/**
 * closing.js —— 收盘任务（growth 自触发 item 5–6）
 *
 * 每天固定时刻（默认 18:00）做三件维护动作：
 *   1. 无条件写当天日报（不依赖唤醒）；
 *   2. 如果她今天还没写日记，给一次极短的“收工，记一笔”机会；
 *   3. 到期时顺带问一次「想一想」（sleepDue），不另起定时器。
 *
 * 边界：
 *   - 不占 wakesPerDay / daily.events，不写 fired:，不写 seen:；
 *   - 失败不重试（写 closingfail:，下一天再说）；
 *   - flushReport 返回 null 时**不**落完成标记，让下一个 tick 还能重试（D26）；
 *   - 只补今天和昨天，已有报告不覆盖。
 */

import { readEvents, appendEvent, readDaily, rootDir } from './store.js'
import { dateKey } from './settings.js'
import { deriveSelf } from './derive.js'
import { flushReport, listReports, localDay } from './report.js'
import { talkSessionId } from './home.js'
import { setWakeSection, clearWakeSection } from './identity.js'
import { watchTurnEnd } from './turnend.js'
import { withWake } from './wakewin.js'
import { sleepDue } from './sleep.js'
import { SLEEP_TODAY } from './persona.js'
import { CLOSING_TRIGGER, CLOSING_HINT } from './wakeconst.js'

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const DAY_MS = 86_400_000
const WAKE_TIMEOUT_MS = 2 * 60_000
const RECENT_WAKE_MS = 15 * 60_000
const FALLBACK_MS = 90_000

/** 今天是不是该收盘了。纯函数，不读盘。 */
export function closingDue({ config, events = [], now = new Date(), dk = dateKey(now) } = {}) {
  const c = config?.memory?.closing
  if (!c?.enabled) return { due: false, why: 'disabled' }
  const time = String(c.time ?? '')
  if (!TIME_RE.test(time)) return { due: false, why: 'bad-time' }
  const [h, m] = time.split(':').map(Number)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  if (nowMin < h * 60 + m) return { due: false, why: 'before-time' }
  const done = events.some((e) => {
    if (e?.type !== 'meta') return false
    const t = String(e.text ?? '')
    return t.startsWith(`closing:${dk}`) || t.startsWith(`closingfail:${dk}`)
  })
  if (done) return { due: false, why: 'already-done' }
  return { due: true, why: 'due' }
}

function lastWakeAt(events) {
  let at = 0
  for (const e of events) {
    if (e?.type !== 'meta' || !String(e.text ?? '').startsWith('wake:')) continue
    const t = Date.parse(e.ts) || 0
    if (t > at) at = t
  }
  return at
}

async function biliItems(ctx) {
  try {
    const bili = ctx?.get?.('bili')
    return (await bili?.browse?.())?.items ?? []
  } catch {
    return []
  }
}

/**
 * 跑一次收盘。每个 tick 调用；closingDue 会挡住重复。
 * @returns {{ok:boolean, woke?:boolean, report?:string|null, why?:string}}
 */
