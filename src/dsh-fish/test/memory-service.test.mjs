/**
 * memory-service.test.mjs —— `fishCore.memory` 写/读门面（Task A1.2）
 *
 * 设计 §5.2（channel/surface 语义）与 §5.5（写接口）：
 *   - 系统侧唯一写入口 append：不抛，失败返回 {ok:false, why}；
 *   - surface/channel 解析顺序按主控裁定，B 站公开事实 channel 落 core；
 *   - meta 默认不出现在 read 里；read 的时间/类型/通道/面过滤与 limit 夹取；
 *   - write-then-refresh 的身份文档刷新只在指定类型后触发，失败不影响写入。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMemoryService } from '../lib/memory-service.js'
import { provideFishCore } from '../lib/core-service.js'
import { readEvents, paths } from '../lib/store.js'
import { HER_TYPES, EVENT_SCHEMA_VERSION } from '../lib/schema.js'
import { similarity } from '../lib/similarity.js'

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-mem-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const agent = (id, cwd = '') => ({ session: { header: { id, cwd } } })

/** 只实现 surface.current 的最小 core；通道判定仍由 store.channelOfAgent 完成。 */
function fakeCore() {
  return {
    surface: {
      current(a) {
        const id = String(a?.session?.header?.id ?? a?.session?.id ?? '')
        const cwd = String(a?.session?.header?.cwd ?? '')
        if (cwd.endsWith('/home/bili')) return 'bili'
        if (id.startsWith('onebot-')) return 'qq'
        if (id === 'wx-1') return 'wx'
        if (id === 'home-1') return 'web'
        return null
      },
    },
  }
}

const mem = (root, extra = {}) => createMemoryService({ root, core: fakeCore(), ...extra })

async function diskEvents(root) {
  const { events } = await readEvents(root)
  return events
}

// ---------------------------------------------------------------- append 基础

test('append：v4 落盘；opts.surface 必须真的进磁盘（不能被 opts 吞掉）', async () => {
  await withRoot(async (root) => {
    const r = await mem(root).append({ type: 'saw', text: 'B站｜一个视频' }, { surface: 'bili' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.event.v, EVENT_SCHEMA_VERSION)
    assert.equal(r.event.surface, 'bili')
    assert.equal(r.event.channel, 'core', 'B 站公开事实 channel 必须是 core')
    assert.equal(r.event.source, 'system', 'append 默认 source 是 system')

    const [ev] = await diskEvents(root)
    assert.equal(ev.v, EVENT_SCHEMA_VERSION)
    assert.equal(ev.surface, 'bili')
    assert.equal(ev.channel, 'core')
    assert.equal(ev.source, 'system')
  })
})

test('append：没有 agent/opts 时 channel/surface 都是 core', async () => {
  await withRoot(async (root) => {
    const r = await mem(root).append({ type: 'meta', text: '记账' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.event.channel, 'core')
    assert.equal(r.event.surface, 'core')
  })
})

test('append：agent 推断 surface，并映射 channel（qq/wx/web）', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    const qq = await m.append({ type: 'utterance', text: 'qq 里的话' }, { agent: agent('onebot-1') })
    assert.equal(qq.ok, true, JSON.stringify(qq))
    assert.equal(qq.event.surface, 'qq')
    assert.equal(qq.event.channel, 'qq')

    const wx = await m.append({ type: 'utterance', text: '微信里的话' }, { agent: agent('wx-1') })
    assert.equal(wx.ok, true, JSON.stringify(wx))
    assert.equal(wx.event.surface, 'wx')
    assert.equal(wx.event.channel, 'wx')

    const web = await m.append({ type: 'utterance', text: '屋子里的话' }, { agent: agent('home-1') })
    assert.equal(web.ok, true, JSON.stringify(web))
    assert.equal(web.event.surface, 'web')
    assert.equal(web.event.channel, 'web')
  })
})

