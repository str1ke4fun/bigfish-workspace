// 耳朵的投递记忆：同一个 key 只能压住「同一个未读回合」。
// 跑：node test-ear-seen.mjs
import assert from 'node:assert/strict'
import { dropRecentContent, noteContent, CONTENT_WINDOW_MS, freshHits, forgetReadChats, ownEcho, parseSeen, pruneSeen, serializeSeen, SEEN_TTL_MS } from './lib/ear-seen.js'

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

assert.equal(freshHits([hit], seen).length, 0, '未读还在时不能重复投')
assert.equal(forgetReadChats(seen, [{ name: 'cat不到flag的cat', unread: 1 }]), 0, '未读=1 不是已读')
assert.equal(seen.has(key), true)

assert.equal(forgetReadChats(seen, [{ name: 'cat不到flag的cat', unread: 0 }]), 1, '读到会话后应清掉旧 key')
assert.equal(seen.has(key), false)
assert.equal(freshHits([hit], seen).length, 1, '读完之后同一句话应重新触发')

// 2b. 已读但侧栏预览还是同一句 @：不能清 key，否则同一句每隔几分钟又推一次
const sameVisibleKey = '某群|@|@D33p53Ek 整个活'
const visible = parseSeen({ delivered: [{ key: sameVisibleKey, at: NOW, chat: '某群' }] }, NOW)
assert.equal(forgetReadChats(visible, [{ name: '某群', unread: 0, preview: '@D33p53Ek 整个活' }]), 0, '预览没变，保留投递记忆')
assert.equal(visible.has(sameVisibleKey), true)
assert.equal(forgetReadChats(visible, [{ name: '某群', unread: 0, preview: '换了一句' }]), 1, '预览变了才清')

// 2c. 同一句 @ 带不带「发送者:」前缀都算同一条
const prefixedKey = '某群|@|cat不到flag的cat: @D33p53Ek 整个活'
const prefixedSeen = parseSeen({ delivered: [{ key: prefixedKey, at: NOW, chat: '某群' }] }, NOW)
assert.equal(forgetReadChats(prefixedSeen, [{ name: '某群', unread: 0, preview: '@D33p53Ek 整个活' }]), 0)
assert.equal(freshHits([{
  key: '某群|@|@D33p53Ek 整个活', chat: '某群', why: '@', preview: '@D33p53Ek 整个活',
}], prefixedSeen, { now: NOW }).length, 0, '同一个 @ 换了个前缀写法也不能再投')

// 2d. capture 键里没有正文段：靠 seen 里记下的 text 判断预览还是同一句
const captureKey = 'capture:m_8978fbc4e0c87564'
const captureSeen = parseSeen({ delivered: [{
  key: captureKey, at: NOW, chat: '我需要重新集结部队',
  text: '@D33p53Ek 面对华约30km巨大火炮，北约该发射什么？',
}] }, NOW)
assert.equal(forgetReadChats(captureSeen, [{
  name: '我需要重新集结部队', unread: 0, preview: '@D33p53Ek 面对华约30km巨大火炮，北约该发射什么？',
}]), 0, '预览没变，capture 键也要保留')
assert.equal(forgetReadChats(captureSeen, [{
  name: '我需要重新集结部队', unread: 0, preview: '换了一句',
}]), 0, 'capture 键是稳定消息号，预览换了也不能清')
assert.equal(captureSeen.has(captureKey), true)
assert.equal(freshHits([{
  key: captureKey, chat: '我需要重新集结部队', why: '@',
  preview: '@D33p53Ek 面对华约30km巨大火炮，北约该发射什么？',
}], captureSeen, { now: NOW }).length, 0)
assert.equal(freshHits([{
  key: 'capture:m_newer', chat: '我需要重新集结部队', why: '@',
  preview: '@D33p53Ek 面对华约30km巨大火炮，北约该发射什么？',
}], captureSeen, { now: NOW }).length, 0, '换了 msgId 的同文也要拦')

