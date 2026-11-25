import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeConfig, DEFAULTS, CONFIG_PATCH_KEYS } from '../lib/settings.js'

test('hostCua 默认值：终端/浏览器 detail=full、input=allow，未列出默认 structure/deny', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.hostCua.defaultDetail, 'structure')
  assert.equal(cfg.hostCua.defaultInput, 'deny')
  assert.equal(cfg.hostCua.detail.code, 'full')
  assert.equal(cfg.hostCua.detail.windowsterminal, 'full')
  assert.equal(cfg.hostCua.detail.chrome, 'full')
  assert.equal(cfg.hostCua.input.chrome, 'allow')
  assert.deepEqual(cfg.hostCua.budget, { maxActions: 40, maxActionsPer10s: 8, maxTypedChars: 5000 })
  assert.ok(CONFIG_PATCH_KEYS.includes('hostCua'))
  assert.ok(DEFAULTS.hostCua.apps.includes('Code.exe'))
})

test('hostCua 的 detail/input 规范化：key 去 .exe/小写，非法值丢掉，默认安全', () => {
  const cfg = normalizeConfig({ hostCua: { detail: { ' Code.exe ': 'full', 'Weixin.exe': 'bogus' }, defaultDetail: 'nope', input: { ' Code.exe ': 'allow', 'chrome.exe': 'bogus' }, defaultInput: 'nope', budget: { maxActions: 9999 } } })
  assert.equal(cfg.hostCua.detail.code, 'full')
  assert.equal(cfg.hostCua.detail.weixin, undefined)
  assert.equal(cfg.hostCua.defaultDetail, 'structure')
  assert.equal(cfg.hostCua.input.code, 'allow')
  assert.equal(cfg.hostCua.input.chrome, undefined)
  assert.equal(cfg.hostCua.defaultInput, 'deny')
  assert.equal(cfg.hostCua.budget.maxActions, 200)
})
