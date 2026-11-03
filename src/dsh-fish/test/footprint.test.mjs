/**
 * footprint.test.mjs —— 工作台「B站」页的两串足迹
 *
 * 守的是三件事：
 *   1. 四类看法记账（browse / saw / looked / watched）能合到一条视频一行，不重复列。
 *   2. 老记录只有 BV 号也不丢；标题拿到过就保留，后面的 `looked:` 不许把它冲掉。
 *   3. 评论与回复都算足迹；正文优先用 cbody，没有就留空让 UI 现取，绝不编。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  commentUrl, parseSaw, viewedFromEvents, commentsFromEvents, footprintFromEvents,
} from '../lib/footprint.js'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const BV1 = 'BV1xx411c7mD'
const BV2 = 'BV1yy411c7mE'
const BV3 = 'BV1zz411c7mF'

function meta(text, ts) {
  return { type: 'meta', text, ts, source: 'system' }
}

function saw(text, bvid, ts) {
  return { type: 'saw', text, refs: [bvid], ts, source: 'system' }
}

test('parseSaw 从 200 字摘要里抠出标题、UP、时长和标签', () => {
  const p = parseSaw('B站｜《标题》｜UP：某某｜3分05秒｜标签：技术/生活｜简介：一句话')
  assert.equal(p.title, '标题')
  assert.equal(p.up, '某某')
  assert.equal(p.duration, 185)
  assert.deepEqual(p.tags, ['技术', '生活'])
  assert.equal(p.desc, '一句话')
  // 截断的摘要不该让整条记忆失去标题
  assert.equal(parseSaw('B站｜《只有标题…》').title, '只有标题…')
  assert.equal(parseSaw('').title, '')
})

test('看过的视频：四类记账去重、合并来源，按最近一次出现倒序', () => {
  const events = [
    meta(`browse:2026-11-01 [{"bvid":"${BV1}","title":"旧标题","up":"UP1","duration":600,"view":12000}]`, '2026-11-01T10:00:00Z'),
    saw(`B站｜《新标题》｜UP：UP2｜3分05秒｜标签：技术/生活｜简介：desc`, BV1, '2026-11-02T10:00:00Z'),
    meta(`looked:${BV1}`, '2026-11-03T09:00:00Z'),
    meta(`watched:2026-11-03 ${BV3}`, '2026-11-03T10:00:00Z'),
    // 30 天前的老记录：查 7 天时不该出现
    meta(`looked:${BV2}`, '2026-10-04T10:00:00Z'),
  ]

  const r = viewedFromEvents(events, { days: 7, now: NOW })
  assert.equal(r.total, 2, 'BV1 只算一条，BV2 被时间窗排除')
  assert.deepEqual(r.rows.map((x) => x.bvid).sort(), [BV1, BV3].sort())

  const one = r.rows.find((x) => x.bvid === BV1)
  assert.equal(one.title, '旧标题', '先拿到的标题不能被后面的纯 looked 冲掉')
  assert.equal(one.up, 'UP1')
  assert.equal(one.duration, 600)
  assert.deepEqual(new Set(one.sources), new Set(['browse', 'saw', 'look']))
  assert.equal(one.at, '2026-11-03T09:00:00.000Z', '排序用最近一次出现')
  assert.match(one.url, new RegExp(`/video/${BV1}$`))

  const three = r.rows.find((x) => x.bvid === BV3)
  assert.deepEqual(three.sources, ['watch'])
  assert.equal(three.title, '', '只有 BV 号也照样列出来')
})

test('评论与回复：正文优先 cbody；没有正文就留 null，不猜', () => {
  const events = [
    meta(`comment:2026-11-01 ${BV1} 123`, '2026-11-01T10:00:00Z'),
    meta(`cbody:123 ${JSON.stringify({ kind: 'comment', bvid: BV1, dk: '2026-11-01', text: '她当时说的那句' })}`, '2026-11-01T10:00:01Z'),
    meta(`creply:2026-11-02 ${BV1} 123 456 789`, '2026-11-02T10:00:00Z'),
    meta(`cbody:789 ${JSON.stringify({ kind: 'reply', bvid: BV1, dk: '2026-11-02', rootRpid: 123, parentRpid: 456, text: '回的那句' })}`, '2026-11-02T10:00:01Z'),
    // 更早的一条：没有 cbody，正文应为 null
    meta(`comment:2026-10-01 ${BV3} 321`, '2026-10-01T10:00:00Z'),
  ]

  const r = commentsFromEvents(events, { days: 60, now: NOW })
  assert.equal(r.total, 3)
  const comment = r.rows.find((x) => x.rpid === 123)
  assert.equal(comment.kind, 'comment')
  assert.equal(comment.text, '她当时说的那句')
  assert.equal(comment.url, `https://www.bilibili.com/video/${BV1}#reply123`)

  const reply = r.rows.find((x) => x.rpid === 789)
  assert.equal(reply.kind, 'reply')
  assert.equal(reply.rootRpid, 123)
  assert.equal(reply.parentRpid, 456)
  assert.equal(reply.text, '回的那句')

  const old = r.rows.find((x) => x.rpid === 321)
  assert.equal(old.text, null, '老记录没有正文就是 null，不能编一句')
})

test('时间窗与总入口：footprintFromEvents 同时给出两串足迹', () => {
  const events = [
    meta(`browse:2026-11-01 [{"bvid":"${BV1}","title":"标题"}]`, '2026-11-01T10:00:00Z'),
    meta(`comment:2026-11-01 ${BV1} 123`, '2026-11-01T10:00:00Z'),
    meta(`comment:2026-09-01 ${BV2} 456`, '2026-09-01T10:00:00Z'),
  ]
  const fp = footprintFromEvents(events, { days: 7, now: NOW })
  assert.equal(fp.days, 7)
  assert.equal(fp.viewed.total, 1)
  assert.equal(fp.comments.total, 1)
  assert.equal(fp.comments.rows[0].rpid, 123)
})

test('commentUrl 只认合法 BV 号和正整数 rpid', () => {
  assert.equal(commentUrl(BV1, 123), `https://www.bilibili.com/video/${BV1}#reply123`)
  assert.equal(commentUrl('bad', 123), '')
  assert.equal(commentUrl(BV1, 0), '')
})
