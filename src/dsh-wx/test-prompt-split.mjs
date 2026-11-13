// 微信提示词拆段：短规则放判断依据，工具手册放后段。
// 跑：node --test test-prompt-split.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { channelManualText, channelRulesText, proactivePromptLine } from './lib/index.js'

const NOW = new Date(2026, 10, 13, 10, 0, 0).getTime()
const policy = {
  enabled: true,
  allowChats: ['群A'],
  noMentionChats: ['私聊B'],
  requireMention: true,
  mentionWindowMinutes: 3,
  proactivePerDay: 0,
  proactiveChats: { 群A: 5 },
}
const state = { day: '2026-11-13', used: { 群A: 2 } }
const short = channelRulesText(policy, { proactiveState: state, now: NOW })
const manual = channelManualText()

test('短段保留判断依据：通知语义、任务 id、隐私禁令、发送失败', () => {
  assert.match(short, /\[微信\]/)
  assert.match(short, /侧栏预览/)
  assert.match(short, /任务：t_/)
  assert.match(short, /窗口、坐标、白名单/)
  assert.match(short, /发不出去就算了/)
  assert.match(short, /主动说/)
})

test('短段不背工具手册', () => {
  assert.doesNotMatch(short, /wx_sticker_send/)
  assert.doesNotMatch(short, /wx_context：/)
})

test('手册段保留工具用法与易错点', () => {
  assert.match(manual, /wx_peek/)
  assert.match(manual, /wx_send/)
  assert.match(manual, /不能含换行/)
  assert.match(manual, /点下去就发送/)
  assert.ok(manual.length > short.length, '手册应该比短规则长')
})

test('主动额度句只列有额度且没用完的会话', () => {
  assert.equal(proactivePromptLine({ proactiveChats: {} }, state, NOW), '')
  assert.match(proactivePromptLine(policy, state, NOW), /群A（剩 3\/5）/)
  assert.match(proactivePromptLine(policy, state, NOW), /额度用完就等下次 @/)
})

test('两段各自可独立求值，段名与顺序固定', () => {
  assert.equal(typeof short, 'string')
  assert.equal(typeof manual, 'string')
  const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /name: 'channel:dsh-wx',\s*\n\s*order: 92/)
  assert.match(src, /name: 'channel:dsh-wx-manual',\s*\n\s*order: 8600/)
})
