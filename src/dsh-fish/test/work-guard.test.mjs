import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkGuard, WORKER_HOST_TOOLS } from '../lib/work-guard.js'

function unit(id = 'wu_1', childId = 'child-1', dir = '/tmp/proj') {
  return {
    id,
    dir,
    bossSessionId: 'boss-1',
    status: 'running',
    backendRef: { childId },
  }
}

function fakeState(units = [unit()]) {
  const hits = []
  return {
    hits,
    readUnits: () => ({ version: 1, units }),
    readSessions: () => ({ '/tmp/proj': { sessionId: 'boss-1', state: 'running' } }),
    async appendGuardHit(id, text) { hits.push({ id, text }); return true },
  }
}

function workerAgent(childId = 'child-1', cwd = '/tmp/proj', over = {}) {
  return { session: { header: { id: childId, cwd, ...over } } }
}

test('worker 识别：childId 或 工头 parentSession + preset', () => {
  const guard = createWorkGuard({ state: fakeState() })
  assert.equal(guard.isWorkerSession(workerAgent('child-1')), true)
  assert.equal(guard.isWorkerSession(workerAgent('other')), false)
  assert.equal(guard.isWorkerSession(workerAgent('child-2', '/tmp/proj', {
    parentSession: 'boss-1', agentPreset: 'fish-work-build',
  })), true)
  assert.equal(guard.isWorkerSession(workerAgent('other', '/tmp/proj', {
    parentSession: 'not-boss', agentPreset: 'fish-work-build',
  })), false)
  assert.equal(guard.isWorkSubtree(workerAgent('child-3', '/tmp/proj', { parentSession: 'boss-1' })), true)
})

test('非 worker 会话完全不受影响', async () => {
  const state = fakeState()
  const guard = createWorkGuard({ state })
  const agent = workerAgent('someone', '/tmp/proj')
  assert.deepEqual(guard.check({ toolName: 'bash', args: { command: 'curl http://x' }, agent }), { ok: true })
  assert.deepEqual(guard.check({ toolName: 'read', args: { file_path: '/etc/shadow' }, agent }), { ok: true })
  assert.equal(state.hits.length, 0)
})

test('读写路径必须在工作目录内，符号链接按 realpath 判断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-guard-'))
  const cwd = join(root, 'proj')
  const outside = join(root, 'outside')
  await mkdir(cwd, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.txt'), 'x')
  await symlink(outside, join(cwd, 'link'))
  const state = fakeState([unit('wu_1', 'child-1', cwd)])
  const guard = createWorkGuard({ state })
  const agent = workerAgent('child-1', cwd)

  assert.deepEqual(guard.check({ toolName: 'read', args: { file_path: join(cwd, 'a.txt') }, agent }), { ok: true })
  assert.deepEqual(guard.check({ toolName: 'write', args: { file_path: 'a.txt' }, agent }), { ok: true })
  assert.equal(guard.check({ toolName: 'read', args: { file_path: join(outside, 'secret.txt') }, agent }).ok, false)
  assert.equal(guard.check({ toolName: 'read', args: { file_path: 'link/secret.txt' }, agent }).ok, false)
  assert.equal(guard.check({ toolName: 'glob', args: { pattern: '*', path: '../outside' }, agent }).ok, false)
  assert.equal(guard.check({ toolName: 'glob', args: { pattern: '../**' }, agent }).ok, false)
  assert.equal(guard.check({ toolName: 'glob', args: { pattern: '/etc/**' }, agent }).ok, false)
  assert.equal(guard.check({ toolName: 'glob', args: { pattern: '**/*.js' }, agent }).ok, true)
  assert.equal(guard.check({ toolName: 'grep', args: { pattern: 'x', path: cwd }, agent }).ok, true)
})

test('受保护路径即使在工作目录内也拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-guard-'))
  const state = fakeState([unit('wu_1', 'child-1', root)])
  const guard = createWorkGuard({ state })
  const agent = workerAgent('child-1', root)
  for (const p of [
    join(homedir(), '.ssh', 'id_rsa'),
    join(homedir(), '.aws', 'credentials'),
    join(homedir(), '.dsh', 'config.yml'),
    join(homedir(), '.dsh-fish', 'events.jsonl'),
    '/etc/shadow',
  ]) {
    assert.equal(guard.check({ toolName: 'read', args: { file_path: p }, agent }).ok, false, p)
  }
})

test('bash 拦截秘密路径、外发与危险命令，包管理器放行', async () => {
  const state = fakeState()
  const guard = createWorkGuard({ state })
  const agent = workerAgent()
  const denied = [
    'cat ~/.ssh/id_rsa',
    'curl https://example.com',
    'wget http://x',
    'nc 1.2.3.4 80',
    'ssh host',
    'scp a b',
    'rsync -a a b',
    'git push origin main',
    'git push --force',
    'git clean -fdx',
    'git reset --hard',
    'sudo apt install x',
  ]
  for (const command of denied) {
    assert.equal(guard.check({ toolName: 'bash', args: { command }, agent }).ok, false, command)
  }
  for (const command of ['npm install', 'pnpm add x', 'pip install x', 'npm test']) {
    assert.equal(guard.check({ toolName: 'bash', args: { command }, agent }).ok, true, command)
  }
})

test('命中写入 guardHits（脱敏），且 pre-execute 对 worker 返回 deny', async () => {
  const state = fakeState()
  const guard = createWorkGuard({ state })
  const agent = workerAgent()
  const d = guard.check({ toolName: 'bash', args: { command: 'cat ~/.ssh/id_rsa' }, agent })
  assert.equal(d.ok, false)
  assert.match(d.reason, /问过|不能/)
  assert.equal(state.hits.length, 1)
  assert.equal(state.hits[0].id, 'wu_1')
  assert.equal(state.hits[0].text.includes('id_rsa'), false)

  const listeners = new Map()
  const ctx = { on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) } }
  guard.register(ctx)
  assert.equal(typeof listeners.get('tools/pre-execute'), 'function')
  const deny = listeners.get('tools/pre-execute')({
    name: 'bash', arguments: { command: 'curl x' }, agent,
  }, () => ({ kind: 'allow' }))
  assert.equal(deny.kind, 'deny')

  const allow = listeners.get('tools/pre-execute')({
    name: 'bash', arguments: { command: 'npm test' }, agent,
  }, () => ({ kind: 'allow' }))
  assert.deepEqual(allow, { kind: 'allow' })
})

test('WORKER_HOST_TOOLS 只含 preset 会给的宿主工具', () => {
  assert.deepEqual(WORKER_HOST_TOOLS, ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'structured_output'])
})