export async function runClosing(ctx, { root = rootDir(), config, now = new Date(), dk = dateKey(now), log } = {}) {
  // tick 开头的事件快照可能早于刚结束的普通唤醒；收盘判断必须用最新事件。
  const { events } = await readEvents(root)
  const due = closingDue({ config, events, now, dk })
  if (!due.due) return { ok: true, skipped: true, why: due.why }

  const model = deriveSelf(events, { growthDays: config.growthDays })
  const items = await biliItems(ctx)
  const report = await flushReport(root, {
    dateKey: dk,
    items,
    notes: [],
    diaryVisible: config?.diary?.visible === true,
  }).catch(() => null)

  // D26：报告写失败不落完成标记；写 closingfail，下一个 tick 还能重试。
  if (!report) {
    await appendEvent(
      { type: 'meta', text: `closingfail:${dk} report-failed` },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    ).catch(() => {})
    log?.('closing report failed', dk)
    return { ok: false, why: 'report-failed' }
  }

  const diary = await readDaily('diaryDir', dk, root).catch(() => null)
  const c = config?.memory?.closing ?? {}
  if (c.wake === false || (c.diaryOnly !== false && diary)) {
    await appendEvent(
      { type: 'meta', text: `closing:${dk} report${diary ? ',diary-present' : ''}` },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    ).catch(() => {})
    return { ok: true, report, woke: false }
  }

  const recent = lastWakeAt(events)
  if (recent > 0 && now.getTime() - recent <= RECENT_WAKE_MS) {
    await appendEvent(
      { type: 'meta', text: `closing:${dk} report,recent-wake` },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    ).catch(() => {})
    return { ok: true, report, woke: false }
  }

  const sc = (() => { try { return ctx.get?.('sessionController') } catch { return undefined } })()
  const sessionId = await talkSessionId(ctx, { root, log }).catch(() => '')
  if (!sessionId || !sc?.prompt) {
    await appendEvent(
      { type: 'meta', text: `closingfail:${dk} no-session` },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    ).catch(() => {})
    log?.('closing no session', dk)
    return { ok: true, report, woke: false, why: 'no-session' }
  }

  const dueSleep = sleepDue(events, model, config?.memory?.sleepEveryDays, dk)
  const hint = dueSleep ? `${CLOSING_HINT}\n\n${SLEEP_TODAY}` : CLOSING_HINT
  setWakeSection(hint, sessionId)
  const ac = new AbortController()
  const kill = setTimeout(() => ac.abort(), WAKE_TIMEOUT_MS)
  kill.unref?.()

  const writeReport = () => flushReport(root, {
    dateKey: dk,
    items: awaitItems(items),
    notes: [],
    diaryVisible: config?.diary?.visible === true,
  }).catch(() => null)

  let watcher = null
  try {
    await withWake(async () => {
      await sc.prompt(
        { requestId: `closing-${dk}`, sessionId, mode: 'queue', content: [{ type: 'text', text: CLOSING_TRIGGER }] },
        ac.signal,
      )
    })
    await appendEvent(
      { type: 'meta', text: `closing:${dk} wake` },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    ).catch(() => {})
    if (dueSleep) {
      await appendEvent(
        { type: 'meta', text: `sleep:${dk}` },
        { day: model.day, stage: model.stage, source: 'system' },
        root,
      ).catch(() => {})
    }
    watcher = watchTurnEnd(ctx, sessionId, () => { void writeReport(); clearWakeSection(sessionId) })
    const fallback = setTimeout(() => {
      try { watcher?.() } catch { /* ignore */ }
      void writeReport()
      clearWakeSection(sessionId)
    }, FALLBACK_MS)
    fallback.unref?.()
    return { ok: true, report, woke: true }
  } catch (err) {
    clearWakeSection(sessionId)
    await appendEvent(
      { type: 'meta', text: `closingfail:${dk} ${String(err?.message ?? err).slice(0, 80)}` },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    ).catch(() => {})
    log?.('closing wake failed', err?.message ?? err)
    return { ok: false, report, woke: false, why: 'wake-failed' }
  } finally {
    clearTimeout(kill)
  }
}

// flushReport 的 items 在延迟回调里也要拿到；保持简单：闭包捕获数组。
function awaitItems(items) {
  return Array.isArray(items) ? items : []
}

/** 某个本地日期有没有事件。口径与 report.js 的 localDay 一致。 */
export function hasEventsOn(events, dk) {
  return (Array.isArray(events) ? events : []).some((e) => localDay(e?.ts) === dk)
}

/**
 * 启动/停用时补写最近 reports（默认今天和昨天）。
 * 只补有事件、且报告文件不存在的日子；已有报告不覆盖。
 */
export async function flushMissingReports(root = rootDir(), { now = new Date(), days = 2, log } = {}) {
  try {
    const { events } = await readEvents(root)
    const existing = new Set(await listReports(root).catch(() => []))
    const out = []
    for (let i = 0; i < Math.max(1, Number(days) || 1); i++) {
      const dk = dateKey(new Date(now.getTime() - i * DAY_MS))
      if (!hasEventsOn(events, dk)) continue
      if (existing.has(dk)) continue
      const path = await flushReport(root, { dateKey: dk, items: [], notes: [], diaryVisible: false }).catch(() => null)
      if (path) out.push(dk)
    }
    return { ok: true, wrote: out }
  } catch (err) {
    log?.('flushMissingReports failed', err?.message ?? err)
    return { ok: false, wrote: [], why: String(err?.message ?? err).slice(0, 160) }
  }
}
