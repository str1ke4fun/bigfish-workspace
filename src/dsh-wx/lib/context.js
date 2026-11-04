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

import { archiveLedger, DEFAULT_RETENTION_DAYS } from './archive.js'
import { isIgnoredChat } from './capture.js'
import { chatIdFor, createLedger, dedupeKeyOf, msgIdOf } from './ledger.js'
import { attributeMessages, parsePreviewSender, requesterOf } from './speaker.js'
import { searchSummaryDocs, writeDailySummaries } from './summaries.js'
import { createTaskBoard } from './tasks.js'
import { kindOfLabel, parseSidebarTime } from './transcript.js'
import { CARD_MAX, formatCards, rrf, searchLexical } from './retrieval.js'

export const DEFAULT_DIR = '/home/str1k3/.dsh-wx'
export const QUERY_LOG_KEEP_MS = 7 * 24 * 3600_000
export const CANDIDATE_MAX = 20
export const RECENT_MAX = 20
export const HISTORY_MAX = 20
export const HISTORY_RECENT = 8
export const RECORDED_MAX = 50
export const RECORDED_DEFAULT = 30

const str = (v) => String(v ?? '').trim()
const identitySanitize = (t) => ({ text: String(t ?? ''), dropped: 0 })

/** 列表里的时间：简化 ISO，固定宽度，便于扫读。 */
const listTimeText = (iso) => {
  const t = Date.parse(String(iso ?? ''))
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : '时间未知'
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dir] 运行数据目录，默认 ~/.dsh-wx
 * @param {() => number} [opts.now]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 * @param {(text:string)=>{text:string, dropped:number}} [opts.sanitize] 外部注入的过滤
 * @param {(req:{query:string, docs:object[], task:object}) => Promise<Array<{doc:object,score:number,reasons:string[]}>|null>} [opts.vectorProvider]
 * @param {(name:string)=>{chatId:string,isDM:boolean,displayName?:string}|null} [opts.resolveChat] 目录解析
 * @param {number} [opts.retentionDays] 台账热存保留期
 */
