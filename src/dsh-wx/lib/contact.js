/**
 * dsh-wx contact 口径（2026-11-13）。
 *
 * v1 只把「单聊」和「免 @ 白名单」算成“他来找她”。群里的点名/@ 先不算：
 * 群昵称可以被备注掩盖，单次字符串相等不足以证明是 owner；拿不准就不写 seen。
 */
export function isContactWhy(why) {
  return why === 'dm' || why === 'exempt'
}
