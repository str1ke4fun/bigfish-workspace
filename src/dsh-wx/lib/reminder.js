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
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sameName } from './tree.js'

/** 许可文件。和 policy.json / session.json 放在一起，便于运维时一起看。 */
export const PERMIT_FILE = '/home/str1k3/.dsh-wx/reminder-permits.json'
/** 到点之后再给多久的宽限。超过这个时间没发，许可作废，需要重新定。 */
export const PERMIT_TTL_MS = 12 * 60 * 60_000
/** 同时最多保留多少张。许可很小，但别让文件无限长。 */
export const PERMIT_MAX = 500
/** 用过 / 过期多久之后从文件里清掉（保留一点排查痕迹，不长期存）。 */
export const PERMIT_KEEP_USED_MS = 24 * 60 * 60_000
/** 许可 id 形如 UUID；也允许测试传短一点的合法 id。 */
export const PERMIT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,79}$/

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
      const expires = Number(p.expiresAt) || 0
      if (used && t - used > PERMIT_KEEP_USED_MS) continue
      if (!used && expires <= t) continue
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

  /** 测试 / 排查用：看现在账上还有什么。 */
  function list() {
    return Object.values(prune(load()).permits)
  }

  return { grant, check, consume, revoke, list }
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
