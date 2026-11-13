import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScreenService, renderActivity } from '../lib/screen.js'
import { readEvents, paths, writeConfig } from '../lib/store.js'
import { normalizeConfig } from '../lib/settings.js'

// sniffMime 认 ff d8 ff；后面填充只是撑到“不是过小帧”的阈值。
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(9000, 1)])

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-screen-'))
  try {
    await mkdir(join(root, 'home', 'screen'), { recursive: true })
    await writeConfig(normalizeConfig({}), root)
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function makeService(root, { mode = 'event', startOk = true } = {}) {
  let t = Date.parse('2026-11-13T10:00:00Z')
  const prompts = []
  const comments = []
  const providers = []
  const instances = []
  const capture = {
    startFrameStream(o) {
      if (!startOk) throw new Error('no backend')
      instances.push(o)
      return { stop: async () => { o.stopped = true } }
    },
    emit(frame) { return instances.at(-1)?.onFrame?.(frame) },
  }
  let turnHandler = null
  const core = {
    surface: { reserve() {}, current: () => 'screen' },
    sessions: {
      create: async () => ({ sessionId: 's1' }),
      async prompt(sid, text) {
        prompts.push({ sid, text })
        // 模拟宿主一轮结束：watchTurnEnd 在 prompt 之前注册，下一轮事件循环再发。
        setTimeout(() => turnHandler?.({ header: { id: sid } }, { type: 'turn/end' }), 0)
      },
    },
    context: {
      provide(id, opts) { providers.push({ id, opts }); return () => {} },
      remove() {},
    },
    config: { get: () => normalizeConfig({}) },
    on(ev, fn) { if (ev === 'session/event') turnHandler = fn; return () => {} },
  }
  const service = createScreenService({
    root, core, config: normalizeConfig({}), capture,
    now: () => t, dateKey: () => '2026-11-13',
  })
  return {
    service, prompts, comments, providers, instances, capture,
    tick: (ms) => { t += ms },
    setMode: (o) => service.setMode(o),
    emitTurnEnd: (sid = 's1') => turnHandler?.({ header: { id: sid } }, { type: 'turn/end' }),
  }
}

test('event 模式启动采集与 provider，关闭写汇总', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    const on = await h.service.setMode({ mode: 'event', on: true })
    assert.equal(on.ok, true)
    assert.equal(h.instances.length, 1)
    assert.equal(h.providers[0].id, 'screen-activity')
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    assert.ok(h.service.status().lastCandidateAt > 0, '候选帧必须过闸门')
    assert.equal(h.prompts.length, 1)
    await h.service.setMode({ mode: 'event', on: false })
    assert.equal(h.instances[0].stopped, true)
    const { events } = await readEvents(root)
    assert.ok(events.some((e) => /^presence:2026-11-13:event:1:0$/.test(String(e.text))))
  })
})

test('候选冷却：30 秒内第二帧不再 prompt', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    await h.service.setMode({ mode: 'event', on: true })
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    h.emitTurnEnd()
    assert.equal(h.service.status().busy, false, 'turn/end 后不再 busy')
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    assert.equal(h.prompts.length, 1)
    h.tick(31_000)
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    assert.equal(h.prompts.length, 2)
  })
})

test('黑帧不送模型；没有采集后端明确失败', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    await h.service.setMode({ mode: 'event', on: true })
    await h.capture.emit({ buf: JPEG, yavg: 0, event: 'scene_change' })
    assert.equal(h.prompts.length, 0)
    const bad = makeService(root, { startOk: false })
    const r = await bad.service.setMode({ mode: 'event', on: true })
    assert.equal(r.ok, false)
    assert.match(r.note, /看不了/)
  })
})

test('presence_speak 台账写入 presence/YYYY-MM-DD.jsonl', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    await h.service.setMode({ mode: 'event', on: true })
    const r = await h.service.recordComment({ text: '这一下有点意思。', at: '2026-11-13T10:00:00Z', mode: 'event', event: 'scene_change' })
    assert.equal(r.ok, true)
    const txt = await readFile(join(paths(root).root, 'presence', '2026-11-13.jsonl'), 'utf8')
    assert.match(txt, /这一下有点意思/)
    assert.match(txt, /scene_change/)
  })
})

test('renderActivity 只给通用句子，不带标题/游戏名', () => {
  assert.equal(renderActivity({ app: 'game', event: 'end' }), '他刚结束一局。')
  assert.equal(renderActivity({ app: 'work' }), '他在电脑前做事。')
  assert.equal(renderActivity(null), '')
})
