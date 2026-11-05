// 当前打开会话的唤醒补丁：侧栏没有未读，也要能叫醒她。
// 跑：node test-ear-open.mjs
//
// 背景：2026-11-05 13:39 的「午安」和 11-04 17:22 的同一条，都发生在
// 会话正好开着的时候——微信不给未读角标，mentionHits 的 unread>0 判据看不到。
// 补丁只认「这一轮新记进台账、且和侧栏 preview 对得上」的入站消息。
import assert from 'node:assert/strict'
import { looksDM, openChatHit, OPEN_HIT_MAX_AGE_MS } from './lib/ear-open.js'

const NOW = Date.parse('2026-11-05T05:40:00.000Z')
const POLICY = {
  allowChats: ['cat不到flag的cat', 'Tina Yu', '测试群A'],
  noMentionChats: ['cat不到flag的cat'],
}
const row = (over = {}) => ({ name: 'cat不到flag的cat', unread: 0, preview: '午安', time: '13:39', ...over })
const rec = (over = {}) => ({ msgId: 'm_1', text: '午安', direction: 'in', at: '2026-11-05T05:39:00.000Z', ...over })
const captured = (...records) => ({ ok: true, added: records.length, skipped: 0, records, dropped: [] })
const hit = (over = {}) => openChatHit({
  chat: 'cat不到flag的cat', row: row(), captured: captured(rec()), policy: POLICY, now: NOW, ...over,
})

// 1. 免 @ 私聊：unread=0，新入账的「午安」与侧栏预览一致 → 叫她
assert.deepEqual(hit(), {
  chat: 'cat不到flag的cat',
  why: 'exempt',
  preview: '午安',
  unread: 0,
  key: 'capture:m_1',
})

// 2. 侧栏已经有未读：老路径会叫，不重复
assert.equal(hit({ row: row({ unread: 1 }) }), null)

// 3. 允许名单里的单聊（不在免 @ 名单）→ why=dm
assert.deepEqual(
  hit({ chat: 'Tina Yu', row: row({ name: 'Tina Yu', preview: '在吗' }), captured: captured(rec({ text: '在吗' })) }),
  { chat: 'Tina Yu', why: 'dm', preview: '在吗', unread: 0, key: 'capture:m_1' },
)

// 4. 群聊预览带「发送者:」前缀 → 不算单聊，不靠预览叫（群里只看 @）
assert.equal(
  hit({ chat: '测试群A', row: row({ name: '测试群A', preview: '张三: 午安' }), captured: captured(rec({ text: '午安' })) }),
  null,
)

// 5. 不在允许 / 免 @ 名单 → 不叫
assert.equal(hit({ chat: 'Tencent News', row: row({ name: 'Tencent News' }) }), null)

// 6. 只有出站记录 → 不叫
assert.equal(hit({ captured: captured(rec({ direction: 'out' })) }), null)

// 7. 新记录对不上侧栏预览（例如 speaker 归因把她的旧回复又记成入站）→ 不叫
assert.equal(hit({ captured: captured(rec({ text: '午安。我这儿中午照旧' })) }), null)

// 8. 旧记录（超过窗口）→ 不叫
assert.equal(
  hit({ captured: captured(rec({ at: new Date(NOW - OPEN_HIT_MAX_AGE_MS - 60_000).toISOString() })) }),
  null,
)

// 9. 只有 preview 重复记录被 drop（老消息）→ 不叫。dropped 不是新消息。
assert.equal(
  hit({ captured: { ok: true, added: 0, records: [], dropped: [rec()] } }),
  null,
)

// 10. 预览被截断时按前缀匹配（侧栏显示不下整句）
assert.deepEqual(
  hit({
    row: row({ preview: '今天天气不错' }),
    captured: captured(rec({ text: '今天天气不错，出去走走吧' })),
  })?.key,
  'capture:m_1',
)

// 11. 多匹配取最新一条；没有 preview / 没抓到记录 → 不叫
assert.equal(
  hit({
    captured: captured(rec({ msgId: 'm_old', at: '2026-11-05T05:30:00.000Z' }), rec({ msgId: 'm_new' })),
  })?.key,
  'capture:m_new',
)
assert.equal(hit({ row: row({ preview: '' }) }), null)
assert.equal(hit({ captured: { ok: false, records: [], dropped: [] } }), null)
assert.equal(hit({ row: null }), null)
assert.equal(hit({ chat: '' }), null)

// 12. 单聊预览的识别规则
assert.equal(looksDM({ preview: '午安' }), true)
assert.equal(looksDM({ preview: '张三: 午安' }), false)
assert.equal(looksDM({ preview: '' }), false)

console.log('ear-open: 全部通过')
