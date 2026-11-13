// 她 · 成长：阶段、数字、判断、张力、疤与拒绝、规则摘要。全部只读。
// 这里没有数值滑杆，不提供调人格的入口——看得到成长，调不了性格。
import { el, clear, card, fish, fmtTime, errorText, emptyState } from '../lib.js'

const SPEC = {}

function build(root) {
  SPEC.notice = el('div', { class: 'meta card-note', text: '这里没有数值滑杆，不提供调人格的入口。' })

  SPEC.stage = card('阶段')
  SPEC.stageBody = el('div')
  SPEC.stage.body.append(SPEC.stageBody)

  SPEC.numbers = card('数字')
  SPEC.numbersBody = el('dl', { class: 'fish-stats' })
  SPEC.numbers.body.append(SPEC.numbersBody)

  SPEC.beliefs = card('她还在拿着的判断', { note: '最近 8 条；全文在记忆页。' })
  SPEC.beliefsBody = el('div')
  SPEC.beliefs.body.append(
    SPEC.beliefsBody,
    el('div', { class: 'row' },
      el('a', { class: 'btn small', href: '#her/memory', text: '去看判断全文 →' }),
    ),
  )

  SPEC.tension = card('张力', { note: '哪句对她，得她自己定。' })
  SPEC.tensionBody = el('div')
  SPEC.tension.body.append(SPEC.tensionBody)

  SPEC.scars = card('疤与拒绝', { note: '只报数量与记录，不评价对错。' })
  SPEC.scarsBody = el('div')
  SPEC.scars.body.append(SPEC.scarsBody)

  SPEC.rules = card('规则')
  SPEC.rulesBody = el('div')
  SPEC.rules.body.append(
    SPEC.rulesBody,
    el('div', { class: 'row' },
      el('a', { class: 'btn small', href: '#system/tools', text: '去工具与规则 →' }),
    ),
  )

  root.append(SPEC.notice, SPEC.stage.root, SPEC.numbers.root, SPEC.beliefs.root,
    SPEC.tension.root, SPEC.scars.root, SPEC.rules.root)
}

// ---------- 渲染 ----------

function renderStage(r) {
  clear(SPEC.stageBody)
  if (!r.ok) { SPEC.stageBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const s = r.data || {}
  SPEC.stageBody.append(
    el('div', { class: 'hero-state' }, el('b', { text: s.stageName || `阶段 ${s.stage ?? '—'}` })),
    el('div', { class: 'meta', text: `第 ${s.day ?? '—'} 天 · 成长天数 ${s.growthDays ?? '—'}` }),
    el('div', { class: 'meta', text: s.pendingGate ? `下一个瓶颈：${s.pendingGate}` : '下一个瓶颈：还没到' }),
    s.stageForced ? el('div', { class: 'meta', text: '阶段是被强制推进的。' }) : null,
  )
}

function renderNumbers(r) {
  clear(SPEC.numbersBody)
  if (!r.ok) { SPEC.numbersBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const s = r.data || {}
  const stance = !s.stanceReady
    ? '还没走到那一步'
    : (s.stanceCount > 0 ? `已站住 ${s.stanceCount} 条` : '走到了，还没站住')
  const rows = [
    ['判断', s.beliefCount ?? '—'],
    ['张力', s.tension?.count ?? 0],
    ['固化', s.solidCount ?? 0],
    ['疤', s.scarCount ?? 0],
    ['立场', s.stanceCount ?? 0],
    ['立场就绪', stance],
  ]
  for (const [k, v] of rows) SPEC.numbersBody.append(el('div', {}, el('dt', { text: k }), el('dd', { text: String(v) })))
}

function renderBeliefs(r) {
  clear(SPEC.beliefsBody)
  if (!r.ok) { SPEC.beliefsBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const active = r.data?.active || []
  if (!active.length) { SPEC.beliefsBody.append(emptyState('还没有长出来的判断')); return }
  const list = el('ul', { class: 'plain' })
  for (const b of active.slice(-8).reverse()) {
    list.append(el('li', {}, el('span', { class: 'x', text: b.text }), el('span', { class: 't', text: fmtTime(b.since) })))
  }
  SPEC.beliefsBody.append(list)
}

function renderTension(r) {
  clear(SPEC.tensionBody)
  if (!r.ok) { SPEC.tensionBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const t = r.data?.tension
  if (!t || !t.count) { SPEC.tensionBody.append(emptyState('现在没有对不上的地方。')); return }
  SPEC.tensionBody.append(
    el('div', { class: 'meta', text: `有 ${t.count} 处对不上` }),
    el('div', { class: 'quote', text: t.a }),
    el('div', { class: 'quote', text: t.b }),
  )
}

function renderScars(stateResult, beliefsResult) {
  clear(SPEC.scarsBody)
  if (!stateResult.ok) { SPEC.scarsBody.append(el('div', { class: 'bad', text: errorText(stateResult) })); return }
  const s = stateResult.data || {}
  SPEC.scarsBody.append(el('div', { text: `疤：${s.scarCount ?? 0} 处` }))
  if (!beliefsResult.ok) { SPEC.scarsBody.append(el('div', { class: 'bad', text: errorText(beliefsResult) })); return }
  const refusals = beliefsResult.data?.refusals || []
  if (!refusals.length) { SPEC.scarsBody.append(emptyState('还没有拒绝记录。')); return }
  SPEC.scarsBody.append(el('div', { class: 'meta', text: `拒绝记录 ${refusals.length} 条` }))
  const list = el('ul', { class: 'plain' })
  for (const x of refusals.slice(-5).reverse()) {
    list.append(el('li', {}, el('span', { class: 'x', text: typeof x === 'string' ? x : (x.text || JSON.stringify(x)) })))
  }
  SPEC.scarsBody.append(list)
}

function renderRules(r) {
  clear(SPEC.rulesBody)
  if (!r.ok) { SPEC.rulesBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const d = r.data || {}
  const layers = d.layers || []
  const active = (d.status || []).filter((s) => s.active).length
  const ready = (d.status || []).filter((s) => s.ready && !s.active).length
  SPEC.rulesBody.append(
    el('div', { text: `规则分 ${layers.length} 层 · 已开放 ${active} 条 · 够格待开放 ${ready} 条` }),
    el('div', { class: 'meta', text: d.pending ? `她提了一张申请：${d.pending.rule}` : '现在没有待裁决的申请' }),
    el('div', { class: 'meta', text: d.offersOn === false ? '申请入口关着。' : '申请入口开着。' }),
  )
}

// ---------- 读取 ----------

async function load() {
  const [state, beliefs, rules] = await Promise.all([fish('state'), fish('beliefs'), fish('rules')])
  renderStage(state)
  renderNumbers(state)
  renderBeliefs(beliefs)
  renderTension(state)
  renderScars(state, beliefs)
  renderRules(rules)
}

// ---------- 页面契约 ----------

export const herGrowth = {
  id: 'her-growth',
  nav: 'her',
  slug: 'growth',
  label: '成长',
  order: 30,

  enter(root) {
    if (!SPEC.built) { build(root); SPEC.built = true }
    load()
  },

  leave() {},
}
