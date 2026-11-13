/**
 * outing.js —— B 站出门会话（第一版，2026-11-10）
 *
 * 为什么要有：`bili_look` / `bili_watch` / `bili_speak` 属于 `bili` 面，
 * 而面由会话决定。以前没有 B 站会话，这三个工具对任何会话都不可见——
 * 她能「被推送着看」，却没法自己打开视频、更没法在评论区回话。
 *
 * 这一版只做两件事：
 *   1. 幂等地建/复用「大肥鱼出门 / 去 B 站」会话，工作区在 `<root>/home/bili`；
 *   2. 后台刷站成功、或评论区有新回复时，把素材投进这条会话，让她自己决定看不看、说不说。
 *
 * 不是 `dsh-bili` 拆包：调度、素材、工具仍由 core 提供。拆包时整块搬走。
 *
 * 边界：
 *   - 只追加事件（`biliout:<日期>` 记账），不改任何历史；
 *   - 永不抛：出门失败只记日志/诊断，不影响 tick；
 *   - 宿主服务没起来就跳过这一轮，不空转重试。
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { appendEvent, getCore } from './core.js'
import { dateKey, inWindow, paths, readJson, writeAtomic } from './support.js'
import { scanReplies, renderReplies } from './comment.js'
import { renderWatchList } from './history.js'
import { fetchCover, coverLines } from './cover.js'
import { BILI_HINT, BILI_TRIGGER } from './prompts.js'

export const TITLE_OUTING_WORKSPACE = '大肥鱼出门'
export const TITLE_OUTING_SESSION = '去 B 站'
/** 只带回复出门时，两次之间至少隔这么久。带素材的出门由刷站槽位控制。 */
export const OUTING_MIN_GAP_MS = 60 * 60_000
/**
 * 扫描评论区回复的默认节流：每次要打 2N 个接口，不能每个 tick 都扫。
 * 配置里有 `comment.scanEveryMin`（分钟）就以它为准。
 */
export const REPLY_SCAN_GAP_MS = 30 * 60_000

/** 扫描间隔：`comment.scanEveryMin` 优先，夹在 5 分钟到 12 小时之间。 */
export function replyScanGapMs(config = {}) {
  const min = Math.round(Number(config?.comment?.scanEveryMin ?? 0)) || 0
  if (!min) return REPLY_SCAN_GAP_MS
  return Math.max(5, Math.min(720, min)) * 60_000
}
const OUTING_TIMEOUT_MS = 5 * 60_000
/** turn/end 迟迟不来时的兜底：把这一条会话的处境段清掉，别残留到下一轮。 */
const OUTING_CLEAR_MS = 90_000

export function outingDir(root) {
  return join(paths(root).root, 'home', 'bili')
}

function stateFile(root) {
  return join(paths(root).root, 'bili-session.json')
}

function pathKey(p) {
  let s = String(p ?? '').replace(/[\\/]+$/, '')
  try { s = resolve(s) } catch { /* 保持原样 */ }
  return process.platform === 'win32' ? s.toLowerCase() : s
}

function readRegistry(ctx) {
  try { return ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry ?? null } catch { return null }
}

function readController(ctx) {
  try { return ctx.get?.('sessionController') ?? ctx.sessionController ?? null } catch { return null }
}

function reserve(ctx, sessionId) {
  try { ctx.get?.('fishCore')?.surface?.reserve?.(String(sessionId), 'bili') } catch { /* ignore */ }
}

/**
 * 回复扫描的时间戳（按 root 分）。只在内存里：重启后多扫一次，无所谓。
 */
const replyScanAt = new Map()
/** 测试用：忘掉扫描节流。 */
export function resetOutingState() {
  replyScanAt.clear()
}

/** 今天出门了几次（只数 `biliout:<日期>`）。 */
export function outingCountToday(events = [], dk = dateKey()) {
  let n = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (String(e.text ?? '').startsWith(`biliout:${dk}`)) n += 1
  }
  return n
}

/** 最近一次出门的时间戳（跨天；0 表示没有）。 */
export function lastOutingAt(events = []) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('biliout:')) continue
    const t = Date.parse(e.ts ?? '') || 0
    if (t > last) last = t
  }
  return last
}

/** 出门次数上限：跟着刷站配额走，至少一次。 */
export function outingQuota(config = {}) {
  const perDay = Math.round(Number(config?.browse?.perDay ?? 0)) || 0
  return Math.max(1, Math.min(4, perDay))
}

