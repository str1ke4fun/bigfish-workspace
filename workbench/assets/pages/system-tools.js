// 系统 · 工具与规则：工具清单、白名单编辑、规则分层、自检。
// 白名单保存后要重启 DSH 才生效；自检只在点按钮时联网。
import {
  el, clear, card, fish, postFish, clock, errorText, writeError, hint, asText,
} from '../lib.js'

const SPEC = { known: [] }

function build(root) {
  SPEC.tools = card('工具清单', { note: '/tools 只给名字不给定义；白名单保存后重启 DSH 后生效。' })
  SPEC.toolMsg = el('div', { class: 'meta' })
  SPEC.toolList = el('div', { class: 'chips' })
  SPEC.restrict = el('input', { type: 'checkbox' })
  SPEC.allow = el('textarea', { class: 'doc', rows: '4', placeholder: '每行一个工具名；空 = 不放行额外工具' })
  SPEC.saveMsg = el('span', { class: 'meta' })
  SPEC.saveBtn = el('button', { class: 'primary', type: 'button', text: '保存白名单', onclick: () => saveTools() })
  SPEC.tools.body.append(
    SPEC.toolMsg,
    SPEC.toolList,
    el('h3', { text: '当前工具白名单' }),
    el('label', { class: 'chk' }, SPEC.restrict, el('span', { text: '收窄工具面（只给她自己的工具 + 下面放行的）' })),
    SPEC.allow,
    el('div', { class: 'row' }, SPEC.saveBtn, SPEC.saveMsg),
  )

  SPEC.rules = card('规则分层', { note: '看规则在哪一层、有没有一张等她裁决的卡；没有「新建/编辑规则」。' })
  SPEC.ruleBody = el('div')
  SPEC.rules.body.append(SPEC.ruleBody)

  SPEC.check = card('自检', { note: '自检会联网（?net=1）；只在点按钮时跑。' })
  SPEC.checkBtn = el('button', { class: 'primary', type: 'button', text: '跑一次自检', onclick: () => runCheck() })
  SPEC.checkMsg = el('span', { class: 'meta' })
  SPEC.checkBody = el('div')
  SPEC.check.body.append(el('div', { class: 'row' }, SPEC.checkBtn, SPEC.checkMsg), SPEC.checkBody)

  root.append(SPEC.tools.root, SPEC.rules.root, SPEC.check.root)
}

async function refresh() {
  const [tools, rules, config] = await Promise.all([fish('tools'), fish('rules'), fish('config')])
  // 白名单整组读写：配置里的 tools.restrict / tools.allow。
  const toolsCfg = config.ok ? config.data?.config?.tools : null

  clear(SPEC.toolList)
  if (tools.ok) {
    const known = tools.data?.known || []
    SPEC.known = known
    SPEC.toolMsg.textContent = `${known.length} 个工具 · 更新于 ${clock()}`
    for (const name of known) {
      SPEC.toolList.append(el('button', {
        class: 'chip',
        type: 'button',
        text: name,
        title: '点一下加入白名单',
        onclick: () => {
          const cur = SPEC.allow.value.split(/\s+/).filter(Boolean)
          if (!cur.includes(name)) SPEC.allow.value = [...cur, name].join('\n')
        },
      }))
    }
  } else {
    SPEC.known = []
    SPEC.toolMsg.textContent = `工具名读不到（按形状校验）：${errorText(tools)}`
  }
  SPEC.restrict.checked = toolsCfg ? toolsCfg.restrict !== false : true
  SPEC.allow.value = Array.isArray(toolsCfg?.allow) ? toolsCfg.allow.join('\n') : ''

  clear(SPEC.ruleBody)
  if (!rules.ok) { SPEC.ruleBody.append(hint(errorText(rules), 'bad')); return }
  const r = rules.data || {}
  SPEC.ruleBody.append(
    el('div', { class: 'meta', text: `申请开关：${r.offersOn === false ? '关' : '开'}` }),
    r.pending
      ? el('div', { class: 'notice', text: `有一张待裁决的卡：${r.pending.rule || ''}${r.pending.why ? ' · ' + r.pending.why : ''}` },
        ' ',
        el('a', { href: '#her/today', text: '去 她 · 今天 批准或驳回' }))
      : hint('现在没有待裁决的申请。', 'meta'),
  )
  SPEC.ruleBody.append(el('h3', { text: '规则在哪一层' }))
  const layers = r.layers
  if (Array.isArray(layers)) {
    for (const layer of layers) {
      const box = el('div', { class: 'rule-layer' },
        el('b', { text: layer.name || layer.layer || layer.id || '—' }),
        el('div', { class: 'meta', text: layer.note || layer.desc || '' }),
      )
      const rows = Array.isArray(layer.rules) ? layer.rules : []
      if (rows.length) {
        box.append(el('ul', { class: 'plain' }, ...rows.map((rule) => el('li', {},
          el('span', { class: 'x' },
            el('b', { text: rule.title || rule.id || '—' }),
            rule.text ? el('div', { class: 'meta', text: rule.text }) : null,
          ),
          el('span', { class: 'meta', text: rule.section || '不进提示词' }),
        ))))
      }
      SPEC.ruleBody.append(box)
    }
  } else {
    SPEC.ruleBody.append(el('pre', { class: 'meta fish-raw', text: asText(layers) }))
  }
  if (Array.isArray(r.history) && r.history.length) {
    SPEC.ruleBody.append(el('h3', { text: '近来的裁决' }))
    SPEC.ruleBody.append(el('ul', { class: 'plain' }, ...r.history.slice().reverse().map((h) => el('li', {},
      el('span', { class: 'x', text: asText(h) }),
    ))))
  }
}

