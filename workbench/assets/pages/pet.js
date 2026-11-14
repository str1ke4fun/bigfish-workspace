// 她 · 桌宠：在线状态、动作试演、尺寸与皮肤、陪伴会话。
// 页面只读 /pet/state（3 秒轮询）；写只有三件：演动作、改外观、换一条会话。
// 都经 BFF /api/fish/pet/* 转到 8710 插件，不调用模型，也不写事件流。
import {
  el, clear, card, fish, postFish, fmtTime, errorText, writeError, statusDot, hint,
} from '../lib.js'

const MOTIONS = [
  { id: 'waving', label: '挥手' },
  { id: 'thinking', label: '想一想' },
  { id: 'working', label: '干活' },
  { id: 'result', label: '结果' },
  { id: 'waiting', label: '等着' },
  { id: 'success', label: '成了' },
  { id: 'error', label: '出错' },
]

const ACTIVITY_LABEL = {
  thinking: '想一想',
  working: '干活',
  result: '结果',
  waiting: '等着',
  success: '成了',
  error: '出错',
}

const MODE_LABEL = { event: '事件', ambient: '氛围', work: '工作' }

// 与 observe.js /pet/config 的夹取区间（240–560）兼容。
const SIZES = [
  { id: 320, label: '小' },
  { id: 400, label: '中' },
  { id: 462, label: '大' },
]

const POLL_MS = 3000
const RECENT_LIMIT = 5

const SPEC = {}

function build(root, ctx) {
  SPEC.ctx = ctx
  SPEC.state = null
  SPEC.note = el('div', { class: 'meta' })

  // ---- 1. 状态 ----
  SPEC.statusCard = card('桌宠状态', {
    note: '在线只认桌宠窗口的心跳：超过 90 秒没报到就是离线。',
  })
  SPEC.statusLine = el('div', { class: 'hero-state' })
  SPEC.statusMeta = el('div', { class: 'meta' })
  SPEC.activity = el('div', { class: 'meta' })
  SPEC.action = el('div', { class: 'meta' })
  SPEC.presence = el('div', { class: 'meta' })
  SPEC.recent = el('ul', { class: 'timeline' })
  SPEC.recentCard = card('最近说的几句', { note: '最多 5 条；这些话不进事件流。' })
  SPEC.recentCard.body.append(SPEC.recent)
  SPEC.statusCard.body.append(
    SPEC.statusLine,
    SPEC.statusMeta,
    SPEC.activity,
    SPEC.action,
    SPEC.presence,
    SPEC.recentCard.root,
  )

  // ---- 2. 动作试演 ----
  SPEC.actionsCard = card('动作试演', {
    note: '点一下只是让桌宠演一遍，不调用模型，也不写事件流。',
  })
  SPEC.actionButtons = []
  SPEC.actions = el('div', { class: 'row' })
  for (const m of MOTIONS) {
    const btn = el('button', {
      class: 'small',
      type: 'button',
      text: m.label,
      onclick: (ev) => act(m.id, ev.currentTarget),
    })
    SPEC.actionButtons.push(btn)
    SPEC.actions.append(btn)
  }
  SPEC.actionsNote = el('div', { class: 'meta' })
  SPEC.actionsCard.body.append(SPEC.actions, SPEC.actionsNote)

  // ---- 3. 外观 ----
  SPEC.looksCard = card('外观', {
    note: '改完由运行中的桌宠自己来取；重复下发同一设置不会抖动窗口。',
  })
  SPEC.sizeButtons = new Map()
  SPEC.sizes = el('div', { class: 'row' })
  for (const s of SIZES) {
    const btn = el('button', {
      class: 'small',
      type: 'button',
      text: s.label,
      onclick: () => applyConfig({ size: s.id }),
    })
    SPEC.sizeButtons.set(s.id, btn)
    SPEC.sizes.append(btn)
  }
  SPEC.skin = el('select', { class: 'small' })
  SPEC.skin.addEventListener('change', () => applyConfig({ skin: SPEC.skin.value }))
  SPEC.skinSignature = ''
  SPEC.skinLabel = el('label', {}, el('span', { class: 'meta', text: '皮肤' }), SPEC.skin)
  SPEC.looksNote = el('div', { class: 'meta' })
  SPEC.looksCard.body.append(
    el('div', { class: 'field' }, el('span', { class: 'meta', text: '尺寸' }), SPEC.sizes),
    SPEC.skinLabel,
    SPEC.looksNote,
  )

  // ---- 4. 陪伴会话 ----
  SPEC.companionCard = card('陪伴会话', {
    note: '陪看评论和桌宠对话共用一个会话；到阈值或手动换一条就开新的。',
  })
  SPEC.companionLine = el('div', { class: 'meta' })
  SPEC.companionStats = el('dl', { class: 'fish-stats' })
  SPEC.rotate = el('button', {
    class: 'small',
    type: 'button',
    text: '换一条',
    onclick: () => rotate(),
  })
  SPEC.companionNote = el('div', { class: 'meta' })
  SPEC.companionCard.body.append(
    SPEC.companionLine,
    SPEC.companionStats,
    el('div', { class: 'row' }, SPEC.rotate, SPEC.companionNote),
    hint('换了会话，前面的评论和对话仍在原会话里，不会被删。'),
  )

  root.append(SPEC.statusCard.root, SPEC.actionsCard.root, SPEC.looksCard.root, SPEC.companionCard.root, SPEC.note)
}

