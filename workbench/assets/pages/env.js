// 环境页：配置键矩阵。P1 先把 16 个顶层键按分组摆出来（只读），P2 才接编辑。
//
// `persona` 永远不出现：它只能是导入动作的副产物，不能给一个「从设置页直接改」的入口。
import { $, el, clear, card, fish, clock, errorText, hint, asText } from '../lib.js'

const GROUPS = [
  ['成长', ['growthDays', 'wakesPerDay', 'window', 'daily', 'diary', 'absenceAfterDays']],
  ['浏览', ['avoid', 'browse', 'video']],
  ['评论', ['comment']],
  ['通知', ['notify']],
  ['对话', ['chat']],
  ['记忆', ['memory']],
  ['工具与规则', ['tools']],
  ['数据与运维', ['observe']],
  ['界面偏好', ['ui']],
]

function build(root) {
  const head = card('配置', { note: '每个键只在一个页面可编辑；P1 只读展示，P2 接入保存（保存后重新拉 /config 回读）。' })
  head.body.append(el('div', { class: 'meta', id: 'env-msg', text: '读取中…' }))
  root.append(head.root)
  for (const [title, keys] of GROUPS) {
    const c = card(title)
    c.body.append(el('div', { class: 'kv' }, ...keys.map((key) => el('div', { class: 'kv-row', dataset: { key } },
      el('code', { class: 'key', text: key }),
      el('pre', { class: 'meta fish-raw val', text: '—' }),
    ))))
    root.append(c.root)
  }
}

async function refresh() {
  const msg = $('#env-msg')
  msg.textContent = '读取中…'
  const r = await fish('config')
  if (!r.ok) { msg.textContent = errorText(r); return }
  const cfg = r.data?.config || {}
  for (const dialog of document.querySelectorAll('.kv-row')) {
    const key = dialog.dataset.key
    const pre = dialog.querySelector('.val')
    // persona 永远不摆：即便上游给了也不读。
    pre.textContent = key === 'persona' ? '' : asText(cfg[key] ?? null)
  }
  const f = r.data?.file || {}
  msg.textContent = `更新于 ${clock()}${f.exists === false ? ' · 还没有配置文件，用的是默认值' : ''}`
}

let built = false
export const env = {
  id: 'env',
  label: '环境',
  enter(root) {
    if (!built) { build(root); built = true }
    refresh()
  },
  leave() {},
}
