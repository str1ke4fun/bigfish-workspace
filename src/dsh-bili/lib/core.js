/**
 * core.js —— B 站插件与 `fishCore` 之间唯一的桥
 *
 * A2 的边界（设计 §3.1 / §7）：
 *   插件不 import `src/dsh-fish/lib/*`。事件流只经 `memory`，配置只经 `config`，
 *   主人身份只经 `owner`，防注入只经 `guard`，处境与会话只经 `prompt` / `sessions`。
 *
 * 这里把这些窄接口包成 B 站模块原来习惯的调用形状（readEvents / appendEvent /
 * loadConfig / readOwner…），让 4000 行业务代码只改 import，不改语义。
 *
 * 谁负责注入：`index.js` 在 apply 时 `setCore(ctx.get('fishCore'))`；加载顺序不保证，
 * 所以取用一律是**调用时**现取，不在模块顶层缓存。
 */

let current = null

/** 由 index.js 注入。允许传 null（插件先于 core 加载），之后可再设。 */
export function setCore(core) {
  current = core || null
}

export function getCore() {
  return current
}

function need(name) {
  const core = current
  if (!core) throw new Error(`fishCore 还没就绪（需要 ${name}）`)
  return core
}

/** 全量事件（含 meta）。B 站的去重与配额必须看到完整历史。 */
export async function readEvents() {
  const core = need('memory')
  if (typeof core.memory?.readAll === 'function') {
    return { events: await core.memory.readAll() }
  }
  // 兼容 A1 的 memory.read：上限 2000，只在旧核心上兜底。
  const events = await core.memory.read({ includeMeta: true, limit: 2000 })
  return { events }
}

/** 系统侧追加。失败抛错，调用方原有的 try/catch 语义不变。 */
export async function appendEvent(raw, ctx = {}) {
  const core = need('memory')
  const r = await core.memory.append(raw, ctx)
  if (!r?.ok) throw new Error(r?.why || 'APPEND_FAILED')
  return r.event
}

/** 主人身份 + 进程内凭据（只在需要发评论的调用点用）。 */
export async function readOwner() {
  const core = need('owner')
  const pub = (await core.owner.read()) ?? {}
  let cookie = ''
  try {
    cookie = String((await core.owner.credentials())?.cookie ?? '')
  } catch { /* 没登录就没有 cookie，交给调用方按未登录处理 */ }
  return { ...pub, cookie }
}

export async function mentionPrefix() {
  try {
    return String((await need('owner').owner.mentionPrefix?.()) ?? '')
  } catch {
    return ''
  }
}

/** 完整配置。返回形状保持旧 `loadConfig(root)` 的 `{ config }`。 */
export async function loadConfig() {
  const core = need('config')
  return { config: await core.config.get() }
}

/** 派生自述。走 memory.derive，插件不自己解析事件流。 */
export async function deriveSelf(opts = {}) {
  return need('memory').memory.derive(opts)
}

export async function refreshSelfDoc() {
  try {
    return await need('self').self.refresh()
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
}

/** 防注入 / 出口清洗：与 core 同一份实现。 */
export function sanitizeForeign(...args) {
  return need('guard').guard.sanitizeForeign(...args)
}

export function screenOutgoing(...args) {
  return need('guard').guard.screenOutgoing(...args)
}

/** 处境段与会话投递。参数顺序与 fishCore.prompt 一致。 */
export function promptService() {
  return need('prompt').prompt
}

export function sessionsService() {
  return need('sessions').sessions
}

/** 「这一轮是定时/出门唤醒」标记。 */
export function withWake(fn) {
  const prompt = promptService()
  return typeof prompt.withWake === 'function' ? prompt.withWake(fn) : fn()
}
