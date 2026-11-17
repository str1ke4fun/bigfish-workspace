import { test } from 'node:test'
import assert from 'node:assert/strict'

import { WxToolError, parseWxToolError, registerWxToolErrorAdapter } from './lib/tool-error.js'

test('WxToolError 只接受 A-Z0-9_ 组成的 code', () => {
  for (const code of ['', 'WX-lower', 'WX SPACE', 'WX_TOOL_中文']) {
    assert.throws(() => new WxToolError(code, '[没做成]'), TypeError)
    assert.equal(parseWxToolError(`WXTOOL|${code}|[没做成]`), null)
  }
  assert.throws(() => new WxToolError('WX|INJECT', '[没做成]'), TypeError)
  assert.deepEqual(
    parseWxToolError('WXTOOL|WX_OK|第一段|第二段|第三段'),
    { code: 'WX_OK', modelText: '第一段|第二段|第三段' },
  )
})

test('WxToolError 的 modelText 必须是字符串', () => {
  for (const text of [undefined, null, 42, { text: '[没做成]' }]) {
    assert.throws(() => new WxToolError('WX_OK', text), TypeError)
  }
})

test('微信预期错误只替换模型内容，普通错误原样透传', async () => {
  const listeners = []
  const off = registerWxToolErrorAdapter({
    on(event, listener) {
      assert.equal(event, 'tools/post-execute')
      listeners.push(listener)
      return () => listeners.splice(listeners.indexOf(listener), 1)
    },
  })
  assert.equal(listeners.length, 1)

  const listener = listeners[0]
  const error = new WxToolError('WX_NOT_ALLOWED', '[这个会话现在说不了]')
  const result = { isError: true, error, content: [{ type: 'text', text: `Error: ${error.message}` }] }
  const decision = await listener(
    { name: 'wx_send', arguments: {} },
    result,
    () => Promise.resolve({ kind: 'accept' }),
  )

  assert.deepEqual(decision, {
    kind: 'accept',
    content: [{ type: 'text', text: '[这个会话现在说不了]' }],
  })
  assert.equal(result.isError, true)

  let nextCalls = 0
  const ordinary = await listener(
    { name: 'wx_send', arguments: {} },
    { isError: true, error: new Error('普通错误'), content: [{ type: 'text', text: 'Error: 普通错误' }] },
    () => {
      nextCalls++
      return Promise.resolve({ kind: 'accept' })
    },
  )
  assert.equal(nextCalls, 1)
  assert.deepEqual(ordinary, { kind: 'accept' })

  off()
  assert.equal(listeners.length, 0)
})

test('适配器只接管微信错误，监听器异常也放行', async () => {
  const listeners = []
  registerWxToolErrorAdapter({
    on(_event, listener) {
      listeners.push(listener)
      return () => {}
    },
  })
  const listener = listeners[0]
  const next = () => Promise.resolve({ kind: 'accept' })
  const encoded = { isError: true, error: { message: 'WXTOOL|WX_NOT_ALLOWED|[这个会话现在说不了]' } }

  assert.deepEqual(await listener({ name: 'qq_send' }, encoded, next), { kind: 'accept' })
  assert.deepEqual(await listener({ name: 'wx_peek' }, { isError: false, value: encoded.error }, next), { kind: 'accept' })
  assert.deepEqual(await listener({ name: 'wx_peek' }, { isError: true, error: { message: '普通错误' } }, next), { kind: 'accept' })

  let calls = 0
  const poisoned = { isError: true }
  Object.defineProperty(poisoned, 'error', { get() { throw new Error('读取失败') } })
  const decision = await listener({ name: 'wx_send' }, poisoned, () => {
    calls++
    return Promise.resolve({ kind: 'accept' })
  })
  assert.equal(calls, 1)
  assert.deepEqual(decision, { kind: 'accept' })
})
