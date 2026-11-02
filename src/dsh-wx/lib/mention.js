/**
 * 微信的「@ 她才回」。
 *
 * QQ 那边是通道层按条判（插件里的 requireMention）：没 @ 她的消息根本递不到她面前。
 * 微信没有消息接口，她是在窗口里自己操作的，所以只能按**会话**判：
 * 耳朵看见侧栏里哪个会话有人 @ 她 → 给这个会话盖一个时间戳；
 * 发消息前看这个时间戳还在不在窗口里，不在就不发。
 *
 * 语义（和 QQ 对齐的地方）：没人叫她 → 她不能开口。
 * 不一样的地方：QQ 是「每条消息都要 @」，微信只能做到「被 @ 之后的一小段时间里能说几句」——
 * 因为一次 @ 之后是整段对话，她得能回话、能追问。窗口默认 3 分钟，工作台可调。
 *
 * 侧栏的 `[You were mentioned]` 要她点开才消失，所以挂着的未读 @ 会一直续窗口；
 * 读完再等 3 分钟就自动闭嘴，想让她继续说得再 @ 一次。
 */
export const DEFAULT_WINDOW_MINUTES = 3
const KEEP_MS = 24 * 3600_000

/** 窗口分钟数的兜底：NaN / 0 / 离谱值都不该把她的嘴锁死或者放开。 */
export function parseWindowMinutes(v, def = DEFAULT_WINDOW_MINUTES) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(120, Math.max(1, Math.round(n)))
}

/** 盖上时间戳（同一个会话后来的 @ 直接覆盖，窗口重新算）。 */
export function grant(state, chat, now) {
  if (!chat) return state ?? {}
  return { ...(state ?? {}), [String(chat)]: now }
}

/** 现在能不能在这个会话里说话。 */
export function canSpeak(state, chat, now, windowMinutes) {
  const at = Number((state ?? {})[String(chat)])
  if (!Number.isFinite(at)) return { ok: false, reason: '最近没人 @ 你' }
  const leftMs = at + parseWindowMinutes(windowMinutes) * 60_000 - now
  if (leftMs <= 0) return { ok: false, reason: `上一次 @ 你已经是 ${parseWindowMinutes(windowMinutes)} 分钟前的事了` }
  return { ok: true, leftMs }
}

/** 清掉一天以前的记录，文件不会越滚越大。 */
export function prune(state, now) {
  const out = {}
  for (const [k, v] of Object.entries(state ?? {})) {
    const t = Number(v)
    if (Number.isFinite(t) && now - t < KEEP_MS) out[k] = t
  }
  return out
}

/** 给一段文字里点到的会话盖戳（手动 poke 用：`echo '测试群A …' > ~/.dsh-wx/poke`）。 */
export function grantMentioned(state, text, chats, now) {
  let next = state ?? {}
  for (const c of chats ?? []) {
    if (c && String(text ?? '').includes(String(c))) next = grant(next, c, now)
  }
  return next
}