/**
 * 第一次把会话点起来：宿主的侧栏只显示「不是空白」的会话，
 * 新建出来的会话不跑一轮就一直藏着。只在新会话上做一次。
 */
function firstLook(ctx, sessionId, log) {
  const sc = readController(ctx)
  const prompt = getCore()?.prompt ?? null
  if (!sc?.prompt || !prompt) return
  const text = `${BILI_HINT}\n\n## 你出门了\n你到 B 站看一眼。看什么、要不要说话，你自己定。`
  prompt.setWake(sessionId, text)
  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), OUTING_TIMEOUT_MS)
  const watcher = prompt.watchTurnEnd(sessionId, () => prompt.clearWake(sessionId))
  const run = () => sc.prompt(
    {
      requestId: `bili-first-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: BILI_TRIGGER }],
    },
    ac.signal,
  )
  void (typeof prompt.withWake === 'function' ? prompt.withWake(run) : run())
    .catch((err) => log?.(`出门会话第一轮没起来：${String(err?.message ?? err).slice(0, 120)}`))
    .finally(() => {
      clearTimeout(kill)
      setTimeout(() => {
        try { watcher.off?.() } catch { /* ignore */ }
        // 只清自己写的那一段：这 90 秒里可能已经有另一次出门挂上了新的处境。
        if (prompt.getWake(sessionId) === text) prompt.clearWake(sessionId)
      }, OUTING_CLEAR_MS).unref?.()
    })
}

/**
 * 建或复用出门会话。
 *
 * 顺序：预分配 id → `surface.reserve(id,'bili')` → `sc.create({ sessionId })`。
 * 宿主可能不认预分配的 id；返回值和请求值不同时，以返回值为准并补登记。
 *
 * @returns {Promise<{ok:boolean, sessionId?:string, wsId?:string, dir?:string, reused?:boolean, why?:string}>}
 */
export async function ensureBiliSession(ctx, { root, preset = '', log, wakeOnCreate = true } = {}) {
  const sc = readController(ctx)
  if (!sc?.create) return { ok: false, why: '宿主没有 sessionController 服务' }
  if (!root) return { ok: false, why: '没有 root' }

  const dir = outingDir(root)
  try { await fs.mkdir(dir, { recursive: true }) } catch { /* 建不了就让 create 报 */ }
  const saved = await readJson(stateFile(root), null).catch(() => null)

  // 上次那条还活着就复用；registry 不可用时不硬判死，沿用旧 id（宿主可能仍认识）。
  if (saved?.sessionId) {
    const reg = readRegistry(ctx)
    let alive = true
    if (reg?.get) {
      try {
        const ws = reg.get(saved.wsId)
        const archived = Array.isArray(reg.archivedSessionIds) ? reg.archivedSessionIds : []
        alive = Boolean(ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(saved.sessionId))
          && !archived.includes(saved.sessionId)
      } catch { alive = false }
    }
    if (alive) {
      reserve(ctx, saved.sessionId)
      return { ok: true, sessionId: saved.sessionId, wsId: saved.wsId ?? '', dir, reused: true }
    }
  }

  // ---- 工作区 ----
  const reg = readRegistry(ctx)
  if (!reg?.create) return { ok: false, why: '宿主没有 workspaceRegistry 服务' }
  let ws = null
  try {
    const list = typeof reg.list === 'function' ? reg.list() : []
    ws = (list ?? []).find((w) => w?.path && pathKey(w.path) === pathKey(dir)) ?? null
  } catch { /* list 不可用就 create */ }
  if (ws && String(ws.title ?? '') !== TITLE_OUTING_WORKSPACE) {
    try {
      if (typeof ws.setTitle === 'function') await ws.setTitle(TITLE_OUTING_WORKSPACE)
      else if (typeof reg.rename === 'function') await reg.rename(ws.id ?? ws.workspaceId, TITLE_OUTING_WORKSPACE)
    } catch { /* 改不了就保留原名 */ }
  }
  if (!ws) {
    try { ws = await reg.create(dir, TITLE_OUTING_WORKSPACE) } catch (err) {
      return { ok: false, why: `建出门工作区失败：${String(err?.message ?? err).slice(0, 120)}` }
    }
  }
  const wsId = String(ws?.id ?? ws?.workspaceId ?? '')
  if (!wsId) return { ok: false, why: '宿主返回的出门工作区没有 id' }

  // ---- 会话 ----
  // 预分配 id 先登记成 bili 面：`agent/created` 是同步发出的，
  // 等 create 返回再登记就晚了一步（她会先以别的面装配一次）。
  const requested = randomUUID()
  reserve(ctx, requested)
  const wantPreset = String(preset ?? '').trim()
  const attempts = []
  if (wantPreset) {
    attempts.push({ workspaceId: wsId, sessionId: requested, agentPreset: wantPreset })
    attempts.push({ workspaceId: wsId, agentPreset: wantPreset })
  }
  attempts.push({ workspaceId: wsId, sessionId: requested })
  attempts.push({ workspaceId: wsId })

  let created = null
  let lastWhy = ''
  for (const req of attempts) {
    try {
      const r = await sc.create(req)
      if (String(r?.sessionId ?? r?.id ?? '')) { created = r; break }
    } catch (err) {
      lastWhy = String(err?.message ?? err).slice(0, 120)
    }
  }
  const sessionId = String(created?.sessionId ?? created?.id ?? '')
  if (!sessionId) return { ok: false, why: `建出门会话失败：${lastWhy || '宿主没给 id'}` }
  reserve(ctx, sessionId)
  try {
    if (typeof sc.rename === 'function') await sc.rename({ sessionId, title: TITLE_OUTING_SESSION })
  } catch { /* 标题改不了不影响使用 */ }

  try {
    await writeAtomic(stateFile(root), JSON.stringify({
      wsId,
      sessionId,
      title: TITLE_OUTING_SESSION,
      dir,
      preset: wantPreset,
      createdAt: new Date().toISOString(),
    }, null, 2))
  } catch { /* 记不下来下次会多建一条；不让它挡住这次出门 */ }

  log?.(`出门会话已就绪 ${sessionId}`)
  if (wakeOnCreate) firstLook(ctx, sessionId, log)
  return { ok: true, sessionId, wsId, dir, reused: false }
}

/** 出门素材：正文 + 链接清单 + 两张封面。 */
export async function renderOutingMaterial({ root, material = '', picks = [], log } = {}) {
  const parts = []
  if (material) parts.push(material)
  const wl = renderWatchList(picks)
  if (wl) parts.push('', wl)
  if (Array.isArray(picks) && picks.length) {
    try {
      for (const p of picks.slice(0, 2)) {
        await fetchCover({ root, bvid: p.bvid, pic: p.pic, log })
      }
      const covers = coverLines(picks, root, 2)
      if (covers.length) parts.push('', ...covers)
    } catch { /* 一张图不能拖垮一次出门 */ }
  }
  return parts.join('\n').trim()
}

/**
 * 到点就出门。永不抛出。
 *
 * @param {object} ctx
 * @param {{
 *   root: string, config: object, events: object[], dk?: string, now?: Date,
 *   material?: string, picks?: object[], log?: Function,
 *   ensureSession?: Function, client?: object, appendEvent?: Function,
 * }} opts
 * @returns {Promise<{ok:boolean, why?:string, sessionId?:string}>}
 */
export async function maybeOuting(ctx, opts = {}) {
  const root = opts.root
  const config = opts.config ?? {}
  const events = Array.isArray(opts.events) ? opts.events : []
  const dk = opts.dk ?? dateKey()
  const now = opts.now instanceof Date ? opts.now : new Date()
  const log = opts.log ?? (() => {})

  try {
    if (!root) return { ok: false, why: 'no-root' }
    if (outingCountToday(events, dk) >= outingQuota(config)) return { ok: false, why: 'quota-full' }

    const material = String(opts.material ?? '').trim()
    const picks = Array.isArray(opts.picks) ? opts.picks : []

    // 只带回复出门时，跟上一次出门至少隔一小时；带素材的由刷站槽位控制。
    const last = lastOutingAt(events)
    if (!material && last && now.getTime() - last < OUTING_MIN_GAP_MS) {
      return { ok: false, why: 'min-gap' }
    }

    // 评论区：只在她能说话、且在说话时段内才看；扫描本身按 20 分钟节流。
    let replies = ''
    let waiting = []
    const cw = Array.isArray(config?.comment?.window) ? config.comment.window : ['00:00', '23:59']
    if (config?.comment?.enabled === true && inWindow({ window: cw }, now)) {
      const scanAt = replyScanAt.get(root) ?? 0
      if (now.getTime() - scanAt >= replyScanGapMs(config)) {
        replyScanAt.set(root, now.getTime())
        const memory = opts.memory ?? opts.core?.memory ?? null
        waiting = await scanReplies({ root, events, dateKey: dk, client: opts.client, memory }).catch(() => [])
        replies = renderReplies(waiting)
      }
    }

    if (!material && !replies) return { ok: false, why: 'nothing-to-see' }

    const ensure = typeof opts.ensureSession === 'function'
      ? opts.ensureSession
      : () => ensureBiliSession(ctx, { root, preset: config?.tools?.preset ?? '', log, wakeOnCreate: false })
    const ses = await ensure()
    if (!ses?.ok) {
      log(`出门跳过：${ses?.why ?? '会话没就绪'}`)
      return { ok: false, why: ses?.why ?? 'no-session' }
    }

    const body = [material, replies].filter(Boolean).join('\n\n')
    const content = [
      '## 你出门了',
      '你到 B 站看一眼。看什么、要不要说话，你自己定。',
      body,
    ].filter(Boolean).join('\n')
    const wakeText = `${BILI_HINT}\n\n${content}`

    const sid = String(ses.sessionId)
    const sc = readController(ctx)
    if (!sc?.prompt) return { ok: false, why: '宿主没有 sessionController.prompt' }

    // A2：处境段与会话投递都走 fishCore；core 不再提供 identity/turnend 的内部实现。
    const prompt = opts.core?.prompt ?? getCore()?.prompt ?? null
    const sessions = opts.core?.sessions ?? getCore()?.sessions ?? null
    if (!prompt) return { ok: false, why: 'NO_PROMPT_SERVICE' }
    const setWake = (text) => prompt.setWake(sid, text)
    const clearWake = () => prompt.clearWake(sid)
    const wakeNow = () => prompt.getWake(sid)

    const ac = new AbortController()
    const kill = setTimeout(() => ac.abort(), OUTING_TIMEOUT_MS)
    const watcher = prompt.watchTurnEnd(sid, () => clearWake())

    setWake(wakeText)
    try {
      const run = async () => {
        if (sessions) {
          const r = await sessions.prompt(sid, BILI_TRIGGER, { signal: ac.signal })
          if (!r?.ok) throw new Error(r?.why ?? '投递失败')
          return
        }
        await sc.prompt(
          {
            requestId: `bili-${dk}-${Date.now()}`,
            sessionId: sid,
            mode: 'queue',
            content: [{ type: 'text', text: BILI_TRIGGER }],
          },
          ac.signal,
        )
      }
      await (typeof prompt.withWake === 'function' ? prompt.withWake(run) : run())
      const append = typeof opts.appendEvent === 'function' ? opts.appendEvent : appendEvent
      try {
        await append(
          { type: 'meta', text: `biliout:${dk}${material ? ' browse' : ' replies'}` },
          { day: 0, stage: 1, source: 'timer' },
        )
      } catch { /* 记账失败不影响这次出门已经发生的事实 */ }

      // 投递成功才写 cseen（v3 呈现态）。失败保留 bili_reply，下一轮扫描会再投。
      for (const w of waiting) {
        try {
          await append({ type: 'meta', text: `cseen:${w.rpid}` }, { day: 0, stage: 1, source: 'system' })
        } catch { /* 少一条呈现标记最多重复投递一次，不静默丢 */ }
      }
      log(`出门（${material ? '带素材' : '带回复'}）`)
      setTimeout(() => {
        try { watcher.off?.() } catch { /* ignore */ }
        // 只清自己写的那一段：这 90 秒里可能已经有下一次出门挂上了新的处境。
        if (wakeNow() === wakeText) clearWake()
      }, OUTING_CLEAR_MS).unref?.()
      return { ok: true, sessionId: sid }
    } catch (err) {
      try { watcher.off?.() } catch { /* ignore */ }
      clearWake()
      log(`出门失败：${String(err?.message ?? err).slice(0, 120)}`)
      return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
    } finally {
      clearTimeout(kill)
    }
  } catch (err) {
    log(`出门出错：${String(err?.message ?? err).slice(0, 120)}`)
    return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
  }
}
