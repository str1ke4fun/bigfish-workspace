/**
 * ear-seen.js —— 耳朵的「投过了」账本。
 *
 * key 是「会话 + 预览文字」。如果只按 key 永久去重，同一句话隔几天再发一遍会撞上旧 key，
 * 耳朵会把它当成回声静默丢掉（2026-11-05 早上 09:44 的「早」就是这么丢的：11-03 投过一次，
 * 同样的 key 还在盘上，于是这一轮既不投递也不打日志，随后红点被采集点开清掉，就再也补不回来）。
 *
 * 所以投递记忆只对一个「未读回合」有效：
 *   - 会话被读到（未读归零）→ 清掉这个会话的记录，之后同样的字再发一次算新消息；
 *   - 另留 24 小时兜底，避免被读到但一直没出现在侧栏的会话把 key 带到天荒地老；
 *   - 上限按时间保留最新的 200 条，盘不会越滚越大。
 */
import { sameName } from './tree.js'
import { parsePreviewSender, samePreviewText } from './speaker.js'

/** 比较「是不是同一句」时只看正文：群预览可能带「发送者: 」前缀，同一条消息两种写法。 */
const bodyOf = (text) => {
  const raw = String(text ?? '')
  return parsePreviewSender(raw).text || raw
}

/** key 的第三段是预览正文；前两段是会话名和 @ 标记。 */
function previewOfKey(key) {
  const first = String(key ?? '').indexOf('|')
  if (first < 0) return ''
  const second = String(key).indexOf('|', first + 1)
  return second < 0 ? '' : String(key).slice(second + 1)
}

export const SEEN_TTL_MS = 24 * 3600_000
export const SEEN_CAP = 200

/**
 * 读盘。兼容旧格式（`delivered` 是纯字符串数组）和新格式（`{key, at, chat}`）。
 * 旧记录不知道投递时间，按「刚刚投过」处理，交给会话已读来清，避免升级后把还挂着的未读重投一遍。
 */
export function parseSeen(raw, now = Date.now()) {
  const out = new Map()
  const arr = Array.isArray(raw?.delivered) ? raw.delivered : []
  for (const x of arr) {
    if (!x) continue
    const key = typeof x === 'string' ? x : String(x.key ?? '')
    if (!key) continue
    const at = typeof x === 'string' ? now : Number(x.at) || now
    const chat = String(typeof x === 'string' ? '' : x.chat ?? '') || key.split('|')[0] || ''
    const text = String(typeof x === 'string' ? '' : x.text ?? '')
    out.set(key, text ? { at, chat, text } : { at, chat })
  }
  return out
}

/**
 * 会话被读到（未读=0）→ 这一轮未读回合结束，清掉这个会话的投递记忆。
 * 但 `capture:<msgId>` 是稳定消息号，后台采集会反复重读同一条消息，不清；
 * 预览键如果还是同一句（例如她刚回完、那行 @ 还挂在侧栏）也保留，直到预览换掉。
 * 没出现在这一屏的会话不动：没看见不代表已读。
 * 返回清掉的条数，调用方据此决定要不要落盘。
 */
export function forgetReadChats(seen, chats, same = sameName) {
  const read = (chats ?? [])
    .filter((c) => Number(c?.unread) === 0 && c?.name)
    .map((c) => ({ name: String(c.name), preview: String(c?.preview ?? '') }))
  if (!read.length) return 0
  let n = 0
  for (const [key, rec] of seen) {
    // capture:<msgId> 是稳定消息号：同一条消息被后台采集重读多少次都不该再叫，
    // 不能因为未读归零就清掉；过期交给 pruneSeen 的 24 小时 TTL。
    if (String(key).startsWith('capture:')) continue
    const row = read.find((c) => same(c.name, rec?.chat))
    if (!row) continue
    // 预览仍在同一句：这不是新回合，保留 key，避免同一句每隔几分钟又推一次。
    // capture/m_xxx 这类 key 里没有正文，优先用投递时记下的 text。
    const keyPreview = String(rec?.text ?? '') || previewOfKey(key)
    if (row.preview && keyPreview && samePreviewText(bodyOf(row.preview), bodyOf(keyPreview))) continue
    seen.delete(key)
    n += 1
  }
  return n
}

/**
 * 侧栏预览是不是她自己刚发出去的那句话。
 * 只有 outbox 里（发送回执确认过）的原文才算回声；不再按「上次投递后 45 秒」一刀切，
 * 否则真人 20 秒后的追问会被一起吞掉（2026-11-05 09:53 的「这么高冷」就是这么丢的）。
 */
