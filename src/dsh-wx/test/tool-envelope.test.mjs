import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ToolError } from '../../dsh-fish/lib/tool-result.js'
import { WxToolError, wrapWxTool, wxFailure, wxFailureFrom, wxWithText } from '../lib/tool-error.js'

const base = (execute) => ({
  name: 'wx_test',
  description: '测试工具',
  parameters: { type: 'object', properties: {} },
  output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'legacy' }] },
  execute,
})

test('微信信封包装把预期 WxToolError 转成带 code 的 ok:false', async () => {
  const wrapped = wrapWxTool(base(async () => {
    throw new WxToolError('WX_NOT_ALLOWED', '[这个会话现在说不了]', '名单没放行')
  }))

  const result = await wrapped.execute({}, {})
  assert.deepEqual(result, {
    ok: false,
    code: 'WX_NOT_ALLOWED',
    message: '[这个会话现在说不了]',
    detail: '名单没放行',
  })
  assert.equal(wrapped.output.schema.type, 'object')
  assert.equal(wrapped.output.schema.required.includes('ok'), true)
  assert.equal(wrapped.output.render({}, result)[0].text, '[这个会话现在说不了]')
  assert.equal(result.isError, undefined)
})

test('微信信封包装保留成功完整结果，只把 text 投影给模型', async () => {
  const wrapped = wrapWxTool({
    ...base(async () => ({ ok: true, text: '[看到] 两句话', raw: { secret: 'audit-only' } })),
    project: (result) => ({ text: result.text }),
  })

  const result = await wrapped.execute({}, {})
  assert.deepEqual(result, { ok: true, text: '[看到] 两句话', raw: { secret: 'audit-only' } })
  assert.equal(wrapped.output.render({}, result)[0].text, '[看到] 两句话')
  assert.equal(wrapped.output.render({}, result)[0].text.includes('audit-only'), false)
})

test('微信信封包装只转换预期错误，意外异常仍是错误', async () => {
  const wrapped = wrapWxTool(base(async () => { throw new TypeError('secret internal detail') }))
  await assert.rejects(
    () => wrapped.execute({}, {}),
    (error) => {
      assert.ok(error instanceof ToolError)
      assert.equal(error.code, 'TOOL_FAILED')
      assert.equal(error.message.includes('secret internal detail'), false)
      return true
    },
  )
})

test('微信信封包装开关关闭时回到旧字符串并重新抛出预期错误', async () => {
  const ok = wrapWxTool(base(async () => ({ ok: true, text: '旧结果', full: 'audit' })), { envelopes: false })
  assert.equal(await ok.execute({}, {}), '旧结果')
  assert.equal(ok.output.schema.type, 'string')

  const failed = wrapWxTool(base(async () => wxFailure('WX_DISABLED', '[微信现在没开]', 'policy.enabled=false')), { envelopes: false })
  await assert.rejects(
    () => failed.execute({}, {}),
    (error) => {
      assert.ok(error instanceof WxToolError)
      assert.equal(error.code, 'WX_DISABLED')
      assert.equal(error.modelText, '[微信现在没开]')
      assert.equal(error.rawDetail, 'policy.enabled=false')
      return true
    },
  )
})

test('微信失败信封保留工具自己的完整审计字段，模型投影仍只用 message', async () => {
  const wrapped = wrapWxTool({
    ...base(async () => ({
      ok: false,
      code: 'WX_STICKER_SCAN_FAILED',
      message: '[表情没扫成]',
      detail: 'panel still open',
      panelShot: '/tmp/panel.png',
      closed: false,
    })),
    project: (result) => ({ text: result.ok ? result.text : result.message }),
  })
  const result = await wrapped.execute({}, {})
  assert.deepEqual(result, {
    ok: false,
    code: 'WX_STICKER_SCAN_FAILED',
    message: '[表情没扫成]',
    detail: 'panel still open',
    panelShot: '/tmp/panel.png',
    closed: false,
  })
  assert.equal(wrapped.output.render({}, result)[0].text, '[表情没扫成]')
})

test('微信信封在边界上只交纯 JSON：undefined 字段不会让宿主整条打回', async () => {
  const wrapped = wrapWxTool(base(async () => ({
    ok: true,
    source: undefined,
    text: '看得见',
    nested: { keep: 1, drop: undefined },
    items: [1, undefined, 2],
  })))

  const result = await wrapped.execute({}, {})
  assert.deepEqual(result, { ok: true, text: '看得见', nested: { keep: 1 }, items: [1, null, 2] })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('微信失败信封同样只交纯 JSON', async () => {
  const wrapped = wrapWxTool(base(async () => ({
    ok: false,
    code: 'WX_STICKER_SCAN_FAILED',
    message: '[表情没扫成]',
    detail: '',
    panelShot: undefined,
  })))
  const result = await wrapped.execute({}, {})
  assert.deepEqual(result, { ok: false, code: 'WX_STICKER_SCAN_FAILED', message: '[表情没扫成]' })
})

test('wxFailureFrom 只接管 WxToolError，wxWithText 不碰失败结果', () => {
  assert.deepEqual(
    wxFailureFrom(new WxToolError('WX_TREE_STALE', '[没看清]', 'tree stale')),
    { ok: false, code: 'WX_TREE_STALE', message: '[没看清]', detail: 'tree stale' },
  )
  assert.equal(wxFailureFrom(new Error('boom')), null)

  let projected = 0
  const failed = wxWithText(wxFailure('WX_DISABLED', '[微信现在没开]'), () => {
    projected += 1
    return '不该出现'
  })
  assert.deepEqual(failed, { ok: false, code: 'WX_DISABLED', message: '[微信现在没开]' })
  assert.equal(projected, 0)
  assert.deepEqual(
    wxWithText({ ok: true, confirmed: true, chat: '测试群A' }, (result) => `[好了] ${result.chat}`),
    { ok: true, confirmed: true, chat: '测试群A', text: '[好了] 测试群A' },
  )
})
