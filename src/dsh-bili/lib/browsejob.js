/**
 * browsejob.js —— 后台刷站：不叫醒她，只把看见的东西写进记忆
 *
 * 2026-11-03（用户：「原来的 b 站插件好像没有正常运作……让大肥鱼有自己的记忆和认知」）。
 *
 * 以前刷站只挂在 `lookBeforeWake()` 里：不唤醒 = 不刷站。所以 `wakesPerDay=0` 的号
 * 从装好那天起就没再刷过；即使刷了，`browse:` 也只是 meta 记账，`her_recall` 跳过
 * meta——她看完等于没记住。这里补的是另一条路：
 *
 *   1. **按 browse.window / browse.perDay 在后台刷**，不需要会话、不需要模型回合，
 *      所以不会在侧栏里冒出一条"她突然说话"。
 *   2. 刷到的东西由 `browse.recordSaw` 写成 `saw` 事件：her_recall 翻得到，
 *      身份文档里也会摆最近三条。
 *   3. 和唤醒共用同一份配额（`browse:` meta）。有唤醒排着的时候先给它留一次，
 *      别把当天的素材提前用光。
 *
 * 三条边界与 browse.js 一致：只读、永不抛出、素材不是指令。
 */

import { createClient } from './bili.js'
import { gather, browseCountToday, recordBrowse } from './browse.js'
import { dateKey, inWindow } from './support.js'
import { riskState, browsePlan, noteRisk } from './risk.js'
import { deriveSelf } from './core.js'

/** 两次后台刷站之间至少隔这么久：同一天配额 3 次也不能一分钟内刷完。 */
export const BROWSE_MIN_GAP_MS = 20 * 60_000

/** 刷站时段：优先 browse.window，没配就退回全局 window，再没有就全天。 */
export function browseWindow(config) {
  if (Array.isArray(config?.browse?.window)) return config.browse.window
  if (Array.isArray(config?.window)) return config.window
  return ['00:00', '23:59']
}

function parseMinutes(hhmm, fallback) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm ?? ''))
  if (!m) return fallback
  return Number(m[1]) * 60 + Number(m[2])
}

function hashSeed(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * 今天该在哪些时刻刷。纯函数，按日期 + 配额算，不写盘、不读随机数。
 *
 * 为什么不用「每 20 分钟试一次」：那样配额永远在时段开头用光，晚上她就没有新鲜
 * 东西可看。把 n 次均匀铺在窗口里，再加一点按日期固定的抖动，既分散又不会
 * 每次重启都漂到另一个时间。
 *
 * @returns {number[]} 毫秒时间戳，升序
 */
export function browseSlots(config, dk = dateKey()) {
  const [bh, bm] = browseWindow(config)
  const start = parseMinutes(bh, 0)
  let end = parseMinutes(bm, 23 * 60 + 59)
  if (end <= start) end += 24 * 60
  const perDay = Math.max(0, Math.min(4, Math.round(Number(config?.browse?.perDay ?? 0))))
  if (!perDay) return []

  const [y, mo, d] = String(dk).split('-').map(Number)
  if (!y || !mo || !d) return []
  const dayStart = new Date(y, mo - 1, d, 0, 0, 0, 0).getTime()
  if (!Number.isFinite(dayStart)) return []

  const width = (end - start) / perDay
  const out = []
  for (let i = 0; i < perDay; i++) {
    // 抖动量最多半个槽位：不会跨进邻居的槽，也不会正好卡在整点。
    const jitter = (hashSeed(`${dk}:browse:${i}`) - 0.5) * width * 0.4
    const minute = start + (i + 0.5) * width + jitter
    out.push(dayStart + Math.round(minute) * 60_000)
  }
  return out.sort((a, b) => a - b)
}

/** 最近一次刷站是什么时候（任何来源：唤醒、手动、后台）。 */
export function lastBrowseAt(events = []) {
  let last = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('browse:')) continue
    const t = Date.parse(e.ts ?? '') || 0
    if (t > last) last = t
  }
  return last
}

/** 今天已经主动醒来几次（只数 `wake:<dk>`，与 scheduler.todayCounts 同口径）。 */
export function wakeCountToday(events = [], dk = dateKey()) {
  let n = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (String(e.text ?? '').startsWith(`wake:${dk} `)) n++
  }
  return n
}

/** 唤醒点之后多久还没醒，就把预留给它的刷站配额释放掉。 */
export const RESERVE_GRACE_MS = 30 * 60_000

/** 读今天的 sched:<dk> <ISO>；没有就 0。 */
export function scheduledAtFrom(events = [], dk = dateKey()) {
  const marker = `sched:${dk} `
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith(marker)) continue
    const at = Date.parse(t.slice(marker.length).trim())
    if (Number.isFinite(at)) return at
  }
  return 0
}

