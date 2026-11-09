// dsh-wx 工具返回投影：只测纯函数，不启动 GUI、不 import 整个插件。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { lazyRender, projectWxContext, projectWxOcr, projectWxPeek } from '../lib/project.js'

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

test('wx_ocr 解析失败保留原文并截断 2000 字', () => {
  const raw = '不是 JSON ' + '字'.repeat(3000)
  const text = projectWxOcr(raw)
  assert.match(text, /不是 JSON/)
  assert.ok(text.length <= 2040, `长度应为 2000 左右，实际 ${text.length}`)
  assert.match(text, /截断/)
})

test('wx_peek 投影去掉 box=[…] 并截断 12000 字', () => {
  const raw = '会话「测试群」 box=[10,20,300,40]\n「晚上来吗」\n' + '正'.repeat(13000)
  const text = projectWxPeek(raw)
  assert.equal(text.includes('box=['), false)
  assert.match(text, /测试群/)
  assert.match(text, /晚上来吗/)
  assert.ok(text.length <= 12_040, `长度应为 12000 左右，实际 ${text.length}`)
  assert.match(text, /截断/)
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
