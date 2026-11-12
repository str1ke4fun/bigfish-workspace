const $ = (s) => document.querySelector(s)
const state = { qq: null, wx: null, her: null, frames: [] }

function setDot(el, level) { el.className = 'dot' + (level ? ' ' + level : '') }

async function api(path, opts) {
  const r = await fetch(path, opts)
  const ct = r.headers.get('content-type') || ''
  if (ct.includes('json')) return r.json()
  return r
}

async function act(name, btn) {
  btn.disabled = true
  const old = btn.textContent
  btn.textContent = '…'
  try {
    const r = await api('/api/' + name, { method: 'POST' })
    if (r && r.error) console.warn(name, r.error)
  } catch (e) { console.warn(name, e) }
  btn.textContent = old
  btn.disabled = false
  poll()
}

document.querySelectorAll('button[data-act]').forEach((b) => {
  b.addEventListener('click', () => act(b.dataset.act, b))
})

$('#her-open').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true; btn.textContent = '…'
  try {
    const r = await api('/api/her/open')
    if (r.url) window.open(r.url, '_blank')
    else alert(r.error + (r.detail ? '\n' + r.detail : ''))
  } finally { btn.disabled = false; btn.textContent = '打开她的界面' }
})

$('#qq-panel').addEventListener('click', async () => {
  const r = await api('/api/qq/panel')
  window.open(r.panelUrl || r.url, '_blank')
})

$('#qq-copy').addEventListener('click', async () => {
  const r = await api('/api/qq/panel')
  try { await navigator.clipboard.writeText(r.token || '') } catch {}
  $('#qq-token').textContent = r.token || '(没读到)'
})

$('#qq-login').addEventListener('click', async () => {
  const r = await api('/api/qq/panel')
  window.open(r.loginUrl || r.url, '_blank')
})

// 打开工作台就把 token 显示出来（NapCat WebUI 登录要它）
async function loadPanel() {
  try {
    const r = await api('/api/qq/panel')
    $('#qq-token').textContent = r.token || '(没读到 webui.json)'
    $('#qq-token').title = `${r.base}/webui/ · 端口 ${r.port}`
  } catch {
    $('#qq-token').textContent = '(读不到)'
  }
}

// ---------- QQ 消息：像微信那样看画面做不到（QQ 的窗口是 10×10 未映射的壳），
// 但 OneBot 能给出更好的东西：会话列表 + 历史 + 以她的身份发话 ----------
const chat = { items: [], cur: null }

async function loadRecent() {
  try {
    const r = await api('/api/qq/recent')
    chat.items = r.items || []
    $('#chat-list').replaceChildren(...chat.items.map((it) => {
      const el = document.createElement('label')
      el.className = 'chip' + (chat.cur && chat.cur.id === it.id ? ' on' : '')
      el.dataset.kind = it.kind
      el.dataset.id = it.id
      el.innerHTML = `${it.kind === 'group' ? '群' : '私聊'} · <b>${escapeHtml(it.name)}</b>` +
        `<span class="id">${it.clock}</span>`
      el.title = it.last
      el.addEventListener('click', () => openChat(it))
      return el
    }))
    if (!chat.items.length) {
      $('#chat-list').innerHTML = '<span class="hint meta">还没有会话</span>'
    }
    $('#chat-summary').textContent = chat.items.length ? `${chat.items.length} 个会话` : '还没有会话'
  } catch {
    $('#chat-summary').textContent = '读不到'
  }
}

async function openChat(it) {
  chat.cur = it
  for (const el of document.querySelectorAll('#chat-list .chip')) {
    el.classList.toggle('on', el.dataset.id === it.id)
  }
  $('#chat-msgs').innerHTML = '<span class="hint meta">加载中…</span>'
  const r = await api(`/api/qq/history?kind=${it.kind}&id=${it.id}`)
  const box = $('#chat-msgs')
  if (!r.ok || !(r.items || []).length) {
    box.innerHTML = `<span class="hint meta">${r.ok ? '这里还没有消息' : escapeHtml(r.why || '读不到')}</span>`
    return
  }
  box.replaceChildren(...r.items.map((m) => {
    const el = document.createElement('div')
    el.className = 'msg' + (m.self ? ' me' : '')
    el.innerHTML = `<span class="who">${escapeHtml(m.who)} · ${m.clock}</span>` +
      `<span class="bubble">${escapeHtml(m.text)}</span>`
    return el
  }))
  box.scrollTop = box.scrollHeight
}

