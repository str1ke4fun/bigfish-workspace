// B 站页：足迹、评论、待回复、登录、风控、出门、证据。读为主，P2 写登录/解冻/叫醒/界面偏好。
//
// `/comment` 只在进入页面或点「刷新」时调一次，不自动轮询——
// 它会真的去 B 站看有没有人回她。抽帧（/sheet）只在点开单条视频时加载。
import { $, el, clear, card, fish, postFish, fmtTime, clock, fillStats, errorText, writeError, hint, asText } from '../lib.js'

const state = { owner: null, status: null, risk: null, outings: null, history: null, footprint: null, comment: null, ledger: null }

function build(root) {
  state.ownerCard = card('登录', { note: 'cookie 只上行不下行：输入框永远空着，存过之后只显示「已保存」。' })
  state.ownerCard.body.append(
    el('div', { class: 'plain', id: 'bili-owner' }),
    el('div', { class: 'grid2' },
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '领养人 mid' }), el('input', { type: 'text', id: 'bili-owner-mid' })),
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '昵称（@ 用）' }), el('input', { type: 'text', id: 'bili-owner-name' })),
    ),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: 'cookie' }), el('input', { type: 'password', id: 'bili-owner-cookie', placeholder: '留空 = 不改' })),
    el('div', { class: 'meta', text: '「发评论时 @ 领养人」只在一个地方改：环境 → 评论组。这里不重复放开关。' }),
    el('div', { class: 'row' },
      el('button', { id: 'bili-owner-save', class: 'primary', text: '保存登录信息', onclick: () => saveOwner() }),
      el('button', { id: 'bili-owner-test', text: '测试这份 cookie', onclick: () => testOwner() }),
      el('span', { class: 'meta', id: 'bili-owner-msg' }),
    ),
  )

  state.statusCard = card('浏览统计')
  state.statusCard.body.append(el('dl', { class: 'fish-stats', id: 'bili-stats' }))

  state.historyCard = card('视频足迹', { note: '最近在看什么（/history），封面按需从本地取，没有就不显示。' })
  state.historyCard.body.append(el('div', { id: 'bili-history' }))

  state.commentCard = card('评论足迹与待回复', { note: '进入页面或点刷新时才问 B 站；正文按需现取。' })
  state.commentCard.body.append(el('div', { class: 'plain', id: 'bili-mine' }), el('div', { id: 'bili-waiting' }))

  state.outingCard = card('出门', { note: '不提供「替她发评论」；这里只有手动叫她去看 B 站。' })
  state.outingCard.body.append(
    el('dl', { class: 'fish-stats', id: 'bili-outing' }),
    el('div', { class: 'row' },
      el('button', { id: 'bili-wake-browse', text: '人工触发：让她去看 B 站', onclick: () => wakeBrowse() }),
      el('span', { class: 'meta', id: 'bili-wake-msg' }),
    ),
  )

  state.riskCard = card('风控')
  state.riskCard.body.append(el('div', { class: 'plain', id: 'bili-risk' }))

  const uiCard = card('界面偏好', { note: '只影响这一版界面怎么显示，与她的成长无关。' })
  uiCard.body.append(
    el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'bili-hint-dismissed' }), el('span', { text: '不再提示「B 站登录还没存」' })),
    el('div', { class: 'row' },
      el('button', { id: 'bili-ui-save', class: 'small', text: '保存界面偏好', onclick: () => saveUi() }),
      el('span', { class: 'meta', id: 'bili-ui-msg' }),
    ),
  )

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
    state.commentCard.root, state.outingCard.root, state.riskCard.root, uiCard.root, evidence.root)

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
  $('#bili-owner-mid').value = o.mid || ''
  $('#bili-owner-name').value = o.name || ''
  $('#bili-owner-cookie').value = ''
  box.append(
    el('div', { text: o.hasCookie ? `cookie：已存${o.hasCsrf ? '（带 csrf）' : '（没有 csrf，可能不能发言）'}` : 'cookie：还没存' }),
    el('div', { class: 'meta', text: `要 @ 的人：${o.name || '—'}${o.mid ? '（mid ' + o.mid + '）' : ''} · 登录账号：${o.account?.name || '还没认出来'}` }),
    el('div', { class: 'meta', text: `评论时 @ 领养人：${o.atOwner === false ? '关' : '开'}（在环境页评论组里改）` }),
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
    el('div', { class: 'meta', text: `撞过的次数：${x.strikes ?? 0}${x.code ? ' · 最近一次 ' + x.code : ''}` }),
    el('div', { class: 'row' },
      el('button', { class: 'small', text: '解冻（二次确认）', onclick: () => clearRisk() }),
      el('span', { class: 'meta', id: 'bili-risk-msg' }),
    ),
  )
}

