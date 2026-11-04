/**
 * speaker.js —— 谁说的
 *
 * 微信 4.x 的无障碍树只给消息正文，不给发言人（wx-elements.mjs 亲测：
 * messages list item 的 label 就是正文，没有子节点）。所以这里按证据强弱分层：
 *
 *   1. 结构化字段（以后树补上 sender 时）→ high；
 *   2. 私聊 → 对方就是会话名，high；
 *   3. 群聊侧栏预览的 `名字: 内容` → 只能覆盖最后一条，medium；
 *   4. 出站回执里她刚发过的原文 → direction=out，sender=null；
 *   5. 都没有 → sender=null / unknown，卡片写「发言人未识别」。
 *
 * 绝不从正文猜发言人。正文里写「张三说」不代表发言人是张三。
 * 这里只做纯函数，读盘、写 repair 由 context.js 负责。
 */

const str = (v) => String(v ?? '').trim()

/** 群聊预览的发言人头：`安卓4224柚厨圣: 内容`。排除系统标记和时间。 */
const PREVIEW_SENDER = /^([^:：\n]{1,24})[:：]\s*(\S[\s\S]*)$/u
const SYSTEM_PREFIX = /^(?:\[(?:Link|Sticker|Image|File|Voice|Video|Animation|Emoji|图片|表情|文件|语音|视频)\]|系统消息|撤回了一条消息|你撤回了一条消息)$/iu

// 预览头里的时间、星期和提示词，都可能是「名字: 内容」的假象。
const CLOCK = /^\d{1,2}[:：]\d{2}$/
const DAY_WORD = /^(?:Yesterday|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|昨天|今天|周[一二三四五六日天]|星期[一二三四五六日天])$/i

/**
 * 预览里能不能读出「谁: 什么」。读不出返回空。
 * 昵称不按字符类别或词典过滤：纯 emoji、纯数字也能是发言人，
 * 只是这种名字要两次不同观察才建档（needsEvidence）。
 */
export function parsePreviewSender(preview) {
  const raw = str(preview)
  if (!raw) return { sender: null, text: '', confidence: 'unknown', needsEvidence: false }
  const m = raw.match(PREVIEW_SENDER)
  if (!m) return { sender: null, text: raw, confidence: 'unknown', needsEvidence: false }
  const who = str(m[1])
  const body = str(m[2])
  if (!who || !body || SYSTEM_PREFIX.test(who)) {
    return { sender: null, text: raw, confidence: 'unknown', needsEvidence: false }
  }
  // 预览里常见的系统后缀，不算发言人
  if (/^(?:你|You)$/i.test(who)) {
    return { sender: null, text: body, confidence: 'unknown', needsEvidence: false }
  }

  // 时间头（如「14:02 开会」）的冒号把时间切进了 who，首段也要查。
  const head = raw.split(/\s+/)[0] ?? ''
  const nameLength = [...who].length
  if (
    CLOCK.test(who) || DAY_WORD.test(who) || CLOCK.test(head) || DAY_WORD.test(head)
    || nameLength < 1 || nameLength > 24
  ) return { sender: null, text: raw, confidence: 'unknown', needsEvidence: false }
  return { sender: who, text: body, confidence: 'medium', needsEvidence: !/\p{L}/u.test(who) }
}

/** 私聊：侧栏预览通常没有「发送者:」前缀。group 名单只用于展示，不用于发送授权。 */
export function looksLikeDirect(preview) {
  const raw = str(preview)
  if (!raw) return true
  return !PREVIEW_SENDER.test(raw)
}

const normalize = (s) => str(s).replace(/\s+/g, ' ')

/** 内容是否对得上：预览往往只是正文开头，允许前缀匹配。 */
export function samePreviewText(a, b) {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return false
  if (x === y) return true
  const short = x.length <= y.length ? x : y
  const long = x.length <= y.length ? y : x
  if (short.length < 6) return false
  return long.startsWith(short)
}

const timeOf = (v, fallback = 0) => {
  const t = Date.parse(String(v ?? ''))
  return Number.isFinite(t) ? t : fallback
}

/**
 * 给一屏消息补发言人 / 方向。返回新数组，不改输入。
 *
 * @param {object} req
 * @param {string} req.chat 当前会话名
 * @param {boolean} [req.isDM] 私聊
 * @param {string} [req.preview] 侧栏里这个会话的预览
 * @param {Array<{text?:string, sender?:string|null, senderConfidence?:string, direction?:string, at?:string}>} req.messages
 * @param {Array<{chat?:string, text?:string, at?:string|number}>} [req.outbox] 她最近发出去、回执确认过的原文
 * @param {number} [req.now]
 */
export function attributeMessages({
  chat = '', isDM = false, preview = '', messages = [], outbox = [], now = Date.now(),
} = {}) {
  const list = Array.isArray(messages) ? messages : []
  const pv = parsePreviewSender(preview)
  const chatName = str(chat)
  const recentOut = (Array.isArray(outbox) ? outbox : [])
    .filter((x) => x && x.text && (!x.chat || !chatName || normalize(x.chat) === normalize(chatName)))
    .map((x) => ({ text: normalize(x.text), at: timeOf(x.at, 0) }))
    .filter((x) => !x.at || now - x.at <= 30 * 60_000)

  // 只有最后一条对得上预览时才用预览里的发言人。对不上就不硬套。
  let previewIndex = -1
  if (pv.sender) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (samePreviewText(pv.text, list[i]?.text)) { previewIndex = i; break }
    }
  }

  return list.map((m, i) => {
    if (!m || typeof m !== 'object') return m
    const out = { ...m }
    const text = normalize(out.text)
    const sent = recentOut.find((x) => x.text && (x.text === text || (text.length >= 6 && text.startsWith(x.text))))
    if (out.direction === 'out' || sent) {
      out.direction = 'out'
      // 她自己的话不冒充发言人；出站由卡片统一标「大肥鱼（发出）」。
      if (!out.sender) out.sender = null
      if (!out.senderConfidence) out.senderConfidence = sent ? 'high' : 'unknown'
      return out
    }

    // 树里已经给了结构化发言人：最高优先级，不覆盖。
    if (out.sender && out.senderConfidence !== 'unknown') {
      out.direction = 'in'
      return out
    }

    if (isDM && chatName) {
      out.sender = chatName
      out.senderConfidence = 'high'
      out.direction = 'in'
      return out
    }

    if (i === previewIndex && pv.sender) {
      out.sender = pv.sender
      out.senderConfidence = 'medium'
      out.direction = 'in'
      return out
    }

    out.sender = null
    out.senderConfidence = 'unknown'
    out.direction = 'in'
    return out
  })
}

/**
 * 侧栏 / 任务里的「谁在找她」。私聊返回会话名；群聊只认预览头；都读不出就 null。
 * kind: dm / group-member / unknown
 */
export function requesterOf({ chat = '', isDM = false, preview = '' } = {}) {
  if (isDM && str(chat)) return { name: str(chat), kind: 'dm', confidence: 'high' }
  const pv = parsePreviewSender(preview)
  if (pv.sender) return { name: pv.sender, kind: 'group-member', confidence: pv.confidence }
  return { name: null, kind: 'unknown', confidence: 'unknown' }
}
