/**
 * ear-open.js —— 当前打开会话的唤醒补丁。
 *
 * 侧栏判据（tree.js 的 mentionHits）要求 unread > 0 或微信自己的 @ 标。
 * 但当前打开的会话收到消息时，微信不会再亮未读；于是真人接着说下一句，
 * 耳朵完全看不到（2026-11-05 13:39 的「午安」；11-04 17:22 同一条会话也漏过一次）。
 *
 * 这里补一条判据：当前会话是免 @ 私聊（或允许名单里的单聊/群聊），这一轮
 * captureCurrent() 新记进台账的入站正文和侧栏 preview 对得上，就算她在叫她。
 * 群聊要求正文里有 @（或配置的 trigger）：当前会话开着时，同一个人接着 @ 她，
 * 侧栏不会有未读角标，只能靠这条补齐。
 *
 * 判据分两步：
 *   1. 第一次看见这个会话（刚启动 / 刚点开）：整屏旧消息都会变成「新记录」，
 *      只认和侧栏 preview 对得上的那一条。
 *   2. 之后：台账只追加这一轮新记下的入站记录，台账本身就是新消息的证据，
 *      不再要求 preview 对得上——会话开着时侧栏可能没有这一行、preview 可能
 *      被下一条覆盖或截断，用 preview 当唯一判据会漏掉新消息（2026-11-10 09:08）。
 * 两种情况都要排除她自己刚发出去、又被发言人归因误记成入站的话（11-04 17:22）；
 * capture 返回的 dropped 是已经入过账的 preview 副本，不是新消息，不参与。
 */
import { parsePreviewSender, samePreviewText } from './speaker.js'
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
 * @param {object|null} req.row 侧栏这一行，用 unread 和 preview；会话滚出可视区时可以是 null
 * @param {object|null} req.captured captureCurrent() 的返回值
 * @param {object} req.policy 含 allowChats / noMentionChats / trigger
 * @param {number} [req.now]
 * @param {number} [req.maxAgeMs]
 * @param {boolean|null} [req.isDM] 目录里已知的会话类型；null 时按 preview 猜
 * @param {boolean} [req.requirePreviewMatch] 首次看见这个会话时为 true：只认 preview 对得上的记录
 * @param {string[]} [req.outbox] 她自己最近发出去、回执确认过的原文（排回声）
 * @returns {{chat:string, why:string, preview:string, unread:number, key:string}|null}
 */
export function openChatHit({
  chat, row, captured, policy, now = Date.now(), maxAgeMs = OPEN_HIT_MAX_AGE_MS,
  isDM = null, requirePreviewMatch = true, outbox = [],
} = {}) {
  const name = String(chat ?? '').trim()
  if (!name) return null
  // 侧栏有未读时老路径会叫，这里不重复。
  if (Number(row?.unread) > 0) return null
  const preview = String(row?.preview ?? '')
  if (requirePreviewMatch && !preview) return null

  const allow = Array.isArray(policy?.allowChats) ? policy.allowChats : []
  const exemptList = Array.isArray(policy?.noMentionChats) ? policy.noMentionChats : []
  const exempt = exemptList.some((n) => sameName(n, name))
  const allowed = allow.some((n) => sameName(n, name))
  if (!exempt && !allowed) return null

  // 群聊预览是「发送者: 正文」；比对时要去掉发送者前缀，否则正文永远对不上。
  const pv = parsePreviewSender(preview)
  const body = pv.text || preview
  const inGroup = isDM === false ? true : (isDM === true ? false : (Boolean(pv.sender) || !looksDM(row)))
  // 群里有人 @ 她（或按配置的名字）才算叫她；普通闲聊不叫醒。
  const trigger = Array.isArray(policy?.trigger) ? policy.trigger.filter(Boolean) : []

  // 她自己的话被发言人归因误记成入站：拿 outbox 原文排掉。
  const own = Array.isArray(outbox) ? outbox.map((t) => String(t ?? '')) : []
  const isOwnEcho = (text) => own.some((t) =>
    samePreviewText(t, String(text ?? '')) || samePreviewText(String(text ?? ''), t))

  const limit = Math.max(0, Number(maxAgeMs) || 0)
  const records = (Array.isArray(captured?.records) ? captured.records : [])
    .filter((r) => r && r.msgId && r.text && r.direction === 'in')
    .filter((r) => !isOwnEcho(r.text))
    .filter((r) => {
      const at = Date.parse(String(r.at ?? ''))
      // 树里读不到时间就只靠 preview 兜底；读得到就限一个窗口，避免首屏旧消息被叫醒。
      return !Number.isFinite(at) || now - at <= limit
    })
  const matched = preview ? records.filter((r) => samePreviewText(body, String(r.text))) : []
  // 首次整屏只认 preview 对得上的；之后 preview 对不上也认台账新记录。
  const candidates = requirePreviewMatch ? matched : (matched.length ? matched : records)
  const rec = candidates
    .filter((r) => {
      if (exempt || !inGroup) return true
      // 判断「叫没叫她」用这条新消息本身：preview 可能还是上一条。
      const text = matched.includes(r) ? body : String(r.text ?? '')
      return /@\S/.test(text) || trigger.some((t) => text.includes(String(t)))
    })
    .at(-1)
  if (!rec) return null

  return {
    chat: name,
    why: exempt ? 'exempt' : (inGroup ? 'at' : 'dm'),
    preview: matched.includes(rec) && preview ? preview : String(rec.text),
    unread: 0,
    key: 'capture:' + rec.msgId,
  }
}
