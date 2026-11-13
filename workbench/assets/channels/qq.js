// QQ 通道：消息 / 说话范围 / 掉线提醒 / 登录与 WebUI 四段。
// 发送、范围保存都是工作台自己的接口；动作日志由服务端 note() 写，前端不写事件流。
import {
  el, clear, card, local, fmtTime, errorText, humanChip, hint, segment,
} from '../lib.js'
import { confirmHuman, scopeChip, picked } from './shared.js'

const SECTIONS = [
  { id: 'messages', label: '消息' },
  { id: 'scope', label: '说话范围' },
  { id: 'watch', label: '掉线提醒' },
  { id: 'login', label: '登录与 WebUI' },
]

const SPEC = { section: 'messages', chat: { items: [], cur: null }, chips: new Map(), scope: null }

// ---------- 骨架 ----------

function build(root, ctx) {
  SPEC.root = root
  SPEC.ctx = ctx
  SPEC.built = true

  SPEC.seg = segment(SECTIONS, { value: SPEC.section, label: 'QQ 分段', onChange: (id) => show(id) })

  // 消息
  SPEC.messages = card('消息', { note: '读最近会话与聊天记录；发送是以她的身份替你发一句。' })
  SPEC.chatList = el('div', { class: 'chips' })
  SPEC.chatMsgs = el('div', { class: 'chat-msgs' })
  SPEC.chatInput = el('input', { type: 'text', placeholder: '要发的话' })
  SPEC.chatMsg = el('span', { class: 'meta' })
  SPEC.sendBtn = el('button', { class: 'primary', type: 'button', onclick: () => sendChat() }, '人工发送')
  SPEC.sendBtn.append(humanChip())
  SPEC.messages.body.append(
    SPEC.chatList,
    SPEC.chatMsgs,
    el('div', { class: 'row' },
      SPEC.chatInput,
      SPEC.sendBtn,
      el('button', { class: 'small', type: 'button', text: '刷新', onclick: () => loadRecent(true) }),
      SPEC.chatMsg,
    ),
  )
  SPEC.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat() })

  // 说话范围
  SPEC.scope = card('说话范围', { note: '只影响 QQ：名单里的人 / 群她才会接话。' })
  SPEC.scopeFriends = el('div', { class: 'chips' })
  SPEC.scopeGroups = el('div', { class: 'chips' })
  SPEC.scopeAdmins = el('div', { class: 'chips' })
  SPEC.scopeMention = el('input', { type: 'checkbox' })
  SPEC.scopeRestart = el('input', { type: 'checkbox' })
  SPEC.scopeMsg = el('span', { class: 'meta' })
  SPEC.scopeSave = el('button', { class: 'primary small', type: 'button', text: '保存', onclick: () => saveScope() })
  // 读不到当前范围时，保存会把空名单写回去，必须先读到再放开。
  SPEC.scopeSave.disabled = true
  SPEC.scope.body.append(
    el('div', { class: 'meta', text: '私聊' }), SPEC.scopeFriends,
    el('div', { class: 'meta', text: '群' }), SPEC.scopeGroups,
    el('div', { class: 'meta', text: '管理员' }), SPEC.scopeAdmins,
    el('label', { class: 'chk' }, SPEC.scopeMention, el('span', { text: '群里要 @ 才回' })),
    el('label', { class: 'chk' }, SPEC.scopeRestart, el('span', { text: '保存后重启她的进程（约 10 秒，当前对话会中断）' })),
    el('div', { class: 'row' },
      SPEC.scopeSave,
      el('button', { class: 'small', type: 'button', text: '重新读取', onclick: () => loadScope() }),
      SPEC.scopeMsg,
    ),
  )

  // 掉线提醒
  SPEC.watch = card('掉线提醒', { note: '她 QQ 被手机登录顶下线时，工作台发通知并贴出新二维码。' })
  SPEC.watchEnabled = el('input', { type: 'checkbox' })
  SPEC.watchPoll = el('input', { type: 'number', min: '5', step: '1' })
  SPEC.watchNag = el('input', { type: 'number', min: '0', step: '1' })
  SPEC.watchRecover = el('input', { type: 'checkbox' })
  SPEC.watchMsg = el('span', { class: 'meta' })
  SPEC.watch.body.append(
    el('label', { class: 'chk' }, SPEC.watchEnabled, el('span', { text: '开着掉线提醒' })),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '看一次间隔（秒）' }), SPEC.watchPoll),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '多久再催一次（分钟，0 = 只提醒一次）' }), SPEC.watchNag),
    el('label', { class: 'chk' }, SPEC.watchRecover, el('span', { text: '恢复登录时也说一声' })),
    el('div', { class: 'row' },
      el('button', { class: 'primary small', type: 'button', text: '保存', onclick: () => saveWatch() }),
      el('button', { class: 'small', type: 'button', text: '弹一条测试通知', onclick: () => testWatch() }),
      SPEC.watchMsg,
    ),
  )

  // 登录与 WebUI
  SPEC.login = card('登录与 WebUI', { note: '进程启停走 fish-ctl；WebUI 的 token 在 webui.json 里。' })
  SPEC.loginState = el('div', { class: 'meta' })
  SPEC.qr = el('img', { class: 'qr', alt: 'NapCat 登录二维码' })
  SPEC.qr.addEventListener('error', () => { SPEC.qr.hidden = true })
  SPEC.qrAt = 0
  SPEC.panelInfo = el('div', { class: 'meta' })
  SPEC.loginMsg = el('span', { class: 'meta' })
  SPEC.login.body.append(
    SPEC.loginState,
    SPEC.qr,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '启动', onclick: () => act('qq/start') }),
      el('button', { class: 'small', type: 'button', text: '停止', onclick: () => act('qq/stop') }),
      el('button', { class: 'small', type: 'button', text: '重启', onclick: () => act('qq/restart') }),
      el('button', { class: 'small', type: 'button', text: '打开 WebUI', onclick: () => openPanel('panelUrl') }),
      el('button', { class: 'small', type: 'button', text: '登录页', onclick: () => openPanel('loginUrl') }),
      SPEC.loginMsg,
    ),
    SPEC.panelInfo,
  )

  SPEC.sections = {
    messages: SPEC.messages.root,
    scope: SPEC.scope.root,
    watch: SPEC.watch.root,
    login: SPEC.login.root,
  }
  root.append(SPEC.seg.root, ...Object.values(SPEC.sections))
  show(SPEC.section)

  subscribe(ctx)
}

