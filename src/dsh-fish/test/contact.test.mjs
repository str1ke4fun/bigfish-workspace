import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isContactMessage,
  markSeen,
  resetContactCache,
  CONTACT_SOURCES,
  SYSTEM_RPC,
} from '../lib/contact.js'
import { readEvents } from '../lib/store.js'
import { WAKE_TRIGGER, BILI_TRIGGER } from '../lib/wakeconst.js'

const msg = (text, { rpcId = 'rpc-1', kind = 'user', surface = 'web', content } = {}) => ({
  event: {
    type: 'user/message',
    data: {
      content: content ?? [{ type: 'text', text }],
      source: { kind, rpcId },
    },
  },
  surface,
})

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-contact-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('isContactMessage：真实 web 用户消息算，空文本与图片也算', () => {
  assert.equal(isContactMessage(msg('今天吃什么')), true)
  assert.equal(isContactMessage(msg('')), true, '空文本也算 contact')
  assert.equal(isContactMessage(msg('', { content: [{ type: 'image', url: 'x' }] })), true, '纯图片也算 contact')
})

test('isContactMessage：runtime-context 与缺失 source 不算', () => {
  assert.equal(isContactMessage(msg('x', { kind: 'runtime-context' })), false)
  assert.equal(isContactMessage(msg('x', { kind: 'system' })), false)
  assert.equal(isContactMessage({ event: { type: 'user/message', data: { content: [] } }, surface: 'web' }), false)
  assert.equal(isContactMessage(), false)
})

test('isContactMessage：各系统 rpcId 前缀都不算（含 fish-）', () => {
  for (const id of [
    'wake-1',
    'wake-fresh-1',
    'closing-2026-11-13',
    'bili-2026-11-13-1',
    'say-2026-11-13-1',
    'presence-2026-11-13-1',
    'fish-abc123',
  ]) {
    assert.equal(isContactMessage(msg('x', { rpcId: id })), false, id)
  }
  assert.equal(isContactMessage(msg('x', { rpcId: 'rpc-normal' })), true)
})

test('isContactMessage：三种 trigger 与 [微信·主机] poke 不算', () => {
  assert.equal(isContactMessage(msg(WAKE_TRIGGER)), false)
  assert.equal(isContactMessage(msg('（收工了。）')), false)
  assert.equal(isContactMessage(msg(BILI_TRIGGER)), false)
  assert.equal(isContactMessage(msg('[微信·主机] poke')), false)
  assert.equal(isContactMessage(msg('普通消息 [微信·主机] 不在开头')), true)
})

test('isContactMessage：非 web surface 不算（v1）', () => {
  for (const surface of ['wx', 'bili', 'screen', 'qq', 'core', null]) {
    assert.equal(isContactMessage(msg('x', { surface })), false, String(surface))
  }
  // 显式 undefined / 缺省 surface：bootstrap 前可能为 null，同样不写
  const base = msg('x')
  assert.equal(isContactMessage({ event: base.event, surface: undefined }), false)
  assert.equal(isContactMessage({ event: base.event }), false)
})

test('isContactMessage：非 user/message 事件不算', () => {
  const base = msg('x')
  assert.equal(isContactMessage({ ...base, event: { ...base.event, type: 'meta' } }), false)
})

test('markSeen：先 seen 后 contact，两条都是 system meta', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const at = Date.parse('2026-11-13T10:00:00Z')
    const a = await markSeen(root, { source: 'web', at })
    assert.equal(a.ok, true)
    assert.equal(a.contact, true)
    const { events } = await readEvents(root)
    assert.deepEqual(events.map((e) => e.text), [
      'seen:2026-11-13T10:00:00.000Z',
      'contact:web:2026-11-13T10:00:00.000Z',
    ])
    assert.ok(events.every((e) => e.type === 'meta' && e.source === 'system'))
  })
})

test('markSeen：未知 source 回退 web', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const at = Date.parse('2026-11-13T10:00:00Z')
    const r = await markSeen(root, { source: 'telegram', at })
    assert.equal(r.ok, true)
    const { events } = await readEvents(root)
    assert.equal(events[1].text, 'contact:web:2026-11-13T10:00:00.000Z')
  })
})

