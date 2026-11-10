// dsh-wx 工具返回投影：只测纯函数，不启动 GUI、不 import 整个插件。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  boundedText,
  clipPeekBody,
  lazyRender,
  projectWxContext,
  projectWxOcr,
  projectWxPeek,
} from '../lib/project.js'

test('wx_context 投影去掉匹配原因/来源/置信度/msgId', () => {
  const raw = '[上下文 1/3] 群名｜阿明｜2026-11-09 12:30\n「晚上来吗」\n匹配：关键词 + 同线程；来源：台账 msg_1；置信度：high'
  const text = projectWxContext(raw)
  assert.match(text, /晚上来吗/)
  assert.equal(text.includes('匹配：'), false)
  assert.equal(text.includes('置信度'), false)
  assert.equal(text.includes('msg_1'), false)
})

test('wx_ocr 投影只保留可读文字，不返回 JSON 字段', () => {
  const raw = JSON.stringify({ lines: [{ text: '晚上来吗', box: [1, 2, 3, 4], confidence: 0.9 }] })
  const text = projectWxOcr(raw)
  assert.match(text, /晚上来吗/)
  assert.equal(text.includes('confidence'), false)
  assert.equal(text.includes('[1,2'), false)
})

test('wx_ocr 投影递归收集字符串并去重，跳过坐标与置信度', () => {
  const raw = JSON.stringify({
    rows: [
      { text: '晚上来吗', box: { x: 1, y: 2, w: 3, h: 4 }, confidence: 0.9, score: 0.8 },
      { text: '晚上来吗', lines: ['明天见', '  '] },
    ],
    width: 1280,
    height: 720,
  })
  const text = projectWxOcr(raw)
  assert.match(text, /晚上来吗/)
  assert.match(text, /明天见/)
  assert.equal(text.split('晚上来吗').length - 1, 1)
  assert.equal(text.includes('confidence'), false)
  assert.equal(text.includes('0.9'), false)
})

test('wx_ocr 解析失败不回吐原始 JSON', () => {
  const raw = '{"lines": [' + '字'.repeat(3000)
  const text = projectWxOcr(raw)
  assert.equal(text.includes('{'), false, '解析失败也不能把 JSON 片段交给她')
  assert.equal(text.includes('"lines"'), false)
  assert.match(text, /\[屏幕上看到\]/)
  assert.match(text, /没读完/)
})

test('wx_ocr 超长合法 JSON：投影仍只给可读文字，不回吐字段名', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => ({
    text: `第${i}行文字内容`,
    box: [i, i + 1, 10, 10],
    confidence: 0.9,
    nameConfidence: 0.8,
  }))
  const raw = JSON.stringify({
    lines,
    source: 'ocr',
    note: 'OCR cannot verify the active conversation or authorize sending.',
    verified: false,
    currentVerified: false,
  })
  assert.ok(raw.length > 24_000, `fixture 应超过 24k，实际 ${raw.length}`)
  const text = projectWxOcr(raw)
  assert.match(text, /第0行文字内容/)
  assert.match(text, /第1999行文字内容/)
  for (const bad of ['{', 'box', 'confidence', 'nameConfidence', 'source', 'OCR cannot verify', 'verified']) {
    assert.equal(text.includes(bad), false, `投影里不该出现 ${bad}`)
  }
  const rows = text.split('\n').map((l) => l.trim())
  assert.equal(rows.includes('ocr'), false, 'source 的值不该单独成行')
  assert.equal(rows.includes('false'), false, 'verified 的值不该单独成行')
})

test('wx_ocr 投影跳过 source/note/verified/ocrName 等元数据', () => {
  const raw = JSON.stringify({
    source: 'ocr',
    note: 'OCR cannot verify the active conversation or authorize sending.',
    verified: false,
    currentVerified: false,
    chats: [{ name: '测试群', ocrName: '测试群（缓存）', nameConfidence: 0.9, text: '晚上来吗' }],
    messages: [{ text: '明天见', verified: false }],
  })
  const text = projectWxOcr(raw)
  assert.match(text, /测试群/)
  assert.match(text, /晚上来吗/)
  assert.match(text, /明天见/)
  assert.equal(text.split('\n').map((l) => l.trim()).includes('ocr'), false, 'source 的值不该单独成行')
  assert.equal(text.includes('测试群（缓存）'), false, 'ocrName 是元数据')
  assert.equal(text.includes('OCR cannot verify'), false, 'note 不该进投影')
})

