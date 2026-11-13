/**
 * her-tools.test.mjs —— Task 7：`her_tools` 目录 / 说明 / 按需打开
 *
 * 测试直接拿宿主拿到的 def（registerTool 包装过的那一个），
 * 用 `render(def, out, args)` 读模型真正看到的投影（宿主签名是 (arguments, value)）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHerTools } from '../lib/tools.js'
import {
  catalog,
  describeEntry,
  entriesFor,
  groupsFor,
  loadTargets,
  resolveAllow,
} from '../lib/tool-policy.js'

function fakeHost() {
  const defs = new Map()
  return {
    defs,
    ctx: { tools: { register(def) { defs.set(def.name, def); return () => {} } } },
  }
}

const policy = {
  catalog: ({ surface }) => surface === 'wx' ? [
    { name: 'wx_see', surface: 'wx', tier: 'deferred', group: 'wx.ui', summary: '看屏幕' },
    { name: 'wx_click', surface: 'wx', tier: 'deferred', group: 'wx.ui', summary: '点一下' },
  ] : [],
  loadTargets: ({ names, group }) => {
    if (group === 'wx.ui' || (names?.length === 1 && names[0] === 'wx_see')) return { ok: true, names: group ? ['wx_see', 'wx_click'] : ['wx_see'], group, why: '' }
    return { ok: false, names: [], group, why: '这条路上打不开' }
  },
}

// 宿主 render 的签名是 (exec.arguments, value)：投影按 action 分支，args 必须原样传。
function render(def, out, args = {}) {
  return def.output.render(args, out)[0].text
}

function register({ core, policy: p = policy, caps } = {}) {
  const h = fakeHost()
  const dispose = registerHerTools(h.ctx, { core, policy: p, caps })
  return { h, def: h.defs.get('her_tools'), dispose }
}

/** 真实的策略表入口：M1 要验证 hostNames / caps 贯穿 catalog、describe、load。 */
const realPolicy = { resolveAllow, catalog, loadTargets, groupsFor, entriesFor, describeEntry }
const realCaps = { hasGui: true, hasOcr: true, hasImageRoute: true }

function wxCore(state) {
  return {
    surface: { current: () => 'wx' },
    tools: { reveal: () => ({ ok: true, added: [] }), state: () => state },
  }
}

test('search 只列当前面 deferred，最多 5 条，不改 revealed', async () => {
  const h = fakeHost()
  let revealed = 0
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: () => { revealed += 1 } } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'search', query: '屏幕' }, { agent: {} })
  assert.match(render(def, out, { action: 'search', query: '屏幕' }), /wx_see/)
  assert.equal(revealed, 0)
})

test('search 过滤掉已经开着的名字', async () => {
  const { def } = register({
    core: {
      surface: { current: () => 'wx' },
      tools: { reveal() {}, state: () => ({ surface: 'wx', allow: ['wx_see'], revealed: ['wx_see'] }) },
    },
  })
  const out = await def.execute({ action: 'search' }, { agent: {} })
  assert.deepEqual(out.data.items.map((i) => i.name), ['wx_click'])
  assert.equal(render(def, out, { action: 'search' }).includes('wx_see'), false)
})

test('search 只列宿主名单里真的注册过的策略表工具', async () => {
  const hostNames = new Set(['growth_commit', 'her_tools', 'read_image', 'wx_peek', 'wx_see'])
  const { def } = register({
    core: wxCore({ surface: 'wx', allow: [], hostNames }),
    policy: realPolicy,
    caps: realCaps,
  })
  const out = await def.execute({ action: 'search' }, { agent: {} })
  assert.deepEqual(out.data.items.map((i) => i.name), ['wx_see'])
})

test('search 不列能力不满足的工具', async () => {
  const hostNames = new Set(['wx_ocr', 'wx_see'])
  const { def } = register({
    core: wxCore({ surface: 'wx', allow: [], hostNames }),
    policy: realPolicy,
    caps: { hasGui: true }, // 没有 hasOcr
  })
  const out = await def.execute({ action: 'search' }, { agent: {} })
  assert.deepEqual(out.data.items.map((i) => i.name), ['wx_see'])
})

