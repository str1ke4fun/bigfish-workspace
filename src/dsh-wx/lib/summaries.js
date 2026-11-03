/**
 * summaries.js —— L2 摘要卡（确定性汇总，不调用模型）
 *
 * 台账逐条消息是 L0；一条条全塞给检索会越来越吵。L2 把「每个会话每天」
 * 压成一张结构化卡片：首末消息、参与者、条数、关键词、待跟进的问题。
 *
 * 约束：
 *   - 纯函数汇总，不调用模型、不写 events.jsonl；
 *   - 只追加 revisions；同一天内容没变就不写；
 *   - 摘要只是压缩后的台账索引，不是她的记忆。要记住得她自己 growth_commit。
 *
 * 文件布局：<dir>/summaries/<chatId>-<YYYY-MM-DD>.jsonl
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { tokenize } from './retrieval.js'

export const SUMMARIES_VERSION = 1
export const KEYWORD_MAX = 8
export const QUESTION_MAX = 3

const str = (v) => String(v ?? '').trim()
const timeOf = (doc, fallback = 0) => {
  const t = Date.parse(String(doc?.at ?? doc?.capturedAt ?? ''))
  return Number.isFinite(t) ? t : fallback
}
const dayOf = (doc) => {
  const t = timeOf(doc, NaN)
  if (!Number.isFinite(t)) return ''
  return new Date(t).toISOString().slice(0, 10)
}

const QUESTION = /[?？]|吗|怎么|为什么|多少|哪(?:个|里|儿)?|什么时候|怎么办/u

/** 参与者按发言条数排序；出站不冒充发言人。 */
export function participantsOf(docs) {
  const counts = new Map()
  for (const d of docs ?? []) {
    const who = str(d?.sender) || (d?.direction === 'out' ? '大肥鱼' : '发言人未识别')
    counts.set(who, (counts.get(who) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'zh'))
}

/** 高频词：只用于索引，不代表主题判断；按次数、再按字典序，保证确定性。 */
export function keywordsOf(docs, max = KEYWORD_MAX) {
  const counts = new Map()
  for (const d of docs ?? []) {
    if (d?.kind && d.kind !== 'text' && d.kind !== 'summary') continue
    for (const tok of tokenize(d?.text)) counts.set(tok, (counts.get(tok) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([tok, n]) => n >= 2 && tok.length >= 2)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'zh'))
    .slice(0, Math.max(1, Number(max) || KEYWORD_MAX))
    .map(([tok]) => tok)
}

/** 待跟进：最近的问句，去重，最多 3 条。 */
export function questionsOf(docs, max = QUESTION_MAX) {
  const out = []
  for (const d of [...(docs ?? [])].sort((a, b) => timeOf(b) - timeOf(a))) {
    if (d?.direction === 'out') continue
    const text = str(d?.text)
    if (!text || !QUESTION.test(text)) continue
    const short = [...text].slice(0, 80).join('')
    if (out.includes(short)) continue
    out.push(short)
    if (out.length >= Math.max(1, Number(max) || QUESTION_MAX)) break
  }
  return out.reverse()
}

/**
 * 生成一个会话、一天的摘要卡。
 * @returns {object} 与台账文档同形（可直接进检索），kind='summary'
 */
export function buildDailySummary({
  chatId, chatName = '', day, docs = [], revision = 1,
} = {}) {
  const list = [...(docs ?? [])].sort((a, b) => timeOf(a) - timeOf(b))
  const first = list[0] ?? null
  const last = list.at(-1) ?? null
  const people = participantsOf(list)
  const keywords = keywordsOf(list)
  const questions = questionsOf(list)
  const parts = [`${day}｜${list.length} 条`]
  if (people.length) parts.push('参与者：' + people.slice(0, 6).map(([n, c]) => `${n}(${c})`).join('、'))
  if (keywords.length) parts.push('关键词：' + keywords.join('、'))
  if (questions.length) parts.push('待跟进：' + questions.map((q) => `「${q}」`).join('；'))
  if (first?.text) parts.push('开头：' + [...str(first.text)].slice(0, 60).join('') + (str(first.text).length > 60 ? '…' : ''))
  if (last?.text && last !== first) parts.push('最后：' + [...str(last.text)].slice(0, 60).join('') + (str(last.text).length > 60 ? '…' : ''))
  const text = parts.join('｜')
  const msgId = 's_' + createHash('sha256').update(`${chatId}\u001f${day}\u001f${text}`).digest('hex').slice(0, 16)
  return {
    v: SUMMARIES_VERSION,
    type: 'summary',
    msgId,
    chatId: str(chatId),
    chatName: str(chatName) || str(first?.chatName ?? last?.chatName),
    sender: null,
    senderConfidence: 'unknown',
    direction: 'unknown',
    kind: 'summary',
    text,
    at: `${day}T23:59:59.000Z`,
    atConfidence: 'high',
    capturedAt: `${day}T23:59:59.000Z`,
    source: 'summary',
    day,
    revision: Math.max(1, Number(revision) || 1),
    count: list.length,
    firstMsgId: str(first?.msgId),
    lastMsgId: str(last?.msgId),
    participants: people.map(([name, count]) => ({ name, count })),
    keywords,
    questions,
    taskIds: [...new Set(list.map((d) => str(d?.taskId)).filter(Boolean))],
  }
}

/** 摘要文件按 chatId + UTC 日期分段。 */
export function summaryFile(dir, chatId, day) {
  return join(dir, `${str(chatId)}-${str(day)}.jsonl`)
}

function readJsonLines(file, log) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).flatMap((line) => {
      try {
        const v = JSON.parse(line)
        return v && typeof v === 'object' ? [v] : []
      } catch {
        log?.('摘要跳过坏行：' + file)
        return []
      }
    })
  } catch {
    return []
  }
}

