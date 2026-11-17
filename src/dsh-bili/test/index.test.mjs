/**
 * index.test.mjs —— 生产路径把 B 站面挂齐（A2）
 *
 * 钉住五件事：工具、策略表贡献、调度钩子、bili 面提示段、`bili` 服务与路由。
 * 假宿主只实现窄接口，不联网、不碰真实状态库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { renderMaterial } from '../lib/browse.js'
import * as watchModule from '../lib/watch.js'
import { fakeCore, fakeHost, fakeSessions, fakeWorkspaces } from './helpers.mjs'

const BV_ONE = 'BV1xx411c7mD'
const BV_TWO = 'BV1yy411c7mE'

async function boot({ config = { browse: { enabled: true }, comment: { enabled: false } }, events = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-index-'))
  const { core, calls } = fakeCore({ config, events })
  const ctx = fakeHost({
    core,
    tools: ['bili_look', 'bili_watch', 'bili_speak'],
    services: {
      sessionController: fakeSessions(),
      workspaceRegistry: fakeWorkspaces(),
    },
  })
  const handle = apply(ctx, { root })
  const deadline = Date.now() + 3000
  while (!ctx.provided.has('bili') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
  return { root, core, calls, ctx, handle }
}

function registered(ctx, name) {
  return ctx.registered.find((tool) => tool.name === name)
}

test('注册 3 个 B 站工具，并只为自己担保贡献策略表', async () => {
  const { ctx, calls, handle } = await boot()
  try {
    assert.deepEqual(ctx.registered.map((d) => d.name).sort(), ['bili_look', 'bili_speak', 'bili_watch'])
    assert.equal(calls.contributions.length, 1)
    assert.equal(calls.contributions[0].def.id, 'bili')
    assert.deepEqual(calls.contributions[0].def.tools.map((t) => t.name).sort(), ['bili_look', 'bili_speak', 'bili_watch'])
  } finally { handle.dispose() }
})

test('往同一张 core.schedule 表挂刷站与醒来素材两个钩子', async () => {
  const { core, handle } = await boot()
  try {
    const st = core.schedule.status()
    assert.ok(st.tick.some((x) => x.id === 'bili-browse'), '刷站/出门 tick 钩子没挂上')
    assert.ok(st.wake.some((x) => x.id === 'bili-material'), '醒来素材 wake 钩子没挂上')
  } finally { handle.dispose() }
})

test('提示段只挂 bili 面，内容随配置与最近刷到的变化', async () => {
  const events = [
    { type: 'saw', ts: '2026-11-12T10:00:00Z', text: '看到一条测试视频' },
  ]
  const { calls, handle } = await boot({ events })
  try {
    assert.equal(calls.sections.length, 1)
    const sec = calls.sections[0]
    assert.equal(sec.id, 'fish:bili')
    assert.equal(sec.surface, 'bili')
    const text = sec.render()
    assert.match(text, /## 上网/)
    assert.match(text, /在外面可以自己翻/)
    assert.match(text, /## 我最近刷到的/)
    assert.match(text, /看到一条测试视频/)
    assert.doesNotMatch(text, /## 在网上说话/, '评论关着时不该出现说话段')
  } finally { handle.dispose() }
})

test('Bili 面不再自我介绍成 AI，也不教参数', async () => {
  const { calls, handle } = await boot({
    config: { browse: { enabled: true }, comment: { enabled: true } },
    events: [{ type: 'saw', ts: '2026-11-12T10:00:00Z', text: '看到一条测试视频' }],
  })
  try {
    const text = calls.sections[0].render()
    assert.doesNotMatch(text, /你是\s*ai/i)
    assert.doesNotMatch(text, /bili_look|bili_speak|her_recall|what=|keyword=|bvid=|kind=|parentRpid|growth_commit|subagent|shell/)
    assert.match(text, /画面要是在玩生成图、假人说话的梗，可以眨一下/)
  } finally { handle.dispose() }
})

test('Bili 工具说明只留能力和边界，参数结构不变', async () => {
  const { ctx, handle } = await boot()
  try {
    const look = registered(ctx, 'bili_look')
    const watch = registered(ctx, 'bili_watch')
    const speak = registered(ctx, 'bili_speak')

    for (const text of [
      look.description,
      watch.description,
      speak.description,
      look.output.schema.properties.text.description,
      watch.output.schema.properties.path.description,
      ...Object.values(look.parameters.properties).map((x) => x.description),
      ...Object.values(watch.parameters.properties).map((x) => x.description),
      ...Object.values(speak.parameters.properties).map((x) => x.description),
    ]) {
      assert.doesNotMatch(text, /what=|kind=|bvid=|parentRpid|read_image|拼好的图|形如|帧数|取帧|工具手册|参数教程/)
    }

    assert.deepEqual(Object.keys(look.parameters.properties), ['what', 'keyword', 'bvid'])
    assert.deepEqual(look.parameters.required, ['what'])
    assert.deepEqual(look.parameters.properties.what.enum, ['home', 'search', 'related'])
    assert.deepEqual(Object.keys(watch.parameters.properties), ['bvid'])
    assert.deepEqual(watch.parameters.required, ['bvid'])
    assert.deepEqual(Object.keys(speak.parameters.properties), ['kind', 'bvid', 'text', 'parentRpid'])
    assert.deepEqual(speak.parameters.required, ['kind', 'bvid', 'text'])
    assert.deepEqual(speak.parameters.properties.kind.enum, ['comment', 'reply'])
  } finally { handle.dispose() }
})

test('bili_speak 成功只报发出去了，不回显原话', async () => {
  const { ctx, handle } = await boot()
  try {
    const speak = registered(ctx, 'bili_speak')
    const written = '这条视频里的钟声挺有意思'
    const blocks = speak.output.render({ text: written }, { ok: true, said: written, note: '说出去了。' })
    assert.equal(blocks[0].text, '[发出去了]')
    assert.equal(blocks[0].text.includes(written), false)
  } finally { handle.dispose() }
})

test('bili_speak 文本不一致只说不一样，不复述实际文本', async () => {
  const { ctx, handle } = await boot()
  try {
    const speak = registered(ctx, 'bili_speak')
    const written = '这条视频里的钟声挺有意思'
    const actual = '@测试 这条视频里的钟声挺有意思'
    const blocks = speak.output.render({ text: written }, { ok: true, said: actual, note: '说出去了。' })
    assert.equal(blocks[0].text, '[发出去的和你写的不完全一样]')
    assert.equal(blocks[0].text.includes(written), false)
    assert.equal(blocks[0].text.includes(actual), false)
  } finally { handle.dispose() }
})

test('bili_look 失败投影是方括号世界状态', async () => {
  const { ctx, handle } = await boot({ config: { browse: { enabled: false } } })
  try {
    const look = registered(ctx, 'bili_look')
    const out = await look.execute({ what: 'home' })
    const blocks = look.output.render({ what: 'home' }, out)
    assert.equal(blocks[0].text, '[没翻到：现在打不开]')
    assert.equal(blocks[0].text.includes('这次没看到什么'), false)
  } finally { handle.dispose() }
})

test('bili_look 保留素材，BV 只放在末行记号', () => {
  const packs = [
    {
      video: { bvid: BV_ONE, title: '夜里修好的钟', up: '阿明', duration: 183, view: 120000 },
      desc: '一双手把停了很多年的钟重新拨动。',
      pubdate: 1760000000,
      tags: ['手作', '修复'],
      comments: [{ text: '最后那一下真好听。', like: 88 }],
      danmaku: [{ t: 65, text: '听见了' }],
    },
    {
      video: { bvid: BV_TWO, title: '雨天煮面', up: '小李', duration: 420, view: 3000 },
      desc: '窗外下雨，锅里一直冒热气。',
      pubdate: 1760100000,
      tags: ['做饭'],
      comments: [{ text: '看饿了。', like: 12 }],
      danmaku: [{ t: 30, text: '热乎' }],
    },
  ]
  const text = renderMaterial(packs)
  const lines = text.trimEnd().split('\n')
  assert.equal(lines.at(-1), `〔1 ${BV_ONE}〕〔2 ${BV_TWO}〕`)
  const body = lines.slice(0, -1).join('\n')
  assert.match(body, /夜里修好的钟/)
  assert.match(body, /传的人：阿明/)
  assert.match(body, /一双手把停了很多年的钟重新拨动/)
  assert.match(body, /最后那一下真好听/)
  assert.match(body, /听见了/)
  assert.doesNotMatch(body, /https?:\/\//)
  assert.doesNotMatch(body, /播放/)
  assert.equal(body.includes('12.0万'), false)
  assert.equal(body.includes('[热评 88]'), false)
  assert.equal(body.includes(BV_ONE), false)
  assert.equal(body.includes(BV_TWO), false)
})

test('bili_watch 保留画面文字，不报帧数、URL、播放量或 BV 正文', () => {
  const text = watchModule.formatWatchSuccess({
    title: '夜里修好的钟',
    body: '先把门关上\n十二点以后再拨',
    path: '/tmp/bili-sheet.png',
    recognized: true,
  })
  const lines = text.trimEnd().split('\n')
  assert.equal(lines.at(-1), '〔/tmp/bili-sheet.png〕')
  const body = lines.slice(0, -1).join('\n')
  assert.match(body, /^\[画面\]/)
  assert.match(body, /先把门关上/)
  assert.match(body, /十二点以后再拨/)
  assert.doesNotMatch(body, /帧|播放|https?:|BV/)
  assert.equal(body.includes('/tmp/bili-sheet.png'), false)
})

test('bili_watch 只能看画面时把路径放末行记号', () => {
  const text = watchModule.formatWatchSuccess({
    title: '夜里修好的钟',
    path: '/tmp/bili-sheet.png',
    recognized: false,
  })
  const lines = text.trimEnd().split('\n')
  assert.equal(lines.at(-1), '〔/tmp/bili-sheet.png〕')
  const body = lines.slice(0, -1).join('\n')
  assert.match(body, /^\[画面\]/)
  assert.match(body, /画面在手边/)
  assert.doesNotMatch(body, /帧|播放|https?:|BV|取帧/)
  assert.equal(body.includes('/tmp/bili-sheet.png'), false)
})

test('bili_watch 认不出字时只说没读出字', () => {
  const text = watchModule.formatWatchSuccess({
    title: '夜里修好的钟',
    body: '',
    path: '/tmp/bili-sheet.png',
    recognized: true,
  })
  assert.match(text, /\[只看到画面，没读出字\]/)
  assert.doesNotMatch(text, /帧/)
})

test('bili_watch 失败投影区分配额与配置关闭', async () => {
  const cases = [
    [{ browse: { enabled: false } }, '[没看成：现在打不开]', 'browse disabled'],
    [{ browse: { enabled: true }, video: { enabled: false } }, '[没看成：现在看不了画面]', 'video disabled'],
    [{ browse: { enabled: true }, video: { enabled: true, perDay: 0 } }, '[今天不想再看画面了]', 'quota'],
  ]
  for (const [config, want, label] of cases) {
    const { ctx, handle } = await boot({ config })
    try {
      const watch = registered(ctx, 'bili_watch')
      const out = await watch.execute({ bvid: BV_ONE })
      const blocks = watch.output.render({ bvid: BV_ONE }, out)
      assert.equal(blocks[0].text, want, label)
      assert.equal(blocks[0].text.includes('这次没看成'), false, label)
    } finally {
      handle.dispose()
    }
  }
})

test('bili_watch 其他失败也用方括号状态', async () => {
  const { ctx, handle } = await boot()
  try {
    const watch = registered(ctx, 'bili_watch')
    const blocks = watch.output.render(
      { bvid: BV_ONE },
      { ok: false, path: '', text: '', note: '拿不到播放地址。' },
    )
    assert.equal(blocks[0].text, '[没看成：拿不到播放地址]')
  } finally { handle.dispose() }
})

test('provide bili 服务并注册 /dsh-bili 前缀路由', async () => {
  const { ctx, handle } = await boot()
  try {
    assert.ok(ctx.provided.get('bili'), 'bili 服务必须 provide')
    const paths = ctx.routes.map((r) => r.path)
    for (const p of ['/status', '/browse', '/history', '/footprint', '/comment-body', '/comment', '/risk', '/cover', '/sheet', '/ledger', '/outings']) {
      assert.ok(paths.some((x) => x === `/dsh-bili${p}`), `缺路由 ${p}`)
    }
  } finally { handle.dispose() }
})

test('建/复用出门会话并落 bili-session.json', async () => {
  const { root, handle } = await boot()
  try {
    const saved = JSON.parse(await readFile(join(root, 'bili-session.json'), 'utf8'))
    assert.equal(saved.wsId, 'ws-bili')
    assert.equal(saved.title, '去 B 站')
    assert.ok(saved.sessionId)
  } finally { handle.dispose() }
})

test('dispose 停掉一切：钩子、服务、定时器都不再活动', async () => {
  const { core, ctx, handle } = await boot()
  handle.dispose()
  // dispose 是异步 abort 后立刻返回；给 boot 一点时间收尾。
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(!core.schedule.status().tick.some((x) => x.id === 'bili-browse'))
  assert.ok(!core.schedule.status().wake.some((x) => x.id === 'bili-material'))
  assert.ok(!ctx.provided.has('bili'))
})