test('describe 对宿主没注册的策略名字闭口不谈', async () => {
  const hostNames = new Set(['wx_peek'])
  const touched = []
  const agent = { ctx: { tools: { get: (n) => { touched.push(n); return { description: '看屏幕' } } } } }
  const { def } = register({
    core: wxCore({ surface: 'wx', allow: [], hostNames }),
    policy: realPolicy,
    caps: realCaps,
  })
  const out = await def.execute({ action: 'describe', names: ['wx_see'] }, { agent })
  assert.deepEqual(out.data.items, [])
  assert.deepEqual(touched, [], '宿主没注册的名字不该去读实时工具表')
  assert.match(render(def, out, { action: 'describe', names: ['wx_see'] }), /这里没有/)
})

test('describe 对能力不满足的工具明说用不了', async () => {
  const hostNames = new Set(['wx_ocr'])
  const { def } = register({
    core: wxCore({ surface: 'wx', allow: [], hostNames }),
    policy: realPolicy,
    caps: { hasGui: true }, // 没有 hasOcr
  })
  const out = await def.execute({ action: 'describe', names: ['wx_ocr'] }, { agent: {} })
  assert.equal(out.ok, true)
  assert.equal(out.data.items[0].name, 'wx_ocr')
  assert.match(render(def, out, { action: 'describe', names: ['wx_ocr'] }), /wx_ocr/)
  assert.match(render(def, out, { action: 'describe', names: ['wx_ocr'] }), /用不了/)
})

test('load 宿主没注册的名字打不开', async () => {
  const hostNames = new Set(['wx_peek'])
  const { def } = register({
    core: wxCore({ surface: 'wx', allow: [], hostNames }),
    policy: realPolicy,
    caps: realCaps,
  })
  const out = await def.execute({ action: 'load', names: ['wx_see'] }, { agent: {} })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'LOAD_FAILED')
  assert.match(render(def, out, { action: 'load', names: ['wx_see'] }), /没打开/)
})

test('search 最多 5 条', async () => {
  const many = {
    catalog: () => Array.from({ length: 8 }, (_, i) => ({
      name: `wx_${i}`, surface: 'wx', tier: 'deferred', group: 'wx.ui', summary: `第 ${i} 个`,
    })),
    loadTargets: () => ({ ok: true, names: [], group: '', why: '' }),
  }
  const { def } = register({
    core: { surface: { current: () => 'wx' }, tools: { reveal() {} } },
    policy: many,
  })
  const out = await def.execute({ action: 'search' }, { agent: {} })
  assert.equal(out.data.items.length, 5)
})

test('describe 只返回最多 2 条，给说明不给 JSON schema', async () => {
  const h = fakeHost()
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: () => {} } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'describe', names: ['wx_see', 'wx_click'] }, { agent: {} })
  const text = render(def, out, { action: 'describe', names: ['wx_see', 'wx_click'] })
  assert.match(text, /wx_see/)
  assert.equal(text.includes('{'), false)
})

test('describe 最多处理 2 个名字', async () => {
  const p = {
    catalog: () => ['wx_a', 'wx_b', 'wx_c'].map((name) => ({
      name, surface: 'wx', tier: 'deferred', group: 'wx.ui', summary: `${name} 的说明`,
    })),
    loadTargets: () => ({ ok: true, names: [], group: '', why: '' }),
  }
  const { def } = register({
    core: { surface: { current: () => 'wx' }, tools: { reveal() {} } },
    policy: p,
  })
  const out = await def.execute({ action: 'describe', names: ['wx_a', 'wx_b', 'wx_c'] }, { agent: {} })
  assert.deepEqual(out.data.items.map((i) => i.name), ['wx_a', 'wx_b'])
})

test('describe 读实时工具表：说明和参数名，但不输出 schema', async () => {
  const agent = {
    ctx: {
      tools: {
        get: (name) => name === 'wx_see'
          ? { description: '看屏幕上的字。第二句不该出现。', parameters: { type: 'object', properties: { region: { type: 'string' } } } }
          : null,
      },
    },
  }
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  const out = await def.execute({ action: 'describe', names: ['wx_see'] }, { agent })
  assert.match(out.data.items[0].summary, /看屏幕上的字/)
  assert.deepEqual(out.data.items[0].params, ['region'])
  assert.equal(render(def, out, { action: 'describe', names: ['wx_see'] }).includes('{'), false)
})

test('describe 的说明里即使有花括号，投影里也不出现 {', async () => {
  const agent = {
    ctx: { tools: { get: () => ({ description: '用法：{x} 这样写。', parameters: { type: 'object', properties: {} } }) } },
  }
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  const out = await def.execute({ action: 'describe', names: ['wx_see'] }, { agent })
  assert.equal(render(def, out, { action: 'describe', names: ['wx_see'] }).includes('{'), false)
})

