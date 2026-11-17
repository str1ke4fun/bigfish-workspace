/**
 * reminder.js —— 定时提醒的「一次性许可」
 *
 * 为什么要有这一层：
 *   她能在微信里说话，但发送闸要求「当前会话最近被 @ 过」和「主机没在对话框里
 *   跟她说话」。一条 30 分钟后才到的提醒，到点时这两条通常都不成立——
 *   不能为了提醒把闸整个拆掉，也不能让提醒永远发不出去。
 *
 * 做法：定提醒的时候由 dsh-wx 发一张**一次性、绑会话、绑原文、会过期**的许可。
 *   到点后宿主把许可和原话一起交回给她；wx_send 只凭这张许可绕过 @ / 主机闸，
 *   仍然要过允许名单和说话频率。许可用过即作废，重启后仍在盘上。
 *
 * 许可存在 ~/.dsh-wx/reminder-permits.json（0600）。文件坏了就当没有许可——
 * 宁可提醒发不出去、让她如实说，也不静默换成一条没有边界的发送。
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sameName } from './tree.js'

/** 许可文件。和 policy.json / session.json 放在一起，便于运维时一起看。 */
export const PERMIT_FILE = '/home/str1k3/.dsh-wx/reminder-permits.json'
/** 机械投递的提醒任务日志。只追加，重放得到当前状态。 */
export const REMINDER_JOBS_FILE = '/home/str1k3/.dsh-wx/reminder-jobs.jsonl'
/** 到点之后再给多久的宽限。超过这个时间没发，许可作废，需要重新定。 */
export const PERMIT_TTL_MS = 12 * 60 * 60_000
/** 同时最多保留多少张。许可很小，但别让文件无限长。 */
export const PERMIT_MAX = 500
/** 用过 / 过期多久之后从文件里清掉（保留一点排查痕迹，不长期存）。 */
export const PERMIT_KEEP_USED_MS = 24 * 60 * 60_000
/** 许可 id 形如 UUID；也允许测试传短一点的合法 id。 */
export const PERMIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/

/** 机械提醒投递的运行期开关；缺省开启，显式 false 回滚到旧宿主调度。 */
export function mechanicalReminderDeliveryEnabled(raw) {
  return raw?.mechanicalReminderDelivery !== false
}

/** 先按 Return，再记“已回车”；记账失败只留日志，不能诱发一次重发。 */
export async function pressReturnThenMark({ pressReturn, onReturn, log = () => {} } = {}) {
  await pressReturn()
  try {
    await onReturn?.()
    return { returned: true, marked: true }
  } catch (err) {
    log(`提醒 Return 标记没写下来：${String(err?.message ?? err).slice(0, 160)}`)
    return { returned: true, marked: false }
  }
}

function blankReminderJob(id) {
  return {
    id,
    sessionId: '',
    chat: '',
    text: '',
    permit: '',
    dueAt: 0,
    createdAt: '',
    attempt: 0,
    result: 'pending',
    returnedAt: '',
    resultAt: '',
    error: '',
    noticeAcked: false,
  }
}

function applyReminderJob(state, rec) {
  const id = String(rec?.id ?? '').trim()
  if (!id) return
  const type = String(rec?.type ?? '')
  if (type === 'created') {
    if (state.has(id)) return
    const job = blankReminderJob(id)
    job.sessionId = String(rec.sessionId ?? '')
    job.chat = String(rec.chat ?? '')
    job.text = String(rec.text ?? '')
    job.permit = String(rec.permit ?? '')
    job.dueAt = Number(rec.dueAt) || 0
    job.createdAt = String(rec.at ?? '')
    state.set(id, job)
    return
  }
  const job = state.get(id)
  if (!job) return
  if (type === 'attempt') {
    if (job.result !== 'pending') return
    job.attempt = Math.max(0, Number(job.attempt) || 0) + 1
    job.result = 'attempting'
    return
  }
  if (type === 'returned') {
    if (job.result !== 'attempting' || job.returnedAt) return
    job.returnedAt = String(rec.at ?? '')
    return
  }
  if (type === 'result') {
    if (job.result !== 'attempting') return
    const result = String(rec.result ?? '')
    if (!['confirmed', 'unconfirmed', 'failed', 'unknown'].includes(result)) return
    job.result = result
    job.resultAt = String(rec.at ?? '')
    job.error = String(rec.error ?? '').slice(0, 160)
    return
  }
  if (type === 'notice-ack') {
    job.noticeAcked = true
    return
  }
  if (type === 'revoked') {
    if (job.result !== 'pending') return
    job.result = 'revoked'
    job.resultAt = String(rec.at ?? '')
  }
}