// 2f. 6 小时前的同开头消息不能压住今天的新消息
const oldBody = parseSeen({ delivered: [{
  key: 'capture:m_old', at: NOW - 6 * HOUR, chat: '某群', text: '你能帮我看一下这个吗',
}] }, NOW)
assert.equal(freshHits([{
  key: 'capture:m_new', chat: '某群', why: '@', preview: '你能帮我看一下这个吗？急',
}], oldBody, { now: NOW }).length, 1, '超出去重窗口的正文不能永久压住新消息')

// 2g. 窗口内、都没截断的两句只是延伸关系 → 算两条
const nearBody = parseSeen({ delivered: [{
  key: 'capture:m_a', at: NOW - 60_000, chat: '某群', text: '明天下午三点开会，记得带电脑',
}] }, NOW)
assert.equal(freshHits([{
  key: 'capture:m_b', chat: '某群', why: '@', preview: '明天下午三点开会，记得带电脑和充电器',
}], nearBody, { now: NOW }).length, 1, '没截断的两句不是同一句')

// 2g2. 截断预览与全文仍按前缀算同一条
const truncBody = parseSeen({ delivered: [{
  key: 'capture:m_t', at: NOW - 60_000, chat: '某群',
  text: '@D33P533K 当别人问你问题的时候，你要多思考，把条件全部列出来',
}] }, NOW)
assert.equal(freshHits([{
  key: 'capture:m_t2', chat: '某群', why: '@',
  preview: '@D33P533K 当别人问你问题的时候，你要多思考，把条件全部列出来…',
}], truncBody, { now: NOW }).length, 0, '截断预览与全文仍算一条')

// 2h. 只把「正文重复」写进 seen；回声拦下的不写
const dup = []
const dupSeen = parseSeen({ delivered: [{
  key: 'capture:m_dup', at: NOW - 30_000, chat: '某群', text: '同一句',
}] }, NOW)
assert.equal(freshHits([{
  key: 'capture:m_dup2', chat: '某群', why: '@', preview: '同一句',
}], dupSeen, { now: NOW, onDuplicate: (m) => dup.push(m.key) }).length, 0)
assert.deepEqual(dup, ['capture:m_dup2'])

const echoDup = []
freshHits([{ key: '某个猫||哟', chat: '某个猫', why: 'exempt', preview: '哟' }], new Map(), {
  now: NOW,
  isEcho: () => true,
  onDuplicate: (m) => echoDup.push(m.key),
})
assert.deepEqual(echoDup, [], '回声拦下不等于正文重复')

// 2i. 缺 at 的旧记录不参与正文比对，不能被当成永远有效
const noAt = new Map([['capture:m_nat', { chat: '某群', text: '同一句' }]])
assert.equal(freshHits([{
  key: 'capture:m_nat2', chat: '某群', why: '@', preview: '同一句',
}], noAt, { now: NOW }).length, 1)

// 2e. text 跟着 seen 落盘再读回
const withText = parseSeen({ delivered: [{ key: captureKey, at: NOW, chat: '群', text: '一句话' }] }, NOW)
assert.deepEqual(parseSeen(JSON.parse(JSON.stringify(serializeSeen(withText, NOW))), NOW), withText)

// 3. 不在这一屏的会话不能因为「没看见」就被当成已读清掉
const kept = parseSeen({ delivered: [{ key, at: NOW, chat: 'cat不到flag的cat' }] }, NOW)
assert.equal(forgetReadChats(kept, [{ name: '另一个会话', unread: 0 }]), 0)
assert.equal(kept.has(key), true)

// 4. 回声只按 outbox 原文判，不按「上次投递后 45 秒」一刀切
const dmHit = { key: '某个猫||这么高冷', chat: '某个猫', why: 'exempt', preview: '这么高冷' }
const echoHit = { key: '某个猫||哟', chat: '某个猫', why: 'exempt', preview: '哟' }
const outbox = [{ chat: '某个猫', text: '哟', at: NOW - 23_000 }]
const isEcho = (m) => ownEcho(m.chat, m.preview, outbox, { now: NOW })
assert.equal(freshHits([dmHit], new Map(), { isEcho }).length, 1, '真人 23 秒后的追问不能被回声保护吞掉')
assert.equal(freshHits([echoHit], new Map(), { isEcho }).length, 0, '她自己刚发的话才算回声')
assert.equal(freshHits([{ ...echoHit, why: '@' }], new Map(), { isEcho }).length, 1, '@ 仍可穿过回声判断')

