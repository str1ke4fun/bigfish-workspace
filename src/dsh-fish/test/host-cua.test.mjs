import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostCua, scrubEnv } from '../lib/host-cua.js'

function fakeClient(overrides = {}) {
  return {
    calls: [],
    pid: 123,
    disposed: false,
    async initialize() { return { serverInfo: { name: 'cua-driver', version: '0.55.0' } } },
    async listTools() {
      return ['list_windows', 'get_window_state', 'click', 'type_text', 'press_key'].map((name) => ({ name }))
    },
    async callTool(name, args) { this.calls.push([name, args]); return { content: [{ type: 'text', text: 'ok' }] } },
    dispose() { this.disposed = true },
    get closed() { return this.disposed },
    ...overrides,
  }
}

const fakeSpawn = () => ({ on() {}, unref() {} })

test('managed 启动驱动、required tools 缺失则 fail closed', async () => {
  let client
  const svc = createHostCua({
    root: '/tmp/host-cua-test',
    config: { hostCua: { exe: '/tmp/cua-driver.exe' } },
    exists: () => true,
    spawn: fakeSpawn,
    createClient: () => (client = fakeClient({ listTools: async () => [{ name: 'list_windows' }] })),
  })
  const r = await svc.setMode({ mode: 'managed', actor: 'workbench' })
  assert.equal(r.ok, false)
  assert.equal(svc.status().mode, 'off')
  assert.equal(client.disposed, true)
  assert.match(svc.status().lastError, /get_window_state|click/)
})

test('observe 不启动驱动；managed 成功后 call 转发 background', async () => {
  let client
  const svc = createHostCua({
    root: '/tmp/host-cua-test',
    config: { hostCua: { exe: '/tmp/cua-driver.exe' } },
    exists: () => true,
    spawn: fakeSpawn,
    createClient: () => (client = fakeClient()),
  })
  await svc.setMode({ mode: 'observe', actor: 'workbench' })
  assert.equal(client, undefined)
  await svc.setMode({ mode: 'managed', actor: 'workbench' })
  assert.equal(svc.status().mode, 'managed')
  await svc.call('click', { window_id: 1, delivery_mode: 'background' })
  assert.deepEqual(client.calls[0], ['click', { window_id: 1, delivery_mode: 'background' }])
})

test('注册文件只接受稳定目录，稳定路径会落 host-cua.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-cua-reg-'))
  try {
    const svc = createHostCua({ root, config: {}, createClient: () => fakeClient() })
    await svc.refreshRegistration({ version: '0.55.0', exe: 'C:\\Users\\ASUS\\evil\\cua-driver.exe' })
    assert.equal(await readFile(join(root, 'host-cua.json'), 'utf8').catch(() => null), null)
    await svc.refreshRegistration({ version: '0.55.0', exe: 'C:\\Users\\ASUS\\AppData\\Local\\bigfish\\host-cua\\0.55.0\\cua-driver.exe' })
    assert.match(await readFile(join(root, 'host-cua.json'), 'utf8'), /cua-driver\.exe/)
    assert.equal(svc.petState().mode, 'off')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('status.apps 带每个应用的 detail 与 input', async () => {
  const svc = createHostCua({
    root: '/tmp/host-cua-test',
    config: { hostCua: { apps: ['Code.exe'], detail: { 'Code.exe': 'full' }, defaultDetail: 'structure', input: { 'Code.exe': 'allow' }, defaultInput: 'deny' } },
    createClient: () => fakeClient(),
  })
  assert.deepEqual(svc.status().apps, [{ app: 'Code.exe', detail: 'full', input: 'allow' }])
})

test('驱动退出会 fail closed', async () => {
  let onExit
  const svc = createHostCua({
    root: '/tmp/host-cua-test',
    config: { hostCua: { exe: '/tmp/cua-driver.exe' } },
    exists: () => true,
    spawn: fakeSpawn,
    createClient: ({ onExit: cb }) => { onExit = cb; return fakeClient() },
  })
  await svc.setMode({ mode: 'managed', actor: 'workbench' })
  onExit(new Error('boom'))
  assert.equal(svc.status().mode, 'off')
  assert.equal(svc.status().phase, 'error')
  assert.match(svc.status().lastError, /boom/)
})

test('工具名白名单、频率上限、动作数上限与打字上限', async () => {
  let t = 0
  const make = (budget) => createHostCua({
    root: '/tmp/host-cua-test',
    now: () => t,
    config: { hostCua: { exe: '/tmp/cua-driver.exe', budget } },
    exists: () => true,
    spawn: fakeSpawn,
    createClient: () => fakeClient(),
  })

  const rate = make({ maxActions: 10, maxActionsPer10s: 1, maxTypedChars: 100 })
  await rate.setMode({ mode: 'managed', actor: 'workbench' })
  await rate.call('click', { window_id: 1, delivery_mode: 'background' })
  await assert.rejects(rate.call('click', { window_id: 1, delivery_mode: 'background' }), /RATE_LIMITED/)

  const count = make({ maxActions: 1, maxActionsPer10s: 10, maxTypedChars: 100 })
  await count.setMode({ mode: 'managed', actor: 'workbench' })
  await count.call('click', { window_id: 1, delivery_mode: 'background' })
  await assert.rejects(count.call('click', { window_id: 1, delivery_mode: 'background' }), /ACTION_BUDGET/)

  const typed = make({ maxActions: 10, maxActionsPer10s: 10, maxTypedChars: 5 })
  await typed.setMode({ mode: 'managed', actor: 'workbench' })
  await assert.rejects(typed.call('type_text', { window_id: 1, text: 'abcdef', delivery_mode: 'background' }), /ACTION_BUDGET/)

  await assert.rejects(rate.call('move_cursor', {}), /TOOL_NOT_ALLOWED/)
  assert.equal(count.status().actions.count, 1)
})

test('scrubEnv 去掉凭据与 DSH_*，保留其它变量', () => {
  const env = scrubEnv({ B2GFISH_API_KEY: 'x', DSH_TOKEN: 'y', PATH: '/usr/bin', WSL_INTEROP: 's' })
  assert.equal(env.B2GFISH_API_KEY, undefined)
  assert.equal(env.DSH_TOKEN, undefined)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.WSL_INTEROP, 's')
})