function readReminderJournal(file, log) {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    if (err?.code !== 'ENOENT') log?.(`提醒任务日志读不出来：${String(err?.message ?? err).slice(0, 160)}`)
    return []
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      const rec = JSON.parse(text)
      if (rec && typeof rec === 'object') rows.push(rec)
      else log?.(`提醒任务日志跳过非对象行：${file}`)
    } catch {
      log?.(`提醒任务日志跳过坏行：${file}`)
    }
  }
  return rows
}

/** 提醒任务日志：一行一次状态迁移，只追加，不重写旧记录。 */
export function createReminderJobStore({ file = REMINDER_JOBS_FILE, now = Date.now, log = () => {}, append = appendFileSync } = {}) {
  const clock = () => Number(now()) || Date.now()
  const states = new Map()

  function rebuild() {
    states.clear()
    for (const rec of readReminderJournal(file, log)) applyReminderJob(states, rec)
  }

  function snapshot(job) {
    return job ? { ...job } : null
  }

  function commit(rec) {
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      append(file, JSON.stringify({ v: 1, ...rec }) + '\n', { mode: 0o600 })
    } catch (err) {
      log?.(`提醒任务日志写入失败：${String(err?.message ?? err).slice(0, 160)}`)
      return { ok: false, why: '提醒任务没存下来。' }
    }
    applyReminderJob(states, rec)
    return { ok: true }
  }

  rebuild()

  function create({ id, permit, sessionId = '', chat, text, dueAt, at = new Date(clock()).toISOString() } = {}) {
    const jobId = String(id ?? '').trim()
    const permitId = String(permit ?? '').trim()
    const target = String(chat ?? '').trim()
    const body = String(text ?? '')
    const due = Number(dueAt)
    if (!jobId) return { ok: false, why: '提醒任务 id 不能为空。' }
    if (states.has(jobId)) return { ok: false, why: '提醒任务 id 重复。' }
    if (!permitId) return { ok: false, why: '提醒许可不能为空。' }
    if (!target) return { ok: false, why: '提醒会话不能为空。' }
    if (!body) return { ok: false, why: '提醒正文不能为空。' }
    if (!Number.isFinite(due)) return { ok: false, why: '提醒到点时间不合法。' }
    const r = commit({
      type: 'created', id: jobId, permit: permitId, sessionId: String(sessionId ?? ''),
      chat: target, text: body, dueAt: due, at: String(at),
    })
    return r.ok ? { ok: true, job: snapshot(states.get(jobId)) } : r
  }

  function list({ sessionId = '' } = {}) {
    const sid = String(sessionId ?? '')
    return [...states.values()]
      .filter((job) => !sid || job.sessionId === sid)
      .map(snapshot)
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
  }

  /** 只领取最早的一条；发送并结算完这一条之后，worker 才会再来领下一条。 */
  function claimNextDue({ now: at = clock() } = {}) {
    const t = Number(at)
    const job = [...states.values()]
      .filter((item) => item.result === 'pending' && item.dueAt <= t)
      .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))[0]
    if (!job) return null
    const r = commit({ type: 'attempt', id: job.id, at: new Date(t).toISOString() })
    return r.ok ? snapshot(states.get(job.id)) : null
  }

  /** 兼容旧调用：最多领一条，避免一次 tick 把尚未尝试的任务全标成 attempting。 */
  function claimDue({ now: at = clock() } = {}) {
    const job = claimNextDue({ now: at })
    return job ? [job] : []
  }

  function get(id) {
    return snapshot(states.get(String(id ?? '').trim()))
  }

  function markReturned(id, { at = new Date(clock()).toISOString() } = {}) {
    const job = states.get(String(id ?? '').trim())
    if (!job || job.result !== 'attempting') return { ok: false, why: '这条提醒现在不在投递中。' }
    return commit({ type: 'returned', id: job.id, at: String(at) })
  }

  function settle(id, result, { at = new Date(clock()).toISOString(), error = '' } = {}) {
    const job = states.get(String(id ?? '').trim())
    if (!job) return { ok: false, why: '没有这条提醒。' }
    if (job.result !== 'attempting') return { ok: false, why: '这条提醒已经结束。' }
    return commit({ type: 'result', id: job.id, result: String(result), error: String(error ?? ''), at: String(at) })
  }

  function cancel(id, { sessionId = '', at = new Date(clock()).toISOString() } = {}) {
    const job = states.get(String(id ?? '').trim())
    if (!job) return { ok: false, why: '没有这条提醒。' }
    const sid = String(sessionId ?? '')
    if (sid && job.sessionId !== sid) return { ok: false, why: '这条提醒不在当前会话里。' }
    if (job.result !== 'pending') return { ok: false, why: '这条提醒已经开始了，不能取消。' }
    const r = commit({ type: 'revoked', id: job.id, at: String(at) })
    return r.ok ? { ok: true, job: snapshot(states.get(job.id)) } : r
  }

  function recoverInterrupted({ at = new Date(clock()).toISOString() } = {}) {
    const recovered = []
    for (const job of [...states.values()]) {
      if (job.result !== 'attempting') continue
      job.returnedAt = ''
      const r = commit({ type: 'result', id: job.id, result: 'unknown', error: 'restart-during-delivery', at: String(at) })
      if (r.ok) recovered.push(snapshot(states.get(job.id)))
    }
    return recovered
  }

  function pendingNotices() {
    return [...states.values()]
      .filter((job) => ['confirmed', 'unconfirmed', 'failed', 'unknown'].includes(job.result) && !job.noticeAcked)
      .sort((a, b) => Date.parse(a.resultAt) - Date.parse(b.resultAt) || a.id.localeCompare(b.id))
      .map(snapshot)
  }

  function ackNotices(ids, { at = new Date(clock()).toISOString() } = {}) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id ?? '').trim()).filter(Boolean))
    if (!wanted.size) return []
    const delivered = []
    for (const job of pendingNotices()) {
      if (!wanted.has(job.id)) continue
      const r = commit({ type: 'notice-ack', id: job.id, at: String(at) })
      if (r.ok) delivered.push({ id: job.id, result: job.result })
    }
    return delivered
  }

  function takeNotices({ at = new Date(clock()).toISOString() } = {}) {
    return ackNotices(pendingNotices().map((job) => job.id), { at })
  }

  return {
    create, list, get, claimNextDue, claimDue, markReturned, settle, cancel, recoverInterrupted,
    pendingNotices, ackNotices, takeNotices,
  }
}