async function saveOwner() {
  const msg = $('#bili-owner-msg')
  const btn = $('#bili-owner-save')
  // 只发用户真的填了的字段：GET /owner 失败或还没回读时，输入框是空的，
  // 无条件发空串会把已经存好的 mid/昵称清掉。
  const body = {}
  const mid = $('#bili-owner-mid').value.trim()
  const nickname = $('#bili-owner-name').value.trim()
  const cookie = $('#bili-owner-cookie').value.trim()
  if (mid) body.mid = mid
  if (nickname) body.nickname = nickname
  if (cookie) body.cookie = cookie
  if (!Object.keys(body).length) { msg.textContent = '没有要保存的内容。'; return }
  btn.disabled = true
  msg.textContent = '保存中…'
  try {
    const r = await postFish('owner', body)
    if (!r.ok) {
      // 上游 400 把原因放在 note 里（例如 cookie 里没认出 B 站的键），别吞掉。
      msg.textContent = r.data?.note || r.data?.error || writeError(r)
      return
    }
    const d = r.data || {}
    $('#bili-owner-cookie').value = ''
    await refresh({ comment: false })
    msg.textContent = d.note || (d.ok === false ? `没存上${d.note ? '：' + d.note : '。'}` : '存下了。')
  } finally { btn.disabled = false }
}

async function testOwner() {
  const msg = $('#bili-owner-msg')
  const btn = $('#bili-owner-test')
  btn.disabled = true
  msg.textContent = '联网验证中…'
  try {
    const r = await postFish('owner', { test: true })
    if (!r.ok) { msg.textContent = r.data?.note || writeError(r); return }
    const d = r.data || {}
    await refresh({ comment: false })
    msg.textContent = d.note || (d.ok ? '可以说话。' : '还不行。')
  } finally { btn.disabled = false }
}

async function wakeBrowse() {
  const msg = $('#bili-wake-msg')
  const btn = $('#bili-wake-browse')
  btn.disabled = true
  msg.textContent = '叫醒中…'
  try {
    const r = await postFish('wake?focus=browse', {})
    if (!r.ok) {
      // 409 的 body 同时带 error 与 why（「今天已经叫过三次了」这类）。
      msg.textContent = r.data?.error || r.data?.why || writeError(r)
      return
    }
    const d = r.data || {}
    if (d.ok) await refresh({ comment: false })
    msg.textContent = d.ok ? '叫醒了，这一轮她会去看 B 站首页。' : `没叫：${d.why || d.error || '这次没叫醒'}`
  } finally { btn.disabled = false }
}

async function clearRisk() {
  if (!confirm('确认解冻？现在就会允许她继续碰 B 站。')) return
  const r = await postFish('risk', { clear: true })
  if (!r.ok) { $('#bili-risk-msg').textContent = r.data?.error || writeError(r); return }
  const d = r.data || {}
  await refresh({ comment: false })
  // renderRisk 会重建这一段，消息要在刷新之后写到新节点上。
  const msg = $('#bili-risk-msg')
  if (msg) msg.textContent = d.cleared ? '已解冻。' : '解冻请求发出去了。'
}

async function saveUi() {
  const msg = $('#bili-ui-msg')
  const btn = $('#bili-ui-save')
  btn.disabled = true
  try {
    const r = await postFish('config', { ui: { ownerHintDismissed: $('#bili-hint-dismissed').checked } })
    if (!r.ok) { msg.textContent = writeError(r); return }
    if (r.data?.ok === false) { msg.textContent = `没存上：${r.data.error || '上游拒绝'}`; return }
    msg.textContent = '已保存。'
  } finally { btn.disabled = false }
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

async function refresh({ comment = true } = {}) {
  $('#bili-msg').textContent = '读取中…'
  // /comment 会真的去 B 站扫回复：只在进入页面和点「刷新」时调。
  // 写操作后的回读传 comment:false，不把调试点击变成外部流量。
  const commentReq = comment ? fish('comment') : Promise.resolve({ ok: true, data: null, skipped: true })
  const [owner, status, history, footprint, commentRes, outings, risk, config] = await Promise.all([
    fish('owner'), fish('bili/status'), fish('history?days=14'), fish('footprint?days=30'),
    commentReq, fish('outings'), fish('risk'), fish('config'),
  ])
  if (config.ok) $('#bili-hint-dismissed').checked = config.data?.config?.ui?.ownerHintDismissed === true
  renderOwner(owner)
  if (!commentRes.skipped) renderComment(commentRes)
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
