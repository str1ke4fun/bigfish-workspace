// 她 · 桌宠：在线状态、屏幕陪伴开关、动作试演、尺寸/皮肤/气泡、陪伴会话。
// 页面读 /pet/state 与 /presence/status（3 秒轮询）；写：演动作、改外观、换会话、开关陪看。
// 都经 BFF /api/fish/* 转到 8710 插件；开关即授权，默认全关。
import {
  el, clear, card, fish, postFish, fmtTime, fmtClock, errorText, writeError, statusDot, hint,
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

/** 上次为什么停：重启后界面要能说清楚，而不是只显示「关着」。 */
const STOP_REASONS = {
  manual: '手动关闭',
  'max-run': '到了 4 小时上限',
  black: '黑屏太久自动停',
  crashes: '采集连续失败自动停',
  'start-failed': '抓帧启动失败',
}

const PRESENCE_MODES = [
  { id: 'event', label: '事件', note: '场景突变 / 结算 / 菜单；每 30 秒最多一次候选。' },
  { id: 'ambient', label: '氛围', note: '10–30 秒一档；值得说才说。' },
  { id: 'work', label: '工作', note: '只看前台白名单窗口（Code / 终端）；长冷却。' },
]

const OPACITIES = [90, 70, 50]
const WIDTHS = [
  { id: 0, label: '跟随大小' },
  { id: 260, label: '小' },
  { id: 320, label: '中' },
  { id: 400, label: '大' },
]

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
  SPEC.scene = el('div', { class: 'meta' })
  SPEC.presence = el('div', { class: 'meta' })
  // 仅拉起桌宠壳，不碰陪看。链接交给浏览器、由 Windows 按 bigfishpet:// 协议启动壳；
  // 服务端不起子进程。协议要壳在 Windows 上手动启动过一次才登记。
  SPEC.openPet = el('a', { class: 'button small', href: 'bigfishpet://open', text: '仅打开桌宠' })
  SPEC.openPetNote = el('div', { class: 'meta', text: '只把桌宠拉起来，不开陪看。第一次要先在 Windows 上手动启动一次桌宠壳，之后才能点开。' })
  SPEC.recent = el('ul', { class: 'timeline' })
  SPEC.recentCard = card('她看到的这一会儿', { note: '最多 5 条；她愿意说的时候才说，这些话不进事件流。' })
  SPEC.recentCard.body.append(SPEC.recent)
  SPEC.statusCard.body.append(
    SPEC.statusLine,
    SPEC.statusMeta,
    SPEC.activity,
    SPEC.action,
    SPEC.scene,
    SPEC.presence,
    el('div', { class: 'row' }, SPEC.openPet),
    SPEC.openPetNote,
    SPEC.recentCard.root,
  )

  // ---- 1b. 屏幕陪伴 ----
  SPEC.presenceCard = card('陪你看屏幕', {
    note: '默认关。开启后会把当前窗口/屏幕的低频候选帧发给模型；关闭立即停采集。',
  })
  SPEC.presenceStatus = el('div', { class: 'meta', text: '正在读状态…' })
  SPEC.presenceModes = el('div', { class: 'row' })
  SPEC.presenceNote = el('div', { class: 'meta' })
  SPEC.presenceStop = el('button', { class: 'small', type: 'button', text: '立即停止', onclick: () => stopPresence() })
  SPEC.presenceStop.hidden = true
  SPEC.presenceCard.body.append(
    SPEC.presenceStatus,
    SPEC.presenceModes,
    el('div', { class: 'row' }, SPEC.presenceStop, SPEC.presenceNote),
    hint('终端里可能有凭据：工作模式首次开启前请确认当前窗口没有敏感内容。', 'meta'),
  )

  // ---- 1c. 宿主托管 ----
  SPEC.hostCuaCard = card('托管模式', {
    note: '15 分钟后自动结束；关掉立即停止。只允许白名单应用，只做后台操作，不抢前台；每个应用能看多少/能不能输入由内容粒度和输入许可决定。',
  })
  SPEC.hostCuaStatus = el('div', { class: 'meta', text: '正在读状态…' })
  SPEC.hostCuaApps = el('div', { class: 'meta' })
  SPEC.hostCuaNote = el('div', { class: 'meta' })
  SPEC.hostCuaObserve = el('button', { class: 'small', type: 'button', text: '允许看窗口', onclick: () => setHostCua('observe') })
  SPEC.hostCuaManaged = el('button', { class: 'small', type: 'button', text: '开启托管', onclick: () => startHostCua() })
  SPEC.hostCuaStop = el('button', { class: 'small', type: 'button', text: '立即停止', onclick: () => setHostCua('off') })
  SPEC.hostCuaStop.hidden = true
  SPEC.hostCuaCard.body.append(
    SPEC.hostCuaStatus,
    SPEC.hostCuaApps,
    el('div', { class: 'row' }, SPEC.hostCuaObserve, SPEC.hostCuaManaged, SPEC.hostCuaStop),
    SPEC.hostCuaNote,
    hint('终端输入等于 shell，浏览器输入等于网页操作；只有你在这里点开并确认后才生效。', 'meta'),
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
      onclick: (ev) => act({ motion: m.id }, ev.currentTarget),
    })
    SPEC.actionButtons.push(btn)
    SPEC.actions.append(btn)
  }
  SPEC.registeredActionSelect = el('select', { class: 'small', 'aria-label': '选择已登记动作' })
  SPEC.registeredActionSelect.append(el('option', { value: '', text: '选择动作…' }))
  SPEC.registeredActionSelect.addEventListener('change', () => {
    SPEC.registeredActionButton.disabled = !SPEC.registeredActionSelect.value || !SPEC.state?.pet?.online
  })
  SPEC.registeredActionButton = el('button', {
    class: 'small', type: 'button', text: '演一遍', disabled: true,
    onclick: (ev) => act({ action: SPEC.registeredActionSelect.value }, ev.currentTarget),
  })
  SPEC.registeredActionsNote = el('div', { class: 'meta' })
  SPEC.sceneButtons = new Map()
  SPEC.sceneControls = el('div', { class: 'row' })
  for (const [id, label] of [['auto', '按日程'], ['sleep', '睡觉'], ['wake', '起来']]) {
    const button = el('button', {
      class: 'small', type: 'button', text: label,
      onclick: (ev) => setRest(id, ev.currentTarget),
    })
    SPEC.sceneButtons.set(id, button)
    SPEC.sceneControls.append(button)
  }
  SPEC.actionsNote = el('div', { class: 'meta' })
  SPEC.actionsCard.body.append(
    SPEC.actions,
    el('div', { class: 'row' }, SPEC.registeredActionSelect, SPEC.registeredActionButton),
    SPEC.registeredActionsNote,
    el('div', { class: 'field' }, el('span', { class: 'meta', text: '休息场景' }), SPEC.sceneControls),
    SPEC.actionsNote,
  )
  SPEC.actionCatalogSignature = ''

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
  SPEC.opacityButtons = new Map()
  SPEC.opacities = el('div', { class: 'row' })
  for (const value of OPACITIES) {
    const btn = el('button', {
      class: 'small',
      type: 'button',
      text: `${value}%`,
      onclick: () => applyConfig({ bubbleOpacity: value }),
    })
    SPEC.opacityButtons.set(value, btn)
    SPEC.opacities.append(btn)
  }
  SPEC.opacitySlider = el('input', { type: 'range', min: '40', max: '100', step: '5' })
  SPEC.opacitySlider.addEventListener('change', () => applyConfig({ bubbleOpacity: Number(SPEC.opacitySlider.value) }))
  SPEC.widthButtons = new Map()
  SPEC.widths = el('div', { class: 'row' })
  for (const w of WIDTHS) {
    const btn = el('button', {
      class: 'small',
      type: 'button',
      text: w.label,
      onclick: () => applyConfig({ bubbleWidth: w.id }),
    })
    SPEC.widthButtons.set(w.id, btn)
    SPEC.widths.append(btn)
  }
  SPEC.skin = el('select', { class: 'small' })
  SPEC.skin.addEventListener('change', () => applyConfig({ skin: SPEC.skin.value }))
  SPEC.skinSignature = ''
  SPEC.skinLabel = el('label', {}, el('span', { class: 'meta', text: '皮肤' }), SPEC.skin)
  SPEC.looksNote = el('div', { class: 'meta' })
  SPEC.looksCard.body.append(
    el('div', { class: 'field' }, el('span', { class: 'meta', text: '尺寸' }), SPEC.sizes),
    el('div', { class: 'field' }, el('span', { class: 'meta', text: '气泡不透明度（调低不挡游戏）' }), SPEC.opacities, SPEC.opacitySlider),
    el('div', { class: 'field' }, el('span', { class: 'meta', text: '气泡宽度' }), SPEC.widths),
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

  root.append(SPEC.statusCard.root, SPEC.presenceCard.root, SPEC.hostCuaCard.root, SPEC.actionsCard.root, SPEC.looksCard.root, SPEC.companionCard.root, SPEC.note)
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
  const actionLabel = action?.action
    ? (Array.isArray(s.actions) ? s.actions.find((item) => item.id === action.action)?.label : '') || action.action
    : MOTIONS.find((m) => m.id === action?.motion)?.label || action?.motion
  SPEC.action.textContent = action
    ? `动作：${actionLabel}${action.text ? ` · ${action.text}` : ''} · ${timeText(action.at)}`
    : '动作：没有正在演的动作'

  SPEC.scene.textContent = s.scene?.kind === 'rest'
    ? `场景：休息 · ${timeText(s.scene.at)}`
    : s.scene?.kind === 'out'
      ? `场景：出门 · ${timeText(s.scene.at)}`
      : '场景：日常'

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
        el('div', { class: 'meta', text: `${MODE_LABEL[row.mode] || '陪看'} · ${fmtClock(row.at)}` }),
      ))
    }
  }

  for (const btn of SPEC.actionButtons) btn.disabled = !online
  renderRegisteredActions(s.actions, online)
  for (const button of SPEC.sceneButtons.values()) button.disabled = !online

  const settings = s.settings || {}
  const size = Number(settings.size ?? 400)
  for (const [id, btn] of SPEC.sizeButtons) btn.className = size === id ? 'primary small' : 'small'

  const opacity = Number(settings.bubbleOpacity ?? 90)
  for (const [value, btn] of SPEC.opacityButtons) btn.className = opacity === value ? 'primary small' : 'small'
  if (document.activeElement !== SPEC.opacitySlider) SPEC.opacitySlider.value = String(opacity)
  const width = Number(settings.bubbleWidth ?? 0)
  for (const [id, btn] of SPEC.widthButtons) btn.className = width === id ? 'primary small' : 'small'

  renderPresence(presence)

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