$('#chat-refresh').addEventListener('click', async () => {
  await loadRecent()
  if (chat.cur) await openChat(chat.cur)
})

$('#chat-send').addEventListener('click', async () => {
  const input = $('#chat-input')
  const text = input.value.trim()
  if (!text) return
  if (!chat.cur) { $('#chat-msg').textContent = '先点一个会话'; return }
  $('#chat-msg').textContent = '发送中…'
  const r = await api('/api/qq/send', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: chat.cur.kind, id: chat.cur.id, text }),
  })
  $('#chat-msg').textContent = r.ok ? '发出去了' : `失败：${r.why || '未知'}`
  if (r.ok) { input.value = ''; openChat(chat.cur) }
})

$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#chat-send').click()
})

// ---------- 说话范围 ----------
let scopeState = null

function chip(id, label, checked, onToggle) {
  const el = document.createElement('label')
  el.className = 'chip' + (checked ? ' on' : '')
  const box = document.createElement('input')
  box.type = 'checkbox'; box.checked = checked
  box.addEventListener('change', () => {
    el.classList.toggle('on', box.checked)
    onToggle(box.checked)
  })
  el.append(box, document.createTextNode(label))
  const idEl = document.createElement('span')
  idEl.className = 'id'; idEl.textContent = id
  el.append(idEl)
  return el
}

function renderScope(s) {
  scopeState = s
  const p = s.policy || {}
  const has = (arr, id) => (arr || []).map(String).includes(String(id))

  // 列出来的人都得能勾：既包括 NapCat 给的列表，也包括已经存进配置但列表里没有的号
  const friends = [...s.friends]
  for (const id of p.allowFrom || []) if (!friends.some((f) => f.id === String(id))) friends.push({ id: String(id), name: '（不在好友列表）' })
  const admins = [...s.friends]
  for (const id of p.adminUsers || []) if (!admins.some((f) => f.id === String(id))) admins.push({ id: String(id), name: '（不在好友列表）' })

  $('#scope-friends').replaceChildren(...(friends.length
    ? friends.map((f) => chip(f.id, f.name, has(p.allowFrom, f.id), () => {}))
    : [Object.assign(document.createElement('span'), { className: 'hint meta', textContent: '还没有好友可勾' })]))

  $('#scope-groups').replaceChildren(...((s.groups || []).length
    ? s.groups.map((g) => chip(g.id, `${g.name}（${g.count} 人）`, has(p.groupAllowFrom, g.id), () => {}))
    : [Object.assign(document.createElement('span'), { className: 'hint meta', textContent: s.online ? '这个 QQ 还没进任何群——把她拉进群，这里就会出现' : 'QQ 没在线，列不出群' })]))

  $('#scope-admins').replaceChildren(...(admins.length
    ? admins.map((f) => chip(f.id, f.name, has(p.adminUsers, f.id), () => {}))
    : [Object.assign(document.createElement('span'), { className: 'hint meta', textContent: '还没有好友可勾' })]))

  $('#scope-mention').checked = p.requireMention !== false
  const n = (p.allowFrom || []).length, g = (p.groupAllowFrom || []).length, a = (p.adminUsers || []).length
  $('#scope-summary').textContent = `私聊 ${n} 人 · 群 ${g} 个 · 管理员 ${a} 人 · ${p.requireMention !== false ? '群里要 @' : '群里不用 @'}`
  $('#scope-msg').textContent = s.bot ? `机器人 ${s.bot.user_id}「${s.bot.nickname}」· ${s.online ? 'OneBot 在线' : 'OneBot 未连'}` : ''
}

async function loadScope() {
  const s = await api('/api/qq/scope')
  renderScope(s)
}

function picked(sel) {
  return [...document.querySelectorAll(`${sel} .chip`)].filter((c) => c.querySelector('input').checked).map((c) => c.querySelector('.id').textContent)
}

