// 系统 · 日志：她的时间线 / 人工动作 / 工具台账 / 运行日志。
// 时间线是记忆，不是运行日志；运行日志只用于排障。全部只读（清空要二次确认）。
import {
  el, clear, card, fish, postFish, local, fmtTime, clock,
  errorText, writeError, hint, segment, humanChip,
} from '../lib.js'

const SECTIONS = [
  { id: 'timeline', label: '她的时间线' },
  { id: 'actions', label: '人工动作' },
  { id: 'ledger', label: '工具台账' },
  { id: 'runtime', label: '运行日志' },
]

const TYPES = ['', 'meta', 'utterance', 'revise', 'refusal', 'reunion', 'narration', 'saw']

const SPEC = { section: 'timeline' }

function build(root) {
  SPEC.switch = segment(SECTIONS, { value: SPEC.section, label: '日志分段', onChange: (id) => show(id) })

  // ---- 她的时间线 ----
  SPEC.timeline = card('她的时间线', { note: '只读；筛选只按类型和条数，不做全文检索。' })
  SPEC.typePick = el('select', {},
    ...TYPES.map((t) => el('option', { value: t, text: t || '全部' })))
  SPEC.limitPick = el('select', {},
    ...[50, 100, 200, 500].map((n) => el('option', { value: String(n), text: String(n) })))
  SPEC.timelineMsg = el('span', { class: 'meta' })
  SPEC.timelineList = el('ul', { class: 'plain' })
  SPEC.timeline.body.append(
    el('div', { class: 'row' },
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '类型' }), SPEC.typePick),
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '条数' }), SPEC.limitPick),
      el('button', { class: 'primary small', type: 'button', text: '读取', onclick: () => loadTimeline() }),
      SPEC.timelineMsg,
    ),
    SPEC.timelineList,
  )

  // ---- 人工动作 ----
  SPEC.actions = card('人工动作', { note: '工作台自己的动作日志；人工代操作带「人工」标记。' })
  SPEC.actionsMsg = el('span', { class: 'meta' })
  SPEC.actionsList = el('ul', { class: 'plain' })
  SPEC.actions.body.append(
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '刷新', onclick: () => loadActions() }),
      SPEC.actionsMsg,
    ),
    SPEC.actionsList,
  )

  // ---- 工具台账 ----
  SPEC.ledger = card('工具台账', { note: '按日期 / 工具名筛选；每条可展开原始返回。' })
  SPEC.ledgerDate = el('input', { type: 'date' })
  SPEC.ledgerTool = el('input', { type: 'text', placeholder: '工具名（可留空）' })
  SPEC.ledgerMsg = el('span', { class: 'meta' })
  SPEC.ledgerList = el('div')
  SPEC.ledger.body.append(
    el('div', { class: 'row' },
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '日期' }), SPEC.ledgerDate),
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '工具' }), SPEC.ledgerTool),
      el('button', { class: 'small', type: 'button', text: '读取', onclick: () => loadLedger() }),
      SPEC.ledgerMsg,
    ),
    SPEC.ledgerList,
  )

  // ---- 运行日志 ----
  SPEC.runtime = card('运行日志', { note: '插件自己的运行日志；只用于排障，不是她的记忆。' })
  SPEC.linesPick = el('select', {},
    ...[100, 200, 500].map((n) => el('option', { value: String(n), text: `最近 ${n} 行` })))
  SPEC.runtimeMsg = el('span', { class: 'meta' })
  SPEC.runtimeBox = el('pre', { class: 'logbox' })
  SPEC.runtime.body.append(
    el('div', { class: 'row' },
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '行数' }), SPEC.linesPick),
      el('button', { class: 'small', type: 'button', text: '读取', onclick: () => loadRuntime() }),
      el('a', { class: 'btn small', href: '/api/fish/log/export', download: '', text: '导出日志' }),
      el('button', { class: 'small danger', type: 'button', text: '清空运行日志', onclick: () => clearRuntime() }),
      SPEC.runtimeMsg,
    ),
    SPEC.runtimeBox,
  )

  SPEC.sections = {
    timeline: SPEC.timeline.root,
    actions: SPEC.actions.root,
    ledger: SPEC.ledger.root,
    runtime: SPEC.runtime.root,
  }
  root.append(
    el('div', { class: 'meta card-note', text: '她的时间线是记忆，不是运行日志；运行日志只用于排障。' }),
    SPEC.switch.root,
    ...Object.values(SPEC.sections),
  )
  show(SPEC.section)
}

function show(id) {
  SPEC.section = id
  for (const [key, node] of Object.entries(SPEC.sections)) node.hidden = key !== id
  SPEC.switch.set(id)
  if (id === 'timeline') loadTimeline()
  else if (id === 'actions') loadActions()
  else if (id === 'ledger') loadLedger()
  else if (id === 'runtime') loadRuntime()
}

