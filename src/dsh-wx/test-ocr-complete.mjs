// OCR 补全的纯函数测试：不启动微信，也不跑 tesseract。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { compactText, completeFromOcrLines, joinOcrBubble, ocrStartsWith } from './lib/ocr-complete.js'

const lines = (items) => items.map(([text, top], i) => ({
  text, top, height: 20, left: 20, width: 300, confidence: 80, id: i,
}))

test('OCR 行按开头认预览，不把标点/空格差异当不同句', () => {
  assert.equal(ocrStartsWith('@D33P533K 当别人问你问题的时候，你要多思考', '@ @D33P533K 当别人问你问题的时候 ， 你要多思考 ， 把条'), true)
  assert.equal(ocrStartsWith('@D33P533K 当别人问你问题的时候', '完全无关的一句'), false)
  assert.equal(compactText('不能证明xx/不能完全说明xx ，然后'), '不能证明xx不能完全说明xx然后')
})

test('同一条气泡的多行会拼起来，遇到大间隔就停', () => {
  const list = lines([
    ['@ @D33P533K 当别人问你问题的时候，你要多思考，把条', 0],
    ['件全部列出来，然后给一个非常严谨的答案：不能证明xx/', 21],
    ['不能完全说明xx，然后什么活都停下来不干，这就是大傻', 42],
    ['龙了', 63],
    ['另一条消息', 120],
  ])
  const joined = joinOcrBubble(list, 0)
  assert.equal(joined.lines.length, 4)
  assert.match(joined.text, /这就是大傻龙了/)
  assert.equal(joined.text.includes('另一条消息'), false)
})

test('预览被截断时用 OCR 全文；OCR 更短或对不上就放弃', () => {
  const list = lines([
    ['@ @D33P533K 当别人问你问题的时候，你要多思考，把条', 0],
    ['件全部列出来，然后给一个非常严谨的答案：不能证明xx/', 21],
    ['不能完全说明xx，然后什么活都停下来不干，这就是大傻', 42],
    ['龙了', 63],
  ])
  const preview = '@D33P533K 当别人问你问题的时候，你要多思考，把条件全部列出来，然后给一个非常严谨的答案：…'
  const full = completeFromOcrLines(preview, list)
  assert.match(full, /这就是大傻龙了/)
  assert.equal(completeFromOcrLines('完全无关', list), '')
  assert.equal(completeFromOcrLines(preview, lines([['短', 0]])), '')
})