/**
 * 今天还能不能后台刷。
 *
 * reserve：还没发生的唤醒，每次都会在醒来时刷一次；先把这部分配额留出来。
 * 全部醒来过、或者根本没开唤醒，reserve = 0，后台可以把剩余配额用完。
 *
 * 2026-11-13：唤醒点过了 30 分钟还没醒，说明今天大概率不会醒了，
 * 释放 reserve，别让后台永远只用 1/3 配额；已有 wake 的日子继续预留。
 */
export function browseBudget(config, events = [], dk = dateKey(), { now = Date.now() } = {}) {
  const perDay = Math.max(0, Math.round(Number(config?.browse?.perDay ?? 0)))
  const wakes = Math.max(0, Math.round(Number(config?.wakesPerDay ?? 0)))
  const dailyEvents = Math.max(0, Math.round(Number(config?.daily?.events ?? 0)))
  const fired = wakeCountToday(events, dk)
  // 每天事件数是 0 时 plan() 永远不会 wake，别为一个不会发生的唤醒预留。
  const pending = wakes > 0 && dailyEvents > 0 ? Math.max(0, wakes - fired) : 0
  const scheduledAt = scheduledAtFrom(events, dk)
  const afterPoint = scheduledAt > 0 && now >= scheduledAt + RESERVE_GRACE_MS
  const release = afterPoint && fired === 0
  const reserve = release ? 0 : Math.min(pending, perDay)
  const used = browseCountToday(events, dk)
  return { perDay, used, reserve, free: Math.max(0, perDay - reserve) }
}

/**
 * 后台刷一轮。永不抛出。
 *
 * @returns {Promise<{ok:boolean, why?:string, picks?:object[], text?:string, note?:string}>}
 */
export async function backgroundBrowse({
  root,
  config,
  events = [],
  dk = dateKey(),
  now = Date.now(),
  log,
  deps = {},
} = {}) {
  try {
    if (!root) return { ok: false, why: 'no-root' }
    if (!config?.browse?.enabled) return { ok: false, why: 'disabled' }

    const at = now instanceof Date ? now : new Date(now)
    const budget = browseBudget(config, events, dk, { now: at.getTime() })
    if (!(budget.perDay > 0)) return { ok: false, why: 'perDay=0' }
    if (budget.used >= budget.free) {
      return { ok: false, why: budget.reserve > 0 ? 'reserved-for-wake' : 'quota-full' }
    }

    if (!inWindow({ window: browseWindow(config) }, at)) return { ok: false, why: 'outside-window' }

    const lastAt = lastBrowseAt(events)
    if (lastAt && at.getTime() - lastAt < BROWSE_MIN_GAP_MS) return { ok: false, why: 'min-gap' }

    const slots = browseSlots(config, dk)
    if (!slots.some((t) => t <= at.getTime())) return { ok: false, why: 'not-due' }

    // 风控闸：锁着就什么都不碰；人不用醒，也不需要留一条失败记录。
    const st = riskState(root, at)
    if (st.cooling) {
      log?.('risk cooldown', `还有 ${st.remainMin} 分钟`)
      return { ok: false, why: 'risk-cooldown' }
    }

    const model = await deriveSelf({ growthDays: config.growthDays, now: at.getTime() })
    // 刚被风控过 → 减半试探（与唤醒路径同一套）。
    const bp = browsePlan(config, st)
    const cfg2 = (bp.topN === Number(config?.browse?.topN) && bp.deepRead === Number(config?.browse?.deepRead))
      ? config
      : { ...config, browse: { ...config.browse, topN: bp.topN, deepRead: bp.deepRead } }

    const client = deps.client ?? createClient({ log: (...a) => log?.('bili', ...a) })
    const r = await gather(client, model, cfg2, { root, dk, events, memory: deps.memory })
    if (!r.ok || !r.text) {
      if (/COOLDOWN|-352|-412|-509|风控/.test(String(r.code ?? r.note ?? ''))) {
        noteRisk(root, r.code ?? 'COOLDOWN', at)
      }
      if (r.note) log?.('background browse empty', r.note)
      return { ok: false, why: 'empty', note: r.note }
    }

    await recordBrowse(root, dk, r.picks, model)
    log?.('background browse', `${r.picks.length} 条`)
    return { ok: true, picks: r.picks, text: r.text }
  } catch (err) {
    if (/COOLDOWN|-352|-412|-509|风控/.test(String(err?.code ?? err?.message ?? ''))) {
      noteRisk(root, err?.code ?? 'COOLDOWN', now instanceof Date ? now : new Date(now))
    }
    log?.('background browse failed', err?.message ?? err)
    return { ok: false, why: String(err?.message ?? err).slice(0, 120) }
  }
}