async function saveTools() {
  const names = SPEC.allow.value.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean)
  if (SPEC.known.length) {
    const unknown = names.filter((x) => !SPEC.known.includes(x))
    if (unknown.length) { SPEC.saveMsg.textContent = `这些名字不存在，没保存：${unknown.join('、')}`; return }
  }
  SPEC.saveBtn.disabled = true
  SPEC.saveMsg.textContent = '保存中…'
  try {
    const r = await postFish('config', { tools: { restrict: SPEC.restrict.checked, allow: names } })
    if (!r.ok) { SPEC.saveMsg.textContent = writeError(r); return }
    if (r.data?.ok === false) { SPEC.saveMsg.textContent = `没存上：${r.data.error || '上游拒绝'}`; return }
    await refresh()
    SPEC.saveMsg.textContent = `已保存 · 重启 DSH 后生效 · ${clock()}`
  } finally {
    SPEC.saveBtn.disabled = false
  }
}

async function runCheck() {
  SPEC.checkBtn.disabled = true
  SPEC.checkBtn.textContent = '跑…'
  SPEC.checkMsg.textContent = '自检要联网，可能慢一点…'
  clear(SPEC.checkBody)
  try {
    const r = await fish('selfcheck?net=1')
    if (!r.ok) { SPEC.checkBody.append(hint(errorText(r), 'bad')); SPEC.checkMsg.textContent = ''; return }
    const d = r.data || {}
    SPEC.checkMsg.textContent = `跑完了 · ${clock()}`
    SPEC.checkBody.append(el('div', { class: 'status-detail', text: d.summary || '' }))
    const items = d.items || []
    if (items.length) {
      SPEC.checkBody.append(el('ul', { class: 'plain' }, ...items.map((it) => el('li', { class: it.ok === false ? 'bad' : '' },
        el('span', { class: 'kind', text: it.ok === false ? '✗' : '✓' }),
        el('span', { class: 'x' },
          `${it.label || it.name || it.title || it.id || ''}${it.detail ? ' · ' + it.detail : ''}`,
          it.ok === false && it.fix ? el('div', { class: 'meta', text: `怎么修：${it.fix}` }) : null,
        ),
      ))))
    }
    SPEC.checkBody.append(el('details', {}, el('summary', { text: '原始返回' }), el('pre', { class: 'meta fish-raw', text: asText(d) })))
  } finally {
    SPEC.checkBtn.disabled = false
    SPEC.checkBtn.textContent = '跑一次自检'
  }
}

export const systemTools = {
  id: 'system-tools',
  nav: 'system',
  slug: 'tools',
  label: '工具与规则',
  order: 20,

  enter(root) {
    if (!SPEC.built) { build(root); SPEC.built = true }
    refresh()
  },

  leave() {},
}
