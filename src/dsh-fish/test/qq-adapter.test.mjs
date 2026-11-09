import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  projectQqTool,
  registerQqAdapter,
  qqAdapterStatus,
  resetQqAdapterStatus,
} from '../lib/qq-adapter.js'

test('qq 发送工具去掉 message_id/chatId', () => {
  const blocks = projectQqTool('qq_send_image', 'sent=true message_id=123 chatId=group_1', [])
  assert.equal(blocks[0].text, '[发出去了]')
  assert.equal(blocks[0].text.includes('123'), false)
})

test('qq_group_history 保留正文，不只是条数', () => {
  const raw = JSON.stringify({ messages: [{ nickname: '阿明', text: '晚上来吗' }, { nickname: '小李', text: '来' }] })
  const blocks = projectQqTool('qq_group_history', raw, [])
  assert.match(blocks[0].text, /阿明：晚上来吗/)
  assert.match(blocks[0].text, /小李：来/)
})

test('qq_napcat_api 未知 action 不返回原始 JSON', () => {
  const blocks = projectQqTool('qq_napcat_api', JSON.stringify({ retcode: 0, data: { secret: 'x' } }), [])
  assert.equal(blocks[0].text.includes('retcode'), false)
  assert.equal(blocks[0].text.includes('secret'), false)
})

test('非 qq 工具返回 null，不接管', () => {
  assert.equal(projectQqTool('wx_peek', 'x', []), null)
})