/* ---------- QQ 掉线提醒（观察者）---------- */
async function loadWatch() {
  try {
    const r = await fetch('/api/watch').then((x) => x.json())
    const s = r.settings || {}
    const login = r.login || {}
    if (document.activeElement !== $('#watch-poll')) $('#watch-poll').value = s.pollSeconds ?? 15
    if (document.activeElement !== $('#watch-nag')) $('#watch-nag').value = s.nagMinutes ?? 10
    $('#watch-enabled').checked = s.enabled !== false
    $('#watch-recover').checked = s.notifyRecover !== false
    $('#watch-summary').textContent = s.enabled === false
      ? '关着'
      : `开 · 每 ${s.pollSeconds} 秒 · ${login.phase === 'kicked' ? 'QQ 现在掉着' : '看着呢'}${s.nagMinutes ? ` · ${s.nagMinutes} 分钟催一次` : ' · 只提醒一次'}`
  } catch { /* 服务刚起时可能还没响应 */ }
}
$('#watch-save').addEventListener('click', async () => {
  const body = {
    enabled: $('#watch-enabled').checked,
    pollSeconds: Number($('#watch-poll').value),
    nagMinutes: Number($('#watch-nag').value),
    notifyRecover: $('#watch-recover').checked,
  }
  const r = await fetch('/api/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
  $('#watch-msg').textContent = r.ok ? `已保存：每 ${r.settings.pollSeconds} 秒，${r.settings.nagMinutes ? r.settings.nagMinutes + ' 分钟催一次' : '只提醒一次'}` : '保存失败'
  loadWatch()
})
$('#watch-test').addEventListener('click', async () => {
  await fetch('/api/watch/test', { method: 'POST' })
  $('#watch-msg').textContent = '弹了一条测试通知'
})
/* ---------- 微信：允许说话 ---------- */
let wxScopeState = null

function renderWxScope(s) {
  wxScopeState = s
  const p = s.policy || {}
  // 坏成问号的名字不当候选摆出来（摆出来就是用户看到的那一排 ????），改成下面一行提醒
  const isBad = (n) => /\?\?|\uFFFD/.test(String(n))
  const garbled = [...new Set([...(p.allowChats || []), ...(p.noMentionChats || [])].filter(isBad))]
  const names = [...(s.labels || [])]
  for (const n of p.allowChats || []) if (!names.includes(n) && !isBad(n)) names.push(n)
  $('#wx-scope-chats').replaceChildren(...(names.length
    ? names.map((n) => chip(n, n, (p.allowChats || []).includes(n), () => {}))
    : [Object.assign(document.createElement('span'), { className: 'hint meta', textContent: s.ok ? '窗口里没读到会话名（先让微信停在有对话的界面）' : `微信检测没返回候选${s.err ? '：' + s.err : '（看一下工作台日志）'}` })]))
  const exempt = Array.isArray(p.noMentionChats) ? p.noMentionChats : []
  // 候选和上面「能开口的会话」同一个来源（微信侧栏读到的会话名），
  // 再把已经存过的名字并进来——微信没登录/读不到的时候也能看见自己勾过谁。
  const names2 = [...new Set([...(s.labels || []), ...(p.allowChats || []), ...exempt])].filter((n) => !isBad(n))
  $('#wx-nomention-chats').replaceChildren(...(names2.length
    ? names2.map((n) => chip(n, n, exempt.includes(n), () => {}))
    : [Object.assign(document.createElement('span'), { className: 'hint meta', textContent: s.ok ? '还没有不用 @ 的会话（微信读到会话后这里会出现候选）' : '微信检测没读到会话，候选暂时为空' })]))
  $('#wx-enabled').checked = p.enabled === true
  // 勾着也可能说不了（@ 窗口没开）——把这层直接写出来，免得看着像开关接反
  const sp = s.speaking || null
  $('#wx-now').textContent = sp ? `${sp.ok ? '现在能说' : '现在说不了'}：${sp.why}` : ''
  $('#wx-now').className = 'hint ' + (sp ? (sp.ok ? 'ok' : 'bad') : '')
  $('#wx-mention').checked = p.requireMention !== false
  $('#wx-mention-window').value = p.mentionWindowMinutes ?? 3
  const n = (p.allowChats || []).length
  $('#wx-scope-summary').textContent = p.enabled
    ? (n ? `开 · ${n} 个会话${p.requireMention === false ? '' : ' · @ 才回'}` : '开 · 名单空着（她开不了口）')
    : '关着'
  // 当前开着的会话 + 树是否落后于屏幕（由 dsh-wx 对账得出，写在 health.json）
  const bits = []
  if (s.current) bits.push(`微信当前停在「${s.current}」`)
  const tr = s.health?.tree
  if (tr && tr.status !== 'ok') bits.push(`⚠ ${tr.alert || `无障碍树状态 ${tr.status}（元素 ${tr.elements}、会话 ${tr.chats}）`}`)
  if (s.health?.stale) bits.push(`⚠ 树落后于屏幕（自 ${new Date(s.health.stale.since).toLocaleTimeString()}）`)
  if (garbled.length) bits.push(`⚠ 名单里有 ${garbled.length} 个会话名已坏成问号（${garbled.join('、')}），她对不上这些群。请在上面重新勾选真名后保存，坏的会被一并清掉`)
  $('#wx-scope-msg').textContent = bits.join(' · ')
}

async function loadWxScope() {
  const btn = $('#wx-scope-reload')
  btn.disabled = true; btn.textContent = '读…'
  try {
    const s = await api('/api/wx/scope')
    renderWxScope(s)
    // 只有真读到了才允许保存：不然页面上的勾还是 HTML 默认值，
    // 这时点保存等于把默认值（关）写回去——看着就像开关接反了。
    wxScopeState = s
    // s.ok 为 false 时 labels 不可信（脚本没回话/OCR 没读全），
    // 此时保存会把页面的默认值写回去，必须禁掉。
    $('#wx-scope-save').disabled = !s.ok
  } catch {
    wxScopeState = null
    $('#wx-scope-save').disabled = true
    $('#wx-scope-msg').textContent = '没读到微信的状态（先点「刷新候选」），这会儿保存会把按钮上的默认值写回去'
  } finally { btn.disabled = false; btn.textContent = '刷新候选' }
}

$('#wx-scope-reload').addEventListener('click', loadWxScope)

$('#wx-scope-add-btn').addEventListener('click', () => {
  const v = $('#wx-scope-add').value.trim()
  if (!v) return
  const p = { ...(wxScopeState?.policy || { enabled: false, allowChats: [] }) }
  p.allowChats = [...new Set([...(p.allowChats || []), v])]
  renderWxScope({ ...(wxScopeState || {}), policy: p })
  $('#wx-scope-add').value = ''
})

$('#wx-nomention-add-btn').addEventListener('click', () => {
  const v = $('#wx-nomention-add').value.trim()
  if (!v) return
  const p = { ...(wxScopeState?.policy || { enabled: false, allowChats: [] }) }
  p.noMentionChats = [...new Set([...(p.noMentionChats || []), v])]
  renderWxScope({ ...(wxScopeState || {}), policy: p })
  $('#wx-nomention-add').value = ''
})

$('#wx-scope-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true; btn.textContent = '保存中…'
  try {
    const body = {
      enabled: $('#wx-enabled').checked,
      allowChats: picked('#wx-scope-chats'),
      requireMention: $('#wx-mention').checked,
      mentionWindowMinutes: Number($('#wx-mention-window').value),
      // 之前漏了这一条：每次保存都把「不用 @」的名单清空，所以勾了也存不住
      noMentionChats: picked('#wx-nomention-chats'),
    }
    const r = await api('/api/wx/scope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (r.error) { alert(r.error); return }
    renderWxScope({ ...(wxScopeState || {}), policy: r.policy })
    $('#wx-scope-msg').textContent = r.policy.enabled
      ? `已保存：${r.policy.allowChats.length} 个会话可以开口，立刻生效（她在下一轮就能读到）`
      : '已保存：微信这边关着'
  } finally { btn.disabled = false; btn.textContent = '保存' }
})

$('#scope-reload').addEventListener('click', loadScope)

$('#scope-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true; btn.textContent = '保存中…'
  try {
    const body = {
      requireMention: !!$('#scope-mention')?.checked,
      allowFrom: picked('#scope-friends'),
      groupAllowFrom: picked('#scope-groups'),
      adminUsers: picked('#scope-admins'),
      dmPolicy: 'allowlist',
      groupPolicy: 'allowlist',
      restart: $('#scope-restart').checked,
    }
    const r = await api('/api/qq/scope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (r.error) { alert(r.error); return }
    $('#scope-msg').textContent = r.url
      ? '已保存并重启，她读了新配置。新地址已记在下面（旧标签页会 401）'
      : '已保存到 patch；下次重启生效'
    if (r.url) $('#scope-msg').insertAdjacentHTML('beforeend', ` · <a href="${r.url}" target="_blank" style="color:var(--accent)">打开她</a>`)
    renderScope({ ...scopeState, policy: r.policy })
  } finally { btn.disabled = false; btn.textContent = '保存' }
})

// ---------- 微信：点一下、打一句 ----------
$('#wx-shot').addEventListener('click', async (ev) => {
  const img = ev.currentTarget
  if (!img.naturalWidth) return
  const rect = img.getBoundingClientRect()
  const x = Math.round((ev.clientX - rect.left) * (img.naturalWidth / rect.width))
  const y = Math.round((ev.clientY - rect.top) * (img.naturalHeight / rect.height))
  await api('/api/wx/click', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x, y }) })
})

