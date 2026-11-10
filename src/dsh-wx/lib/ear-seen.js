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
import { samePreviewText } from './speaker.js'

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
    out.set(key, { at, chat })
  }
  return out
}

/**
 * 会话被读到（未读=0）→ 这一轮未读回合结束，清掉这个会话的投递记忆。
 * 没出现在这一屏的会话不动：没看见不代表已读。
 * 返回清掉的条数，调用方据此决定要不要落盘。
 */
export function forgetReadChats(seen, chats, same = sameName) {
  const read = (chats ?? [])
    .filter((c) => Number(c?.unread) === 0 && c?.name)
    .map((c) => String(c.name))
  if (!read.length) return 0
  let n = 0
  for (const [key, rec] of seen) {
    if (read.some((name) => same(name, rec?.chat))) {
      seen.delete(key)
      n += 1
    }
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
 * 已经投过的 key 不再投；@ 立刻能投，其余命中只要不是她自己的回声就能投。
 */
export function freshHits(hits, seen, { isEcho = () => false } = {}) {
  return (hits ?? []).filter((m) => !seen.has(m.key) && (m.why === '@' || !isEcho(m)))
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
    })),
    at: new Date(now).toISOString(),
  }
}
