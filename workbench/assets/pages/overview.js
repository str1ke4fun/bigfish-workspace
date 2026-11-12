// 总览：状态条、今天的时间线、判断、通知、屋子、你不在的时候、动作日志。
// 全部只读；写操作（叫她、让她说一句、通知去重）在 P2。
import { $, el, clear, card, fish, local, fmtTime, clock, fillStats, errorText, hint } from '../lib.js'

const TYPE_LABEL = {
  utterance: '她说的',
  revise: '认知重构',
  refusal: '她拒绝了',
  reunion: '重聚',
  narration: '她对自己说',
  saw: '看到',
  meta: '行动',
}

const state = {}

function build(root) {
  state.status = card('她现在')
  state.status.body.append(
    el('div', { class: 'status-detail', id: 'ov-detail', text: '正在读…' }),
    el('dl', { class: 'fish-stats', id: 'ov-stats' }),
  )
  state.status.root.querySelector('h2').after(el('div', { class: 'meta card-note', text: '状态、今天做了什么、出门与风控，全部由插件现算。' }))

  state.timeline = card('今天的时间线', { note: '/events?limit=40，只做数量筛选，不提供全文检索。' })
  state.timeline.body.append(el('ul', { class: 'timeline', id: 'ov-timeline' }))

  state.beliefs = card('她现在的判断', { note: '判断是会长出来的，不是进度条。' })
  state.beliefs.body.append(el('ul', { class: 'plain', id: 'ov-beliefs' }))

  state.notify = card('通知', { note: '弹出是页面的事；这里只回答「该不该提醒、提醒什么」。' })
  state.notify.body.append(el('div', { class: 'plain', id: 'ov-notify' }))

  state.inbox = card('信箱', { note: '她特意留给你的话。' })
  state.inbox.body.append(el('div', { class: 'plain', id: 'ov-inbox' }))

  state.home = card('屋子')
  state.home.body.append(el('div', { class: 'plain', id: 'ov-home' }))

  state.away = card('你不在的时候', { note: '不推送，只在你回来时告诉你错过了什么。' })
  state.away.body.append(el('div', { class: 'plain', id: 'ov-away' }))

  const logCard = card('动作日志', { note: '工作台这一侧做过的事（最近 20 条）。' })
  logCard.body.append(el('ul', { class: 'plain', id: 'ov-actions' }))
  state.log = logCard

  root.append(state.status.root, state.timeline.root, state.beliefs.root, state.notify.root,
    state.inbox.root, state.home.root, state.away.root, logCard.root)
}

function renderStatus(s) {
  if (!s) { state.status.setMeta('没读到', 'bad'); return }
  state.status.setMeta(`${s.label || s.phase || '—'}${s.detail ? ' · ' + s.detail : ''}`, s.awake ? 'ok' : 'warn')
  const bili = state.bili
  const her = state.her
  const st = state.self
  const today = s.today || {}
  fillStats($('#ov-stats'), [
    ['今天醒来', today.wakes ?? '—'],
    ['发呆', today.idleWakes ?? '—'],
    ['浏览', today.browsed ?? '—'],
    ['说话', today.said ?? '—'],
    ['评论', today.comments ?? '—'],
    ['日记', today.dairies ?? '—'],
    ['第几天', st ? `${st.day ?? '—'} / ${st.growthDays ?? '—'}` : '—'],
    ['阶段', st ? (st.stageName || st.stage || '—') : '—'],
    ['出门', bili ? `${bili.outingsToday ?? 0} 次` : '—'],
    ['风控', bili ? (bili.cooling ? '冷却中' : '正常') : '—'],
    ['8710', her ? (her.running ? '在跑' : '没在跑') : '—'],
    ['出门会话', bili?.sessionId ? String(bili.sessionId).slice(0, 8) + '…' : '还没建'],
  ])
  $('#ov-detail').textContent = s.nextWakeAt ? `下次醒来约 ${fmtTime(s.nextWakeAt)}` : (s.detail || '')
}

function renderTimeline(r) {
  const box = $('#ov-timeline')
  clear(box)
  if (!r.ok) { box.append(el('li', { class: 'bad', text: errorText(r) })); return }
  const rows = r.data?.rows || []
  if (!rows.length) { box.append(el('li', { class: 'meta', text: '还没有事件' })); return }
  for (const e of rows) {
    box.append(el('li', {},
      el('span', { class: 't', text: fmtTime(e.ts) }),
      el('span', { class: 'kind k-' + String(e.type || 'meta'), text: TYPE_LABEL[e.type] || e.type || '—' }),
      el('span', { class: 'x', text: String(e.text || '') }),
    ))
  }
}

function renderBeliefs(r) {
  const box = $('#ov-beliefs')
  clear(box)
  if (!r.ok) { box.append(el('li', { class: 'bad', text: errorText(r) })); return }
  const active = r.data?.active || []
  if (!active.length) { box.append(el('li', { class: 'meta', text: '还没有长出来的判断' })); return }
  for (const b of active.slice(-8).reverse()) {
    box.append(el('li', {}, el('span', { class: 'x', text: b.text }), el('span', { class: 't', text: fmtTime(b.since) })))
  }
}

