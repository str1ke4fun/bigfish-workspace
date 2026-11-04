/**
 * capture.js —— 后台轮转采集的纯判定：配置、服务号过滤、入队与暂停。
 *
 * 这里不读屏、不写台账、不碰真实时钟：now 由调用方注入，方便测试和回放。
 * 判定顺序按 spec 固定，调用方只需要拿结果做事。
 */

const str = (v) => String(v ?? '').trim()
const collapse = (v) => str(v).replace(/\s+/g, ' ')
const asciiLower = (v) => v.replace(/[A-Z]/g, (c) => c.toLowerCase())
const nameKey = (v) => asciiLower(collapse(v))

/** spec §7：服务号、系统会话。用户可在 policy.ignoreChats 覆盖。 */
export const DEFAULT_IGNORE_CHATS = [
  'Tencent News',
  'File Transfer',
  'Service Messages',
  'Weixin Team',
  '微信团队',
  '微信ClawBot',
  '微信支付',
  '服务通知',
]

const DEFAULTS = {
  preview: true,
  rotate: true,
  queueMax: 20,
  chatCooldownSec: 60,
  maxScrollPages: 3,
  quietMs: 10000,
  ocrEveryMs: 20000,
}

const LIMITS = {
  queueMax: [1, 100],
  chatCooldownSec: [0, 3600],
  maxScrollPages: [0, 10],
  quietMs: [0, 600000],
  ocrEveryMs: [0, 600000],
}

/**
 * policy → 采集配置。缺省值与 spec §12 一致；显式 ignoreChats 照用。
 * 布尔项只有显式 false 才关；数值越界 clamp，读不出数字时用缺省值。
 */
export function captureSettings(raw) {
  const policy = raw && typeof raw === 'object' ? raw : {}
  const capture = policy.capture && typeof policy.capture === 'object' ? policy.capture : {}
  const clamped = (key) => {
    const [min, max] = LIMITS[key]
    const value = capture[key]
    if (value === undefined || value === null) return DEFAULTS[key]
    const num = Number(value)
    if (!Number.isFinite(num)) return DEFAULTS[key]
    return Math.min(max, Math.max(min, num))
  }
  return {
    ignoreChats: Array.isArray(policy.ignoreChats)
      ? policy.ignoreChats.map(str).filter(Boolean)
      : [...DEFAULT_IGNORE_CHATS],
    preview: capture.preview !== false,
    rotate: capture.rotate !== false,
    queueMax: clamped('queueMax'),
    chatCooldownSec: clamped('chatCooldownSec'),
    maxScrollPages: clamped('maxScrollPages'),
    quietMs: clamped('quietMs'),
    ocrEveryMs: clamped('ocrEveryMs'),
  }
}

/** 服务号判定：trim + 压空格 + ASCII 小写后精确比较，避免前缀误伤正常群。 */
export function isIgnoredChat(name, ignoreChats = []) {
  const key = nameKey(name)
  if (!key) return false
  return (Array.isArray(ignoreChats) ? ignoreChats : []).some((n) => nameKey(n) === key)
}

/** 侧栏预览指纹：只用来判断有没有变化，不进入台账。 */
export function previewSig(row) {
  return `${Number(row?.unread) || 0}|${str(row?.time)}|${str(row?.preview)}`
}

/**
 * 是否把一个会话放进轮转队列。
 * 顺序：not-allowed → ignored → draft → 变化信号 → cooldown。
 * 先看有没有变化信号：冷却只决定「什么时候采」，不能把信号吞掉。
 * 有信号但还在冷却期时仍入队，dueAt 指向冷却结束；没有信号才是 unchanged。
 */
export function shouldEnqueue({
  row,
  sig = '',
  prevSig = '',
  capturedSinceStart = false,
  lastCaptureAt = 0,
  now = 0,
  cooldownMs = 0,
  allowChats = [],
  ignoreChats = [],
} = {}) {
  const name = str(row?.name)
  const allowed = (Array.isArray(allowChats) ? allowChats : []).some((n) => nameKey(n) === nameKey(name))
  if (!allowed) return { enqueue: false, reason: 'not-allowed' }
  if (isIgnoredChat(name, ignoreChats)) return { enqueue: false, reason: 'ignored' }
  if (row?.draft) return { enqueue: false, reason: 'draft' }

  let signal = ''
  if (!capturedSinceStart) signal = 'first'
  else if ((Number(row?.unread) || 0) > 0) signal = 'unread'
  else if (sig !== prevSig) signal = 'changed'
  if (!signal) return { enqueue: false, reason: 'unchanged' }

  const last = Number(lastCaptureAt) || 0
  const at = Number(now) || 0
  const cooldown = Number(cooldownMs) || 0
  if (last > 0 && at - last < cooldown) {
    return { enqueue: true, reason: 'cooldown', dueAt: last + cooldown }
  }
  return { enqueue: true, reason: signal }
}

/**
 * 暂停原因，空串表示可以轮转。
 * 顺序按 spec §4.3：policy-off → login → 树状态 → stale → host-busy →
 * host-active → sending → pending-hits → quiet。暂停只影响轮转。
 */
export function pauseReason({
  policy,
  hostBusy = false,
  hostActive = false,
  sending = false,
  pendingHits = 0,
  treeStatus = 'unknown',
  stale = false,
  login = false,
  quietUntil = 0,
  now = 0,
} = {}) {
  if (policy && (policy.enabled === false || policy.watch === false)) return 'policy-off'
  if (login) return 'login'
  if (treeStatus !== 'ok') return 'tree-' + (str(treeStatus) || 'unknown')
  if (stale) return 'stale'
  if (hostBusy) return 'host-busy'
  if (hostActive) return 'host-active'
  if (sending) return 'sending'
  if ((Number(pendingHits) || 0) > 0) return 'pending-hits'
  if ((Number(quietUntil) || 0) > (Number(now) || 0)) return 'quiet'
  return ''
}