test('describe 不认识的宿主工具：跳过、不回显、也不读实时工具表', async () => {
  const touched = []
  const agent = {
    ctx: {
      tools: {
        get: (name) => {
          touched.push(name)
          return {
            description: '运行 shell 命令',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
          }
        },
      },
    },
  }
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  const out = await def.execute({ action: 'describe', names: ['bash'] }, { agent })
  assert.equal(out.ok, true)
  assert.deepEqual(out.data.items, [])
  const text = render(def, out, { action: 'describe', names: ['bash'] })
  assert.equal(text.includes('bash'), false)
  assert.equal(text.includes('shell'), false)
  assert.equal(text.includes('command'), false)
  assert.deepEqual(touched, [])
  assert.match(text, /这里没有/)
})

test('describe 混合列表：只讲当前面策略表里的名字', async () => {
  const touched = []
  const agent = {
    ctx: {
      tools: {
        get: (name) => {
          touched.push(name)
          if (name === 'wx_see') {
            return { description: '看屏幕。', parameters: { type: 'object', properties: { region: { type: 'string' } } } }
          }
          return {
            description: '运行 shell 命令',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
          }
        },
      },
    },
  }
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  const out = await def.execute({ action: 'describe', names: ['wx_see', 'bash'] }, { agent })
  const text = render(def, out, { action: 'describe', names: ['wx_see', 'bash'] })
  assert.match(text, /wx_see/)
  assert.equal(text.includes('bash'), false)
  assert.equal(text.includes('shell'), false)
  assert.deepEqual(out.data.items.map((i) => i.name), ['wx_see'])
  assert.deepEqual(touched, ['wx_see'])
})

test('describe 不把 schema 根键当参数名', async () => {
  const agent = {
    ctx: {
      tools: {
        get: () => ({
          description: '没有属性。',
          parameters: { required: ['x'], additionalProperties: false },
        }),
      },
    },
  }
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  const out = await def.execute({ action: 'describe', names: ['wx_see'] }, { agent })
  assert.deepEqual(out.data.items[0].params, [])
})

test('describe 的实时工具表抛错时退回策略摘要，不抛', async () => {
  const agent = {
    ctx: {
      tools: {
        get() { throw new Error('boom') },
        view() { throw new Error('boom') },
      },
    },
  }
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  const out = await def.execute({ action: 'describe', names: ['wx_see'] }, { agent })
  assert.equal(out.ok, true)
  assert.match(out.data.items[0].summary, /看屏幕/)
})

test('load 组成功返回已打开，并调用 reveal', async () => {
  const h = fakeHost()
  let got = null
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: (_a, names) => { got = names; return { ok: true } } } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'load', group: 'wx.ui' }, { agent: {} })
  assert.deepEqual(got.sort(), ['wx_click', 'wx_see'])
  assert.match(render(def, out, { action: 'load', group: 'wx.ui' }), /已打开/)
})

test('load 只传一个选择器：按名字时不带 group，按组时不带 names', async () => {
  const seen = []
  const p = {
    catalog: () => [],
    loadTargets: (opts) => {
      seen.push(opts)
      return opts.group
        ? { ok: true, names: ['wx_see', 'wx_click'], group: opts.group, why: '' }
        : { ok: true, names: opts.names, group: '', why: '' }
    },
  }
  const { def } = register({
    core: { surface: { current: () => 'wx' }, tools: { reveal: () => ({ ok: true }) } },
    policy: p,
  })
  await def.execute({ action: 'load', group: 'wx.ui' }, { agent: {} })
  await def.execute({ action: 'load', names: ['wx_see'] }, { agent: {} })
  assert.equal(seen[0].group, 'wx.ui')
  assert.equal(seen[0].names, undefined)
  assert.deepEqual(seen[1].names, ['wx_see'])
  assert.equal(seen[1].group, undefined)
})

