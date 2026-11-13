/**
 * contact.js —— 「有人来找过我」的判定与唯一写入口。
 *
 * 合并裁决 D4：contact 有两层。
 *   meta seen:<ISO>                全局 contact，任何通道都写；absence/away/persona 只读它。
 *   meta contact:<source>:<ISO>    per-source contact，给跨通道卡用。
 * markSeen 是唯一写入口：先写 seen，再写 contact；contact 失败不回滚 seen。
 *
 * 合并裁决 D25：第二段叫 source（来源标记），不是事件 channel。
 *   source ∈ web|wx|qq|bili|screen；事件 channel 域仍是 core|wx|qq|web，两者不是一回事。
 *
 * 合并裁决 D16：系统自己发起的 prompt 用固定 rpcId 前缀，不能当成用户来找她。
 * 这些前缀同时覆盖 B 站出门 fallback（sessions.prompt 的 `fish-`）。
 */

import { appendEvent, rootDir } from './store.js'
import { WAKE_TRIGGER, BILI_TRIGGER } from './wakeconst.js'

/** 收盘 trigger 的字面值。收盘任务可能后于本文件落地，先按字符串排除，避免 import 不存在的常量。 */
const CLOSING_TRIGGER_TEXT = '（收工了。）'

/** `contact:<source>:` 允许的来源标记。screen 是预留，v1 没有来源会写它。 */
export const CONTACT_SOURCES = Object.freeze(['web', 'wx', 'qq', 'bili', 'screen'])

/** 系统 prompt 的 rpcId 前缀（D16 统一表，含 `fish-`）。 */
export const SYSTEM_RPC = /^(?:wake-|wake-fresh-|closing-|bili-|say-|presence-|fish-)/

const DEDUPE_MS = 60_000
let lastBySource = new Map()

/** 只把「恰好一个文本块」当成可判定的文本；多块/图片一律视为非文本（仍算 contact）。 */
function textOf(data) {
  const content = Array.isArray(data?.content) ? data.content : []
  if (content.length !== 1) return ''
  const [block] = content
  return block?.type === 'text' ? String(block.text ?? '') : ''
}

/**
 * 这条 user/message 是不是「真人来找她」。
 *
 * v1 只认 DSH web 面的真实用户消息（微信/B 站各自的联系由它们的适配器调 markSeen）。
 * surface 在 bootstrap 前可能是 null：null 不写，避免把系统消息误记成 contact。
 */
export function isContactMessage({ event, surface } = {}) {
  if (!event || event.type !== 'user/message') return false
  if (surface !== 'web') return false
  const source = event.data?.source
  if (!source || source.kind !== 'user') return false
  if (SYSTEM_RPC.test(String(source.rpcId ?? ''))) return false
  const text = textOf(event.data)
  if (text === WAKE_TRIGGER || text === CLOSING_TRIGGER_TEXT) return false
  if (text === BILI_TRIGGER) return false
  if (text.startsWith('[微信·主机]')) return false
  return true
}

/**
 * 记录一次 contact：先 seen，再 contact。
 *
 * @param {string} root 状态库根目录
 * @param {{ source?: string, channel?: string, at?: number, dedupe?: boolean }} opts
 *        `source` 是来源标记（D25）；`channel` 仅为兼容旧计划命名的别名。
 * @returns {Promise<{ ok: boolean, contact?: boolean, skipped?: boolean, why?: string }>}
 */
export async function markSeen(root = rootDir(), { source, channel, at = Date.now(), dedupe = true } = {}) {
  const raw = source ?? channel ?? 'web'
  // 未知 source 回退 web：宁可记成「web 有人来」，也不让脏值进事件流。
  const src = CONTACT_SOURCES.includes(String(raw)) ? String(raw) : 'web'
  const n = Number(at)
  const now = Number.isFinite(n) ? n : Date.now()
  const last = lastBySource.get(src) ?? 0
  if (dedupe && now - last < DEDUPE_MS) return { ok: true, skipped: true, contact: false }
  const iso = new Date(now).toISOString()

  try {
    await appendEvent({ type: 'meta', text: `seen:${iso}` }, { source: 'system' }, root)
  } catch (err) {
    // seen 没写成功 -> 去重窗口不消费，下一次调用还会重试。
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
  // seen 成功后才生效去重。
  lastBySource.set(src, now)

  try {
    await appendEvent({ type: 'meta', text: `contact:${src}:${iso}` }, { source: 'system' }, root)
  } catch (err) {
    // D4：contact 失败不回滚 seen，也不回滚去重窗口。
    return { ok: true, contact: false, why: String(err?.message ?? err).slice(0, 160) }
  }
  return { ok: true, contact: true }
}

/** 清空内存去重表（测试与显式重置用）。重启后失效本来就是可接受的语义。 */
export function resetContactCache() {
  lastBySource = new Map()
}
