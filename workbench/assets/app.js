// 工作台外壳：主题、路由、一级 / 二级注册表、共享轮询。
// 业务页面只管自己的 DOM 和短周期刷新；外壳不包含任何页面逻辑。
import { $, el, fish, local, openHer } from './lib.js'
import { NAV, resolveRoute, shellBadge } from './nav.js'
import { routeHash } from './router.js'

const view = $('#view')
const navEl = $('#nav')
const subtabs = $('#subtabs')
const titleEl = $('#page-title')
const subEl = $('#page-sub')
const actions = $('#page-actions')
const themeBtn = $('#theme-toggle')
const herBtn = $('#open-her')
const shellMsg = $('#shell-msg')

const roots = new Map()
const navButtons = new Map()
const navStates = new Map()
const badges = { her: null, bili: null, channels: null, system: null }
let current = null
let currentNav = ''
let status = null
let statusAt = ''
let statusTimer = null

const LEVEL_WORD = { ok: '正常', warn: '注意', bad: '需要你' }

const ctx = {
  get status() { return status },
  get statusAt() { return statusAt },
  go(nav, slug) { show(routeHash(nav, slug)) },
  onStatus(fn) {
    const handler = (event) => fn(event.detail)
    window.addEventListener('workbench:status', handler)
    return () => window.removeEventListener('workbench:status', handler)
  },
  setBadge(navId, level) {
    badges[navId] = level
    paintBadges()
  },
  refreshStatus() { return pollStatus() },
  actions,
}

// ---------- 侧栏 ----------
function buildNav() {
  for (const group of NAV) {
    const dot = el('span', { class: 'nav-dot', 'aria-hidden': 'true' })
    const state = el('span', { class: 'nav-state' })
    const btn = el('button', {
      type: 'button',
      class: 'spine-item',
      onclick: () => show(routeHash(group.id, group.pages[0].slug)),
    }, dot, el('span', { class: 'nav-label', text: group.label }), state)
    navButtons.set(group.id, btn)
    navStates.set(group.id, state)
    navEl.append(btn)
  }
}

function paintNav() {
  for (const [id, btn] of navButtons) {
    const on = id === currentNav
    btn.classList.toggle('on', on)
    if (on) btn.setAttribute('aria-current', 'page')
    else btn.removeAttribute('aria-current')
  }
}

function paintBadges() {
  for (const group of NAV) {
    const btn = navButtons.get(group.id)
    if (!btn) continue
    const level = badges[group.id]
    const dot = btn.querySelector('.nav-dot')
    if (dot) dot.className = 'nav-dot' + (level ? ' ' + level : '')
    const word = navStates.get(group.id)
    if (word) word.textContent = level ? LEVEL_WORD[level] : ''
    btn.title = level ? `${group.label}：${LEVEL_WORD[level]}` : group.label
  }
}

function paintSubtabs(group, page) {
  subtabs.replaceChildren()
  for (const item of group.pages) {
    const on = item === page
    subtabs.append(el('button', {
      type: 'button',
      class: 'tab' + (on ? ' on' : ''),
      role: 'tab',
      'aria-selected': on ? 'true' : 'false',
      text: item.label,
      onclick: () => show(routeHash(group.id, item.slug)),
    }))
  }
}

const DAY = () => new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })

function paintTitle(group, page) {
  titleEl.textContent = `${group.label} · ${page.label}`
  paintSub()
}

function paintSub() {
  const bits = [DAY()]
  if (statusAt && Number.isFinite(new Date(statusAt).getTime())) {
    bits.push(`更新于 ${new Date(statusAt).toLocaleTimeString('zh-CN', { hour12: false })}`)
  }
  subEl.textContent = bits.join(' · ')
}

// ---------- 路由与挂载 ----------
function show(rawHash) {
  const route = resolveRoute(rawHash)
  const hash = routeHash(route.nav, route.page.slug)
  if (location.hash !== hash) history.replaceState(null, '', hash)

  if (current === route.page) return
  current?.leave?.()
  current = route.page
  currentNav = route.nav
  document.body.dataset.nav = currentNav
  document.body.dataset.page = current.id

  const host = current.host || current.id
  let root = roots.get(host)
  if (!root) {
    root = document.createElement('section')
    root.className = 'page'
    root.hidden = true
    view.append(root)
    roots.set(host, root)
  }
  for (const node of roots.values()) node.hidden = node !== root
  root.dataset.page = current.id
  actions.replaceChildren()

  const group = NAV.find((n) => n.id === currentNav)
  paintNav()
  paintSubtabs(group, current)
  paintTitle(group, current)
  scheduleStatus(currentNav === 'channels' ? 0 : undefined)

  try {
    const result = current.enter(root, ctx)
    if (result && typeof result.catch === 'function') result.catch((err) => showPageError(root, err))
  } catch (err) {
    showPageError(root, err)
  }
}

function showPageError(root, err) {
  root.append(el('div', { class: 'notice bad', text: `页面没打开：${err?.message || err}` }))
}

// ---------- 共享状态轮询 ----------
async function pollStatus() {
  const [st, localStatus] = await Promise.all([fish('status'), local('/api/status')])
  status = localStatus.ok ? localStatus.data : null
  statusAt = status?.at || ''
  const detail = {
    status: st.ok ? st.data : null,
    error: st.ok ? '' : st.error,
    her: status?.her ?? null,
  }
  // 旧页面仍监听 fish:status / fish:notify；新页面走 ctx.onStatus。
  window.dispatchEvent(new CustomEvent('fish:status', { detail }))
  window.dispatchEvent(new CustomEvent('workbench:status', { detail: status }))
  badges.her = shellBadge('her', status)
  badges.channels = shellBadge('channels', status)
  paintBadges()
  paintSub()
  return status
}

function scheduleStatus(delay) {
  clearTimeout(statusTimer)
  const wait = delay ?? (currentNav === 'channels' ? 3000 : 30_000)
  statusTimer = setTimeout(async () => {
    if (!document.hidden) await pollStatus()
    scheduleStatus()
  }, wait)
}

async function pollNotify() {
  if (document.hidden) return
  const r = await fish('notify')
  window.dispatchEvent(new CustomEvent('fish:notify', { detail: r }))
}

// ---------- 主题与外壳动作 ----------
function paintTheme() {
  const night = document.documentElement.dataset.theme === 'night'
  themeBtn.textContent = night ? '日' : '夜'
  themeBtn.setAttribute('aria-pressed', night ? 'true' : 'false')
  themeBtn.title = night ? '切到日间' : '切到夜间'
}

themeBtn.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'night' ? 'day' : 'night'
  document.documentElement.dataset.theme = next
  try { localStorage.setItem('fish.theme', next) } catch { /* 无痕模式等，仍允许本次切换 */ }
  paintTheme()
})

herBtn.addEventListener('click', async () => {
  herBtn.disabled = true
  const r = await openHer()
  if (shellMsg) shellMsg.textContent = r.ok ? '' : `没打开：${r.error}`
  herBtn.disabled = false
})

// ---------- 启动 ----------
buildNav()
paintTheme()
if (!location.hash) history.replaceState(null, '', routeHash('her', 'today'))
show(location.hash)
pollStatus()
scheduleStatus()
pollNotify()
setInterval(pollNotify, 60_000)
window.addEventListener('hashchange', () => show(location.hash))
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  pollStatus()
  pollNotify()
})
