// 发言人几何对齐：node test-speaker-align.mjs
// 只测纯函数；不读屏、不 OCR、不写台账。
import assert from 'node:assert/strict'

import { alignSpeakers, planSpeakerRepairs } from './lib/speaker-align.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

const rosterOf = (match) => ({ resolve: (raw) => (match(raw) ? { name: raw, matched: true } : { name: raw, matched: false }) })

console.log('名字行对齐')
t('名册命中：medium，用名册名字', () => {
  const roster = {
    resolve: (raw) => (raw === '计科 4223 薛长顺'
      ? { name: '计科4223薛长顺', matched: true }
      : { name: raw, matched: false }),
  }
  const out = alignSpeakers(
    [{ text: '那里润', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '计科 4223 薛长顺', x: 120, y: 105, w: 200, h: 14, conf: 82 }],
    { roster },
  )
  assert.deepEqual(out[0], { text: '那里润', sender: '计科4223薛长顺', senderConfidence: 'medium', direction: 'in' })
})

t('没有名册：保留原文、low', () => {
  const out = alignSpeakers(
    [{ text: '那里润', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '某 人', x: 120, y: 105, w: 60, h: 14, conf: 82 }],
    {},
  )
  assert.deepEqual(out[0], { text: '那里润', sender: '某 人', senderConfidence: 'low', direction: 'in' })
})

t('名册不匹配：仍用原文、low', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '陌生人', x: 120, y: 105, w: 60, h: 14, conf: 82 }],
    { roster: { resolve: (raw) => ({ name: '别人的名字', matched: false }) } },
  )
  assert.equal(out[0].sender, '陌生人')
  assert.equal(out[0].senderConfidence, 'low')
})

// OCR 常把头像图标读成 `+e `、`< ` 之类的前缀。名册里其实有真名，
// 精确匹配失败时取最后一个空白后的片段再查一次。
const rosterOfEntries = (entries) => ({
  resolve: (raw) => (Object.hasOwn(entries, raw)
    ? { name: entries[raw], matched: true }
    : { name: raw, matched: false }),
})
const nameLineOf = (text) => [{ text, x: 120, y: 105, w: 60, h: 14, conf: 82 }]
const messageOf = () => [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }]

t('图标前缀 `+e ` 去掉后再查名册', () => {
  const out = alignSpeakers(
    messageOf(),
    nameLineOf('+e cat不到flag的cat'),
    { roster: rosterOfEntries({ 'cat不到flag的cat': 'cat不到flag的cat' }) },
  )
  assert.equal(out[0].sender, 'cat不到flag的cat')
  assert.equal(out[0].senderConfidence, 'medium')
})

t('图标前缀 `< ` 去掉后再查名册', () => {
  const out = alignSpeakers(
    messageOf(),
    nameLineOf('< cat不到flag的cat'),
    { roster: rosterOfEntries({ 'cat不到flag的cat': 'cat不到flag的cat' }) },
  )
  assert.equal(out[0].sender, 'cat不到flag的cat')
  assert.equal(out[0].senderConfidence, 'medium')
})

t('tail 也不认识时仍保留 raw、low', () => {
  const out = alignSpeakers(
    messageOf(),
    nameLineOf('+e nobody'),
    { roster: rosterOfEntries({ 'cat不到flag的cat': 'cat不到flag的cat' }) },
  )
  assert.equal(out[0].sender, '+e nobody')
  assert.equal(out[0].senderConfidence, 'low')
})

t('精确匹配优先于 tail', () => {
  const out = alignSpeakers(
    messageOf(),
    nameLineOf('cat不到flag的cat'),
    { roster: rosterOfEntries({ 'cat不到flag的cat': 'cat不到flag的cat' }) },
  )
  assert.equal(out[0].sender, 'cat不到flag的cat')
  assert.equal(out[0].senderConfidence, 'medium')
})