/** 成功 / 不确定 / 失败的世界声只描述结果，不带会话名、原文或内部记号。 */
export function reminderNoticeText(result) {
  if (result === 'confirmed') return '刚才定的提醒已经发了。'
  if (result === 'unconfirmed') return '刚才定的提醒按了发送，但没看清有没有发出去；别再补发。'
  if (result === 'unknown') return '刚才定的提醒可能发出去了，也可能没有；别再补发。'
  if (result === 'failed') return '刚才定的提醒没发出去。'
  return ''
}

/**
 * 机械投递 worker：领取已到点的持久任务，直接走 wx 的高层发送，不经过模型。
 * 一旦按下 Return，任何未确认或异常都按终态处理，绝不重发。
 */
export function createReminderDeliveryWorker({
  jobs = createReminderJobStore(),
  permits,
  sendReminder,
  getEnabled = () => true,
  now = Date.now,
  log = () => {},
} = {}) {
  const clock = () => Number(now()) || Date.now()

  function enabled() {
    try { return getEnabled() !== false } catch { return false }
  }

  function create({ sessionId, chat, text, dueAt } = {}) {
    if (!enabled()) return { ok: false, disabled: true, why: '机械提醒投递没开。' }
    if (!permits || typeof permits.grant !== 'function') return { ok: false, why: '提醒许可不能用。' }
    const at = clock()
    const permit = newPermitId()
    const granted = permits.grant({ id: permit, sessionId, chat, text, dueAt })
    if (!granted.ok) return granted
    const id = 'rem-' + randomUUID()
    const saved = jobs.create({ id, permit, sessionId, chat, text, dueAt, at: new Date(at).toISOString() })
    if (!saved.ok) {
      try { permits.revoke?.(permit) } catch { /* ignore */ }
      return saved
    }
    return { ok: true, job: saved.job }
  }

  function list({ sessionId = '' } = {}) {
    return jobs.list({ sessionId })
  }

  function cancel(id, { sessionId = '' } = {}) {
    const cancelled = jobs.cancel(id, { sessionId, at: new Date(clock()).toISOString() })
    if (!cancelled.ok) return cancelled
    const retired = permits?.retire?.(cancelled.job.permit) ?? permits?.revoke?.(cancelled.job.permit)
    if (retired && retired.ok === false) log(`提醒许可撤销失败：${retired.why || 'unknown'}`)
    return cancelled
  }

  function recover() {
    const recovered = jobs.recoverInterrupted({ at: new Date(clock()).toISOString() })
    for (const job of recovered) permits?.retire?.(job.permit)
    return recovered
  }

  let running = false
  async function deliverDue({ now: at = clock(), limit = 20 } = {}) {
    if (running) return { ok: true, processed: 0, busy: true }
    running = true
    try {
      const max = Math.max(1, Math.min(100, Number(limit) || 20))
      const finish = (job, result, error) => {
        const settled = jobs.settle(job.id, result, { at: new Date(at).toISOString(), error })
        if (settled.ok) permits?.retire?.(job.permit)
        return settled
      }
      let processed = 0
      while (processed < max) {
        // 开关在每一条之前现读；前一条发送期间回滚，后面的任务必须原样留在盘上。
        if (!enabled()) return { ok: true, processed, disabled: true }
        const job = jobs.claimNextDue({ now: at })
        if (!job) break

        const permit = permits?.check?.({ id: job.permit, chat: job.chat, text: job.text })
        if (!permit?.ok) {
          finish(job, 'failed', permit?.why || 'permit-invalid')
          processed += 1
          continue
        }

        let returned = false
        try {
          const sent = await sendReminder({
            chat: job.chat,
            text: job.text,
            permit: job.permit,
            reminderId: job.id,
            onReturn: async () => {
              returned = true
              jobs.markReturned(job.id, { at: new Date(clock()).toISOString() })
            },
          })
          if (sent?.ok === false) {
            finish(job, 'failed', String(sent.code || sent.message || 'send-failed'))
          } else {
            const result = sent?.sent === 'confirmed' ? 'confirmed' : 'unconfirmed'
            finish(job, result, sent?.sent ? `send:${sent.sent}` : 'send:unknown')
          }
        } catch (err) {
          const current = jobs.get(job.id)
          const afterReturn = returned || !!current?.returnedAt
          finish(job, afterReturn ? 'unknown' : 'failed', String(err?.code || err?.message || err || 'send-failed'))
        }
        processed += 1
      }
      return { ok: true, processed }
    } finally {
      running = false
    }
  }

  function peekNotices() {
    return jobs.pendingNotices()
      .map((row) => ({ id: row.id, result: row.result, text: reminderNoticeText(row.result) }))
      .filter((row) => row.text)
  }

  function ackNotices({ ids = [], at = new Date(clock()).toISOString() } = {}) {
    return { ok: true, acked: jobs.ackNotices(ids, { at }) }
  }

  function takeNotices({ at = new Date(clock()).toISOString() } = {}) {
    const notices = peekNotices()
    const acked = new Set(ackNotices({ ids: notices.map((row) => row.id), at }).acked.map((row) => row.id))
    return notices.filter((row) => acked.has(row.id))
  }

  return { enabled, create, list, cancel, recover, deliverDue, peekNotices, ackNotices, takeNotices }
}