test('load 已经开着的名字：直接回 already，不调 loadTargets / reveal', async () => {
  let loadCalls = 0
  let revealCalls = 0
  const p = {
    catalog: () => [],
    loadTargets: () => { loadCalls += 1; return { ok: true, names: ['wx_see'], group: '', why: '' } },
  }
  const { def } = register({
    core: {
      surface: { current: () => 'wx' },
      tools: {
        reveal() { revealCalls += 1; return { ok: true } },
        state: () => ({ surface: 'wx', allow: ['wx_see'], revealed: ['wx_see'] }),
      },
    },
    policy: p,
  })
  const out = await def.execute({ action: 'load', names: ['wx_see'] }, { agent: {} })
  assert.equal(out.ok, true)
  assert.equal(out.data.already, true)
  assert.deepEqual(out.data.opened, ['wx_see'])
  assert.equal(loadCalls, 0)
  assert.equal(revealCalls, 0)
  assert.match(render(def, out, { action: 'load', names: ['wx_see'] }), /\[已经开着\]/)
})

test('load 混合列表：已开的只回显，未开的真的打开', async () => {
  let revealedNames = null
  const p = {
    catalog: () => [],
    loadTargets: ({ names }) => (names?.length
      ? { ok: true, names, group: '', why: '' }
      : { ok: false, names: [], group: '', why: '这条路上打不开' }),
  }
  const { def } = register({
    core: {
      surface: { current: () => 'wx' },
      tools: {
        reveal(_agent, names) {
          revealedNames = names
          return { ok: true, added: names, allow: ['wx_see', 'wx_click'] }
        },
        state: () => ({ surface: 'wx', allow: ['wx_see'], revealed: ['wx_see'] }),
      },
    },
    policy: p,
  })
  const out = await def.execute({ action: 'load', names: ['wx_see', 'wx_click'] }, { agent: {} })
  assert.equal(out.ok, true)
  assert.deepEqual(revealedNames, ['wx_click'])
  assert.deepEqual(out.data.opened, ['wx_click'], '这次真正打开的名字')
  assert.deepEqual(out.data.alreadyOpen, ['wx_see'], '早就开着的名字单独列出')
  assert.equal(out.data.already, undefined, '混合请求不是「已经开着」')
  const text = render(def, out, { action: 'load', names: ['wx_see', 'wx_click'] })
  assert.match(text, /\[已打开\]/, '要说这次真的打开了东西')
  assert.match(text, /wx_click/)
  assert.match(text, /wx_see.*早就开着|早就开着.*wx_see/)
  assert.equal(text.includes('[已经开着]'), false)
})

test('load 别的面/宿主工具失败，不假装成功', async () => {
  const h = fakeHost()
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: () => { throw new Error('should not') } } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'load', names: ['bili_look'] }, { agent: {} })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'LOAD_FAILED')
  assert.match(render(def, out, { action: 'load', names: ['bili_look'] }), /没打开/)
})

test('load 的 reveal 失败时不假装成功', async () => {
  const { def } = register({
    core: {
      surface: { current: () => 'wx' },
      tools: { reveal: () => ({ ok: false, why: '这会儿不行', added: [], allow: [] }) },
    },
  })
  const out = await def.execute({ action: 'load', group: 'wx.ui' }, { agent: {} })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'LOAD_FAILED')
  assert.equal(out.message, '这会儿不行')
  assert.match(render(def, out, { action: 'load', group: 'wx.ui' }), /没打开：这会儿不行/)
})

test('判不面时返回 NO_SURFACE 失败信封', async () => {
  const { def } = register({
    core: { surface: { current: () => null }, tools: { reveal() {} } },
  })
  const out = await def.execute({ action: 'search' }, { agent: {} })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NO_SURFACE')
  assert.match(render(def, out, { action: 'search' }), /打不开工具目录/)
})

test('注册返回宿主给的注销函数', () => {
  const off = () => {}
  const defs = new Map()
  const ctx = { tools: { register(def) { defs.set(def.name, def); return off } } }
  assert.equal(registerHerTools(ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal() {} } }, policy }), off)
})

test('参数 schema：action 必填且限定三种动作', () => {
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  assert.deepEqual(def.parameters.properties.action.enum, ['search', 'describe', 'load'])
  assert.deepEqual(def.parameters.required, ['action'])
})

test('投影文案不出现「他」', async () => {
  const { def } = register({ core: { surface: { current: () => 'wx' }, tools: { reveal() {} } } })
  const outputs = [
    await def.execute({ action: 'search' }, { agent: {} }),
    await def.execute({ action: 'describe', names: ['wx_see'] }, { agent: {} }),
    await def.execute({ action: 'load', names: ['bili_look'] }, { agent: {} }),
  ]
  for (const out of outputs) assert.equal(render(def, out, { action: 'search' }).includes('他'), false)
})
