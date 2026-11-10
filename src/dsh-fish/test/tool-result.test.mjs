import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  wrapTool,
  wrapRenderOnly,
  registerTool,
  renderProjection,
  ToolError,
  PROJECTION,
  CALL_META,
  projectError,
  universalOutputSchema,
} from '../lib/tool-result.js'

function fakeCtx() {
  const regs = []
  return { regs, tools: { register(def) { regs.push(def); return () => {} } } }
}

test('project 只算一次，render 只读预计算结果', () => {
  let calls = 0
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, render: () => { throw new Error('should not use legacy render') } },
    execute: async () => ({ ok: true, id: 'ev_1' }),
    project: (result, args, view) => { calls += 1; return { text: `[好] ${view.surface}` } },
  }
  const wrapped = wrapTool(def, { core: { surface: { current: () => 'wx' } } })
  return wrapped.execute({}, { agent: { id: 's1' } }).then((result) => {
    assert.equal(calls, 1)
    assert.equal(result[PROJECTION].text, '[好] wx')
    const blocks = wrapped.output.render({}, result)
    assert.equal(calls, 1)
    assert.equal(blocks[0].text, '[好] wx')
  })
})

test('handles 渲染成末尾一行编号，正文不重复', () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    execute: async () => ({ ok: true }),
    project: () => ({ text: '[翻到] 一条', handles: [{ label: '1', value: 'ev_1' }] }),
  }
  const wrapped = wrapTool(def)
  return wrapped.execute({}, {}).then((r) => {
    const blocks = wrapped.output.render({}, r)
    assert.equal(blocks[0].text, '[翻到] 一条\n（编号：1=ev_1）')
  })
})

test('project 抛错时 render 兜底，不把 Error 带进上下文', async () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    execute: async () => ({ ok: true }),
    project: () => { throw new Error('boom') },
  }
  const wrapped = wrapTool(def)
  const r = await wrapped.execute({}, {})
  assert.equal(wrapped.output.render({}, r)[0].text, '[结果没能显示出来]')
})

test('预期失败走信封，投影仍可读', async () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' } }, required: ['ok'] } },
    execute: async () => ({ ok: false, code: 'NO', message: '这个会话不在名单里' }),
    project: (r) => ({ text: r.ok ? '[好]' : `[没做成：${r.message}]` }),
  }
  const wrapped = wrapTool(def)
  const r = await wrapped.execute({}, {})
  assert.equal(wrapped.output.render({}, r)[0].text, '[没做成：这个会话不在名单里]')
})

test('没有 outputSchema 时用通用信封 schema', () => {
  const wrapped = wrapTool({ name: 't', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }), project: () => ({ text: 'x' }) })
  assert.equal(wrapped.output.schema.type, 'object')
})

test('ToolError 保留 code 与人话', () => {
  const e = new ToolError('WX_NOT_ALLOWED', '这个会话不在能说话的名单里')
  assert.equal(e.code, 'WX_NOT_ALLOWED')
  assert.equal(e.message, '这个会话不在能说话的名单里')
})

test('wrapRenderOnly 不改返回值，只在 render 时投影', async () => {
  const raw = '原始字符串'
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => raw,
    project: (v) => ({ text: `[投影]${v}` }),
  }
  const wrapped = wrapRenderOnly(def)
  assert.equal(await wrapped.execute({}, {}), raw)
  assert.equal(wrapped.output.render({}, raw)[0].text, '[投影]原始字符串')
})

test('通用信封 schema 不带 required，且允许额外字段', () => {
  const schema = universalOutputSchema()
  assert.equal(schema.type, 'object')
  assert.equal(schema.required, undefined)
  assert.equal(schema.additionalProperties, true)
  assert.equal(schema.properties.ok.type, 'boolean')
})

test('wrapTool 不修改入参，返回新对象', () => {
  const legacyRender = () => [{ type: 'text', text: 'legacy' }]
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} }, render: legacyRender },
    execute: async () => ({ ok: true }),
    project: () => ({ text: 'p' }),
  }
  const wrapped = wrapTool(def)
  assert.notEqual(wrapped, def)
  assert.equal(def.output.render, legacyRender)
  assert.equal(def.output.schema.type, 'object')
  assert.equal(wrapped.output.schema, def.output.schema)
  assert.notEqual(wrapped.output.render, legacyRender)
})

test('execute 抛普通错误时包成 ToolError，不带原始 message', async () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} } },
    execute: async () => { throw new Error('cookie=secret-value') },
    project: () => ({ text: 'x' }),
  }
  const wrapped = wrapTool(def)
  await assert.rejects(wrapped.execute({}, {}), (err) => {
    assert.ok(err instanceof ToolError)
    assert.equal(err.code, 'TOOL_FAILED')
    assert.equal(err.message, '没做成，再试一次')
    assert.ok(!err.message.includes('secret-value'))
    return true
  })
})

