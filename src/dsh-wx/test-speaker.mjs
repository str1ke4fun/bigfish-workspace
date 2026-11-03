// 发言人归因：node test-speaker.mjs
// 只测纯函数；不读屏、不写台账。
import assert from 'node:assert/strict'

import { attributeMessages, looksLikeDirect, parsePreviewSender, requesterOf, samePreviewText } from './lib/speaker.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

console.log('侧栏预览')
t('群聊预览的「名字: 内容」能读出人和正文', () => {
  const r = parsePreviewSender('安卓4224柚厨圣: 明天几点出发')
  assert.equal(r.sender, '安卓4224柚厨圣')
  assert.equal(r.text, '明天几点出发')
  assert.equal(r.confidence, 'medium')
})
t('全角冒号也认', () => {
  assert.equal(parsePreviewSender('甲：在吗').sender, '甲')
})
t('系统标记、自己说的话、「你」都不算发言人', () => {
  assert.equal(parsePreviewSender('[图片]').sender, null)
  assert.equal(parsePreviewSender('你: 好').sender, null)
  assert.equal(parsePreviewSender('系统消息: 已撤回').sender, null)
})
t('没有冒号就不猜', () => {
  const r = parsePreviewSender('明天几点出发')
  assert.equal(r.sender, null)
  assert.equal(r.confidence, 'unknown')
})
t('单聊预览通常没有前缀', () => {
  assert.equal(looksLikeDirect('明天几点出发'), true)
  assert.equal(looksLikeDirect('甲: 明天几点出发'), false)
})
t('预览和正文只按前缀对齐，短文本不硬配', () => {
  assert.equal(samePreviewText('明天几点出发', '明天几点出发呀'), true)
  assert.equal(samePreviewText('好', '好的'), false)
  assert.equal(samePreviewText('完全不同', '明天'), false)
})

console.log('归因')
t('私聊：对方就是会话名，high', () => {
  const out = attributeMessages({
    chat: '大白饭', isDM: true, messages: [{ text: '吃了吗' }, { text: '在吗' }], now: 0,
  })
  assert.deepEqual(out.map((m) => m.sender), ['大白饭', '大白饭'])
  assert.ok(out.every((m) => m.senderConfidence === 'high' && m.direction === 'in'))
})
t('群聊：只有对得上预览的那一条得到 medium，别的不猜', () => {
  const out = attributeMessages({
    chat: '测试群A',
    preview: '甲: 明天几点出发',
    messages: [{ text: '前一屏的话' }, { text: '明天几点出发' }],
  })
  assert.equal(out[0].sender, null)
  assert.equal(out[0].senderConfidence, 'unknown')
  assert.equal(out[1].sender, '甲')
  assert.equal(out[1].senderConfidence, 'medium')
})
t('预览对不上任何一条时，谁都不套', () => {
  const out = attributeMessages({ chat: '测试群A', preview: '甲: 别的话', messages: [{ text: '当前这屏' }] })
  assert.equal(out[0].sender, null)
})
t('出站回执：她自己刚发的原文 → out，不冒充发言人', () => {
  const now = Date.UTC(2026, 10, 3, 4, 0, 0)
  const out = attributeMessages({
    chat: '测试群A',
    messages: [{ text: '我来回答一下' }, { text: '别人说的' }],
    outbox: [{ chat: '测试群A', text: '我来回答一下', at: now - 1000 }],
    now,
  })
  assert.equal(out[0].direction, 'out')
  assert.equal(out[0].sender, null)
  assert.equal(out[0].senderConfidence, 'high')
  assert.equal(out[1].direction, 'in')
})
t('结构化发言人优先，不覆盖', () => {
  const out = attributeMessages({
    chat: '测试群A', preview: '甲: 同一句', messages: [{ text: '同一句', sender: '乙', senderConfidence: 'high' }],
  })
  assert.equal(out[0].sender, '乙')
  assert.equal(out[0].senderConfidence, 'high')
})
t('正文里写了「张三说」也不当发言人', () => {
  const out = attributeMessages({ chat: '测试群A', messages: [{ text: '张三说明天放假' }] })
  assert.equal(out[0].sender, null)
})

console.log('谁在找她')
t('私聊返回会话名；群聊只认预览头', () => {
  assert.deepEqual(requesterOf({ chat: '大白饭', isDM: true }), { name: '大白饭', kind: 'dm', confidence: 'high' })
  assert.deepEqual(requesterOf({ chat: '测试群A', preview: '甲: 在吗' }), { name: '甲', kind: 'group-member', confidence: 'medium' })
  assert.deepEqual(requesterOf({ chat: '测试群A', preview: '在吗' }), { name: null, kind: 'unknown', confidence: 'unknown' })
})

console.log(`\n${n} 项通过`)
