/**
 * pet-event-sources.test.mjs —— 桌宠二期真实事实源接线
 *
 * 只覆盖服务端的易失事实：append 观察、live speech 去重、B 站出门起止、
 * 日程窗口休息。桌宠素材选择与触发优先级在 desktop-pet 侧另有测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { wirePetEventSources } from '../lib/index.js'
import { registerCapture } from '../lib/capture.js'
import { registerLetter } from '../lib/letter.js'
import { createMemoryService } from '../lib/memory-service.js'
import { createPetView } from '../lib/pet-view.js'
import { createScheduleHooks } from '../lib/schedule-hooks.js'
import { readEvents } from '../lib/store.js'


function fakeMemory() {
  let observer = null
  return {
    onAppend(fn) {
      observer = fn
      return () => { if (observer === fn) observer = null }
    },
    append(event) { observer?.(event) },
    observerCount() { return observer ? 1 : 0 },
  }
}

function fakeCtx() {
  const handlers = new Set()
  const tools = new Map()
  return {
    on(_name, fn) {
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
    emit(session, event) {
      for (const fn of [...handlers]) fn(session, event)
    },
    listenerCount() { return handlers.size },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    toolsByName: tools,
  }
}


test('growth_commit 的真实持久 utterance 会生成 petView speak cue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-pet-writer-'))
  try {
    const ctx = fakeCtx()
    const core = { surface: { current: () => 'web' } }
    const memory = createMemoryService({ root, core })
    core.memory = memory
    const petView = createPetView({ now: () => 1000 })
    const wiring = wirePetEventSources({
      ctx,
      memory,
      petView,
      surfaceOf: (session) => session?.surface ?? 'web',
      isHerSession: () => true,
    })

    registerCapture(ctx, { root, core, memory })
    const tool = ctx.toolsByName.get('growth_commit')
    const out = await tool.execute(
      { type: 'utterance', text: '这句是从真实写入路径来的' },
      { agent: { session: { header: { id: 'web-real-1' } } } },
    )

    assert.equal(out.ok, true, JSON.stringify(out))
    assert.deepEqual(petView.snapshot().cues, [{
      id: out.id,
      kind: 'speak',
      text: '这句是从真实写入路径来的',
      at: 1000,
      ttlMs: 15_000,
    }])

    wiring.dispose()
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})


test('her_leave 的真实持久 utterance 也会生成 petView speak cue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-pet-letter-writer-'))
  try {
    const ctx = fakeCtx()
    const core = { surface: { current: () => 'web' } }
    const memory = createMemoryService({ root, core })
    core.memory = memory
    const petView = createPetView({ now: () => 1500 })
    const wiring = wirePetEventSources({
      ctx,
      memory,
      petView,
      surfaceOf: (session) => session?.surface ?? 'web',
      isHerSession: () => true,
    })

    registerLetter(ctx, { root, core, memory })
    const tool = ctx.toolsByName.get('her_leave')
    const out = await tool.execute(
      { text: '这句是留给他的，也该出现在桌宠上' },
      { agent: { session: { header: { id: 'web-real-2' } } } },
    )

    assert.equal(out.ok, true, JSON.stringify(out))
    const { events } = await readEvents(root)
    const utterance = events.find((event) => event.type === 'utterance')
    assert.deepEqual(petView.snapshot().cues, [{
      id: utterance.id,
      kind: 'speak',
      text: '这句是留给他的，也该出现在桌宠上',
      at: 1500,
      ttlMs: 15_000,
    }])

    wiring.dispose()
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})


test('bili_reply 落盘后按 event id 生成一条 replied cue', () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  const petView = createPetView({ now: () => 1000 })
  const wiring = wirePetEventSources({ ctx, memory, petView })

  const event = { id: 'ev_reply_1', type: 'bili_reply', text: '有人回了她一句' }
  memory.append(event)
  memory.append(event)

  assert.deepEqual(petView.snapshot().cues, [{
    id: 'ev_reply_1',
    kind: 'replied',
    text: '有人回了她一句',
    at: 1000,
    ttlMs: 15_000,
  }])

  wiring.dispose()
  assert.equal(memory.observerCount(), 0)
  assert.equal(ctx.listenerCount(), 0)
})


test('同一 turn 的 live assistant speech 与 persisted utterance 只生成一条 speak cue', () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  const petView = createPetView({ now: () => 2000 })
  const wiring = wirePetEventSources({
    ctx,
    memory,
    petView,
    surfaceOf: (session) => session?.surface ?? '',
    isHerSession: () => true,
  })
  const session = { header: { id: 'web-1' }, surface: 'web' }

  ctx.emit(session, { type: 'turn/start' })
  assert.equal(petView.snapshot().activity.state, 'thinking', '新事实源接线不能丢原有 activity')
  ctx.emit(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '她刚刚说出口的话' }] } },
  })
  memory.append({ id: 'ev_utterance_1', type: 'utterance', text: '她刚刚说出口的话', surface: 'web' })
  ctx.emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })

  const speaks = petView.snapshot().cues.filter((cue) => cue.kind === 'speak')
  assert.equal(speaks.length, 1)
  assert.equal(speaks[0].text, '她刚刚说出口的话')
  assert.match(speaks[0].id, /^speak:/)

  wiring.dispose()
})


test('没有 live message 时 persisted utterance 直接生成 speak cue', () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  const petView = createPetView({ now: () => 2500 })
  const wiring = wirePetEventSources({ ctx, memory, petView })

  memory.append({ id: 'ev_utterance_2', type: 'utterance', text: '她自己写下来的一句', surface: 'web' })

  assert.deepEqual(petView.snapshot().cues, [{
    id: 'ev_utterance_2',
    kind: 'speak',
    text: '她自己写下来的一句',
    at: 2500,
    ttlMs: 15_000,
  }])

  wiring.dispose()
})


test('同一 turn 先落 utterance 再收到 live message 也只生成一条 speak cue', () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  const petView = createPetView({ now: () => 2600 })
  const wiring = wirePetEventSources({
    ctx,
    memory,
    petView,
    surfaceOf: (session) => session?.surface ?? '',
    isHerSession: () => true,
  })
  const session = { header: { id: 'web-2' }, surface: 'web' }

  ctx.emit(session, { type: 'turn/start' })
  memory.append({ id: 'ev_utterance_3', type: 'utterance', text: '先被记录的话', surface: 'web' })
  ctx.emit(session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '先被记录的话' }] } },
  })

  assert.equal(petView.snapshot().cues.filter((cue) => cue.kind === 'speak').length, 1)
  wiring.dispose()
})


test('连续两个没有 event id 的 turn 不会复用同一个 speak cue id', () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  const petView = createPetView({ now: () => 2700 })
  const wiring = wirePetEventSources({
    ctx,
    memory,
    petView,
    surfaceOf: (session) => session?.surface ?? '',
    isHerSession: () => true,
  })
  const session = { header: { id: 'web-3' }, surface: 'web' }
  const message = (text) => ({
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  })

  ctx.emit(session, { type: 'turn/start' })
  ctx.emit(session, message('第一轮'))
  ctx.emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  ctx.emit(session, { type: 'turn/start' })
  ctx.emit(session, message('第二轮'))

  assert.deepEqual(
    petView.snapshot().cues.filter((cue) => cue.kind === 'speak').map((cue) => cue.text),
    ['第一轮', '第二轮'],
  )
  wiring.dispose()
})


test('B 站 session 的 turn/start 与 turn/end 驱动 outing scene', () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  const petView = createPetView({ now: () => 3000 })
  const wiring = wirePetEventSources({
    ctx,
    memory,
    petView,
    surfaceOf: (session) => session?.surface ?? '',
    isHerSession: () => true,
  })
  const session = { header: { id: 'bili-1' }, surface: 'bili' }

  ctx.emit(session, { type: 'turn/start' })
  assert.deepEqual(petView.snapshot().scene, { kind: 'out', at: 3000 })

  ctx.emit(session, { type: 'assistant/message', data: { message: { content: [] } } })
  assert.deepEqual(petView.snapshot().scene, { kind: 'out', at: 3000 })

  ctx.emit(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(petView.snapshot().scene, null)

  wiring.dispose()
})


test('两个 B 站 session 重叠时，前一个结束不会提前清掉 outing scene', () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  const petView = createPetView({ now: () => 3100 })
  const wiring = wirePetEventSources({
    ctx,
    memory,
    petView,
    surfaceOf: (session) => session?.surface ?? '',
    isHerSession: () => true,
  })
  const first = { header: { id: 'bili-overlap-1' }, surface: 'bili' }
  const second = { header: { id: 'bili-overlap-2' }, surface: 'bili' }

  ctx.emit(first, { type: 'turn/start' })
  ctx.emit(second, { type: 'turn/start' })
  assert.deepEqual(petView.snapshot().scene, { kind: 'out', at: 3100 })

  ctx.emit(first, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.deepEqual(petView.snapshot().scene, { kind: 'out', at: 3100 }, '还有另一条 B 站会话没结束')

  ctx.emit(second, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(petView.snapshot().scene, null, '最后一条 B 站会话结束才出门回家')

  wiring.dispose()
})


test('日程休息只在真实 tick 更新，窗口外 rest、窗口内清除；快照不重算', async () => {
  const memory = fakeMemory()
  const ctx = fakeCtx()
  let now = new Date(2026, 10, 18, 22, 0, 0).getTime()
  const petView = createPetView({ now: () => now })
  const scheduleHooks = createScheduleHooks()
  const wiring = wirePetEventSources({ ctx, memory, petView, scheduleHooks })
  const config = { window: ['08:00', '18:00'] }

  const outside1 = new Date(2026, 10, 18, 22, 0, 0)
  await scheduleHooks.runTick({ now: outside1, config })
  assert.deepEqual(petView.snapshot().scene, { kind: 'rest', at: outside1.getTime() })

  now = new Date(2026, 10, 18, 22, 0, 30).getTime()
  assert.deepEqual(petView.snapshot().scene, { kind: 'rest', at: outside1.getTime() }, '状态组装不能重算 rest')

  const outside2 = new Date(2026, 10, 18, 22, 1, 0)
  await scheduleHooks.runTick({ now: outside2, config })
  assert.deepEqual(petView.snapshot().scene, { kind: 'rest', at: outside2.getTime() }, '下一次真实 tick 才更新')

  const inside = new Date(2026, 10, 19, 12, 0, 0)
  await scheduleHooks.runTick({ now: inside, config })
  assert.equal(petView.snapshot().scene, null, '窗口内 tick 清除 rest')

  wiring.dispose()
  scheduleHooks.dispose()
})


test('桌宠观察器抛错不影响真实 append 成功和事件落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-pet-sources-'))
  try {
    const memory = createMemoryService({ root })
    const ctx = fakeCtx()
    const petView = {
      noteCue() { throw new Error('桌宠状态坏了') },
      setScheduleRest() { throw new Error('日程状态坏了') },
    }
    const wiring = wirePetEventSources({ ctx, memory, petView })

    const result = await memory.append({
      type: 'bili_reply',
      text: '回复仍然要落盘',
      surface: 'bili',
      reply: { bvid: 'BV1', rpid: '42' },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.event.text, '回复仍然要落盘')

    const { events } = await readEvents(root)
    assert.equal(events.length, 1)
    assert.equal(events[0].id, result.event.id)
    assert.equal(events[0].text, '回复仍然要落盘')

    wiring.dispose()
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
