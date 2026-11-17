// 微信常驻段：只留会改变下一句判断的现实，不再挂工具手册。
// 跑：node --test test-prompt-split.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { channelRulesText } from './lib/index.js'

const NOW = new Date(2026, 10, 13, 10, 0, 0).getTime()
const policy = {
  enabled: true,
  allowChats: ['群A'],
  noMentionChats: ['私聊B'],
  requireMention: true,
  mentionWindowMinutes: 3,
  proactivePerDay: 0,
  proactiveChats: { 群A: 5 },
  softLimit: 5,
  hardBreaker: 12,
}
const state = { day: '2026-11-13', used: { 群A: 6 } }
const short = channelRulesText(policy, { proactiveState: state, now: NOW })
const expected = [
  '## 微信',
  '有人找你时，你会看见是哪个会话、谁说的、最后那句。那句多半是预览，不是全文。要看全，先点开那个会话。',
  '只在被叫到的地方说话。私聊、以及他跟你说过不用等 @ 的地方，可以自己开口。别的群，等他们叫你。',
  '对话框里他问的事，在这儿答。他没让你发去微信，就别发。',
  '发不出去就在这儿说一声。群里只说事，不说你这边怎么操作的。',
  '屏幕可能慢半拍。没看见落下去，就别说发出去了。',
].join('\n')

test('微信常驻段只保留设计里的五句现实规则', () => {
  assert.equal(short, expected)
  assert.equal(short.split('\n').length, 6, '标题之外只有五行规则')
})

test('常驻段不报会话名单、软上限/硬熔断、@ 分钟数或工具手册', () => {
  for (const bad of ['群A', '私聊B', '剩 3/5', '3 分钟', 'wx_', 'dsh-wx', '白名单', '额度', '软上限', '硬熔断', '12', '任务：']) {
    assert.doesNotMatch(short, new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('只注册一个微信常驻段，不再注册工具手册', () => {
  const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /name: 'channel:dsh-wx',\s*\n\s*order: 92/)
  assert.doesNotMatch(src, /channel:dsh-wx-manual|channelManualText/)
})