// 4b. outbox 过期后不再算回声；换一个会话也不算
assert.equal(ownEcho('某个猫', '哟', [{ chat: '某个猫', text: '哟', at: NOW - 46_000 }], { now: NOW }), false)
assert.equal(ownEcho('另一个会话', '哟', outbox, { now: NOW }), false)

// 4c. 预览通常只是正文开头，前缀能对上
assert.equal(ownEcho('某个猫', '今天天气不错', [{ chat: '某个猫', text: '今天天气不错，出去走走吧', at: NOW }], { now: NOW }), true)

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

// 8. 内容窗口：同会话同正文换 key 也不重投；窗口外、别的会话、别的正文照常投
const recent = []
const h1 = { key: 'capture:m_c6b1', chat: '某个猫', why: 'exempt', preview: '中午吃什么' }
const h2 = { key: 'capture:m_8ec5', chat: '某个猫', why: 'exempt', preview: '中午吃什么' }
assert.equal(dropRecentContent([h1], recent, { now: NOW }).length, 1, '没投过就放行')
noteContent(recent, h1, { now: NOW })
assert.equal(dropRecentContent([h2], recent, { now: NOW + 17_000 }).length, 0, '17 秒后换 key 的同一句要拦')
assert.equal(dropRecentContent([{ ...h2, why: '@' }], recent, { now: NOW + 17_000 }).length, 0, '@ 也一样')
// 侧栏预览被截成「…」，整屏拿到全文后不能当成第二句再叫一次。
const truncated = []
noteContent(truncated, {
  chat: '某群', why: '@',
  preview: '@D33P533K 当别人问你问题的时候，你要多思考，把条件全部列出来，然后给一个非常严谨的答案：…',
}, { now: NOW })
assert.equal(dropRecentContent([{
  chat: '某群', why: 'at',
  preview: '@D33P533K 当别人问你问题的时候，你要多思考，把条件全部列出来，然后给一个非常严谨的答案：不能证明xx/不能完全说明xx ，然后什么活都停下来不干，这就是大傻龙了',
}], truncated, { now: NOW + 25_000 }).length, 0, '截断预览与整屏全文只算一条')
// 群预览带不带「发送者: 」前缀，同一条 @ 不能推两次。
const prefixed = []
noteContent(prefixed, { chat: '某群', why: '@', preview: 'cat不到flag的cat: @D33p53Ek 整个活' }, { now: NOW })
assert.equal(dropRecentContent([{ chat: '某群', why: '@', preview: '@D33p53Ek 整个活' }], prefixed, { now: NOW + 80_000 }).length, 0, '前缀不同但正文相同要拦')
assert.equal(dropRecentContent([h2], recent, { now: NOW + CONTENT_WINDOW_MS + 1 }).length, 1, '窗口外放行')
assert.equal(dropRecentContent([{ ...h2, chat: '别的猫' }], recent, { now: NOW + 1000 }).length, 1, '别的会话放行')
assert.equal(dropRecentContent([{ ...h2, preview: '晚上吃什么' }], recent, { now: NOW + 1000 }).length, 1, '别的正文放行')
assert.equal(dropRecentContent([h1, h2], [], { now: NOW }).length, 1, '同一批里的重复只留一条')
// 会话读到后清 seen 不影响内容记录
const s8 = parseSeen({ delivered: [{ key: h1.key, at: NOW, chat: '某个猫' }] }, NOW)
forgetReadChats(s8, [{ name: '某个猫', unread: 0 }])
assert.equal(dropRecentContent([h2], recent, { now: NOW + 1000 }).length, 0, '已读清 key 后内容窗口仍然生效')
noteContent(recent, h1, { now: NOW + 100_000 })
assert.equal(recent.length, 1, '同一句话刷新时间而不是堆叠')

console.log('ear-seen: 全部通过')