test('execute 抛 ToolError 时原样透传', async () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: {} } },
    execute: async () => { throw new ToolError('WX_UNCONFIRMED', '没看到回执，可能没发出去') },
    project: () => ({ text: 'x' }),
  }
  const wrapped = wrapTool(def)
  await assert.rejects(wrapped.execute({}, {}), (err) => {
    assert.ok(err instanceof ToolError)
    assert.equal(err.code, 'WX_UNCONFIRMED')
    assert.equal(err.message, '没看到回执，可能没发出去')
    return true
  })
})

test('返回 null / 冻结对象时 execute 不抛，render 现算投影', async () => {
  const nullWrapped = wrapTool({
    name: 'n', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => null,
    project: (r) => ({ text: `[空]${r}` }),
  })
  assert.equal(await nullWrapped.execute({}, {}), null)
  assert.equal(nullWrapped.output.render({}, null)[0].text, '[空]null')

  const frozen = Object.freeze({ ok: true })
  const frozenWrapped = wrapTool({
    name: 'f', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => frozen,
    project: () => ({ text: '冻结投影' }),
  })
  assert.equal(await frozenWrapped.execute({}, {}), frozen)
  assert.equal(frozen == null, false)
  assert.equal(frozen[PROJECTION], undefined)
  assert.equal(frozenWrapped.output.render({}, frozen)[0].text, '冻结投影')

  const primitiveWrapped = wrapTool({
    name: 'p', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => 42,
    project: (r) => ({ text: `[数字]${r}` }),
  })
  assert.equal(await primitiveWrapped.execute({}, {}), 42)
  assert.equal(primitiveWrapped.output.render({}, 42)[0].text, '[数字]42')
})

test('renderProjection 收到空投影也有兜底文本，不返回空数组', () => {
  for (const empty of [undefined, null, {}]) {
    const blocks = renderProjection(empty)
    assert.ok(Array.isArray(blocks))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, '[结果没能显示出来]')
  }
})

test('renderProjection 保留 blocks 并拼接正文', () => {
  const blocks = renderProjection({
    blocks: [{ type: 'image', source: { type: 'base64', data: 'x' } }],
    text: '看图',
  })
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'image')
  assert.equal(blocks[1].text, '看图')
})

test('project 缺失时退回 String(result)', async () => {
  const wrapped = wrapTool({
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  })
  const r = await wrapped.execute({}, {})
  assert.equal(wrapped.output.render({}, r)[0].text, '[object Object]')
})

test('CALL_META 记录开始时间且不可枚举', async () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
    project: () => ({ text: 'x' }),
  }
  const wrapped = wrapTool(def)
  const before = Date.now()
  const r = await wrapped.execute({}, {})
  assert.ok(r[CALL_META].startedAt >= before)
  assert.ok(r[CALL_META].startedAt <= Date.now())
  assert.equal(Object.keys(r).includes(String(CALL_META)), false)
  assert.equal(Object.keys(r).includes('fish.projection'), false)
})

test('projectError 只映射已知码，未知码不外泄 err.message', () => {
  assert.equal(projectError(Object.assign(new Error('secret'), { code: 'WX_NOT_ALLOWED' })), '这个会话不在能说话的名单里')
  assert.equal(projectError(Object.assign(new Error('secret'), { code: 'WX_UNCONFIRMED' })), '没看到回执，可能没发出去')
  assert.equal(projectError(Object.assign(new Error('secret'), { code: 'BILI_COOLDOWN' })), '今天说得够多了')
  assert.equal(projectError(Object.assign(new Error('secret'), { code: 'REMIND_EXPIRED' })), '这条提醒已经过期了')
  assert.equal(projectError(new Error('secret')), '没做成，再试一次')
  assert.equal(projectError(undefined), '没做成，再试一次')
})

test('registerTool 用包装后的定义注册并返回注销函数', async () => {
  const ctx = fakeCtx()
  const off = registerTool(ctx, {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
    project: () => ({ text: '已包装' }),
  })
  assert.equal(ctx.regs.length, 1)
  assert.equal(typeof off, 'function')
  const r = await ctx.regs[0].execute({}, {})
  assert.equal(ctx.regs[0].output.render({}, r)[0].text, '已包装')
})

test('wrapRenderOnly 不改 output.schema', () => {
  const schema = { type: 'object', properties: {} }
  const wrapped = wrapRenderOnly({
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema },
    execute: async () => 'x',
    project: () => ({ text: 'p' }),
  })
  assert.equal(wrapped.output.schema, schema)
})