t('含空格的英文名精确匹配优先，不被 tail 改写', () => {
  const out = alignSpeakers(
    messageOf(),
    nameLineOf('Tina Yu'),
    { roster: rosterOfEntries({ 'Tina Yu': 'Tina Yu', Yu: '错误的人' }) },
  )
  assert.equal(out[0].sender, 'Tina Yu')
  assert.equal(out[0].senderConfidence, 'medium')
})

t('tail 命中时采用名册返回的规范名', () => {
  const out = alignSpeakers(
    messageOf(),
    nameLineOf('小红 张三'),
    { roster: rosterOfEntries({ 张三: '张三丰' }) },
  )
  assert.equal(out[0].sender, '张三丰')
  assert.equal(out[0].senderConfidence, 'medium')
})

t('名字行不在名字带里不算', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '张三', x: 120, y: 140, w: 40, h: 14, conf: 90 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out[0].sender, null)
  assert.equal(out[0].senderConfidence, 'unknown')
})

t('低置信 OCR 行不当名字', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '张三', x: 120, y: 105, w: 40, h: 14, conf: 49 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out[0].sender, null)
})

t('多个候选：取离 top 最近的', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '甲', x: 120, y: 110, w: 30, h: 14, conf: 95 },
     { text: '乙', x: 120, y: 100, w: 30, h: 14, conf: 60 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out[0].sender, '乙')
})

t('候选距离并列：取置信度高的', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '甲', x: 120, y: 105, w: 30, h: 14, conf: 60 },
     { text: '乙', x: 120, y: 105, w: 30, h: 14, conf: 90 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out[0].sender, '乙')
})

console.log('方向')
t('右侧对齐、无名字行 → out', () => {
  const out = alignSpeakers(
    [{ text: '我自己说的', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '我自己说的', x: 650, y: 130, w: 100, h: 16, conf: 90 }],
    { pane: { left: 100, right: 800 } },
  )
  assert.deepEqual(out[0], { text: '我自己说的', sender: null, senderConfidence: 'unknown', direction: 'out' })
})

t('文字行在左侧、无名字 → in/unknown', () => {
  const out = alignSpeakers(
    [{ text: '别人说的', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '别人说的', x: 140, y: 130, w: 100, h: 16, conf: 90 }],
    { pane: { left: 100, right: 800 } },
  )
  assert.equal(out[0].direction, 'in')
  assert.equal(out[0].sender, null)
  assert.equal(out[0].senderConfidence, 'unknown')
})

t('不给 pane 时从消息框推导', () => {
  const out = alignSpeakers(
    [{ text: '右侧的话', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '右侧的话', x: 600, y: 130, w: 80, h: 16, conf: 90 }],
    {},
  )
  assert.equal(out[0].direction, 'out')
})

t('没有正文匹配行时默认 in/unknown', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [],
    {},
  )
  assert.deepEqual(out[0], { text: '正文', sender: null, senderConfidence: 'unknown', direction: 'in' })
})

console.log('什么不能当名字')
t('时间行、贴纸行不能当名字', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '14:02', x: 120, y: 105, w: 50, h: 14, conf: 90 },
     { text: 'Animated Stickers', x: 120, y: 120, w: 150, h: 14, conf: 90 }],
    {},
  )
  assert.equal(out[0].sender, null)
})

t('气泡文字落在名字带里，不能被当成人名', () => {
  const out = alignSpeakers(
    [{ text: '很短', box: { x: 100, y: 100, w: 600, h: 40 } }],
    [{ text: '很短', x: 120, y: 105, w: 40, h: 16, conf: 90 }],
    { pane: { left: 100, right: 800 } },
  )
  assert.equal(out[0].sender, null)
})

t('正文 ≥4 字时，候选与正文互相包含也不当名字', () => {
  const out = alignSpeakers(
    [{ text: '今天中午一起吃饭', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '一起吃饭', x: 120, y: 105, w: 80, h: 14, conf: 90 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out[0].sender, null)
})

t('带标点的行不当名字', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '张三：你好', x: 120, y: 105, w: 80, h: 14, conf: 90 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out[0].sender, null)
})