function renderRegisteredActions(actions, online) {
  const list = Array.isArray(actions) ? actions.filter((item) => (
    item && typeof item.id === 'string' && typeof item.label === 'string' && typeof item.group === 'string'
  )) : []
  const signature = list.map((item) => `${item.id}:${item.label}:${item.group}`).join('|')
  if (signature !== SPEC.actionCatalogSignature) {
    const selected = SPEC.registeredActionSelect.value
    SPEC.actionCatalogSignature = signature
    clear(SPEC.registeredActionSelect)
    SPEC.registeredActionSelect.append(el('option', { value: '', text: '选择动作…' }))
    const groups = new Map()
    for (const item of list) {
      if (!groups.has(item.group)) groups.set(item.group, [])
      groups.get(item.group).push(item)
    }
    for (const [group, items] of groups) {
      const optgroup = el('optgroup', { label: group })
      for (const item of items) optgroup.append(el('option', { value: item.id, text: item.label }))
      SPEC.registeredActionSelect.append(optgroup)
    }
    if (list.some((item) => item.id === selected)) SPEC.registeredActionSelect.value = selected
  }
  SPEC.registeredActionSelect.disabled = !online || list.length === 0
  SPEC.registeredActionButton.disabled = !online || !SPEC.registeredActionSelect.value || list.length === 0
  SPEC.registeredActionsNote.textContent = list.length
    ? `桌宠已上报 ${list.length} 个动作。`
    : online ? '当前桌宠没有上报动作目录；更新并重启 Windows 桌宠壳后再试。' : '桌宠在线后显示它上报的动作。'
}

