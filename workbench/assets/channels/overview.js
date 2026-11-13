// 通道 · 总览：注册表里的每个通道各一张卡 + 说话节奏 + 她（8710）+ 最近动作。
// 页面订阅 ctx.onStatus（通道页 3 秒一次），离开取消。
import {
  el, clear, card, local, errorText, openHer, humanChip, fillStats,
} from '../lib.js'
import { CHANNELS } from './registry.js'
import { renderSpeechCard } from './speech.js'

// 与 server.mjs 的 HOLD_SEC（600 秒）一致：停止 = 写一段 hold，到点看门狗自动拉起。
const HOLD_MINUTES = 10

const SPEC = { channels: new Map() }

function channelEntry(ch) {
  const c = card(ch.label)
  const lines = el('div')
  const acts = el('div', { class: 'row' })
  c.body.append(lines, acts)
  return { ch, card: c, lines, acts }
}

function buildHer(root) {
  SPEC.her = card('她（8710 上的 DSH）')
  SPEC.herStats = el('dl', { class: 'fish-stats' })
  SPEC.herMsg = el('span', { class: 'meta' })
  SPEC.her.body.append(
    SPEC.herStats,
    el('div', { class: 'row' },
      el('button', { class: 'primary small', type: 'button', text: '打开她的界面', onclick: () => openHerHere() }),
      el('button', { class: 'small', type: 'button', text: '启动', onclick: () => actHer('start') }),
      el('button', { class: 'small', type: 'button', text: '停止', onclick: () => actHer('stop') }),
      SPEC.herMsg,
    ),
  )
  root.append(SPEC.her.root)
}

function buildLog(root) {
  SPEC.log = card('最近动作', { note: '只读最近 20 条；人工动作带「人工」标记。' })
  SPEC.logList = el('ul', { class: 'plain' })
  SPEC.log.body.append(SPEC.logList)
  root.append(SPEC.log.root)
}

function build(root, ctx) {
  SPEC.built = true
  SPEC.ctx = ctx
  for (const ch of CHANNELS) {
    const entry = channelEntry(ch)
    SPEC.channels.set(ch.id, entry)
    root.append(entry.card.root)
  }
  SPEC.speech = renderSpeechCard(ctx)
  root.append(SPEC.speech.root)
  buildHer(root)
  buildLog(root)
  subscribe(ctx)
}

function subscribe(ctx) {
  SPEC.unsub?.()
  SPEC.unsub = ctx?.onStatus?.((status) => applyStatus(status))
}

function statusFor(status, ch) {
  return status?.channels?.[ch.id] ?? status?.[ch.id] ?? null
}

function applyStatus(status) {
  if (!status) return
  for (const entry of SPEC.channels.values()) {
    const st = statusFor(status, entry.ch)
    entry.card.setMeta('', entry.ch.badge?.(st) || '')
    const summary = entry.ch.summary?.(st, SPEC.ctx) || { lines: [], actions: [] }
    clear(entry.lines)
    for (const line of summary.lines || []) entry.lines.append(el('div', { text: line }))
    clear(entry.acts)
    for (const action of summary.actions || []) {
      entry.acts.append(el('button', {
        class: 'small',
        type: 'button',
        text: action.label,
        onclick: () => action.onClick?.(),
      }))
    }
  }
  const her = status.her || null
  fillStats(SPEC.herStats, [
    ['运行', her?.running ? '在跑' : '没在跑'],
    ['事件', her?.events ?? '—'],
    ['最后写入', her?.lastEventAt || '—'],
    ['HTTP', her?.http ?? '—'],
  ])
  SPEC.her.setMeta(her?.label || '', her?.running ? 'ok' : 'bad')
  loadLog()
}

async function loadLog() {
  const r = await local('/api/status.log')
  if (!r.ok) { clear(SPEC.logList); SPEC.logList.append(el('li', { text: errorText(r) })); return }
  const rows = r.data?.rows || []
  clear(SPEC.logList)
  if (!rows.length) { SPEC.logList.append(el('li', { text: '还没有动作' })); return }
  for (const row of rows) {
    const li = el('li', { class: row.ok ? '' : 'fail' },
      el('span', { class: 'meta', text: row.at }),
      ' ',
      el('b', { text: row.who }),
      ' ',
      el('span', { text: row.text }),
    )
    if (row.operator === 'human') li.append(' ', humanChip())
    SPEC.logList.append(li)
  }
}

async function openHerHere() {
  const r = await openHer()
  SPEC.herMsg.textContent = r.ok ? '' : `没打开：${r.error}`
}

async function actHer(kind) {
  SPEC.herMsg.textContent = kind === 'stop'
    ? `停止中…（会写 ${HOLD_MINUTES} 分钟 hold）`
    : '启动中…'
  const r = await local('/api/her/' + kind, { method: 'POST' })
  const d = r.data || {}
  if (!r.ok) { SPEC.herMsg.textContent = `没成：${d.error || d.err || '接口没回话'}`; return }
  SPEC.herMsg.textContent = kind === 'stop'
    ? `已停；约 ${HOLD_MINUTES} 分钟后自动拉起`
    : '已启动（已解除 hold）'
  await SPEC.ctx?.refreshStatus?.()
}

// ---------- 页面契约 ----------

export const channelsOverview = {
  id: 'channels-overview',
  nav: 'channels',
  slug: 'overview',
  label: '总览',
  order: 0,

  enter(root, ctx) {
    if (!SPEC.built) build(root, ctx)
    SPEC.ctx = ctx
    // 离开页面时退订了；重进要接回 3 秒一次的状态。
    subscribe(ctx)
    applyStatus(ctx.status)
    loadLog()
    SPEC.speech?.refresh?.()
    ctx.refreshStatus?.()
  },

  leave() {
    SPEC.unsub?.()
    SPEC.unsub = null
  },
}
