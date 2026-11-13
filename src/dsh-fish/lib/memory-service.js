/**
 * memory-service.js —— `fishCore.memory`：事件流的唯一写/读门面
 *
 * 设计 §5.2 / §5.5。这里只做三件事：
 *   1. 把调用方给的 channel/surface 解析成一条明确的事件字段（不靠猜测兜底）；
 *   2. 所有写入都经 `store.appendEvent`（内部 validateEvent），失败返回
 *      `{ok:false, why}`，绝不把异常抛给工具层；
 *   3. 读与派生共用 `store.readEvents` / `derive.deriveSelf`，不另起一套口径。
 *
 * 零依赖；不 import `selfdoc.js`——身份文档刷新由 `provideFishCore` 注入，
 * 这样 core-service 不必知道 selfdoc 的存在，测试也能直接数刷新次数。
 */

import { channelOfAgent, appendEvent, readEvents, paths } from './store.js'
import { validateEvent, HER_TYPES, SURFACES } from './schema.js'
import { deriveSelf } from './derive.js'
import { similarity, ECHO_MIN_SIM } from './similarity.js'

const DAY_MS = 86_400_000
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 2000

/** 写入后需要刷新身份文档的类型（设计 §5.5 + A1.2 主控裁定）。meta 不在其中。 */
const REFRESH_TYPES = new Set([
  'seed', 'saw', 'voice', 'bili_reply', 'utterance', 'revise', 'narration',
  // v4：她写下人物笔记后，fish:owner / 关于他.md 也要跟着刷新。
  'person_note',
])

/** 错误 → 人可读的 why；带 code 的错误保留 code，方便日志/测试直接匹配。 */
function whyOf(err) {
  const msg = String(err?.message ?? err)
  const code = typeof err?.code === 'string' ? err.code : ''
  if (code && !msg.includes(code)) return `${code}: ${msg}`.slice(0, 240)
  return msg.slice(0, 240)
}

