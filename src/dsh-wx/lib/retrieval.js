/**
 * retrieval.js —— 当前任务会话里的上下文检索（零依赖）
 *
 * 只会被 wx_context 调用，范围由任务板的 chatId 决定：这个模块拿不到「去别的会话查」
 * 的参数，调用方也不提供。跨会话检索是明确不做的。
 *
 * 两档打分：
 *   A 档：中文二元组 + 英文/数字词 + BM25 变体 + 时间衰减 + 同一条线加成。纯 JS，永远可用。
 *   B 档：本地向量侧车（可选）。本模块只做余弦和 RRF 融合，不负责起服务、不下载模型。
 * 两档都用 RRF（倒数排名融合）合并，不直接相加不同量纲的分数。
 *
 * 结果不是「更多上下文」，而是**可解释的引用卡片**：
 *   来源、发言人、时间、匹配原因、置信度，最多 5 条、总字数有预算。
 * 返回前由调用方注入 sanitize（dsh-fish 的 guard.js）；这里不自己发明过滤规则。
 */

export const CARD_MAX = 5
export const CARD_TEXT_MAX = 160
export const CARD_BUDGET = 1200
export const RRF_K = 60

/** 高频词不进倒排：它们几乎出现在每条消息里，只会把分数拉平。 */
const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '就', '不', '也', '都',
  '要', '会', '说', '吗', '呢', '吧', '啊', '呀', '嘛', '哦', '嗯', '个', '上', '下', '中', '来', '去', '到',
  '给', '对', '把', '被', '让', '很', '太', '还', '又', '再', '没', '有', '一', '二', '三', '四', '五', '六',
  '七', '八', '九', '十', '我', '我们', '你们', '他们', '她们', '这个', '那个', '就是', '可以', '什么',
  '怎么', '一个', '一下', '现在', '时候', 'the', 'and', 'for', 'you', 'are', 'was', 'were', 'this', 'that',
  'with', 'have', 'has', 'had', 'not', 'but', 'from', 'they', 'them', 'your', 'our', 'its',
])

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]+/g
const WORD_RE = /[a-z0-9][a-z0-9_+#.-]*/gi

/**
 * 分词：中文按二元组（单字成词时保留单字），英文/数字按单词。
 * 返回去重后的 token 列表。查询和文档走同一套规则，避免两边口径不一致。
 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const out = []
  for (const run of s.match(CJK_RE) ?? []) {
    if (run.length === 1) {
      if (!STOP.has(run)) out.push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2)
      if (STOP.has(g)) continue
      // 两个字都是停用词的二元组（「是多」「了吗」）不携带信息，去掉。
      if (STOP.has(g[0]) && STOP.has(g[1])) continue
      out.push(g)
    }
  }
  for (const w of s.match(WORD_RE) ?? []) {
    if (w.length < 2) continue
    if (STOP.has(w)) continue
    out.push(w)
  }
  return [...new Set(out)]
}

/** 文档里用于打分的正文：发言人和时间不参与，避免「谁说的」压过「说了什么」。 */
const docText = (doc) => String(doc?.text ?? '')

const timeOf = (doc, fallback = 0) => {
  const t = Date.parse(String(doc?.at ?? doc?.capturedAt ?? ''))
  return Number.isFinite(t) ? t : fallback
}

/**
 * BM25 变体。单会话语料很小，参数取常见默认值即可；不调参，先保证可解释。
 * @returns {{ scores: Map<string, number>, terms: Map<string, number[]>, idf: Map<string, number> }}
 */
export function bm25(docs, queryTokens, { k1 = 1.2, b = 0.75 } = {}) {
  const q = [...new Set((queryTokens ?? []).map(String).filter(Boolean))]
  const scores = new Map()
  const terms = new Map()
  const idf = new Map()
  if (!q.length || !docs?.length) return { scores, terms, idf }

  const tokenized = docs.map((d) => tokenize(docText(d)))
  const df = new Map()
  let total = 0
  for (const toks of tokenized) {
    total += toks.length
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
  }
  const avgdl = total / Math.max(1, docs.length)
  const N = docs.length
  for (const t of q) {
    const n = df.get(t) ?? 0
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)))
  }

  docs.forEach((doc, i) => {
    const key = String(doc.msgId ?? i)
    const toks = tokenized[i]
    if (!toks.length) return
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    let score = 0
    const hit = []
    for (const t of q) {
      const f = tf.get(t) ?? 0
      if (!f) continue
      const denom = f + k1 * (1 - b + (b * toks.length) / Math.max(1e-6, avgdl))
      score += (idf.get(t) ?? 0) * ((f * (k1 + 1)) / Math.max(1e-6, denom))
      hit.push(t)
    }
    if (score > 0) {
      scores.set(key, score)
      terms.set(key, hit)
    }
  })
  return { scores, terms, idf }
}