test('append：B 站 agent（cwd 专属）得到 surface=bili，但 channel 落 core 而不是 web', async () => {
  await withRoot(async (root) => {
    const r = await mem(root).append(
      { type: 'saw', text: 'B站｜视频' },
      { agent: agent('bili-1', join(root, 'home', 'bili')) },
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.event.surface, 'bili')
    assert.equal(r.event.channel, 'core', 'channelOfAgent 对 B 站 cwd 返回 web，必须被 bili→core 规则覆盖')
  })
})

test('append：opts.channel / opts.surface 优先于 agent 推断', async () => {
  await withRoot(async (root) => {
    const r = await mem(root).append(
      { type: 'utterance', text: '强制通道' },
      { agent: agent('onebot-1'), channel: 'wx', surface: 'wx' },
    )
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.event.channel, 'wx')
    assert.equal(r.event.surface, 'wx')
  })
})

test('append：非法类型返回 ok:false 且不抛、不落盘', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    let r
    await assert.doesNotReject(async () => { r = await m.append({ type: 'nope', text: 'x' }) })
    assert.equal(r.ok, false)
    assert.match(r.why, /BAD_TYPE/)
    assert.deepEqual(await diskEvents(root), [])
  })
})

test('append：source:tool 只能写 HER_TYPES；系统侧类型返回 NOT_HER_TYPE 不落盘', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    const bad = await m.append({ type: 'saw', text: 'x' }, { source: 'tool' })
    assert.deepEqual(bad, { ok: false, why: 'NOT_HER_TYPE' })
    assert.deepEqual(await diskEvents(root), [])

    const good = await m.append({ type: 'utterance', text: '她说的' }, { source: 'tool' })
    assert.equal(good.ok, true, JSON.stringify(good))
    assert.equal(good.event.source, 'tool')
  })
})

// ---------------------------------------------------------------- commit / appendSystem

test('commit：source 固定 tool，type 默认 utterance，channel/surface 从 agent 推断', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    const r = await m.commit('一句她自己的话', { agent: agent('onebot-9') })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.event.source, 'tool')
    assert.equal(r.event.type, 'utterance')
    assert.equal(r.event.channel, 'qq')
    assert.equal(r.event.surface, 'qq')

    const bili = await m.commit('在 B 站说的', { agent: agent('bili-2', join(root, 'home', 'bili')) })
    assert.equal(bili.ok, true, JSON.stringify(bili))
    assert.equal(bili.event.channel, 'core')
    assert.equal(bili.event.surface, 'bili')

    const notHer = await m.commit('不能写这个', { type: 'saw' })
    assert.deepEqual(notHer, { ok: false, why: 'NOT_HER_TYPE' })
  })
})

test('appendSystem：source 固定 system，拒绝 HER_TYPES', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    const r = await m.appendSystem('saw', 'B站｜视频', { surface: 'bili' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.event.source, 'system')
    assert.equal(r.event.surface, 'bili')

    for (const t of HER_TYPES) {
      const bad = await m.appendSystem(t, 'x')
      assert.deepEqual(bad, { ok: false, why: 'NOT_SYSTEM_TYPE' }, t)
    }
    assert.equal((await diskEvents(root)).length, 1)
  })
})