test('adapter 监听器抛错不影响工具结果', async () => {
  const listeners = []
  const ctx = { on: (ev, fn) => { listeners.push([ev, fn]); return () => {} } }
  registerQqAdapter(ctx, { core: { surface: { current: () => 'qq' } } })
  const fn = listeners.find(([ev]) => ev === 'tools/post-execute')[1]
  const result = { isError: false, content: [{ type: 'text', text: '原样' }] }
  const decision = await fn({ name: 'qq_send_image', agent: {} }, result, () => Promise.resolve({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content[0].text, '[发出去了]')
  // 让 project 抛错也不改变原结果
  const bad = await fn({ name: 'qq_group_history', agent: {} }, { isError: false, content: [{ type: 'text', text: '原样' }] }, () => Promise.resolve({ kind: 'accept' }))
  assert.equal(bad.kind, 'accept')
})

test('value 不可序列化时原样放行，不改写工具结果', async () => {
  const listeners = []
  const ctx = { on: (ev, fn) => { listeners.push([ev, fn]); return () => {} } }
  registerQqAdapter(ctx, { core: { surface: { current: () => 'qq' } } })
  const fn = listeners.find(([ev]) => ev === 'tools/post-execute')[1]
  const result = { isError: false, value: { big: 1n }, content: [{ type: 'text', text: '原样' }] }
  let nextCalled = false
  const decision = await fn({ name: 'qq_group_history', agent: {} }, result, () => {
    nextCalled = true
    return Promise.resolve({ kind: 'accept', content: result.content })
  })
  assert.equal(nextCalled, true)
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content[0].text, '原样')
})

test('非 qq 面不接管', async () => {
  const listeners = []
  const ctx = { on: (ev, fn) => { listeners.push([ev, fn]); return () => {} } }
  registerQqAdapter(ctx, { core: { surface: { current: () => 'web' } } })
  const fn = listeners.find(([ev]) => ev === 'tools/post-execute')[1]
  let nextCalled = false
  const decision = await fn({ name: 'qq_send_image', agent: {} }, { isError: false, content: [] }, () => {
    nextCalled = true
    return Promise.resolve({ kind: 'accept' })
  })
  assert.equal(nextCalled, true)
  assert.equal(decision.kind, 'accept')
})

test('surface 判定抛错也不影响工具结果', async () => {
  const listeners = []
  const ctx = { on: (ev, fn) => { listeners.push([ev, fn]); return () => {} } }
  registerQqAdapter(ctx, { core: { surface: { current: () => { throw new Error('boom') } } } })
  const fn = listeners.find(([ev]) => ev === 'tools/post-execute')[1]
  let nextCalled = false
  const decision = await fn({ name: 'qq_send_image', agent: {} }, { isError: false, content: [] }, () => {
    nextCalled = true
    return Promise.resolve({ kind: 'accept' })
  })
  assert.equal(nextCalled, true)
  assert.equal(decision.kind, 'accept')
})

test('qq_send 失败只给原因，不带路径与编号', () => {
  const result = { isError: true, content: [{ type: 'text', text: 'Error: 本地路径不在允许的媒体目录内：/home/str1k3/x.png message_id=7 chatId=group_1' }] }
  const blocks = projectQqTool('qq_send_image', undefined, result.content, { isError: true })
  assert.match(blocks[0].text, /^\[没发出去：/)
  assert.equal(blocks[0].text.includes('message_id'), false)
  assert.equal(blocks[0].text.includes('chatId'), false)
  assert.equal(blocks[0].text.includes('/home/'), false)
})

test('qq_group_history 支持 vendor 的数组返回', () => {
  const value = [
    { message_id: '1', user_id: '42', nickname: '阿明', text: '在吗' },
    { message_id: '2', user_id: '43', nickname: '小李', text: '在' },
  ]
  const blocks = projectQqTool('qq_group_history', value, [])
  assert.match(blocks[0].text, /^\[群历史\] 最近 2 条：/)
  assert.match(blocks[0].text, /阿明：在吗/)
  assert.match(blocks[0].text, /小李：在/)
  assert.equal(blocks[0].text.includes('message_id'), false)
})

test('qq_group_history 解析失败保留原文并截断', () => {
  const raw = '不是 JSON 的历史\n' + 'x'.repeat(5000)
  const blocks = projectQqTool('qq_group_history', raw, [])
  assert.ok(blocks[0].text.length < raw.length)
  assert.match(blocks[0].text, /已截断/)
})

test('qq_napcat_api 群成员只给名字和角色', () => {
  const value = [
    { user_id: '10001', nickname: '阿明', card: '明明', role: 'admin' },
    { user_id: '10002', nickname: '小李', role: 'member' },
  ]
  const blocks = projectQqTool('qq_napcat_api', value, [], { args: { action: 'get_group_member_list' } })
  assert.match(blocks[0].text, /^\[群成员\] 2 人：/)
  assert.match(blocks[0].text, /明明（管理员）/)
  assert.match(blocks[0].text, /小李（群员）/)
  assert.equal(blocks[0].text.includes('10001'), false)
})

test('qq_napcat_api OCR 只给文字', () => {
  const value = { texts: [{ text: '晚上八点开会', confidence: 0.98 }], language: 'zh' }
  const blocks = projectQqTool('qq_napcat_api', value, [], { args: { action: 'ocr_image' } })
  assert.match(blocks[0].text, /晚上八点开会/)
  assert.equal(blocks[0].text.includes('confidence'), false)
  assert.equal(blocks[0].text.includes('0.98'), false)
})

test('未知 qq_* 返回 null，不接管', () => {
  assert.equal(projectQqTool('qq_mystery', 'something useful', []), null)
})

test('qq_napcat_api 未知 action 仍只报拿到', () => {
  const blocks = projectQqTool('qq_napcat_api', { secret: 'x', retcode: 0 }, [], { args: { action: 'get_unknown_thing' } })
  assert.equal(blocks[0].text, '[拿到了]')
})

test('未知 qq_* 进 legacy，监听器原样放行', async () => {
  resetQqAdapterStatus()
  const listeners = []
  const ctx = { on: (ev, fn) => { listeners.push([ev, fn]); return () => {} } }
  registerQqAdapter(ctx, { core: { surface: { current: () => 'qq' } } })
  const fn = listeners.find(([ev]) => ev === 'tools/post-execute')[1]
  let nextCalled = false
  const decision = await fn(
    { name: 'qq_mystery', agent: {} },
    { isError: false, value: 'something useful', content: [{ type: 'text', text: '原样' }] },
    () => { nextCalled = true; return Promise.resolve({ kind: 'accept' }) },
  )
  assert.equal(nextCalled, true)
  assert.equal(decision.kind, 'accept')
  assert.equal(Object.hasOwn(decision, 'content'), false)
  assert.deepEqual(qqAdapterStatus(), { legacy: ['qq_mystery'] })
  resetQqAdapterStatus()
})

test('legacy 排序去重，非 qq 面不记录', async () => {
  resetQqAdapterStatus()
  const qqListeners = []
  registerQqAdapter({ on: (ev, fn) => { qqListeners.push([ev, fn]); return () => {} } }, { core: { surface: { current: () => 'qq' } } })
  const qqFn = qqListeners.find(([ev]) => ev === 'tools/post-execute')[1]
  const pass = () => Promise.resolve({ kind: 'accept' })
  await qqFn({ name: 'qq_zeta', agent: {} }, { isError: false, content: [] }, pass)
  await qqFn({ name: 'qq_zeta', agent: {} }, { isError: false, content: [] }, pass)
  await qqFn({ name: 'qq_alpha', agent: {} }, { isError: false, content: [] }, pass)
  assert.deepEqual(qqAdapterStatus(), { legacy: ['qq_alpha', 'qq_zeta'] })

  const wxListeners = []
  registerQqAdapter({ on: (ev, fn) => { wxListeners.push([ev, fn]); return () => {} } }, { core: { surface: { current: () => 'wx' } } })
  const wxFn = wxListeners.find(([ev]) => ev === 'tools/post-execute')[1]
  await wxFn({ name: 'qq_other', agent: {} }, { isError: false, content: [] }, pass)
  assert.deepEqual(qqAdapterStatus(), { legacy: ['qq_alpha', 'qq_zeta'] })
  resetQqAdapterStatus()
})
