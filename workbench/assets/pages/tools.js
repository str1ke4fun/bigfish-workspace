// 工具与规则：工具清单、规则分层、自检。工具白名单编辑在 P2。
import { $, el, clear, card, fish, clock, errorText, hint, asText } from '../lib.js'

function build(root) {
  const toolsCard = card('工具清单', { note: '/tools 只给名字不给定义；白名单编辑在 P2。' })
  toolsCard.body.append(
    el('div', { class: 'meta', id: 'tool-msg' }),
    el('div', { class: 'chips', id: 'tool-list' }),
    el('h3', { text: '当前工具白名单' }),
    el('pre', { class: 'meta fish-raw', id: 'tool-allow' }),
  )

  const rulesCard = card('规则分层', { note: '看规则在哪一层、有没有一张等她裁决的卡；没有「新建/编辑规则」。' })
  rulesCard.body.append(el('div', { id: 'rule-body' }))

  const checkCard = card('自检', { note: '自检会联网（?net=1）；只在点按钮时跑。' })
  checkCard.body.append(
    el('div', { class: 'row' },
      el('button', { id: 'check-run', class: 'primary', text: '跑一次自检', onclick: () => runCheck() }),
      el('span', { class: 'meta', id: 'check-msg' }),
    ),
    el('div', { id: 'check-body' }),
  )

  root.append(toolsCard.root, rulesCard.root, checkCard.root)
}

async function refresh() {
  const [tools, rules, config] = await Promise.all([fish('tools'), fish('rules'), fish('config')])
  const list = $('#tool-list')
  clear(list)
  if (tools.ok) {
    const known = tools.data?.known || []
    $('#tool-msg').textContent = `${known.length} 个工具 · 更新于 ${clock()}`
    for (const name of known) list.append(el('span', { class: 'chip', text: name }))
  } else {
    $('#tool-msg').textContent = `工具名读不到（按形状校验）：${errorText(tools)}`
  }

  const allow = config.ok ? config.data?.config?.tools?.allow : null
  $('#tool-allow').textContent = allow === undefined || allow === null
    ? '（没设白名单 = 全量工具面）'
    : asText(allow)

  const ruleBox = $('#rule-body')
  clear(ruleBox)
  if (!rules.ok) { ruleBox.append(hint(errorText(rules), 'bad')); return }
  const r = rules.data || {}
  ruleBox.append(
    el('div', { class: 'meta', text: `申请开关：${r.offersOn === false ? '关' : '开'}` }),
    r.pending
      ? el('div', { class: 'notice', text: `有一张待裁决的卡：${r.pending.rule || ''}${r.pending.why ? ' · ' + r.pending.why : ''}（裁决在 P2）` })
      : hint('现在没有待裁决的申请。', 'meta'),
  )
  const layers = r.layers
  ruleBox.append(el('h3', { text: '规则在哪一层' }))
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      const box = el('div', { class: 'rule-layer' },
        el('b', { text: layer.name || layer.layer || layer.id || '—' }),
        el('div', { class: 'meta', text: layer.note || layer.desc || '' }),
      )
      const rules = Array.isArray(layer.rules) ? layer.rules : []
      if (rules.length) {
        box.append(el('ul', { class: 'plain' }, ...rules.map((rule) => el('li', {},
          el('span', { class: 'x' },
            el('b', { text: rule.title || rule.id || '—' }),
            rule.text ? el('div', { class: 'meta', text: rule.text }) : null,
          ),
          el('span', { class: 'meta', text: rule.section || '不进提示词' }),
        ))))
      }
      ruleBox.append(box)
    }
  } else {
    ruleBox.append(el('pre', { class: 'meta fish-raw', text: asText(layers) }))
  }
  if (Array.isArray(r.history) && r.history.length) {
    ruleBox.append(el('h3', { text: '近来的裁决' }))
    ruleBox.append(el('ul', { class: 'plain' }, ...r.history.slice().reverse().map((h) => el('li', {},
      el('span', { class: 'x', text: asText(h) }),
    ))))
  }
}

async function runCheck() {
  const btn = $('#check-run')
  const msg = $('#check-msg')
  const box = $('#check-body')
  btn.disabled = true; btn.textContent = '跑…'
  msg.textContent = '自检要联网，可能慢一点…'
  clear(box)
  try {
    const r = await fish('selfcheck?net=1')
    if (!r.ok) { box.append(hint(errorText(r), 'bad')); msg.textContent = ''; return }
    const d = r.data || {}
    msg.textContent = `跑完了 · ${clock()}`
    box.append(el('div', { class: 'status-detail', text: d.summary || '' }))
    const items = d.items || []
    if (items.length) {
      box.append(el('ul', { class: 'plain' }, ...items.map((it) => el('li', { class: it.ok === false ? 'bad' : '' },
        el('span', { class: 'kind', text: it.ok === false ? '✗' : '✓' }),
        el('span', { class: 'x' },
          `${it.label || it.name || it.title || it.id || ''}${it.detail ? ' · ' + it.detail : ''}`,
          it.ok === false && it.fix ? el('div', { class: 'meta', text: `怎么修：${it.fix}` }) : null,
        ),
      ))))
    }
    box.append(el('details', {}, el('summary', { text: '原始返回' }), el('pre', { class: 'meta fish-raw', text: asText(d) })))
  } finally {
    btn.disabled = false; btn.textContent = '跑一次自检'
  }
}

let built = false
export const tools = {
  id: 'tools',
  label: '工具与规则',
  enter(root) {
    if (!built) { build(root); built = true }
    refresh()
  },
  leave() {},
}
