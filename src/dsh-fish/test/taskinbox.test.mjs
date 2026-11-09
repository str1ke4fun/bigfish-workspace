// her_inbox：只读 wx 服务的摘要，不碰任务板文件；QQ 会话里不给看。
import test from 'node:test'
import assert from 'node:assert/strict'

import { registerInbox } from '../lib/taskinbox.js'

function harness(wx) {
  const defs = []
  const ctx = {
    tools: { register: (d) => { defs.push(d); return () => {} } },
    get: (name) => (name === 'wx' ? wx : undefined),
  }
  const off = registerInbox(ctx, { log: () => {} })
  return { def: defs[0], off }
}

test('没有 wx 服务：如实说看不到，不编任务', async () => {
  const { def } = harness(undefined)
  const out = await def.execute({}, {})
  assert.match(out.text, /没接上/)
})

test('有任务：原样返回摘要', async () => {
  const { def } = harness({ inboxSummary: ({ max }) => `最多${max}条：t_1｜群A｜未回` })
  const out = await def.execute({}, {})
  assert.equal(out.text, '最多10条：t_1｜群A｜未回')
})

test('没有任务：说没有', async () => {
  const { def } = harness({ inboxSummary: () => '' })
  assert.match((await def.execute({}, {})).text, /没有要回/)
})

test('QQ 会话里拒绝', async () => {
  const { def } = harness({ inboxSummary: () => 't_1' })
  await assert.rejects(() => def.execute({}, { agent: { session: { id: 'onebot-1' } } }), /微信通道/)
})

test('模型投影：有任务给 [待回]，没任务给 [没有要回的]', async () => {
  const busy = harness({ inboxSummary: () => 't_1｜群A｜未回' })
  const out = await busy.def.execute({}, {})
  const text = busy.def.output.render({}, out)[0].text
  assert.match(text, /^\[待回\] t_1/)
  assert.doesNotMatch(text, /编号/)

  const idle = harness({ inboxSummary: () => '' })
  const none = await idle.def.execute({}, {})
  assert.equal(idle.def.output.render({}, none)[0].text, '[没有要回的]')
})

test('工具形状：object-rooted schema + render', () => {
  const { def } = harness(undefined)
  assert.equal(def.name, 'her_inbox')
  assert.equal(def.parameters.type, 'object')
  assert.equal(def.output.schema.type, 'object')
  assert.equal(typeof def.output.render, 'function')
})
