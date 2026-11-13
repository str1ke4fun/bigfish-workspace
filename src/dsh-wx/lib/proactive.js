/**
 * 每群主动额度：不等人 @，每天也能接几句。
 *
 * 语义（与 2026-11-12 设计一致）：
 *   - 只对 allowChats 里的群生效；生效额度 = proactiveChats[群] ?? proactivePerDay；
 *   - 范围 0..50，0 表示不主动；
 *   - 被 @ 的窗口内、noMentionChats、以及没开 requireMention 时，都不消耗额度；
 *   - 状态按本地日期存 `{ day, used: { 群名: 条数 } }`，跨天清空；
 *   - 读不到 / 坏文件一律按「今天 0 条」处理，宁可少说，不绕过 @ 闸。
 *
 * 纯模块：所有判定不读写文件，读写只有 loadState / saveState 两个入口。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const STATE_FILE = process.env.WX_PROACTIVE_STATE || '/home/str1k3/.dsh-wx/proactive.json'
export const MAX_PER_DAY = 50

const pad = (n) => String(n).padStart(2, '0')

/** 本地日期键，跨天以本地午夜为界（和台账、日记一致）。 */
export function dateKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 额度兜底：NaN / 负数落 0，超过 50 按 50。 */
export function parseQuota(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.min(MAX_PER_DAY, Math.max(0, Math.round(n)))
}

/** 把 policy.json 的两个主动额度键归一；显式 0 保留，空群名丢掉。 */
export function normalizeProactive(raw = {}) {
  const map = raw?.proactiveChats
  const chats = {}
  if (map && typeof map === 'object') {
    for (const [k, v] of Object.entries(map)) {
      const name = String(k).trim()
      if (name) chats[name] = parseQuota(v)
    }
  }
  return { proactivePerDay: parseQuota(raw?.proactivePerDay), proactiveChats: chats }
}

/** 这个群今天最多能主动说几条。群覆盖优先于默认值，0 也是有效覆盖。 */
export function quotaFor(policy, chat) {
  const key = String(chat ?? '')
  const map = policy?.proactiveChats
  const has = map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, key)
  return parseQuota(has ? map[key] : policy?.proactivePerDay)
}

const empty = (day, ok = true) => ({ ok, day, used: {} })

/**
 * 读状态。ENOENT 是第一天，按空账本；坏 JSON/权限/形状不对返回 `ok:false`，
 * 由发送闸拒绝主动发言——宁可少说，也不因为文件坏了把额度重置成满额。
 */
export function loadState(file = STATE_FILE, now = Date.now()) {
  const today = dateKey(now)
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!raw || typeof raw !== 'object' || raw.day !== today) return empty(today)
    const used = {}
    if (raw.used && typeof raw.used === 'object') {
      for (const [k, v] of Object.entries(raw.used)) {
        const n = Number(v)
        if (k && Number.isFinite(n) && n > 0) used[k] = Math.floor(n)
      }
    } else if (raw.used !== undefined) {
      return empty(today, false)
    }
    return { ok: true, day: today, used }
  } catch (err) {
    if (err?.code === 'ENOENT') return empty(today)
    return empty(today, false)
  }
}

/** tmp + rename 写回；失败只返回 false，不影响发送。 */
export function saveState(state, file = STATE_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 今天这个群已经用了几条。 */
function usedToday(state, chat, today) {
  if (!state || state.day !== today || !state.used) return 0
  const n = Number(state.used[String(chat ?? '')])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 今天这个群还剩几条。状态不可信时按 0 算，主动路径因此被关死。 */
export function remaining(policy, state, chat, today = dateKey()) {
  if (state?.ok === false) return 0
  return Math.max(0, quotaFor(policy, chat) - usedToday(state, chat, today))
}

/** 扣一条，返回新的 state 与剩余；额度为 0 / 状态不可信时原样返回。纯函数，不写盘。 */
export function consume(policy, state, chat, today = dateKey()) {
  const left = remaining(policy, state, chat, today)
  if (left <= 0) return { state, left: 0 }
  const key = String(chat ?? '')
  const used = state?.day === today ? { ...state.used } : {}
  used[key] = usedToday(state, key, today) + 1
  return { state: { ok: true, day: today, used }, left: left - 1 }
}

/**
 * 发送闸的纯判定：
 *   requireMention === false / exempt / @ 窗口内 → 放行且不主动；
 *   状态不可信 → 拒绝主动（@ 窗口/免 @ 仍放行）；
 *   否则有额度 → 放行且主动；没额度 → 拒绝（带上 @ 闸原来的原因）。
 */
export function decideProactive({ policy, state, chat, mention, exempt, now = Date.now() }) {
  const today = dateKey(now)
  const left = remaining(policy, state, chat, today)
  if (policy?.requireMention === false || exempt || mention?.ok) {
    return { ok: true, proactive: false, left }
  }
  if (state?.ok === false) {
    return { ok: false, proactive: false, left: 0, why: '主动额度状态读不出来' }
  }
  if (left <= 0) {
    return { ok: false, proactive: false, left: 0, why: mention?.reason || '最近没人 @ 你' }
  }
  return { ok: true, proactive: true, left }
}
