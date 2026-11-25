import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  isHostAppAllowed, parseWindowList, parseWindowCapture, winPathToWsl,
  buildWindowListScript, createPrintWindow,
} from '../lib/host-window.js'

test('allowlist 去掉 .exe 比较，deny 优先', () => {
  assert.equal(isHostAppAllowed('Code.exe'), true)
  assert.equal(isHostAppAllowed('code'), true)
  assert.equal(isHostAppAllowed('Weixin.exe'), false)
  assert.equal(isHostAppAllowed('explorer.exe'), false)
})

test('窗口列表只保留合法条目并截断标题', () => {
  const r = parseWindowList(JSON.stringify([
    { hwnd: 12, pid: 34, app: 'Code.exe', title: 'x'.repeat(400), minimized: false },
    { hwnd: 0, pid: 0, app: '', title: '', minimized: false },
  ]))
  assert.equal(r.ok, true)
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].id, '12')
  assert.equal(r.windows[0].title.length, 200)
})

test('坏 JSON 返回 ok:false，不抛', () => {
  assert.equal(parseWindowList('not json').ok, false)
  assert.equal(parseWindowCapture('{"ok":false,"code":"printwindow-failed"}').code, 'printwindow-failed')
})

test('抓帧解析 base64 PNG', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
  const r = parseWindowCapture(JSON.stringify({ ok: true, app: 'notepad.exe', title: 't', width: 10, height: 10, png }))
  assert.equal(r.ok, true)
  assert.equal(r.buf.length, 4)
})

test('Windows 路径映射到 /mnt', () => {
  assert.equal(winPathToWsl('C:\\Users\\ASUS\\AppData\\Local\\bigfish\\cua-driver.exe'), '/mnt/c/Users/ASUS/AppData/Local/bigfish/cua-driver.exe')
  assert.equal(winPathToWsl('D:\\fish\\cua-driver.exe'), '/mnt/d/fish/cua-driver.exe')
})

test('列表脚本带 allow/deny，拒绝应用的标题不离开 Windows', () => {
  const s = buildWindowListScript({ allow: ['Code.exe'], deny: ['Weixin.exe'] })
  assert.match(s, /Code\.exe/)
  assert.match(s, /Weixin\.exe/)
  assert.match(s, /IsWindowVisible/)
})

function fakeChild({ stdout = '', code = 0 } = {}) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
  child.kill = () => {}
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', stdout)
    child.emit('close', code)
  })
  return child
}

test('createPrintWindow 用注入的 spawn，列表走 PowerShell', async () => {
  const seen = []
  const pw = createPrintWindow({
    spawn: (exe, args) => { seen.push([exe, args]); return fakeChild({ stdout: JSON.stringify([{ hwnd: 5, pid: 6, app: 'Code.exe', title: 't', minimized: false }]) }) },
  })
  const r = await pw.list({ allow: ['Code.exe'], deny: [] })
  assert.equal(r.ok, true)
  assert.equal(r.windows.length, 1)
  assert.ok(seen[0][1].includes('-Command'))
})

test('PowerShell 非零退出返回明确 code', async () => {
  const pw = createPrintWindow({ spawn: () => fakeChild({ stdout: 'boom', code: 1 }) })
  const r = await pw.list()
  assert.equal(r.ok, false)
  assert.equal(r.code, 'powershell-exit')
})
