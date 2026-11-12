// B 站页：足迹、评论、待回复、登录、风控、出门、证据。全部只读。
//
// `/comment` 只在进入页面或点「刷新」时调一次，不自动轮询——
// 它会真的去 B 站看有没有人回她。抽帧（/sheet）只在点开单条视频时加载。
import { $, el, clear, card, fish, fmtTime, clock, fillStats, errorText, hint, asText } from '../lib.js'

const state = { owner: null, status: null, risk: null, outings: null, history: null, footprint: null, comment: null, ledger: null }

function build(root) {
  state.ownerCard = card('登录', { note: '只读展示；保存 cookie 与验证在 P2。' })
  state.ownerCard.body.append(el('div', { class: 'plain', id: 'bili-owner' }))

  state.statusCard = card('浏览统计')
  state.statusCard.body.append(el('dl', { class: 'fish-stats', id: 'bili-stats' }))

  state.historyCard = card('视频足迹', { note: '最近在看什么（/history），封面按需从本地取，没有就不显示。' })
  state.historyCard.body.append(el('div', { id: 'bili-history' }))

  state.commentCard = card('评论足迹与待回复', { note: '进入页面或点刷新时才问 B 站；正文按需现取。' })
  state.commentCard.body.append(el('div', { class: 'plain', id: 'bili-mine' }), el('div', { id: 'bili-waiting' }))

  state.outingCard = card('出门', { note: '只读；不提供「替她发评论」。' })
  state.outingCard.body.append(el('dl', { class: 'fish-stats', id: 'bili-outing' }))

  state.riskCard = card('风控')
  state.riskCard.body.append(el('div', { class: 'plain', id: 'bili-risk' }))

  const evidence = card('证据', { note: '抽帧只在点开单条视频时加载；台账只读。' })
  evidence.body.append(
    el('div', { class: 'meta', text: '待回复正文在上一张卡片里；抽帧入口在视频足迹的每一条旁边。' }),
    el('div', { class: 'sheet-box' }, el('img', { id: 'bili-sheet', alt: '', hidden: '' })),
    el('div', { class: 'meta', id: 'bili-sheet-msg' }),
    el('h3', { text: '工具调用台账' }),
    el('div', { class: 'meta', text: '今天（或选一个日期）她调用过哪些工具。只读，不提供编辑。' }),
    el('div', { class: 'row' },
      el('input', { type: 'date', id: 'bili-ledger-date' }),
      el('input', { type: 'text', id: 'bili-ledger-tool', placeholder: '工具名（可空）' }),
      el('button', { id: 'bili-ledger-load', text: '读台账' }),
    ),
    el('div', { id: 'bili-ledger' }),
  )
  state.evidenceCard = evidence

  const refreshBtn = el('button', { class: 'primary', text: '刷新', onclick: () => refresh() })
  const bar = el('div', { class: 'row page-bar' }, refreshBtn, el('span', { class: 'meta', id: 'bili-msg' }))
  root.append(bar, state.ownerCard.root, state.statusCard.root, state.historyCard.root,
    state.commentCard.root, state.outingCard.root, state.riskCard.root, evidence.root)

  $('#bili-ledger-load').addEventListener('click', () => loadLedger())
}

function coverImg(bvid, alt) {
  const img = el('img', { class: 'cover', src: `/api/fish/cover/${encodeURIComponent(bvid)}`, alt: alt || '', loading: 'lazy' })
  img.addEventListener('error', () => { img.hidden = true })
  return img
}

function renderOwner(r) {
  const box = $('#bili-owner')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const o = r.data || {}
  state.owner = o
  box.append(
    el('div', { text: o.hasCookie ? `cookie：已存${o.hasCsrf ? '（带 csrf）' : '（没有 csrf，可能不能发言）'}` : 'cookie：还没存' }),
    el('div', { class: 'meta', text: `要 @ 的人：${o.name || '—'}${o.mid ? '（mid ' + o.mid + '）' : ''} · 登录账号：${o.account?.name || '还没认出来'}` }),
    el('div', { class: 'meta', text: `评论时 @ 领养人：${o.atOwner === false ? '关' : '开'}` }),
  )
}

