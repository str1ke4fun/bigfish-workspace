import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presenceDocText } from '../lib/presence-view.js'

const row = (dk, workMin = 0, eventMin = 0, ambientMin = 0) => ({ dk, workMin, eventMin, ambientMin })

test('空数据返回空串，不输出空标题', () => {
  assert.equal(presenceDocText([]), '')
  assert.equal(presenceDocText(undefined), '')
  assert.equal(presenceDocText([row('2026-11-13')]), '')
})

test('按天渲染大致在做什么，不报分钟表，最多 3 天', () => {
  const text = presenceDocText([
    row('2026-11-13', 180, 40, 0),
    row('2026-11-12', 0, 90, 15),
    row('2026-11-11', 60, 0, 0),
    row('2026-11-10', 10, 0, 0),
  ])
  assert.match(text, /## 他这几天/)
  assert.match(text, /11-13：大半天在做事；玩了一会儿游戏/)
  assert.match(text, /11-12：玩了好一阵游戏；在旁边看了一会儿/)
  assert.match(text, /11-11：有一阵在做事/)
  assert.doesNotMatch(text, /分钟|小时/)
  assert.ok(!text.includes('11-10'), '最多 3 天')
})

test('超过 200 字按整行截断，加省略号', () => {
  const rows = Array.from({ length: 3 }, (_, i) => row(`2026-11-1${3 - i}`, 60 + i, 30))
  const text = presenceDocText(rows, { maxChars: 40 })
  assert.ok(text.length <= 41)
  assert.ok(text.endsWith('…'))
  assert.ok(!text.includes('11-11'))
})