test('bili_reply：缺显式 surface 时门面拒绝（不默认 core），显式/agent 可写', async () => {
  await withRoot(async (root) => {
    const m = mem(root)

    const missing = await m.appendSystem('bili_reply', '对方回了', { reply: { bvid: 'BV1', rpid: '9' } })
    assert.deepEqual(missing, { ok: false, why: 'BAD_SURFACE' })
    assert.deepEqual(await diskEvents(root), [], '缺 surface 的 bili_reply 不能落盘')

    const checked = await m.validate({ type: 'bili_reply', text: '先自检', reply: { bvid: 'BV1', rpid: '12' } })
    assert.deepEqual(checked, { ok: false, why: 'BAD_SURFACE' })

    const explicit = await m.appendSystem('bili_reply', '对方回了', {
      surface: 'bili',
      reply: { bvid: 'BV1', rpid: '9' },
    })
    assert.equal(explicit.ok, true, JSON.stringify(explicit))
    assert.equal(explicit.event.surface, 'bili')
    assert.equal(explicit.event.channel, 'core')

    const viaAgent = await m.append(
      { type: 'bili_reply', text: '又回了一条', reply: { bvid: 'BV1', rpid: '10' } },
      { agent: agent('bili-3', join(root, 'home', 'bili')) },
    )
    assert.equal(viaAgent.ok, true, JSON.stringify(viaAgent))
    assert.equal(viaAgent.event.surface, 'bili')

    const viaRaw = await m.append({
      type: 'bili_reply', text: '第三条', surface: 'bili', reply: { bvid: 'BV1', rpid: '11' },
    })
    assert.equal(viaRaw.ok, true, JSON.stringify(viaRaw))
    assert.equal(viaRaw.event.surface, 'bili')
  })
})

// ---------------------------------------------------------------- read

test('read：默认排除 meta，includeMeta 才返回；types/channel/surface 过滤生效', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    await m.appendSystem('meta', 'system 记账')
    await m.appendSystem('saw', 'B站｜视频', { surface: 'bili' })
    await m.append({ type: 'utterance', text: '微信里的话' }, { channel: 'wx', surface: 'wx' })
    await m.appendSystem('voice', '读到一句', { surface: 'core' })

    assert.equal((await m.read()).length, 3, 'meta 默认排除')
    assert.equal((await m.read({ includeMeta: true })).length, 4)

    const saw = await m.read({ types: ['saw'] })
    assert.equal(saw.length, 1)
    assert.equal(saw[0].type, 'saw')

    const wx = await m.read({ channel: 'wx' })
    assert.equal(wx.length, 1)
    assert.equal(wx[0].channel, 'wx')

    const bili = await m.read({ surface: 'bili' })
    assert.equal(bili.length, 1)
    assert.equal(bili[0].surface, 'bili')

    const onlyMeta = await m.read({ types: ['meta'], includeMeta: true })
    assert.equal(onlyMeta.length, 1)
    assert.equal(onlyMeta[0].type, 'meta')
  })
})

test('read：没有 channel 字段的老事件按 core 返回（全仓 `channel ?? core` 约定）', async () => {
  await withRoot(async (root) => {
    const legacy = {
      id: 'ev_LEGACY0000000000000000000',
      type: 'utterance',
      text: '老事件',
      ts: '2026-01-01T00:00:00.000Z',
    }
    await appendFile(paths(root).events, JSON.stringify(legacy) + '\n', 'utf8')

    const m = mem(root)
    const coreRead = await m.read({ channel: 'core' })
    assert.equal(coreRead.length, 1, '没有 channel 的老事件必须算 core，不能被过滤掉')
    assert.equal(coreRead[0].id, legacy.id)
    assert.equal(coreRead[0].channel, 'core', '返回给调用方时补上 channel，不留 undefined')

    assert.deepEqual(await m.read({ channel: 'wx' }), [])
  })
})

test('read：since/until 接受 ISO / Date / epoch，非法值忽略', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    await m.appendSystem('meta', 'meta', { ts: '2026-01-01T00:00:00.000Z' })
    await m.appendSystem('saw', 'B站｜一', { surface: 'bili', ts: '2026-01-02T00:00:00.000Z' })
    await m.append({ type: 'utterance', text: '二', ts: '2026-01-03T00:00:00.000Z' }, { channel: 'wx', surface: 'wx' })
    await m.appendSystem('voice', '三', { ts: '2026-01-04T00:00:00.000Z' })

    assert.deepEqual(
      (await m.read({ since: '2026-01-03T00:00:00.000Z' })).map((e) => e.text),
      ['二', '三'],
    )
    assert.deepEqual(
      (await m.read({ until: new Date('2026-01-02T23:59:59.999Z') })).map((e) => e.text),
      ['B站｜一'],
    )
    assert.deepEqual(
      (await m.read({ since: Date.parse('2026-01-04T00:00:00.000Z') })).map((e) => e.text),
      ['三'],
    )
    assert.equal((await m.read({ since: 'not-a-date' })).length, 3, '非法 since 被忽略')
    assert.equal((await m.read({ until: Number.NaN })).length, 3, 'NaN until 被忽略')
  })
})

