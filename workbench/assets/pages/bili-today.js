// B 站 · 今天：她今天在外面做什么。读为主，写只有四件：
// 人工叫醒去看 B 站、翻转刷站 / 评论开关、解冻风控、关掉登录提示。
// `/comment` 会真的去 B 站扫回复：只在进入页面或点“刷新评论”时调，
// 写操作后的回读传 comment:false，不把一次点击变成外部流量。
import {
  el, clear, card, fish, postFish, fmtTime, clock, fillStats,
  errorText, writeError, hint, emptyState,
} from '../lib.js'

const SPEC = {}

function build(root) {
  SPEC.stats = card('今天')
  SPEC.statsBody = el('dl', { class: 'fish-stats' })
  SPEC.stats.body.append(SPEC.statsBody)

  // ---- 待回复 ----
  SPEC.waiting = card('待回复', { note: '只给读正文和人工叫醒；不替她回复。' })
  SPEC.waitingBody = el('div')
  SPEC.waiting.body.append(SPEC.waitingBody)

  // ---- 今天看了什么 ----
  SPEC.seen = card('今天看了什么', { note: '封面按需从本地取；抽帧点开单条才加载。' })
  SPEC.seenBody = el('div')
  SPEC.seen.body.append(
    SPEC.seenBody,
    el('div', { class: 'row' },
      el('a', { class: 'btn small', href: '#bili/footprint', text: '在足迹里按天看 →' }),
    ),
  )

  // ---- 出门 ----
  SPEC.outing = card('出门')
  SPEC.outingBody = el('dl', { class: 'fish-stats' })
  SPEC.outingMsg = el('span', { class: 'meta' })
  SPEC.outing.body.append(
    SPEC.outingBody,
    el('div', { class: 'row' },
      el('button', { type: 'button', text: '人工让她去看 B 站', onclick: () => wakeBrowse() }),
      SPEC.outingMsg,
    ),
  )

  // ---- 开关与登录 ----
  SPEC.switches = card('开关与登录', { note: '只翻转刷站 / 评论两个开关；配额与策略在系统 · 设置。' })
  SPEC.browseToggle = el('input', { type: 'checkbox', onchange: () => saveSwitch('browse', SPEC.browseToggle.checked) })
  SPEC.commentToggle = el('input', { type: 'checkbox', onchange: () => saveSwitch('comment', SPEC.commentToggle.checked) })
  SPEC.switchMsg = el('span', { class: 'meta' })
  SPEC.loginBody = el('div')
  SPEC.switches.body.append(
    el('div', { class: 'row' },
      el('label', { class: 'chk' }, SPEC.browseToggle, el('span', { text: '刷站' })),
      el('label', { class: 'chk' }, SPEC.commentToggle, el('span', { text: '评论' })),
      SPEC.switchMsg,
    ),
    SPEC.loginBody,
  )

  // ---- 风控 ----
  SPEC.risk = card('风控')
  SPEC.riskBody = el('div')
  SPEC.riskMsg = el('span', { class: 'meta' })
  SPEC.clearBtn = el('button', {
    class: 'small danger',
    type: 'button',
    text: '解冻（二次确认）',
    onclick: () => clearRisk(),
  })
  SPEC.clearBtn.hidden = true
  SPEC.risk.body.append(SPEC.riskBody, el('div', { class: 'row' }, SPEC.clearBtn, SPEC.riskMsg))

  root.append(SPEC.stats.root, SPEC.waiting.root, SPEC.seen.root, SPEC.outing.root,
    SPEC.switches.root, SPEC.risk.root)
}

function mountActions(ctx) {
  ctx.actions.append(
    el('button', { class: 'primary', type: 'button', text: '刷新评论', onclick: () => refresh() }),
    SPEC.msg = el('span', { class: 'meta' }),
  )
}

// ---------- 渲染 ----------