test('markSeen：同一 source 60 秒内去重，不同 source 不去重', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const t0 = Date.parse('2026-11-13T10:00:00Z')
    assert.equal((await markSeen(root, { source: 'web', at: t0 })).ok, true)
    const b = await markSeen(root, { source: 'web', at: t0 + 30_000 })
    assert.equal(b.ok, true)
    assert.equal(b.skipped, true)
    assert.equal((await readEvents(root)).events.length, 2)

    // 正好 60 秒算新的 contact
    const edge = await markSeen(root, { source: 'web', at: t0 + 60_000 })
    assert.equal(edge.ok, true)
    assert.notEqual(edge.skipped, true)
    assert.equal((await readEvents(root)).events.length, 4)

    // 不同 source 各自独立
    const c = await markSeen(root, { source: 'wx', at: t0 + 30_000 })
    assert.equal(c.ok, true)
    assert.equal(c.contact, true)
    assert.equal((await readEvents(root)).events.length, 6)
    const last = (await readEvents(root)).events.slice(-2).map((e) => e.text)
    assert.deepEqual(last, [
      'seen:2026-11-13T10:00:30.000Z',
      'contact:wx:2026-11-13T10:00:30.000Z',
    ])
  })
})

test('markSeen：dedupe=false 时不去重', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const at = Date.parse('2026-11-13T10:00:00Z')
    await markSeen(root, { source: 'web', at })
    const b = await markSeen(root, { source: 'web', at: at + 1_000, dedupe: false })
    assert.notEqual(b.skipped, true)
    assert.equal((await readEvents(root)).events.length, 4)
  })
})

test('markSeen：resetContactCache 后重新写', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const at = Date.parse('2026-11-13T10:00:00Z')
    await markSeen(root, { source: 'web', at })
    assert.equal((await markSeen(root, { source: 'web', at: at + 1_000 })).skipped, true)
    resetContactCache()
    const again = await markSeen(root, { source: 'web', at: at + 2_000 })
    assert.notEqual(again.skipped, true)
    assert.equal((await readEvents(root)).events.length, 4)
  })
})

test('markSeen：seen 写失败返回 ok:false，且不消费去重窗口', async () => {
  const root = join(await mkdtemp(join(tmpdir(), 'fish-contact-bad-')), 'not-a-dir')
  await writeFile(root, 'x')
  try {
    resetContactCache()
    const at = Date.parse('2026-11-13T10:00:00Z')
    const a = await markSeen(root, { source: 'web', at })
    assert.equal(a.ok, false)
    assert.equal(typeof a.why, 'string')
    assert.ok(a.why.length > 0)
    // seen 没成功 -> 去重时间不更新，下一次同一时间窗仍然尝试（仍然失败，不是 skipped）
    const b = await markSeen(root, { source: 'web', at: at + 1_000 })
    assert.equal(b.ok, false)
    assert.notEqual(b.skipped, true)
  } finally {
    await rm(root, { force: true })
  }
})

test('markSeen：contact 写失败不回滚 seen，返回 {ok:true,contact:false}', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const original = fsp.appendFile
    let calls = 0
    fsp.appendFile = async (...args) => {
      calls++
      if (calls === 2) throw new Error('disk full (mock)')
      return original.apply(fsp, args)
    }
    try {
      const at = Date.parse('2026-11-13T10:00:00Z')
      const r = await markSeen(root, { source: 'web', at })
      assert.equal(calls, 2)
      assert.equal(r.ok, true)
      assert.equal(r.contact, false)
      assert.match(String(r.why), /disk full/)
      const { events } = await readEvents(root)
      assert.deepEqual(events.map((e) => e.text), ['seen:2026-11-13T10:00:00.000Z'])
    } finally {
      fsp.appendFile = original
    }
  })
})

test('常量：CONTACT_SOURCES 与 SYSTEM_RPC 可供复用', () => {
  assert.deepEqual([...CONTACT_SOURCES], ['web', 'wx', 'qq', 'bili', 'screen'])
  for (const id of ['wake-1', 'wake-fresh-1', 'closing-1', 'bili-1', 'say-1', 'presence-1', 'fish-1']) {
    assert.equal(SYSTEM_RPC.test(id), true, id)
  }
  assert.equal(SYSTEM_RPC.lastIndex, 0, '正则无 g，不应有 lastIndex 状态')
})
