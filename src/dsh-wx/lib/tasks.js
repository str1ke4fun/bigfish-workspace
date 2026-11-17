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
 *   4. 出站回执按 msgId 去重；重放不会多算一次回复。
 *
 * 这里不发送、不读屏、不管 GUI；只负责「有什么要回、回到哪了」。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
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

/** 逾期封顶、blocked 视图和工作台摘要共用同一个运行期开关；缺省开启。 */
export function overdueVisibilityEnabled(raw) {
  return raw?.overdueVisibility !== false
}

/** 新建任务时把入站消息变成一个稳定的去重键。 */
export function inboundKey(chatId, msgId) {
  return `in:${str(chatId)}:${str(msgId)}`
}

/** 空状态。重放和新建共用，保证字段形状一致。 */
function blank() {
  return {
    taskId: '',
    version: 0,
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
    outboundMsgIds: [],
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
    t.version = 1
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
  if (!t) return false
  const at = str(rec.at)
  const expectedVersion = Number(rec.expectedVersion)
  if (Number.isFinite(expectedVersion) && t.version !== expectedVersion) return false
  const expectedOverdueCount = Number(rec.expectedOverdueCount)
  if (Number.isFinite(expectedOverdueCount) && t.overdueCount !== expectedOverdueCount) return false
  t.version += 1

  if (type === 'inbound') {
    if (rec.dedupeKey && t.dedupeKeys.includes(str(rec.dedupeKey))) return
    if (at) t.updatedAt = at
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
    // blocked 收到新入站只记账，不自动重开催办；后续回复或人工 unblock 再推进状态。
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
    const msgId = str(rec.msgId)
    if (!msgId) return
    if ((t.outboundMsgIds ?? []).includes(msgId)) return
    if (at) t.updatedAt = at
    t.status = 'replying'
    t.replyCount += 1
    t.outboundMsgIds.push(msgId)
    t.lastOutboundMsgId = msgId
    if (rec.final === true) t.final = true
    if (rec.nextCheckAt) t.nextCheckAt = str(rec.nextCheckAt)
    return
  }
  if (at) t.updatedAt = at
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
    if (rec.finalBlock === true) {
      t.status = 'blocked'
      t.lease = null
      t.blockedWhy = str(rec.why).slice(0, 500)
      t.uncertain = rec.uncertain === true
    }
    return
  }
}

