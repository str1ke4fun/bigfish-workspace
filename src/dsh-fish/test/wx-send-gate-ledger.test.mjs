import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSendGate } from '../../dsh-wx/lib/send-gate.js'
import { WxToolError, registerWxToolErrorAdapter } from '../../dsh-wx/lib/tool-error.js'
import { createToolLedger } from '../lib/tool-ledger.js'

const SAME_NAME = (a, b) => String(a ?? '').trim() === String(b ?? '').trim()

function makeGate(overrides = {}) {
  return createSendGate({
    policy: () => ({
      enabled: true,
      allowChats: ['测试群A'],
      noMentionChats: [],
      requireMention: true,
      mentionWindowMinutes: 3,
      proactivePerDay: 0,
      proactiveChats: {},
    }),
    hostBlocksSend: () => false,
    look: async () => ({ parsed: { ok: true, current: '测试群A', chats: [] } }),
    isStale: () => false,
    staleDetail: () => '',
    allowedCurrent: (parsed, allowed) => (
      allowed.find((name) => SAME_NAME(name, parsed.current)) ?? null
    ),
    sameName: SAME_NAME,
    canSpeak: () => ({ ok: false, reason: '最近没人 @ 你' }),
    readMentions: () => ({}),
    loadState: () => ({ ok: true, day: '2026-11-18', used: {} }),
    decideProactive: () => ({ ok: true, proactive: false, left: 0 }),
    consumeProactive: (_policy, state) => ({ state, left: 0 }),
    saveState: () => true,
    logInbound: () => {},
    now: () => Date.UTC(2026, 10, 18, 4, 0, 0),
    ...overrides,
  })
}

async function rejectsWxTool(promise, code) {
  try {
    await promise
    assert.fail(`expected ${code}`)
  } catch (error) {
    assert.ok(error instanceof WxToolError)
    assert.equal(error.code, code)
    return error
  }
}

test('真实发送闸拒绝经 post-execute 后，台账保留 code、原始原因和世界声', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-wx-gate-'))
  try {
    const gate = makeGate({ hostBlocksSend: () => true })
    const error = await rejectsWxTool(gate(), 'WX_HOST_BLOCKED')
    assert.match(error.rawDetail, /host|主机/i)

    const listeners = []
    const off = registerWxToolErrorAdapter({
      on(event, listener) {
        assert.equal(event, 'tools/post-execute')
        listeners.push(listener)
        return () => listeners.splice(listeners.indexOf(listener), 1)
      },
    })
    const result = {
      isError: true,
      error,
      content: [{ type: 'text', text: `Error: ${error.message}` }],
    }
    const projected = await listeners[0](
      { name: 'wx_send', arguments: { chat: '测试群A', text: '在吗' } },
      result,
      () => Promise.resolve({ kind: 'accept', content: result.content }),
    )
    assert.deepEqual(projected, {
      kind: 'accept',
      content: [{ type: 'text', text: '[这句是在这儿说的，不是发到微信]' }],
    })
    result.content = projected.content

    const ledger = createToolLedger({ root, guard: { looksLikeSecret: () => ({ hit: false }) } })
    const entry = await ledger.record(
      { name: 'wx_send', arguments: { chat: '测试群A', text: '在吗' }, agent: { session: { header: { id: 'wx-test' } } } },
      result,
      { surface: 'wx' },
    )
    assert.equal(entry.ok, false)
    assert.equal(entry.code, 'WX_HOST_BLOCKED')
    assert.equal(entry.error, error.rawDetail)
    assert.equal(entry.modelText, '[这句是在这儿说的，不是发到微信]')
    assert.equal(entry.error.includes('WXTOOL|'), false)
    off()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('发送闸的名单、切会话和主动额度失败都带可审计原始原因', async () => {
  const notAllowed = await rejectsWxTool(makeGate({
    look: async () => ({ parsed: { ok: true, current: '测试群B', chats: [] } }),
  })(), 'WX_NOT_ALLOWED')
  assert.match(notAllowed.rawDetail, /测试群B/)
  assert.match(notAllowed.rawDetail, /allowChats|允许/)

  const changed = await rejectsWxTool(makeGate({
    policy: () => ({
      enabled: true,
      allowChats: ['测试群B'],
      noMentionChats: [],
      requireMention: false,
      mentionWindowMinutes: 3,
      proactivePerDay: 0,
      proactiveChats: {},
    }),
    look: async () => ({ parsed: { ok: true, current: '测试群B', chats: [] } }),
  })({ expected: '测试群A' }), 'WX_CHAT_CHANGED')
  assert.match(changed.rawDetail, /expected=测试群A/)
  assert.match(changed.rawDetail, /actual=测试群B/)

  const loadFailed = await rejectsWxTool(makeGate({
    loadState: () => ({ ok: false, day: '2026-11-18', used: {} }),
    decideProactive: () => ({
      ok: false,
      proactive: false,
      left: 0,
      why: '主动额度状态读不出来',
    }),
  })(), 'WX_PROACTIVE_STATE')
  assert.match(loadFailed.rawDetail, /主动额度状态读不出来/)

  const saveFailed = await rejectsWxTool(makeGate({
    loadState: () => ({ ok: true, day: '2026-11-18', used: {} }),
    decideProactive: () => ({ ok: true, proactive: true, left: 1 }),
    consumeProactive: (_policy, state) => ({ state, left: 0 }),
    saveState: () => false,
  })({ consume: true }), 'WX_PROACTIVE_STATE')
  assert.match(saveFailed.rawDetail, /saveState|写入/)
})
