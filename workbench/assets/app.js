// 工作台外壳：八项导航、页面切换、统一的 30s/60s 轮询。
//
// 页面模块各自只管渲染；轮询只在页面可见时跑，切走即停。
// 通道页的 3 秒轮询由 channels.js 自己按「当前是不是通道页」判断。
import { $, fish, local, clock } from './lib.js'
import { initChannels, refreshChannels } from './channels.js'
import { overview } from './pages/overview.js'
import { bili } from './pages/bili.js'
import { memory } from './pages/memory.js'
import { env } from './pages/env.js'
import { tools } from './pages/tools.js'
import { data } from './pages/data.js'
import { principles } from './pages/principles.js'

const channels = {
  id: 'channels',
  label: '通道',
  enter() {
    if (!channels.ready) {
      initChannels({ isActive: () => current === 'channels' })
      channels.ready = true
      return
    }
    refreshChannels()
  },
  leave() {},
}

const PAGES = [overview, bili, memory, env, channels, tools, data, principles]
const byId = new Map(PAGES.map((p) => [p.id, p]))
let current = ''

function show(id) {
  const page = byId.get(id) || overview
  if (current === page.id) return
  byId.get(current)?.leave?.()
  current = page.id
  document.body.dataset.page = current
  for (const main of document.querySelectorAll('main[data-page]')) main.hidden = main.dataset.page !== current
  for (const btn of document.querySelectorAll('.tabs button')) {
    btn.classList.toggle('on', btn.dataset.page === current)
    btn.setAttribute('aria-selected', btn.dataset.page === current ? 'true' : 'false')
  }
  if (location.hash !== '#' + current) history.replaceState(null, '', '#' + current)
  page.enter(document.querySelector(`main[data-page="${current}"]`))
}

// ---- 外壳轮询：/status 30 秒、/notify 60 秒，只在页面可见时跑 ----
function setStrip(status, her) {
  const strip = $('#fish-strip')
  if (!strip) return
  const bits = []
  if (status) bits.push(`她：${status.label || status.phase || '—'}`)
  if (her) bits.push(`8710 ${her.running ? '在跑' : '没在跑'}`)
  strip.textContent = bits.join(' · ')
  strip.title = status?.detail || ''
}

async function shellStatus() {
  if (document.hidden) return
  const [st, her] = await Promise.all([fish('status'), local('/api/status')])
  const detail = {
    status: st.ok ? st.data : null,
    error: st.ok ? '' : st.error,
    her: her.ok ? (her.data?.her ?? null) : null,
  }
  setStrip(detail.status, detail.her)
  window.dispatchEvent(new CustomEvent('fish:status', { detail }))
}

async function shellNotify() {
  if (document.hidden) return
  const r = await fish('notify')
  window.dispatchEvent(new CustomEvent('fish:notify', { detail: r }))
}

document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => show(btn.dataset.page))
})
window.addEventListener('hashchange', () => show((location.hash || '#overview').slice(1)))

const initial = (location.hash || '#overview').slice(1)
show(byId.has(initial) ? initial : 'overview')

shellStatus()
shellNotify()
setInterval(shellStatus, 30_000)
setInterval(shellNotify, 60_000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) { shellStatus(); shellNotify() } })

// 页脚用同一个时钟，省得每个页面各写一份
const clockEl = $('#clock')
if (clockEl) setInterval(() => { clockEl.textContent = clock() }, 1000)