console.log('坐标不二次缩放')
t('box.y=100 就是屏幕 100，名字行 y=105 命中', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '张三', x: 125, y: 105, w: 40, h: 14, conf: 80 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out[0].sender, '张三')
})

t('输出与消息等长同序，坏输入不崩', () => {
  const out = alignSpeakers(
    [{ text: '甲句', box: { x: 100, y: 100, w: 200, h: 40 } }, null, { text: '乙句', box: { x: 100, y: 200, w: 200, h: 40 } }],
    [{ text: '张三', x: 120, y: 105, w: 40, h: 14, conf: 90 }, null],
    { roster: rosterOf(() => true) },
  )
  assert.equal(out.length, 3)
  assert.equal(out[0].sender, '张三')
  assert.equal(out[2].sender, null)
})

t('第三个参数传 null 也按空选项处理', () => {
  const out = alignSpeakers(
    [{ text: '正文', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [],
    null,
  )
  assert.deepEqual(out[0], { text: '正文', sender: null, senderConfidence: 'unknown', direction: 'in' })
})

console.log('台账补发言人')
t('只补空位：已有发言人的不覆盖', () => {
  const out = planSpeakerRepairs(
    [{ text: '你好', sender: '张三', senderConfidence: 'medium' },
     { text: '收到', sender: '李四', senderConfidence: 'low' },
     { text: '已经有人', sender: '王五', senderConfidence: 'medium' }],
    [{ msgId: 'm1', text: '你好', sender: null },
     { msgId: 'm2', text: '收到', sender: null },
     { msgId: 'm3', text: '已经有人', sender: '赵六' }],
  )
  assert.deepEqual(out, [
    { msgId: 'm1', sender: '张三', senderConfidence: 'medium' },
    { msgId: 'm2', sender: '李四', senderConfidence: 'low' },
  ])
})

t('同一文本取最后一条未识别记录', () => {
  const out = planSpeakerRepairs(
    [{ text: '同一句', sender: '张三', senderConfidence: 'medium' }],
    [{ msgId: 'a', text: '同一句', sender: null },
     { msgId: 'b', text: '同一句', sender: null }],
  )
  assert.deepEqual(out, [{ msgId: 'b', sender: '张三', senderConfidence: 'medium' }])
})

t('aligned 没识别出人的不补', () => {
  const out = planSpeakerRepairs(
    [{ text: '你好', sender: null, senderConfidence: 'unknown' }],
    [{ msgId: 'm1', text: '你好', sender: null }],
  )
  assert.deepEqual(out, [])
})

t('同一 msgId 不生成两条', () => {
  const out = planSpeakerRepairs(
    [{ text: '同一句', sender: '张三', senderConfidence: 'medium' },
     { text: '同一句', sender: '张三', senderConfidence: 'medium' }],
    [{ msgId: 'a', text: '同一句', sender: null }],
  )
  assert.deepEqual(out, [{ msgId: 'a', sender: '张三', senderConfidence: 'medium' }])
})

t('alignSpeakers 结果可直接交给 planSpeakerRepairs', () => {
  const aligned = alignSpeakers(
    [{ text: '你好', box: { x: 100, y: 100, w: 600, h: 80 } }],
    [{ text: '张三', x: 120, y: 105, w: 40, h: 14, conf: 90 }],
    { roster: rosterOf(() => true) },
  )
  assert.equal(aligned[0].text, '你好')
  const repairs = planSpeakerRepairs(aligned, [{ msgId: 'm1', text: '你好', sender: null }])
  assert.deepEqual(repairs, [{ msgId: 'm1', sender: '张三', senderConfidence: 'medium' }])
})

console.log(`\n${n} 项通过`)
