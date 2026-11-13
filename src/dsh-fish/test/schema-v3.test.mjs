/**
 * schema-v3.test.mjs —— 事件 v3：surface、bili_reply、读路径推断
 *
 * 设计 §5.3 / §5.4 / §5.8：
 *   - 写入时 surface 白名单校验（未知抛 BAD_SURFACE）；
 *   - bili_reply 带结构化 reply（bvid / rpid 是去重键，缺失抛 BAD_REPLY）；
 *   - v1/v2 事件不迁移、不改写；读路径按 §5.4 推断 surface；
 *   - 旧版本读到 v3 事件跳过并计数（newer），等于回退时看不到新事件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ALL_TYPES,
  HER_TYPES,
  EVENT_SCHEMA_VERSION,
  SURFACES,
  BILI_META_PREFIXES,
  inferSurface,
  validateEvent,
} from '../lib/schema.js'
import { readEvents, appendEvent } from '../lib/store.js'
import { SYSTEM_EVENT_TYPES } from '../lib/events.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-v3-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const line = (ev) => JSON.stringify(ev) + '\n'

// ---------------------------------------------------------------- 常量与白名单

test('schema: 版本号与 surface 白名单', () => {
  assert.equal(EVENT_SCHEMA_VERSION, 4)
  // v4（合并裁决 D2）：事件来源面同时加入 screen；它与会话面 surface.js 不是同一张表。
  assert.deepEqual([...SURFACES], ['core', 'web', 'wx', 'qq', 'bili', 'screen'])
})

test('v3: BILI_META_PREFIXES 覆盖设计 §5.4 的全部前缀', () => {
  assert.deepEqual([...BILI_META_PREFIXES], [
    'browse:', 'looked:', 'watched:', 'comment:', 'creply:', 'cbody:', 'cseen:', 'my:', 'biliout:',
  ])
})

test('v3: bili_reply 是一等事件类型，但不开放给她写', () => {
  assert.ok(ALL_TYPES.includes('bili_reply'))
  assert.ok(!HER_TYPES.includes('bili_reply'))
  assert.throws(
    () => validateEvent({ type: 'bili_reply', text: '回了', reply: { bvid: 'BV1', rpid: '42' } }, { source: 'tool' }),
    (e) => e.code === 'NOT_HER_TYPE',
  )
})

test('v3: events.js 登记了全部系统侧类型（含 bili_reply）', () => {
  assert.ok(SYSTEM_EVENT_TYPES.includes('bili_reply'))
  const expected = ALL_TYPES.filter((t) => !HER_TYPES.includes(t)).slice().sort()
  assert.deepEqual([...SYSTEM_EVENT_TYPES].slice().sort(), expected)
})

// ---------------------------------------------------------------- 写路径

test('v3: 合法 surface 往返', () => {
  const ev = validateEvent({ type: 'saw', text: 'x', surface: 'bili' }, { source: 'system' })
  assert.equal(ev.v, EVENT_SCHEMA_VERSION)
  assert.equal(ev.surface, 'bili')
})

test('v3: 未知 surface 拒绝，不静默落 core', () => {
  assert.throws(
    () => validateEvent({ type: 'saw', text: 'x', surface: 'nope' }, { source: 'system' }),
    (e) => e.code === 'BAD_SURFACE' && /BAD_SURFACE/.test(e.message),
  )
})

test('v3: 不传 surface 时按老行为接受，并推断出 surface', () => {
  assert.equal(validateEvent({ type: 'utterance', text: 'x', channel: 'wx' }, { source: 'system' }).surface, 'wx')
  assert.equal(validateEvent({ type: 'saw', text: 'x', refs: ['BV1'] }, { source: 'system' }).surface, 'bili')
  assert.equal(validateEvent({ type: 'utterance', text: 'x' }, { source: 'system' }).surface, 'core')
})

test('v3: bili_reply 漏传/空 surface 拒绝，不静默落 core', () => {
  const reply = { bvid: 'BV1', rpid: '42' }
  for (const surface of [undefined, null]) {
    assert.throws(
      () => validateEvent({ type: 'bili_reply', text: '回了', surface, reply }, { source: 'system' }),
      (e) => e.code === 'BAD_SURFACE' && /BAD_SURFACE/.test(e.message),
      `surface=${String(surface)} 时应当拒绝`,
    )
  }
})

test('v3: bili_reply 结构化去重键', () => {
  const ev = validateEvent(
    { type: 'bili_reply', text: '回了', surface: 'bili', reply: { bvid: 'BV1', rpid: '42' } },
    { source: 'system' },
  )
  assert.equal(ev.v, EVENT_SCHEMA_VERSION)
  assert.equal(ev.surface, 'bili')
  assert.equal(ev.reply.rpid, '42')
  assert.equal(ev.reply.bvid, 'BV1')
  assert.equal(ev.channel, 'core')
})

test('v3: bili_reply 的 reply 字段转字符串并截断到 64', () => {
  const ev = validateEvent(
    {
      type: 'bili_reply',
      text: '对方回了',
      surface: 'bili',
      reply: {
        bvid: ' BV1abc ',
        rpid: 42,
        root: 7,
        parent: 'p1',
        user: '名'.repeat(80),
        mid: 12345,
        extra: '不落盘',
      },
    },
    { source: 'system' },
  )
  assert.equal(ev.reply.bvid, 'BV1abc')
  assert.equal(ev.reply.rpid, '42')
  assert.equal(ev.reply.root, '7')
  assert.equal(ev.reply.parent, 'p1')
  assert.equal(ev.reply.user.length, 64)
  assert.equal(ev.reply.mid, '12345')
  assert.ok(!('extra' in ev.reply), '只保留设计里的字段')
})

test('v3: 空回复写占位句，不新增 flag', () => {
  const ev = validateEvent(
    { type: 'bili_reply', text: '   ', surface: 'bili', reply: { bvid: 'BV1', rpid: '42' } },
    { source: 'system' },
  )
  assert.equal(ev.text, '（对方发了一条空回复）')
  assert.deepEqual(ev.flags, [])
})

test('v3: bili_reply 缺 reply / bvid / rpid 抛 BAD_REPLY', () => {
  const bad = [
    undefined,
    'reply',
    {},
    { bvid: 'BV1' },
    { rpid: '42' },
    { bvid: '   ', rpid: '42' },
    { bvid: 'BV1', rpid: '   ' },
  ]
  for (const reply of bad) {
    assert.throws(
      () => validateEvent({ type: 'bili_reply', text: '回了', surface: 'bili', reply }, { source: 'system' }),
      (e) => e.code === 'BAD_REPLY' && /BAD_REPLY/.test(e.message),
      `reply=${JSON.stringify(reply)} 应当被拒`,
    )
  }
})

test('v3: 非 bili_reply 不携带 reply 子对象', () => {
  const ev = validateEvent({ type: 'utterance', text: 'x', reply: { bvid: 'BV1', rpid: '42' } }, { source: 'system' })
  assert.ok(!('reply' in ev))
})

// ---------------------------------------------------------------- 读路径推断

test('v3: 旧事件推断 surface', () => {
  assert.equal(inferSurface({ channel: 'wx', type: 'utterance' }), 'wx')
  assert.equal(inferSurface({ channel: 'qq', type: 'utterance' }), 'qq')
  assert.equal(inferSurface({ channel: 'web', type: 'utterance' }), 'web')
  assert.equal(inferSurface({ channel: 'core', type: 'saw', refs: ['BV1'] }), 'bili')
  assert.equal(inferSurface({ channel: 'core', type: 'voice', refs: ['BV1abc'] }), 'bili')
  assert.equal(inferSurface({ channel: 'core', type: 'saw', text: 'B站｜《一个视频》' }), 'bili')
  assert.equal(inferSurface({ channel: 'core', type: 'meta', text: 'browse:2026-11-10 3' }), 'bili')
  assert.equal(inferSurface({ channel: 'core', type: 'meta', text: 'fired:x' }), 'core')
  assert.equal(inferSurface({ channel: 'core', type: 'meta', text: 'seen:2026-11-10T00:00:00.000Z' }), 'core')
  assert.equal(inferSurface({ channel: 'core', type: 'utterance', text: '我自己的想法。' }), 'core')
})

test('v3: B 站前缀全部推断为 bili，core 前缀为 core', () => {
  for (const prefix of BILI_META_PREFIXES) {
    assert.equal(inferSurface({ channel: 'core', type: 'meta', text: `${prefix}x` }), 'bili', prefix)
  }
  for (const prefix of ['fired:', 'sched:', 'seen:', 'quiet:', 'absence:']) {
    assert.equal(inferSurface({ channel: 'core', type: 'meta', text: `${prefix}x` }), 'core', prefix)
  }
})

test('v3: inferSurface 对残缺事件不抛错，也绝不改事件', () => {
  const malformed = [
    undefined, null, {}, [], 'x', 42,
    { channel: 'core' },
    { channel: 'core', type: 'saw' },
    { channel: 'core', type: 'meta' },
    { channel: 42, type: 42, text: 42, refs: 'BV1' },
  ]
  for (const ev of malformed) {
    assert.doesNotThrow(() => inferSurface(ev))
    assert.equal(inferSurface(ev), 'core', JSON.stringify(ev))
  }

  const frozen = Object.freeze({
    channel: 'core', type: 'meta', text: 'browse:2026-11-10 3', refs: Object.freeze(['BV1']),
  })
  const before = JSON.stringify(frozen)
  assert.equal(inferSurface(frozen), 'bili')
  assert.equal(JSON.stringify(frozen), before, '推断不能写回事件')
  assert.ok(!('surface' in frozen))
})

// ---------------------------------------------------------------- readEvents

test('v3: v3 事件经 readEvents 往返保留 surface', async () => {
  await withRoot(async (root) => {
    const ev = await appendEvent(
      { type: 'saw', text: 'B站｜《一个视频》', refs: ['BV1abc'], surface: 'bili' },
      { day: 1, stage: 1, source: 'system' },
      root,
    )
    assert.equal(ev.v, EVENT_SCHEMA_VERSION)
    assert.equal(ev.surface, 'bili')

    const r = await readEvents(root)
    assert.equal(r.events.length, 1)
    assert.equal(r.events[0].surface, 'bili')
    assert.equal(r.newer, 0)
  })
})

test('v3: 比本程序新的事件被跳过并计数（旧读者的回退行为）', async () => {
  await withRoot(async (root) => {
    const known = {
      id: 'ev_01J0000000000000000000000D', v: EVENT_SCHEMA_VERSION, type: 'utterance', text: '本版本的话。',
      ts: '2026-11-10T00:00:00.000Z', day: 1, stage: 1,
    }
    const future = {
      id: 'ev_01J0000000000000000000000E', v: EVENT_SCHEMA_VERSION + 1, type: 'utterance', text: '未来的话。',
      ts: '2026-11-10T00:00:00.000Z', day: 1, stage: 1,
    }
    await writeFile(join(root, 'events.jsonl'), line(known) + line(future))

    const r = await readEvents(root)
    assert.equal(r.events.length, 1, '只读得懂本版本的事件')
    assert.equal(r.events[0].id, known.id)
    assert.equal(r.newer, 1, '更新版本的事件跳过并计数')
    assert.equal(r.skipped, 0)
  })
})

test('v3: 旧事件读路径补 surface，且不回写文件', async () => {
  await withRoot(async (root) => {
    const wx = {
      id: 'ev_01J0000000000000000000000F', v: 2, type: 'utterance', text: '微信里的一句话。',
      channel: 'wx', ts: '2026-11-01T00:00:00.000Z', day: 1, stage: 1,
    }
    const meta = {
      id: 'ev_01J0000000000000000000000G', v: 1, type: 'meta', text: 'browse:2026-11-01 2',
      ts: '2026-11-01T00:00:00.000Z', day: 1, stage: 1,
    }
    const file = join(root, 'events.jsonl')
    await writeFile(file, line(wx) + line(meta))

    const r = await readEvents(root)
    assert.deepEqual(r.events.map((e) => e.surface), ['wx', 'bili'])

    const after = await readFile(file, 'utf8')
    assert.ok(!after.includes('surface'), '读路径推断不回写 events.jsonl')
  })
})
