// 她 · 记忆：事件 / 日记 / 日报 / 判断 / 模板，五段只读。
// 事件只做类型和数量筛选，不提供全文检索；记忆预算等配置在系统 · 设置。
import { el, clear, card, fish, fmtTime, clock, errorText, hint, asText, segment, emptyState } from '../lib.js'

const TYPES = ['', 'meta', 'utterance', 'revise', 'refusal', 'reunion', 'narration', 'saw']

const SECTIONS = [
  { id: 'events', label: '事件' },
  { id: 'diary', label: '日记' },
  { id: 'reports', label: '日报' },
  { id: 'beliefs', label: '判断' },
  { id: 'templates', label: '模板' },
]

const SPEC = {}

function build(root) {
  SPEC.switch = segment(SECTIONS, {
    value: 'events',
    label: '记忆分段',
    onChange: (id) => show(id),
  })

  // ---- 事件 ----
  SPEC.events = card('事件', { note: '只做类型和数量筛选，不提供全文检索。' })
  SPEC.eventsList = el('ul', { class: 'plain' })
  SPEC.eventsMsg = el('span', { class: 'meta' })
  SPEC.typePick = el('select', {
    onchange: () => loadEvents(),
  }, ...TYPES.map((t) => el('option', { value: t, text: t || '全部' })))
  SPEC.limitPick = el('select', {
    onchange: () => loadEvents(),
  }, ...[50, 100, 200, 500].map((n) => el('option', { value: String(n), text: String(n) })))
  SPEC.events.body.append(
    el('div', { class: 'row' },
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '类型' }), SPEC.typePick),
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '条数' }), SPEC.limitPick),
      el('button', { class: 'primary', type: 'button', text: '读取', onclick: () => loadEvents() }),
      SPEC.eventsMsg,
    ),
    SPEC.eventsList,
  )

  // ---- 日记 ----
  SPEC.diary = card('日记', { note: '设置为不可见时，只给日期目录，不给正文。' })
  SPEC.diaryPick = el('div', { class: 'row' })
  SPEC.diaryBody = el('div')
  SPEC.diary.body.append(SPEC.diaryPick, SPEC.diaryBody)

  // ---- 日报 ----
  SPEC.reports = card('日报', { note: '只读预览，保留原始 Markdown，不提供导出。' })
  SPEC.reportPick = el('div', { class: 'row' })
  SPEC.reportBody = el('pre', { class: 'doc' })
  SPEC.reports.body.append(SPEC.reportPick, SPEC.reportBody)

  // ---- 判断 ----
  SPEC.beliefs = card('判断', { note: '判断、被推翻的、拒绝记录、自我修改尝试——原样列出，不做裁决。' })
  SPEC.beliefsBody = el('div')
  SPEC.beliefs.body.append(SPEC.beliefsBody)

  // ---- 模板 ----
  SPEC.templates = card('处境模板', { note: '哪些处境已经来过、来过几次。' })
  SPEC.templatesBody = el('div')
  SPEC.templates.body.append(SPEC.templatesBody)

  SPEC.sections = {
    events: SPEC.events.root,
    diary: SPEC.diary.root,
    reports: SPEC.reports.root,
    beliefs: SPEC.beliefs.root,
    templates: SPEC.templates.root,
  }

  root.append(SPEC.switch.root, ...Object.values(SPEC.sections))
  show('events')
}

function show(id) {
  for (const [key, node] of Object.entries(SPEC.sections)) node.hidden = key !== id
  SPEC.switch.set(id)
}

// ---------- 事件 ----------

async function loadEvents() {
  const box = SPEC.eventsList
  clear(box)
  box.append(el('li', { class: 'meta', text: '读取中…' }))
  const type = SPEC.typePick.value
  const limit = SPEC.limitPick.value
  const qs = new URLSearchParams({ limit })
  if (type) qs.set('type', type)
  const r = await fish('events?' + qs.toString())
  clear(box)
  if (!r.ok) { box.append(el('li', { class: 'bad', text: errorText(r) })); SPEC.eventsMsg.textContent = ''; return }
  const rows = r.data?.rows || []
  const total = r.data?.total ?? rows.length
  // /events 的 total 是全部事件数，rows 才是筛选后的；分开说，别让「共 N 条」对不上列表。
  SPEC.eventsMsg.textContent = (type ? `筛选下 ${rows.length} 条 · 全部 ${total} 条` : `共 ${total} 条`) + ` · ${clock()}`
  if (!rows.length) { box.append(el('li', { class: 'meta', text: '这个筛选下没有事件' })); return }
  for (const e of rows) {
    box.append(el('li', {},
      el('span', { class: 't', text: fmtTime(e.ts) }),
      el('span', { class: 'kind', text: e.type || '—' }),
      el('span', { class: 'x', text: String(e.text || '') }),
    ))
  }
}

// ---------- 日记 ----------

