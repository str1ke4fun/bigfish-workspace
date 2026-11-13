// 微信通道：实时画面 / 允许说话 / 维护三段。
// 打字、回车、Esc 都是人工代操作：按钮标注、二次确认，服务端记动作日志。
import {
  el, clear, card, local, fmtTime, errorText, humanChip, hint, segment,
} from '../lib.js'
import { confirmHuman, scopeChip, picked } from './shared.js'

const SECTIONS = [
  { id: 'live', label: '实时画面' },
  { id: 'scope', label: '允许说话' },
  { id: 'maint', label: '维护' },
]

const SPEC = { section: 'live', timer: null, wx: null, scope: null, frames: [] }

// ---------- 骨架 ----------

function build(root, ctx) {
  SPEC.root = root
  SPEC.ctx = ctx
  SPEC.built = true

  SPEC.seg = segment(SECTIONS, { value: SPEC.section, label: '微信分段', onChange: (id) => show(id) })

  // 实时画面
  SPEC.live = card('实时画面', { note: '约一秒一帧；点画面等于在原位置点一下（人工代操作）。' })
  SPEC.shot = el('img', { class: 'shot', alt: '微信实时画面' })
  SPEC.shot.addEventListener('error', () => { SPEC.shot.hidden = true })
  SPEC.empty = hint('等画面…')
  SPEC.liveMeta = el('div', { class: 'meta' })
  SPEC.text = el('input', { type: 'text', placeholder: '要打进当前窗口的话' })
  SPEC.typeBtn = el('button', { class: 'primary', type: 'button', onclick: () => typeText(SPEC.text.value) }, '人工打字')
  SPEC.typeBtn.append(humanChip())
  SPEC.liveMsg = el('span', { class: 'meta' })
  SPEC.shot.addEventListener('click', (ev) => clickAt(ev))
  SPEC.live.body.append(
    SPEC.shot,
    SPEC.empty,
    SPEC.liveMeta,
    el('div', { class: 'row' },
      SPEC.text,
      SPEC.typeBtn,
      el('button', { class: 'small', type: 'button', text: '回车（发送）', onclick: () => pressKey('Return') }),
      el('button', { class: 'small', type: 'button', text: 'Esc', onclick: () => pressKey('Escape') }),
      SPEC.liveMsg,
    ),
  )
  SPEC.text.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (await typeText(SPEC.text.value)) SPEC.text.value = '' }
  })

  // 允许说话
  SPEC.scope = card('允许说话', { note: '名单是发消息前的闸：当前窗口得是名单里的会话，她才开口。' })
  SPEC.wxEnabled = el('input', { type: 'checkbox' })
  SPEC.wxAllow = el('div', { class: 'chips' })
  SPEC.wxNoMention = el('div', { class: 'chips' })
  SPEC.wxMention = el('input', { type: 'checkbox' })
  SPEC.wxWindow = el('input', { type: 'number', min: '1', step: '1' })
  SPEC.wxNow = el('div', { class: 'meta' })
  SPEC.wxSave = el('button', { class: 'primary small', type: 'button', text: '保存', onclick: () => saveScope() })
  SPEC.wxMsg = el('span', { class: 'meta' })
  SPEC.scope.body.append(
    el('label', { class: 'chk' }, SPEC.wxEnabled, el('span', { text: '允许她在微信说话' })),
    el('div', { class: 'meta', text: '可以开口的会话' }), SPEC.wxAllow,
    el('div', { class: 'meta', text: '不用 @ 的会话' }), SPEC.wxNoMention,
    el('label', { class: 'chk' }, SPEC.wxMention, el('span', { text: '@ 才回' })),
    el('label', { class: 'field' }, el('span', { class: 'meta', text: '@ 的有效窗口（分钟）' }), SPEC.wxWindow),
    SPEC.wxNow,
    el('div', { class: 'row' },
      SPEC.wxSave,
      el('button', { class: 'small', type: 'button', text: '刷新候选', onclick: () => loadScope() }),
      SPEC.wxMsg,
    ),
  )

  // 维护
  SPEC.maint = card('维护', { note: '截图存档、识别界面、关多余界面、补扫会话目录。清理会真的删文件。' })
  SPEC.extraBtn = el('button', { class: 'small', type: 'button', text: '关掉多余界面', onclick: () => closeExtra() })
  SPEC.maintMsg = el('span', { class: 'meta' })
  SPEC.thumbs = el('div', { class: 'chips' })
  SPEC.maint.body.append(
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '存一张当前画面', onclick: () => saveShot() }),
      el('button', { class: 'small', type: 'button', text: '识别界面', onclick: () => peek() }),
      SPEC.extraBtn,
      el('button', { class: 'small', type: 'button', text: '补扫会话目录', onclick: () => scanChats() }),
      el('button', { class: 'small danger', type: 'button', text: '清理', onclick: () => gc() }),
    ),
    SPEC.maintMsg,
    el('div', { class: 'meta', text: '最近存档' }),
    SPEC.thumbs,
  )

  SPEC.sections = { live: SPEC.live.root, scope: SPEC.scope.root, maint: SPEC.maint.root }
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
  if (id === 'live') startFrames()
  else stopFrames()
  if (id === 'scope') loadScope()
  else if (id === 'maint') loadFrames()
}