/**
 * A 档检索。返回按分数从高到低的结果，带可解释的匹配原因。
 *
 * @param {Array<object>} docs 台账消息（只应有 text）
 * @param {string} query
 * @param {{now?:number, threadIds?:Iterable<string>, limit?:number}} [opts]
 */
export function searchLexical(docs, query, { now = Date.now(), threadIds = [], limit = 12 } = {}) {
  const q = tokenize(query)
  const list = (docs ?? []).filter((d) => docText(d))
  if (!q.length) return []
  const { scores, terms } = bm25(list, q)
  const threaded = new Set([...(threadIds ?? [])].map(String))
  const nowMs = Number(now) || Date.now()
  const rows = []
  list.forEach((doc, index) => {
    const id = String(doc.msgId ?? index)
    const base = scores.get(id) ?? 0
    const isThread = threaded.size > 0 && threaded.has(id)
    if (base <= 0 && !isThread) return
    const age = Math.max(0, nowMs - timeOf(doc, nowMs))
    const recentBoost = base > 0 ? 0.2 * Math.exp(-age / (30 * 24 * 3600_000)) : 0
    const threadBoost = isThread ? 0.3 : 0
    const score = base + recentBoost + threadBoost
    const reasons = []
    if (base > 0) reasons.push(`关键词「${(terms.get(id) ?? q).slice(0, 3).join('、')}」`)
    if (isThread) reasons.push('同一条线')
    if (age < 3600_000) reasons.push('最近')
    rows.push({ doc, score, matched: terms.get(id) ?? [], reasons })
  })
  rows.sort((a, b) => (b.score - a.score) || (timeOf(b.doc) - timeOf(a.doc)))
  return rows.slice(0, Math.max(1, Number(limit) || 12))
}

/** 余弦相似度。向量允许 Float32Array / number[]；长度不一致返回 0，不猜。 */
export function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  const n = a.length
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]) || 0
    const y = Number(b[i]) || 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na <= 0 || nb <= 0) return 0
  return dot / Math.sqrt(na * nb)
}

/**
 * B 档打分。vectors: Map<msgId, number[]>。只返回有向量的文档。
 */
export function searchVector(docs, queryVec, vectors, { limit = 12 } = {}) {
  if (!queryVec?.length || !vectors?.size) return []
  const rows = []
  for (const doc of docs ?? []) {
    const id = String(doc.msgId ?? '')
    const v = vectors.get(id)
    if (!v?.length) continue
    const score = cosine(queryVec, v)
    if (score <= 0) continue
    rows.push({ doc, score, matched: [], reasons: ['语义近邻'] })
  }
  rows.sort((a, b) => b.score - a.score)
  return rows.slice(0, Math.max(1, Number(limit) || 12))
}

/**
 * RRF：把多份排名合成一份。只吃名次，不吃原始分数，避免 BM25 和余弦量纲打架。
 * 同一个 msgId 出现多次时分数相加。
 */
export function rrf(rankings, { k = RRF_K } = {}) {
  const acc = new Map()
  const docOf = new Map()
  const reasonsOf = new Map()
  for (const rows of rankings ?? []) {
    rows.forEach((row, i) => {
      const id = String(row?.doc?.msgId ?? '')
      if (!id) return
      const add = 1 / (k + i + 1)
      acc.set(id, (acc.get(id) ?? 0) + add)
      if (!docOf.has(id)) docOf.set(id, row.doc)
      if (row.reasons?.length) {
        reasonsOf.set(id, [...new Set([...(reasonsOf.get(id) ?? []), ...row.reasons])])
      }
    })
  }
  const rows = [...acc.entries()]
    .map(([id, score]) => ({ doc: docOf.get(id), score, matched: [], reasons: reasonsOf.get(id) ?? [] }))
    .sort((a, b) => b.score - a.score)
  return rows
}