function renderStatus(r) {
  const stats = $('#bili-stats')
  clear(stats)
  if (!r.ok) { state.statusCard.setMeta(errorText(r), 'bad'); return }
  const s = r.data || {}
  state.status = s
  state.statusCard.setMeta(s.installed ? `v${s.version || '?'}` : '插件没在跑', s.installed ? 'ok' : 'bad')
  const c = state.comment
  fillStats(stats, [
    ['今天刷站', s.browsedToday ?? '—'],
    ['今天出门', s.outingsToday ?? '—'],
    ['待回复', c ? (c.waitingCount ?? (c.waiting || []).length) : '—'],
    ['刷站开关', s.browseEnabled ? '开' : '关'],
    ['评论开关', s.commentEnabled ? '开' : '关'],
    ['风控', s.cooling ? '冷却中' : '正常'],
    ['最近出门', s.lastOutingAt ? fmtTime(s.lastOutingAt) : '—'],
    ['出门会话', s.sessionId ? String(s.sessionId).slice(0, 8) + '…' : '还没建'],
  ])
}

function videoRow(v, date = '') {
  const link = el('a', { href: v.url || `https://www.bilibili.com/video/${v.bvid}`, target: '_blank', rel: 'noreferrer', text: v.title || v.bvid })
  const sheetBtn = el('button', { class: 'small', text: '抽帧', onclick: () => loadSheet(v.bvid) })
  const when = v.at ? fmtTime(v.at) : (date || '—')
  return el('li', { class: 'video' },
    coverImg(v.bvid, v.title),
    el('div', { class: 'vbody' },
      link,
      el('div', { class: 'meta', text: `${v.up || '—'} · ${when}${v.duration ? ' · ' + Math.round(v.duration / 60) + ' 分钟' : ''}${v.view ? ' · ' + v.view + ' 播放' : ''}` }),
    ),
    sheetBtn,
  )
}

function renderHistory(r) {
  const box = $('#bili-history')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const groups = r.data?.groups || []
  if (!groups.length) { box.append(hint('还没看过什么。', 'meta')); return }
  for (const g of groups) {
    const ul = el('ul', { class: 'videos' }, ...(g.items || []).map((v) => videoRow(v, g.date)))
    box.append(el('details', { open: '' }, el('summary', { text: `${g.date} · ${(g.items || []).length} 条` }), ul))
  }
}

function commentRow(row, { waiting = false } = {}) {
  const label = row.kind === 'reply' ? '回复' : '评论'
  const who = waiting ? (row.user || '') : ''
  const body = el('div', { class: 'quote', text: row.text || (waiting ? row.text || '' : '（这条没有存正文，可现取）') })
  const actions = el('div', { class: 'row' })
  if (waiting || !row.text) {
    actions.append(el('button', {
      class: 'small', text: '读正文',
      onclick: async () => {
        const r = await fish(`comment-body?bvid=${encodeURIComponent(row.bvid)}&rpid=${encodeURIComponent(row.rpid)}`)
        if (!r.ok) { body.textContent = errorText(r); body.className = 'quote bad'; return }
        const d = r.data || {}
        body.textContent = d.text || d.message || asText(d)
        body.className = 'quote'
      },
    }))
  }
  return el('li', {},
    el('div', { class: 'meta', text: `${label} · ${fmtTime(row.at)}${who ? ' · ' + who : ''} · ${row.bvid}` }),
    body,
    actions,
  )
}

function renderComment(r) {
  const mine = $('#bili-mine')
  const waiting = $('#bili-waiting')
  clear(mine); clear(waiting)
  if (!r.ok) { mine.append(hint(errorText(r), 'bad')); return }
  const c = r.data || {}
  state.comment = c
  state.commentCard.setMeta(`今天说了 ${c.usedToday ?? 0} 条 · 回回复 ${c.replyUsedToday ?? 0} 条`, c.enabled ? 'ok' : 'warn')
  const rows = c.mine || []
  mine.append(el('div', { class: 'meta', text: rows.length ? `今天在 B 站说的（${rows.length}）` : '今天还没在 B 站说话。' }))
  if (rows.length) mine.append(el('ul', { class: 'plain' }, ...rows.slice(-6).reverse().map((x) => commentRow(x))))
  const list = c.waiting || []
  waiting.append(el('h3', { text: `待回复（${c.waitingCount ?? list.length}）` }))
  if (!list.length) { waiting.append(hint(c.enabled ? '现在没人回她。' : '评论区开关关着，不会去看。', 'meta')); return }
  waiting.append(el('ul', { class: 'plain' }, ...list.map((x) => commentRow(x, { waiting: true }))))
}

function renderOutings(r) {
  const stats = $('#bili-outing')
  clear(stats)
  if (!r.ok) { state.outingCard.setMeta(errorText(r), 'bad'); return }
  const o = r.data || {}
  state.outings = o
  state.outingCard.setMeta(o.enabled ? '刷站开着' : '刷站关着', o.enabled ? 'ok' : 'warn')
  fillStats(stats, [
    ['今天次数', `${o.usedToday ?? 0} / ${o.quota ?? '—'}`],
    ['最近出门', o.lastAt ? fmtTime(o.lastAt) : '—'],
    ['会话标题', o.sessionTitle || '—'],
    ['会话 id', o.sessionId ? String(o.sessionId).slice(0, 8) + '…' : '还没建'],
    ['回扫间隔', o.scanEveryMin ? `${o.scanEveryMin} 分钟` : '—'],
  ])
}