function renderStats(status, comment, outings, config) {
  clear(SPEC.statsBody)
  if (!status.ok) {
    SPEC.stats.setMeta(errorText(status), 'bad')
    SPEC.statsBody.append(el('div', { class: 'bad', text: errorText(status) }))
    return
  }
  const s = status.data || {}
  SPEC.stats.setMeta(s.installed ? `v${s.version || '?'}` : '插件没在跑', s.installed ? 'ok' : 'bad')
  const cfg = config.ok ? (config.data?.config || {}) : {}
  const browseQuota = cfg.browse?.perDay ?? '—'
  const outingQuota = outings.ok ? (outings.data?.quota ?? '—') : '—'
  const waiting = comment.ok && comment.data ? (comment.data.waitingCount ?? (comment.data.waiting || []).length) : '—'
  fillStats(SPEC.statsBody, [
    ['今天刷站', `${s.browsedToday ?? 0}/${browseQuota}`],
    ['今天出门', `${s.outingsToday ?? 0}/${outingQuota}`],
    ['待回复', waiting],
    ['风控', s.cooling ? '冷却中' : '正常'],
  ])
}

function waitingRow(row) {
  const body = el('div', {
    class: 'quote',
    text: row.text || '（这条没有存正文，可现取）',
  })
  const read = el('button', {
    class: 'small',
    type: 'button',
    text: '读正文',
    onclick: async () => {
      read.disabled = true
      body.textContent = '现取中…'
      const r = await fish('comment-body?bvid=' + encodeURIComponent(row.bvid) + '&rpid=' + encodeURIComponent(row.rpid))
      if (!r.ok) { body.textContent = errorText(r); body.className = 'quote bad'; read.disabled = false; return }
      const d = r.data || {}
      body.textContent = d.text || d.message || '这条读不到正文'
      body.className = 'quote'
    },
  })
  return el('li', {},
    el('div', { class: 'meta', text: `${row.title || row.bvid}${row.user ? ' · ' + row.user : ''} · ${fmtTime(row.at)}` }),
    body,
    el('div', { class: 'row' }, read),
  )
}