async function load() {
  const r = await fish('pet/state')
  if (!r.ok) {
    SPEC.note.textContent = errorText(r)
    SPEC.statusLine.replaceChildren(statusDot('bad', '离线'), el('b', { text: '桌宠状态读不到' }))
    SPEC.statusMeta.textContent = '桌宠接口不可达；可能还没部署或版本较旧。'
    for (const btn of SPEC.actionButtons) btn.disabled = true
    SPEC.registeredActionSelect.disabled = true
    SPEC.registeredActionButton.disabled = true
    for (const button of SPEC.sceneButtons.values()) button.disabled = true
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
  void loadPresenceMeta()
  void loadHostCuaMeta()
}

function renderPresence(presence) {
  clear(SPEC.presenceModes)
  const on = Boolean(presence?.on)
  const mode = String(presence?.mode ?? '')
  for (const m of PRESENCE_MODES) {
    const active = on && mode === m.id
    const btn = el('button', {
      class: active ? 'primary small' : 'small',
      type: 'button',
      text: `${m.label}${active ? ' · 开' : ''}`,
      onclick: () => togglePresence(m),
    })
    SPEC.presenceModes.append(el('div', { class: 'field' }, el('span', { class: 'meta', text: m.note }), btn))
  }
  const stopLabel = STOP_REASONS[String(SPEC.presenceStopReason ?? '')] ?? ''
  const last = Array.isArray(presence?.recent) && presence.recent.length ? presence.recent[presence.recent.length - 1] : null
  SPEC.presenceStatus.textContent = on
    ? `正在看：${MODE_LABEL[mode] || mode || '—'} · ${last ? '最近一句：' + String(last.text ?? '') : '还没说话'}`
    : `陪看没开${stopLabel ? `（上次：${stopLabel}）` : ''}`
  SPEC.presenceStop.hidden = !on
}

function confirmOn(mode) {
  const label = PRESENCE_MODES.find((m) => m.id === mode)?.label || mode
  return window.confirm(`开启「${label}」后，会把当前窗口/屏幕的低频候选帧发给模型。继续？`)
}

async function loadPresenceMeta() {
  const r = await fish('presence/status')
  if (!r.ok) {
    SPEC.presenceNote.textContent = '屏幕陪伴接口不可达；可能还没部署或版本较旧。'
    return
  }
  SPEC.presenceStopReason = r.data?.stopReason ?? ''
  SPEC.presenceNote.textContent = r.data?.lastError ? `上次错误：${r.data.lastError}` : ''
  if (SPEC.state) renderPresence(SPEC.state.presence)
}

async function setPresence(mode, on) {
  SPEC.presenceNote.textContent = on ? '正在开启…' : '正在关闭…'
  const r = await postFish('presence/mode', { mode, on })
  if (!r.ok) { SPEC.presenceNote.textContent = errorText(r); return }
  if (r.data?.ok === false) SPEC.presenceNote.textContent = r.data?.note || '没切成。'
  else SPEC.presenceNote.textContent = ''
  await load()
}

async function togglePresence(m) {
  const presence = SPEC.state?.presence
  const same = Boolean(presence?.on) && presence?.mode === m.id
  if (same) return setPresence(m.id, false)
  if (!confirmOn(m.id)) return
  return setPresence(m.id, true)
}

async function stopPresence() {
  const mode = SPEC.state?.presence?.mode
  if (mode) await setPresence(mode, false)
  else await load()
}

async function loadHostCuaMeta() {
  const r = await fish('host-cua/status')
  if (!r.ok || r.data?.ok === false) {
    SPEC.hostCuaStatus.textContent = '托管接口不可达；可能还没部署或版本较旧。'
    SPEC.hostCuaApps.textContent = ''
    SPEC.hostCuaObserve.disabled = true
    SPEC.hostCuaManaged.disabled = true
    SPEC.hostCuaStop.hidden = true
    return
  }
  renderHostCua(r.data)
}

function renderHostCua(s = {}) {
  const mode = String(s.mode ?? 'off')
  const phase = String(s.phase ?? 'off')
  const on = mode !== 'off'
  const remain = Number(s.remainingMs) > 0 ? Math.ceil(Number(s.remainingMs) / 60_000) : 0
  const driver = s.driver?.connected ? `驱动 ${s.driver.version || ''}` : '驱动没连'
  const actions = Number(s.actions?.count) || 0
  const modeLabel = mode === 'managed' ? '托管' : mode === 'observe' ? '看窗口' : '关'
  SPEC.hostCuaStatus.textContent = on
    ? `正在${modeLabel} · 还剩 ${remain} 分钟 · ${driver} · 已操作 ${actions} 次`
    : `托管没开${s.lastError ? `（上次：${s.lastError}）` : ''}`
  const apps = Array.isArray(s.apps) ? s.apps : []
  SPEC.hostCuaApps.textContent = apps.length
    ? '应用：' + apps.map((a) => `${a.app}（${a.detail}/${a.input}）`).join('、')
    : '没有可用的白名单应用。'
  SPEC.hostCuaObserve.hidden = mode === 'managed'
  SPEC.hostCuaObserve.disabled = mode === 'managed'
  SPEC.hostCuaManaged.hidden = on
  SPEC.hostCuaStop.hidden = !on
  SPEC.hostCuaNote.textContent = phase === 'error' && s.lastError ? `上次错误：${s.lastError}` : ''
}

async function setHostCua(mode) {
  SPEC.hostCuaNote.textContent = mode === 'off' ? '正在停止…' : '正在开启…'
  const r = await postFish('host-cua/mode', { mode, actor: 'workbench' })
  if (!r.ok || r.data?.ok === false) {
    SPEC.hostCuaNote.textContent = writeError(r)
    return
  }
  SPEC.hostCuaNote.textContent = ''
  await load()
}

function startHostCua() {
  const apps = Array.isArray(SPEC.state?.hostCua?.apps) ? SPEC.state.hostCua.apps : []
  const names = apps.length ? apps.map((a) => a.app).join(' / ') : '白名单应用'
  const ok = window.confirm(
    `开启后她可以在 ${names} 里后台点击和打字；终端输入等于 shell，浏览器输入等于网页操作。15 分钟自动结束。继续？`,
  )
  if (ok) void setHostCua('managed')
}

async function act(payload, btn) {
  if (btn) btn.disabled = true
  SPEC.actionsNote.textContent = '正在演…'
  const r = await postFish('pet/act', payload)
  const ok = r.ok && r.data?.ok !== false
  SPEC.actionsNote.textContent = ok ? '演好了。' : writeError(r)
  if (btn) btn.disabled = false
  if (ok) await load()
}

async function setRest(action, btn) {
  for (const button of SPEC.sceneButtons.values()) button.disabled = true
  SPEC.actionsNote.textContent = action === 'auto' ? '正在恢复日程…' : action === 'sleep' ? '正在休息…' : '正在起来…'
  const r = await postFish('pet/rest', { action })
  if (!r.ok || r.data?.ok === false) {
    SPEC.actionsNote.textContent = writeError(r)
  } else {
    SPEC.actionsNote.textContent = action === 'auto' ? '已交回日程决定。' : action === 'sleep' ? '进入休息场景。' : '休息场景已结束。'
    await load()
  }
  for (const button of SPEC.sceneButtons.values()) button.disabled = !SPEC.state?.pet?.online
  if (btn) btn.blur()
}

async function applyConfig(body) {
  const what = body.size !== undefined ? '尺寸'
    : body.skin !== undefined ? '皮肤'
    : body.bubbleOpacity !== undefined ? '气泡透明度' : '气泡宽度'
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
