import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitSentences,
  dwellMs,
  createPager,
  clampBubbleOpacity,
  clampBubbleWidth,
  defaultBubbleWidth,
  pageBubble,
  PAGE_BUBBLE_ID,
} from '../renderer/bubble-pages.ts'

test('按句末标点和换行切句，标点留在句尾', () => {
  assert.deepEqual(splitSentences('你好。今天累吗？早点睡！\n明天见'), ['你好。', '今天累吗？', '早点睡！', '明天见'])
})

test('连续标点和引号跟在同一句里', () => {
  assert.deepEqual(splitSentences('真的吗？！好吧……行。'), ['真的吗？！', '好吧……', '行。'])
})

test('超长句按逗号再拆，每段不超过上限', () => {
  const long = '这一局你打得很稳，前面几波团战都没有乱，最后那个换位置的操作也很漂亮，我看着都替你高兴'
  const parts = splitSentences(long, 20)
  assert.ok(parts.length >= 3)
  for (const part of parts) assert.ok(part.length <= 20, part)
  assert.equal(parts.join(''), long)
})

test('没有逗号的超长句硬切，不丢字', () => {
  const long = '啊'.repeat(45)
  const parts = splitSentences(long, 20)
  assert.equal(parts.join(''), long)
  for (const part of parts) assert.ok(part.length <= 20)
})

test('空白和空串返回空数组', () => {
  assert.deepEqual(splitSentences(''), [])
  assert.deepEqual(splitSentences('  \n \n'), [])
})

test('停留时长：短句保底 2.5 秒，长句按字数', () => {
  assert.equal(dwellMs('嗯。'), 2500)
  assert.equal(dwellMs('字'.repeat(40)), 7200)
})

test('分页器依次显示每一句，最后一句播完后收起', () => {
  const shown: string[] = []
  let closed = 0
  const timers: Array<{ fn: () => void; ms: number }> = []
  const pager = createPager({
    show: (text) => shown.push(text),
    close: () => { closed += 1 },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => {},
  })
  pager.play('一句。两句。')
  assert.deepEqual(shown, ['一句。'])
  timers.shift()!.fn()
  assert.deepEqual(shown, ['一句。', '两句。'])
  assert.equal(closed, 0)
  timers.shift()!.fn()
  assert.equal(closed, 1)
})

test('新消息取消上一轮：旧计时器被清掉，不会再翻旧页', () => {
  const shown: string[] = []
  const cleared: number[] = []
  let id = 0
  const pager = createPager({
    show: (text) => shown.push(text),
    close: () => {},
    setTimer: () => ++id,
    clearTimer: (handle) => { cleared.push(handle as number) },
  })
  pager.play('甲。乙。')
  pager.play('丙。')
  assert.deepEqual(cleared, [1])
  assert.deepEqual(shown, ['甲。', '丙。'])
})

test('空文本不弹气泡', () => {
  const shown: string[] = []
  const pager = createPager({
    show: (text) => shown.push(text),
    close: () => {},
    setTimer: () => 1,
    clearTimer: () => {},
  })
  pager.play('   ')
  assert.deepEqual(shown, [])
})

test('透明度夹在 40–100，非法值回默认 90', () => {
  assert.equal(clampBubbleOpacity(10), 40)
  assert.equal(clampBubbleOpacity(150), 100)
  assert.equal(clampBubbleOpacity(70.4), 70)
  assert.equal(clampBubbleOpacity('x'), 90)
})

test('宽度夹在 220–420；0 或非法表示跟随尺寸', () => {
  assert.equal(clampBubbleWidth(100), 220)
  assert.equal(clampBubbleWidth(999), 420)
  assert.equal(clampBubbleWidth(300), 300)
  assert.equal(clampBubbleWidth(0), 0)
  assert.equal(clampBubbleWidth(undefined), 0)
  assert.equal(defaultBubbleWidth(400), 300)
  assert.equal(defaultBubbleWidth(240), 240)
  assert.equal(defaultBubbleWidth(560), 360)
})

test('动作只跟首句走：show 的第三个参数首句有、后续没有', () => {
  const calls: Array<[string, number, string | undefined]> = []
  const timers: Array<() => void> = []
  const pager = createPager({
    show: (text, index, motion) => calls.push([text, index, motion]),
    close: () => {},
    setTimer: (fn) => { timers.push(fn); return timers.length },
    clearTimer: () => {},
  })
  pager.play('一句。两句。', 'waving')
  timers.shift()!()
  assert.deepEqual(calls, [['一句。', 0, 'waving'], ['两句。', 1, undefined]])
})

test('翻页气泡常驻：不带 timeout 以外的时长，也不带 motion，收起只由分页器负责', () => {
  const options = pageBubble('这一局你打得很稳。')
  assert.equal(options.id, PAGE_BUBBLE_ID)
  assert.equal(options.description, '这一局你打得很稳。')
  assert.equal(options.timeout, 0)
  assert.equal('motion' in options, false)
})