async function wxType(text) {
  if (!text) return
  await api('/api/wx/type', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
}
async function wxKey(key) {
  await api('/api/wx/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) })
}

$('#wx-send').addEventListener('click', async () => {
  const el = $('#wx-text')
  await wxType(el.value)
  el.value = ''
})
$('#wx-text').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') { e.preventDefault(); await wxType(e.currentTarget.value); e.currentTarget.value = '' }
})
$('#wx-enter').addEventListener('click', () => wxKey('Return'))
$('#wx-esc').addEventListener('click', () => wxKey('Escape'))

$('#wx-save').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  try {
    const r = await api('/api/wx/save', { method: 'POST' })
    if (r.error) alert(r.error)
  } finally { btn.disabled = false }
  loadFrames()
})

async function loadFrames() {
  const r = await api('/api/frames')
  state.frames = (r.files || []).slice(0, 8)
  $('#thumbs').innerHTML = state.frames
    .map((n) => `<a href="/api/frames/${encodeURIComponent(n)}" target="_blank" title="${n}"><img src="/api/frames/${encodeURIComponent(n)}" alt="${n}"></a>`)
    .join('')
}

$('#wx-peek').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true; btn.textContent = '…'
  try {
    const r = await api('/api/wx/peek')
    if (r.error) { alert(r.error); return }
    $('#wx-meta').textContent =
      `CU 看到：${r.screen} · ${r.elements} 个元素 · 可输入 [${(r.editables || []).join(', ')}] · ` +
      `bounds ${r.bounds?.width}×${r.bounds?.height} @ ${r.bounds?.x},${r.bounds?.y}`
  } finally { btn.disabled = false; btn.textContent = '识别界面' }
})

