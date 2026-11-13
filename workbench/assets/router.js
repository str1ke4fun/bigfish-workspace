// 纯 hash 映射：旧地址兼容一个版本，未知地址回落「她 · 今天」。
// 这里只判断形状，不判断页面是否存在；页面校验归 nav.js。

export const LEGACY_HASH = {
  overview: 'her/today',
  memory: 'her/memory',
  bili: 'bili/today',
  env: 'system/settings',
  channels: 'channels/overview',
  tools: 'system/tools',
  data: 'system/data',
  principles: 'system/principles',
}

export const DEFAULT_ROUTE = 'her/today'

const ROUTE = /^[a-z]+\/[a-z0-9-]+$/

export function normalizeRoute(rawHash) {
  const raw = String(rawHash || '').replace(/^#/, '')
  const route = LEGACY_HASH[raw] || raw
  return ROUTE.test(route) ? route : DEFAULT_ROUTE
}

export function routeHash(nav, slug) {
  return `#${nav}/${slug}`
}

export function splitRoute(normalized) {
  const route = String(normalized || DEFAULT_ROUTE)
  const at = route.indexOf('/')
  return { nav: route.slice(0, at), slug: route.slice(at + 1) }
}