function subscribe(ctx) {
  SPEC.unsub?.()
  SPEC.unsub = ctx?.onStatus?.((status) => applyStatus(status))
}

function show(id) {
  SPEC.section = id
  for (const [key, node] of Object.entries(SPEC.sections)) node.hidden = key !== id
  SPEC.seg.set(id)
  refreshData()
}

// ---------- 状态 ----------

function applyStatus(status) {
  const x = status?.channels?.qq || status?.qq || null
  if (!x) return
  if (SPEC.section === 'login') {
    const label = !x.running ? '进程没在跑' : x.loggedIn ? '在线' : '进程在，等扫码'
    SPEC.loginState.textContent = x.login?.phase === 'kicked'
      ? `${label} · 掉线于 ${fmtTime(x.login.at)}`
      : label
    if (x.qrAt && x.qrAt !== SPEC.qrAt) {
      SPEC.qrAt = x.qrAt
      SPEC.qr.hidden = false
      SPEC.qr.src = '/api/qq/qr?t=' + x.qrAt
    }
  }
}

// ---------- 数据 ----------

async function refreshData() {
  if (SPEC.section === 'messages') await loadRecent()
  else if (SPEC.section === 'scope') await loadScope()
  else if (SPEC.section === 'watch') await loadWatch()
  else if (SPEC.section === 'login') await loadPanel()
}

async function loadRecent(keep = false) {
  const r = await local('/api/qq/recent')
  if (!r.ok) {
    clear(SPEC.chatList)
    SPEC.chatList.append(hint(errorText(r)))
    return
  }
  const items = r.data?.items || []
  SPEC.chat.items = items
  // 选中的会话没了就落回第一个
  if (SPEC.chat.cur && !items.some((it) => it.id === SPEC.chat.cur.id && it.kind === SPEC.chat.cur.kind)) SPEC.chat.cur = null
  if (!SPEC.chat.cur && items.length) SPEC.chat.cur = items[0]
  clear(SPEC.chatList)
  if (!items.length) {
    SPEC.chatList.append(hint('还没有会话'))
    clear(SPEC.chatMsgs)
    return
  }
  SPEC.chips = new Map()
  for (const it of items) {
    const key = `${it.kind}:${it.id}`
    const chip = el('label', { class: 'chip' + (SPEC.chat.cur?.id === it.id && SPEC.chat.cur?.kind === it.kind ? ' on' : ''), title: it.last || '' },
      el('span', { text: `${it.kind === 'group' ? '群' : '私聊'} · ` }),
      el('b', { text: it.name || it.id }),
      el('span', { class: 'id', text: it.clock || '' }),
    )
    chip.addEventListener('click', () => openChat(it))
    SPEC.chips.set(key, chip)
    SPEC.chatList.append(chip)
  }
  if (SPEC.chat.cur) await openChat(SPEC.chat.cur, keep)
}