// ---------- 状态与画面 ----------

function applyStatus(status) {
  const x = status?.channels?.wx || status?.wx || null
  SPEC.wx = x
  if (!x) return
  const g = x.geom || {}
  const bits = [
    x.running ? '在跑' : '没在跑',
    `Xvfb ${x.xvfb ? '开' : '关'}`,
    `窗口 ${x.window || '无'}`,
    `${g.w || 0}×${g.h || 0}`,
  ]
  if (x.extra > 0) bits.push(`还有 ${x.extra} 个多余界面`)
  const tree = x.health?.tree
  if (tree && tree.status !== 'ok') bits.push(`无障碍树 ${tree.status}（元素 ${tree.elements ?? '—'}、会话 ${tree.chats ?? '—'}）`)
  SPEC.liveMeta.textContent = bits.join(' · ')
  SPEC.extraBtn.hidden = !(x.extra > 0)
  if (!x.running) {
    stopFrames()
    SPEC.shot.hidden = true
    SPEC.empty.hidden = false
    SPEC.empty.textContent = '微信没在跑'
  } else if (SPEC.section === 'live') {
    startFrames()
  }
  // 不在这里重画“允许说话”：轮询会盖掉还没保存的勾选与输入。
  // 表单只在进入分段、点刷新、保存成功后更新。
}

function startFrames() {
  stopFrames()
  if (SPEC.section !== 'live') return
  const tick = () => {
    if (document.hidden || SPEC.section !== 'live' || !SPEC.wx?.running) return
    const url = '/api/wx/frame.jpg?t=' + Date.now()
    const probe = new Image()
    probe.onload = () => {
      SPEC.shot.src = url
      SPEC.shot.hidden = false
      SPEC.empty.hidden = true
    }
    probe.onerror = () => {
      SPEC.shot.hidden = true
      SPEC.empty.hidden = false
      SPEC.empty.textContent = '截不到图（Xvfb 或微信没起）'
    }
    probe.src = url
  }
  tick()
  SPEC.timer = setInterval(tick, 1000)
}

function stopFrames() {
  if (SPEC.timer) clearInterval(SPEC.timer)
  SPEC.timer = null
}

async function clickAt(ev) {
  if (!SPEC.shot.naturalWidth) return
  const rect = SPEC.shot.getBoundingClientRect()
  const x = Math.round((ev.clientX - rect.left) * (SPEC.shot.naturalWidth / rect.width))
  const y = Math.round((ev.clientY - rect.top) * (SPEC.shot.naturalHeight / rect.height))
  const r = await local('/api/wx/click', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ x, y }),
  })
  SPEC.liveMsg.textContent = r.ok ? `点了一下 (${x}, ${y})` : `点不动：${r.data?.err || r.data?.error || '没成'}`
}

// ---------- 人工打字 / 按键 ----------

async function typeText(text) {
  const value = String(text || '').trim()
  if (!value) return false
  if (!confirmHuman('把这句打进微信当前窗口', value)) return false
  SPEC.liveMsg.textContent = '打字中…'
  const r = await local('/api/wx/type', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: value }),
  })
  const d = r.data || {}
  if (d.err) { SPEC.liveMsg.textContent = `人工打字失败：${d.err}`; return false }
  SPEC.liveMsg.textContent = '打进去了；按回车才会发出去'
  return true
}

