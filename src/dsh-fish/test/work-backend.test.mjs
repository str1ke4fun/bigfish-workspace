import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSubagentBackend } from '../lib/work-backend.js'

function fakeService({ includeSpawn = true } = {}) {
  const calls = { start: [], message: [], interrupt: [] }
  let settle
  const result = new Promise((resolve) => { settle = resolve })
  const service = {
    list: () => (includeSpawn ? ['spawn'] : ['fork']),
    async startActivation(spec) {
      calls.start.push(spec)
      return {
        childId: 'child-1',
        messageId: 'm-1',
        result,
        dispose: async () => {},
      }
    },
    async sendMessage(sender, target, content, opts) {
      calls.message.push({ sender, target, content, opts })
      return 'inbox-1'
    },
    interrupt(target, authority) {
      calls.interrupt.push({ target, authority })
    },
  }
  return { service, calls, settle }
}

test('没有 subagents / spawn 时明确不可用', async () => {
  const backend = createSubagentBackend({ getService: () => null })
  assert.equal(backend.available(), false)
  assert.deepEqual(await backend.spawn({ parent: {}, dir: '/tmp/p', preset: 'x', prompt: 'x' }), {
    ok: false,
    code: 'NO_SUBAGENTS',
    why: '这台机器不支持派活',
  })
  const noSpawn = createSubagentBackend({ getService: () => ({ list: () => ['fork'], startActivation() {} }) })
  assert.equal(noSpawn.available(), false)
})

test('spawn 把 cwd / preset / maxDepth / outputSchema 固定下来', async () => {
  const { service, calls, settle } = fakeService()
  const backend = createSubagentBackend({ getService: () => service })
  assert.equal(backend.available(), true)

  const parent = { id: 'boss' }
  const r = await backend.spawn({
    parent,
    dir: '/tmp/proj',
    preset: 'fish-work-inspect',
    prompt: '看一下',
    outputSchema: { type: 'object', properties: {} },
    label: '看一眼',
  })
  assert.equal(r.ok, true)
  assert.equal(r.childId, 'child-1')
  assert.equal(calls.start.length, 1)
  const spec = calls.start[0]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.label, '看一眼')
  assert.equal(spec.request.parent, parent)
  assert.equal(spec.request.cwd, '/tmp/proj')
  assert.equal(spec.request.agentPreset, 'fish-work-inspect')
  assert.equal(spec.request.maxDepth, 1)
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: '看一下' }])
  assert.deepEqual(spec.request.outputSchema, { type: 'object', properties: {} })
  assert.ok(spec.signal)

  settle({ output: [{ type: 'text', text: '好了' }], stopReason: 'completed' })
})

test('build 不传 outputSchema 时不带这个字段', async () => {
  const { service, calls } = fakeService()
  const backend = createSubagentBackend({ getService: () => service })
  await backend.spawn({ parent: { id: 'boss' }, dir: '/tmp/proj', preset: 'fish-work-build', prompt: '改' })
  assert.equal('outputSchema' in calls.start[0].request, false)
})

test('message / interrupt 走宿主服务，失败码原样返回', async () => {
  const { service, calls } = fakeService()
  const backend = createSubagentBackend({ getService: () => service })
  const sender = { id: 'boss' }
  assert.deepEqual(await backend.message({ sender, childId: 'child-1', text: '继续' }), {
    ok: true,
    messageId: 'inbox-1',
  })
  assert.equal(calls.message[0].target, 'child-1')
  assert.deepEqual(calls.message[0].content, [{ type: 'text', text: '继续' }])

  assert.deepEqual(await backend.interrupt({ sender, childId: 'child-1' }), { ok: true, accepted: true })
  assert.equal(calls.interrupt[0].target, 'child-1')
  assert.equal(calls.interrupt[0].authority.kind, 'ancestor')
  assert.equal(calls.interrupt[0].authority.agent, sender)

  service.sendMessage = async () => { const e = new Error('closed'); e.code = 'INPUT_CLOSED'; throw e }
  assert.deepEqual(await backend.message({ sender, childId: 'child-1', text: '再继续' }), {
    ok: false,
    code: 'INPUT_CLOSED',
    why: 'closed',
  })
})

test('onSettle 把 result 交给回调，拒绝也按 error 收口', async () => {
  const { service, settle } = fakeService()
  const backend = createSubagentBackend({ getService: () => service })
  const r = await backend.spawn({ parent: { id: 'boss' }, dir: '/tmp/p', preset: 'x', prompt: 'x' })
  const seen = []
  backend.onSettle(r.result, (x) => seen.push(x))
  settle({ output: [{ type: 'text', text: '完成' }], stopReason: 'completed' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].stopReason, 'completed')
  assert.equal(seen[0].closingText, '完成')

  const seen2 = []
  const rejecting = createSubagentBackend({
    getService: () => ({ list: () => ['spawn'], startActivation: async () => ({ childId: 'c', result: Promise.reject(new Error('boom')) }) }),
  })
  const r3 = await rejecting.spawn({ parent: { id: 'boss' }, dir: '/tmp/p', preset: 'x', prompt: 'x' })
  rejecting.onSettle(r3.result, (x) => seen2.push(x))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(seen2.length, 1)
  assert.equal(seen2[0].stopReason, 'error')
})