$('#wx-close-extra').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true; btn.textContent = '…'
  try {
    const r = await api('/api/wx/close-extra', { method: 'POST' })
    if (r.error) alert(r.error)
    else if (!r.closed) alert('没有多余界面了')
  } finally { btn.disabled = false; btn.textContent = '关掉多余界面' }
  poll()
})

$('#gc').addEventListener('click', async (e) => {
  const btn = e.currentTarget
  btn.disabled = true; btn.textContent = '…'
  try {
    const r = await api('/api/gc', { method: 'POST' })
    if (r.error) { alert(r.error); return }
    const u = r.usage || {}
    $('#wx-meta').textContent =
      `清理完：存档删 ${r.framesPruned} 张 · /tmp 删 ${r.tmpPruned}（剩 ${r.tmpLeft}）· ` +
      `cache ${u.cache} · cu-test ${u.cu} · 她 ${u.her} · 归档 ${u.archive}`
  } finally { btn.disabled = false; btn.textContent = '清理' }
  loadFrames()
})

// ---------- 画面：慢一点也没关系，别堆请求 ----------
let frameTimer = null
async function frameLoop() {
  if (document.hidden || !state.wx?.running) { frameTimer = setTimeout(frameLoop, 1500); return }
  const img = $('#wx-shot'), empty = $('#wx-empty')
  const url = '/api/wx/frame.jpg?t=' + Date.now()
  const probe = new Image()
  probe.onload = () => {
    img.src = url
    img.hidden = false
    empty.hidden = true
    $('#wx-meta').dataset.live = '1'
  }
  probe.onerror = () => {
    img.hidden = true; empty.hidden = false
    empty.textContent = '截不到图（Xvfb 或微信没起）'
  }
  probe.src = url
  frameTimer = setTimeout(frameLoop, 1000)
}

