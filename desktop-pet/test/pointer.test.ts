import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldIgnoreMouse, clampToDisplays } from '../electron/pointer.ts'

test('身体/UI/拖拽时可交互，其余穿透', () => {
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:false, dragging:false }), true)
  assert.equal(shouldIgnoreMouse({ overPet:true, overUi:false, dragging:false }), false)
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:true, dragging:false }), false)
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:false, dragging:true }), false)
})
test('窗口位置夹到显示器工作区', () => {
  const displays = [{ x:0, y:0, width:1920, height:1080 }]
  assert.deepEqual(clampToDisplays({ x:2000, y:-50, width:400, height:260 }, displays, (d) => ({ x:d.x, y:d.y, width:d.width, height:d.height })), { x:1520, y:0 })
})
