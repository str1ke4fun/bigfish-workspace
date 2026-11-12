// /api/fish/* 的唯一白名单。没有通配转发，没有客户端指定 upstream。
//
// 表项形状：
//   path        相对 /api/fish/ 的路径，可含 /（如 log/export）
//   methods     { 方法: 从这里开始暴露的阶段 }；阶段未开的方法不对外
//   upstream    'fish' → /dsh-fish/*；'bili' → /dsh-bili/*（A2 拆包只改这一列）
//   target      上游路径与 BFF 路径不同名时用，例如 bili/status → /dsh-bili/status
//   pattern     只允许一个额外路径段，且必须命中的正则（cover / sheet / media）
//   maxBody     请求体上限，默认 256 KB
//   timeoutMs   上游超时，默认 30 秒
//   binary      二进制/下载响应，流式透传
//   sideEffect  GET 也可能触发上游副作用，需要同源校验
//
// 阶段：P0 只开 status；P1 开只读；P2 开写。A2 新增的 B 站路由按 A2 阶段登记，
// 但工作台在 P1 就能按“B 站页”把它们当只读用。

export const ROUTES = [
  // ---- 总览 / 记忆 / 环境 / 工具 / 数据 ----
  { path: 'status', methods: { GET: 'P0' }, upstream: 'fish' },
  { path: 'state', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'events', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'beliefs', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'memory', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'diary', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'reports', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'templates', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'notify', methods: { GET: 'P1', POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
  { path: 'inbox', methods: { GET: 'P1', POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024, sideEffect: true },
  { path: 'decide', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
  { path: 'home', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'say', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 12_000_000, timeoutMs: 120_000 },
  { path: 'wake', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024, timeoutMs: 180_000 },
  { path: 'away', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'owner', methods: { GET: 'P1', POST: 'P2', PUT: 'P2' }, upstream: 'fish', maxBody: 64 * 1024, timeoutMs: 120_000 },
  { path: 'config', methods: { GET: 'P1', POST: 'P2', PUT: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
  { path: 'tools', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'rules', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'selfcheck', methods: { GET: 'P1' }, upstream: 'fish', timeoutMs: 120_000, sideEffect: true },
  { path: 'log', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'log/export', methods: { GET: 'P1' }, upstream: 'fish', binary: true },
  { path: 'log/clear', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
  { path: 'backup', methods: { GET: 'P1' }, upstream: 'fish', binary: true, timeoutMs: 120_000 },
  { path: 'backup/restore', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 96_000_000, timeoutMs: 300_000 },
  { path: 'import', methods: { GET: 'P1', POST: 'P2' }, upstream: 'fish', maxBody: 256 * 1024, timeoutMs: 60_000 },
  { path: 'reset', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024, timeoutMs: 60_000 },
  { path: 'paths', methods: { GET: 'P1' }, upstream: 'fish', sideEffect: true },
  { path: 'update', methods: { GET: 'P1' }, upstream: 'fish', timeoutMs: 60_000, sideEffect: true },
  { path: 'avatar', methods: { GET: 'P1', POST: 'P2' }, upstream: 'fish', maxBody: 4_000_000 },
  { path: 'avatar/info', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'media', methods: { GET: 'P1' }, upstream: 'fish', pattern: /^principle-[a-z]+\.svg$/, binary: true },
  { path: 'wx/scan', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024, timeoutMs: 120_000 },

  // ---- B 站 ----
  { path: 'bili/status', methods: { GET: 'P1' }, upstream: 'bili', target: 'status' },
  { path: 'browse', methods: { GET: 'P1' }, upstream: 'bili' },
  { path: 'history', methods: { GET: 'P1' }, upstream: 'bili' },
  { path: 'footprint', methods: { GET: 'P1' }, upstream: 'bili' },
  { path: 'comment', methods: { GET: 'P1' }, upstream: 'bili', timeoutMs: 120_000, sideEffect: true },
  { path: 'comment-body', methods: { GET: 'P1' }, upstream: 'bili', timeoutMs: 120_000, sideEffect: true },
  { path: 'cover', methods: { GET: 'P1' }, upstream: 'bili', pattern: /^BV[0-9A-Za-z]{10}$/, binary: true, sideEffect: true },
  { path: 'risk', methods: { GET: 'P1', POST: 'P2' }, upstream: 'bili', maxBody: 64 * 1024, timeoutMs: 60_000 },
  { path: 'sheet', methods: { GET: 'P1' }, upstream: 'bili', pattern: /^BV[0-9A-Za-z]{10}$/, binary: true, timeoutMs: 120_000, sideEffect: true },
  { path: 'ledger', methods: { GET: 'P1' }, upstream: 'bili', timeoutMs: 60_000 },
  { path: 'outings', methods: { GET: 'P1' }, upstream: 'bili' },
]

export const DEFAULT_MAX_BODY = 256 * 1024
export const DEFAULT_TIMEOUT_MS = 30_000
export const UPSTREAM_PREFIX = { fish: '/dsh-fish', bili: '/dsh-bili' }

const BAD_SEGMENT = /[\/\\]|\.\.|%2e%2e|%2f|%5c/i

/** 路径段只允许 pattern 里的字符；拒绝编码斜杠、反斜杠和 .. */
export function segmentAllowed(segment, pattern) {
  if (typeof segment !== 'string' || segment === '') return false
  if (BAD_SEGMENT.test(segment)) return false
  if (!pattern.test(segment)) return false
  try {
    const decoded = decodeURIComponent(segment)
    if (decoded !== segment) return false
  } catch { return false }
  return true
}

/**
 * 在相对 /api/fish/ 的路径里找表项。
 * @param {string} rest 例如 "status"、"cover/BV1xx411c7mD"、"log/export"
 * @returns {{route: object, suffix: string}|null}
 */
export function matchRoute(rest) {
  if (typeof rest !== 'string' || rest === '') return null
  const parts = rest.split('/')
  for (const route of ROUTES) {
    const routeParts = route.path.split('/')
    if (parts.length < routeParts.length) continue
    let ok = true
    for (let i = 0; i < routeParts.length; i += 1) {
      if (parts[i] !== routeParts[i]) { ok = false; break }
    }
    if (!ok) continue
    const extra = parts.slice(routeParts.length)
    if (route.pattern) {
      if (extra.length !== 1 || !segmentAllowed(extra[0], route.pattern)) continue
      return { route, suffix: `/${extra[0]}` }
    }
    if (extra.length !== 0) continue
    return { route, suffix: '' }
  }
  return null
}

/** 该方法在当前阶段是否允许。 */
export function methodEnabled(route, method, phases) {
  const phase = route.methods?.[method]
  return Boolean(phase && phases.includes(phase))
}

/** 当前阶段下，这条路由允许的方法（用于 405 的 Allow 头）。 */
export function enabledMethods(route, phases) {
  return Object.keys(route.methods ?? {}).filter((m) => methodEnabled(route, m, phases))
}

export function upstreamPath(route, suffix, search = '') {
  const target = route.target ?? route.path
  return `${UPSTREAM_PREFIX[route.upstream]}${target.startsWith('/') ? '' : '/'}${target}${suffix}${search}`
}
