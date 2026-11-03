/**
 * tasks.js —— 微信请求池 / 任务板
 *
 * 为什么要有它：
 *   现在的耳朵把一轮命中的会话合并成一条通知，投递成功只记 `seen`。
 *   「她回没回」「回到哪一步」「另一个群是不是被忘了」都没有地方记。
 *   任务板把「待回」变成可重放的状态，而不是模型记忆里的一句话。
 *
 * 三条约束：
 *   1. 只追加。tasks.jsonl 一行一次状态迁移，启动时重放得到当前状态。
 *   2. 同一会话同一时刻最多一个活动任务；新消息追加到它，不另开一份。
 *   3. 入站去重靠 dedupeKey。同一条消息不会生成两个任务。
 *
 * 这里不发送、不读屏、不管 GUI；只负责「有什么要回、回到哪了」。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const TASKS_FILE = '/home/str1k3/.dsh-wx/tasks.jsonl'
export const TASK_SCHEMA_VERSION = 1
/** 默认 15 分钟没动就进逾期视图。 */
export const DEFAULT_CHECK_MS = 15 * 60_000
/** 租约：防止同一任务被两个循环同时领走。 */
export const DEFAULT_LEASE_MS = 2 * 60_000

export const ACTIVE_STATUSES = Object.freeze(['new', 'reading', 'replying', 'waiting', 'blocked'])
const ACTIVE = new Set(ACTIVE_STATUSES)
const UNFINISHED = new Set(['new', 'reading', 'replying', 'waiting'])

const str = (v) => String(v ?? '').trim()
const timeOf = (iso, fallback = 0) => {
  const t = Date.parse(String(iso ?? ''))
  return Number.isFinite(t) ? t : fallback
}

const addMinutes = (iso, ms) => new Date(timeOf(iso, Date.now()) + ms).toISOString()

/** 新建任务时把入站消息变成一个稳定的去重键。 */
export function inboundKey(chatId, msgId) {
  return `in:${str(chatId)}:${str(msgId)}`
}

/** 空状态。重放和新建共用，保证字段形状一致。 */
function blank() {
  return {
    taskId: '',
    chatId: '',
    chatName: '',
    requester: { name: null, kind: 'unknown', confidence: 'unknown' },
    reason: '',
    status: 'new',
    priority: 50,
    createdAt: '',
    updatedAt: '',
    firstInboundMsgId: '',
    lastInboundMsgId: '',
    lastOutboundMsgId: '',
    lastText: '',
    inboundCount: 0,
    replyCount: 0,
    nextCheckAt: '',
    lease: null,
    attempts: 0,
    overdueCount: 0,
    lastRemindedAt: '',
    notes: [],
    dedupeKeys: [],
    blockedWhy: '',
    uncertain: false,
    final: false,
  }
}