test('read：limit 默认 200，夹取 1..2000', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    for (let i = 0; i < 5; i++) await m.appendSystem('voice', `句子${i}`)

    assert.equal((await m.read({ limit: 2 })).length, 2)
    assert.deepEqual((await m.read({ limit: 2 })).map((e) => e.text), ['句子0', '句子1'])
    assert.equal((await m.read({ limit: 0 })).length, 1, '0 夹到 1')
    assert.equal((await m.read({ limit: 99999 })).length, 5, '上限 2000 不丢事件')
    assert.equal((await m.read({ limit: 'nope' })).length, 5, '非法 limit 回默认（事件不足 200）')
  })
})

// ---------------------------------------------------------------- validate / eventById

test('validate：返回校验后的 v4 事件但不落盘；失败返回 ok:false', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    const r = await m.validate({ type: 'utterance', text: '先看看' }, { channel: 'wx', surface: 'wx' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.event.v, EVENT_SCHEMA_VERSION)
    assert.equal(r.event.channel, 'wx')
    assert.equal(r.event.surface, 'wx')
    assert.deepEqual(await diskEvents(root), [], 'validate 不写盘')

    const bad = await m.validate({ type: 'nope', text: 'x' })
    assert.equal(bad.ok, false)
    assert.match(bad.why, /BAD_TYPE/)
    assert.deepEqual(await diskEvents(root), [])
  })
})

test('eventById：命中返回事件，不存在返回 null', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    const r = await m.appendSystem('voice', '一句读到的')
    assert.deepEqual(await m.eventById(r.event.id), r.event)
    assert.equal(await m.eventById('ev_DOESNOTEXIST0000000000000'), null)
    assert.equal(await m.eventById(undefined), null)
  })
})

// ---------------------------------------------------------------- derive / similarity / findEcho

test('derive：转发 now/growthDays/viewSurface 给 deriveSelf', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    await m.appendSystem('seed', '起点')
    const model = await m.derive({ now: Date.now(), growthDays: 30, viewSurface: 'bili' })
    assert.equal(typeof model, 'object')
    assert.ok(model !== null)
    assert.ok(Array.isArray(model.beliefs))
    assert.equal(model.day >= 1, true)
  })
})

test('similarity：透出 similarity.js 的实现', () => {
  const m = mem('/tmp/unused-root')
  assert.equal(m.similarity('一样', '一样'), 1)
  assert.equal(m.similarity('甲', '乙'), 0)
})

test('findEcho：返回近 N 天最相似的 voice/utterance；低于 0.7 或过期返回 null', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-06-01T00:00:00.000Z')
    const m = mem(root)
    await m.appendSystem('voice', '春风吹过湖面', { ts: new Date(now - 86_400_000).toISOString() })
    const exact = await m.append({ type: 'utterance', text: '今天天气真好呀', ts: new Date(now - 3_600_000).toISOString() })
    await m.appendSystem('voice', '今天天气真好呀', { ts: new Date(now - 7_200_000).toISOString() })

    const hit = await m.findEcho('今天天气真好呀', { now })
    assert.equal(hit.id, exact.event.id, '相似度相同时取事件流里更早的那条')

    assert.equal(await m.findEcho('量子力学导论', { now }), null, '低于 ECHO_MIN_SIM')
  })
})