async function pressKey(key) {
  const label = key === 'Return' ? '回车（发送）' : '按键'
  if (!confirmHuman(`在微信当前窗口按${label}「${key}」`)) return
  const r = await local('/api/wx/key', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  const d = r.data || {}
  SPEC.liveMsg.textContent = d.err ? `人工按键失败：${d.err}` : `按了 ${key}`
}

// ---------- 允许说话 ----------

async function loadScope() {
  SPEC.wxSave.disabled = true
  const r = await local('/api/wx/scope')
  if (!r.ok) {
    SPEC.wxMsg.textContent = errorText(r)
    return
  }
  SPEC.scopeData = r.data || {}
  renderScopeNow(SPEC.scopeData)
}

function renderScopeNow(s) {
  const p = s.policy || {}
  const isBad = (n) => /\?\?|�/.test(String(n))
  const garbled = [...new Set([...(p.allowChats || []), ...(p.noMentionChats || [])].filter(isBad))]
  const names = [...(s.labels || [])]
  for (const n of p.allowChats || []) if (!names.includes(n) && !isBad(n)) names.push(n)
  const exempt = Array.isArray(p.noMentionChats) ? p.noMentionChats : []
  const names2 = [...new Set([...(s.labels || []), ...(p.allowChats || []), ...exempt])].filter((n) => !isBad(n))

  clear(SPEC.wxAllow)
  if (!names.length) SPEC.wxAllow.append(hint(s.ok ? '窗口里没读到会话名（先让微信停在有对话的界面）' : `微信检测没返回候选${s.err ? '：' + s.err : ''}`))
  for (const n of names) SPEC.wxAllow.append(scopeChip({ id: n, label: n, checked: (p.allowChats || []).includes(n) }))
  clear(SPEC.wxNoMention)
  if (!names2.length) SPEC.wxNoMention.append(hint(s.ok ? '还没有不用 @ 的会话' : '微信检测没读到会话，候选暂时为空'))
  for (const n of names2) SPEC.wxNoMention.append(scopeChip({ id: n, label: n, checked: exempt.includes(n) }))

  SPEC.wxEnabled.checked = p.enabled === true
  SPEC.wxMention.checked = p.requireMention !== false
  SPEC.wxWindow.value = p.mentionWindowMinutes ?? 3

  const sp = s.speaking
  SPEC.wxNow.textContent = sp ? `${sp.ok ? '现在能说' : '现在说不了'}：${sp.why}` : ''
  SPEC.wxNow.className = 'meta ' + (sp ? (sp.ok ? 'ok' : 'bad') : '')

  const bits = []
  bits.push(p.enabled
    ? ((p.allowChats || []).length ? `开 · ${(p.allowChats || []).length} 个会话` : '开 · 名单空着（她开不了口）')
    : '关着')
  if (s.current) bits.push(`当前停在「${s.current}」`)
  const tr = s.health?.tree
  if (tr && tr.status !== 'ok') bits.push(`⚠ ${tr.alert || `无障碍树状态 ${tr.status}`}`)
  if (s.health?.stale) bits.push(`⚠ 树落后于屏幕（自 ${fmtTime(s.health.stale.since)}）`)
  if (garbled.length) {
    bits.push(`⚠ 名单里有 ${garbled.length} 个会话名已坏成问号（${garbled.join('、')}），请重新勾选真名后保存`)
  }
  SPEC.wxMsg.textContent = bits.join(' · ')

  // 检测失败时 labels 不可信，保存会把页面上的默认值写回去，必须禁掉。
  SPEC.wxSave.disabled = !s.ok
}

async function saveScope() {
  SPEC.wxMsg.textContent = '保存中…'
  const r = await local('/api/wx/scope', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: SPEC.wxEnabled.checked,
      allowChats: picked(SPEC.wxAllow),
      requireMention: SPEC.wxMention.checked,
      mentionWindowMinutes: Number(SPEC.wxWindow.value),
      noMentionChats: picked(SPEC.wxNoMention),
    }),
  })
  const d = r.data || {}
  if (d.error || !r.ok) { SPEC.wxMsg.textContent = `没存上：${d.error || d.err || '接口没回话'}`; return }
  renderScopeNow({ ...SPEC.scopeData, policy: d.policy })
  SPEC.wxMsg.textContent = d.policy?.enabled
    ? `已保存：${(d.policy.allowChats || []).length} 个会话可以开口，立刻生效`
    : '已保存：微信这边关着'
}

// ---------- 维护 ----------

async function saveShot() {
  SPEC.maintMsg.textContent = '存图中…'
  const r = await local('/api/wx/save', { method: 'POST' })
  const d = r.data || {}
  SPEC.maintMsg.textContent = d.ok ? `存下了 ${d.file}；旧存档清了 ${d.pruned ?? 0} 张` : `没存上：${d.error || '没成'}`
  await loadFrames()
}

