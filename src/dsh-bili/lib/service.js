/**
 * service.js —— `ctx.provide('bili')` 的反向服务（设计 §7.10）
 *
 * core 的 `/dsh-fish/*` B 站路由在 A2 之后只剩代理：它们不再 import 任何 B 站
 * 模块，只把请求转给这里。工作台 `/dsh-bili/*` 也走同一份实现，两处看到的
 * 数据必须一模一样（P3 的双入口一致性就靠这一点）。
 *
 * 所有方法只读事件流 / 运行数据；写操作只有 `risk({clear:true})` 与 `sheet`
 * 的现场抽帧，与旧路由行为一致。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

import { createClient } from './bili.js'
import { browseCountToday, itemsFromEvents, renderSaw } from './browse.js'
import { commentCountToday, herComments, replyCountToday, scanReplies } from './comment.js'
import { coverPath, fetchCover } from './cover.js'
import { footprintFromEvents } from './footprint.js'
import { historyFromEvents } from './history.js'
import { outingCountToday, lastOutingAt, outingQuota, replyScanGapMs, outingDir, TITLE_OUTING_SESSION } from './outing.js'
import { clearRisk, riskState } from './risk.js'
import { grabFrames } from './video.js'
import { dateKey, paths, readJson } from './support.js'
import { getCore, loadConfig, readEvents, readOwner } from './core.js'

const COMMENT_BODY_TTL_MS = 10 * 60_000
const COMMENT_BODY_CACHE_MAX = 100
const sheetCache = new Map()
const commentBodyCache = new Map()

function isBvid(x) {
  return /^BV[0-9A-Za-z]{10}$/.test(String(x ?? ''))
}

function riskPayload(root) {
  // 页面要显示解除时刻，所以 riskState 一并给出 until（只读一次 risk.json）。
  return riskState(root)
}

export function createBiliService({ root, version = '0.1.0', log, makeClient } = {}) {
  const warn = (...a) => log?.(...a)

  async function events() {
    return (await readEvents()).events
  }

  async function config() {
    try {
      return (await loadConfig()).config ?? {}
    } catch {
      return {}
    }
  }

  async function savedSession() {
    return readJson(join(root, 'bili-session.json'), null).catch(() => null)
  }

  async function browse() {
    const evs = await events()
    const cfg = await config()
    const dk = dateKey()
    const lookedAll = []
    for (const e of evs) {
      if (e?.type !== 'meta') continue
      const t = String(e.text ?? '')
      if (t.startsWith('looked:')) lookedAll.push(t.slice(7))
    }
    return {
      enabled: Boolean(cfg?.browse?.enabled),
      perDay: Number(cfg?.browse?.perDay ?? 0),
      usedToday: browseCountToday(evs, dk),
      topN: Number(cfg?.browse?.topN ?? 0),
      keywords: cfg?.browse?.keywords ?? [],
      items: itemsFromEvents(evs, dk),
      lookedCount: lookedAll.length,
      lookedRecent: lookedAll.slice(-20).reverse(),
      avoidKeywords: cfg?.avoid?.keywords ?? [],
      avoidMids: cfg?.avoid?.upMids ?? [],
      minDuration: Number(cfg?.avoid?.minDuration ?? 0),
    }
  }

  async function history({ days = 14 } = {}) {
    const d = Math.max(1, Math.min(180, Number(days) || 14))
    const groups = historyFromEvents(await events(), { days: d })
    return { days: d, total: groups.reduce((a, g) => a + g.items.length, 0), groups }
  }

  async function footprint({ days = 365, limit = 500 } = {}) {
    const d = Math.max(1, Math.min(3650, Number(days) || 365))
    const l = Math.max(1, Math.min(1000, Number(limit) || 500))
    return footprintFromEvents(await events(), { days: d, limit: l })
  }

  /** 评论正文现取；只接受合法 BV + 正整数 rpid。 */
  async function commentBody({ bvid, rpid } = {}) {
    const b = String(bvid ?? '').trim()
    const r = Number(rpid) || 0
    if (!isBvid(b) || !r) return { ok: false, status: 400, error: '参数不对：需要 bvid 和 rpid' }
    const key = `${b}:${r}`
    const hit = commentBodyCache.get(key)
    if (hit && Date.now() - hit.at < COMMENT_BODY_TTL_MS) {
      return { ok: true, status: 200, data: { ...hit.data, cached: true } }
    }
    const client = await clientFor()
    const v = await client.view(b)
    const aid = Number(v?.data?.aid) || 0
    if (!aid) return { ok: false, status: 404, error: '找不到这个视频' }
    const d = await client.replyDetail(aid, r)
    if (!d.ok) return { ok: false, status: 502, error: d.message || '没读到这条评论' }
    const data = { ...d.data, at: d.data?.ctime ? new Date(d.data.ctime * 1000).toISOString() : null }
    commentBodyCache.set(key, { at: Date.now(), data })
    while (commentBodyCache.size > COMMENT_BODY_CACHE_MAX) {
      commentBodyCache.delete(commentBodyCache.keys().next().value)
    }
    return { ok: true, status: 200, data }
  }

  /** 封面：本地没有就按需取一次。返回 { buf, contentType } 或 null。 */
  async function cover(bvid) {
    if (!isBvid(bvid)) return null
    let file = coverPath(root, bvid)
    if (!file) {
      try {
        const client = await clientFor()
        const v = await client.view(bvid)
        const pic = v?.data?.pic || v?.pic || ''
        if (pic) file = await fetchCover({ root, bvid, pic })
      } catch { /* 拿不到就是 404 */ }
    }
    if (!file) return null
    try {
      const buf = await fs.readFile(file)
      const ext = file.split('.').pop().toLowerCase()
      return { buf, contentType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' }
    } catch {
      return null
    }
  }

  /** 抽帧拼图：命中缓存直接给；没有就现场抽一次。 */
  async function sheet(bvid) {
    if (!isBvid(bvid)) return null
    const dir = paths(root).media
    let files = []
    try {
      files = (await fs.readdir(dir)).filter((f) => f.startsWith(`sheet-${bvid}-`) && f.endsWith('.png'))
    } catch { /* 目录还没有 */ }
    files.sort()
    const hit = files.length ? join(dir, files[files.length - 1]) : ''
    const cached = hit ? await fs.readFile(hit).catch(() => null) : null
    const memo = sheetCache.get(bvid)
    if (!hit && memo && Date.now() - memo.at < 10 * 60_000) {
      return { buf: memo.buf, contentType: 'image/png' }
    }
    if (cached) return { buf: cached, contentType: 'image/png' }

    const r = await grabFrames({ root, bvid, log: warn }).catch((err) => ({ ok: false, why: String(err?.message ?? err) }))
    if (!r?.ok || !r.path) return null
    const buf = await fs.readFile(r.path).catch(() => null)
    if (!buf) return null
    sheetCache.set(bvid, { at: Date.now(), buf })
    return { buf, contentType: 'image/png' }
  }

  async function risk({ clear = false } = {}) {
    const cleared = Boolean(clear)
    if (cleared) clearRisk(root)
    return { ...riskPayload(root), cleared }
  }

  async function commentStatus() {
    const evs = await events()
    const cfg = await config()
    const dk = dateKey()
    const c = cfg.comment ?? {}
    let replies = []
    if (c.enabled === true) {
      // 有人打开页面才问 B 站；与旧路由一致。BFF 把这条登记为 sideEffect +
      // 同源校验，跨站 <img> 不能借它触发扫描。
      replies = await scanReplies({ root, events: evs, dateKey: dk, memory: getCore()?.memory }).catch(() => [])
    }
    return {
      enabled: c.enabled === true,
      perDay: Number(c.perDay ?? 0),
      usedToday: commentCountToday(evs, dk),
      replyPerDay: Number(c.replyPerDay ?? 0),
      replyUsedToday: replyCountToday(evs, dk),
      replyToReplies: c.replyToReplies !== false,
      scanEveryMin: Number(c.scanEveryMin ?? 30),
      window: c.window ?? [],
      mine: herComments(evs, dk),
      waiting: replies.slice(0, 5).map((x) => ({
        rpid: x.rpid,
        bvid: x.bvid,
        user: x.user,
        text: x.text,
        // B 站 ctime 是秒；页面用 at 显示「什么时候回的」。
        at: x.ctime ? new Date(x.ctime * 1000).toISOString() : '',
      })),
      waitingCount: replies.length,
    }
  }

  async function outings() {
    const evs = await events()
    const cfg = await config()
    const saved = await savedSession()
    const today = outingCountToday(evs, dateKey())
    return {
      quota: outingQuota(cfg),
      usedToday: today,
      lastAt: lastOutingAt(evs) || null,
      sessionId: String(saved?.sessionId ?? ''),
      sessionTitle: String(saved?.title ?? TITLE_OUTING_SESSION),
      dir: outingDir(root),
      scanEveryMin: Math.round(replyScanGapMs(cfg) / 60_000),
      enabled: cfg?.browse?.enabled === true,
    }
  }

  /** 联网客户端：线上按 owner 的 cookie 建；测试可注入替身，避免真打 B 站。 */
  async function clientFor() {
    if (typeof makeClient === 'function') return makeClient()
    const ow = await readOwner().catch(() => null)
    return createClient({ cookie: ow?.cookie || '', log: () => {} })
  }

  /** 给 core 自检用的联网客户端；拿不到 cookie 也返回（匿名请求）。 */
  async function netClient() {
    return clientFor()
  }

  async function ledger({ date = '', session = '', tool = '', limit = 100 } = {}) {
    const svc = getCore()?.toolLedger
    if (!svc || typeof svc.read !== 'function') {
      return { ok: false, code: 'NO_LEDGER', rows: [] }
    }
    try {
      const r = await svc.read({ date, session, tool, limit })
      // fishCore.toolLedger.read 返回行数组；直接展开会变成 {"0":…}，
      // 工作台读 rows 永远是空。对象形式（别的宿主/老实现）也认。
      if (Array.isArray(r)) return { ok: true, rows: r }
      return { ok: true, rows: [], ...(r ?? {}) }
    } catch (err) {
      return { ok: false, code: 'LEDGER_READ_FAILED', why: String(err?.message ?? err).slice(0, 160), rows: [] }
    }
  }

  async function status() {
    const [evs, cfg, saved] = await Promise.all([events(), config(), savedSession()])
    const dk = dateKey()
    const risk = riskPayload(root)
    const waiting = [] // 不在状态里联网扫描；需要待回列表走 /comment
    return {
      installed: true,
      version,
      browsedToday: browseCountToday(evs, dk),
      outingsToday: outingCountToday(evs, dk),
      waiting: waiting.length,
      riskUntil: risk.until ?? 0,
      cooling: risk.cooling === true,
      lastOutingAt: lastOutingAt(evs) || null,
      sessionId: String(saved?.sessionId ?? ''),
      sessionReused: Boolean(saved?.sessionId),
      browseEnabled: cfg?.browse?.enabled === true,
      commentEnabled: cfg?.comment?.enabled === true,
      at: new Date().toISOString(),
    }
  }

  /** 出门素材缓存视图：给工作台证据页的“最近一次出门带了什么”。 */
  async function recentMaterial(limit = 10) {
    const evs = await events()
    const saw = evs.filter((e) => e?.type === 'saw').slice(-limit).map((e) => ({
      at: e.ts ?? '', text: String(e.text ?? '').slice(0, 400), refs: e.refs ?? [],
    }))
    return { saw: saw.reverse() }
  }

  return {
    version,
    status,
    browse,
    history,
    footprint,
    commentBody,
    cover,
    sheet,
    risk,
    commentStatus,
    outings,
    ledger,
    netClient,
    recentMaterial,
    _renderSaw: renderSaw,
  }
}