/** ISO 字符串 / Date / epoch 数字 → 毫秒；无法解析返回 null（调用方忽略）。 */
function toMs(value) {
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isFinite(t) ? t : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const s = value.trim()
    const t = Date.parse(s)
    if (Number.isFinite(t)) return t
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function agentSurface(core, agent) {
  if (!agent) return null
  try {
    return core?.surface?.current?.(agent) ?? null
  } catch {
    return null
  }
}

/**
 * surface 解析。
 *
 * 一般类型：opts.surface > agent 推断 > 'core'。
 * bili_reply 是例外：它在 schema 里必须显式写 surface（否则 BAD_SURFACE）。
 * 门面若在这里把缺省值补成 'core'，等于替调用方绕过那条守卫，所以缺省时返回
 * undefined，由 prepare() 拒掉；合法的 raw.surface 也算显式来源（兼容系统侧
 * 直接构造事件对象的老写法）。
 */
function resolveSurface(core, opts, raw, type) {
  if (opts.surface !== undefined && opts.surface !== null) return opts.surface
  if (type === 'bili_reply') {
    const rawSurface = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.surface : undefined
    if (rawSurface !== undefined && rawSurface !== null && SURFACES.includes(rawSurface)) {
      return rawSurface
    }
  }
  const fromAgent = agentSurface(core, opts.agent)
  if (fromAgent !== null && fromAgent !== undefined) return fromAgent
  if (type === 'bili_reply') return undefined
  return 'core'
}

function resolveChannel(opts, surface, agent) {
  // channel：opts.channel > (B 站公开事实 → core) > channelOfAgent(agent) > 'core'
  // B 站 cwd 会让 channelOfAgent 返回 'web'；按 §5.2 公开内容必须写 core。
  let channel = opts.channel
  if (channel === undefined || channel === null) {
    if (surface === 'bili') channel = 'core'
    else if (agent) channel = channelOfAgent(agent)
    else channel = 'core'
  }
  if (channel === undefined || channel === null) channel = 'core'
  return channel
}

/**
 * 解析 + 预检。append 与 validate 共用，保证「自检看到的失败」和写入一致。
 * @returns {{ok:true, raw:object, source:string, ctx:object}|{ok:false, why:string}}
 */
function prepare(raw, opts = {}) {
  const source = opts.source ?? 'system'

  const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
  const type = isObject ? String(raw.type ?? '') : ''
  // 工具侧的窄门先判，避免把「她不能写系统类型」伪装成一次 BAD_TYPE。
  // 非对象的 raw 交给 validateEvent 报 BAD_SHAPE。
  if (source === 'tool' && isObject && !HER_TYPES.includes(type)) {
    return { ok: false, why: 'NOT_HER_TYPE' }
  }

  const surface = resolveSurface(opts.core, opts, raw, type)
  // bili_reply 没有显式 surface（opts / 合法 raw / agent）时不能补 core，
  // 否则 schema 的显式守卫就被门面绕过了。直接拒绝、不写盘。
  if (surface === undefined) return { ok: false, why: 'BAD_SURFACE' }
  const channel = resolveChannel(opts, surface, opts.agent)

  return {
    ok: true,
    // 关键：channel/surface 必须合进 raw。validateEvent 只从 raw 读 surface，
    // 只放在 opts 里会被静默丢掉，事件就会落错面。
    raw: isObject ? { ...raw, channel, surface } : raw,
    source,
    ctx: { day: opts.day, stage: opts.stage, source },
  }
}

async function loadKnownIds(root, type) {
  // person_note 的 refs/supersedes/revokes 同样做存在性校验；否则 fishCore.memory
  // 的 validate 路径会绕过 schema 的 knownIds 守卫（合并裁决 D18/C12）。
  if (type !== 'revise' && type !== 'narration' && type !== 'person_note') return null
  try {
    const { events } = await readEvents(root)
    return new Set(events.map((e) => e.id).filter(Boolean))
  } catch {
    return null
  }
}

/**
 * @param {{
 *   root?: string,
 *   core?: object,
 *   refreshSelfDoc?: (root: string) => Promise<any>,
 * }} [options]
 */
export function createMemoryService({ root, core, refreshSelfDoc: injectedRefresh } = {}) {
  const baseRoot = root || paths().root

  async function refresh() {
    if (typeof injectedRefresh !== 'function') return { ok: false, why: 'NO_REFRESH' }
    try {
      const result = await injectedRefresh(baseRoot)
      if (result && typeof result === 'object' && 'ok' in result) return result
      return { ok: true }
    } catch (err) {
      return { ok: false, why: whyOf(err) }
    }
  }

  async function append(raw, opts = {}) {
    const prepared = prepare(raw, { ...opts, core })
    if (!prepared.ok) return { ok: false, why: prepared.why }

    let event
    try {
      event = await appendEvent(prepared.raw, prepared.ctx, baseRoot)
    } catch (err) {
      return { ok: false, why: whyOf(err) }
    }

    // 写入是既成事实。刷新失败只影响身份文档是否最新，不能反悔这条事件。
    if (REFRESH_TYPES.has(event.type)) await refresh().catch(() => {})
    return { ok: true, event }
  }

  async function validate(raw, opts = {}) {
    const prepared = prepare(raw, { ...opts, core })
    if (!prepared.ok) return { ok: false, why: prepared.why }

    try {
      const type = prepared.raw?.type
      const knownIds = await loadKnownIds(baseRoot, type)
      const event = validateEvent(prepared.raw, { ...prepared.ctx, knownIds })
      return { ok: true, event }
    } catch (err) {
      return { ok: false, why: whyOf(err) }
    }
  }

  function commit(text, {
    type = 'utterance', refs = [], verdict, confidence, agent, surface, channel,
    person, supersedes, revokes, flags,
  } = {}) {
    const raw = { type, text, refs }
    if (verdict !== undefined) raw.verdict = verdict
    if (confidence !== undefined) raw.confidence = confidence
    // v4：person_note 的认知字段；其它类型由 schema 丢掉，不会长野字段。
    if (person !== undefined) raw.person = person
    if (supersedes !== undefined) raw.supersedes = supersedes
    if (revokes !== undefined) raw.revokes = revokes
    if (flags !== undefined) raw.flags = flags
    // surface/channel 显式传入优先（B 站公开言论：surface='bili'、channel='core'）；
    // 不传时仍按 agent 推断，老调用点不受影响。
    return append(raw, { source: 'tool', agent, surface, channel })
  }

  function appendSystem(type, text, opts = {}) {
    if (HER_TYPES.includes(String(type ?? ''))) return { ok: false, why: 'NOT_SYSTEM_TYPE' }
    // opts 里除 source 外的事件字段（refs/reply/flags/ts…）一起进 raw；
    // channel/surface/agent/day/stage 既可能属于 raw 也可能属于 ctx，两边都带无害。
    const { source: _ignored, ...rest } = opts
    const raw = { ...rest, type, text }
    return append(raw, { ...rest, source: 'system' })
  }

  async function read({
    since,
    until,
    types,
    channel,
    surface,
    limit = DEFAULT_LIMIT,
    includeMeta = false,
  } = {}) {
    let events
    try {
      events = (await readEvents(baseRoot)).events
    } catch {
      return []
    }

    const sinceMs = toMs(since)
    const untilMs = toMs(until)
    const hasWindow = sinceMs !== null || untilMs !== null
    const typeSet = types == null ? null : new Set(Array.isArray(types) ? types : [types])

    const out = []
    for (const ev of events) {
      if (!includeMeta && ev.type === 'meta') continue
      if (typeSet && !typeSet.has(ev.type)) continue
      // 老事件没有 channel 字段——仓里所有读方的约定是 `channel ?? 'core'`。
      // 这里既按同一口径过滤，也把补出来的 channel 交给调用方，避免下游再各自兜底。
      const ch = ev.channel ?? 'core'
      if (channel != null && ch !== channel) continue
      if (surface != null && ev.surface !== surface) continue

      if (hasWindow) {
        const t = Date.parse(typeof ev.ts === 'string' ? ev.ts : '')
        if (!Number.isFinite(t)) continue
        if (sinceMs !== null && t < sinceMs) continue
        if (untilMs !== null && t > untilMs) continue
      }
      out.push(ev.channel == null ? { ...ev, channel: ch } : ev)
    }

    const n = Number(limit)
    const cap = Number.isFinite(n) ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n))) : DEFAULT_LIMIT
    return out.slice(0, cap)
  }

  /**
   * 全量事件（含 meta）。
   *
   * 为什么单独开一个方法：`read()` 的 2000 上限是给人看的召回窗口，
   * 但面插件的去重/配额要看到完整历史（例如回复去重会扫所有 `bili_reply`）。
   * 让它们拿 `read({limit:'all'})` 会把“召回范围”和“账本”混成一条路径。
   */
  async function readAll() {
    try {
      return (await readEvents(baseRoot)).events
    } catch {
      return []
    }
  }

  async function derive({ now, growthDays, viewSurface } = {}) {
    const { events } = await readEvents(baseRoot)
    return deriveSelf(events, { now, growthDays, viewSurface })
  }

  async function findEcho(text, { days = 7, now } = {}) {
    let events
    try {
      events = (await readEvents(baseRoot)).events
    } catch {
      return null
    }

    // now 接受 epoch / Date / ISO，非法时退回此刻。
    const nowMs = toMs(now) ?? Date.now()
    const d = Number(days)
    const windowDays = Number.isFinite(d) ? Math.max(0, d) : 7
    const cutoff = nowMs - windowDays * DAY_MS

    let best = null
    let bestSim = -1
    for (const ev of events) {
      if (ev.type !== 'voice' && ev.type !== 'utterance') continue
      const t = Date.parse(typeof ev.ts === 'string' ? ev.ts : '')
      if (!Number.isFinite(t) || t < cutoff || t > nowMs) continue
      const score = similarity(text, ev.text)
      if (score >= ECHO_MIN_SIM && score > bestSim) {
        best = ev
        bestSim = score
      }
    }
    return best
  }

  async function eventById(id) {
    if (typeof id !== 'string' || id === '') return null
    try {
      const { events } = await readEvents(baseRoot)
      return events.find((e) => e.id === id) ?? null
    } catch {
      return null
    }
  }

  return {
    append,
    commit,
    appendSystem,
    validate,
    read,
    readAll,
    derive,
    refreshSelfDoc: refresh,
    similarity,
    findEcho,
    eventById,
  }
}
