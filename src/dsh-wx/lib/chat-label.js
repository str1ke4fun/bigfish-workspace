/**
 * 会话列表一行的 label → 字段。
 *
 * 微信 4.x 的会话行，无障碍 label 是用换行分字段的：
 *   名字 \n [未读数] \n [You were mentioned] \n 预览 \n 时间 \n
 * 第一行永远是名字，其余行的写法固定，所以按行认，不靠"在哪个括号前断开"去猜。
 * （以前把换行抹成空格再切，名字和预览糊在一起，没有括号的行连名字都切不出来。）
 */
const MENTION = /^\[(?:you were mentioned|you were @ed|有人@我|有人@你)\]$/i
const DRAFT = /^\[(?:draft|草稿)\]$/i
const PINNED = /^(?:pinned to top|置顶)$/i
const UNREAD = /^\[(\d+)\]$/
const UNREAD_MUTED = /^\[(\d+) ?(?:unread|messages?|条)[^\]]*\]$/i
// 时间：16:19 / Yesterday 23:49 / 昨天 23:49 / Mon / 10/28 / 2026/10/28
const TIME = new RegExp(
  '^(?:' +
    '(?:yesterday |昨天 |星期[一二三四五六日天] ?)?\\d{1,2}:\\d{2}' +
    '|(?:yesterday|mon|tue|wed|thu|fri|sat|sun)[a-z]*' +
    '|昨天|星期[一二三四五六日天]|周[一二三四五六日天]' +
    '|\\d{1,4}[/.-]\\d{1,2}(?:[/.-]\\d{1,4})?' +
  ')$',
  'i',
)

export function parseChatLabel(raw) {
  const lines = String(raw ?? '').split('\n').map((s) => s.trim())
  const name = lines[0] ?? ''
  const out = { name, unread: 0, muted: false, mention: false, draft: false, pinned: false, time: '', preview: '' }
  const preview = []
  const rest = lines.slice(1).filter(Boolean)
  // 时间永远是最后一行；别的行就算长得像时间（有人发了条"12:30"），也是预览
  if (rest.length > 0 && TIME.test(rest[rest.length - 1])) out.time = rest.pop()
  for (const l of rest) {
    let m
    if ((m = l.match(UNREAD))) { out.unread = Number(m[1]); continue }
    if ((m = l.match(UNREAD_MUTED))) { out.unread = Number(m[1]); out.muted = true; continue }
    if (MENTION.test(l)) { out.mention = true; continue }
    if (DRAFT.test(l)) { out.draft = true; continue }
    if (PINNED.test(l)) { out.pinned = true; continue }
    preview.push(l)
  }
  out.preview = preview.join(' ')
  return out
}
