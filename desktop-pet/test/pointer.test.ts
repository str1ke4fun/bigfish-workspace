import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldIgnoreMouse,
  clampToDisplays,
  defaultPosition,
  ensureVisible,
} from '../electron/pointer.ts'
import { clampPetSize, windowSizeFor } from '../electron/size.ts'

test('身体/UI/拖拽时可交互，其余穿透', () => {
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:false, dragging:false }), true)
  assert.equal(shouldIgnoreMouse({ overPet:true, overUi:false, dragging:false }), false)
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:true, dragging:false }), false)
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:false, dragging:true }), false)
})
test('首次启动默认落在工作区右下角，留边距', () => {
  assert.deepEqual(
    defaultPosition({ x: 0, y: 0, width: 1920, height: 1040 }, 500, 340),
    { x: 1396, y: 676 },
  )
  // 任务栏在左侧/上方时以工作区原点为准，不假设 0,0。
  assert.deepEqual(
    defaultPosition({ x: 80, y: 40, width: 1000, height: 700 }, 500, 340, 10),
    { x: 570, y: 390 },
  )
})
test('窗口位置夹到显示器工作区', () => {
  const displays = [{ x:0, y:0, width:1920, height:1080 }]
  assert.deepEqual(clampToDisplays({ x:2000, y:-50, width:400, height:260 }, displays, (d) => ({ x:d.x, y:d.y, width:d.width, height:d.height })), { x:1520, y:0 })
})

test('拖拽落点只要还看得见就不弹回', () => {
  const displays = [{ x:0, y:0, width:1920, height:1080 }]
  const area = (d: typeof displays[number]) => ({ x:d.x, y:d.y, width:d.width, height:d.height })
  // 半只挂在右边：与工作区仍有交集，保持原位。
  assert.deepEqual(ensureVisible({ x:1800, y:700, width:500, height:340 }, displays, area), { x:1800, y:700 })
  // 完全丢出屏幕：拉回工作区。
  assert.deepEqual(ensureVisible({ x:3000, y:700, width:500, height:340 }, displays, area), { x:1420, y:700 })
})

test('尺寸夹取与窗口比例', () => {
  assert.equal(clampPetSize(9999), 560)
  assert.equal(clampPetSize(1), 240)
  assert.equal(clampPetSize('abc'), 400)
  assert.equal(clampPetSize(400), 400)
  // 462 → 500×340，与旧默认窗口一致。
  assert.deepEqual(windowSizeFor(462), { width: 500, height: 340 })
  assert.deepEqual(windowSizeFor(320), { width: 358, height: 260 })
})