/** 生成一个新许可 id。 */
export function newPermitId() {
  return randomUUID()
}

/**
 * 允许发送的会话名（返回策略文件里的标准写法）。
 * 只在允许名单和免 @ 名单里找；两张都不在就是不能发。
 *
 * @param {object} p policy() 的返回值
 * @param {string} chat
 * @returns {string|null}
 */
export function findAllowedChat(p, chat) {
  const want = String(chat ?? '').trim()
  if (!want) return null
  const allow = Array.isArray(p?.allowChats) ? p.allowChats : []
  const exempt = Array.isArray(p?.noMentionChats) ? p.noMentionChats : []
  return allow.find((n) => sameName(n, want)) ?? exempt.find((n) => sameName(n, want)) ?? null
}

/**
 * 这个会话能不能发（只看名单和总开关，不看 @ / 主机闸）。
 * @returns {{ok:boolean, chat?:string, why?:string}}
 */
export function canSendWithPolicy(p, chat) {
  if (!p?.enabled) return { ok: false, why: '微信通道已关闭。' }
  const want = String(chat ?? '').trim()
  if (!want) return { ok: false, why: '没有指定要发到哪个会话。' }
  const hit = findAllowedChat(p, want)
  if (!hit) return { ok: false, why: `「${want}」不在允许发送的会话里。` }
  return { ok: true, chat: hit }
}