async function loadTimeline() {
  const box = SPEC.timelineList
  clear(box)
  box.append(el('li', { class: 'meta', text: '读取中…' }))
  const type = SPEC.typePick.value
  const limit = SPEC.limitPick.value
  const qs = new URLSearchParams({ limit })
  if (type) qs.set('type', type)
  const r = await fish('events?' + qs.toString())
  clear(box)
  if (!r.ok) { box.append(el('li', { class: 'bad', text: errorText(r) })); SPEC.timelineMsg.textContent = ''; return }
  const rows = r.data?.rows || []
  const total = r.data?.total ?? rows.length
  SPEC.timelineMsg.textContent = (type ? `筛选下 ${rows.length} 条 · 全部 ${total} 条` : `共 ${total} 条`) + ` · ${clock()}`
  if (!rows.length) { box.append(el('li', { class: 'meta', text: '这个筛选下没有事件' })); return }
  for (const e of rows) {
    box.append(el('li', {},
      el('span', { class: 't', text: fmtTime(e.ts) }),
      el('span', { class: 'kind', text: e.type || '—' }),
      el('span', { class: 'x', text: String(e.text || '') }),
    ))
  }
}

async function loadActions() {
  const r = await local('/api/status.log')
  clear(SPEC.actionsList)
  if (!r.ok) { SPEC.actionsList.append(el('li', { class: 'bad', text: errorText(r) })); return }
  const rows = r.data?.rows || []
  SPEC.actionsMsg.textContent = `${rows.length} 条 · ${clock()}`
  if (!rows.length) { SPEC.actionsList.append(el('li', { class: 'meta', text: '还没有动作' })); return }
  for (const row of rows) {
    const li = el('li', { class: row.ok ? '' : 'fail' },
      el('span', { class: 't', text: row.at }),
      el('span', { class: 'kind', text: row.who }),
      el('span', { class: 'x', text: row.text }),
    )
    if (row.operator === 'human') li.append(humanChip())
    SPEC.actionsList.append(li)
  }
}

async function loadLedger() {
  clear(SPEC.ledgerList)
  SPEC.ledgerList.append(hint('读取中…'))
  const qs = new URLSearchParams({ limit: '100' })
  if (SPEC.ledgerDate.value) qs.set('date', SPEC.ledgerDate.value)
  if (SPEC.ledgerTool.value.trim()) qs.set('tool', SPEC.ledgerTool.value.trim())
  const r = await fish('ledger?' + qs.toString())
  clear(SPEC.ledgerList)
  if (!r.ok) { SPEC.ledgerList.append(hint(errorText(r), 'bad')); return }
  const d = r.data || {}
  if (d.ok === false) {
    SPEC.ledgerList.append(hint(`台账读不到：${d.code || d.why || '上游没挂台账'}`, 'bad'))
    SPEC.ledgerMsg.textContent = ''
    return
  }
  const rows = d.rows || []
  SPEC.ledgerMsg.textContent = `${rows.length} 条 · ${clock()}`
  if (!rows.length) { SPEC.ledgerList.append(hint('这一天没有台账')); return }
  for (const row of rows) {
    SPEC.ledgerList.append(el('details', { class: 'rule-layer' },
      el('summary', { text: `${fmtTime(row.ts)} · ${row.tool || '—'} · ${row.ok === false ? '✗' : '✓'}` }),
      el('pre', { class: 'fish-raw', text: JSON.stringify(row, null, 2) }),
    ))
  }
}

async function loadRuntime() {
  const lines = SPEC.linesPick.value
  SPEC.runtimeMsg.textContent = '读取中…'
  const r = await fish('log?lines=' + encodeURIComponent(lines))
  if (!r.ok) { SPEC.runtimeBox.textContent = errorText(r); SPEC.runtimeMsg.textContent = ''; return }
  const d = r.data || {}
  SPEC.runtimeBox.textContent = d.exists === false
    ? '还没有运行日志。'
    : (d.lines || []).join('\n')
  SPEC.runtimeMsg.textContent = `更新于 ${clock()}${d.bytes ? ' · ' + Math.round(d.bytes / 1024) + ' KB' : ''}`
}

async function clearRuntime() {
  if (!confirm('清空运行日志？导出过的文件不受影响。')) return
  const r = await postFish('log/clear', {})
  if (!r.ok) { SPEC.runtimeMsg.textContent = writeError(r); return }
  if (r.data?.ok === false) { SPEC.runtimeMsg.textContent = `没清成：${r.data.why || r.data.error || '上游拒绝'}`; return }
  const text = r.data?.cleared === false ? '日志本来就没有内容。' : '日志清空了。'
  await loadRuntime()
  SPEC.runtimeMsg.textContent = text
}

export const systemLogs = {
  id: 'system-logs',
  nav: 'system',
  slug: 'logs',
  label: '日志',
  order: 30,

  enter(root) {
    if (!SPEC.built) { build(root); SPEC.built = true }
    show(SPEC.section)
  },

  leave() {},
}
