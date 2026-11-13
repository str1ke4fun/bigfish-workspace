// 她 · 今天：巡检首屏。先回答“她现在怎么样”，再给今天的时间线、
// 她留下的话、B 站与通道的世界摘要，最后是叫醒 / 说一句 / 信箱这些单次动作。
// 读为主；写只有四件：叫醒、说一句、标信箱已读、裁决她提的申请。
import {
  el, clear, card, fish, postFish, local, fmtTime, clock, fillStats,
  errorText, writeError, humanChip, emptyState, openHer,
} from '../lib.js'

const TYPE_LABEL = {
  utterance: '她说的',
  revise: '认知重构',
  refusal: '她拒绝了',
  reunion: '重聚',
  narration: '她对自己说',
  saw: '看到',
  meta: '行动',
}

const SPEC = {}

function build(root, ctx) {
  // 待裁决条：她提了申请才出现，平时不占版面。
  SPEC.pending = el('div', { class: 'pending-bar' })
  SPEC.pending.hidden = true

  SPEC.hero = card('她今天')
  SPEC.heroState = el('div', { class: 'hero-state' })
  SPEC.heroState.append(el('span', { class: 'dot' }), el('b', { text: '正在读…' }))
  SPEC.heroMeta = el('div', { class: 'meta' })
  SPEC.heroStats = el('dl', { class: 'fish-stats' })
  SPEC.heroMsg = el('span', { class: 'meta' })
  SPEC.retry = el('button', {
    class: 'small',
    type: 'button',
    text: '重试',
    onclick: () => refresh({ inbox: false }),
  })
  SPEC.retry.hidden = true
  SPEC.homeLine = el('div', { class: 'meta' })
  SPEC.hero.body.append(
    SPEC.heroState,
    SPEC.heroMeta,
    SPEC.heroStats,
    el('div', { class: 'row' },
      el('button', { class: 'primary', type: 'button', text: '叫醒她', onclick: () => wakeHer() }),
      el('button', { type: 'button', text: '跟她说一句', onclick: () => focusTalk() }),
      el('button', { type: 'button', text: '打开她的界面', onclick: () => openHerHere() }),
      SPEC.retry,
      SPEC.heroMsg,
    ),
    SPEC.homeLine,
  )

  SPEC.timeline = card('今天的时间线', { note: '最近 40 条，只做数量筛选。' })
  SPEC.timelineList = el('ul', { class: 'timeline' })
  SPEC.timeline.body.append(
    SPEC.timelineList,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '在记忆里看全部 →', onclick: () => ctx.go('her', 'memory') }),
    ),
  )

  SPEC.words = card('她留下的话', { note: '她这阵子自己想说的，和已经长出来的判断。' })
  SPEC.wordsBody = el('div')
  SPEC.beliefsBody = el('div')
  SPEC.words.body.append(
    SPEC.wordsBody,
    el('h3', { text: '她现在的判断' }),
    SPEC.beliefsBody,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '读日记', onclick: () => ctx.go('her', 'memory') }),
      el('button', { class: 'small', type: 'button', text: '看信箱', onclick: () => SPEC.inbox.root.scrollIntoView({ block: 'nearest' }) }),
    ),
  )

  SPEC.bili = card('B 站')
  SPEC.biliBody = el('div')
  SPEC.bili.body.append(
    SPEC.biliBody,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '去 B 站 →', onclick: () => ctx.go('bili', 'today') }),
    ),
  )

  SPEC.channels = card('通道')
  SPEC.channelsBody = el('div')
  SPEC.channels.body.append(
    SPEC.channelsBody,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '去通道 →', onclick: () => ctx.go('channels', 'overview') }),
    ),
  )

  SPEC.away = card('你不在的时候', { note: '不推送，只在你回来时告诉你错过了什么。' })
  SPEC.awayBody = el('div')
  SPEC.away.body.append(SPEC.awayBody)

  SPEC.actions = card('最近动作', { note: '工作台这一侧做过的事（最近 20 条）。' })
  SPEC.actionsList = el('ul', { class: 'plain' })
  SPEC.actions.body.append(SPEC.actionsList)

  SPEC.talk = card('跟她说一句', { note: '这句话会进到她那里；只做单次动作，不保留历史。图片上限 12MB。' })
  SPEC.talkInput = el('textarea', { class: 'doc', rows: '3', placeholder: '你想对她说什么…' })
  SPEC.talkFile = el('input', { type: 'file', accept: 'image/*' })
  SPEC.talkMsg = el('span', { class: 'meta' })
  SPEC.talkSaid = el('div')
  SPEC.talk.body.append(
    SPEC.talkInput,
    el('div', { class: 'row' },
      SPEC.talkFile,
      el('button', { class: 'primary', type: 'button', text: '说给她', onclick: () => sayToHer() }),
      SPEC.talkMsg,
    ),
    SPEC.talkSaid,
  )

  SPEC.inbox = card('信箱', { note: '她特意留给你的话。' })
  SPEC.inboxBody = el('div')
  SPEC.inboxMsg = el('span', { class: 'meta' })
  SPEC.inbox.body.append(
    SPEC.inboxBody,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '标为已读', onclick: () => markInbox() }),
      SPEC.inboxMsg,
    ),
  )

  root.append(
    SPEC.pending, SPEC.hero.root, SPEC.timeline.root, SPEC.words.root, SPEC.bili.root,
    SPEC.channels.root, SPEC.away.root, SPEC.actions.root, SPEC.talk.root, SPEC.inbox.root,
  )
}