export function ownEcho(chat, preview, outbox = [], { now = Date.now(), echoMs = 45_000, same = samePreviewText } = {}) {
  if (!preview) return false
  return (Array.isArray(outbox) ? outbox : []).some((x) => x && x.text &&
    (!x.chat || sameName(x.chat, chat)) &&
    now - (Number(x.at) || 0) <= echoMs &&
    same(preview, x.text))
}

/**
 * 这一轮真正要投的命中。
 * 已经投过的 key 不再投；同一个会话里正文对得上的旧 key 也不再投
 * （群预览带不带「发送者:」前缀会换 key）；@ 立刻能投，其余命中只要不是
 * 她自己的回声就能投。
 */
export function freshHits(hits, seen, { isEcho = () => false, same = samePreviewText } = {}) {
  const alreadyDelivered = (m) => {
    if (seen.has(m.key)) return true
    const body = bodyOf(m?.preview)
    if (!body) return false
    for (const [key, rec] of seen) {
      // capture/m_xxx 这类 key 里没有正文，投递时把正文一起记进 seen；旧记录退回 key。
      const text = String(rec?.text ?? '') || previewOfKey(key)
      if (!text) continue
      const chat = String(rec?.chat ?? '') || String(key).split('|')[0] || ''
      if (sameName(chat, m.chat) && same(bodyOf(text), body)) return true
    }
    return false
  }
  return (hits ?? []).filter((m) => !alreadyDelivered(m) && (m.why === '@' || !isEcho(m)))
}

/** 同一会话里同一句话，这么久之内只投一次。 */
export const CONTENT_WINDOW_MS = 5 * 60_000

/**
 * 按「会话 + 正文」在时间窗口内去重。
 *
 * msgId 和 key 都会因为整屏采集的「上一条 / 发言人」变化而换新，同一句话被重新读到
 * 就成了新 key（2026-11-13 04:05 的「中午吃什么」隔 17 秒投了两次）。内容记录独立于
 * seen：会话被读到不清它，所以采集清掉未读后同一句话也不会再投。
 *
 * recent 是数组 `{chat, text, at}`，由调用方持有；这里只读，写入走 noteContent。
 */
export function dropRecentContent(hits, recent, { now = Date.now(), windowMs = CONTENT_WINDOW_MS, same = samePreviewText } = {}) {
  const batch = []
  return (hits ?? []).filter((m) => {
    const text = String(m?.preview ?? '')
    if (!text) return true
    // 群预览有时带「发送者: 」前缀、有时不带；同一条消息不能因此算两句。
    const dup = (r) => sameName(r.chat, m.chat) && same(bodyOf(r.text), bodyOf(text))
    if ((Array.isArray(recent) ? recent : []).some((r) => now - (Number(r.at) || 0) <= windowMs && dup(r))) return false
    if (batch.some(dup)) return false
    batch.push({ chat: m.chat, text })
    return true
  })
}

/** 投递成功后记一笔。同一句话刷新时间，不重复堆。 */
export function noteContent(recent, hit, { now = Date.now(), windowMs = CONTENT_WINDOW_MS, same = samePreviewText } = {}) {
  const text = String(hit?.preview ?? '')
  if (!text) return
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i]
    if (now - (Number(r.at) || 0) > windowMs) recent.splice(i, 1)
    else if (sameName(r.chat, hit.chat) && same(bodyOf(r.text), bodyOf(text))) recent.splice(i, 1)
  }
  recent.push({ chat: hit.chat, text, at: now })
}

/** 过期清理 + 按时间保留最新 cap 条。 */
export function pruneSeen(seen, { now = Date.now(), ttlMs = SEEN_TTL_MS, cap = SEEN_CAP } = {}) {
  for (const [key, rec] of seen) {
    if (now - Number(rec?.at ?? 0) > ttlMs) seen.delete(key)
  }
  if (seen.size > cap) {
    const keep = [...seen.entries()]
      .sort((a, b) => (a[1]?.at ?? 0) - (b[1]?.at ?? 0))
      .slice(-cap)
    seen.clear()
    for (const [key, rec] of keep) seen.set(key, rec)
  }
}

/** 落盘结构。 */
export function serializeSeen(seen, now = Date.now()) {
  return {
    delivered: [...seen].map(([key, rec]) => ({
      key,
      at: Number(rec?.at) || 0,
      chat: String(rec?.chat ?? ''),
      ...(rec?.text ? { text: String(rec.text) } : {}),
    })),
    at: new Date(now).toISOString(),
  }
}
