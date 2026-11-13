// 一级 / 二级页面注册表。外壳只认这里的 page 契约。
// P0 的二级页全部是旧页面包装器；P1–P4 逐页替换，注册表形状不变。
import { normalizeRoute, splitRoute } from './router.js'
import { legacyChannels } from './legacy-channels.js'
import { herToday } from './pages/her-today.js'
import { herMemory } from './pages/her-memory.js'
import { herGrowth } from './pages/her-growth.js'
import { biliToday } from './pages/bili-today.js'
import { biliFootprint } from './pages/bili-footprint.js'
import { biliManage } from './pages/bili-manage.js'
import { systemSettings } from './pages/system-settings.js'
import { systemTools } from './pages/system-tools.js'
import { systemLogs } from './pages/system-logs.js'
import { systemData } from './pages/system-data.js'
import { systemPrinciples } from './pages/system-principles.js'

const legacyChannelPage = (slug, label, order) => ({
  id: `channels-${slug}`,
  nav: 'channels',
  slug,
  label,
  order,
  host: 'channels-legacy',
  enter(root) { legacyChannels.enter(root) },
  leave() { legacyChannels.leave() },
})

export const NAV = [
  { id: 'her', label: '她', pages: [herToday, herMemory, herGrowth] },
  { id: 'bili', label: 'B 站', pages: [biliToday, biliFootprint, biliManage] },
  { id: 'channels', label: '通道', pages: [legacyChannelPage('overview', '总览', 10), legacyChannelPage('qq', 'QQ', 20), legacyChannelPage('wx', '微信', 30)] },
  { id: 'system', label: '系统', pages: [systemSettings, systemTools, systemLogs, systemData, systemPrinciples] },
]

export const PAGES = NAV.flatMap((group) => group.pages)

const RANK = { ok: 1, warn: 2, bad: 3 }

function worst(levels) {
  const known = levels.filter(Boolean)
  if (!known.length) return null
  return known.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))
}

function channelLevel(ch) {
  if (!ch) return null
  if (!ch.running || ch.login?.phase === 'kicked') return 'bad'
  if (ch.loggedIn === false) return 'warn'
  if (ch.health?.tree?.status && ch.health.tree.status !== 'ok') return 'warn'
  return 'ok'
}

export function shellBadge(navId, status, extra = {}) {
  if (navId === 'system') return null
  if (navId === 'bili') return extra?.bili || null
  if (!status) return null
  if (navId === 'her') {
    return status.her?.running && String(status.her.http) === '200' ? 'ok' : 'bad'
  }
  if (navId === 'channels') {
    // P0 时服务端还没加 channels 映射，退回旧键，状态点不会空一版。
    const map = status.channels || status
    return worst([channelLevel(map.qq), channelLevel(map.wx)])
  }
  return null
}

export function resolveRoute(rawHash) {
  const route = normalizeRoute(rawHash)
  const { nav, slug } = splitRoute(route)
  const group = NAV.find((n) => n.id === nav)
  const page = group?.pages.find((p) => p.slug === slug)
  if (page) return { nav: group.id, slug, page }
  const fallback = NAV[0].pages.find((p) => p.slug === 'today')
  return { nav: 'her', slug: 'today', page: fallback }
}