// ---------- 渲染 ----------

function renderStatus(r) {
  const s = r.ok ? r.data : null
  const dot = SPEC.heroState.querySelector('.dot')
  const word = SPEC.heroState.querySelector('b')
  if (!s) {
    word.textContent = errorText(r)
    dot.className = 'dot bad'
    SPEC.heroMeta.textContent = ''
    SPEC.retry.hidden = false
    SPEC.hero.setMeta('没读到', 'bad')
    return
  }
  SPEC.retry.hidden = true
  word.textContent = s.label || s.phase || '醒着'
  dot.className = 'dot ' + (s.awake ? 'ok' : 'warn')
  SPEC.hero.setMeta(s.detail || '', s.awake ? 'ok' : 'warn')

  const bits = []
  if (SPEC.self) bits.push(`第 ${SPEC.self.day ?? '—'} 天`)
  if (s.nextWakeAt) bits.push(`下次醒来约 ${fmtTime(s.nextWakeAt)}`)
  if (SPEC.toolCount != null) bits.push(`工具 ${SPEC.toolCount} 个`)
  SPEC.heroMeta.textContent = bits.join(' · ')

  const today = s.today || {}
  fillStats(SPEC.heroStats, [
    ['醒来', today.wakes ?? '—'],
    ['看了', today.browsed ?? '—'],
    ['说了', today.said ?? '—'],
    ['待回复', SPEC.unread ?? '—'],
  ])
  SPEC.hero.setStatus(`更新于 ${clock()}`)
}

function renderHome(r) {
  clear(SPEC.homeLine)
  if (!r.ok) { SPEC.homeLine.textContent = errorText(r); SPEC.homeLine.className = 'meta bad'; return }
  SPEC.homeLine.className = 'meta'
  const h = r.data || {}
  const ws = h.workspace || {}
  const ses = h.session || {}
  SPEC.homeLine.textContent = `工作区：${ws.title || (ws.ok ? ws.id : '还没建')} · 会话：${ses.id ? String(ses.id).slice(0, 12) + '…' : '还没建'}`
}