function timeText(ms) {
  if (!ms) return '—'
  try { return fmtTime(new Date(Number(ms)).toISOString()) } catch { return '—' }
}

function render() {
  const s = SPEC.state
  if (!s) return
  const pet = s.pet || {}
  const online = Boolean(pet.online)
  clear(SPEC.statusLine)
  SPEC.statusLine.append(
    statusDot(online ? 'ok' : 'bad', online ? '在线' : '离线'),
    el('b', { text: online ? '桌宠在线' : '桌宠离线' }),
  )
  SPEC.statusMeta.textContent = `最后轮询：${timeText(pet.lastPollAt ?? s.at)} · 版本：${pet.version || '—'}`

  const activity = s.activity
  SPEC.activity.textContent = activity
    ? `活动：${ACTIVITY_LABEL[activity.state] || activity.state} · ${timeText(activity.at)}`
    : '活动：现在没有正在进行的活动'
  const action = s.action
  SPEC.action.textContent = action
    ? `动作：${MOTIONS.find((m) => m.id === action.motion)?.label || action.motion}${action.text ? ` · ${action.text}` : ''} · ${timeText(action.at)}`
    : '动作：没有正在演的动作'

  const presence = s.presence
  SPEC.presence.textContent = presence
    ? `屏幕陪伴：${presence.on ? '开' : '关'}${presence.on ? ` · ${MODE_LABEL[presence.mode] || presence.mode || '—'}` : ''}${presence.busy ? ' · 正忙' : ''}`
    : '屏幕陪伴：没在跑'

  clear(SPEC.recent)
  const rows = Array.isArray(presence?.recent) ? [...presence.recent].slice(-RECENT_LIMIT).reverse() : []
  if (!rows.length) {
    SPEC.recent.append(el('li', { class: 'meta', text: presence?.on ? '还没说话。' : '陪看没开。' }))
  } else {
    for (const row of rows) {
      SPEC.recent.append(el('li', {},
        el('div', { text: String(row.text ?? '') }),
        el('div', { class: 'meta', text: `${MODE_LABEL[row.mode] || '陪看'} · ${String(row.at ?? '').slice(11, 16)}` }),
      ))
    }
  }

  for (const btn of SPEC.actionButtons) btn.disabled = !online

  const settings = s.settings || {}
  const size = Number(settings.size ?? 400)
  for (const [id, btn] of SPEC.sizeButtons) btn.className = size === id ? 'primary small' : 'small'

  const skins = Array.isArray(pet.skins) ? pet.skins : []
  const signature = skins.map((x) => `${x.id}:${x.name}`).join('|') + `#${settings.skin ?? ''}`
  if (signature !== SPEC.skinSignature) {
    SPEC.skinSignature = signature
    clear(SPEC.skin)
    const known = new Set()
    SPEC.skin.append(el('option', { value: '', text: '默认' }))
    known.add('')
    for (const skin of skins) {
      if (known.has(skin.id)) continue
      known.add(skin.id)
      SPEC.skin.append(el('option', { value: skin.id, text: skin.name }))
    }
    const current = String(settings.skin ?? '')
    if (!known.has(current)) SPEC.skin.append(el('option', { value: current, text: `${current}（壳里没报到）` }))
    SPEC.skin.value = current
  } else if (SPEC.skin.value !== String(settings.skin ?? '')) {
    SPEC.skin.value = String(settings.skin ?? '')
  }

  const companion = s.companion
  if (!companion) {
    SPEC.companionLine.textContent = '陪伴会话：还没开。'
    clear(SPEC.companionStats)
    SPEC.rotate.disabled = true
  } else {
    const id = String(companion.sessionId ?? '')
    SPEC.companionLine.textContent = `陪伴会话：${id ? id.slice(0, 8) : '还没开'}`
    SPEC.companionLine.title = id
    clear(SPEC.companionStats)
    const threshold = Number(companion.rotateAfter ?? 0)
    for (const [k, v] of [
      ['评论数', Number(companion.sessionComments ?? 0)],
      ['对话轮数', Number(companion.chatTurns ?? 0)],
      ['轮换阈值', threshold > 0 ? threshold : '不自动换'],
    ]) {
      SPEC.companionStats.append(el('div', {}, el('dt', { text: k }), el('dd', { text: String(v) })))
    }
    SPEC.rotate.disabled = !id
  }
}