test('findEcho：days 窗口生效；meta 不参与回声', async () => {
  await withRoot(async (root) => {
    const now = Date.parse('2026-06-01T00:00:00.000Z')
    const m = mem(root)
    const old = await m.appendSystem('voice', '今天天气真好呀', {
      ts: new Date(now - 10 * 86_400_000).toISOString(),
    })

    assert.equal(await m.findEcho('今天天气真好呀', { now, days: 7 }), null)
    const found = await m.findEcho('今天天气真好呀', { now, days: 30 })
    assert.equal(found.id, old.event.id)

    await m.appendSystem('meta', '今天天气真好呀', { ts: new Date(now - 60_000).toISOString() })
    const afterMeta = await m.findEcho('完全不同的另外一句', { now, days: 30 })
    assert.equal(afterMeta, null, 'meta 尽管文本相同也不参与')
  })
})

// ---------------------------------------------------------------- refreshSelfDoc

test('refreshSelfDoc：seed/saw/voice/bili_reply/utterance/revise/narration 后刷新，meta 不刷新', async () => {
  await withRoot(async (root) => {
    let calls = 0
    const seenRoots = []
    const m = mem(root, {
      refreshSelfDoc: async (r) => {
        calls++
        seenRoots.push(r)
        return { ok: true, changed: false, file: 'fake' }
      },
    })

    const seed = await m.appendSystem('seed', '起点')
    assert.equal(seed.ok, true, JSON.stringify(seed))
    assert.equal(calls, 1)

    await m.appendSystem('saw', 'B站｜视频', { surface: 'bili' })
    await m.appendSystem('voice', '读到一句')
    await m.append(
      { type: 'bili_reply', text: '对方回了', reply: { bvid: 'BV1', rpid: '2' } },
      { surface: 'bili' },
    )
    await m.append({ type: 'utterance', text: '她说的' })
    await m.append({ type: 'revise', text: '改口', refs: [seed.event.id] })
    await m.append({ type: 'narration', text: '我没想清楚' })
    assert.equal(calls, 7, '七个类型各刷新一次')
    assert.deepEqual(seenRoots, Array(7).fill(root), '注入的刷新函数收到 root')

    await m.appendSystem('meta', '记账')
    await m.appendSystem('diary', '日记')
    assert.equal(calls, 7, 'meta / diary 不触发刷新')
  })
})

test('refreshSelfDoc：未注入时 memory 照常工作，公开方法返回 NO_REFRESH', async () => {
  await withRoot(async (root) => {
    const m = mem(root)
    const r = await m.appendSystem('seed', '起点')
    assert.equal(r.ok, true)
    assert.deepEqual(await m.refreshSelfDoc(), { ok: false, why: 'NO_REFRESH' })
  })
})

test('refreshSelfDoc：刷新失败不影响写入成功，公开方法返回失败原因', async () => {
  await withRoot(async (root) => {
    const m = mem(root, {
      refreshSelfDoc: async () => { throw new Error('磁盘满了') },
    })
    const r = await m.append({ type: 'utterance', text: '她还是写下了' })
    assert.equal(r.ok, true, '刷新失败不能把成功的写入变成失败')
    const refresh = await m.refreshSelfDoc()
    assert.equal(refresh.ok, false)
    assert.match(refresh.why, /磁盘满了/)
  })
})

// ---------------------------------------------------------------- core-service 接线

function fakeCtx() {
  const services = new Map()
  return {
    provide(name, value) { services.set(name, value); return () => services.delete(name) },
    get(name) { return services.get(name) },
  }
}

test('provideFishCore：在同一个 core 对象上挂 memory，并转发 refreshSelfDoc', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    let calls = 0
    const { core, dispose } = provideFishCore(ctx, {
      root,
      herDir: join(root, 'home'),
      refreshSelfDoc: async () => { calls++ },
    })
    try {
      assert.equal(ctx.get('fishCore'), core)
      assert.ok(core.memory, 'core.memory 必须挂上')
      for (const name of [
        'append', 'commit', 'appendSystem', 'validate', 'read',
        'derive', 'refreshSelfDoc', 'similarity', 'findEcho', 'eventById',
      ]) {
        assert.equal(typeof core.memory[name], 'function', name)
      }
      const r = await core.memory.appendSystem('seed', '起点')
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(calls, 1)
    } finally {
      dispose()
    }
  })
})