function renderPending(r) {
  clear(SPEC.pending)
  SPEC.pending.hidden = true
  if (!r.ok) return
  const p = r.data?.pending
  if (!p) return
  SPEC.pending.hidden = false
  SPEC.pending.append(el('div', { class: 'notice' },
    el('div', { text: `她提了一张申请：${p.rule || ''}${p.why ? ' · ' + p.why : ''}` }),
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '批准', onclick: () => decide('approve') }),
      el('button', { class: 'small', type: 'button', text: '驳回', onclick: () => decide('reject') }),
      el('span', { class: 'meta decide-msg' }),
    ),
  ))
}

function renderTimeline(r) {
  clear(SPEC.timelineList)
  if (!r.ok) {
    SPEC.timelineList.append(el('li', { class: 'bad', text: errorText(r) }))
    return
  }
  const rows = r.data?.rows || []
  if (!rows.length) {
    SPEC.timelineList.append(el('li', { class: 'meta', text: '还没有事件' }))
    return
  }
  for (const e of rows) {
    SPEC.timelineList.append(el('li', {},
      el('span', { class: 't', text: fmtTime(e.ts) }),
      el('span', { class: 'kind k-' + String(e.type || 'meta'), text: TYPE_LABEL[e.type] || e.type || '—' }),
      el('span', { class: 'x', text: String(e.text || '') }),
    ))
  }
}