function refreshQr(qq) {
  const img = $('#qq-qr'), empty = $('#qq-empty')
  if (!qq.running || qq.loggedIn) {
    img.hidden = true; empty.hidden = false
    empty.textContent = !qq.running ? 'QQ 没在跑，点"启动"' : '已经登录了'
    return
  }
  const stamp = String(qq.qrAt || 0)
  if (img.dataset.at !== stamp) {
    img.dataset.at = stamp
    img.src = '/api/qq/qr?t=' + stamp
  }
  img.hidden = false; empty.hidden = true
  img.onerror = () => { img.hidden = true; empty.hidden = false; empty.textContent = '还没生成二维码，等几秒' }
}

async function poll() {
  let s
  try { s = await api('/api/status') } catch { $('#clock').textContent = '连不上服务'; return }
  state.qq = s.qq; state.wx = s.wx; state.her = s.her

  const kicked = s.qq.login?.phase === 'kicked'
  setDot($('#qq-dot'), kicked ? 'bad' : s.qq.loggedIn ? 'ok' : s.qq.running ? 'warn' : 'bad')
  $('#qq-label').textContent = kicked ? `掉线（${s.qq.login.since} 被踢）· 扫码` : s.qq.label
  $('#qq-meta').textContent = `WebUI ${s.qq.webui ? '开' : '关'} · OneBot ${s.qq.loggedIn ? '已连' : '未连'} · screen ${s.qq.screen ? '在' : '无'}`
    + (kicked ? ' · 手机登录把它顶下线了，扫下面这张码就回来（掉线会提醒）' : '')

  // 无障碍树的状态由 dsh-wx 写在 health.json：掉了/不完整时这里必须看得见，
  // 否则「耳朵没反应」看起来和「没人说话」一模一样。
  const tree = s.wx.health?.tree || null
  const treeBad = tree && tree.status !== 'ok'
  const treeText = !treeBad ? ''
    : tree.status === 'login'
      ? '无障碍树：微信在登录页，等人工登录'
      : tree.status === 'partial'
        ? `无障碍树不完整（元素 ${tree.elements}、会话 ${tree.chats}）：侧栏读不到`
        : `无障碍树掉了（元素 ${tree.elements}、会话 ${tree.chats}）：耳朵读不到微信`
  setDot($('#wx-dot'), !s.wx.running ? 'bad' : treeBad ? 'warn' : 'ok')
  $('#wx-label').textContent = s.wx.label
  const g = s.wx.geom || {}
  $('#wx-meta').textContent = `Xvfb ${s.wx.xvfb ? '开' : '关'} · 窗口 ${s.wx.window || '无'} · ${g.w || 0}×${g.h || 0} @ ${g.x || 0},${g.y || 0}` +
    (s.wx.extra > 0 ? ` · ⚠ 还有 ${s.wx.extra} 个多余界面，这里显示最大的` : '') +
    (treeText ? ` · ⚠ ${treeText}${tree.phase === 'init' ? '（初始化重试中）' : tree.phase === 'recover' ? '（微信重启后恢复中）' : tree.phase === 'steady' ? '（使用中：只提醒，不自动重启）' : ''}` : '')
  $('#wx-close-extra').hidden = !(s.wx.extra > 0)

  setDot($('#her-dot'), s.her.running ? 'ok' : 'bad')
  $('#her-label').textContent = s.her.label
  $('#her-meta').textContent = `事件 ${s.her.events} 条 · 最后写入 ${s.her.lastEventAt || '—'} · HTTP ${s.her.http}`

  $('#log-list').innerHTML = (s.log || []).map((r) =>
    `<li class="${r.ok ? '' : 'fail'}">${r.at} <b>${r.who}</b> ${escapeHtml(r.text)}</li>`).join('') || '<li>还没有动作</li>'

  loadWatch()

  $('#clock').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN')
  refreshQr(s.qq)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

// ---- 说话频率 ----
// 策略存在 WSL 的 /home/str1k3/dsh-plugins/speech/speech.json，两个通道每次发消息前现读，
// 所以这里保存完就是生效的，不需要重启 dsh-web。
async function loadSpeech() {
  const r = await fetch('/api/speech').then((x) => x.json()).catch(() => null)
  if (!r?.policy) { $('#speech-label').textContent = '读不到'; return }
  const p = r.policy
  $('#speech-enabled').checked = p.enabled
  $('#speech-gap').value = p.minGapSeconds
  $('#speech-permin').value = p.maxPerMinute
  $('#speech-perhour').value = p.maxPerHour
  $('#speech-label').textContent = p.enabled
    ? `间隔 ${p.minGapSeconds}s · ${p.maxPerMinute}/分 · ${p.maxPerHour}/时`
    : '不限'
  setDot($('#speech-dot'), p.enabled ? 'ok' : 'bad')
  const stats = r.stats || []
  $('#speech-stats').replaceChildren(...(stats.length === 0
    ? [Object.assign(document.createElement('span'), { className: 'meta', textContent: '最近一小时她还没说话' })]
    : stats.map((s) => {
      const el = document.createElement('span')
      el.className = 'chip'
      const who = s.chat.replace(/^wx:/, '微信·').replace(/^group:/, 'QQ群·').replace(/^private:/, 'QQ·')
      el.textContent = `${who}：一小时 ${s.lastHour} 条 · ${s.quietSeconds < 60 ? '刚刚' : Math.round(s.quietSeconds / 60) + ' 分钟前'}`
      return el
    })))
}

$('#speech-save').addEventListener('click', async () => {
  const body = {
    enabled: $('#speech-enabled').checked,
    minGapSeconds: Number($('#speech-gap').value),
    maxPerMinute: Number($('#speech-permin').value),
    maxPerHour: Number($('#speech-perhour').value),
  }
  const r = await fetch('/api/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((x) => x.json()).catch(() => null)
  if (!r?.ok) { $('#speech-msg').textContent = '没存上：' + (r?.err || '接口没回话'); return }
  $('#speech-msg').textContent = r.policy.enabled
    ? `已保存：间隔 ${r.policy.minGapSeconds} 秒 · 一分钟最多 ${r.policy.maxPerMinute} 条 · 一小时最多 ${r.policy.maxPerHour} 条（立刻生效）`
    : '已保存：不限'
  loadSpeech()
})
$('#speech-reload').addEventListener('click', loadSpeech)
poll()
setInterval(poll, 3000)
loadFrames()
frameLoop()
loadScope()
loadWxScope()
loadSpeech()
loadPanel()
loadRecent()

// ---------- 鱼：P0 只读 /api/fish/status ----------
// 文本一律走 textContent；上游返回什么就显示什么，工作台不复制业务状态。
function setView(view) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view))
  $('#view-channels').hidden = view !== 'channels'
  $('#view-fish').hidden = view !== 'fish'
  if (view === 'fish') loadFishStatus()
}