/**
 * 在解析后的树里找输入框。
 * 微信的输入框没有固定角色名，常见的是 `text "<当前会话名>"` 贴在底部；
 * 找不到同名文本时，退而求其次取底部最宽的一条 text/entry/edit。
 *
 * @param {{current?:string, clickables?:Array<{role?:string,label?:string,box:{x:number,y:number,w:number,h:number,cx:number,cy:number}}>}} parsed
 */
export function findInputBox(parsed) {
  const items = (parsed?.clickables ?? []).filter((c) => /text|entry|edit/i.test(String(c?.role ?? '')))
  const cur = String(parsed?.current ?? '')
  const exact = items
    .filter((c) => sameName(c.label, cur))
    .sort((a, b) => b.box.y - a.box.y || b.box.w - a.box.w)[0]
  if (exact) return exact
  return items.filter((c) => c.box.w >= 120).sort((a, b) => b.box.y - a.box.y)[0] ?? null
}

/** 内部：空账本。 */
const empty = () => ({ v: 1, permits: {} })

/**
 * 许可账本。所有方法都同步、永不抛（写盘失败只记日志）。
 *
 * @param {{file?:string, now?:()=>number, log?:(msg:string)=>void}} opts
 */
export function createPermitStore({ file = PERMIT_FILE, now = Date.now, log = () => {} } = {}) {
  const clock = () => Number(now()) || Date.now()

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (!raw || typeof raw !== 'object' || !raw.permits || typeof raw.permits !== 'object') return empty()
      return { v: 1, permits: { ...raw.permits } }
    } catch (err) {
      if (err?.code !== 'ENOENT') log(`许可文件读不出来，按没有许可处理：${String(err?.message ?? err).slice(0, 160)}`)
      return empty()
    }
  }

  function save(data) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, file)
      try { chmodSync(file, 0o600) } catch { /* 某些文件系统不支持，不影响内容 */ }
      return true
    } catch (err) {
      log(`许可文件写不进去：${String(err?.message ?? err).slice(0, 160)}`)
      return false
    }
  }

  /** 清掉太久以前用过 / 已经过期的，并把总数压到上限。 */
  function prune(data, t = clock()) {
    const keep = {}
    for (const [id, p] of Object.entries(data.permits ?? {})) {
      if (!p || typeof p !== 'object') continue
      const used = Number(p.usedAt) || 0
      const revoked = Number(p.revokedAt) || 0
      const expires = Number(p.expiresAt) || 0
      if (used && t - used > PERMIT_KEEP_USED_MS) continue
      if (revoked && t - revoked > PERMIT_KEEP_USED_MS) continue
      if (!used && !revoked && expires <= t) continue
      keep[id] = p
    }
    const ids = Object.keys(keep)
    if (ids.length > PERMIT_MAX) {
      ids.sort((a, b) => (Number(keep[a].createdAt) || 0) - (Number(keep[b].createdAt) || 0))
      for (const id of ids.slice(0, ids.length - PERMIT_MAX)) delete keep[id]
    }
    return { v: 1, permits: keep }
  }

  /**
   * 发一张许可。
   * @param {{id?:string, chat:string, text:string, sessionId?:string, dueAt:number, ttlMs?:number}} req
   * @returns {{ok:boolean, id?:string, chat?:string, expiresAt?:number, why?:string}}
   */
  function grant({ id, chat, text, sessionId = '', dueAt, ttlMs = PERMIT_TTL_MS } = {}) {
    const pid = String(id ?? '').trim() || newPermitId()
    if (!PERMIT_ID_RE.test(pid)) return { ok: false, why: '许可 id 不合法。' }
    const target = String(chat ?? '').trim()
    if (!target) return { ok: false, why: '没有指定要发到哪个会话。' }
    const body = String(text ?? '')
    if (!body) return { ok: false, why: '要提醒的话是空的。' }
    const due = Number(dueAt)
    if (!Number.isFinite(due)) return { ok: false, why: '到点时间不合法。' }
    const t = clock()
    const expiresAt = due + Math.max(60_000, Number(ttlMs) || PERMIT_TTL_MS)
    if (expiresAt <= t) return { ok: false, why: '这个到点时间已经过去了。' }

    const data = prune(load(), t)
    if (data.permits[pid]) return { ok: false, why: '许可 id 重复。' }
    data.permits[pid] = {
      id: pid,
      chat: target,
      text: body,
      sessionId: String(sessionId ?? ''),
      createdAt: t,
      dueAt: due,
      expiresAt,
      usedAt: 0,
      revokedAt: 0,
    }
    if (!save(data)) return { ok: false, why: '许可没存下来，不能保证到点能发。' }
    return { ok: true, id: pid, chat: target, expiresAt }
  }

  /**
   * 查一张许可能不能用。不消费。
   * @returns {{ok:boolean, permit?:object, why?:string}}
   */
  function check({ id, chat, text } = {}) {
    const pid = String(id ?? '').trim()
    if (!pid) return { ok: false, why: '没有许可。' }
    const data = prune(load())
    const p = data.permits[pid]
    if (!p) return { ok: false, why: '没有这条提醒许可（可能已经用过、过期，或没存下来）。' }
    const t = clock()
    if (Number(p.usedAt) > 0) return { ok: false, why: '这条提醒许可已经用过了。' }
    if (Number(p.revokedAt) > 0) return { ok: false, why: '这条提醒许可已经撤销了。' }
    if (Number(p.expiresAt) <= t) return { ok: false, why: '这条提醒许可已经过期了。' }
    const target = String(chat ?? '').trim()
    if (target && !sameName(target, p.chat)) return { ok: false, why: `许可只允许发到「${p.chat}」，不是「${target}」。` }
    if (text != null && String(text) !== String(p.text)) return { ok: false, why: '要发的内容和当初定的不一致。' }
    return { ok: true, permit: p }
  }

  /**
   * 用掉一张许可。只有发送已经回车之后才调。
   * @returns {{ok:boolean, why?:string}}
   */
  function consume({ id, chat, text } = {}) {
    const v = check({ id, chat, text })
    if (!v.ok) return v
    const data = prune(load())
    const p = data.permits[String(id).trim()]
    if (!p) return { ok: false, why: '许可在写入前消失了。' }
    p.usedAt = clock()
    if (!save(data)) return { ok: false, why: '许可作废没写进盘，重启后可能被重复使用。' }
    return { ok: true }
  }

  /** 取消一张还没用的许可（定提醒失败时回滚）。 */
  function revoke(id) {
    const pid = String(id ?? '').trim()
    if (!pid) return { ok: false, why: '没有许可 id。' }
    const data = prune(load())
    if (!data.permits[pid]) return { ok: true }
    delete data.permits[pid]
    return save(data) ? { ok: true } : { ok: false, why: '许可没删掉。' }
  }

  /** 撤销但保留记录，供机械提醒任务和排查使用。 */
  function retire(id) {
    const pid = String(id ?? '').trim()
    if (!pid) return { ok: false, why: '没有许可 id。' }
    const data = prune(load())
    const p = data.permits[pid]
    if (!p) return { ok: true }
    p.revokedAt = clock()
    return save(data) ? { ok: true } : { ok: false, why: '许可撤销没写进盘。' }
  }

  /** 测试 / 排查用：看现在账上还有什么。 */
  function list() {
    return Object.values(prune(load()).permits)
  }

  return { grant, check, consume, revoke, retire, list }
}

/**
 * 把 wx 服务挂到 Cordis 上。失败不抛，返回 ok:false，调用方只记日志。
 * @returns {{ok:boolean, why?:string, dispose:()=>void}}
 */
export function provideWxService(ctx, service) {
  if (typeof ctx?.provide !== 'function') {
    return { ok: false, why: 'ctx.provide 不可用', dispose: () => {} }
  }
  try {
    const off = ctx.provide('wx', service)
    return { ok: true, dispose: typeof off === 'function' ? off : () => {} }
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 200), dispose: () => {} }
  }
}
