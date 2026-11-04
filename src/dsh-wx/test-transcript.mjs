// 聊天区消息行解析：node test-transcript.mjs
// 只测纯函数；不读屏、不写台账。
import assert from 'node:assert/strict'

import {
  isTimeMarker,
  kindOfLabel,
  normalizeMessages,
  parseSidebarTime,
  splitMessageLabel,
} from './lib/transcript.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const NOW = new Date(2026, 10, 4, 15, 0, 0).getTime() // 本地时间 2026-11-04 15:00
const iso = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0).toISOString()

console.log('侧栏时间')
t('14:02 落在今天', () => {
  assert.deepEqual(parseSidebarTime('14:02', NOW), { at: iso(2026, 11, 4, 14, 2), confidence: 'medium' })
})
t('Yesterday 16:29 落在昨天', () => {
  assert.deepEqual(parseSidebarTime('Yesterday 16:29', NOW), { at: iso(2026, 11, 3, 16, 29), confidence: 'medium' })
})
t('Monday 取最近一次周一，无时间用 00:00', () => {
  assert.deepEqual(parseSidebarTime('Monday', NOW), { at: iso(2026, 11, 2, 0, 0), confidence: 'medium' })
})
t('昨天 09:05 用中文前缀', () => {
  assert.deepEqual(parseSidebarTime('昨天 09:05', NOW), { at: iso(2026, 11, 3, 9, 5), confidence: 'medium' })
})
t('14:02 晚于 now 一分钟以上 → 退到昨天', () => {
  const morning = new Date(2026, 10, 4, 9, 0, 0).getTime()
  assert.deepEqual(parseSidebarTime('14:02', morning), { at: iso(2026, 11, 3, 14, 2), confidence: 'medium' })
})
t('读不出的时间标记 → 空时间、低置信', () => {
  assert.deepEqual(parseSidebarTime('下午三点', NOW), { at: '', confidence: 'low' })
})

console.log('时间标记')
t('整行是时间才算标记', () => {
  assert.equal(isTimeMarker('14:02'), true)
  assert.equal(isTimeMarker('Yesterday 16:29'), true)
  assert.equal(isTimeMarker('Monday'), true)
  assert.equal(isTimeMarker('14:02 开会'), false)
  assert.equal(isTimeMarker('今天 09:00'), true)
  assert.equal(isTimeMarker('星期三 09:00'), true)
  assert.equal(isTimeMarker('普通一句话'), false)
})

console.log('消息行拆分')
t('引用行拆出作者和原文', () => {
  assert.deepEqual(
    splitMessageLabel("那里润\nQuote 计科4221陈子助's message: 很润是吧"),
    { text: '那里润', quote: { author: '计科4221陈子助', text: '很润是吧' }, kind: 'text' },
  )
})
t('贴纸、图片、普通文字各自归类', () => {
  assert.equal(splitMessageLabel('Animated Stickers').kind, 'sticker')
  assert.equal(splitMessageLabel('[Image]').kind, 'image')
  assert.deepEqual(splitMessageLabel('普通一句话'), { text: '普通一句话', quote: null, kind: 'text' })
})
t('中文标记也认', () => {
  assert.equal(kindOfLabel('[图片]'), 'image')
  assert.equal(kindOfLabel('[动画表情]'), 'sticker')
  assert.equal(kindOfLabel('[语音]'), 'voice')
  assert.equal(kindOfLabel('[文件]'), 'file')
  assert.equal(kindOfLabel('[视频]'), 'video')
  assert.equal(kindOfLabel('[链接]'), 'link')
  assert.equal(kindOfLabel('图片'), 'text')
})
t('引用一条图片：正文保留标记，类型仍是图片', () => {
  assert.deepEqual(
    splitMessageLabel("[Image]\nQuote 张三's message: 原文"),
    { text: '[Image]', quote: { author: '张三', text: '原文' }, kind: 'image' },
  )
})

console.log('整屏归一')
t('时间标记只推进当前时间，不产出消息', () => {
  const box = { x: 1, y: 2, w: 3, h: 4 }
  const out = normalizeMessages([{ text: '14:02', box }, { text: '甲说' }, { text: '乙说' }], { now: NOW })
  assert.equal(out.length, 2)
  assert.ok(out.every((m) => m.at === iso(2026, 11, 4, 14, 2) && m.atConfidence === 'medium'))
})
t('末尾连续三条相同贴纸 → 表情面板浮层，整体丢弃', () => {
  const out = normalizeMessages([{ text: 'Animated Stickers' }, { text: 'Animated Stickers' }, { text: 'Animated Stickers' }])
  assert.deepEqual(out, [])
})
t('贴纸后面还有人说话 → 贴纸保留', () => {
  const out = normalizeMessages([{ text: 'Animated Stickers' }, { text: '后面还有人说话' }])
  assert.equal(out.length, 2)
  assert.equal(out[0].kind, 'sticker')
  assert.equal(out[0].text, 'Animated Stickers')
})
t('引用与 box 原样带出', () => {
  const box = { x: 9, y: 9, w: 9, h: 9 }
  const out = normalizeMessages([{ text: "那里润\nQuote 张三's message: 原文", box }])
  assert.equal(out.length, 1)
  assert.equal(out[0].quote.author, '张三')
  assert.equal(out[0].box, box)
})
t('时间标记前的消息没有时间，之后的消息用标记时间', () => {
  const out = normalizeMessages([
    { text: '标记前' },
    { text: '14:02' },
    { text: '标记后' },
    { text: '昨天 09:05' },
    { text: '再后面' },
  ], { now: NOW })
  assert.deepEqual(out.map((m) => m.text), ['标记前', '标记后', '再后面'])
  assert.equal(out[0].at, '')
  assert.equal(out[0].atConfidence, 'unknown')
  assert.equal(out[1].at, iso(2026, 11, 4, 14, 2))
  assert.equal(out[2].at, iso(2026, 11, 3, 9, 5))
})
t('不在末尾的相同贴纸不丢', () => {
  const out = normalizeMessages([
    { text: 'Animated Stickers' },
    { text: 'Animated Stickers' },
    { text: 'Animated Stickers' },
    { text: '后面还有人说话' },
  ])
  assert.equal(out.length, 4)
})

console.log(`\n${n} 项通过`)
