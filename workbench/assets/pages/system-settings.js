// 系统 · 设置：只剩成长 / 通知 / 对话 / 记忆四组。
// B 站的行为配置在 B站 · 管理，通道的范围在通道页，工具白名单在系统 · 工具与规则。
import { el, card, fish, clock, errorText } from '../lib.js'
import { configGroup } from '../config-form.js'

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
  'notify.enabled': '桌面提醒',
  'chat.rotateAfter': '多少轮换会话',
  'chat.replyChars': '单轮字数上限',
  'memory.docBudget': '身份文档预算',
  'memory.beliefsShown': '一轮摆几条判断',
  'memory.sleepEveryDays': '几天想一次',
  'memory.sleepKeep': '留几条自述',
  'memory.closing.enabled': '收盘任务',
  'memory.closing.time': '收盘时间（HH:MM）',
  'memory.closing.wake': '收盘时叫她记一笔',
  'memory.closing.diaryOnly': '只在她今天没写日记时叫',
}

const GROUPS = [
  {
    title: '成长',
    keys: ['growthDays', 'wakesPerDay', 'window', 'daily.events', 'daily.questions',
      'diary.enabled', 'diary.visible', 'diary.keepDays', 'absenceAfterDays'],
  },
  { title: '通知', keys: ['notify.enabled'] },
  { title: '对话', keys: ['chat.rotateAfter', 'chat.replyChars'] },
  {
    title: '记忆',
    keys: ['memory.docBudget', 'memory.beliefsShown', 'memory.sleepEveryDays', 'memory.sleepKeep',
      'memory.closing.enabled', 'memory.closing.time', 'memory.closing.wake', 'memory.closing.diaryOnly'],
  },
]

const SPEC = {}

function moveRow(label, text, onClick) {
  return el('div', { class: 'row' },
    el('span', { class: 'meta', text: label }),
    el('span', { text }),
    el('button', { class: 'small', type: 'button', text: '去改', onclick: onClick }),
  )
}

function build(root, ctx) {
  SPEC.ctx = ctx

  const move = card('配置搬家', { note: '这里只留成长、通知、对话、记忆；别的配置在各自的页面。' })
  move.body.append(
    moveRow('B 站', '浏览、看画面、评论、避让、登录与风控', () => ctx?.go?.('bili', 'manage')),
    moveRow('通道', 'QQ 说话范围、微信允许说话、掉线提醒', () => ctx?.go?.('channels', 'overview')),
    moveRow('工具与规则', '工具白名单、规则分层、自检', () => ctx?.go?.('system', 'tools')),
  )

  SPEC.groups = GROUPS.map((g) => configGroup({
    title: g.title,
    keys: g.keys,
    labels: LABELS,
    note: '保存只提交这一组；存完重新读 /config 回读。',
    onSaved: () => loadConfig(),
  }))

  SPEC.configMsg = el('div', { class: 'meta' })
  root.append(move.root, ...SPEC.groups.map((g) => g.root), SPEC.configMsg)
}

async function loadConfig() {
  const r = await fish('config')
  if (!r.ok) {
    SPEC.configMsg.textContent = errorText(r)
    for (const g of SPEC.groups) g.setStatus(errorText(r), 'bad')
    return
  }
  const cfg = r.data?.config || {}
  for (const g of SPEC.groups) g.setConfig(cfg)
  SPEC.configMsg.textContent = `配置更新于 ${clock()}`
}

export const systemSettings = {
  id: 'system-settings',
  nav: 'system',
  slug: 'settings',
  label: '设置',
  order: 10,

  enter(root, ctx) {
    if (!SPEC.built) { build(root, ctx); SPEC.built = true }
    SPEC.ctx = ctx
    loadConfig()
  },

  leave() {},
}