/** 本地向量侧车的配置校验：只认本机地址，不读外部凭据。 */
export function parseVectorConfig(raw) {
  let cfg = raw
  if (typeof raw === 'string') {
    try { cfg = JSON.parse(raw) } catch { return { ok: false, why: 'context.json 不是合法 JSON' } }
  }
  const emb = cfg?.embedding
  if (!emb || typeof emb !== 'object') return { ok: false, why: '没有 embedding 配置' }
  let url
  try { url = new URL(String(emb.url ?? '')) } catch { return { ok: false, why: 'embedding.url 不是合法地址' } }
  if (url.protocol !== 'http:') return { ok: false, why: '只允许本机 http' }
  const host = url.hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    return { ok: false, why: 'embedding.url 只能是本机地址' }
  }
  const dim = Number(emb.dim)
  if (!Number.isInteger(dim) || dim < 8 || dim > 8192) return { ok: false, why: 'embedding.dim 不像向量维度' }
  // 首次请求可能包含模型预热/批量嵌入；允许配置 0.5–30 秒，默认仍由调用方决定。
  const timeoutMs = emb.timeoutMs === undefined ? 0 : Number(emb.timeoutMs)
  if (timeoutMs && (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 30_000)) {
    return { ok: false, why: 'embedding.timeoutMs 需要在 500–30000 之间' }
  }
  return {
    ok: true,
    config: {
      url: url.toString().replace(/\/$/, ''),
      model: String(emb.model ?? ''),
      dim,
      timeoutMs,
    },
  }
}

const timeText = (iso) => {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return '时间未知'
  return new Date(t).toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

const confidenceText = (doc) => {
  const s = String(doc?.senderConfidence ?? 'unknown')
  if (s === 'high') return '高'
  if (s === 'medium') return '中'
  return '低'
}

const cut = (text, max) => {
  const chars = [...String(text ?? '')]
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('') + '…'
}

/**
 * 结果卡片。sanitize 由调用方注入（dsh-fish/lib/guard.js 的 sanitizeForeign），
 * 返回 { text, dropped }；没注入就原样，不假装过滤过。
 *
 * @param {Array<{doc:object, score:number, reasons:string[]}>} hits
 */
export function formatCards(hits, {
  max = CARD_MAX,
  budget = CARD_BUDGET,
  sanitize = (t) => ({ text: String(t ?? ''), dropped: 0 }),
  chatNameOf = (doc) => String(doc?.chatName ?? ''),
} = {}) {
  const rows = (hits ?? []).slice(0, Math.max(1, Number(max) || CARD_MAX))
  const cards = []
  let used = 0
  let dropped = 0
  for (const hit of rows) {
    const doc = hit.doc ?? {}
    const clean = sanitize(docText(doc))
    dropped += Number(clean?.dropped) || 0
    const body = String(clean?.text ?? '').trim()
    if (!body) continue
    const n = cards.length + 1
    // L2 摘要不是原文，也不是某个人的发言：来源和说话人都要标清楚，别冒充台账里的原话。
    const isSummary = doc.kind === 'summary' || doc.source === 'summary'
    const who = isSummary
      ? '每日摘要'
      : (doc.sender || (doc.direction === 'out' ? '大肥鱼（发出）' : '发言人未识别'))
    const header = `[上下文 ${n}/${rows.length}] ${chatNameOf(doc) || '（会话名未知）'}｜${who}｜${timeText(doc.at)}`
    const reasons = [...new Set(hit.reasons ?? [])].join(' + ') || '相关'
    const source = isSummary ? `摘要 ${doc.msgId ?? '（无 id）'}` : `台账 ${doc.msgId ?? '（无 id）'}`
    const card = [
      header,
      `「${cut(body, CARD_TEXT_MAX)}」`,
      `匹配：${reasons}；来源：${source}；置信度：${confidenceText(doc)}`,
    ].join('\n')
    const size = [...card].length
    if (cards.length > 0 && used + size > budget) break
    cards.push(card)
    used += size
  }
  const tail = dropped > 0 ? `\n（返回前有 ${dropped} 行被拦下，未显示。）` : ''
  return {
    text: cards.length ? cards.join('\n\n') + tail : (dropped > 0 ? '没有可以显示的内容。' + tail.trim() : '没有找到相关的上下文。'),
    cards,
    shown: cards.length,
    dropped,
  }
}