async function peek() {
  SPEC.maintMsg.textContent = '识别中…（要等一会儿）'
  const r = await local('/api/wx/peek')
  const d = r.data || {}
  SPEC.maintMsg.textContent = d.error
    ? `识别失败：${d.error}`
    : `CU 看到：${d.screen} · ${d.elements} 个元素 · 可输入 [${(d.editables || []).join(', ')}]`
}

async function closeExtra() {
  SPEC.maintMsg.textContent = '关…'
  const r = await local('/api/wx/close-extra', { method: 'POST' })
  const d = r.data || {}
  SPEC.maintMsg.textContent = d.error ? `没关成：${d.error}` : d.closed ? `关掉 ${d.closed} 个多余界面` : '没有多余界面了'
  SPEC.ctx?.refreshStatus?.()
}

async function scanChats() {
  SPEC.maintMsg.textContent = '正在扫…'
  const r = await local('/api/fish/wx/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: '{}',
  })
  const d = r.data || {}
  if (d.ok !== true) { SPEC.maintMsg.textContent = `补扫没成：${d.error || d.why || '上游拒绝'}`; return }
  SPEC.maintMsg.textContent = `补扫了 ${d.pages ?? 0} 页，记下 ${d.count ?? 0} 个会话${d.complete ? '（已经到底）' : '（没滚到底，过一会儿再试）'}`
}

async function gc() {
  if (!confirm('清理会真的删掉旧的截图存档和 /tmp 里一天前的图片。继续？')) return
  SPEC.maintMsg.textContent = '清理中…'
  const r = await local('/api/gc', { method: 'POST' })
  const d = r.data || {}
  if (d.error) { SPEC.maintMsg.textContent = `清理失败：${d.error}`; return }
  const u = d.usage || {}
  SPEC.maintMsg.textContent = `清理完：存档删 ${d.framesPruned} 张 · /tmp 删 ${d.tmpPruned}（剩 ${d.tmpLeft}）· cache ${u.cache || '—'} · 她 ${u.her || '—'}`
  await loadFrames()
}

async function loadFrames() {
  const r = await local('/api/frames')
  const files = r.data?.files || []
  SPEC.frames = files.slice(0, 8)
  clear(SPEC.thumbs)
  if (!SPEC.frames.length) { SPEC.thumbs.append(hint('还没有存档')); return }
  for (const name of SPEC.frames) {
    SPEC.thumbs.append(el('a', { href: '/api/frames/' + encodeURIComponent(name), target: '_blank', rel: 'noreferrer', title: name },
      el('img', { class: 'thumb', src: '/api/frames/' + encodeURIComponent(name), alt: name }),
    ))
  }
}

// ---------- 适配器契约 ----------

export const wx = {
  id: 'wx',
  label: '微信',
  order: 20,
  humanActions: ['type', 'key'],

  badge(status) {
    if (!status || !status.running) return 'bad'
    const tree = status.health?.tree
    if (tree && tree.status !== 'ok') return 'warn'
    return 'ok'
  },

  summary(status, ctx) {
    const lines = []
    if (!status) lines.push('状态还没读到')
    else {
      lines.push(status.running ? (status.label || '在跑') : '没在跑')
      const tree = status.health?.tree
      if (tree && tree.status !== 'ok') lines.push(`无障碍树 ${tree.status}（元素 ${tree.elements ?? '—'}）`)
      if (status.extra > 0) lines.push(`${status.extra} 个多余界面`)
    }
    return {
      lines,
      actions: [{ label: '去微信', onClick: () => ctx?.go?.('channels', 'wx') }],
    }
  },

  renderPanel(root, ctx) {
    if (SPEC.built && SPEC.root === root) {
      SPEC.ctx = ctx
      // 离开页面时退订了；重进要接回 3 秒一次的状态。
      subscribe(ctx)
      if (SPEC.section === 'live') startFrames()
      return
    }
    SPEC.built = false
    build(root, ctx)
  },

  async refresh(ctx) {
    SPEC.ctx = ctx
    applyStatus(ctx?.status)
    if (SPEC.section === 'scope') await loadScope()
    else if (SPEC.section === 'maint') await loadFrames()
  },

  leave() {
    stopFrames()
    SPEC.unsub?.()
    SPEC.unsub = null
  },
}
