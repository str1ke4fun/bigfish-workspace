// 记忆页：事件列表、日记、日报、判断全文、模板。全部只读。
// 事件只做类型/数量筛选，不承诺全文检索。
import { $, el, clear, card, fish, fmtTime, clock, errorText, hint, asText } from '../lib.js'

const TYPES = ['', 'meta', 'utterance', 'revise', 'refusal', 'reunion', 'narration', 'saw']

function build(root) {
  const eventsCard = card('事件列表', { note: '/events?type=&limit=；只做类型和数量筛选。' })
  eventsCard.body.append(
    el('div', { class: 'row' },
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '类型' }),
        el('select', { id: 'mem-type' }, ...TYPES.map((t) => el('option', { value: t, text: t || '全部' })))),
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '条数' }),
        el('select', { id: 'mem-limit' },
          ...[50, 100, 200, 500].map((n) => el('option', { value: String(n), text: String(n) })))),
      el('button', { id: 'mem-load', class: 'primary', text: '读取', onclick: () => loadEvents() }),
      el('span', { class: 'meta', id: 'mem-msg' }),
    ),
    el('ul', { class: 'plain', id: 'mem-events' }),
  )

  const diaryCard = card('日记', { note: '/diary?day=；设置为不可见时只给日期目录，不给正文。' })
  diaryCard.body.append(el('div', { class: 'row' }, el('span', { id: 'mem-diary-pick' })), el('div', { id: 'mem-diary' }))

  const reportsCard = card('日报', { note: '预览与落盘走同一个 buildReport；工作台只做只读预览，不提供导出。' })
  reportsCard.body.append(el('div', { class: 'row' }, el('span', { id: 'mem-report-pick' })), el('pre', { class: 'doc', id: 'mem-report' }))

  const beliefsCard = card('判断全文', { note: '判断、被推翻的、拒绝记录、自我修改尝试——原样列出，不做裁决。' })
  beliefsCard.body.append(el('div', { id: 'mem-beliefs' }))

  const templatesCard = card('处境模板', { note: '哪些处境已经来过、来过几次。' })
  templatesCard.body.append(el('div', { id: 'mem-templates' }))

  root.append(eventsCard.root, diaryCard.root, reportsCard.root, beliefsCard.root, templatesCard.root)

  $('#mem-type').addEventListener('change', () => loadEvents())
  $('#mem-limit').addEventListener('change', () => loadEvents())
}

async function loadEvents() {
  const box = $('#mem-events')
  clear(box)
  box.append(el('li', { class: 'meta', text: '读取中…' }))
  const type = $('#mem-type').value
  const limit = $('#mem-limit').value
  const qs = new URLSearchParams({ limit })
  if (type) qs.set('type', type)
  const r = await fish('events?' + qs.toString())
  clear(box)
  if (!r.ok) { box.append(el('li', { class: 'bad', text: errorText(r) })); $('#mem-msg').textContent = ''; return }
  const rows = r.data?.rows || []
  const total = r.data?.total ?? rows.length
  // /events 的 total 是全部事件数，rows 才是筛选后的；分开说，别让「共 N 条」对不上列表。
  $('#mem-msg').textContent = (type ? `筛选下 ${rows.length} 条 · 全部 ${total} 条` : `共 ${total} 条`) + ` · ${clock()}`
  if (!rows.length) { box.append(el('li', { class: 'meta', text: '这个筛选下没有事件' })); return }
  for (const e of rows) {
    box.append(el('li', {},
      el('span', { class: 't', text: fmtTime(e.ts) }),
      el('span', { class: 'kind', text: e.type || '—' }),
      el('span', { class: 'x', text: String(e.text || '') }),
    ))
  }
}

function pick(opts, onPick) {
  return el('select', { onchange: (e) => onPick(e.target.value) }, ...opts.map(([v, label]) => el('option', { value: v, text: label })))
}