function pick(options, onPick) {
  return el('select', { onchange: (e) => onPick(e.target.value) },
    ...options.map(([value, label]) => el('option', { value, text: label })))
}

async function loadDiary() {
  const box = SPEC.diaryBody
  clear(box)
  clear(SPEC.diaryPick)
  box.append(hint('读取中…', 'meta'))
  const r = await fish('diary')
  clear(box)
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const d = r.data || {}
  if (!d.enabled) { box.append(hint(d.note || '她没在写日记', 'meta')); return }
  if (!d.visible) {
    box.append(hint(d.note || '日记已写，但设置为不可见', 'meta'))
    const dates = d.lockedDates || []
    if (dates.length) box.append(el('div', { class: 'meta', text: `写过的日期：${dates.slice(0, 20).join('、')}` }))
    return
  }
  for (const item of d.items || []) {
    box.append(el('div', { class: 'meta', text: item.date }), el('pre', { class: 'doc diary-text', text: item.text || '' }))
  }
  const dates = d.dates || []
  if (dates.length) {
    SPEC.diaryPick.append(el('span', { class: 'meta', text: '看别的天：' }),
      pick(dates.map((x) => [x, x]), async (day) => {
        if (!day) return
        const rr = await fish('diary?day=' + encodeURIComponent(day))
        clear(box)
        if (!rr.ok) { box.append(hint(errorText(rr), 'bad')); return }
        box.append(el('div', { class: 'meta', text: rr.data?.date || day }), el('pre', { class: 'doc diary-text', text: rr.data?.text || '' }))
      }))
  }
}

// ---------- 日报 ----------

async function loadReports() {
  clear(SPEC.reportPick)
  SPEC.reportBody.textContent = '读取中…'
  const r = await fish('reports')
  if (!r.ok) { SPEC.reportBody.textContent = errorText(r); return }
  const dates = r.data?.dates || []
  if (!dates.length) { SPEC.reportBody.textContent = '还没有日报。'; return }
  SPEC.reportBody.textContent = '选一天读报。'
  SPEC.reportPick.append(el('span', { class: 'meta', text: '日报：' }),
    pick(dates.map((x) => [x, x]), async (date) => {
      if (!date) return
      SPEC.reportBody.textContent = '读取中…'
      const rr = await fish('reports?date=' + encodeURIComponent(date))
      SPEC.reportBody.textContent = rr.ok ? (rr.data?.md || '这天没有内容') : errorText(rr)
    }))
}

// ---------- 判断 ----------

async function loadBeliefs() {
  const box = SPEC.beliefsBody
  clear(box)
  const r = await fish('beliefs')
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const b = r.data || {}
  const section = (title, rows, render) => {
    const list = Array.isArray(rows) ? rows : []
    box.append(el('h3', { text: `${title}（${list.length}）` }))
    if (!list.length) { box.append(emptyState('还没有。')); return }
    box.append(el('ul', { class: 'plain' }, ...list.map(render)))
  }
  section('还在拿着的判断', b.active, (x) => el('li', {},
    el('span', { class: 'x', text: x.text || '' }),
    el('span', { class: 't', text: fmtTime(x.since) }),
  ))
  section('被推翻的', b.refuted, (x) => el('li', {}, el('span', { class: 'x', text: asText(x) })))
  section('拒绝记录', b.refusals, (x) => el('li', {}, el('span', { class: 'x', text: asText(x) })))
  section('自我修改尝试', b.selfmod, (x) => el('li', {}, el('span', { class: 'x', text: asText(x) })))
}

// ---------- 模板 ----------

async function loadTemplates() {
  const box = SPEC.templatesBody
  clear(box)
  const r = await fish('templates')
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const rows = r.data?.rows || []
  if (!rows.length) { box.append(emptyState('还没有处境模板。')); return }
  box.append(el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ...['id', '阶段', '问什么', '一次性', '来过', '次数', '最近'].map((h) => el('th', { text: h })))),
    el('tbody', {}, ...rows.map((t) => el('tr', {},
      el('td', { text: t.id }), el('td', { text: String(t.stage ?? '') }), el('td', { text: t.asks || '' }),
      el('td', { text: t.once ? '是' : (t.everyDays ? `每 ${t.everyDays} 天` : '') }),
      el('td', { text: t.fired ? '来过' : '—' }), el('td', { text: String(t.count ?? 0) }), el('td', { text: fmtTime(t.lastAt) }),
    ))),
  ))
}

// ---------- 页面契约 ----------

export const herMemory = {
  id: 'her-memory',
  nav: 'her',
  slug: 'memory',
  label: '记忆',
  order: 20,

  enter(root) {
    if (!SPEC.built) { build(root); SPEC.built = true }
    loadEvents()
    loadDiary()
    loadReports()
    loadBeliefs()
    loadTemplates()
  },

  leave() {},
}
