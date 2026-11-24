/**
 * work-state.js —— 工作会话与 WorkUnit 的唯一状态存储
 *
 * 两个运行数据文件（不进 Git）：
 *   ~/.dsh-fish/work-sessions.json  dir → boss 记录
 *   ~/.dsh-fish/work-units.json     worker / teammate 记录
 *
 * 约束：
 *   - 只有本进程写；所有变更串行，读-改-写之间不丢并发更新；
 *   - 原子写、0600；坏文件由 store.readJson 另存 .corrupt-* 后按空处理；
 *   - 终态只写一次；guardHits 只能在终态前追加；
 *   - 事件流不在这里，worker 原始日志也不在这里。
 *
 * 这个模块不 import 宿主或其它业务模块，状态映射是纯函数。
 */

import { readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeAtomic } from './store.js'

const SESSION_LIMIT = 20
const UNIT_LIMIT = 200
const SUMMARY_LIMIT = 2000
const REPORT_ARRAY_LIMIT = 20
const REPORT_ITEM_LIMIT = 500
const TEAMMATE_LIMIT = 16
const GUARD_HIT_LIMIT = 10
const GUARD_HIT_CHARS = 200
const TERMINAL = new Set(['done', 'blocked', 'failed', 'aborted', 'unknown'])

function iso(at) {
  try {
    return new Date(at).toISOString()
  } catch {
    return new Date().toISOString()
  }
}

function charCount(s) {
  return [...s].length
}

function cutChars(s, n) {
  const chars = [...s]
  return chars.length <= n ? s : chars.slice(0, n).join('')
}

function asString(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** 压平换行；空串保持空串。 */
export function truncateSummary(text, limit = SUMMARY_LIMIT) {
  const flat = asString(text).replace(/\s*\n+\s*/g, ' ').trim()
  return cutChars(flat, limit)
}

/** 结构化报告只保留已知字段，数组/字数都有界。 */
export function sanitizeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null
  const out = {}
  if (report.summary !== undefined) out.summary = truncateSummary(report.summary)
  if (report.done !== undefined) out.done = report.done === true
  for (const key of ['filesChanged', 'verification', 'blockers']) {
    if (!Array.isArray(report[key])) continue
    out[key] = report[key]
      .slice(0, REPORT_ARRAY_LIMIT)
      .map((x) => cutChars(asString(x), REPORT_ITEM_LIMIT))
      .filter((x) => x !== '')
  }
  if (Array.isArray(report.teammates)) {
    out.teammates = report.teammates.slice(0, TEAMMATE_LIMIT).map((t) => ({
      name: cutChars(asString(t?.name), 120),
      status: cutChars(asString(t?.status), 40),
      summary: truncateSummary(t?.summary, REPORT_ITEM_LIMIT),
    }))
  }
  return out
}

/**
 * 命中记录只留工具名 + 一个 basename/子命令，不把完整命令、路径或秘密写进状态。
 * 这是审计摘要，不是可回放的日志。
 */
