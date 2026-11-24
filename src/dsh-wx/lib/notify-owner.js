/**
 * notify-owner.js —— 老板汇总发回微信前的纯文本处理
 *
 * 只做三件事：压平换行、截到 500 字、秘密命中改通用文案。
 * 发送仍走 wx 的发送闸和串行锁，这里不碰 GUI。
 */

export const OWNER_NOTICE_LIMIT = 500
export const OWNER_NOTICE_SECRET_TEXT = '做完了，详情在电脑上'
export const OWNER_NOTICE_DETAIL_TEXT = '（详情在电脑上）'

/** 微信只收结论：去掉代码块、路径和 Markdown 记号，完整内容留在工头会话。 */
function scrubDetail(text) {
  let out = String(text ?? '')
  out = out.replace(/```[\s\S]*?```/g, OWNER_NOTICE_DETAIL_TEXT)
  out = out.replace(/`([^`]*)`/g, (_m, inner) => (
    /[\\/]/.test(inner) || [...inner].length > 40 ? OWNER_NOTICE_DETAIL_TEXT : inner
  ))
  out = out.replace(/[A-Za-z]:\\[^\s，。；、）】"'`]+/g, OWNER_NOTICE_DETAIL_TEXT)
  out = out.replace(/(?:\/[\w.@-]+){2,}/g, OWNER_NOTICE_DETAIL_TEXT)
  out = out.replace(/\*\*|__/g, '')
  return out
}

/**
 * @param {string} text
 * @param {{ looksLikeSecret?: (text: string) => boolean|{hit?:boolean} }} [opts]
 * @returns {{ok:true, text:string}|{ok:false, why:string}}
 */
export function ownerNoticeText(text, { looksLikeSecret } = {}) {
  let body = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim()
  if (!body) return { ok: false, why: 'empty' }
  body = scrubDetail(body)
  if ([...body].length > OWNER_NOTICE_LIMIT) {
    body = [...body].slice(0, OWNER_NOTICE_LIMIT).join('')
  }
  try {
    const hit = looksLikeSecret?.(body)
    if (hit === true || hit?.hit === true) body = OWNER_NOTICE_SECRET_TEXT
  } catch { /* 守门失败不改变发送 */ }
  return { ok: true, text: body }
}
