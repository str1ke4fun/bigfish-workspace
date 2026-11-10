/**
 * ear-open.js —— 当前打开会话的唤醒补丁。
 *
 * 侧栏判据（tree.js 的 mentionHits）要求 unread > 0 或微信自己的 @ 标。
 * 但当前打开的会话收到消息时，微信不会再亮未读；于是真人接着说下一句，
 * 耳朵完全看不到（2026-11-05 13:39 的「午安」；11-04 17:22 同一条会话也漏过一次）。
 *
 * 这里补一条判据：当前会话是免 @ 私聊（或允许名单里的单聊），这一轮
 * captureCurrent() 新记进台账的入站正文和侧栏 preview 对得上，就算她在叫她。
 *
 * 只认「和 preview 对得上」和「这一轮新记下」：
 *   - preview 永远是最新一条，她自己的回复、启动首屏的旧消息都对不上；
 *   - speaker 归因有时会把旧出站重新记成入站（11-04 17:22 的脏记录），也对不上；
 *   - capture 返回的 dropped 是已经入过账的 preview 副本，不是新消息，不参与。
 */
import { samePreviewText } from './speaker.js'
import { sameName } from './tree.js'

/** 新记录最多能有多旧还叫。当前会话的树时间通常精确到分钟，留足余量。 */
export const OPEN_HIT_MAX_AGE_MS = 15 * 60_000

/** 单聊预览没有「发送者:」前缀。和 tree.js 里 looksDM 同一条规则。 */
export function looksDM(row) {
  const preview = String(row?.preview ?? '')
  return Boolean(preview) && !/^[^:：]{1,20}[:：]\s/.test(preview)
}

/**
 * 当前打开会话这一轮有没有该投的入站消息。
 *
 * @param {object} req
 * @param {string} req.chat 当前打开会话（parsed.current）
 * @param {object|null} req.row 侧栏这一行，用 unread 和 preview
 * @param {object|null} req.captured captureCurrent() 的返回值
 * @param {object} req.policy 含 allowChats / noMentionChats
 * @param {number} [req.now]
 * @param {number} [req.maxAgeMs]
 * @returns {{chat:string, why:string, preview:string, unread:number, key:string}|null}
 */
export function openChatHit({
  chat, row, captured, policy, now = Date.now(), maxAgeMs = OPEN_HIT_MAX_AGE_MS,
} = {}) {
  const name = String(chat ?? '').trim()
  if (!name || !row) return null
  // 侧栏有未读时老路径会叫，这里不重复。
  if (Number(row.unread) > 0) return null
  const preview = String(row.preview ?? '')
  if (!preview) return null

  const allow = Array.isArray(policy?.allowChats) ? policy.allowChats : []
  const exemptList = Array.isArray(policy?.noMentionChats) ? policy.noMentionChats : []
  const exempt = exemptList.some((n) => sameName(n, name))
  const allowed = allow.some((n) => sameName(n, name))
  if (!exempt && !allowed) return null
  // 群聊只看 @；预览里的「发送者:」前缀就是群聊的识别特征。
  if (!exempt && !looksDM(row)) return null

  const records = Array.isArray(captured?.records) ? captured.records : []
  const limit = Math.max(0, Number(maxAgeMs) || 0)
  const rec = records
    .filter((r) => r && r.msgId && r.text && r.direction === 'in')
    .filter((r) => samePreviewText(preview, String(r.text)))
    .filter((r) => {
      const at = Date.parse(String(r.at ?? ''))
      // 树里读不到时间就只靠 preview 兜底；读得到就限一个窗口，避免首屏旧消息被叫醒。
      return !Number.isFinite(at) || now - at <= limit
    })
    .at(-1)
  if (!rec) return null

  return {
    chat: name,
    why: exempt ? 'exempt' : 'dm',
    preview,
    unread: 0,
    key: 'capture:' + rec.msgId,
  }
}
