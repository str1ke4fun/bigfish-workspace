// @ 才回的判定测试：node test-mention.mjs（跑线上那份实现）
import assert from 'node:assert/strict'
import { canSpeak, grant, grantMentioned, parseWindowMinutes, prune } from './lib/mention.js'

const T = 1_700_000_000_000
let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

console.log('窗口')
t('没人 @ 过 → 不能说话', () => {
  const r = canSpeak({}, '测试群A', T, 3)
  assert.equal(r.ok, false)
  assert.match(r.reason, /没人 @/)
})
t('刚被 @ 过 → 能说话，还剩 3 分钟', () => {
  const r = canSpeak(grant({}, '测试群A', T), '测试群A', T, 3)
  assert.equal(r.ok, true)
  assert.equal(r.leftMs, 3 * 60_000)
})
t('过了 2 分 59 秒还能说，过了 3 分 1 秒就不行', () => {
  const s = grant({}, '测试群A', T)
  assert.equal(canSpeak(s, '测试群A', T + 179_000, 3).ok, true)
  const late = canSpeak(s, '测试群A', T + 181_000, 3)
  assert.equal(late.ok, false)
  assert.match(late.reason, /3 分钟前/)
})
t('窗口调成 10 分钟，5 分钟时还能说', () => {
  const s = grant({}, '测试群A', T)
  assert.equal(canSpeak(s, '测试群A', T + 5 * 60_000, 10).ok, true)
  assert.equal(canSpeak(s, '测试群A', T + 5 * 60_000, 3).ok, false)
})
t('会话分开算：A 被 @ 不代表 B 能开口', () => {
  const s = grant({}, '测试群A', T)
  assert.equal(canSpeak(s, '测试群A', T + 1000, 3).ok, true)
  assert.equal(canSpeak(s, '测试家园10号楼1302', T + 1000, 3).ok, false)
})
t('同一个会话再被 @ → 窗口重新算', () => {
  const s = grant(grant({}, '测试群A', T), '测试群A', T + 120_000)
  assert.equal(canSpeak(s, '测试群A', T + 240_000, 3).ok, true)
})

console.log('兜底')
t('窗口填 0 / 负数 / 文字 → 落回 1~120 之间，不会把嘴锁死也不会永开', () => {
  assert.equal(parseWindowMinutes(0), 1)
  assert.equal(parseWindowMinutes(-7), 1)
  assert.equal(parseWindowMinutes('abc'), 3)
  assert.equal(parseWindowMinutes(999), 120)
  assert.equal(parseWindowMinutes(undefined), 3)
})
t('cleaning：一天以前的记录会被丢掉', () => {
  const s = { 老群: T - 25 * 3600_000, 新群: T - 1000 }
  assert.deepEqual(prune(s, T), { 新群: T - 1000 })
})
t('poke 里点到的会话才算被叫（点不到就不给开）', () => {
  const chats = ['测试群A', '测试家园10号楼1302']
  const a = grantMentioned({}, '测试群A 里有人 @ 你，去看看', chats, T)
  assert.equal(canSpeak(a, '测试群A', T, 3).ok, true)
  assert.equal(canSpeak(a, '测试家园10号楼1302', T, 3).ok, false)
  const b = grantMentioned({}, '随便一句没提名的话', chats, T)
  assert.deepEqual(b, {})
})

console.log(`\n${n} 条断言全部通过`)
