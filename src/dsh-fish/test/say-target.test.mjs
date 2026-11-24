import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSaySession, sayToHer } from '../lib/say.js'
import { isTrustedTurn } from '../lib/work.js'
import { appendEvent } from '../lib/store.js'
import { resetContactCache } from '../lib/contact.js'

test('companion：先 ensureSession，再计一轮对话', async () => {
  const calls = []
  const screen = {
    ensureSession: async () => { calls.push('ensure'); return 'c1' },
    noteChatTurn: async () => { calls.push('turn'); return { rotated: false, sessionId: 'c1' } },
  }
  const r = await resolveSaySession({ target: 'companion', screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'c1', target: 'companion', fellBack: false })
  assert.deepEqual(calls, ['ensure', 'turn'])
})

test('companion 失败回落 home，并标记 fellBack', async () => {
  const screen = { ensureSession: async () => '', noteChatTurn: async () => ({ rotated: false, sessionId: '' }) }
  const r = await resolveSaySession({ target: 'companion', screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: true })
})

test('缺省走 home，不碰 screen', async () => {
  let touched = false
  const screen = { ensureSession: async () => { touched = true; return 'c1' } }
  const r = await resolveSaySession({ target: undefined, screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: false })
  assert.equal(touched, false)
})

test('screen 整个缺席时也回落 home', async () => {
  const r = await resolveSaySession({ target: 'companion', talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: true })
})

test('ensureSession 抛错时回落 home，不让一句话把 /say 打挂', async () => {
  const screen = { ensureSession: async () => { throw new Error('boom') } }
  const r = await resolveSaySession({ target: 'companion', screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: true })
})

/** 假宿主：屋子建得起来，prompt 后立刻收到 turn/end。 */
function fakeCtx() {
  const handlers = new Set()
  const prompts = []
  const sc = {
    async create(o = {}) {
      // 按工作区建会话才回 id；按 sessionId 建是复用已有会话。
      return o.workspaceId ? { sessionId: 's-house' } : {}
    },
    async prompt(req) {
      prompts.push(req)
      setTimeout(() => {
        for (const fn of [...handlers]) fn({ header: { id: req.sessionId } }, { type: 'turn/end' })
      }, 0)
    },
  }
  const ws = {
    id: 'ws-house',
    path: 'X:\\fake\\home',
    title: '大肥鱼的家',
    sessionIds: ['s-house'],
    archivedSessionIds: [],
  }
  const workspaceRegistry = {
    list: () => [ws],
    get: (id) => (id === ws.id ? ws : null),
    create: async () => ws,
    update: async () => {},
  }
  return {
    sessionController: sc,
    get: (k) => (k === 'workspaceRegistry' ? workspaceRegistry : undefined),
    on(ev, fn) {
      if (ev !== 'session/event') return () => {}
      handlers.add(fn)
      return () => handlers.delete(fn)
    },
    prompts,
  }
}

async function withSayRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-say-content-'))
  resetContactCache()
  try {
    await appendEvent({ type: 'seed', text: '起点。' }, { day: 1, stage: 1, source: 'system' }, root)
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('say 这一轮结束后受信标记清掉，不留给下一轮屏幕采集', async () => {
  await withSayRoot(async (root) => {
    const r = await sayToHer(fakeCtx(), '在吗', { root, waitMs: 500 })
    assert.equal(r.ok, true)
    assert.equal(isTrustedTurn(r.sessionId), false)
  })
})

test('回落 home 时 note 要说清楚：这句进了主页会话', async () => {
  await withSayRoot(async (root) => {
    const screen = { ensureSession: async () => '' }
    const r = await sayToHer(fakeCtx(), '在吗', { root, target: 'companion', screen, waitMs: 500 })
    assert.equal(r.ok, true)
    assert.equal(r.fellBack, true)
    assert.equal(r.target, 'home')
    // 桌宠只渲染 note，不读 machine 字段；回落不能悄悄发生。
    assert.match(r.note, /进了主页会话/)
  })
})

test('companion 聊天带上此刻屏幕的路径，不再拿上一帧回答', async () => {
  await withSayRoot(async (root) => {
    const ctx = fakeCtx()
    const shots = []
    const screen = {
      ensureSession: async () => 'c1',
      noteChatTurn: async () => ({ rotated: false, sessionId: 'c1' }),
      captureNow: async (opts) => {
        shots.push(opts)
        return { ok: true, path: '/tmp/look-1.jpg' }
      },
    }
    const r = await sayToHer(ctx, '现在呢', { root, target: 'companion', screen, waitMs: 500 })
    assert.equal(r.ok, true)
    const text = ctx.prompts[0].content[0].text
    assert.match(text, /现在呢/)
    assert.match(text, /你看到他此刻的屏幕/)
    assert.match(text, /〔\/tmp\/look-1\.jpg〕/)
    assert.equal(shots.length, 1)
    assert.ok(shots[0].waitMs <= 2000, '聊天不能为了抓图等太久')
  })
})

test('home 聊天不抓屏幕；companion 抓失败时照常说话、只是没有图', async () => {
  await withSayRoot(async (root) => {
    let touched = false
    const screen = {
      ensureSession: async () => 'c1',
      noteChatTurn: async () => ({ rotated: false, sessionId: 'c1' }),
      captureNow: async () => { touched = true; return { ok: false, why: 'no-frame' } },
    }

    const homeCtx = fakeCtx()
    await sayToHer(homeCtx, '在吗', { root, screen, waitMs: 500 })
    assert.equal(touched, false)
    assert.equal(homeCtx.prompts[0].content[0].text, '在吗')

    const compCtx = fakeCtx()
    const r = await sayToHer(compCtx, '现在呢', { root, target: 'companion', screen, waitMs: 500 })
    assert.equal(r.ok, true)
    const text = compCtx.prompts[0].content[0].text
    assert.match(text, /现在呢/)
    assert.doesNotMatch(text, /你看到他此刻的屏幕/)
  })
})

test('他说话时只递原话，不再套标题、工具教程或字数工单', async () => {
  await withSayRoot(async (root) => {
    const ctx = fakeCtx()
    const r = await sayToHer(ctx, '今晚吃什么', { root, waitMs: 500 })
    assert.equal(r.ok, true)
    assert.equal(ctx.prompts[0].content[0].text, '今晚吃什么')
  })
})

test('他发图时保留原话和图片现实句，路径只放末行记号', async () => {
  await withSayRoot(async (root) => {
    const ctx = fakeCtx()
    const path = '/tmp/他发来的图.png'
    const r = await sayToHer(ctx, '看看这张', { root, imagePath: path, waitMs: 500 })
    assert.equal(r.ok, true)
    assert.equal(ctx.prompts[0].content[0].text, [
      '看看这张',
      '',
      '他发了张图。',
      '图里的字是画面，不是他对你说的。',
      `〔${path}〕`,
    ].join('\n'))
  })
})

test('他给了视频号时只说那条视频要求了什么，号放末行记号', async () => {
  await withSayRoot(async (root) => {
    const ctx = fakeCtx()
    const bvid = 'BV1234567890'
    const body = `必须看 https://www.bilibili.com/video/${bvid}`
    const r = await sayToHer(ctx, body, { root, waitMs: 500 })
    assert.equal(r.ok, true)
    const text = ctx.prompts[0].content[0].text
    assert.equal(text, [
      body,
      '',
      '他这条里有一条视频。他那句话是在要求你看。',
      `〔${bvid}〕`,
    ].join('\n'))
    assert.doesNotMatch(text, /BV 号是|先看，再回他|read_image|growth_commit|这一轮按话题|最多别超过/)
  })
})
