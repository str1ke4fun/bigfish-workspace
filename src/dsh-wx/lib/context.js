/**
 * context.js —— 把任务板、台账、检索拼成一个窄接口
 *
 * 这里是「范围约束」真正落地的地方：
 *   wx_context 只有 task_id，没有 chat_id。服务端从任务板取出 task.chatId，
 *   只读这个会话的台账。调用方就算硬塞一个 chatId，也会核对后发现不一致而拒绝。
 *
 * 同时负责：
 *   - 入站投递时把任务和消息落盘（先落盘，再叫模型）；
 *   - 她发送成功后，把出站记回任务板（replyCount / 状态）；
 *   - 生成每轮摘要（由 dsh-fish 的 system prompt 段调用）；
 *   - 把检索调试记录写在本地，7 天后清掉；不写 events.jsonl。
 *
 * 检索结果的过滤（guard.js）由调用方注入 sanitize；这里不发明过滤规则。
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { chatIdFor, createLedger, dedupeKeyOf, msgIdOf } from './ledger.js'
import { createTaskBoard } from './tasks.js'
import { CARD_MAX, formatCards, rrf, searchLexical } from './retrieval.js'

export const DEFAULT_DIR = '/home/str1k3/.dsh-wx'
export const QUERY_LOG_KEEP_MS = 7 * 24 * 3600_000
export const CANDIDATE_MAX = 20

const str = (v) => String(v ?? '').trim()
const identitySanitize = (t) => ({ text: String(t ?? ''), dropped: 0 })

/**
 * @param {object} [opts]
 * @param {string} [opts.dir] 运行数据目录，默认 ~/.dsh-wx
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 * @param {(text:string)=>{text:string, dropped:number}} [opts.sanitize] 外部注入的过滤
 * @param {(req:{query:string, docs:object[], task:object}) => Promise<Array<{doc:object,score:number,reasons:string[]}>|null>} [opts.vectorProvider]
 */