export function createContextStore({
  dir = DEFAULT_DIR, now = Date.now, log, sanitize = identitySanitize, vectorProvider = null,
  resolveChat = null, retentionDays = DEFAULT_RETENTION_DAYS,
} = {}) {
  const board = createTaskBoard({ file: join(dir, 'tasks.jsonl'), now, log })
  const ledgerDir = join(dir, 'ledger')
  const ledger = createLedger({ dir: ledgerDir, now, log })
  const summariesDir = join(dir, 'summaries')
  const queryLog = join(dir, 'context-queries.jsonl')
  let lastPrune = 0

  /** 目录优先，拿不到就退回会话名哈希；active task 的 chatId 始终是同一套。 */
  function chatIdOf(chatName, explicit = '') {
    const given = str(explicit)
    if (given) return given
    const hit = typeof resolveChat === 'function' ? resolveChat(str(chatName)) : null
    if (hit?.chatId) return str(hit.chatId)
    return chatIdFor(chatName)
  }

  function chatMeta(chatName) {
    const hit = typeof resolveChat === 'function' ? resolveChat(str(chatName)) : null
    return {
      isDM: hit?.isDM === true,
      displayName: str(hit?.displayName) || str(chatName),
    }
  }

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
   * chatId 由目录解析；目录还没见过这个名字时才退回会话名哈希。
   */
  function ingest({
    chat, chatId: explicitChatId = '', preview = '', why = 'unknown', requester = {}, inbound = null,
    isDM = null, source = 'ingest',
  } = {}) {
    const chatName = str(chat)
    if (!chatName) return { ok: false, why: '会话名为空' }
    const chatId = chatIdOf(chatName, explicitChatId)
    const meta = chatMeta(chatName)
    const dm = isDM === null ? meta.isDM : isDM === true
    const messages = Array.isArray(inbound) ? inbound : []
    const attributed = messages.length
      ? attributeMessages({ chat: chatName, isDM: dm, preview, messages, now: now() })
      : []
    const who = requester?.name
      ? requester
      : requesterOf({ chat: chatName, isDM: dm, preview })
    // 先看有没有现成任务，好让这批消息直接绑到任务上。
    const active = board.activeForChat(chatId)
    const captured = attributed.length
      ? ledger.append(chatId, attributed, { chatName, source, taskId: active?.taskId ?? '' })
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
      requester: who,
      reason: why,
      inboundMsgId: msgId,
      text: str(preview) || last?.text || '',
      dedupeKey: key,
      at: new Date(now()).toISOString(),
    })
    if (!made.ok) return made
    return { ok: true, task: made.task, duplicate: !!made.duplicate, added: !!made.added, captured, chatId }
  }

  /**
   * 她这一轮实际看过的消息：当前打开会话的消息区。
   * 发言人按「结构化 > 单聊本人 > 侧栏预览（最后一条）> 未知」归因，不从正文猜。
   */
  function capture({
    chat, chatId: explicitChatId = '', messages = [], source = 'tree',
    isDM = null, preview = '', outbox = [], taskId = '',
  } = {}) {
    const chatName = str(chat)
    if (!chatName) return { ok: false, why: '会话名为空', added: 0 }
    const chatId = chatIdOf(chatName, explicitChatId)
    const meta = chatMeta(chatName)
    const attributed = attributeMessages({
      chat: chatName,
      isDM: isDM === null ? meta.isDM : isDM === true,
      preview,
      messages,
      outbox,
      now: now(),
    })
    // 只有调用方明确说「这段属于某个任务」时才绑定。把当前会话看到的每条消息
    // 都挂到活动任务上，会让「同一条线」把无关的最近消息也带进检索结果。
    const r = ledger.append(chatId, attributed, { chatName, source, taskId: str(taskId) })
    return { ...r, chatId }
  }

  /**
   * 侧栏预览入账：不点开会话，只把「预览里说了什么」追加进台账。
   * 服务号先拒；群聊读不出发言人就保持 null，绝不从正文猜。
   * 同一个会话名可能同时出现在侧栏和目录里，chatId 仍以目录优先，避免两边分叉。
   *
   * @param {object} [req]
   * @param {string} req.chat
   * @param {string} [req.chatId]
   * @param {string} [req.preview]
   * @param {string} [req.time] 侧栏时间文本（14:02 / 昨天 09:05）
   * @param {number} [req.unread]
   * @param {boolean|null} [req.isDM] 缺省时查目录
   * @param {string|number} [req.at] 调用方已有的 ISO 时间，优先于侧栏时间
   * @param {string[]} [req.ignoreChats]
   */
  function capturePreview({
    chat, chatId: explicitChatId = '', preview = '', time = '', unread = null,
    isDM = null, at = '', ignoreChats = [],
  } = {}) {
    const chatName = str(chat)
    if (isIgnoredChat(chatName, ignoreChats)) {
      return { ok: true, chatId: '', added: 0, skipped: 0, sender: null, kind: 'text', why: 'ignored' }
    }
    if (!chatName) {
      return { ok: false, chatId: '', added: 0, skipped: 0, sender: null, kind: 'text', why: '会话名为空' }
    }

    const chatId = chatIdOf(chatName, explicitChatId)
    const meta = chatMeta(chatName)
    const dm = isDM === null ? meta.isDM : isDM === true
    const pv = parsePreviewSender(preview)
    // 单聊的发言人就是会话名；群聊只认预览头，读不出就留 null。
    const sender = dm ? chatName : pv.sender
    const senderConfidence = dm ? 'high' : (pv.sender ? pv.confidence : 'unknown')
    const text = pv.text
    const kind = kindOfLabel(text)

    let atText = typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : str(at)
    let atConfidence = 'medium'
    if (!atText) {
      const parsed = parseSidebarTime(time, now())
      if (parsed.at) {
        atText = parsed.at
      } else {
        // 侧栏时间读不出时用采集时间兜底，并明确标低置信度。
        atText = new Date(now()).toISOString()
        atConfidence = 'low'
      }
    }

    const msg = { sender, senderConfidence, direction: 'in', kind, text, at: atText, atConfidence }
    if (unread !== null && unread !== undefined) msg.unreadBefore = unread
    const captured = ledger.append(chatId, [msg], { chatName, source: 'preview' })
    return {
      ok: captured.ok,
      chatId,
      added: captured.added,
      skipped: captured.skipped,
      sender,
      kind,
      ...(captured.ok ? {} : { why: captured.why }),
    }
  }

  /**
   * 只读历史：按会话名查台账，不建任务、不写事件流、不跨会话。
   * 服务号直接拒绝；查询结果正文统一过注入的 sanitize。
   *
   * @param {object} [req]
   * @param {string} req.chat
   * @param {string} [req.chatId]
   * @param {string} [req.query]
   * @param {number} [req.hours] 只保留该时间窗内（按台账 at）的记录
   * @param {number} [req.limit]
   * @param {string[]} [req.ignoreChats]
   */
  function historyForChat({
    chat, chatId: explicitChatId = '', query = '', hours = 0, limit = HISTORY_RECENT, ignoreChats = [],
  } = {}) {
    const chatName = str(chat)
    if (isIgnoredChat(chatName, ignoreChats)) {
      return { ok: false, chatId: '', text: '', cards: [], shown: 0, why: '不记录服务号的会话。' }
    }
    if (!chatName) return { ok: false, chatId: '', text: '', cards: [], shown: 0, why: '会话名为空' }

    const chatId = chatIdOf(chatName, explicitChatId)
    const n = Math.max(1, Math.min(HISTORY_MAX, Number(limit) || HISTORY_RECENT))
    const cut = Number(hours) > 0 ? now() - Number(hours) * 3600_000 : 0
    let docs = ledger.searchDocs(chatId)
    if (cut) {
      // 时间读不出的记录不猜，直接排除在时间窗之外。
      docs = docs.filter((d) => {
        const t = Date.parse(String(d.at ?? ''))
        return Number.isFinite(t) && t >= cut
      })
    }
    if (!docs.length) return { ok: true, chatId, text: '这个会话还没有可查的记录。', cards: [], shown: 0 }

    const q = str(query)
    let rows
    if (!q) {
      rows = docs.slice(-n).map((doc) => ({ doc, score: 0, reasons: ['最近'] }))
    } else {
      rows = searchLexical(docs, q, { now: now(), limit: CANDIDATE_MAX }).slice(0, n)
      if (!rows.length) return { ok: true, chatId, text: '没有找到相关的上下文。', cards: [], shown: 0 }
    }
    const out = formatCards(rows, { max: n, sanitize })
    return { ok: true, chatId, ...out }
  }

  /**
   * 有台账记录的会话列表：只读，跳过服务号；已有旧记录仍在盘上，只是不再列出。
   * @param {{limit?:number, ignoreChats?:string[]}} [req]
   */
  function listRecordedChats({ limit = RECORDED_DEFAULT, ignoreChats = [] } = {}) {
    const n = Math.max(1, Math.min(RECORDED_MAX, Number(limit) || RECORDED_DEFAULT))
    const rows = []
    for (const chatId of ledger.chats()) {
      const st = ledger.stats(chatId)
      const last = ledger.window(chatId, { limit: 1 })[0] ?? null
      const chatName = str(last?.chatName) || str(chatId)
      if (isIgnoredChat(chatName, ignoreChats)) continue
      rows.push({ chat: chatName, chatId, count: st.count, lastAt: st.lastAt })
    }
    rows.sort((a, b) => {
      const ta = Date.parse(String(a.lastAt ?? ''))
      const tb = Date.parse(String(b.lastAt ?? ''))
      return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
    })
    const chats = rows.slice(0, n)
    const lines = chats.map((c) => `- ${c.chat}｜${listTimeText(c.lastAt)}｜${c.count} 条`)
    return {
      ok: true,
      text: lines.length ? lines.join('\n') : '还没有任何会话记录。',
      chats,
      shown: chats.length,
    }
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
    // L0 原文 + L2 每日摘要一起检索；摘要命中也标注来源，不冒充原文。
    const docs = [...ledger.searchDocs(task.chatId), ...searchSummaryDocs(summariesDir, task.chatId, { log })]
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

  /**
   * 当前会话最近几条，供耳朵写进通知，让她一进来就知道刚才聊到哪。
   * 只读当前会话；不跨会话、不写事件流。
   * @param {{chat:string, chatId?:string, limit?:number, hours?:number, includeOut?:boolean}} req
   */
  function recentContext({
    chat, chatId: explicitChatId = '', limit = 8, hours = 6, includeOut = true,
  } = {}) {
    const chatName = str(chat)
    if (!chatName) return { ok: false, why: '会话名为空', lines: [], text: '' }
    const chatId = chatIdOf(chatName, explicitChatId)
    const n = Math.max(1, Math.min(RECENT_MAX, Number(limit) || 8))
    const cut = Number(hours) > 0 ? now() - Number(hours) * 3600_000 : 0
    const docs = ledger.window(chatId, { limit: Math.max(n * 3, n) })
      .filter((d) => !cut || Date.parse(String(d.at ?? '')) >= cut || !Number.isFinite(Date.parse(String(d.at ?? ''))))
      .filter((d) => includeOut || d.direction !== 'out')
      .slice(-n)
    const lines = docs.map((d) => {
      const who = d.direction === 'out' ? '大肥鱼' : (str(d.sender) || '发言人未识别')
      const raw = `${who}：${str(d.text).replace(/\s+/g, ' ').slice(0, 120)}`
      return sanitize(raw).text
    })
    return { ok: true, chatId, lines, text: lines.join('\n') }
  }

  /**
   * 定期维护：过期台账整月归档 + 为已经过去的天写摘要。
   * 归档失败保留原文件；摘要只追加、内容没变不写。
   */
  function maintain({ includeToday = false, retention = retentionDays } = {}) {
    const arch = archiveLedger({ dir: ledgerDir, now: now(), retentionDays: retention, log })
    if (arch.archived.length) ledger.reset()
    const chats = ledger.chats().map((chatId) => ({
      chatId,
      chatName: ledger.allDocs(chatId).at(-1)?.chatName ?? '',
      docs: ledger.allDocs(chatId),
    }))
    const sums = writeDailySummaries({ dir: summariesDir, chats, now, includeToday, log })
    return { ok: arch.ok && sums.ok, archive: arch, summaries: sums }
  }

  /** 每轮 system prompt 的摘要；没有任务返回空串。 */
  function summary(opts = {}) {
    return board.summary(opts)
  }

  function inbox() {
    return board.active()
  }

  function stats() {
    const chats = ledger.chats()
    const counts = chats.map((chatId) => ledger.stats(chatId))
    return {
      tasks: board.stats(),
      ledger: {
        chats: chats.length,
        messages: counts.reduce((n, c) => n + c.count, 0),
        summaries: chats.reduce((n, c) => n + searchSummaryDocs(summariesDir, c.chatId, { log }).length, 0),
      },
    }
  }

  return {
    board, ledger, summariesDir, ingest, capture, capturePreview, historyForChat, listRecordedChats,
    recentContext, maintain, recordReply, done, snooze,
    contextForTask, summary, inbox, stats, logQuery,
  }
}