function renderWords(r) {
  clear(SPEC.wordsBody)
  if (!r.ok) { SPEC.wordsBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  // /events 是新到旧；取第一条才是她最近留下的话。
  const rows = (r.data?.rows || []).filter((e) => e.type === 'utterance' || e.type === 'narration')
  const last = rows[0]
  if (!last) { SPEC.wordsBody.append(emptyState('还没有她留下的话。')); return }
  SPEC.wordsBody.append(
    el('div', { class: 'quote', text: String(last.text || '') }),
    el('div', { class: 'meta', text: fmtTime(last.ts) }),
  )
}

function renderBeliefs(r) {
  clear(SPEC.beliefsBody)
  if (!r.ok) { SPEC.beliefsBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const active = r.data?.active || []
  if (!active.length) { SPEC.beliefsBody.append(emptyState('还没有长出来的判断')); return }
  const list = el('ul', { class: 'plain' })
  // /beliefs 按显著性排（固化、常被提起的在前），取最强的前 6 条。
  for (const b of active.slice(0, 6)) {
    list.append(el('li', {}, el('span', { class: 'x', text: b.text }), el('span', { class: 't', text: fmtTime(b.since) })))
  }
  SPEC.beliefsBody.append(list)
}

function renderBili(r) {
  clear(SPEC.biliBody)
  if (!r.ok) { SPEC.biliBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const b = r.data || {}
  if (!b.installed) {
    SPEC.biliBody.append(emptyState('还没装 B 站插件。'))
    return
  }
  const lines = [
    `今天刷了 ${b.browsedToday ?? 0} 条 · 出门 ${b.outingsToday ?? 0} 次`,
    `风控${b.cooling ? `冷却中${b.riskUntil ? `（到 ${fmtTime(b.riskUntil)}）` : ''}` : '正常'}${b.lastOutingAt ? ` · 最近出门 ${fmtTime(b.lastOutingAt)}` : ''}`,
  ]
  for (const line of lines) SPEC.biliBody.append(el('div', { text: line }))
}

function qqLevel(q) {
  if (!q) return ''
  if (!q.running) return 'bad'
  return q.loggedIn ? 'ok' : 'warn'
}

function wxLevel(w) {
  if (!w) return ''
  if (!w.running) return 'bad'
  return w.windows > 0 ? 'ok' : 'warn'
}

function channelLine(level, text) {
  return el('div', {}, el('span', { class: 'dot' + (level ? ' ' + level : '') }), el('span', { text }))
}

function renderChannels(status) {
  clear(SPEC.channelsBody)
  if (!status) {
    SPEC.channelsBody.append(el('div', { class: 'meta', text: '工作台状态还没回来。' }))
    return
  }
  const q = status.qq || {}
  const w = status.wx || {}
  SPEC.channelsBody.append(
    channelLine(qqLevel(q), `QQ ${q.label || '—'}`),
    channelLine(wxLevel(w), `微信 ${w.label || '—'}`),
  )
}

function renderAway(r) {
  clear(SPEC.awayBody)
  if (!r.ok) { SPEC.awayBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const a = r.data || {}
  if (a.quiet || !a.days) { SPEC.awayBody.append(el('div', { class: 'meta', text: '这段时间没什么可说的。' })); return }
  SPEC.awayBody.append(el('div', {
    text: `你不在的 ${a.days} 天里：醒了 ${a.wakes} 次 · 看了 ${a.videos} 条视频 · 说了 ${a.said} 句 · 写了 ${a.diaries} 篇日记。`,
  }))
}

function renderActions(r) {
  clear(SPEC.actionsList)
  if (!r.ok) { SPEC.actionsList.append(el('li', { class: 'bad', text: '读不到动作日志' })); return }
  const rows = r.data?.rows || []
  if (!rows.length) { SPEC.actionsList.append(el('li', { class: 'meta', text: '还没有动作' })); return }
  for (const row of rows) {
    SPEC.actionsList.append(el('li', { class: row.ok ? '' : 'bad' },
      el('span', { class: 't', text: row.at }),
      el('b', { text: row.who }), ' ',
      // 人工代操作带 operator:'human'，单独标出来，别混进她的动作里。
      row.operator === 'human' ? humanChip() : null,
      el('span', { class: 'x', text: row.text }),
    ))
  }
}

function renderInbox(r) {
  if (!r || r.skipped) return
  clear(SPEC.inboxBody)
  if (!r.ok) { SPEC.inboxBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const rows = r.data?.rows || []
  const unread = Number(r.data?.unread ?? 0)
  SPEC.unread = unread
  SPEC.inboxBody.append(el('div', { class: 'meta', text: `共 ${r.data?.total ?? rows.length} 封，未读 ${unread} 封。` }))
  if (!rows.length) { SPEC.inboxBody.append(emptyState('还没有。这是起点，不是故障。')); return }
  // /inbox 已经是新到旧；取最近的 6 封，保持新在上。
  for (const m of rows.slice(0, 6)) {
    SPEC.inboxBody.append(el('div', { class: 'letter' + (m.unread ? ' unread' : '') },
      el('div', { class: 'meta', text: `${fmtTime(m.ts)}${m.unread ? ' · 未读' : ''}` }),
      el('div', { class: 'quote', text: String(m.text || '') }),
    ))
  }
}

// ---------- 读取 ----------

async function refresh({ inbox = false } = {}) {
  // GET /inbox 会重写一次信箱文件；只在进入页面时读，60 秒的自动刷新不碰它。
  const inboxReq = inbox ? fish('inbox') : Promise.resolve({ ok: true, data: null, skipped: true })
  const [status, self, bili, tools, events, beliefs, inboxRes, home, away, actions, rules] = await Promise.all([
    fish('status'), fish('state'), fish('bili/status'), fish('tools'), fish('events?limit=40'),
    fish('beliefs'), inboxReq, fish('home'), fish('away'), local('/api/status.log'), fish('rules'),
  ])

  SPEC.self = self.ok ? self.data : null
  SPEC.toolCount = tools.ok ? (tools.data?.known?.length ?? null) : null
  SPEC.ctx.setBadge('bili', !bili.ok ? 'bad' : (!bili.data?.installed ? 'bad' : bili.data.cooling ? 'warn' : 'ok'))

  // 先读信箱，hero 的“待回复”才有数（首屏不必等下一轮）。
  renderInbox(inboxRes)
  renderStatus(status)
  renderHome(home)
  renderPending(rules)
  renderTimeline(events)
  renderWords(events)
  renderBeliefs(beliefs)
  renderBili(bili)
  renderAway(away)
  renderActions(actions)
}

async function refreshRulings() {
  const [rules, beliefs] = await Promise.all([fish('rules'), fish('beliefs')])
  renderPending(rules)
  renderBeliefs(beliefs)
}

// ---------- 动作 ----------

function focusTalk() {
  SPEC.talkInput.focus()
  SPEC.talk.root.scrollIntoView({ block: 'nearest' })
}

function readImage(input) {
  return new Promise((resolve) => {
    const file = input?.files?.[0]
    if (!file) { resolve(null); return }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

async function sayToHer() {
  const text = SPEC.talkInput.value.trim()
  const image = await readImage(SPEC.talkFile)
  if (!text && !image) { SPEC.talkMsg.textContent = '写一句话，或者选一张图。'; return }
  SPEC.talkMsg.textContent = '递给她…'
  try {
    const body = { text }
    if (image) body.image = image
    const r = await postFish('say', body)
    if (!r.ok) { SPEC.talkMsg.textContent = writeError(r); return }
    const d = r.data || {}
    const said = d.said || []
    clear(SPEC.talkSaid)
    if (said.length) {
      SPEC.talkSaid.append(
        el('h3', { text: '她这一轮说的' }),
        el('div', { class: 'plain' }, ...said.map((line) => el('div', { class: 'quote', text: String(line) }))),
      )
    }
    SPEC.talkMsg.textContent = said.length ? '说完了。' : (d.note || '她这次没说话。')
    if (d.ok !== false) { SPEC.talkInput.value = ''; SPEC.talkFile.value = '' }
  } catch (err) {
    SPEC.talkMsg.textContent = `没成：${err?.message || err}`
  }
}

async function openHerHere() {
  const r = await openHer()
  SPEC.heroMsg.textContent = r.ok ? '' : `没打开：${r.error}`
}

async function wakeHer() {
  SPEC.heroMsg.textContent = '叫她…'
  try {
    const r = await postFish('wake', {})
    if (!r.ok) {
      // 409 时上游把原因放在 error/why 里，别只显示 HTTP 409。
      SPEC.heroMsg.textContent = r.data?.error || r.data?.why || errorText(r)
      return
    }
    const d = r.data || {}
    SPEC.heroMsg.textContent = d.ok ? '她醒了。' : `没叫醒：${d.why || d.error || '上游拒绝'}`
    if (d.ok) await refresh({ inbox: false })
  } catch (err) {
    SPEC.heroMsg.textContent = `没成：${err?.message || err}`
  }
}

async function markInbox() {
  const r = await postFish('inbox', {})
  if (!r.ok) { SPEC.inboxMsg.textContent = writeError(r); return }
  await refresh({ inbox: true })
  SPEC.inboxMsg.textContent = '标为已读了。'
}

async function decide(verdict) {
  const r = await postFish('decide', { verdict })
  const word = verdict === 'approve' ? '批准了。' : '驳回了。'
  if (!r.ok) {
    const msg = SPEC.pending.querySelector('.decide-msg')
    if (msg) msg.textContent = writeError(r)
    return
  }
  await refreshRulings()
  const msg = SPEC.pending.querySelector('.decide-msg')
  if (msg) msg.textContent = word
  else SPEC.heroMsg.textContent = word
}

// ---------- 页面契约 ----------

let timer = null
let offStatus = null

export const herToday = {
  id: 'her-today',
  nav: 'her',
  slug: 'today',
  label: '今天',
  order: 10,

  enter(root, ctx) {
    SPEC.ctx = ctx
    if (!SPEC.built) { build(root, ctx); SPEC.built = true }
    offStatus?.()
    offStatus = ctx.onStatus((status) => renderChannels(status))
    renderChannels(ctx.status)
    refresh({ inbox: true })
    clearInterval(timer)
    // 外壳每 30 秒已经刷过 /status 与 /api/status；这里只补更重的读。
    timer = setInterval(() => { if (!document.hidden) refresh({ inbox: false }) }, 60_000)
  },

  leave() {
    clearInterval(timer)
    timer = null
    offStatus?.()
    offStatus = null
  },
}