/** 重放一条记录。坏记录跳过，不影响别的任务。 */
function apply(state, rec) {
  const id = str(rec?.taskId)
  if (!id) return
  const type = str(rec.type)
  if (type === 'create') {
    if (state.has(id)) return // 同一个 id 只认第一次 create
    const t = blank()
    t.taskId = id
    t.chatId = str(rec.chatId)
    t.chatName = str(rec.chatName)
    t.requester = {
      name: rec.requester?.name === null || rec.requester?.name === undefined ? null : str(rec.requester.name) || null,
      kind: str(rec.requester?.kind) || 'unknown',
      confidence: str(rec.requester?.confidence) || 'unknown',
    }
    t.reason = str(rec.reason)
    t.status = 'new'
    t.priority = Number(rec.priority) || 50
    t.createdAt = str(rec.at)
    t.updatedAt = t.createdAt
    t.firstInboundMsgId = str(rec.inboundMsgId)
    t.lastInboundMsgId = str(rec.inboundMsgId)
    t.lastText = str(rec.text)
    t.inboundCount = rec.inboundMsgId ? 1 : 0
    t.nextCheckAt = str(rec.nextCheckAt) || addMinutes(rec.at, DEFAULT_CHECK_MS)
    if (rec.dedupeKey) t.dedupeKeys.push(str(rec.dedupeKey))
    state.set(id, t)
    return
  }

  const t = state.get(id)
  if (!t) return
  const at = str(rec.at)
  if (at) t.updatedAt = at

  if (type === 'inbound') {
    if (rec.dedupeKey && t.dedupeKeys.includes(str(rec.dedupeKey))) return
    if (rec.dedupeKey) t.dedupeKeys.push(str(rec.dedupeKey))
    t.lastInboundMsgId = str(rec.msgId) || t.lastInboundMsgId
    if (rec.text) t.lastText = str(rec.text)
    if (rec.requester?.name) {
      t.requester = {
        name: str(rec.requester.name),
        kind: str(rec.requester.kind) || t.requester.kind,
        confidence: str(rec.requester.confidence) || t.requester.confidence,
      }
      if (rec.reason) t.reason = str(rec.reason)
    }
    t.inboundCount += 1
    // 对方又说话了：未读数变了，重新开始计逾期；提醒计数也重新算。
    t.overdueCount = 0
    t.lastRemindedAt = ''
    // 在等对方接话时又来了新话：重新变成要处理；blocked / replying 保持原状态。
    if (t.status === 'waiting') t.status = 'new'
    if (t.status === 'new' && at) t.nextCheckAt = addMinutes(at, DEFAULT_CHECK_MS)
    return
  }
  if (type === 'claim') {
    t.status = 'reading'
    t.attempts += 1
    t.lease = { owner: str(rec.owner) || 'wx', until: str(rec.leaseUntil) }
    return
  }
  if (type === 'release') {
    t.lease = null
    return
  }
  if (type === 'reply') {
    t.status = 'replying'
    t.replyCount += 1
    t.lastOutboundMsgId = str(rec.msgId) || t.lastOutboundMsgId
    if (rec.final === true) t.final = true
    if (rec.nextCheckAt) t.nextCheckAt = str(rec.nextCheckAt)
    return
  }
  if (type === 'done') {
    t.status = 'done'
    t.lease = null
    t.nextCheckAt = ''
    if (rec.note) t.notes.push(str(rec.note).slice(0, 500))
    return
  }
  if (type === 'snooze') {
    t.status = 'waiting'
    t.lease = null
    t.nextCheckAt = str(rec.nextCheckAt)
    return
  }
  if (type === 'block') {
    t.status = 'blocked'
    t.lease = null
    t.blockedWhy = str(rec.why).slice(0, 500)
    t.uncertain = rec.uncertain === true
    return
  }
  if (type === 'unblock') {
    if (t.status === 'blocked') t.status = 'new'
    t.blockedWhy = ''
    t.uncertain = false
    if (at) t.nextCheckAt = addMinutes(at, DEFAULT_CHECK_MS)
    return
  }
  if (type === 'note') {
    if (rec.note) {
      t.notes.push(str(rec.note).slice(0, 500))
      if (t.notes.length > 20) t.notes.splice(0, t.notes.length - 20)
    }
    return
  }
  if (type === 'check') {
    if (rec.nextCheckAt) t.nextCheckAt = str(rec.nextCheckAt)
    return
  }
  if (type === 'remind') {
    t.overdueCount = Math.max(0, Number(rec.level) || t.overdueCount + 1)
    t.lastRemindedAt = at
    if (rec.nextCheckAt) t.nextCheckAt = str(rec.nextCheckAt)
    if (rec.note) {
      t.notes.push(str(rec.note).slice(0, 500))
      if (t.notes.length > 20) t.notes.splice(0, t.notes.length - 20)
    }
    return
  }
}

function readRecords(file, log) {
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const v = JSON.parse(s)
      if (v && typeof v === 'object') out.push(v)
      else log?.(`任务板跳过非对象行：${file}`)
    } catch {
      log?.(`任务板跳过坏行：${file}`)
    }
  }
  return out
}

