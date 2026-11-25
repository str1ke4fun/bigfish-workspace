import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  HOST_CUA_VERSION, resolveInstallTarget, installBundledHostCua,
} from '../electron/host-cua.ts'

test('安装目录按版本稳定，不落在 portable 解压目录', () => {
  assert.equal(
    resolveInstallTarget({ localAppData: path.join('C:', 'Users', 'ASUS', 'AppData', 'Local'), version: HOST_CUA_VERSION }),
    path.join('C:', 'Users', 'ASUS', 'AppData', 'Local', 'bigfish', 'host-cua', HOST_CUA_VERSION),
  )
})

test('已有 exe 时幂等；缺 manifest 时明确失败', async () => {
  const r1 = await installBundledHostCua({
    bundledDir: 'b',
    localAppData: 'l',
    exists: (p) => p.endsWith('cua-driver.exe'),
    readManifest: async () => ({ version: HOST_CUA_VERSION }),
    copyDir: async () => { throw new Error('should not copy') },
  })
  assert.equal(r1.ok, true)
  assert.equal(r1.reused, true)

  const r2 = await installBundledHostCua({
    bundledDir: 'b',
    localAppData: 'l',
    exists: (p) => p.endsWith('cua-driver.exe'),
    readManifest: async () => null,
    copyDir: async () => {},
  })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'manifest-missing')
})

test('首次复制先写临时目录再 rename，不执行驱动', async () => {
  const ops: string[] = []
  const r = await installBundledHostCua({
    bundledDir: path.join('res', 'host-cua'),
    localAppData: path.join('local'),
    exists: (p) => p.endsWith(path.join('res', 'host-cua', 'cua-driver.exe')),
    readManifest: async () => ({ version: HOST_CUA_VERSION }),
    copyDir: async (from, to) => { ops.push(`copy:${from}->${to}`) },
    renameDir: async (from, to) => { ops.push(`rename:${from}->${to}`) },
    mkdir: async () => {},
    rmDir: async () => {},
  })
  assert.equal(r.ok, true)
  assert.equal(r.reused, false)
  assert.ok(ops.some((op) => op.startsWith('copy:')))
  assert.ok(ops.some((op) => op.startsWith('rename:')))
  assert.ok(!ops.some((op) => /telemetry/.test(op)))
})