function readRecords(file, log) {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return { records: [], error: null }
    return { records: [], error: String(err?.message ?? err).slice(0, 160) }
  }
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
  return { records: out, error: null }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.file]
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createTaskBoard({ file = TASKS_FILE, now = Date.now, log, append = appendFileSync, probe } = {}) {
  let states = new Map()
  let dedupe = new Map() // dedupeKey -> taskId
  let loadError = ''

  const rebuild = () => {
    states = new Map()
    dedupe = new Map()
    const loaded = readRecords(file, log)
    loadError = loaded.error || ''
    for (const rec of loaded.records) {
      const applied = apply(states, rec)
      if (applied !== false && (rec?.type === 'create' || rec?.type === 'inbound')) {
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
      append(file, JSON.stringify({ v: TASK_SCHEMA_VERSION, ...rec }) + '\n', { mode: 0o600 })
    } catch (err) {
      log?.('任务板写盘失败', err)
      return { ok: false, code: 'persistence', why: String(err?.message ?? err).slice(0, 160) }
    }
    apply(states, rec)
    const key = str(rec.dedupeKey)
    if (key && (rec.type === 'create' || rec.type === 'inbound')) dedupe.set(key, str(rec.taskId))
    return { ok: true }
  }

  function probeWritable() {
    try {
      if (typeof probe === 'function') {
        const r = probe(file)
        if (r === false) return { ok: false, code: 'persistence', why: '任务板当前不可写。' }
        if (r && typeof r === 'object') return r
        return { ok: true }
      }
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const fd = openSync(file, 'a', 0o600)
      closeSync(fd)
      return { ok: true }
    } catch (err) {
      log?.('任务板写盘探测失败', err)
      return { ok: false, code: 'persistence', why: String(err?.message ?? err).slice(0, 160) }
    }
  }

  function readStatus() {
    return loadError
      ? { ok: false, code: 'unavailable', why: loadError }
      : { ok: true }
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
    const cleanMsgId = str(msgId)
    if (!cleanMsgId) return { ok: false, why: '没有稳定的消息记号，回复没记上。' }
    if (t.outboundMsgIds.includes(cleanMsgId)) {
      return { ok: true, duplicate: true, task: get(t.taskId) }
    }
    if (t.status === 'done') return { ok: false, why: '这个任务已经结束了。' }
    const check = str(nextCheckAt) || new Date(now() + DEFAULT_CHECK_MS).toISOString()
    const r = transition(t.taskId, 'reply', { msgId: cleanMsgId, final: final === true, nextCheckAt: check, at })
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

  function block(taskId, { why = '', uncertain = false, expectedVersion, expectedOverdueCount, at } = {}) {
    return transition(taskId, 'block', {
      why: str(why).slice(0, 500), uncertain: uncertain === true, expectedVersion, expectedOverdueCount, at,
    })
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
   * 第三次提醒是最后一响：同一批落 remind + block，之后不再接第四次。
   */
  function markReminded(taskId, { level = 1, nextCheckAt = '', note = '', maxLevel = 3, finalBlock = true, expectedVersion, expectedOverdueCount, at } = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    const versionCheck = Number(expectedVersion)
    const countCheck = Number(expectedOverdueCount)
    if (!Number.isInteger(versionCheck) || versionCheck < 0 || !Number.isInteger(countCheck) || countCheck < 0) {
      return { ok: false, code: 'precondition-required', why: '提醒必须带上任务版本和逾期计数。', task: get(t.taskId) }
    }
    if (t.status === 'done') return { ok: false, why: '这个任务已经结束了。' }
    expectedVersion = versionCheck
    expectedOverdueCount = countCheck
    if (Number.isFinite(expectedVersion) && t.version !== expectedVersion) {
      return { ok: false, code: 'stale', why: '任务在提醒投递期间已经变了，旧提醒不记。', task: get(t.taskId) }
    }
    if (Number.isFinite(expectedOverdueCount) && t.overdueCount !== expectedOverdueCount) {
      return { ok: false, code: 'stale', why: '任务提醒计数已经变了，旧提醒不记。', task: get(t.taskId) }
    }
    if (t.status === 'blocked') {
      return { ok: false, why: '这个任务已经卡住了，不再自动提醒。', task: get(t.taskId) }
    }
    const cap = Math.max(1, Number(maxLevel) || 3)
    const current = Math.max(0, Number(t.overdueCount) || 0)
    if (current >= cap) {
      const blocked = transition(t.taskId, 'block', {
        why: '连续多次逾期提醒后仍未处理', uncertain: true, expectedVersion, expectedOverdueCount, at,
      })
      if (!blocked.ok) return blocked
      return { ok: false, why: '提醒次数已满，不再自动提醒。', task: get(t.taskId) }
    }
    const nextLevel = Math.min(cap, Math.max(1, Number(level) || current + 1))
    const next = str(nextCheckAt) || new Date(now() + DEFAULT_CHECK_MS).toISOString()
    const embedBlock = finalBlock !== false && nextLevel >= cap
    const r = transition(t.taskId, 'remind', {
      level: nextLevel,
      nextCheckAt: next,
      note: str(note).slice(0, 500),
      expectedVersion,
      expectedOverdueCount,
      finalBlock: embedBlock,
      why: embedBlock ? '连续多次逾期提醒后仍未处理' : '',
      uncertain: embedBlock,
      at,
    })
    if (!r.ok) return r
    return { ok: true, task: get(t.taskId) }
  }

  /** 旧记录里「提醒已到上限、block 没落盘」的任务；下一轮只补 block，不重投提醒。 */
  function reminderBlocksNeedingRepair({ maxLevel = 3 } = {}) {
    const cap = Math.max(1, Number(maxLevel) || 3)
    return active().filter((t) => t.status !== 'blocked' && Number(t.overdueCount) >= cap)
  }

  function reconcileReminderBlock(taskId, {
    maxLevel = 3, expectedVersion, expectedOverdueCount, at,
  } = {}) {
    const t = states.get(str(taskId))
    if (!t) return { ok: false, why: '没有这个任务。' }
    const cap = Math.max(1, Number(maxLevel) || 3)
    if (t.status === 'blocked') return { ok: true, noop: true, task: get(t.taskId) }
    if (Number(t.overdueCount) < cap) return { ok: false, code: 'not-needed', why: '还没到封顶。', task: get(t.taskId) }
    return transition(t.taskId, 'block', {
      why: '连续多次逾期提醒后仍未处理',
      uncertain: true,
      expectedVersion,
      expectedOverdueCount,
      at,
    })
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
    return t ? {
      ...t, requester: { ...t.requester }, notes: [...t.notes], dedupeKeys: [...t.dedupeKeys],
      outboundMsgIds: [...t.outboundMsgIds],
    } : null
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
    const who = (t) => t.requester?.name || '有人'
    const preview = (t) => {
      let text = String(t.lastText ?? '')
      const name = String(t.requester?.name ?? '').trim()
      if (name) {
        for (const prefix of [`${name}:`, `${name}：`]) {
          if (text.trimStart().startsWith(prefix)) {
            text = text.trimStart().slice(prefix.length).trimStart()
            break
          }
        }
      }
      return text.replace(/^\s*(?:@\S+\s+)+/, '').slice(0, 80)
    }
    const status = (t) => {
      if (t.status === 'blocked') return '这件事先放着。'
      if (t.status === 'waiting') return timeOf(t.nextCheckAt) <= at ? '还搁着。' : '先搁着。'
      if (t.status === 'replying') return '回了一半。'
      if (t.status === 'reading') return '在看。'
      return timeOf(t.nextCheckAt) <= at ? '还搁着。' : '还没回。'
    }
    return rows.map((t) => {
      const lines = [
        `「${t.chatName || t.chatId}」里，${who(t)}说：${preview(t)}`,
        status(t),
      ]
      if (t.taskId) lines.push(`〔${t.taskId}〕`)
      return lines.join('\n')
    }).join('\n\n')
  }

  function reload() {
    rebuild()
    return loadError
      ? { ok: false, code: 'unavailable', why: loadError, count: states.size }
      : { ok: true, count: states.size }
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
    markReminded, overdueReminders, reminderBlocksNeedingRepair, reconcileReminderBlock,
    probeWritable, readStatus,
    get, active, overdue, byChat, summary, stats, reload, activeForChat,
  }
}

/** 任务板文件是否存在（工作台/自检用）。 */
export function tasksFileExists(file = TASKS_FILE) {
  return existsSync(file)
}
