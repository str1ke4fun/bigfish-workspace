/**
 * memory-closed-loop.test.mjs —— B 站路径改走 fishCore 接口（A1.8）
 *
 * 守的是三态闭环与「公开事实」的落点：
 *   1. 扫到新回复 → 一条 `bili_reply`（surface=bili、channel=core、reply.rpid 去重）；
 *   2. 投递成功 → `cseen:<rpid>`；投递失败不写，下一轮还能再投；
 *   3. 她回出去 → `creply` 记账 + 呈现标记；
 *   4. 她说出口 → 一条 `utterance` + `my:<rpid>`，同 rpid 不重复；
 *   5. 看过视频 → `saw` 也带 surface=bili / channel=core。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents, writeConfig, paths } from '../lib/store.js'
import { normalizeConfig, dateKey } from '../lib/settings.js'
import { createMemoryService } from '../lib/memory-service.js'
import { scanReplies, postReply, observedReplies, seenReplies } from '../lib/comment.js'
import { speakOnce } from '../lib/speak.js'
import { recordSaw } from '../lib/browse.js'
import { maybeOuting, resetOutingState } from '../lib/outing.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-loop-'))
  try {
    return await fn(root)
  } finally {
    resetOutingState()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function fakeClient(over = {}) {
  const base = {
    view: async (bvid) => ({ ok: true, data: { aid: 1001, title: `标题 ${bvid}` } }),
    subReplies: async () => ({ ok: true, data: [] }),
    replyAdd: async () => ({ ok: true, data: { rpid: 90001 } }),
    replyReply: async () => ({ ok: true, data: { rpid: 90002 } }),
  }
  return { ...base, ...over }
}

async function enableComment(root, patch = {}) {
  await mkdir(paths(root).root, { recursive: true })
  const cfg = normalizeConfig({
    comment: { enabled: true, perDay: 2, replyPerDay: 2, window: ['00:00', '23:59'], ...patch },
  })
  await writeConfig(cfg, root)
  return cfg
}

async function seedBrowse(root, bvid, dk = dateKey()) {
  await appendEvent(
    { type: 'meta', text: `browse:${dk} [{"bvid":"${bvid}","title":"某视频","up":"某UP","duration":600,"view":1000}]` },
    { day: 1, stage: 1, source: 'system' },
    root,
  )
}

async function seedComment(root, rpid = 111, bvid = 'BV1', dk = dateKey()) {
  await appendEvent({ type: 'meta', text: `comment:${dk} ${bvid} ${rpid}` }, { day: 1, stage: 1, source: 'system' }, root)
}

const REPLY = { rpid: 222, mid: 777, parent: 111, user: '路人甲', text: '说得挺对的', ctime: 3 }

test('scanReplies：新回复写成一条 bili_reply，重复扫描不重复写', async () => {
  await withRoot(async (root) => {
    await seedComment(root)
    const memory = createMemoryService({ root })
    const client = fakeClient({ subReplies: async () => ({ ok: true, data: [REPLY] }) })

    const first = await scanReplies({ root, client, memory })
    assert.equal(first.length, 1)
    let { events } = await readEvents(root)
    const replies = events.filter((e) => e.type === 'bili_reply')
    assert.equal(replies.length, 1, '一条新回复只能有一条 bili_reply')
    assert.equal(replies[0].surface, 'bili')
    assert.equal(replies[0].channel, 'core')
    assert.equal(replies[0].text, '说得挺对的')
    assert.equal(replies[0].reply.rpid, '222')
    assert.equal(replies[0].reply.root, '111')
    assert.equal(replies[0].reply.parent, '111')

    // 同一回复再扫一遍：不重复写事件，但因为还没呈现，仍然返回给她
    const second = await scanReplies({ root, client, memory })
    assert.equal(second.length, 1, '还没投递的回复下一轮还要给')
    ;({ events } = await readEvents(root))
    assert.equal(events.filter((e) => e.type === 'bili_reply').length, 1)
    assert.deepEqual([...observedReplies(events)], ['222'])
  })
})

test('scanReplies：v2 的 cseen（已回）不再扫、不再投', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await seedComment(root)
    await appendEvent({ type: 'meta', text: `cseen:${dk} 222` }, { day: 1, stage: 1, source: 'system' }, root)
    const memory = createMemoryService({ root })
    const client = fakeClient({ subReplies: async () => ({ ok: true, data: [REPLY] }) })

    const out = await scanReplies({ root, client, memory })
    assert.equal(out.length, 0)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'bili_reply').length, 0, '旧 cseen 的回复不该补写观察记录')
    assert.ok(seenReplies(events, dk).has(222))
  })
})

// ---------------------------------------------------------------------------
// 投递（出门）与三态
// ---------------------------------------------------------------------------

function fakeOutingCtx({ promptImpl } = {}) {
  const prompts = []
  const listeners = new Set()
  const ctx = {
    sessionController: {
      async prompt(payload) {
        prompts.push(payload)
        if (promptImpl) return promptImpl(payload)
      },
    },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    get(key) { return ctx[key] },
  }
  return { ctx, prompts }
}

test('maybeOuting：投递成功才写 cseen：<rpid>；下一轮扫描不再投', async () => {
  await withRoot(async (root) => {
    await seedComment(root)
    await enableComment(root)
    const memory = createMemoryService({ root })
    const client = fakeClient({ subReplies: async () => ({ ok: true, data: [REPLY] }) })
    const { ctx } = fakeOutingCtx()

    const out = await maybeOuting(ctx, {
      root,
      config: normalizeConfig({ comment: { enabled: true, window: ['00:00', '23:59'] } }),
      events: (await readEvents(root)).events,
      now: new Date(2026, 10, 11, 12, 0, 0),
      ensureSession: async () => ({ ok: true, sessionId: 'bil-1' }),
      client,
      memory,
    })
    assert.equal(out.ok, true, out.why)

    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.type === 'meta' && e.text === 'cseen:222'), '投递成功要写 v3 呈现标记')
    assert.equal(events.filter((e) => e.type === 'bili_reply').length, 1)

    const again = await scanReplies({ root, client, memory })
    assert.equal(again.length, 0, '已呈现的回复不再投递')
  })
})

test('maybeOuting：投递失败不写 cseen，下一轮还能再投', async () => {
  await withRoot(async (root) => {
    await seedComment(root)
    await enableComment(root)
    const memory = createMemoryService({ root })
    const client = fakeClient({ subReplies: async () => ({ ok: true, data: [REPLY] }) })
    const { ctx } = fakeOutingCtx({ promptImpl: async () => { throw new Error('session busy') } })

    const out = await maybeOuting(ctx, {
      root,
      config: normalizeConfig({ comment: { enabled: true, window: ['00:00', '23:59'] } }),
      events: (await readEvents(root)).events,
      now: new Date(2026, 10, 11, 12, 0, 0),
      ensureSession: async () => ({ ok: true, sessionId: 'bil-1' }),
      client,
      memory,
    })
    assert.equal(out.ok, false)

    const { events } = await readEvents(root)
    assert.equal(events.some((e) => e.type === 'meta' && e.text === 'cseen:222'), false, '失败不能写呈现标记')
    const again = await scanReplies({ root, client, memory })
    assert.equal(again.length, 1, '没投出去的回复下一轮还要给')
  })
})

test('postReply 成功：creply 记账 + v3 cseen 呈现标记', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root)
    await seedBrowse(root, 'BV1', dk)
    await seedComment(root, 555, 'BV1', dk)
    const client = fakeClient()

    const r = await postReply({ root, client, bvid: 'BV1', parentRpid: 777, text: '嗯', dateKey: dk })
    assert.equal(r.ok, true, r.why)

    const { events } = await readEvents(root)
    assert.ok(events.some((e) => e.type === 'meta' && String(e.text).startsWith(`creply:${dk} BV1 555 777`)))
    assert.ok(events.some((e) => e.type === 'meta' && e.text === 'cseen:777'), 'v3 呈现标记是 cseen:<rpid>')
    assert.equal(
      events.some((e) => e.type === 'meta' && e.text === `cseen:${dk} 777`),
      false,
      '不再写 v2 的 cseen:<日期> <rpid>',
    )
  })
})

// ---------------------------------------------------------------------------
// 她说出口 / 看过视频
// ---------------------------------------------------------------------------

test('speakOnce 成功：一条 utterance + my:<rpid>，同 rpid 不重复', async () => {
  await withRoot(async (root) => {
    const dk = dateKey()
    await enableComment(root)
    await seedBrowse(root, 'BV1', dk)
    const memory = createMemoryService({ root })
    const client = fakeClient({ replyAdd: async () => ({ ok: true, data: { rpid: 90001 } }) })

    const one = await speakOnce({ root, kind: 'comment', bvid: 'BV1', text: '这个好看', client, memory })
    assert.equal(one.ok, true, one.note)

    let { events } = await readEvents(root)
    const words = events.filter((e) => e.type === 'utterance')
    assert.equal(words.length, 1)
    assert.equal(words[0].text, '这个好看')
    assert.equal(words[0].surface, 'bili')
    assert.equal(words[0].channel, 'core')
    assert.ok(events.some((e) => e.type === 'meta' && e.text === 'my:90001'))

    // 平台回执被重放（同一 rpid）：记忆只写一次
    const two = await speakOnce({ root, kind: 'comment', bvid: 'BV1', text: '这个好看', client, memory })
    assert.equal(two.ok, true)
    ;({ events } = await readEvents(root))
    assert.equal(events.filter((e) => e.type === 'utterance').length, 1)
    assert.equal(events.filter((e) => e.type === 'meta' && e.text === 'my:90001').length, 1)
  })
})

test('recordSaw 走 memory：saw 带 surface=bili、channel=core', async () => {
  await withRoot(async (root) => {
    const memory = createMemoryService({ root })
    const packs = [{
      video: { bvid: 'BVsaw1', title: '第一条', up: '某UP', duration: 600, view: 1000 },
      tags: ['日常'],
      desc: '简介',
    }]
    const n = await recordSaw(root, packs, { day: 2, stage: 2 }, { memory })
    assert.equal(n, 1)
    const { events } = await readEvents(root)
    const saw = events.find((e) => e.type === 'saw')
    assert.equal(saw.surface, 'bili')
    assert.equal(saw.channel, 'core')
    assert.deepEqual(saw.refs, ['BVsaw1'])
  })
})
