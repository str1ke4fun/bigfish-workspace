/**
 * ledger.js —— 每个会话一本只增不改的消息台账
 *
 * 为什么不是「内存里留最近几条」：
 *   现在耳朵只看侧栏预览，窗口切走、宿主重启、模型失败都会把上下文丢掉。
 *   台账先落盘，之后的任务板、检索、回执都从它读；它是微信这一侧的真相，
 *   但不等于她的记忆（记忆只在 dsh-fish 的 events.jsonl，且只由 growth_commit 写）。
 *
 * 三条硬约束：
 *   1. 只追加。纠正发言人靠追加 `repair`，不覆盖原文。
 *   2. 去重靠内容 + 邻接消息摘要，不靠时间戳（微信里读不到稳定时间）。
 *   3. 按会话 + 月份分文件，单个文件不会无限长；读的时候按时间合并。
 *
 * 文件布局：
 *   <dir>/<chatId>-<YYYY-MM>.jsonl
 *
 * 一行一条 JSON。坏行跳过并计数，不因为一行坏了让整本台账读不出来。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEDGER_VERSION = 1
export const DEFAULT_LEDGER_DIR = '/home/str1k3/.dsh-wx/ledger'
export const MAX_TEXT = 4000

const SEP = '\u001f'
const MONTH_RE = /^(\d{4})-(\d{2})$/

const str = (v) => String(v ?? '').trim()

/** 正文归一：压掉连续空白，但不改写内容。 */
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
    .slice(0, MAX_TEXT)
}

/** 从会话全名生成稳定 chatId。目录模块拿到正式 id 后以目录为准。 */
export function chatIdFor(name) {
  const n = str(name)
  if (!n) return ''
  return 'c_' + createHash('sha256').update(n).digest('hex').slice(0, 12)
}

/**
 * 去重键：会话 + 发言人 + 类型 + 正文 + 上一条的摘要。
 * 滚动窗口会重复看到同一屏消息，用内容去重比时间戳可靠。
 */
export function dedupeKeyOf({ chatId, sender, kind = 'text', text, prev } = {}) {
  const prevKey = prev ? [prev.sender ?? '', prev.kind ?? '', prev.text ?? ''].join(SEP) : ''
  const raw = [str(chatId), str(sender), str(kind), normalizeText(text), prevKey].join(SEP)
  return 'sha256:' + createHash('sha256').update(raw).digest('hex')
}

/** 可读的短 id，用于卡片和 repair 定位。 */
export function msgIdOf(key) {
  const k = String(key ?? '')
  return 'm_' + (k.startsWith('sha256:') ? k.slice(7, 23) : createHash('sha256').update(k).digest('hex').slice(0, 16))
}

const monthOf = (at, fallback = Date.now()) => {
  const t = Date.parse(String(at ?? ''))
  const d = new Date(Number.isFinite(t) ? t : fallback)
  return d.toISOString().slice(0, 7)
}

const timeOf = (rec, fallback = 0) => {
  const t = Date.parse(String(rec?.at ?? rec?.capturedAt ?? ''))
  return Number.isFinite(t) ? t : fallback
}

const fileFor = (dir, chatId, month) => join(dir, `${chatId}-${month}.jsonl`)
const archiveFileFor = (dir, chatId, month) => join(dir, 'archive', `${chatId}-${month}.jsonl`)
/** 读优先热文件；热文件归档后只在 archive 里。写永远写热文件。 */
const readFileFor = (dir, chatId, month) => {
  const hot = fileFor(dir, chatId, month)
  if (existsSync(hot)) return hot
  const cold = archiveFileFor(dir, chatId, month)
  return existsSync(cold) ? cold : hot
}

const readJsonLines = (file, log) => {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const v = JSON.parse(s)
      if (v && typeof v === 'object') out.push(v)
      else log?.(`台账跳过非对象行：${file}`)
    } catch {
      log?.(`台账跳过坏行：${file}`)
    }
  }
  return out
}

/**
 * 把 repair 应用到消息上。repair 只改发言人/类型这类元数据，不碰正文。
 * 后写的 repair 覆盖先写的。
 */