function renderRisk(r) {
  const box = $('#bili-risk')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const x = r.data || {}
  state.risk = x
  state.riskCard.setMeta(x.cooling ? '冷却中' : '正常', x.cooling ? 'warn' : 'ok')
  box.append(
    el('div', { text: x.cooling ? `风控冷却到 ${x.until ? fmtTime(x.until) : '—'}` : '没在冷却。' }),
    el('div', { class: 'meta', text: `撞过的次数：${x.strikes ?? 0}${x.code ? ' · 最近一次 ' + x.code : ''} · 解冻（POST /risk）在 P2。` }),
  )
}

function renderFootprint(r) {
  // 评论足迹（/footprint.comments）和待回复分开摆，避免重复。
  const cardBox = state.evidenceCard.body
  const old = $('#bili-footprint')
  if (old) old.remove()
  if (!r.ok) {
    cardBox.prepend(el('div', { id: 'bili-footprint' }, hint(errorText(r), 'bad')))
    return
  }
  const f = r.data || {}
  const rows = f.comments?.rows || []
  const list = el('ul', { class: 'plain' },
    ...(rows.length ? rows.slice(0, 20).map((row) => commentRow(row)) : [el('li', { class: 'meta', text: '这段时间没有评论足迹。' })]))
  cardBox.prepend(el('div', { id: 'bili-footprint' },
    el('h3', { text: `评论足迹（${f.comments?.total ?? rows.length}）` }), list,
    el('div', { class: 'meta', text: `视频足迹共 ${f.viewed?.total ?? 0} 条（按天在上一张卡片里）。` }),
  ))
}

async function loadSheet(bvid) {
  const img = $('#bili-sheet')
  const msg = $('#bili-sheet-msg')
  msg.textContent = `正在取 ${bvid} 的抽帧…`
  img.hidden = true
  img.onload = () => { img.hidden = false; msg.textContent = `${bvid} 的抽帧` }
  img.onerror = () => { img.hidden = true; msg.textContent = `这集没有可用的抽帧（${bvid}），可能视频关掉了或抽帧失败。` }
  img.src = `/api/fish/sheet/${encodeURIComponent(bvid)}`
}

async function loadLedger() {
  const box = $('#bili-ledger')
  clear(box)
  box.append(hint('读取中…', 'meta'))
  const date = $('#bili-ledger-date').value
  const tool = $('#bili-ledger-tool').value.trim()
  const qs = new URLSearchParams()
  if (date) qs.set('date', date)
  if (tool) qs.set('tool', tool)
  const r = await fish('ledger?' + qs.toString())
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  if (r.data?.ok === false) {
    const code = r.data.code || 'LEDGER_READ_FAILED'
    if (code === 'NO_LEDGER') {
      box.append(hint('台账服务没挂上（dsh-fish 版本太老或没启用）。', 'meta'))
    } else {
      box.append(hint(`台账读失败：${r.data.why || code}（不是「没有记录」）`, 'bad'))
    }
    return
  }
  const rows = r.data?.rows || []
  if (!rows.length) { box.append(hint('这天没有调用记录。', 'meta')); return }
  box.append(el('div', { class: 'meta', text: `共 ${rows.length} 条` }))
  for (const row of rows.slice().reverse()) {
    const at = row.at || row.ts || row.time || ''
    box.append(el('details', {},
      el('summary', { text: `${fmtTime(at)} · ${row.tool || row.name || '—'}${row.ok === false ? ' · 失败' : ''}` }),
      el('pre', { class: 'meta fish-raw', text: asText(row) }),
    ))
  }
}

async function refresh() {
  $('#bili-msg').textContent = '读取中…'
  const [owner, status, history, footprint, comment, outings, risk] = await Promise.all([
    fish('owner'), fish('bili/status'), fish('history?days=14'), fish('footprint?days=30'),
    fish('comment'), fish('outings'), fish('risk'),
  ])
  renderOwner(owner)
  renderComment(comment)
  renderStatus(status)
  renderHistory(history)
  renderFootprint(footprint)
  renderOutings(outings)
  renderRisk(risk)
  $('#bili-msg').textContent = `更新于 ${clock()}`
}

export const bili = {
  id: 'bili',
  label: 'B 站',
  enter(root) {
    if (!state.built) { build(root); state.built = true; $('#bili-ledger-date').value = '' }
    refresh()
  },
  leave() {},
}