/** 读这个会话所有摘要卡（每天取最后一版）。 */
export function summaryDocs(dir, chatId, { log } = {}) {
  let files = []
  try { files = readdirSync(dir).filter((f) => f.startsWith(`${str(chatId)}-`) && f.endsWith('.jsonl')) } catch { return [] }
  const byDay = new Map()
  for (const f of files.sort()) {
    for (const rec of readJsonLines(join(dir, f), log)) {
      const day = str(rec.day) || f.slice(str(chatId).length + 1, -'.jsonl'.length)
      const prev = byDay.get(day)
      if (!prev || Number(rec.revision) >= Number(prev.revision)) byDay.set(day, rec)
    }
  }
  return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))
}

/**
 * 写入各会话的每日摘要。只写「内容变了」的天；默认不写今天（今天还在长）。
 *
 * @param {object} req
 * @param {string} req.dir summaries 目录
 * @param {Array<{chatId:string, chatName?:string, docs:object[]}>} req.chats
 * @param {() => number} [req.now]
 * @param {boolean} [req.includeToday]
 */
export function writeDailySummaries({ dir, chats = [], now = Date.now, includeToday = false, log } = {}) {
  const today = new Date(now()).toISOString().slice(0, 10)
  const written = []
  const skipped = []
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160), written, skipped }
  }
  for (const chat of chats) {
    const chatId = str(chat?.chatId)
    if (!chatId) continue
    const byDay = new Map()
    for (const doc of chat.docs ?? []) {
      if (doc?.kind === 'summary') continue
      const day = str(doc?.day) || dayOf(doc)
      if (!day || (!includeToday && day >= today)) continue
      if (!byDay.has(day)) byDay.set(day, [])
      byDay.get(day).push(doc)
    }
    for (const [day, docs] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (!docs.length) continue
      const file = summaryFile(dir, chatId, day)
      const existing = readJsonLines(file, log).filter((r) => str(r.day) === day).at(-1) ?? null
      const revision = (Number(existing?.revision) || 0) + 1
      const card = buildDailySummary({ chatId, chatName: chat.chatName, day, docs, revision })
      if (existing && existing.msgId === card.msgId) { skipped.push({ chatId, day, why: 'unchanged' }); continue }
      try {
        if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 })
        appendFileSync(file, JSON.stringify(card) + '\n', { mode: 0o600 })
        written.push({ chatId, day, revision, msgId: card.msgId, count: card.count })
      } catch (err) {
        log?.('摘要写不进去：' + String(err?.message ?? err).slice(0, 120))
      }
    }
  }
  return { ok: true, written, skipped }
}

/** 给检索用的摘要文档（与台账同形）。 */
export function searchSummaryDocs(dir, chatId, { log } = {}) {
  return summaryDocs(dir, chatId, { log }).map((r) => ({
    ...r,
    at: str(r.at) || `${r.day}T23:59:59.000Z`,
  }))
}
