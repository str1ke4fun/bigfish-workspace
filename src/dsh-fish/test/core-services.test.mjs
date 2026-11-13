/**
 * core-services.test.mjs —— `fishCore.config / owner / toolLedger / self`（A1.7）
 *
 * 守的是四组接口的边界：
 *   1. config：只走白名单、persona 永不可改、bili 命名空间与顶层键双读一致；
 *   2. owner：read 不含 cookie，credentials 在进程内可用但 JSON/字符串化脱敏；
 *   3. toolLedger：只读、按日期/会话/工具过滤，artifact 不能穿越目录；
 *   4. self：身份文本只读，refresh 走 memory 的同一份实现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { provideFishCore } from '../lib/core-service.js'
import { paths, writeOwner } from '../lib/store.js'

async function withCore(fn, opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'fish-core-'))
  const ctx = {
    services: new Map(),
    provide(name, value) { this.services.set(name, value); return () => this.services.delete(name) },
    get(name) { return this.services.get(name) },
  }
  const { core, dispose } = provideFishCore(ctx, {
    root,
    herDir: join(root, 'home'),
    identityText: () => '她的身份',
    refreshSelfDoc: async () => ({ ok: true }),
    ...opts,
  })
  try {
    return await fn({ core, root, ctx })
  } finally {
    dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

// ---- config ----

test('config.patch 拒绝 persona，且不改动磁盘配置', async () => {
  await withCore(async ({ core, root }) => {
    const before = await core.config.get()
    const r = await core.config.patch({ persona: { imported: true } })
    assert.equal(r.ok, false)
    assert.equal(r.why, 'PERSONA_READONLY')
    const after = await core.config.get()
    assert.deepEqual(after.persona, before.persona)
    assert.equal(await import('node:fs/promises').then(({ readFile }) => readFile(paths(root).config, 'utf8').catch(() => '')), '')
  })
})

test('config.patch 走 bili 命名空间，顶层与视图双读一致', async () => {
  await withCore(async ({ core }) => {
    const r = await core.config.patch({ bili: { browse: { perDay: 2 } } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.config.browse.perDay, 2)

    const top = await core.config.get()
    const view = await core.config.getView('bili')
    assert.equal(top.browse.perDay, 2)
    assert.equal(view.browse.perDay, 2)
    // 两次读各自 load 一次配置，值必须一致，但不承诺同一个对象引用。
    assert.deepEqual(view.browse, top.browse)
    assert.deepEqual(Object.keys(view).sort(), ['avoid', 'browse', 'comment', 'video'])
    assert.equal(await core.config.getView('nope'), null)
  })
})

test('config.patch 未知键整次拒绝，坏值按 LIMITS / 布尔归一', async () => {
  await withCore(async ({ core }) => {
    const bad = await core.config.patch({ nope: 1 })
    assert.equal(bad.ok, false)
    assert.equal(bad.why, 'UNKNOWN_KEY')

    const r = await core.config.patch({
      bili: { browse: { rankingTids: 99, keywords: ['a', 'a', ' b '] }, video: { enabled: 'yes', ocr: 0 } },
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.config.browse.rankingTids, 4, 'rankingTids 必须被 LIMITS 夹到 4')
    assert.deepEqual(r.config.browse.keywords, ['a', 'b'])
    assert.equal(r.config.video.enabled, true)
    assert.equal(r.config.video.ocr, false)
  })
})

test('config.onChange 收到变更键，off 之后不再触发', async () => {
  await withCore(async ({ core }) => {
    const seen = []
    const off = core.config.onChange((e) => seen.push(e))
    await core.config.patch({ bili: { comment: { perDay: 2 } } })
    assert.equal(seen.length, 1)
    assert.deepEqual(seen[0].changedKeys, ['comment'])
    assert.equal(seen[0].config.comment.perDay, 2)
    off()
    await core.config.patch({ bili: { comment: { perDay: 3 } } })
    assert.equal(seen.length, 1)
  })
})

// ---- owner ----

test('owner.read 不含 cookie；credentials 进程内可用但序列化脱敏', async () => {
  await withCore(async ({ core, root }) => {
    await writeOwner({ mid: '42', nickname: '阿鱼', cookie: 'SESSDATA=abc; bili_jct=csrf' }, root)

    const pub = await core.owner.read()
    assert.equal(pub.mid, '42')
    assert.equal(pub.hasCookie, true)
    assert.equal(pub.hasCsrf, true)
    assert.ok(!JSON.stringify(pub).includes('SESSDATA'))

    const cred = await core.owner.credentials()
    assert.equal(cred.cookie, 'SESSDATA=abc; bili_jct=csrf')
    assert.equal(cred.csrf, 'csrf')
    assert.equal(JSON.stringify(cred), '"[redacted]"')
    assert.equal(String(cred), '[redacted]')

    assert.equal(await core.owner.mentionPrefix(), '@阿鱼 ')
  })
})

// ---- toolLedger ----

test('toolLedger 按日期/会话/工具过滤，status 透传', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-ledger-'))
  const dir = paths(root).toolLedgerDir
  await mkdir(dir, { recursive: true })
  const rows = [
    { ts: '2026-11-11T01:00:00.000Z', sessionId: 's1', tool: 'bili_look', ok: true },
    { ts: '2026-11-11T02:00:00.000Z', sessionId: 's2', tool: 'bili_watch', ok: true },
    { ts: '2026-11-11T03:00:00.000Z', sessionId: 's1', tool: 'bili_speak', ok: false },
  ]
  await writeFile(join(dir, '2026-11-11.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const ledger = { status: () => ({ ok: true, written: 3, failed: 0 }) }
  const ctx = { get: () => undefined }
  const { core, dispose } = provideFishCore(ctx, { root, herDir: join(root, 'home'), toolLedger: ledger })
  try {
    assert.deepEqual(core.toolLedger.status(), { ok: true, written: 3, failed: 0 })
    const all = await core.toolLedger.read({ date: '2026-11-11' })
    assert.equal(all.length, 3)
    const s1 = await core.toolLedger.read({ date: '2026-11-11', session: 's1' })
    assert.deepEqual(s1.map((r) => r.tool), ['bili_look', 'bili_speak'])
    const one = await core.toolLedger.read({ date: '2026-11-11', tool: 'bili_watch' })
    assert.equal(one.length, 1)
    assert.deepEqual(await core.toolLedger.read({ date: '2026-11-12' }), [])
  } finally {
    dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('toolLedger.artifact 只允许 tool-ledger/artifacts 前缀', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-artifact-'))
  const art = paths(root).toolLedgerArtifacts
  await mkdir(art, { recursive: true })
  await writeFile(join(art, 'tc_1.json'), JSON.stringify({ hello: 'world' }))
  const { core, dispose } = provideFishCore({ get: () => undefined }, { root, herDir: join(root, 'home') })
  try {
    const good = await core.toolLedger.artifact(join(art, 'tc_1.json'))
    assert.equal(good.ok, true)
    assert.deepEqual(good.data, { hello: 'world' })

    const bad = await core.toolLedger.artifact('../../events.jsonl')
    assert.equal(bad.ok, false)
    assert.equal(bad.why, 'ARTIFACT_OUTSIDE')
  } finally {
    dispose()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---- self ----

test('self.identity 只读注入的身份文本，refresh 走 memory', async () => {
  await withCore(async ({ core }) => {
    assert.equal(core.self.identity(), '她的身份')
    assert.equal(core.self.identity({ surface: 'bili' }), '她的身份')
    const r = await core.self.refresh()
    assert.deepEqual(r, { ok: true })
  })
})
