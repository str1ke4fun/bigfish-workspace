// B 站 · 管理：登录、风控和四组策略配置。
// 这些配置只影响她在 B 站的行为；成长与记忆设置在系统 · 设置。
// 每组独立保存、存完重新 GET /config 回读；cookie 只上行不下行，输入框永远空着。
import {
  el, clear, card, fish, postFish, fmtTime, clock,
  errorText, writeError,
} from '../lib.js'
import { configGroup } from '../config-form.js'

const LABELS = {
  'browse.enabled': '刷站开关',
  'browse.perDay': '每天刷几次',
  'browse.topN': '每次看几条',
  'browse.rankingTids': '轮换分区数',
  'browse.deepRead': '深读评论条数',
  'browse.danmaku': '弹幕条数',
  'browse.keywords': '额外搜索词（逗号分隔）',
  'browse.window': '刷站时段（如 08:00, 23:00）',
  'browse.voices': '读评论区',
  'video.enabled': '看画面开关',
  'video.perDay': '每天几条视频',
  'video.frames': '每条抽几帧',
  'video.ocr': '认画面里的字',
  'comment.enabled': '评论开关',
  'comment.perDay': '每天评论几条',
  'comment.replyPerDay': '每天回复几条',
  'comment.replyToReplies': '允许回回复',
  'comment.scanEveryMin': '扫描间隔（分钟）',
  'comment.window': '评论时段（如 08:00, 23:00）',
  'comment.atOwner': '@ 领养人',
  'avoid.keywords': '避让词（逗号分隔）',
  'avoid.upMids': '避让 UP mid（逗号分隔）',
  'avoid.minDuration': '最短时长（秒）',
}

const GROUPS = [
  {
    title: '浏览',
    keys: ['browse.enabled', 'browse.perDay', 'browse.topN', 'browse.rankingTids',
      'browse.deepRead', 'browse.danmaku', 'browse.keywords', 'browse.window', 'browse.voices'],
  },
  {
    title: '看画面',
    keys: ['video.enabled', 'video.perDay', 'video.frames', 'video.ocr'],
  },
  {
    title: '评论',
    keys: ['comment.enabled', 'comment.perDay', 'comment.replyPerDay', 'comment.replyToReplies',
      'comment.scanEveryMin', 'comment.window', 'comment.atOwner'],
  },
  {
    title: '避让',
    keys: ['avoid.keywords', 'avoid.upMids', 'avoid.minDuration'],
  },
]

const SPEC = {}

function build(root) {
  SPEC.notice = el('div', {
    class: 'meta card-note',
    text: '这些配置只影响她在 B 站的行为；成长与记忆设置在系统 · 设置。',
  })

  // ---- 登录 ----
  SPEC.login = card('登录', { note: 'cookie 只上行不下行：输入框永远空着，存过之后只显示「已保存」。' })
  SPEC.loginBody = el('div')
  SPEC.mid = el('input', { type: 'text', placeholder: '领养人 mid' })
  SPEC.nickname = el('input', { type: 'text', placeholder: '昵称（@ 用）' })
  SPEC.cookie = el('input', { type: 'password', placeholder: '留空 = 不改' })
  SPEC.loginMsg = el('span', { class: 'meta' })
  SPEC.login.body.append(
    SPEC.loginBody,
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '领养人 mid' }), SPEC.mid),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '昵称（@ 用）' }), SPEC.nickname),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: 'cookie' }), SPEC.cookie),
    el('div', { class: 'row' },
      el('button', { class: 'primary', type: 'button', text: '保存登录信息', onclick: () => saveOwner() }),
      el('button', { type: 'button', text: '测试这份 cookie', onclick: () => testOwner() }),
      SPEC.loginMsg,
    ),
  )

  // ---- 风控 ----
  SPEC.risk = card('风控')
  SPEC.riskBody = el('div')
  SPEC.riskMsg = el('span', { class: 'meta' })
  SPEC.clearBtn = el('button', {
    class: 'small danger',
    type: 'button',
    text: '解冻（二次确认）',
    onclick: () => clearRisk(),
  })
  SPEC.clearBtn.hidden = true
  SPEC.risk.body.append(SPEC.riskBody, el('div', { class: 'row' }, SPEC.clearBtn, SPEC.riskMsg))

  // ---- 四组策略 ----
  SPEC.groups = GROUPS.map((g) => configGroup({
    title: g.title,
    keys: g.keys,
    labels: LABELS,
    note: '保存只提交这一组；存完重新读 /config 回读。',
    onSaved: () => loadConfig(),
  }))

  root.append(SPEC.notice, SPEC.login.root, SPEC.risk.root, ...SPEC.groups.map((g) => g.root))
}

// ---------- 渲染 ----------