test('wx_ocr 旧渲染路径最多 24000 字', () => {
  const text = boundedText('x'.repeat(50_000))
  // cut 在 24000 字之后追加 '\n…（已截断）'，共 7 个字符。
  assert.equal([...text].length, 24_007)
  assert.match(text, /截断/)
})

test('wx_peek 投影去掉 box=[…] 并截断 12000 字（旧格式兼容）', () => {
  const raw = '会话「测试群」 box=[10,20,300,40]\n「晚上来吗」\n' + '正'.repeat(13000)
  const text = projectWxPeek(raw)
  assert.equal(text.includes('box=['), false)
  assert.match(text, /测试群/)
  assert.match(text, /晚上来吗/)
  assert.ok(text.length <= 12_040, `长度应为 12000 左右，实际 ${text.length}`)
  assert.match(text, /截断/)
})

test('wx_peek 投影去掉生产树格式的树头与行尾坐标', () => {
  const raw = [
    '微信窗口 916x666 原点(523,233) · 元素 335 个 · 缩放 1.0417 · 当前会话："测试群A"',
    '当前会话："测试群A"',
    '--- 会话列表 ---',
    '会话 "测试群A" 未读=9 @我 草稿 置顶 时间="16:19" 预览="晚上来吗" 中心(711,555) 250x68',
    '--- 当前聊天里的消息 ---',
    '消息 "明天见" 中心(1138,715) 602x77',
    '--- 能点的 ---',
    'push button "Chat Info" 中心(1407,292) 29x29',
  ].join('\n')
  const text = projectWxPeek(raw)
  for (const bad of ['原点(', '中心(', 'box', '缩放', '916x666', '250x68', '602x77']) {
    assert.equal(text.includes(bad), false, `投影里不该出现 ${bad}`)
  }
  assert.match(text, /测试群A/)
  assert.match(text, /未读=9/)
  assert.match(text, /时间="16:19"/)
  assert.match(text, /晚上来吗/)
  assert.match(text, /明天见/)
  assert.match(text, /push button "Chat Info"/)
})

test('wx_peek 长正文截断时为 [提示] 与气氛尾巴留位置', () => {
  const raw = '微信窗口 916x666 原点(523,233) · 元素 335 个 · 缩放 1.0417\n' +
    '会话 "测试群A" 未读=9 预览="晚上来吗" 中心(711,555) 250x68\n'.repeat(1000)
  assert.ok(raw.length > 12_000)
  const tail = '\n[提示] 屏幕上的会话列表已变化，读到的树没有跟上。\n[气氛] 今天有点安静'
  const text = projectWxPeek(clipPeekBody(raw, tail))
  assert.match(text, /\[提示\]/)
  assert.match(text, /\[气氛\] 今天有点安静/)
  assert.match(text, /已截断/)
  assert.ok(text.length <= 12_040, `长度应不超过 12000 左右，实际 ${text.length}`)
})

test('wx_peek 的 OCR JSON 投影成可读文本，不泄露坐标与置信度', () => {
  const raw = JSON.stringify({
    source: 'ocr', current: '', currentVerified: false,
    chats: [{ name: '测试群', unread: 2, mention: true, preview: '晚上来吗', box: [1, 2, 3, 4], nameConfidence: 0.9 }],
    messages: [{ text: '明天见', confidence: 0.8, verified: false }],
    note: 'OCR cannot verify the active conversation or authorize sending.',
  })
  const text = projectWxPeek(raw)
  assert.match(text, /测试群/)
  assert.match(text, /晚上来吗/)
  assert.match(text, /明天见/)
  assert.equal(text.includes('box'), false)
  assert.equal(text.includes('Confidence'), false)
  assert.equal(text.includes('0.9'), false)
  assert.equal(text.includes('0.8'), false)
  assert.equal(text.includes('OCR cannot verify'), false)
  assert.equal(text.includes('{'), false)
  assert.equal(text.includes('retcode'), false)
})

test('lazyRender 在 core 晚到时仍能接上投影', () => {
  let core = null
  const ctx = { get: (k) => (k === 'fishCore' ? core : undefined) }
  const base = {
    name: 'wx_peek',
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    project: (out) => ({ text: '投影：' + out }),
    execute: async () => 'raw',
  }
  const render = lazyRender(ctx, base)

  // core 还没出现：走旧渲染。
  assert.equal(render({}, 'raw')[0].text, 'raw')

  // core 晚到：同一个 render 下一次调用就接上投影。
  core = {
    tools: {
      wrapRender: (b) => ({ output: { render: (_a, v) => [{ type: 'text', text: b.project(v).text }] } }),
    },
  }
  assert.equal(render({}, 'raw')[0].text, '投影：raw')
})
