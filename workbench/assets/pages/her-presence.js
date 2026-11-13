// 她 · 陪伴：屏幕陪伴的三个模式开关与状态。
// 开关即授权；默认全关；所有请求经 BFF /api/fish/presence/* 转到 8710 插件。
import { el, clear, card, fish, postFish, clock, errorText, hint } from '../lib.js'

const MODES = [
  { id: 'event', label: '事件', note: '场景突变 / 结算 / 菜单；每 30 秒最多一次候选。' },
  { id: 'ambient', label: '氛围', note: '10–30 秒一档；值得说才说。' },
  { id: 'work', label: '工作', note: '只看前台白名单窗口（Code / 终端）；长冷却。' },
]

const SPEC = {}

function build(root, ctx) {
  SPEC.ctx = ctx
  SPEC.card = card('陪你看屏幕', {
    note: '默认关。开启后会把当前窗口/屏幕的低频候选帧发给模型；关闭立即停采集。',
  })
  SPEC.status = el('div', { class: 'meta', text: '正在读状态…' })
  SPEC.note = el('div', { class: 'meta' })
  SPEC.body = el('div', { class: 'row' })
  SPEC.stop = el('button', { class: 'small', type: 'button', text: '立即停止', onclick: () => stopAll() })
  SPEC.stop.hidden = true
  SPEC.card.body.append(
    SPEC.status,
    SPEC.body,
    el('div', { class: 'row' }, SPEC.stop, SPEC.note),
    hint('终端里可能有凭据：工作模式首次开启前请确认当前窗口没有敏感内容。', 'meta'),
  )
  root.append(SPEC.card.root)
}

function render() {
  clear(SPEC.body)
  const on = Boolean(SPEC.state?.on)
  const mode = String(SPEC.state?.mode ?? '')
  for (const m of MODES) {
    const active = on && mode === m.id
    const btn = el('button', {
      class: active ? 'primary small' : 'small',
      type: 'button',
      text: `${m.label}${active ? ' · 开' : ''}`,
      onclick: () => toggle(m),
    })
    SPEC.body.append(el('div', { class: 'field' },
      el('span', { class: 'meta', text: m.note }), btn))
  }
  SPEC.status.textContent = on
    ? `正在看：${mode || '—'} · ${SPEC.state?.lastComment ? '最近一句：' + SPEC.state.lastComment : '还没说话'} · ${clock()}`
    : `关着 · ${clock()}`
  SPEC.stop.hidden = !on
  SPEC.note.textContent = SPEC.state?.lastError ? `上次错误：${SPEC.state.lastError}` : ''
}

async function load() {
  const r = await fish('presence/status')
  if (!r.ok) {
    SPEC.status.textContent = errorText(r)
    SPEC.note.textContent = '屏幕陪伴接口不可达；可能还没部署或版本较旧。'
    return
  }
  SPEC.state = r.data || {}
  render()
}

function confirmOn(mode) {
  const label = MODES.find((m) => m.id === mode)?.label || mode
  return window.confirm(`开启「${label}」后，会把当前窗口/屏幕的低频候选帧发给模型。继续？`)
}

async function toggle(m) {
  const on = Boolean(SPEC.state?.on)
  const same = on && SPEC.state?.mode === m.id
  if (same) return setMode(m.id, false)
  if (!confirmOn(m.id)) return
  return setMode(m.id, true)
}

async function setMode(mode, on) {
  SPEC.note.textContent = on ? '正在开启…' : '正在关闭…'
  const r = await postFish('presence/mode', { mode, on })
  if (!r.ok) { SPEC.note.textContent = errorText(r); return }
  if (r.data?.ok === false) { SPEC.note.textContent = r.data?.note || '没切成。'; await load(); return }
  SPEC.state = r.data?.status || r.data || {}
  render()
  await load()
}

async function stopAll() {
  if (SPEC.state?.mode) await setMode(SPEC.state.mode, false)
  else await load()
}

let poll = null
function startPoll() {
  if (poll) return
  poll = setInterval(() => { if (SPEC.state?.on) void load() }, 5000)
}
function stopPoll() {
  if (poll) { clearInterval(poll); poll = null }
}

export const herPresence = {
  id: 'her-presence',
  nav: 'her',
  slug: 'presence',
  label: '陪伴',
  order: 30,

  enter(root, ctx) {
    if (!SPEC.built) { build(root, ctx); SPEC.built = true }
    startPoll()
    void load()
  },

  leave() {
    stopPoll()
  },
}