/**
 * @param {object} [opts]
 * @param {string} [opts.file]
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createTaskBoard({ file = TASKS_FILE, now = Date.now, log } = {}) {
  let states = new Map()
  let dedupe = new Map() // dedupeKey -> taskId

  const rebuild = () => {
    states = new Map()
    dedupe = new Map()
    for (const rec of readRecords(file, log)) {
      apply(states, rec)
      if (rec?.type === 'create' || rec?.type === 'inbound') {
        const key = str(rec.dedupeKey)
        if (key) dedupe.set(key, str(rec.taskId))
      }
    }
  }
  rebuild()

  const iso = (t) => new Date(Number(t) || 0).toISOString()

  const commit = (rec) => {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      appendFileSync(file, JSON.stringify({ v: TASK_SCHEMA_VERSION, ...rec }) + '\n', { mode: 0o600 })
    } catch (err) {
      log?.('任务板写盘失败', err)
      return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
    }
    apply(states, rec)
    const key = str(rec.dedupeKey)
    if (key && (rec.type === 'create' || rec.type === 'inbound')) dedupe.set(key, str(rec.taskId))
    return { ok: true }
  }

  /** 同一会话当前还没结束的任务。 */
  function activeForChat(chatId) {
    const id = str(chatId)
    return [...states.values()]
      .filter((t) => t.chatId === id && ACTIVE.has(t.status))
      .sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt))[0] ?? null
  }

  /**
   * 建任务。三种结果：
   *   - 这个 dedupeKey 已经见过 → duplicate，返回原任务；
   *   - 这个会话已有活动任务 → 追加一条 inbound，返回原任务（added: true）；
   *   - 都没有 → 新建。
   */
  function create({
    chatId, chatName = '', requester = {}, reason = '', inboundMsgId = '', text = '',
    dedupeKey = '', priority = 50, at = iso(now()),
  } = {}) {
    const cid = str(chatId)
    if (!cid) return { ok: false, why: 'chatId 为空' }
    const key = str(dedupeKey) || (inboundMsgId ? inboundKey(cid, inboundMsgId) : '')
    if (key) {
      const hitId = dedupe.get(key)
      if (hitId && states.has(hitId)) {
        return { ok: true, duplicate: true, task: states.get(hitId) }
      }
    }
    const active = activeForChat(cid)
    if (active) {
      const r = commit({
        type: 'inbound', taskId: active.taskId, msgId: str(inboundMsgId), text: str(text),
        dedupeKey: key, at, requester, reason: str(reason),
      })
      if (!r.ok) return r
      return { ok: true, added: true, task: states.get(active.taskId) }
    }

    const taskId = 't_' + randomUUID()
    const rec = {
      type: 'create',
      taskId,
      chatId: cid,
      chatName: str(chatName),
      requester: {
        name: requester?.name === null || requester?.name === undefined ? null : str(requester.name) || null,
        kind: str(requester?.kind) || 'unknown',
        confidence: str(requester?.confidence) || 'unknown',
      },
      reason: str(reason),
      priority: Number(priority) || 50,
      inboundMsgId: str(inboundMsgId),
      text: str(text).slice(0, 500),
      dedupeKey: key,
      nextCheckAt: addMinutes(at, DEFAULT_CHECK_MS),
      at,
    }
    const r = commit(rec)
    if (!r.ok) return r
    return { ok: true, created: true, task: states.get(taskId) }
  }

  function transition(taskId, type, fields = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    const at = str(fields.at) || iso(now())
    // 先展开 fields 再落 at：fields.at 可能是 undefined，放在后面会把算好的时间盖掉。
    return commit({ ...fields, type, taskId: t.taskId, at })
  }

  /** 领任务。租约过期或同一 owner 可重领。 */
  function claim(taskId, { owner = 'wx', ttlMs = DEFAULT_LEASE_MS, force = false } = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    if (t.status === 'done') return { ok: false, why: '这个任务已经结束了。' }
    const leased = t.lease && timeOf(t.lease.until) > now() && t.lease.owner !== owner
    if (leased && !force) return { ok: false, why: '这个任务正在被处理。' }
    const r = transition(t.taskId, 'claim', { owner, leaseUntil: new Date(now() + Math.max(5_000, Number(ttlMs) || DEFAULT_LEASE_MS)).toISOString() })
    if (!r.ok) return r
    return { ok: true, task: states.get(t.taskId) }
  }

  function release(taskId, { owner = 'wx' } = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    if (t.lease && t.lease.owner !== owner) return { ok: false, why: '这个任务不是你在处理。' }
    return transition(t.taskId, 'release')
  }

  /** 记一条出站。final 只是标记，不等于 done。 */
  function reply(taskId, { msgId = '', final = false, nextCheckAt = '', at } = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    if (t.status === 'done') return { ok: false, why: '这个任务已经结束了。' }
    const check = str(nextCheckAt) || new Date(now() + DEFAULT_CHECK_MS).toISOString()
    const r = transition(t.taskId, 'reply', { msgId: str(msgId), final: final === true, nextCheckAt: check, at })
    if (!r.ok) return r
    return { ok: true, task: states.get(t.taskId) }
  }

  function done(taskId, { note = '', at } = {}) {
    return transition(taskId, 'done', { note: str(note).slice(0, 500), at })
  }

  /** 暂时不催：到 until 之前不算逾期，状态是 waiting。 */
  function snooze(taskId, { minutes = 15, until = '', at } = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    if (t.status === 'done') return { ok: false, why: '这个任务已经结束了。' }
    const nextCheckAt = str(until) || new Date(now() + Math.max(1, Number(minutes) || 15) * 60_000).toISOString()
    return transition(t.taskId, 'snooze', { nextCheckAt, at })
  }

  function block(taskId, { why = '', uncertain = false, at } = {}) {
    return transition(taskId, 'block', { why: str(why).slice(0, 500), uncertain: uncertain === true, at })
  }

  function unblock(taskId, { at } = {}) {
    return transition(taskId, 'unblock', { at })
  }

  function note(taskId, text, { at } = {}) {
    return transition(taskId, 'note', { note: str(text).slice(0, 500), at })
  }

  function checkAt(taskId, isoAt) {
    return transition(taskId, 'check', { nextCheckAt: str(isoAt) })
  }

  /**
   * 记一次逾期提醒，并把下次检查时间往后推。
   * level 从 1 开始；到了上限由调用方 block，不在这里偷偷结束任务。
   */
  function markReminded(taskId, { level = 1, nextCheckAt = '', note = '', at } = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    if (t.status === 'done') return { ok: false, why: '这个任务已经结束了。' }
    const next = str(nextCheckAt) || new Date(now() + DEFAULT_CHECK_MS).toISOString()
    const r = transition(t.taskId, 'remind', {
      level: Math.max(1, Number(level) || 1), nextCheckAt: next, note: str(note).slice(0, 500), at,
    })
    if (!r.ok) return r
    return { ok: true, task: states.get(t.taskId) }
  }

  /** 到点还没处理、还没提醒满的任务（blocked 不催）。 */
  function overdueReminders({ at = now(), maxLevel = 3 } = {}) {
    return active().filter((t) => {
      if (t.status === 'blocked' || t.status === 'done') return false
      if (!UNFINISHED.has(t.status)) return false
      if (Number(t.overdueCount) >= Math.max(1, Number(maxLevel) || 3)) return false
      if (!t.nextCheckAt) return true
      return timeOf(t.nextCheckAt) <= at
    })
  }

  function get(taskId) {
    const t = states.get(str(taskId))
    return t ? { ...t, requester: { ...t.requester }, notes: [...t.notes], dedupeKeys: [...t.dedupeKeys] } : null
  }

  /** 所有没结束的任务，优先级高的、等得久的在前。 */
  function active() {
    return [...states.values()]
      .filter((t) => ACTIVE.has(t.status))
      .sort((a, b) => (b.priority - a.priority) || (timeOf(a.createdAt) - timeOf(b.createdAt)))
      .map((t) => get(t.taskId))
  }

  /** 逾期：还没结束、且 nextCheckAt 已过（或没设）。blocked 也算，但带原因。 */
  function overdue(at = now()) {
    return active().filter((t) => {
      if (!UNFINISHED.has(t.status) && t.status !== 'blocked') return false
      if (!t.nextCheckAt) return t.status !== 'blocked'
      return timeOf(t.nextCheckAt) <= at
    })
  }

  function byChat(chatId) {
    const id = str(chatId)
    return [...states.values()].filter((t) => t.chatId === id).map((t) => get(t.taskId))
  }

  /** 每轮 system prompt 里的摘要；没有任务时返回空串。 */
  function summary({ max = 5, at = now() } = {}) {
    const rows = active().slice(0, Math.max(1, Number(max) || 5))
    if (!rows.length) return ''
    const waited = (t) => {
      const ms = Math.max(0, at - timeOf(t.updatedAt || t.createdAt, at))
      const m = Math.round(ms / 60_000)
      return m < 1 ? '刚刚' : m < 60 ? `已等 ${m} 分钟` : `已等 ${Math.floor(m / 60)} 小时`
    }
    const who = (t) => {
      const name = t.requester?.name ?? ''
      const kind = t.requester?.kind
      const why = t.reason ? `（${t.reason}）` : ''
      return (name || '发言人未识别') + why
    }
    const status = (t) => {
      if (t.status === 'blocked') return `卡住：${t.blockedWhy || '需要人处理'}`
      if (t.status === 'waiting') return timeOf(t.nextCheckAt) <= at ? '在等对方（已到复查时间）' : '在等对方'
      if (t.status === 'replying') return '回了一半'
      if (t.status === 'reading') return '在看'
      return timeOf(t.nextCheckAt) <= at ? '未回（已逾期）' : '未回'
    }
    return rows.map((t) => [
      `- ${t.taskId}｜${t.chatName || t.chatId}｜${who(t)}｜${waited(t)}`,
      `  「${String(t.lastText ?? '').slice(0, 80)}」`,
      `  状态：${status(t)}`,
    ].join('\n')).join('\n')
  }

  function reload() {
    rebuild()
    return { ok: true, count: states.size }
  }

  function stats() {
    const all = [...states.values()]
    const count = (s) => all.filter((t) => t.status === s).length
    return {
      total: all.length,
      new: count('new'),
      reading: count('reading'),
      replying: count('replying'),
      waiting: count('waiting'),
      blocked: count('blocked'),
      done: count('done'),
      overdue: overdue().length,
    }
  }

  return {
    file, create, claim, release, reply, done, snooze, block, unblock, note, checkAt,
    markReminded, overdueReminders,
    get, active, overdue, byChat, summary, stats, reload, activeForChat,
  }
}

/** 任务板文件是否存在（工作台/自检用）。 */
export function tasksFileExists(file = TASKS_FILE) {
  return existsSync(file)
}
