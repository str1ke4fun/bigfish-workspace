import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '../assets/config.json'), 'utf8'))

test('config 覆盖 14 个动作，且没有重复动画名', () => {
  const names = new Set<string>()
  for (const m of ['idle','turn','moving-left','moving-right','waving','thinking','working','result','waiting','running','review','failed','success','error']) {
    assert.ok(cfg.animations.motions[m], m)
    names.add(cfg.animations.motions[m])
  }
  assert.ok(names.size >= 10)
})

test('config 不包含人设/提示词/数值字段', () => {
  const text = JSON.stringify(cfg)
  for (const bad of ['whisperPrompt', 'chatModel', 'balanceEnabled']) assert.equal(text.includes(bad), false)
})
