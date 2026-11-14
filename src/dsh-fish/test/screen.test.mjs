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

function makeService(root, { mode = 'event', startOk = true, promptText = '', config = normalizeConfig({}), startAt = '2026-11-13T10:00:00Z', maxRunMs } = {}) {
  let t = Date.parse(startAt)
  const prompts = []
  const comments = []
  const providers = []
  const removed = []
  const instances = []
  const fg = []
  const capture = {
    startFrameStream(o) {
      if (!startOk) throw new Error('no backend')
      instances.push(o)
      return { stop: async () => { o.stopped = true } }
    },
    emit(frame) { return instances.at(-1)?.onFrame?.(frame) },
  }
  const foreground = {
    startForegroundWatcher(o) { fg.push(o); return { stop: async () => { o.stopped = true } } },
    emit(sample) { return fg.at(-1)?.onSample?.(sample) },
  }
  let turnHandler = null
  // 每建一次会话 id 递增，轮换测试才能看出“换成了另一个会话”。
  let seq = 0
  const core = {
    surface: { reserve() {}, current: () => 'screen' },
    sessions: {
      create: async () => ({ sessionId: `s${++seq}` }),
      async prompt(sid, text) {
        prompts.push({ sid, text })
        // 模拟宿主一轮结束：watchTurn 在 prompt 之前注册，下一轮事件循环再发。
        setTimeout(() => {
          if (promptText) {
            turnHandler?.({ header: { id: sid } }, {
              type: 'assistant/message',
              data: { message: { role: 'assistant', content: [{ type: 'text', text: promptText }] } },
            })
          }
          turnHandler?.({ header: { id: sid } }, { type: 'turn/end' })
        }, 0)
      },
    },
    context: {
      provide(id, opts) { providers.push({ id, opts }); return () => {} },
      remove(id) { removed.push(id) },
    },
    config: { get: async () => config },
    on(ev, fn) { if (ev === 'session/event') turnHandler = fn; return () => {} },
  }
  const service = createScreenService({
    root, core, config, capture, foreground,
    now: () => t, dateKey: () => '2026-11-13',
    ...(maxRunMs ? { maxRunMs } : {}),
  })
  return {
    service, prompts, comments, providers, removed, instances, capture, fg, foreground,
    tick: (ms) => { t += ms },
    setMode: (o) => service.setMode(o),
    emitTurnEnd: (sid = 's1') => turnHandler?.({ header: { id: sid } }, { type: 'turn/end' }),
  }
}

test('开着时重启：自动恢复同一模式，起点沿用', async () => {
  await withRoot(async (root) => {
    const first = makeService(root)
    await first.service.setMode({ mode: 'event', on: true })
    assert.equal(first.service.status().on, true)

    const second = makeService(root)
    await new Promise((r) => setTimeout(r, 30))
    const st = second.service.status()
    assert.equal(st.on, true)
    assert.equal(st.mode, 'event')
    assert.equal(st.startedAt, Date.parse('2026-11-13T10:00:00Z'))
    assert.equal(second.instances.length, 1)
  })
})

test('重启时已过 4 小时上限：不再恢复，并记下到点', async () => {
  await withRoot(async (root) => {
    const first = makeService(root)
    await first.service.setMode({ mode: 'ambient', on: true })

    const second = makeService(root, { startAt: '2026-11-13T14:00:01Z' })
    await new Promise((r) => setTimeout(r, 30))
    const st = second.service.status()
    assert.equal(st.on, false)
    assert.equal(st.stopReason, 'max-run')
  })
})

test('手动关闭后重启不恢复，原因留在状态里', async () => {
  await withRoot(async (root) => {
    const first = makeService(root)
    await first.service.setMode({ mode: 'event', on: true })
    await first.service.setMode({ mode: 'event', on: false })

    const second = makeService(root)
    await new Promise((r) => setTimeout(r, 30))
    const st = second.service.status()
    assert.equal(st.on, false)
    assert.equal(st.stopReason, 'manual')
  })
})

test('到点自动停止：上限从本次开启算，停止原因记为 max-run', async () => {
  await withRoot(async (root) => {
    const h = makeService(root, { maxRunMs: 60 })
    await h.service.setMode({ mode: 'event', on: true })
    await new Promise((r) => setTimeout(r, 120))
    const st = h.service.status()
    assert.equal(st.on, false)
    assert.equal(st.stopReason, 'max-run')
  })
})

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

test('她自然说出的那句进 presence 台账与 recent，不算沉默', async () => {
  await withRoot(async (root) => {
    const h = makeService(root, { promptText: '这一下打得漂亮。' })
    await h.service.setMode({ mode: 'event', on: true })
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h.service.status().lastComment, '这一下打得漂亮。')
    assert.equal(h.service.status().recent.at(-1).text, '这一下打得漂亮。')
    const txt = await readFile(join(paths(root).root, 'presence', '2026-11-13.jsonl'), 'utf8')
    assert.match(txt, /这一下打得漂亮/)
    assert.equal(txt.includes('presence_speak'), false)
  })
})