function renderNotify(r) {
  const box = $('#ov-notify')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const n = r.data || {}
  box.append(
    el('div', { text: n.enabled ? (n.due ? '现在有一条该提醒的：' : '开着，今天没有要提醒的。') : '通知关着。' }),
    n.text ? el('div', { class: 'quote', text: n.text }) : null,
    el('div', { class: 'meta', text: `上次提醒：${n.lastShown || '还没有'}${n.why ? ' · ' + n.why : ''}` }),
  )
}

function renderInbox(r) {
  const box = $('#ov-inbox')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const rows = r.data?.rows || []
  const unread = Number(r.data?.unread ?? 0)
  box.append(el('div', { class: 'meta', text: `共 ${r.data?.total ?? rows.length} 封，未读 ${unread} 封。` }))
  if (!rows.length) { box.append(el('div', { class: 'meta', text: '还没有。这是起点，不是故障。' })); return }
  for (const m of rows.slice(-6).reverse()) {
    box.append(el('div', { class: 'letter' + (m.unread ? ' unread' : '') },
      el('div', { class: 'meta', text: `${fmtTime(m.ts)}${m.unread ? ' · 未读' : ''}` }),
      el('div', { class: 'quote', text: String(m.text || '') }),
    ))
  }
}

function renderHome(r) {
  const box = $('#ov-home')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const h = r.data || {}
  const ws = h.workspace || {}
  const ses = h.session || {}
  box.append(
    el('div', { text: `工作区：${ws.title || (ws.ok ? ws.id : '还没建')}` }),
    el('div', { class: 'meta', text: `会话：${ses.id ? String(ses.id).slice(0, 12) + '…' : '还没建'} · 身份文档 ${h.selfDoc?.exists ? `${h.selfDoc.bytes} 字节` : '还没有'}` }),
  )
}

function renderAway(r) {
  const box = $('#ov-away')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const a = r.data || {}
  if (a.quiet || !a.days) { box.append(el('div', { text: '这段时间没什么可说的。' })); return }
  box.append(el('div', {
    text: `你不在的 ${a.days} 天里：醒了 ${a.wakes} 次 · 看了 ${a.videos} 条视频 · 说了 ${a.said} 句 · 写了 ${a.diaries} 篇日记。`,
  }))
}

function renderActions(r) {
  const box = $('#ov-actions')
  clear(box)
  if (!r.ok) { box.append(el('li', { class: 'bad', text: '读不到动作日志' })); return }
  const rows = r.data?.rows || []
  if (!rows.length) { box.append(el('li', { class: 'meta', text: '还没有动作' })); return }
  for (const row of rows) {
    box.append(el('li', { class: row.ok ? '' : 'bad' },
      el('span', { class: 't', text: row.at }), el('b', { text: row.who }), ' ', el('span', { class: 'x', text: row.text }),
    ))
  }
}

async function refresh({ inbox: readInbox = true } = {}) {
  // GET /inbox 会重写一次信箱文件；只在进入页面时读，60 秒的自动刷新不碰它。
  const inboxReq = readInbox ? fish('inbox') : Promise.resolve({ ok: true, data: null, skipped: true })
  const [status, self, bili, tools, her, events, beliefs, inbox, home, away, actions] = await Promise.all([
    fish('status'), fish('state'), fish('bili/status'), fish('tools'), local('/api/status'),
    fish('events?limit=40'), fish('beliefs'), inboxReq, fish('home'), fish('away'), local('/api/status.log'),
  ])
  state.self = self.ok ? self.data : null
  state.bili = bili.ok ? bili.data : null
  state.her = her.ok ? (her.data?.her ?? null) : null
  renderStatus(status.ok ? status.data : null)
  if (!status.ok) state.status.setMeta(errorText(status), 'bad')
  state.status.setStatus(`更新于 ${clock()}`)
  if (tools.ok) state.status.root.title = `工具 ${tools.data?.known?.length ?? '?'} 个`
  renderTimeline(events)
  renderBeliefs(beliefs)
  if (!inbox.skipped) renderInbox(inbox)
  renderHome(home)
  renderAway(away)
  renderActions(actions)
}

function onShellStatus(e) {
  if (!state.built) return
  const detail = e.detail || {}
  state.her = detail.her ?? state.her
  renderStatus(detail.status || null)
  if (detail.status) state.status.setStatus(`更新于 ${clock()}`)
}

function onShellNotify(e) {
  if (!state.built) return
  renderNotify(e.detail || { ok: false, error: '读不到' })
}

let timer = null

export const overview = {
  id: 'overview',
  label: '总览',
  enter(root) {
    if (!state.built) { build(root); state.built = true }
    window.addEventListener('fish:status', onShellStatus)
    window.addEventListener('fish:notify', onShellNotify)
    refresh()
    clearInterval(timer)
    // 外壳管 /status 与 /notify；这里只按 60 秒刷新时间线/判断/信箱这些更重的读。
    timer = setInterval(() => { if (!document.hidden) refresh({ inbox: false }) }, 60_000)
  },
  leave() {
    clearInterval(timer)
    timer = null
    window.removeEventListener('fish:status', onShellStatus)
    window.removeEventListener('fish:notify', onShellNotify)
  },
}
