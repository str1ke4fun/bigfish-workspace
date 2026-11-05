// 耳朵的投递记忆：同一个 key 只能压住「同一个未读回合」。
// 跑：node test-ear-seen.mjs
import assert from 'node:assert/strict'
import { freshHits, forgetReadChats, parseSeen, pruneSeen, serializeSeen, SEEN_TTL_MS } from './lib/ear-seen.js'

const NOW = Date.parse('2026-11-05T01:50:00.000Z')
const HOUR = 3600_000

// 1. 旧格式（纯字符串数组）能读，chat 从 key 前缀里取
const legacy = parseSeen({ delivered: ['cat不到flag的cat||早'] }, NOW)
assert.equal(legacy.size, 1)
assert.equal(legacy.get('cat不到flag的cat||早').chat, 'cat不到flag的cat')

// 2. 回归：11-03 投过「早」，11-05 同一句再出现时，old key 不能把它吃掉。
//    未读还在 → 继续压住；会话被读到（未读=0）→ 清 key，同一句重新算新消息。
const key = 'cat不到flag的cat||早'
const hit = { key, chat: 'cat不到flag的cat', why: 'exempt', preview: '早' }
const seen = parseSeen({ delivered: [{ key, at: NOW - 2 * 24 * HOUR, chat: 'cat不到flag的cat' }] }, NOW)

assert.equal(freshHits([hit], seen, new Map(), { now: NOW }).length, 0, '未读还在时不能重复投')
assert.equal(forgetReadChats(seen, [{ name: 'cat不到flag的cat', unread: 1 }]), 0, '未读=1 不是已读')
assert.equal(seen.has(key), true)

assert.equal(forgetReadChats(seen, [{ name: 'cat不到flag的cat', unread: 0 }]), 1, '读到会话后应清掉旧 key')
assert.equal(seen.has(key), false)
assert.equal(freshHits([hit], seen, new Map(), { now: NOW }).length, 1, '读完之后同一句话应重新触发')

// 3. 不在这一屏的会话不能因为「没看见」就被当成已读清掉
const kept = parseSeen({ delivered: [{ key, at: NOW, chat: 'cat不到flag的cat' }] }, NOW)
assert.equal(forgetReadChats(kept, [{ name: '另一个会话', unread: 0 }]), 0)
assert.equal(kept.has(key), true)

// 4. @ 不受回声冷却影响；单聊/免 @ 仍然要等满 45 秒
const lastDeliver = new Map([['某个群', NOW - 1000], ['某个猫', NOW - 1000]])
const atHit = { key: '某个群|@|@D33p53Ek 在吗', chat: '某个群', why: '@' }
const dmHit = { key: '某个猫||在吗', chat: '某个猫', why: 'exempt' }
assert.equal(freshHits([atHit, dmHit], new Map(), lastDeliver, { now: NOW }).length, 1, '只有 @ 能穿过冷却')
assert.equal(freshHits([dmHit], new Map(), new Map([['某个猫', NOW - 46_000]]), { now: NOW }).length, 1, '45 秒后单聊可以再叫')

// 5. 24 小时兜底：过期记录会被清掉，没到期的留着
const old = parseSeen({
  delivered: [
    { key: 'a||x', at: NOW - SEEN_TTL_MS - HOUR, chat: 'a' },
    { key: 'b||y', at: NOW - HOUR, chat: 'b' },
  ],
}, NOW)
pruneSeen(old, { now: NOW })
assert.equal(old.has('a||x'), false, '超过 24 小时应过期')
assert.equal(old.has('b||y'), true)

// 6. 上限按时间保留最新的 200 条
const many = new Map()
for (let i = 0; i < 205; i += 1) many.set(`c${i}||m`, { at: NOW - (205 - i) * 1000, chat: `c${i}` })
pruneSeen(many, { now: NOW, cap: 200 })
assert.equal(many.size, 200)
assert.equal(many.has('c0||m'), false, '最旧的应该先被淘汰')
assert.equal(many.has('c204||m'), true)

// 7. 落盘再读回来，key/时间/会话都不丢
const round = parseSeen(JSON.parse(JSON.stringify(serializeSeen(many, NOW))), NOW)
assert.deepEqual([...round], [...many])

console.log('ear-seen: 全部通过')