export function sanitizeGuardHit(text) {
  const parts = asString(text).trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  const tool = parts[0].replace(/:$/, '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32) || 'tool'
  const detail = parts[1] ?? ''
  // 受保护路径/秘密形态一律不落状态文件；只留工具名。
  if (/(?:^|[\\/._-])(?:ssh|aws|dsh|dsh-fish|shadow|id_rsa|id_ed25519|token|secret|passwd)(?:[\\/._-]|$)/i.test(detail)) {
    return cutChars(tool, GUARD_HIT_CHARS)
  }
  const base = detail.split(/[\\/]/).filter(Boolean).pop() ?? detail
  const safe = base.replace(/[^A-Za-z0-9_.@-]/g, '').slice(0, 32)
  return cutChars(safe ? `${tool} ${safe}` : tool, GUARD_HIT_CHARS)
}

/** 纯函数：从终态输入映射 WorkUnit 状态。 */
export function mapSettlement({ stopReason, structured, requestedSchema = false, closingText = '' } = {}) {
  const report = structured && typeof structured === 'object' && !Array.isArray(structured)
    ? sanitizeReport(structured)
    : null
  const summary = truncateSummary(report?.summary || closingText || '')
  let status = 'unknown'
  let failureKind = null

  if (requestedSchema && report === null) {
    // 请求了结构化结果却没拿到：宿主可能把 stopReason 强制成 error。
    // 无论它写成什么，都按评审失败记，不猜成功。
    status = 'failed'
    failureKind = 'structured-missing-or-error'
  } else if (stopReason === 'completed') {
    const blockers = Array.isArray(report?.blockers) ? report.blockers : []
    status = report?.done === false || blockers.length > 0 ? 'blocked' : 'done'
  } else if (stopReason === 'aborted') {
    status = 'aborted'
  } else if (stopReason === 'max-tokens' || stopReason === 'refusal' || stopReason === 'error') {
    status = 'failed'
    failureKind = stopReason
  } else if (stopReason === 'unknown' || stopReason == null) {
    status = 'unknown'
  }

  return {
    status,
    stopReason: stopReason ?? null,
    failureKind,
    summary,
    report,
  }
}

let seq = 0

/** WorkUnit id：时间 + 进程内序号 + 随机尾，避免同毫秒碰撞。 */
export function newUnitId(at = Date.now()) {
  seq = (seq + 1) % 1296
  const t = Number.isFinite(Number(at)) ? Number(at) : Date.now()
  return `wu_${t.toString(36)}${seq.toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function normalizeUnits(raw) {
  if (!isObject(raw) || !Array.isArray(raw.units)) return { version: 1, units: [] }
  return {
    version: 1,
    units: raw.units.filter(isObject).map((u) => ({
      ...u,
      guardHits: Array.isArray(u.guardHits) ? u.guardHits.slice(0, GUARD_HIT_LIMIT) : [],
    })),
  }
}

function normalizeSessions(raw) {
  return isObject(raw) ? raw : {}
}

function pruneSessions(sessions) {
  const rows = Object.entries(sessions)
  if (rows.length <= SESSION_LIMIT) return sessions
  rows.sort((a, b) => Date.parse(b[1]?.lastUsedAt ?? 0) - Date.parse(a[1]?.lastUsedAt ?? 0))
  return Object.fromEntries(rows.slice(0, SESSION_LIMIT))
}

function pruneUnits(units) {
  if (units.length <= UNIT_LIMIT) return units
  const active = []
  const settled = []
  for (const u of units) {
    if (u.status === 'queued' || u.status === 'running') active.push(u)
    else settled.push(u)
  }
  // 已结算的按 createdAt 从旧到新排；先丢最旧的，直到总数不超限。
  settled.sort((a, b) => Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0))
  const room = Math.max(0, UNIT_LIMIT - active.length)
  return [...active, ...settled.slice(Math.max(0, settled.length - room))]
}

/**
 * @param {{ root: string, now?: () => number, log?: Function, looksLikeSecret?: Function }} opts
 */
export function createWorkState({ root, now = Date.now, log, looksLikeSecret } = {}) {
  const sessionsPath = join(root, 'work-sessions.json')
  const unitsPath = join(root, 'work-units.json')
  let chain = Promise.resolve()

  function serial(fn) {
    const p = chain.then(fn, fn)
    chain = p.catch(() => {})
    return p
  }

  function secret(text) {
    try {
      const r = looksLikeSecret?.(text)
      return r === true || r?.hit === true
    } catch {
      return false
    }
  }

  function readSessions() {
    return normalizeSessions(readJsonSync(sessionsPath, {}))
  }

  function readUnits() {
    return normalizeUnits(readJsonSync(unitsPath, { version: 1, units: [] }))
  }

  async function writeSessions(sessions) {
    await writeAtomic(sessionsPath, JSON.stringify(pruneSessions(sessions), null, 2), 0o600)
  }

  async function writeUnits(units) {
    await writeAtomic(unitsPath, JSON.stringify({ version: 1, units: pruneUnits(units) }, null, 2), 0o600)
  }

  async function mutateSessions(fn) {
    return serial(async () => {
      const sessions = normalizeSessions(await readJson(sessionsPath, {}))
      const result = await fn(sessions)
      await writeSessions(sessions)
      return result
    })
  }

  async function createUnit(input = {}) {
    return serial(async () => {
      const data = normalizeUnits(await readJson(unitsPath, { version: 1, units: [] }))
      const at = iso(now())
      const unit = {
        id: asString(input.id) || newUnitId(now()),
        dir: asString(input.dir),
        bossSessionId: asString(input.bossSessionId),
        bossKind: input.bossKind === 'agent' ? 'agent' : 'fish',
        backend: input.backend === 'team' ? 'team' : 'subagent',
        kind: input.kind === 'teammate' ? 'teammate' : 'worker',
        mode: input.mode === 'build' ? 'build' : input.mode === 'inspect' ? 'inspect' : null,
        label: cutChars(asString(input.label), 120),
        reviewOf: input.reviewOf ? asString(input.reviewOf) : null,
        followUpOf: input.followUpOf ? asString(input.followUpOf) : null,
        status: 'queued',
        stopReason: null,
        failureKind: null,
        summary: '',
        report: null,
        guardHits: [],
        backendRef: input.childId ? { childId: asString(input.childId) } : null,
        createdAt: at,
        updatedAt: at,
        settledAt: null,
      }
      data.units.push(unit)
      await writeUnits(data.units)
      return unit
    })
  }

  async function updateUnit(id, patch = {}) {
    return serial(async () => {
      const data = normalizeUnits(await readJson(unitsPath, { version: 1, units: [] }))
      const unit = data.units.find((u) => u.id === id)
      if (!unit) return null
      Object.assign(unit, patch, { updatedAt: iso(now()) })
      await writeUnits(data.units)
      return unit
    })
  }

  async function settleUnit(id, settlement = {}) {
    return serial(async () => {
      const data = normalizeUnits(await readJson(unitsPath, { version: 1, units: [] }))
      const unit = data.units.find((u) => u.id === id)
      if (!unit || TERMINAL.has(unit.status)) return null
      const mapped = mapSettlement(settlement)
      const reportText = mapped.report ? JSON.stringify(mapped.report) : ''
      const leak = secret(mapped.summary) || (reportText !== '' && secret(reportText))
      const summary = leak ? '详情在电脑上' : mapped.summary
      Object.assign(unit, {
        status: mapped.status,
        stopReason: mapped.stopReason,
        failureKind: mapped.failureKind,
        summary,
        report: leak ? null : mapped.report,
        settledAt: iso(now()),
        updatedAt: iso(now()),
      })
      await writeUnits(data.units)
      return unit
    })
  }

  async function appendGuardHit(id, hit) {
    return serial(async () => {
      const data = normalizeUnits(await readJson(unitsPath, { version: 1, units: [] }))
      const unit = data.units.find((u) => u.id === id)
      if (!unit || TERMINAL.has(unit.status)) return false
      const text = sanitizeGuardHit(hit)
      if (!text) return false
      unit.guardHits = Array.isArray(unit.guardHits) ? unit.guardHits : []
      if (unit.guardHits.length < GUARD_HIT_LIMIT) {
        unit.guardHits.push(text)
      }
      unit.updatedAt = iso(now())
      await writeUnits(data.units)
      return true
    })
  }

  function unitsForBoss(sessionId) {
    const sid = asString(sessionId)
    return readUnits().units.filter((u) => u.bossSessionId === sid)
  }

  function unitsForDir(dir) {
    const d = asString(dir)
    return readUnits().units.filter((u) => u.dir === d)
  }

  function activeCounts(bossSessionId) {
    const sid = asString(bossSessionId)
    const units = readUnits().units.filter((u) => u.bossSessionId === sid)
    const active = units.filter((u) => u.status === 'queued' || u.status === 'running')
    return {
      active: active.length,
      build: active.filter((u) => u.mode === 'build').length,
    }
  }

  async function reconcileRunning() {
    return serial(async () => {
      const data = normalizeUnits(await readJson(unitsPath, { version: 1, units: [] }))
      let changed = 0
      for (const unit of data.units) {
        if (unit.status === 'queued' || unit.status === 'running') {
          unit.status = 'unknown'
          unit.updatedAt = iso(now())
          changed += 1
        }
      }
      if (changed) await writeUnits(data.units)
      return changed
    })
  }

  function status() {
    const units = readUnits().units
    const by = {}
    for (const u of units) by[u.status] = (by[u.status] ?? 0) + 1
    return {
      sessions: Object.keys(readSessions()).length,
      units: units.length,
      byStatus: by,
      unknown: by.unknown ?? 0,
      path: unitsPath,
    }
  }

  return {
    sessionsPath,
    unitsPath,
    readSessions,
    mutateSessions,
    readUnits,
    createUnit,
    updateUnit,
    settleUnit,
    appendGuardHit,
    unitsForBoss,
    unitsForDir,
    activeCounts,
    reconcileRunning,
    status,
  }
}

/** 同步读 JSON：纯读取入口用；坏文件另存 .corrupt-* 后按 fallback 处理。 */
function readJsonSync(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback
    if (err instanceof SyntaxError) {
      try { renameSync(file, `${file}.corrupt.${Date.now()}`) } catch { /* ignore */ }
      return fallback
    }
    throw err
  }
}