async function openChat(it, keep = false) {
  SPEC.chat.cur = it
  for (const [key, chip] of SPEC.chips) chip.classList.toggle('on', key === `${it.kind}:${it.id}`)
  if (!keep) { clear(SPEC.chatMsgs); SPEC.chatMsgs.append(hint('加载中…')) }
  const r = await local(`/api/qq/history?kind=${it.kind}&id=${encodeURIComponent(it.id)}`)
  clear(SPEC.chatMsgs)
  if (!r.ok) { SPEC.chatMsgs.append(hint(errorText(r))); return }
  const items = r.data?.items || []
  if (!items.length) { SPEC.chatMsgs.append(hint('这里还没有消息')); return }
  for (const m of items) {
    SPEC.chatMsgs.append(el('div', { class: 'msg' + (m.self ? ' me' : '') },
      el('span', { class: 'who', text: `${m.who} · ${m.clock}` }),
      el('span', { class: 'bubble', text: m.text }),
    ))
  }
  SPEC.chatMsgs.scrollTop = SPEC.chatMsgs.scrollHeight
}

async function sendChat() {
  const text = SPEC.chatInput.value.trim()
  if (!text) return
  if (!SPEC.chat.cur) { SPEC.chatMsg.textContent = '先点一个会话'; return }
  const where = `${SPEC.chat.cur.kind === 'group' ? '群' : '私聊'}「${SPEC.chat.cur.name || SPEC.chat.cur.id}」`
  if (!confirmHuman(`以她的身份把这句发到${where}`, text)) return
  SPEC.chatMsg.textContent = '发送中…'
  const r = await local('/api/qq/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: SPEC.chat.cur.kind, id: SPEC.chat.cur.id, name: SPEC.chat.cur.name, text }),
  })
  const d = r.data || {}
  SPEC.chatMsg.textContent = d.ok ? '发出去了' : `失败：${d.why || d.error || '未知'}`
  if (d.ok) { SPEC.chatInput.value = ''; await openChat(SPEC.chat.cur) }
}

async function loadScope() {
  SPEC.scopeSave.disabled = true
  const r = await local('/api/qq/scope')
  if (!r.ok) {
    SPEC.scopeMsg.textContent = errorText(r)
    return
  }
  renderScope(r.data || {})
}

function renderScope(s) {
  SPEC.scopeData = s
  // 读成功才允许保存：否则空表单会覆盖掉已有名单。
  SPEC.scopeSave.disabled = false
  const p = s.policy || {}
  const has = (arr, id) => (arr || []).map(String).includes(String(id))
  const withSaved = (list, saved) => {
    const out = [...(list || [])]
    for (const id of saved || []) if (!out.some((x) => String(x.id) === String(id))) out.push({ id: String(id), name: '（不在列表里）' })
    return out
  }
  const friends = withSaved(s.friends, p.allowFrom)
  const admins = withSaved(s.friends, p.adminUsers)
  const groups = withSaved(s.groups, p.groupAllowFrom)

  clear(SPEC.scopeFriends)
  if (!friends.length) SPEC.scopeFriends.append(hint('还没有好友可勾'))
  for (const f of friends) {
    SPEC.scopeFriends.append(scopeChip({ id: f.id, label: f.name, checked: has(p.allowFrom, f.id) }))
  }
  clear(SPEC.scopeGroups)
  if (!groups.length) SPEC.scopeGroups.append(hint(s.online ? '这个 QQ 还没进任何群' : 'QQ 没在线，列不出群'))
  for (const g of groups) {
    SPEC.scopeGroups.append(scopeChip({ id: g.id, label: `${g.name || g.id}${g.count ? `（${g.count} 人）` : ''}`, checked: has(p.groupAllowFrom, g.id) }))
  }
  clear(SPEC.scopeAdmins)
  if (!admins.length) SPEC.scopeAdmins.append(hint('还没有好友可勾'))
  for (const f of admins) {
    SPEC.scopeAdmins.append(scopeChip({ id: f.id, label: f.name, checked: has(p.adminUsers, f.id) }))
  }
  SPEC.scopeMention.checked = p.requireMention !== false
  const n = (p.allowFrom || []).length, g = (p.groupAllowFrom || []).length, a = (p.adminUsers || []).length
  SPEC.scopeMsg.textContent = `私聊 ${n} 人 · 群 ${g} 个 · 管理员 ${a} 人${s.bot ? ` · 机器人 ${s.bot.user_id}「${s.bot.nickname}」` : ''}`
}

