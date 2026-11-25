import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHostCuaTools } from '../lib/host-cua-tools.js'

function setup(hostCua, config = {}) {
  const defs = new Map()
  registerHostCuaTools(
    { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } },
    {
      hostCua, root: '/tmp/x', config,
      guard: {
        looksLikeSecret: (s) => /sk-|Bearer/.test(s),
        sanitizeForeign: (s) => ({ text: String(s).replace(/token=\w+/g, 'token=***') }),
      },
    },
  )
  return defs
}

function windows(app = 'notepad.exe', id = '9', pid = 8) {
  return { structuredContent: { windows: [{ pid, window_id: id, app_name: app, title: 't' }] } }
}

test('四个工具都注册', () => {
  const defs = setup({})
  assert.deepEqual([...defs.keys()].sort(), ['host_click', 'host_key', 'host_look', 'host_type'])
})

test('click 永远传 background，captureId 原样转发', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n, a) => {
      calls.push([n, a])
      if (n === 'list_windows') return windows()
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  }, { hostCua: { defaultDetail: 'full', defaultInput: 'allow' } })
  await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2, captureId: 's1' }, {})
  const click = calls.find(([n]) => n === 'click')
  assert.equal(click[1].delivery_mode, 'background')
  assert.equal(click[1].capture_id, 's1')
})

test('type 拒绝像秘密的文本，不转发', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n, a) => {
      calls.push([n, a])
      if (n === 'list_windows') return windows()
      return {}
    },
  }, { hostCua: { defaultDetail: 'full', defaultInput: 'allow' } })
  const r = await defs.get('host_type').execute({ windowId: '9', text: 'Bearer abc' }, {})
  assert.equal(r.ok, false)
  assert.ok(!calls.some(([n]) => n === 'type_text'))
})

test('key 拒绝 win / alt+f4', async () => {
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n) => {
      if (n === 'list_windows') return windows()
      return {}
    },
  }, { hostCua: { defaultDetail: 'full', defaultInput: 'allow' } })
  assert.equal((await defs.get('host_key').execute({ windowId: '9', key: 'l', modifiers: ['win'] }, {})).ok, false)
  assert.equal((await defs.get('host_key').execute({ windowId: '9', key: 'f4', modifiers: ['alt'] }, {})).ok, false)
})

test('input deny 的应用可以看、不能输入', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n) => {
      calls.push(n)
      if (n === 'list_windows') return windows('chrome.exe')
      return { content: [{ type: 'text', text: 'ok' }], structuredContent: { snapshot_id: 's1' } }
    },
  }, { hostCua: { apps: ['chrome.exe'], deny: [], detail: { 'chrome.exe': 'full' }, defaultDetail: 'structure', input: { 'chrome.exe': 'deny' }, defaultInput: 'deny' } })
  const look = await defs.get('host_look').execute({ windowId: '9' }, {})
  assert.equal(look.ok, true)
  const click = await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2 }, {})
  assert.equal(click.ok, false)
  assert.equal(click.code, 'INPUT_DENIED')
  assert.ok(!calls.includes('click'))
})

test('background_unavailable 映射成人话且不重试', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n) => {
      calls.push(n)
      if (n === 'list_windows') return windows()
      return { content: [{ type: 'text', text: 'background_unavailable' }], structuredContent: { errorCode: 'background_unavailable' } }
    },
  }, { hostCua: { defaultDetail: 'full', defaultInput: 'allow' } })
  const r = await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2, captureId: 's1' }, {})
  assert.equal(r.ok, false)
  assert.match(r.message, /前台/)
  assert.equal(calls.filter((n) => n === 'click').length, 1)
})

test('structure：不带截图、正文脱敏、token 保留', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n, a) => {
      calls.push([n, a])
      if (n === 'list_windows') return windows('Code.exe')
      return {
        content: [{ type: 'image', data: 'xx' }],
        structuredContent: {
          snapshot_id: 's1',
          elements: [
            { role: 'button', label: '保存', value: '', frame: { x: 1 }, element_token: 's1:2' },
            { role: 'text', label: '秘密正文', value: '', frame: { x: 2 }, element_token: 's1:3' },
          ],
        },
      }
    },
  }, { hostCua: { apps: ['Code.exe'], deny: [], detail: { 'Code.exe': 'structure' } } })
  const r = await defs.get('host_look').execute({ windowId: '9' }, {})
  assert.equal(r.ok, true)
  assert.equal(r.detail, 'structure')
  assert.equal(r.path, undefined)
  assert.match(r.tree, /保存/)
  assert.doesNotMatch(r.tree, /秘密正文/)
  assert.match(r.tree, /s1:3/)
  assert.equal(r.window.title, '[标题已隐藏]')
  const lookCall = calls.find(([n]) => n === 'get_window_state')
  assert.equal(lookCall[1].include_screenshot, false)
  assert.equal(lookCall[1].tree_format, 'elements')
})

test('none：不调 get_window_state，输入工具直接拒绝', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n) => {
      calls.push(n)
      return windows('Weixin.exe')
    },
  }, { hostCua: { apps: ['Weixin.exe'], deny: [], detail: { 'Weixin.exe': 'none' } } })
  const look = await defs.get('host_look').execute({ windowId: '9' }, {})
  assert.equal(look.ok, true)
  assert.equal(look.detail, 'none')
  assert.equal(look.path, undefined)
  assert.equal(look.tree, undefined)
  assert.ok(calls.includes('list_windows'))
  assert.ok(!calls.includes('get_window_state'))
  const click = await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2 }, {})
  assert.equal(click.ok, false)
  assert.equal(click.code, 'DETAIL_NONE')
  assert.ok(!calls.some((n) => ['click', 'type_text', 'press_key'].includes(n)))
})

test('坐标点击没有 captureId 时拒绝，不盲点', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n) => {
      calls.push(n)
      if (n === 'list_windows') return windows()
      return {}
    },
  }, { hostCua: { defaultDetail: 'full', defaultInput: 'allow' } })
  const r = await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2 }, {})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'CAPTURE_REQUIRED')
  assert.ok(!calls.includes('click'))
})
