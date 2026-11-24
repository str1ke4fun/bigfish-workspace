import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

function referencedNames(): string[] {
  const cfg = JSON.parse(readFileSync(join(root, 'assets/config.json'), 'utf8'))
  const catalog = JSON.parse(readFileSync(join(root, 'assets/actions.json'), 'utf8'))
  const names = new Set<string>()
  const animations = cfg.animations ?? {}
  for (const key of ['idle', 'turn', 'drag', 'clicks']) {
    for (const name of animations[key] ?? []) names.add(name)
  }
  for (const action of animations.moves?.actions ?? []) names.add(action.name)
  for (const name of Object.values(animations.motions ?? {})) names.add(name)
  for (const action of catalog.actions ?? []) {
    if (action.anim) names.add(action.anim)
    for (const name of action.seq ?? []) names.add(name)
  }
  return [...names]
}

function writeSource(dir: string, names: string[]): void {
  mkdirSync(dir, { recursive: true })
  for (const name of names) writeFileSync(join(dir, `${name}.webm`), 'upstream')
}

function runSync(args: string[]) {
  return spawnSync(process.execPath, ['scripts/sync-assets.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('--skip-existing 保留自定义文件，并补齐其余素材', () => {
  const names = referencedNames()
  const source = mkdtempSync(join(tmpdir(), 'bigfish-src-'))
  const out = mkdtempSync(join(tmpdir(), 'bigfish-out-'))
  writeSource(source, names)
  const custom = join(out, '待机呼吸休闲.webm')
  writeFileSync(custom, 'custom')

  const result = runSync(['--from', source, '--out', out, '--skip-existing'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(custom, 'utf8'), 'custom')
  for (const name of names) assert.ok(existsSync(join(out, `${name}.webm`)), name)
})

test('不带 --skip-existing 时用源文件覆盖已有文件', () => {
  const names = referencedNames()
  const source = mkdtempSync(join(tmpdir(), 'bigfish-src-'))
  const out = mkdtempSync(join(tmpdir(), 'bigfish-out-'))
  writeSource(source, names)
  const custom = join(out, '待机呼吸休闲.webm')
  writeFileSync(custom, 'custom')

  const result = runSync(['--from', source, '--out', out])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(custom, 'utf8'), 'upstream')
})

test('源目录和输出目录都缺某个文件时失败并列出文件名', () => {
  const names = referencedNames()
  const missing = names[0]
  const source = mkdtempSync(join(tmpdir(), 'bigfish-src-'))
  const out = mkdtempSync(join(tmpdir(), 'bigfish-out-'))
  writeSource(source, names.slice(1))

  const result = runSync(['--from', source, '--out', out, '--skip-existing'])
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(`${missing}.webm`), result.stderr)
  assert.ok(result.stderr.includes('缺少 1 个动画文件'), result.stderr)
})
