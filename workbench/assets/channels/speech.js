// 说话节奏：QQ 和微信共用一套闸，键是扁平的（没有 speech. 前缀）。
// 保存立刻生效：dsh-wx 和 QQ 的补丁每次调用都现读 policy。
import { el, clear, card, local, hint } from '../lib.js'

function chipText(row) {
  const who = String(row.chat || '')
    .replace(/^wx:/, '微信·')
    .replace(/^group:/, 'QQ群·')
    .replace(/^private:/, 'QQ·')
  const quiet = row.quietSeconds < 60 ? '刚刚' : `${Math.round(row.quietSeconds / 60)} 分钟前`
  return `${who || '—'}：一小时 ${row.lastHour ?? 0} 条 · ${quiet}`
}

/**
 * 说话节奏卡：总览里用，编辑是页面内展开区，不跳页。
 * @returns {{ root: HTMLElement, refresh: Function }}
 */
export function renderSpeechCard() {
  const c = card('说话节奏', { note: 'QQ 和微信共用；改完立刻生效。' })
  const fields = el('div', { class: 'group-body' })
  const enabled = el('input', { type: 'checkbox' })
  const gap = el('input', { type: 'number', min: '0', step: '1' })
  const perMin = el('input', { type: 'number', min: '1', step: '1' })
  const perHour = el('input', { type: 'number', min: '1', step: '1' })
  const wxGap = el('input', { type: 'number', min: '0', step: '1' })
  const wxPerMin = el('input', { type: 'number', min: '1', step: '1' })
  const wxPerHour = el('input', { type: 'number', min: '1', step: '1' })
  const msg = el('span', { class: 'meta' })
  const stats = el('div', { class: 'chips' })
  fields.append(
    el('label', { class: 'chk' }, enabled, el('span', { text: '限制说话频率' })),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '两条之间至少隔（秒）' }), gap),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '一分钟最多几条' }), perMin),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '一小时最多几条' }), perHour),
    el('div', { class: 'meta', text: '微信覆盖（QQ 仍用上面的值）' }),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '微信：两条之间至少隔（秒）' }), wxGap),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '微信：一分钟最多几条' }), wxPerMin),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '微信：一小时最多几条' }), wxPerHour),
  )
  const editor = el('details', { class: 'rule-layer' },
    el('summary', {}, el('b', { text: '编辑节奏' })),
    fields,
    el('div', { class: 'row' },
      el('button', { class: 'primary small', type: 'button', text: '保存', onclick: () => save() }),
      msg,
    ),
  )
  c.body.append(editor, stats)

  async function load() {
    const r = await local('/api/speech')
    if (!r.ok) { c.setMeta('读不到', 'bad'); return }
    const p = r.data?.policy || {}
    enabled.checked = p.enabled === true
    gap.value = p.minGapSeconds ?? 0
    perMin.value = p.maxPerMinute ?? 0
    perHour.value = p.maxPerHour ?? 0
    wxGap.value = p.wx?.minGapSeconds ?? 8
    wxPerMin.value = p.wx?.maxPerMinute ?? 4
    wxPerHour.value = p.wx?.maxPerHour ?? 40
    c.setMeta(p.enabled
      ? `开 · 间隔 ${p.minGapSeconds}s · ${p.maxPerMinute}/分 · ${p.maxPerHour}/时 · 微信 ${p.wx?.minGapSeconds ?? 8}s / ${p.wx?.maxPerMinute ?? 4} / ${p.wx?.maxPerHour ?? 40}`
      : '不限', p.enabled ? 'ok' : '')
    clear(stats)
    const rows = r.data?.stats || []
    if (!rows.length) stats.append(hint('最近一小时她还没说话'))
    for (const row of rows) stats.append(el('span', { class: 'chip', text: chipText(row) }))
  }

  async function save() {
    msg.textContent = '保存中…'
    const r = await local('/api/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: enabled.checked,
        minGapSeconds: Number(gap.value),
        maxPerMinute: Number(perMin.value),
        maxPerHour: Number(perHour.value),
        wx: {
          minGapSeconds: Number(wxGap.value),
          maxPerMinute: Number(wxPerMin.value),
          maxPerHour: Number(wxPerHour.value),
        },
      }),
    })
    const p = r.data?.policy || {}
    if (!r.ok) { msg.textContent = `没存上：${r.data?.err || r.error || '接口没回话'}`; return }
    msg.textContent = p.enabled
      ? `已保存：间隔 ${p.minGapSeconds} 秒 · 一分钟最多 ${p.maxPerMinute} 条 · 一小时最多 ${p.maxPerHour} 条`
      : '已保存：不限'
    await load()
  }

  load()
  return { root: c.root, refresh: load }
}