function renderOwner(r) {
  clear(SPEC.loginBody)
  if (!r.ok) { SPEC.loginBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const o = r.data || {}
  SPEC.mid.value = o.mid || ''
  SPEC.nickname.value = o.name || ''
  SPEC.cookie.value = ''
  SPEC.loginBody.append(
    el('div', { class: 'meta', text: o.hasCookie ? `cookie：已存${o.hasCsrf ? '（带 csrf）' : '（没有 csrf，可能不能发言）'}` : 'cookie：还没存' }),
    el('div', { class: 'meta', text: `登录账号：${o.account?.name || '还没认出来'}` }),
  )
}

function renderRisk(r) {
  clear(SPEC.riskBody)
  if (!r.ok) { SPEC.risk.setMeta(errorText(r), 'bad'); SPEC.riskBody.append(el('div', { class: 'bad', text: errorText(r) })); SPEC.clearBtn.hidden = true; return }
  const x = r.data || {}
  SPEC.risk.setMeta(x.cooling ? '冷却中' : '正常', x.cooling ? 'warn' : 'ok')
  SPEC.riskBody.append(
    el('div', { text: x.cooling ? `风控冷却到 ${x.until ? fmtTime(x.until) : '—'}` : '没在冷却。' }),
    el('div', { class: 'meta', text: `撞过的次数：${x.strikes ?? 0}${x.code ? ' · 最近一次 ' + x.code : ''}` }),
  )
  SPEC.clearBtn.hidden = !x.cooling
}

function renderConfig(r) {
  if (!r.ok) {
    for (const g of SPEC.groups) g.setStatus(errorText(r), 'bad')
    return
  }
  const cfg = r.data?.config || {}
  for (const g of SPEC.groups) g.setConfig(cfg)
  SPEC.configAt = clock()
}

// ---------- 读取 ----------

async function loadConfig() {
  const r = await fish('config')
  renderConfig(r)
  return r
}

async function loadOwner() {
  const r = await fish('owner')
  renderOwner(r)
}

async function loadRisk() {
  const r = await fish('risk')
  renderRisk(r)
}

async function updateBadge(ctx) {
  const r = await fish('bili/status')
  if (!ctx?.setBadge) return
  ctx.setBadge('bili', !r.ok ? 'bad' : (r.data?.installed === false ? 'bad' : r.data?.cooling ? 'warn' : 'ok'))
}

async function load(ctx) {
  await Promise.all([loadConfig(), loadOwner(), loadRisk(), updateBadge(ctx)])
}

// ---------- 动作 ----------

async function saveOwner() {
  SPEC.loginMsg.textContent = '保存中…'
  // 只发真的填了的字段：回读失败或还没回读时输入框是空的，
  // 无条件发空串会把已经存好的 mid / 昵称清掉。
  const body = {}
  const mid = SPEC.mid.value.trim()
  const nickname = SPEC.nickname.value.trim()
  const cookie = SPEC.cookie.value.trim()
  if (mid) body.mid = mid
  if (nickname) body.nickname = nickname
  if (cookie) body.cookie = cookie
  if (!Object.keys(body).length) { SPEC.loginMsg.textContent = '没有要保存的内容。'; return }
  try {
    const r = await postFish('owner', body)
    if (!r.ok) {
      // 上游 400 把原因放在 note 里（例如 cookie 里没认出 B 站的键），别吞掉。
      SPEC.loginMsg.textContent = r.data?.note || r.data?.error || writeError(r)
      return
    }
    const d = r.data || {}
    await loadOwner()
    SPEC.loginMsg.textContent = d.note || (d.ok === false ? `没存上${d.note ? '：' + d.note : '。'}` : '存下了。')
  } catch (err) {
    SPEC.loginMsg.textContent = `没成：${err?.message || err}`
  }
}

async function testOwner() {
  SPEC.loginMsg.textContent = '联网验证中…'
  try {
    const r = await postFish('owner', { test: true })
    if (!r.ok) { SPEC.loginMsg.textContent = r.data?.note || writeError(r); return }
    const d = r.data || {}
    await loadOwner()
    SPEC.loginMsg.textContent = d.note || (d.ok ? '可以说话。' : '还不行。')
  } catch (err) {
    SPEC.loginMsg.textContent = `没成：${err?.message || err}`
  }
}

async function clearRisk() {
  if (!confirm('确认解冻？现在就会允许她继续碰 B 站。')) return
  SPEC.riskMsg.textContent = '解冻中…'
  const r = await postFish('risk', { clear: true })
  if (!r.ok) { SPEC.riskMsg.textContent = r.data?.error || writeError(r); return }
  const d = r.data || {}
  await loadRisk()
  SPEC.riskMsg.textContent = d.cleared ? '已解冻。' : '解冻请求发出去了。'
}

// ---------- 页面契约 ----------

export const biliManage = {
  id: 'bili-manage',
  nav: 'bili',
  slug: 'manage',
  label: '管理',
  order: 30,

  enter(root, ctx) {
    if (!SPEC.built) { build(root); SPEC.built = true }
    load(ctx)
  },

  leave() {},
}