async function load() {
  const r = await fish('pet/state')
  if (!r.ok) {
    SPEC.note.textContent = errorText(r)
    SPEC.statusLine.replaceChildren(statusDot('bad', '离线'), el('b', { text: '桌宠状态读不到' }))
    SPEC.statusMeta.textContent = '桌宠接口不可达；可能还没部署或版本较旧。'
    for (const btn of SPEC.actionButtons) btn.disabled = true
    return
  }
  SPEC.note.textContent = ''
  const data = r.data || {}
  if (data.ok === false) {
    SPEC.note.textContent = String(data.note || '桌宠状态没在跑。')
    data.pet = { online: false }
    data.presence = null
    data.companion = null
  }
  SPEC.state = data
  render()
}

async function act(motion, btn) {
  if (btn) btn.disabled = true
  SPEC.actionsNote.textContent = '正在演…'
  const r = await postFish('pet/act', { motion })
  const ok = r.ok && r.data?.ok !== false
  SPEC.actionsNote.textContent = ok ? '演好了。' : writeError(r)
  if (btn) btn.disabled = false
  if (ok) await load()
}

async function applyConfig(body) {
  const what = body.size !== undefined ? '尺寸' : '皮肤'
  SPEC.looksNote.textContent = `正在改${what}…`
  const r = await postFish('pet/config', body)
  if (!r.ok || r.data?.ok === false) {
    SPEC.looksNote.textContent = writeError(r)
    return
  }
  SPEC.looksNote.textContent = `${what}改好了；桌宠下一轮取状态时生效。`
  await load()
}

async function rotate() {
  if (!window.confirm('换一条陪伴会话？接下来的评论和对话会记到新会话里。')) return
  SPEC.rotate.disabled = true
  SPEC.companionNote.textContent = '正在换…'
  const r = await postFish('pet/rotate', {})
  if (!r.ok || r.data?.ok === false) {
    SPEC.companionNote.textContent = writeError(r)
    SPEC.rotate.disabled = false
    return
  }
  SPEC.companionNote.textContent = `换好了：${String(r.data?.sessionId ?? '').slice(0, 8)}`
  await load()
}

let poll = null
function startPoll() {
  if (poll) return
  poll = setInterval(() => { if (!document.hidden) void load() }, POLL_MS)
}
function stopPoll() {
  if (poll) { clearInterval(poll); poll = null }
}

export const herPet = {
  id: 'her-pet',
  nav: 'her',
  slug: 'pet',
  label: '桌宠',
  order: 40,

  enter(root, ctx) {
    if (!SPEC.built) { build(root, ctx); SPEC.built = true }
    startPoll()
    void load()
  },

  leave() {
    stopPoll()
  },
}
