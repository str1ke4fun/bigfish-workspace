import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assistantTextOf, watchTurn } from '../lib/turnend.js'

function bus() {
  const handlers = new Set()
  return {
    on(_ev, fn) { handlers.add(fn); return () => handlers.delete(fn) },
    emit(session, event) { for (const fn of [...handlers]) fn(session, event) },
    size: () => handlers.size,
  }
}

const say = (id, text) => ({
  type: 'assistant/message',
  data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
})

test('assistantTextOf 只取 text block，不取 reasoning / tool-call', () => {
  assert.equal(assistantTextOf(say('s', '  他刚打完一局。 ')), '他刚打完一局。')
  assert.equal(assistantTextOf({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: '草稿' }, { type: 'tool-call', name: 'read_image' }] } },
  }), '')
  assert.equal(assistantTextOf({ type: 'turn/end' }), '')
})

test('watchTurn 拼多步文本，turn/end 只回调一次并自动卸载', () => {
  const b = bus()
  let ended = 0
  let seen = ''
  const w = watchTurn({ on: b.on }, 's1', { onText: (t) => { seen += t }, onEnd: (t) => { ended += 1; seen = t } })
  b.emit({ header: { id: 's2' } }, say('s2', '别的会话'))
  b.emit({ header: { id: 's1' } }, say('s1', '第一句。'))
  b.emit({ header: { id: 's1' } }, say('s1', '第二句。'))
  assert.equal(ended, 0)
  b.emit({ header: { id: 's1' } }, { type: 'turn/end' })
  assert.equal(ended, 1)
  assert.equal(seen, '第一句。\n第二句。')
  assert.equal(w.text(), '第一句。\n第二句。')
  assert.equal(b.size(), 0, 'turn/end 后要卸载监听')
  b.emit({ header: { id: 's1' } }, { type: 'turn/end' })
  assert.equal(ended, 1, '卸载后不再回调')
})