document.querySelectorAll('.tabs button').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view))
})

function fishError(text) {
  $('#fish-label').textContent = '读不到'
  $('#fish-detail').textContent = text
  setDot($('#fish-dot'), 'bad')
}

async function loadFishStatus() {
  $('#fish-msg').textContent = '读取中…'
  try {
    const r = await fetch('/api/fish/status', { headers: { accept: 'application/json' } })
    const ct = r.headers.get('content-type') || ''
    const data = ct.includes('json') ? await r.json() : { ok: false, error: 'BAD_RESPONSE' }
    if (!r.ok || data?.ok === false) {
      fishError(`${data?.error || r.status}${data?.upstreamStatus ? `（上游 ${data.upstreamStatus}）` : ''}`)
      $('#fish-msg').textContent = '没读到'
      return
    }
    renderFish(data)
  } catch {
    fishError('工作台连不上，或上游不可达')
    $('#fish-msg').textContent = '没读到'
  }
}

function renderFish(s) {
  $('#fish-label').textContent = s.label || s.phase || '—'
  $('#fish-detail').textContent = s.detail || ''
  const t = s.today || {}
  $('#fish-wakes').textContent = t.wakes ?? '—'
  $('#fish-idle').textContent = t.idleWakes ?? '—'
  $('#fish-browsed').textContent = t.browsed ?? '—'
  $('#fish-said').textContent = t.said ?? '—'
  $('#fish-comments').textContent = t.comments ?? '—'
  $('#fish-dairies').textContent = t.dairies ?? '—'
  $('#fish-raw').textContent = JSON.stringify(s, null, 2)
  setDot($('#fish-dot'), s.awake ? 'ok' : 'warn')
  $('#fish-msg').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN')
}

$('#fish-refresh').addEventListener('click', loadFishStatus)
