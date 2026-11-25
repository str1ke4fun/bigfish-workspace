/**
 * 一次性状态迁移：旧文件的键是会话名，新文件的键是目录 chatId。
 *
 * 名字会漂移：同一群可能写成 `❤️读书群` 或 `❤读书群`，截断名补全后也会变。
 * 以名字为键时，@ 窗口、主动额度、最近会话都可能在两种写法之间各记一份；
 * 目录 chatId 一旦分配就不换，才是稳定身份。
 *
 * 纯函数，不读文件、不写文件：调用方负责备份与写回。
 * 迁移是保守的：空身份跳过，撞键取「更宽松」的值（时间戳/计数取最大），
 * 宁可让她多一个窗口/额度，也不因为迁移把已有的记录吞掉。
 */
import { sanitizeName } from './name.js'

const identity = (v) => v
const keyString = (value) => String(value ?? '')
// 稳定目录 id（c_ + 12 hex）和同名/截断条目在补全前分配的临时 id（c_tmp_ + 10 hex）都算身份键。
const CHAT_ID_KEY = /^c_(?:tmp_[0-9a-f]{10}|[0-9a-f]{12})$/

/** 目录 chatId 的形状。迁移必须先认形状再认标记，否则二次迁移会把 chatId 再哈希一遍。 */
export function isChatIdKey(value) {
  return CHAT_ID_KEY.test(keyString(value).trim())
}

/** 迁移用的键：已经是 chatId 的原样保留（幂等），否则走 keyOf。 */
const migrateKey = (name, keyOf) => {
  const raw = keyString(name).trim()
  if (isChatIdKey(raw)) return raw
  return keyString((keyOf ?? identity)(name)).trim()
}

/** mentions：`{ 名字: 时间戳 }` → `{ chatId: 时间戳 }`；撞键取最大时间戳。 */
export function migrateMentions(raw, keyOf = identity) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, value] of Object.entries(raw)) {
    const at = Number(value)
    if (!Number.isFinite(at)) continue
    const key = migrateKey(name, keyOf)
    if (!key) continue
    out[key] = Math.max(out[key] ?? at, at)
  }
  return out
}

/** proactive：`{ day, used: { 名字: 条数 } }` → 同样的 used 以 chatId 记账；撞键取较大计数。 */
export function migrateProactive(raw, keyOf = identity) {
  const out = { used: {} }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (typeof raw.day === 'string' && raw.day) out.day = raw.day
  const used = raw.used && typeof raw.used === 'object' && !Array.isArray(raw.used) ? raw.used : {}
  for (const [name, value] of Object.entries(used)) {
    const count = Number(value)
    if (!Number.isFinite(count)) continue
    const key = migrateKey(name, keyOf)
    if (!key) continue
    out.used[key] = Math.max(out.used[key] ?? 0, count)
  }
  return out
}

/** recent：`[{ chat, at }]` → `[{ chatId, chat, at }]`；按 key 去重取最大 at，保留展示名。 */
export function migrateRecent(raw, keyOf = identity) {
  const byKey = new Map()
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = String(item?.chat ?? '').trim()
    const at = Number(item?.at)
    if (!name || !Number.isFinite(at)) continue
    const key = migrateKey(name, keyOf)
    if (!key) continue
    const chat = String(sanitizeName(name)).trim()
    if (!chat) continue
    const prior = byKey.get(key)
    if (!prior || at > prior.at) byKey.set(key, { chatId: key, chat, at })
  }
  return [...byKey.values()]
}