async function saveScope() {
  if (SPEC.scopeSave.disabled) return
  const restart = SPEC.scopeRestart.checked
  if (restart && !confirm('保存后会把她的进程重启（约 10 秒，当前对话会中断）。继续？')) return
  SPEC.scopeMsg.textContent = '保存中…'
  SPEC.scopeSave.disabled = true
  const r = await local('/api/qq/scope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requireMention: SPEC.scopeMention.checked,
      allowFrom: picked(SPEC.scopeFriends),
      groupAllowFrom: picked(SPEC.scopeGroups),
      adminUsers: picked(SPEC.scopeAdmins),
      dmPolicy: 'allowlist',
      groupPolicy: 'allowlist',
      restart,
    }),
  })
  const d = r.data || {}
  if (d.error || !r.ok) {
    SPEC.scopeMsg.textContent = `没存上：${d.error || d.err || '接口没回话'}`
    SPEC.scopeSave.disabled = false
    return
  }
  renderScope({ ...SPEC.scopeData, policy: d.policy })
  SPEC.scopeMsg.textContent = d.url
    ? '已保存并重启，新地址记在下面（旧标签页会 401）'
    : '已保存到 patch；下次重启生效'
  if (d.url) SPEC.scopeMsg.append(' · ', el('a', { href: d.url, target: '_blank', rel: 'noreferrer', text: '打开她' }))
}

async function loadWatch() {
  const r = await local('/api/watch')
  if (!r.ok) { SPEC.watchMsg.textContent = errorText(r); return }
  const s = r.data?.settings || {}
  const login = r.data?.login || {}
  if (document.activeElement !== SPEC.watchPoll) SPEC.watchPoll.value = s.pollSeconds ?? 15
  if (document.activeElement !== SPEC.watchNag) SPEC.watchNag.value = s.nagMinutes ?? 10
  SPEC.watchEnabled.checked = s.enabled !== false
  SPEC.watchRecover.checked = s.notifyRecover !== false
  SPEC.watch.setMeta(
    s.enabled === false ? '关着' : `开 · 每 ${s.pollSeconds} 秒 · ${login.phase === 'kicked' ? 'QQ 现在掉着' : '看着呢'}`,
    s.enabled === false ? '' : (login.phase === 'kicked' ? 'warn' : 'ok'),
  )
}

async function saveWatch() {
  SPEC.watchMsg.textContent = '保存中…'
  const r = await local('/api/watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: SPEC.watchEnabled.checked,
      pollSeconds: Number(SPEC.watchPoll.value),
      nagMinutes: Number(SPEC.watchNag.value),
      notifyRecover: SPEC.watchRecover.checked,
    }),
  })
  const s = r.data?.settings || {}
  SPEC.watchMsg.textContent = r.ok
    ? `已保存：每 ${s.pollSeconds} 秒，${s.nagMinutes ? s.nagMinutes + ' 分钟催一次' : '只提醒一次'}`
    : '保存失败'
  await loadWatch()
}

async function testWatch() {
  await local('/api/watch/test', { method: 'POST' })
  SPEC.watchMsg.textContent = '弹了一条测试通知'
}

async function loadPanel() {
  const r = await local('/api/qq/panel')
  if (!r.ok) { SPEC.panelInfo.textContent = '读不到 WebUI 配置'; return }
  const d = r.data || {}
  SPEC.panel = d
  SPEC.panelInfo.textContent = `WebUI ${d.base || ''} · 端口 ${d.port || '—'} · token ${d.token ? '已读到' : '没读到'}`
}

function openPanel(kind) {
  const d = SPEC.panel || {}
  const url = d[kind] || d.url
  if (url) window.open(url, '_blank')
  else SPEC.loginMsg.textContent = '还没读到地址'
}

async function act(name) {
  SPEC.loginMsg.textContent = '…'
  const r = await local('/api/' + name, { method: 'POST' })
  SPEC.loginMsg.textContent = r.ok ? '好了' : (r.data?.error || '没成')
  SPEC.ctx?.refreshStatus?.()
}

// ---------- 适配器契约 ----------

export const qq = {
  id: 'qq',
  label: 'QQ',
  order: 10,
  humanActions: ['send'],

  badge(status) {
    if (!status || !status.running) return 'bad'
    if (status.login?.phase === 'kicked') return 'bad'
    if (!status.loggedIn) return 'warn'
    return 'ok'
  },

  summary(status, ctx) {
    const lines = []
    if (!status) lines.push('状态还没读到')
    else {
      lines.push(status.running ? (status.loggedIn ? '在线' : '进程在，等扫码') : '没在跑')
      if (status.login?.phase === 'kicked') lines.push(`掉线于 ${fmtTime(status.login.at)}`)
    }
    return {
      lines,
      actions: [{ label: '去 QQ', onClick: () => ctx?.go?.('channels', 'qq') }],
    }
  },

  renderPanel(root, ctx) {
    if (SPEC.built && SPEC.root === root) {
      SPEC.ctx = ctx
      subscribe(ctx)
      refreshData()
      return
    }
    SPEC.built = false
    build(root, ctx)
  },

  async refresh(ctx) {
    SPEC.ctx = ctx
    applyStatus(ctx?.status)
    await refreshData()
  },

  leave() {
    SPEC.unsub?.()
    SPEC.unsub = null
  },
}