async function loadDiary() {
  const box = $('#mem-diary')
  const picker = $('#mem-diary-pick')
  clear(box); clear(picker)
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
    box.append(el('div', { class: 'meta', text: item.date }), el('pre', { class: 'doc', text: item.text || '' }))
  }
  const dates = d.dates || []
  if (dates.length) {
    picker.append(el('span', { class: 'meta', text: '看别的天：' }),
      pick(dates.map((x) => [x, x]), async (day) => {
        if (!day) return
        const rr = await fish('diary?day=' + encodeURIComponent(day))
        clear(box)
        if (!rr.ok) { box.append(hint(errorText(rr), 'bad')); return }
        box.append(el('div', { class: 'meta', text: rr.data?.date || day }), el('pre', { class: 'doc', text: rr.data?.text || '' }))
      }))
  }
}

async function loadReports() {
  const box = $('#mem-report')
  const picker = $('#mem-report-pick')
  clear(picker)
  box.textContent = '读取中…'
  const r = await fish('reports')
  if (!r.ok) { box.textContent = errorText(r); return }
  const dates = r.data?.dates || []
  if (!dates.length) { box.textContent = '还没有日报。'; return }
  box.textContent = '选一天读报。'
  picker.append(el('span', { class: 'meta', text: '日报：' }),
    pick(dates.map((x) => [x, x]), async (date) => {
      if (!date) return
      box.textContent = '读取中…'
      const rr = await fish('reports?date=' + encodeURIComponent(date))
      box.textContent = rr.ok ? (rr.data?.md || '这天没有内容') : errorText(rr)
    }))
}

async function loadBeliefs() {
  const box = $('#mem-beliefs')
  clear(box)
  const r = await fish('beliefs')
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const b = r.data || {}
  const section = (title, rows, render) => {
    const list = Array.isArray(rows) ? rows : []
    box.append(el('h3', { text: `${title}（${list.length}）` }))
    if (!list.length) { box.append(hint('还没有。', 'meta')); return }
    box.append(el('ul', { class: 'plain' }, ...list.map(render)))
  }
  section('还在拿着的判断', b.active, (x) => el('li', {},
    el('span', { class: 'x', text: x.text || '' }),
    el('span', { class: 't', text: fmtTime(x.since) }),
  ))
  section('被推翻的', b.refuted, (x) => el('li', {},
    el('span', { class: 'x', text: asText(x) }),
  ))
  section('拒绝记录', b.refusals, (x) => el('li', {},
    el('span', { class: 'x', text: asText(x) }),
  ))
  section('自我修改尝试', b.selfmod, (x) => el('li', {},
    el('span', { class: 'x', text: asText(x) }),
  ))
}

async function loadTemplates() {
  const box = $('#mem-templates')
  clear(box)
  const r = await fish('templates')
  if (!r.ok) { box.append(hint(errorText(r), 'bad')); return }
  const rows = r.data?.rows || []
  if (!rows.length) { box.append(hint('还没有处境模板。', 'meta')); return }
  box.append(el('table', { class: 'table' },
    el('thead', {}, el('tr', {}, ...['id', '阶段', '问什么', '一次性', '来过', '次数', '最近'].map((h) => el('th', { text: h })))),
    el('tbody', {}, ...rows.map((t) => el('tr', {},
      el('td', { text: t.id }), el('td', { text: String(t.stage ?? '') }), el('td', { text: t.asks || '' }),
      el('td', { text: t.once ? '是' : (t.everyDays ? `每 ${t.everyDays} 天` : '') }),
      el('td', { text: t.fired ? '来过' : '—' }), el('td', { text: String(t.count ?? 0) }), el('td', { text: fmtTime(t.lastAt) }),
    ))),
  ))
}

let built = false
export const memory = {
  id: 'memory',
  label: '记忆',
  enter(root) {
    if (!built) { build(root); built = true }
    loadEvents(); loadDiary(); loadReports(); loadBeliefs(); loadTemplates()
  },
  leave() {},
}
