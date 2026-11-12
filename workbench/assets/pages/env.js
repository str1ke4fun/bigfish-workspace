// 环境页：配置键矩阵（除 tools / observe / ui，它们各自在唯一页面编辑）。
//
// `persona` 永远不出现：它只能是导入动作的副产物，不能给一个「从设置页直接改」的入口。
// 保存只发当前这一张卡的顶层键，服务端白名单整次拒绝；存完重新 GET /config 回读。
import { $, el, clear, card, fish, postFish, clock, errorText, writeError, hint } from '../lib.js'

const GROUPS = [
  ['成长', ['growthDays', 'wakesPerDay', 'window', 'daily', 'diary', 'absenceAfterDays']],
  ['浏览', ['avoid', 'browse', 'video']],
  ['评论', ['comment']],
  ['通知', ['notify']],
  ['对话', ['chat']],
  ['记忆', ['memory']],
]

const LABELS = {
  growthDays: '成长天数',
  wakesPerDay: '每天醒几次',
  window: '醒来时段',
  'daily.events': '每天成长事件',
  'daily.questions': '每天问题',
  'diary.enabled': '写日记',
  'diary.visible': '日记可见',
  'diary.keepDays': '日记保留天数',
  absenceAfterDays: '缺席判定天数',
  'avoid.keywords': '避让词（逗号分隔）',
  'avoid.upMids': '避让 UP mid（逗号分隔）',
  'avoid.minDuration': '最短时长（秒）',
  'browse.enabled': '刷站开关',
  'browse.perDay': '每天刷几次',
  'browse.topN': '每次看几条',
  'browse.rankingTids': '轮换分区数',
  'browse.deepRead': '深读评论条数',
  'browse.danmaku': '弹幕条数',
  'browse.keywords': '额外搜索词（逗号分隔）',
  'browse.window': '刷站时段',
  'browse.voices': '读评论区',
  'video.enabled': '看画面',
  'video.perDay': '每天几条视频',
  'video.frames': '每条抽几帧',
  'video.ocr': '认画面里的字',
  'comment.enabled': '评论开关',
  'comment.perDay': '每天评论几条',
  'comment.replyPerDay': '每天回复几条',
  'comment.replyToReplies': '允许回回复',
  'comment.scanEveryMin': '扫描间隔（分钟）',
  'comment.window': '评论时段',
  'comment.atOwner': '@ 领养人',
  'notify.enabled': '桌面提醒',
  'chat.rotateAfter': '多少轮换会话',
  'chat.replyChars': '单轮字数上限',
  'memory.docBudget': '身份文档预算',
  'memory.beliefsShown': '一轮摆几条判断',
  'memory.sleepEveryDays': '几天想一次',
  'memory.sleepKeep': '留几条自述',
}

// 这些是运行期内部状态，不摆在编辑表单里，也不回写。
const HIDDEN = new Set(['lastShown', 'lastScanAt'])

const state = { root: null }

function label(path) {
  return LABELS[path] || path
}

function parseList(text, sample) {
  const parts = String(text || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  // 空数组合法（默认 keywords / upMids 都是 []），不能靠 sample.every 判类型：
  // 空数组的 every 恒真，会把关键词全变成 NaN。退一步看这一次输入本身像不像数字。
  const sampleNumeric = Array.isArray(sample) && sample.length > 0 && sample.every((x) => typeof x === 'number')
  const numeric = sampleNumeric || (parts.length > 0 && parts.every((x) => /^-?\d+(\.\d+)?$/.test(x)))
  return numeric ? parts.map(Number) : parts
}

function control(path, value) {
  if (typeof value === 'boolean') {
    const input = el('input', { type: 'checkbox' })
    input.checked = value
    return { node: el('label', { class: 'chk' }, input, el('span', { text: label(path) })), read: () => input.checked }
  }
  if (typeof value === 'number') {
    const input = el('input', { type: 'number', value: String(value), step: '1' })
    return { node: el('label', { class: 'field' }, el('span', { class: 'meta', text: label(path) }), input), read: () => Number(input.value) }
  }
  if (Array.isArray(value)) {
    const input = el('input', { type: 'text', value: value.join(', ') })
    return { node: el('label', { class: 'field' }, el('span', { class: 'meta', text: label(path) }), input), read: () => parseList(input.value, value) }
  }
  const input = el('input', { type: 'text', value: value === null || value === undefined ? '' : String(value) })
  return { node: el('label', { class: 'field' }, el('span', { class: 'meta', text: label(path) }), input), read: () => input.value }
}

function setPath(target, path, value) {
  if (!path.length) return value
  let node = target
  for (let i = 0; i < path.length - 1; i += 1) {
    const k = path[i]
    if (!node[k] || typeof node[k] !== 'object') node[k] = {}
    node = node[k]
  }
  node[path[path.length - 1]] = value
  return target
}

function editors(value, path, fields, nodes) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (HIDDEN.has(k)) continue
      editors(v, [...path, k], fields, nodes)
    }
    return
  }
  const full = path.join('.')
  const c = control(full, value)
  fields.push({ path, read: c.read })
  nodes.push(c.node)
}

function group(root, title, keys, cfg) {
  const c = card(title, { note: '保存只提交这一组；存完重新拉 /config 回读，不做本地乐观更新。' })
  const status = el('div', { class: 'meta', id: 'env-msg-' + keys[0] })
  for (const key of keys) {
    const box = el('details', { class: 'rule-layer' })
    const fields = []
    const nodes = []
    editors(cfg[key], [key], fields, nodes)
    const save = el('button', {
      class: 'primary small',
      text: '保存 ' + key,
      onclick: async () => {
        save.disabled = true
        status.textContent = '保存中…'
        try {
          const patch = {}
          for (const f of fields) setPath(patch, f.path, f.read())
          const r = await postFish('config', patch)
          if (!r.ok) { status.textContent = writeError(r); return }
          if (r.data?.ok === false) { status.textContent = `没存上：${r.data.error || '上游拒绝'}`; return }
          await refresh()
          const msg = $('#env-status')
          if (msg) msg.textContent = `已保存 ${key} · ${clock()}`
        } finally { save.disabled = false }
      },
    })
    box.append(el('summary', {}, el('code', { class: 'key', text: key })), ...nodes, el('div', { class: 'row' }, save))
    c.body.append(box)
  }
  c.body.append(status)
  root.append(c.root)
}

async function refresh() {
  const root = state.root
  if (!root) return
  const r = await fish('config')
  clear(root)
  if (!r.ok) { root.append(hint(errorText(r), 'bad')); return }
  const cfg = r.data?.config || {}
  const head = card('配置', { note: '每个键只在一个页面可编辑。工具白名单在「工具与规则」，观测参数在「数据与运维」，界面偏好在 B 站页。' })
  const f = r.data?.file || {}
  head.body.append(el('div', { class: 'meta', id: 'env-status', text: `更新于 ${clock()}${f.exists === false ? ' · 还没有配置文件，用的是默认值' : ''}` }))
  root.append(head.root)
  for (const [title, keys] of GROUPS) group(root, title, keys, cfg)
}

function build(root) {
  state.root = root
}

export const env = {
  id: 'env',
  label: '环境',
  enter(root) {
    if (!state.root) build(root)
    refresh()
  },
  leave() {},
}
