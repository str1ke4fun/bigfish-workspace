import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pickMonitor, cropForWindow, isAllowed, buildForegroundScript, parseForegroundSample,
} from '../lib/foreground.js'

const monitors = [
  { device: 'DISPLAY1', primary: true, x: 0, y: 0, w: 2560, h: 1600 },
  { device: 'DISPLAY2', primary: false, x: -1920, y: 509, w: 1920, h: 1080 },
]

test('跨屏窗口取重叠最大的显示器并夹紧 crop', () => {
  const rect = { left: -1931, top: 498, right: 11, bottom: 1552 }
  const { index } = pickMonitor(rect, monitors)
  assert.equal(index, 1)
  assert.deepEqual(cropForWindow(rect, monitors[1]), { w: 1920, h: 1054, x: 0, y: 0 })
})

test('deny 优先且大小写不敏感', () => {
  assert.equal(isAllowed('Code.exe', ['code.exe'], ['weixin.exe']), true)
  assert.equal(isAllowed('Weixin.exe', ['weixin.exe'], ['weixin.exe']), false)
  assert.equal(isAllowed('unknown.exe', ['code.exe'], []), false)
  assert.equal(isAllowed('', ['code.exe'], []), false)
})

test('前台脚本含 per-monitor V2，且不含 EncodedCommand', () => {
  const s = buildForegroundScript({ intervalMs: 2000 })
  assert.match(s, /SetProcessDpiAwarenessContext/)
  assert.doesNotMatch(s, /EncodedCommand|WindowStyle Hidden/)
  assert.match(s, /GetForegroundWindow/)
})

test('parseForegroundSample 解析 JSON 行，坏行返回 null', () => {
  const line = JSON.stringify({ hwnd: 1, pid: 2, name: 'Code', rect: { left: 0, top: 0, right: 100, bottom: 50 }, monitors })
  const s = parseForegroundSample(line)
  assert.equal(s.name, 'Code')
  assert.equal(s.rect.right, 100)
  assert.equal(parseForegroundSample('not json'), null)
})