function applyRepairs(records) {
  const repairs = records.filter((r) => r?.type === 'repair' && r.targetMsgId)
  if (!repairs.length) return records.filter((r) => r?.type !== 'repair')
  const byMsg = new Map()
  for (const r of repairs) byMsg.set(String(r.targetMsgId), r)
  return records
    .filter((r) => r?.type !== 'repair')
    .map((r) => {
      const fix = byMsg.get(String(r.msgId))
      if (!fix) return r
      return {
        ...r,
        sender: fix.sender !== undefined ? fix.sender : r.sender,
        senderConfidence: fix.senderConfidence ?? r.senderConfidence,
        kind: fix.kind ?? r.kind,
        repaired: true,
        repairedAt: fix.at ?? r.repairedAt,
      }
    })
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dir] 默认 ~/.dsh-wx/ledger
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export function createLedger({ dir = DEFAULT_LEDGER_DIR, now = Date.now, log } = {}) {
  const cache = new Map() // chatId -> { docs, keys, keyDoc, loaded }

  /** 热目录 + 归档目录里的月份，合并去重。 */
  const monthsOf = (chatId) => {
    const prefix = `${chatId}-`
    const months = new Set()
    for (const base of [dir, join(dir, 'archive')]) {
      let files = []
      try { files = readdirSync(base) } catch { continue }
      for (const f of files) {
        if (!f.startsWith(prefix) || !f.endsWith('.jsonl')) continue
        const m = f.slice(prefix.length, -'.jsonl'.length)
        if (MONTH_RE.test(m)) months.add(m)
      }
    }
    return [...months].sort()
  }

  const load = (chatId, { force = false } = {}) => {
    const id = str(chatId)
    if (!id) return { docs: [], keys: new Set(), keyDoc: new Map(), loaded: true }
    const hit = cache.get(id)
    if (hit?.loaded && !force) return hit
    const records = []
    for (const m of monthsOf(id)) records.push(...readJsonLines(readFileFor(dir, id, m), log))
    const docs = applyRepairs(records).sort((a, b) => (timeOf(a) - timeOf(b)) || (Number(a.seq) || 0) - (Number(b.seq) || 0))
    const keyDoc = new Map()
    const keys = new Set()
    for (const d of docs) {
      const k = String(d.dedupeKey ?? '')
      if (!k) continue
      keys.add(k)
      keyDoc.set(k, d)
    }
    const entry = { docs, keys, keyDoc, loaded: true }
    cache.set(id, entry)
    return entry
  }

  /**
   * 追加一段消息。重复的按 dedupeKey 跳过；返回新增和跳过的条数。
   *
   * @param {string} chatId
   * @param {Array<object>} messages
   * @param {{source?:string, chatName?:string, capturedAt?:string, taskId?:string}} [meta]
   */
  function append(chatId, messages, meta = {}) {
    const id = str(chatId)
    if (!id) return { ok: false, why: 'chatId 为空', added: 0, skipped: 0, records: [] }
    const state = load(id)
    const capturedAt = str(meta.capturedAt) || new Date(now()).toISOString()

    // 滚动窗口会重复看到上一屏。先按「内容序列」和台账末尾对齐：
    // 找到最长的一段尾部重叠，那一段直接跳过。这样第一句不会因为
    // 「前一条不在这一屏」而算出另一个 dedupeKey。
    const cand = []
    for (const raw of messages ?? []) {
      if (!raw || typeof raw !== 'object') continue
      const text = normalizeText(raw.text)
      if (!text) continue
      cand.push({
        raw,
        text,
        kind: str(raw.kind) || 'text',
        sender: raw.sender === null || raw.sender === undefined ? null : str(raw.sender) || null,
      })
    }
    // 重叠对齐只看「类型 + 正文」，不看发言人：发言人是从侧栏预览补出来的，
    // 同一屏第二次读到时置信度可能从 unknown 变成 medium。若把 sender 算进去，
    // 最后一条一旦补上发言人就会整屏对不上，重复入账。正文相同才是同一条。
    const sameContent = (a, b) => !!a && !!b
      && (a.kind ?? 'text') === (b.kind ?? 'text')
      && normalizeText(a.text) === normalizeText(b.text)
    const tail = state.docs.slice(-Math.max(1, cand.length))
    let overlap = 0
    for (let k = Math.min(cand.length, tail.length); k > 0; k--) {
      let ok = true
      for (let i = 0; i < k; i++) {
        if (!sameContent(cand[i], tail[tail.length - k + i])) { ok = false; break }
      }
      if (ok) { overlap = k; break }
    }

    const pending = []
    let prev = overlap > 0 ? tail[tail.length - 1] : (state.docs.at(-1) ?? null)
    let skipped = overlap
    let seq = state.docs.at(-1)?.seq ?? 0

    for (const item of cand.slice(overlap)) {
      const { raw, text, kind, sender } = item
      const dedupeKey = dedupeKeyOf({ chatId: id, sender, kind, text, prev })
      const known = state.keyDoc.get(dedupeKey)
      if (known) {
        skipped += 1
        prev = known
        continue
      }
      seq += 1
      const rec = {
        v: LEDGER_VERSION,
        msgId: msgIdOf(dedupeKey),
        chatId: id,
        chatName: str(meta.chatName ?? raw.chatName),
        sender,
        senderConfidence: str(raw.senderConfidence) || (sender ? 'medium' : 'unknown'),
        direction: raw.direction === 'out' || raw.direction === 'in' ? raw.direction : 'unknown',
        kind,
        text,
        quote: raw.quote && typeof raw.quote === 'object'
          ? { author: str(raw.quote.author), text: normalizeText(raw.quote.text) }
          : undefined,
        unreadBefore: Number.isFinite(Number(raw.unreadBefore)) ? Math.max(0, Number(raw.unreadBefore)) : undefined,
        at: str(raw.at) || capturedAt,
        atConfidence: str(raw.atConfidence) || (raw.at ? 'medium' : 'low'),
        capturedAt,
        source: str(raw.source) || str(meta.source) || 'tree',
        dedupeKey,
        seq,
        taskId: str(raw.taskId) || str(meta.taskId) || '',
      }
      state.keys.add(dedupeKey)
      state.keyDoc.set(dedupeKey, rec)
      state.docs.push(rec)
      pending.push(rec)
      prev = rec
    }

    if (!pending.length) return { ok: true, added: 0, skipped, records: [] }

    const byMonth = new Map()
    for (const rec of pending) {
      const m = monthOf(rec.at, now())
      if (!byMonth.has(m)) byMonth.set(m, [])
      byMonth.get(m).push(rec)
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const [m, rows] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const file = fileFor(dir, id, m)
        if (!existsSync(file)) {
          // 先建空文件并收紧权限，再追加：appendFileSync 的 mode 只在新建时生效。
          writeFileSync(file, '', { mode: 0o600 })
        }
        appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
      }
    } catch (err) {
      // 写盘失败：把内存里刚加进去的撤出来，别让「以为记下了」继续传播。
      for (const rec of pending) {
        state.keys.delete(rec.dedupeKey)
        state.keyDoc.delete(rec.dedupeKey)
      }
      state.docs = state.docs.filter((d) => !pending.includes(d))
      log?.('台账写盘失败', err)
      return { ok: false, why: String(err?.message ?? err).slice(0, 160), added: 0, skipped, records: [] }
    }
    return { ok: true, added: pending.length, skipped, records: pending }
  }

  /** 只读：按时间取一段。before 是 ISO 时间，limit 是条数。 */
  function window(chatId, { before = '', limit = 20 } = {}) {
    const state = load(chatId)
    const cut = Date.parse(String(before ?? ''))
    const rows = Number.isFinite(cut) ? state.docs.filter((d) => timeOf(d) < cut) : state.docs
    const n = Math.max(1, Math.min(500, Number(limit) || 20))
    return rows.slice(-n)
  }

  /** 只读：最近 limit 条，按时间正序。 */
  function recent(chatId, limit = 12) {
    return window(chatId, { limit })
  }

  /** 只读：检索用的文档集合。图片/表情/文件只有元数据，不猜内容。 */
  function searchDocs(chatId) {
    return load(chatId).docs.filter((d) => d.kind === 'text' && d.text)
  }

  /**
   * 纠正一条消息的元数据（通常是发言人）。不覆盖原文，追加一条 repair。
   */
  function repair(chatId, { msgId, sender, senderConfidence = 'medium', kind, why = '' } = {}) {
    const id = str(chatId)
    const target = str(msgId)
    if (!id || !target) return { ok: false, why: '要修哪条消息？' }
    const state = load(id)
    if (!state.docs.some((d) => d.msgId === target)) return { ok: false, why: '台账里没有这条消息。' }
    const rec = {
      type: 'repair',
      v: LEDGER_VERSION,
      targetMsgId: target,
      sender: sender === null ? null : str(sender) || undefined,
      senderConfidence: str(senderConfidence) || 'medium',
      kind: kind === undefined ? undefined : str(kind) || 'text',
      why: str(why).slice(0, 200),
      at: new Date(now()).toISOString(),
    }
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      appendFileSync(fileFor(dir, id, monthOf(rec.at, now())), JSON.stringify(rec) + '\n', { mode: 0o600 })
    } catch (err) {
      log?.('台账 repair 写盘失败', err)
      return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
    }
    load(id, { force: true })
    return { ok: true, targetMsgId: target }
  }

  /** 所有出现过消息的 chatId（热目录 + 归档目录）。 */
  function chats() {
    const ids = new Set()
    for (const base of [dir, join(dir, 'archive')]) {
      let files = []
      try { files = readdirSync(base) } catch { continue }
      for (const f of files) {
        const m = f.match(/^(.+)-(\d{4})-(\d{2})\.jsonl$/)
        if (m) ids.add(m[1])
      }
    }
    return [...ids].sort()
  }

  /** 只读：一个会话的全部文档（按时间正序）。摘要/归档维护用。 */
  function allDocs(chatId) {
    return [...load(chatId).docs]
  }

  /** 统计（工作台/自检用）。 */
  function stats(chatId) {
    const state = load(chatId)
    const last = state.docs.at(-1)
    return {
      chatId: str(chatId),
      count: state.docs.length,
      months: monthsOf(str(chatId)),
      lastMsgId: last?.msgId ?? '',
      lastAt: last?.at ?? '',
      lastSender: last?.sender ?? null,
    }
  }

  /** 测试/长跑用：丢掉内存缓存，下次重新读盘。 */
  function reset() {
    cache.clear()
  }

  return { dir, append, window, recent, searchDocs, repair, stats, load, reset, chats, allDocs }
}
