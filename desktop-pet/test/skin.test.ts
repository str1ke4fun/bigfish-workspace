import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSkin, shouldApplySettings, SIMPLE_SKIN_ID } from '../electron/skin.ts'

test('skin.json 必须覆盖 14 个动作', () => {
  const motions = Object.fromEntries(['idle','turn','moving-left','moving-right','waving','thinking','working','result','waiting','running','review','failed','success','error'].map(m => [m, 'x']))
  assert.equal(validateSkin({ name: '测试', motions }).ok, true)
  assert.equal(validateSkin({ name: '缺动作', motions: { idle: 'x' } }).ok, false)
  assert.equal(validateSkin(null).ok, false)
})
test('皮肤 id 只允许小写字母数字与连字符', () => {
  assert.equal(SIMPLE_SKIN_ID.test('maid-blue'), true)
  assert.equal(SIMPLE_SKIN_ID.test('大肥鱼'), false)
  assert.equal(SIMPLE_SKIN_ID.test('../escape'), false)
})
test('同一设置重复下发不重复应用（避免抖动/重载）', () => {
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { size: 400, skin: '' }), false)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { size: 320 }), true)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { skin: 'maid-blue' }), true)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, {}), false)
})