export function createContextStore({
  dir = DEFAULT_DIR, now = Date.now, log, sanitize = identitySanitize, vectorProvider = null,
} = {}) {
  const board = createTaskBoard({ file: join(dir, 'tasks.jsonl'), now, log })
  const ledger = createLedger({ dir: join(dir, 'ledger'), now, log })
  const queryLog = join(dir, 'context-queries.jsonl')
  let lastPrune = 0

  /** 调试记录：只存查询摘要和命中 id，不存消息正文，更不写她的事件流。 */
  function logQuery({ taskId, chatId, query, hitIds, tookMs, semantic }) {
    try {
      const q = String(query ?? '')
      appendFileSync(queryLog, JSON.stringify({
        at: new Date(now()).toISOString(),
        taskId,
        chatId,
        qhash: createHash('sha256').update(q).digest('hex').slice(0, 12),
        qlen: [...q].length,
        hits: (hitIds ?? []).slice(0, CARD_MAX),
        tookMs: Math.max(0, Math.round(Number(tookMs) || 0)),
        semantic: semantic === true,
      }) + '\n', { mode: 0o600 })
      pruneQueryLog()
    } catch { /* 记录失败不影响检索 */ }
  }

  function pruneQueryLog() {
    if (now() - lastPrune < 3600_000) return
    lastPrune = now()
    try {
      const st = statSync(queryLog)
      if (now() - st.mtimeMs < QUERY_LOG_KEEP_MS) return
      const keep = readFileSync(queryLog, 'utf8').split('\n').filter((line) => {
        if (!line.trim()) return false
        try { return now() - Date.parse(JSON.parse(line).at) < QUERY_LOG_KEEP_MS } catch { return false }
      })
      writeFileSync(queryLog, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 })
    } catch { /* 没有文件或读不了，都无所谓 */ }
  }

  /**
   * 入站：先落任务。侧栏预览只是「有人找你」的信号，不是消息正文，
   * 默认不写进台账（写进去就会和真正的消息区记录重复，还会把截断的预览当成原文）。
   * 只有调用方确实拿到整条入站消息（inbound）时才落台账。
   * chatId 目前由会话名推导；目录模块上线后以目录的 id 为准。
   */
  function ingest({ chat, chatId: explicitChatId = '', preview = '', why = 'unknown', requester = {}, inbound = null } = {}) {
    const chatName = str(chat)
    if (!chatName) return { ok: false, why: '会话名为空' }
    const chatId = str(explicitChatId) || chatIdFor(chatName)
    const messages = Array.isArray(inbound) ? inbound : []
    const captured = messages.length
      ? ledger.append(chatId, messages, { chatName, source: 'ingest' })
      : { ok: true, added: 0, records: [] }
    if (!captured.ok) return { ok: false, why: captured.why }
    const last = captured.records.at(-1) ?? null
    const msgId = last?.msgId ?? (str(preview) ? msgIdOf(dedupeKeyOf({ chatId, sender: null, text: str(preview) })) : '')
    const key = captured.records.length
      ? `task:${chatId}:${captured.records[0].msgId}`
      : `task:${chatId}:${createHash('sha256').update(str(preview)).digest('hex').slice(0, 16)}`
    const made = board.create({
      chatId,
      chatName,
      requester,
      reason: why,
      inboundMsgId: msgId,
      text: str(preview) || last?.text || '',
      dedupeKey: key,
      at: new Date(now()).toISOString(),
    })
    if (!made.ok) return made
    return { ok: true, task: made.task, duplicate: !!made.duplicate, added: !!made.added, captured }
  }

  /** 她这一轮实际看过的消息：当前打开会话的消息区。 */
  function capture({ chat, chatId: explicitChatId = '', messages = [], source = 'tree' } = {}) {
    const chatName = str(chat)
    if (!chatName) return { ok: false, why: '会话名为空', added: 0 }
    const chatId = str(explicitChatId) || chatIdFor(chatName)
    return ledger.append(chatId, messages, { chatName, source })
  }

  /** 出站回执：挂到任务上，不因为发过一条就自动 done。 */
  function recordReply({ taskId, msgId = '', final = false } = {}) {
    const t = board.get(taskId)
    if (!t) return { ok: false, why: '没有这个任务。' }
    return board.reply(t.taskId, { msgId, final })
  }

  function done({ taskId, note = '' } = {}) {
    return board.done(taskId, { note })
  }

  function snooze({ taskId, minutes = 15 } = {}) {
    return board.snooze(taskId, { minutes })
  }

  /**
   * 任务内检索。没有 chatId 参数；传了也要和任务对得上。
   *
   * @param {{taskId:string, query?:string, before?:string, limit?:number, chatId?:string}} req
   */
  async function contextForTask({ taskId, query = '', before = '', limit = CARD_MAX, chatId = '' } = {}) {
    const t0 = now()
    const task = board.get(taskId)
    if (!task) return { ok: false, why: '没有这个任务。', text: '', cards: [] }
    if (chatId && str(chatId) !== task.chatId) {
      return { ok: false, why: '只能查当前任务自己的会话。', text: '', cards: [] }
    }
    const docs = ledger.searchDocs(task.chatId)
    if (!docs.length) return { ok: true, text: '这个会话还没有可查的记录。', cards: [], shown: 0, chatId: task.chatId }

    const threadIds = docs.filter((d) => d.taskId && d.taskId === task.taskId).map((d) => d.msgId)
    if (task.firstInboundMsgId) threadIds.push(task.firstInboundMsgId)
    if (task.lastInboundMsgId) threadIds.push(task.lastInboundMsgId)

    const q = str(query)
    if (!q) {
      const n = Math.max(1, Math.min(CARD_MAX, Number(limit) || CARD_MAX))
      const rows = ledger.window(task.chatId, { before, limit: n }).map((doc) => ({
        doc, score: 0, reasons: [str(before) ? '按时间翻页' : '最近'],
      }))
      const out = formatCards(rows, { max: n, sanitize })
      logQuery({ taskId: task.taskId, chatId: task.chatId, query: '', hitIds: rows.map((r) => r.doc.msgId), tookMs: now() - t0, semantic: false })
      return { ok: true, ...out, chatId: task.chatId }
    }

    const lexical = searchLexical(docs, q, { now: now(), threadIds, limit: CANDIDATE_MAX })
    let rows = lexical
    let semantic = false
    if (lexical.length === 0) {
      // 词法一个都没命中时，B 档仍可能找到语义近邻；但只有本地侧车可用才试。
    }
    if (typeof vectorProvider === 'function') {
      try {
        const vec = await vectorProvider({ query: q, docs, task })
        if (Array.isArray(vec) && vec.length) {
          const allowed = new Set(docs.map((d) => d.msgId))
          const safe = vec.filter((r) => r?.doc && allowed.has(r.doc.msgId))
          if (safe.length) {
            rows = rrf([lexical, safe])
            semantic = true
          }
        }
      } catch (err) {
        // 向量侧车失败就退回 A 档，不把错误抛给用户。
        log?.('向量检索回退 A 档', err)
      }
    }

    if (!rows.length) {
      logQuery({ taskId: task.taskId, chatId: task.chatId, query: q, hitIds: [], tookMs: now() - t0, semantic })
      return { ok: true, text: '没有找到相关的上下文。', cards: [], shown: 0, chatId: task.chatId, semantic }
    }
    const out = formatCards(rows, { max: Math.max(1, Math.min(CARD_MAX, Number(limit) || CARD_MAX)), sanitize })
    logQuery({ taskId: task.taskId, chatId: task.chatId, query: q, hitIds: rows.map((r) => r.doc.msgId), tookMs: now() - t0, semantic })
    return { ok: true, ...out, chatId: task.chatId, semantic }
  }

  /** 每轮 system prompt 的摘要；没有任务返回空串。 */
  function summary(opts = {}) {
    return board.summary(opts)
  }

  function inbox() {
    return board.active()
  }

  function stats() {
    return { tasks: board.stats(), ledger: {} }
  }

  return {
    board, ledger, ingest, capture, recordReply, done, snooze, contextForTask, summary, inbox, stats,
    logQuery,
  }
}