test('画面冻住后不再被 scen 分数反复当成新事件', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    await h.service.setMode({ mode: 'event', on: true })
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    h.emitTurnEnd()
    h.tick(31_000)
    await h.capture.emit({ buf: JPEG, yavg: 40, scene: 2.8, frozen: true })
    assert.equal(h.prompts.length, 1, '冻住的画面不能因为待机动画再送')
    await h.capture.emit({ buf: JPEG, yavg: 40, frozen: true, event: 'settlement' })
    assert.equal(h.prompts.length, 2, '刚冻住那一帧可以说一次')
  })
})

test('正常停止后重启不再补写同一条 presence 汇总', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    await h.service.setMode({ mode: 'event', on: true })
    await h.service.setMode({ mode: 'event', on: false })
    makeService(root)
    await new Promise((r) => setTimeout(r, 20))
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => /^presence:/.test(String(e.text))).length, 1)
  })
})

test('评论达到每小时上限后不再递新候选（自然文本也要受上限约束）', async () => {
  await withRoot(async (root) => {
    const cfg = normalizeConfig({ presence: { event: { maxCommentsPerHour: 1 } } })
    const h = makeService(root, { config: cfg, promptText: '说一句。' })
    await h.service.setMode({ mode: 'event', on: true })
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(h.prompts.length, 1)
    h.tick(31_000)
    await h.capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change' })
    assert.equal(h.prompts.length, 1, '一小时只说一句，第二帧不再递')
  })
})

test('work 模式只看前台白名单窗口：deny 立即停，allow 才按矩形裁剪', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    await h.service.setMode({ mode: 'work', on: true })
    assert.equal(h.fg.length, 1, 'work 模式先挂前台 watcher')
    assert.equal(h.instances.length, 0, '还没确认前台，不启动抓帧')

    const monitors = [{ x: 0, y: 0, w: 2560, h: 1600 }]
    h.foreground.emit({ name: 'Weixin.exe', rect: { left: 0, top: 0, right: 500, bottom: 400 }, monitors })
    assert.equal(h.instances.length, 0, 'denylist 永远不采集')
    assert.ok(h.removed.includes('screen-activity'), '切到非白名单要移除 provider')

    h.foreground.emit({ name: 'Code.exe', rect: { left: 100, top: 120, right: 1000, bottom: 720 }, monitors })
    assert.equal(h.instances.length, 1)
    assert.deepEqual(h.instances[0].crop, { w: 900, h: 600, x: 100, y: 120 })
    assert.equal(h.instances[0].outputIdx, 0)
    const first = h.instances[0]

    h.foreground.emit({ name: 'Code.exe', rect: { left: 100, top: 120, right: 1000, bottom: 720 }, monitors })
    assert.equal(h.instances.length, 1, '矩形没变不重启抓帧')

    h.foreground.emit({ name: 'Code.exe', rect: { left: 0, top: 0, right: 1200, bottom: 800 }, monitors })
    assert.equal(first.stopped, true, '窗口变化先停旧进程')
    assert.equal(h.instances.length, 2)
  })
})

test('work 模式没有前台探测时明确失败，不留半启动状态', async () => {
  await withRoot(async (root) => {
    const h = makeService(root)
    const service = createScreenService({
      root,
      core: { config: { get: () => normalizeConfig({}) } },
      config: normalizeConfig({}),
      capture: h.capture,
      foreground: {},
      now: () => Date.parse('2026-11-13T10:00:00Z'),
      dateKey: () => '2026-11-13',
    })
    const r = await service.setMode({ mode: 'work', on: true })
    assert.equal(r.ok, false)
    assert.match(r.note, /看不了/)
    assert.equal(service.status().on, false)
  })
})

test('对话轮次也计入轮换：评论 0 + 对话到阈值就换会话', async () => {
  await withRoot(async (root) => {
    const h = makeService(root, { config: normalizeConfig({ presence: { rotateAfter: 2 } }) })
    await h.service.setMode({ mode: 'event', on: true })
    const first = h.service.status().sessionId
    await h.service.noteChatTurn()
    assert.equal(h.service.status().sessionId, first)
    await h.service.noteChatTurn()
    assert.notEqual(h.service.status().sessionId, first)
    assert.equal(h.service.companionInfo().chatTurns, 0)
  })
})

test('手动换一条：新会话从零开始，轮换计数与最近评论一起清空', async () => {
  await withRoot(async (root) => {
    const h = makeService(root, { config: normalizeConfig({ presence: { rotateAfter: 30 } }) })
    await h.service.setMode({ mode: 'event', on: true })
    const first = h.service.status().sessionId
    await h.service.noteChatTurn()
    await h.service.recordComment({ text: '这一下有点意思。', at: '2026-11-13T10:00:00Z', mode: 'event' })
    assert.equal(h.service.companionInfo().chatTurns, 1)
    assert.equal(h.service.companionInfo().sessionComments, 1)
    assert.ok(h.service.status().recent.length > 0, '先有最近评论可清')

    const next = await h.service.rotateSession()
    assert.notEqual(next, first)
    assert.equal(h.service.companionInfo().sessionId, next)
    assert.equal(h.service.companionInfo().chatTurns, 0, '新会话不能继承上一会话的对话轮次')
    assert.equal(h.service.companionInfo().sessionComments, 0)
    assert.deepEqual(h.service.status().recent, [], '新会话不显示上一会话的评论')
  })
})