function renderWaiting(r) {
  clear(SPEC.waitingBody)
  if (!r.ok) { SPEC.waitingBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const c = r.data || {}
  const rows = c.waiting || []
  SPEC.waiting.setMeta(`今天说了 ${c.usedToday ?? 0} 条 · 回回复 ${c.replyUsedToday ?? 0} 条`, c.enabled ? 'ok' : 'warn')
  SPEC.waitingBody.append(el('h3', { text: `待回复（${c.waitingCount ?? rows.length}）` }))
  if (!rows.length) {
    SPEC.waitingBody.append(emptyState(c.enabled ? '现在没人回她。' : '评论区开关关着，不会去看。'))
    return
  }
  SPEC.waitingBody.append(el('ul', { class: 'plain' }, ...rows.map(waitingRow)))
}

function coverImg(bvid, alt) {
  const img = el('img', { class: 'cover', src: `/api/fish/cover/${encodeURIComponent(bvid)}`, alt: alt || '', loading: 'lazy' })
  img.addEventListener('error', () => { img.hidden = true })
  return img
}

function videoRow(v) {
  const frame = el('div', { class: 'sheet-inline', hidden: '' })
  const frameMsg = el('div', { class: 'meta' })
  const frameBtn = el('button', {
    class: 'small',
    type: 'button',
    text: '抽帧',
    onclick: () => loadSheet(v.bvid, frame, frameMsg),
  })
  return el('li', { class: 'video' },
    coverImg(v.bvid, v.title),
    el('div', { class: 'vbody' },
      el('a', { href: v.url || `https://www.bilibili.com/video/${v.bvid}`, target: '_blank', rel: 'noreferrer', text: v.title || v.bvid }),
      el('div', { class: 'meta', text: `${v.up || '—'} · ${v.at ? fmtTime(v.at) : '—'}` }),
      frameBtn,
      frame,
      frameMsg,
    ),
  )
}

function renderSeen(r) {
  clear(SPEC.seenBody)
  if (!r.ok) { SPEC.seenBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const groups = r.data?.groups || []
  const items = groups.flatMap((g) => (g.items || []).map((v) => ({ ...v, at: v.at || g.date })))
  if (!items.length) { SPEC.seenBody.append(emptyState('她还没看过什么')); return }
  SPEC.seenBody.append(el('ul', { class: 'videos' }, ...items.slice(-8).reverse().map(videoRow)))
}

async function loadSheet(bvid, frame, msg) {
  frame.hidden = false
  clear(frame)
  msg.textContent = `正在取 ${bvid} 的抽帧…`
  const img = el('img', { class: 'sheet', alt: `${bvid} 的抽帧`, src: `/api/fish/sheet/${encodeURIComponent(bvid)}` })
  img.addEventListener('load', () => { msg.textContent = '' })
  img.addEventListener('error', () => {
    img.remove()
    msg.textContent = '这集没有可用的抽帧（可能视频关掉了或抽帧失败）。'
  })
  frame.append(img)
}

function renderOuting(r) {
  clear(SPEC.outingBody)
  if (!r.ok) { SPEC.outing.setMeta(errorText(r), 'bad'); SPEC.outingBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const o = r.data || {}
  SPEC.outing.setMeta(o.enabled ? '刷站开着' : '刷站关着', o.enabled ? 'ok' : 'warn')
  const rows = [
    ['今天次数', `${o.usedToday ?? 0} / ${o.quota ?? '—'}`],
    ['最近出门', o.lastAt ? fmtTime(o.lastAt) : '—'],
    ['会话 id', o.sessionId ? String(o.sessionId).slice(0, 8) + '…' : '还没建'],
  ]
  for (const [k, v] of rows) SPEC.outingBody.append(el('div', {}, el('dt', { text: k }), el('dd', { text: String(v) })))
}

function renderSwitches(status, owner, config) {
  const s = status.ok ? (status.data || {}) : {}
  SPEC.browseToggle.checked = s.browseEnabled === true
  SPEC.commentToggle.checked = s.commentEnabled === true
  const cfg = config.ok ? (config.data?.config || {}) : {}

  clear(SPEC.loginBody)
  if (!owner.ok) { SPEC.loginBody.append(el('div', { class: 'bad', text: errorText(owner) })); return }
  const o = owner.data || {}
  SPEC.loginBody.append(
    el('div', { class: 'meta', text: o.hasCookie ? `cookie 已存${o.hasCsrf ? '' : '（没有 csrf，可能不能发言）'}` : 'cookie 还没存' }),
    el('div', { class: 'meta', text: `要 @ 的人：${o.name || '—'}${o.mid ? '（mid ' + o.mid + '）' : ''} · 登录账号：${o.account?.name || '还没认出来'}` }),
  )
  const row = el('div', { class: 'row' },
    el('button', { class: 'small', type: 'button', text: '测试', onclick: () => testOwner() }),
  )
  if (!o.hasCookie && cfg.ui?.ownerHintDismissed !== true) {
    SPEC.loginBody.append(
      el('div', { class: 'notice', text: 'B 站登录还没存。存了之后她才能看需要登录的内容、发评论。' }),
      el('div', { class: 'row' },
        el('a', { class: 'btn small', href: '#bili/manage', text: '去管理存登录' }),
        el('button', { class: 'small', type: 'button', text: '不再提示', onclick: () => dismissHint() }),
      ),
    )
  }
  SPEC.loginBody.append(row)
}

function renderRisk(r) {
  clear(SPEC.riskBody)
  if (!r.ok) { SPEC.risk.setMeta(errorText(r), 'bad'); SPEC.riskBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const x = r.data || {}
  SPEC.risk.setMeta(x.cooling ? '冷却中' : '正常', x.cooling ? 'warn' : 'ok')
  SPEC.riskBody.append(
    el('div', { text: x.cooling ? `风控冷却到 ${x.until ? fmtTime(x.until) : '—'}` : '没在冷却。' }),
    el('div', { class: 'meta', text: `撞过的次数：${x.strikes ?? 0}${x.code ? ' · 最近一次 ' + x.code : ''}` }),
  )
  // 只有真的在冷却时才给解冻入口。
  SPEC.clearBtn.hidden = !x.cooling
}

// ---------- 读取 ----------

async function refresh({ comment = true } = {}) {
  if (SPEC.msg) SPEC.msg.textContent = '读取中…'
  // /comment 会真的去 B 站扫回复：只在进入页面和点“刷新评论”时调。
  const commentReq = comment ? fish('comment') : Promise.resolve({ ok: true, data: null, skipped: true })
  const [owner, status, history, commentRes, outings, risk, config] = await Promise.all([
    fish('owner'), fish('bili/status'), fish('history?days=14'), commentReq,
    fish('outings'), fish('risk'), fish('config'),
  ])
  renderStats(status, commentRes, outings, config)
  if (!commentRes.skipped) renderWaiting(commentRes)
  renderSeen(history)
  renderOuting(outings)
  renderSwitches(status, owner, config)
  renderRisk(risk)
  // 侧栏点：插件没在跑算坏，冷却算注意，其余正常。
  SPEC.ctx.setBadge('bili', !status.ok ? 'bad' : (risk.ok && risk.data?.cooling ? 'warn' : 'ok'))
  if (SPEC.msg) SPEC.msg.textContent = `更新于 ${clock()}`
}

// ---------- 动作 ----------

async function wakeBrowse() {
  SPEC.outingMsg.textContent = '叫醒中…'
  try {
    const r = await postFish('wake?focus=browse', {})
    if (!r.ok) {
      // 409 的 body 同时带 error 与 why（「今天已经叫过三次了」这类）。
      SPEC.outingMsg.textContent = r.data?.error || r.data?.why || writeError(r)
      return
    }
    const d = r.data || {}
    if (d.ok) await refresh({ comment: false })
    SPEC.outingMsg.textContent = d.ok ? '叫醒了，这一轮她会去看 B 站首页。' : `没叫：${d.why || d.error || '这次没叫醒'}`
  } catch (err) {
    SPEC.outingMsg.textContent = `没成：${err?.message || err}`
  }
}

async function saveSwitch(group, value) {
  SPEC.switchMsg.textContent = '保存中…'
  // 只发开关这一项；deepMerge 会保留同组的其它策略。
  const patch = group === 'browse'
    ? { browse: { enabled: value } }
    : { comment: { enabled: value } }
  const r = await postFish('config', patch)
  if (!r.ok || r.data?.ok === false) {
    SPEC.switchMsg.textContent = !r.ok ? writeError(r) : `没存上：${r.data?.error || '上游拒绝'}`
    // 失败回读当前值，别让开关停在没生效的状态。
    await refresh({ comment: false })
    return
  }
  SPEC.switchMsg.textContent = '已保存。'
}

async function testOwner() {
  SPEC.switchMsg.textContent = '联网验证中…'
  try {
    const r = await postFish('owner', { test: true })
    if (!r.ok) { SPEC.switchMsg.textContent = r.data?.note || writeError(r); return }
    const d = r.data || {}
    SPEC.switchMsg.textContent = d.note || (d.ok ? '可以说话。' : '还不行。')
  } catch (err) {
    SPEC.switchMsg.textContent = `没成：${err?.message || err}`
  }
}

async function dismissHint() {
  SPEC.switchMsg.textContent = '保存中…'
  const r = await postFish('config', { ui: { ownerHintDismissed: true } })
  if (!r.ok || r.data?.ok === false) { SPEC.switchMsg.textContent = writeError(r); return }
  await refresh({ comment: false })
  SPEC.switchMsg.textContent = '不再提示了。'
}

async function clearRisk() {
  if (!confirm('确认解冻？现在就会允许她继续碰 B 站。')) return
  SPEC.riskMsg.textContent = '解冻中…'
  const r = await postFish('risk', { clear: true })
  if (!r.ok) { SPEC.riskMsg.textContent = r.data?.error || writeError(r); return }
  const d = r.data || {}
  await refresh({ comment: false })
  SPEC.riskMsg.textContent = d.cleared ? '已解冻。' : '解冻请求发出去了。'
}

// ---------- 页面契约 ----------

export const biliToday = {
  id: 'bili-today',
  nav: 'bili',
  slug: 'today',
  label: '今天',
  order: 10,

  enter(root, ctx) {
    SPEC.ctx = ctx
    if (!SPEC.built) { build(root); SPEC.built = true }
    mountActions(ctx)
    refresh({ comment: true })
  },

  leave() {},
}
