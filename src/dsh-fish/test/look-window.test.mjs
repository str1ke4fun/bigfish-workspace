import test from 'node:test'
import assert from 'node:assert/strict'
import { registerLookWindow } from '../lib/look-window.js'

function fakeCtx() {
  const defs = new Map()
  return { defs, ctx: { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } } }
}

test('没授权时拒绝，并给人话', async () => {
  const { ctx, defs } = fakeCtx()
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: false, code: 'HOST_CUA_OFF' }) },
    printWindow: {}, root: '/tmp/x', config: {},
  })
  const r = await defs.get('look_window').execute({}, {})
  assert.equal(r.ok, false)
  assert.match(defs.get('look_window').project(r).text, /托管|看窗口/)
})

test('无 windowId 时列白名单窗口，structure 标题隐藏', async () => {
  const { ctx, defs } = fakeCtx()
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: true }) },
    printWindow: {
      list: async () => ({ ok: true, windows: [
        { id: '1', pid: 2, app: 'Code.exe', title: 'a', minimized: false },
        { id: '3', pid: 4, app: 'explorer.exe', title: 'b', minimized: false },
      ] }),
      capture: async () => ({ ok: false }),
    },
    root: '/tmp/x', config: {},
  })
  const r = await defs.get('look_window').execute({}, {})
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].app, 'Code.exe')
  assert.equal(r.windows[0].title, '[标题已隐藏]')
})

test('按 windowId 抓帧会落盘并返回路径', async () => {
  const { ctx, defs } = fakeCtx()
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: true }) },
    printWindow: {
      list: async () => ({ ok: true, windows: [{ id: '9', pid: 8, app: 'notepad.exe', title: 't', minimized: false }] }),
      capture: async () => ({ ok: true, app: 'notepad.exe', title: 't', width: 10, height: 10, buf: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    },
    root: '/tmp/x',
    config: { hostCua: { apps: ['notepad.exe'], deny: [], detail: { 'notepad.exe': 'full' } } },
    saveImage: async () => ({ ok: true, path: '/tmp/x/media/a.png' }),
  })
  const r = await defs.get('look_window').execute({ windowId: '9' }, {})
  assert.equal(r.ok, true)
  assert.equal(r.path, '/tmp/x/media/a.png')
  assert.equal(r.detail, 'full')
})

test('structure / none 的应用在 look_window 里不抓图', async () => {
  const { ctx, defs } = fakeCtx()
  let captured = false
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: true }) },
    printWindow: {
      list: async () => ({ ok: true, windows: [{ id: '9', pid: 8, app: 'Weixin.exe', title: 't', minimized: false }] }),
      capture: async () => { captured = true; return { ok: true } },
    },
    root: '/tmp/x',
    config: { hostCua: { apps: ['Weixin.exe'], deny: [], detail: { 'Weixin.exe': 'structure' } } },
  })
  const r = await defs.get('look_window').execute({ windowId: '9' }, {})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DETAIL_NO_IMAGE')
  assert.equal(captured, false)
})
