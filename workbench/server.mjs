// 工作台：把 QQ / 微信 / 鱼 透到浏览器里。
// 零依赖，node server.mjs 即可。只绑 127.0.0.1。
// 平台层只剩 Linux/WSL：host/linux.mjs 本机直跑；Windows 桌面交付已退役。
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path'
import { qqState, tailLines } from './qq-watch.mjs'
import { createHost } from './host/index.mjs'
import { createFishBff } from './fish/bff.mjs'

const PORT = Number(process.env.WORKBENCH_PORT || 8788)
const VERSION = process.env.WORKBENCH_VERSION || '0.1.0'
// 那台跑微信/QQ/她的机器的家目录。树莓派上设 WORKBENCH_HOME=/home/pi 就行。
const H = process.env.WORKBENCH_HOME || process.env.HOME || '/home/str1k3'
const HERE = dirname(fileURLToPath(import.meta.url))
// 运行数据与源码分开：frames/、watch.json 不再落在仓库目录里。
const DATA = process.env.WORKBENCH_DATA || join(H, '.fish-workbench')
const NAPCAT = `${H}/Napcat/opt/QQ/resources/app/app_launcher/napcat`
const HER_HEALTH = 'http://127.0.0.1:8710/'
// 人工“停止她”的免打扰窗口：看门狗读 ~/.dsh-wx/hold.json，所以这个文件不能搬到
// WORKBENCH_DATA；否则“停止她”会失效，看门狗下一轮就把她拉起来。
const HOLD = `${H}/.dsh-wx/hold.json`
const HOLD_SEC = 600
const setHold = (sec) => asHer(`mkdir -p ${H}/.dsh-wx && printf '{"until":%s,"reason":"workbench"}\\n' "$(( $(date +%s) + ${sec} ))" > ${H}/.dsh-wx/hold.json`)
// 微信"眼睛和手"。关多余界面复用耳朵自己的 clean（浮层、弹出的会话窗、黑框一套判断），
// 免得工作台和耳朵各写一份、还各漏一种。
const WX_SH = process.env.WX_SH || `${H}/dsh-plugins/dsh-wx/lib/wx.sh`

const log = []
function note(who, text, ok = true, extra = null) {
  const d = new Date()
  // extra 给人工代操作留结构化字段：{ operator:'human', channel, target, action }。
  const row = {
    at: [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'),
    who, text: String(text).slice(0, 300), ok, ...(extra || {}),
  }
  log.unshift(row)
  if (log.length > 80) log.pop()
  console.log(`[${row.at}] ${who} ${ok ? 'ok' : 'fail'} ${row.text}`)
  return row
}

// 平台层：Linux/WSL 上脏活就在本机跑。上层只认 host.sh / host.root /
// host.image / host.notify / host.keepalive。
const host = createHost({ appDir: HERE })
const asHer = (cmd, o) => host.sh(cmd, o)

// 鱼侧 BFF：阶段在 routes.mjs 里按表项登记，这里只决定现在开到哪一档。
// P0 只有 status；P1 开全部只读；P2 再开写。`WORKBENCH_PHASES=P0` 可以退回上一档。
const PHASES = String(process.env.WORKBENCH_PHASES || 'P0,P1,P2')
  .split(',').map((s) => s.trim()).filter(Boolean)
const fishBff = createFishBff({
  phases: PHASES,
  version: VERSION,
  entryOrigin: process.env.FISH_ENTRY_ORIGIN || 'http://127.0.0.1:8711',
  webOrigin: process.env.FISH_WEB_ORIGIN || 'http://127.0.0.1:8710',
})

/** 读 JSON 请求体（小体量，够用） */
function jsonBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
  })
}

// ---------- 截图存档：只存"想留的"，并按窗口滚动清理 ----------
const FRAMES = join(DATA, 'frames')
const KEEP_MAX = 120        // 最多留 120 张
const KEEP_DAYS = 7         // 超过 7 天的删掉

/** 本地时间当文件名，看着不别扭：2026-10-29T12-06-06.jpg */
function frameName(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.jpg`
}

async function listFrames() {
  try {
    const names = (await readdir(FRAMES)).filter((n) => n.endsWith('.jpg'))
    const rows = await Promise.all(
      names.map(async (n) => ({ n, t: await stat(join(FRAMES, n)).then((s) => s.mtimeMs).catch(() => 0) })),
    )
    return rows.sort((a, b) => b.t - a.t).map((r) => r.n) // 新 → 旧
  } catch { return [] }
}

async function saveFrame(name, buf) {
  await mkdir(FRAMES, { recursive: true })
  await writeFile(join(FRAMES, name), buf)
  return pruneFrames()
}

/** 按「最新 120 张 / 7 天」滚动清理，返回删掉几张 */
async function pruneFrames() {
  const rows = await Promise.all(
    (await listFrames()).map(async (n) => ({ n, t: await stat(join(FRAMES, n)).then((s) => s.mtimeMs).catch(() => 0) })),
  )
  const cutoff = Date.now() - KEEP_DAYS * 86400_000
  const drop = []
  rows.forEach((r, i) => {
    if (r.t < cutoff || i >= KEEP_MAX) drop.push(r.n)   // i 从新往旧数，超过上限的就是老的
  })
  for (const n of drop) { try { await unlink(join(FRAMES, n)) } catch {} }
  return drop.length
}
// ---------- 说话范围：谁能让大肥鱼开口 ----------
// 真源是 ${H}/dsh-plugins/qq/policy.json，改成 patch 行由 sync.mjs 负责；
// 期望的键：dmPolicy / groupPolicy / requireMention / allowFrom / groupAllowFrom / adminUsers
const QQ_DIR = `${H}/dsh-plugins/qq`

async function qqPolicy() {
  const r = await asHer(`cat ${QQ_DIR}/policy.json 2>/dev/null`)
  try {
    return JSON.parse(r.out)
  } catch {
    return { dmPolicy: 'allowlist', groupPolicy: 'allowlist', requireMention: true, adminUsers: [], allowFrom: [], groupAllowFrom: [] }
  }
}

/** 从 NapCat 要列表；QQ 没登录就返回空，不报错 */
async function onebot(action) {
  const r = await asHer(`node ${QQ_DIR}/onebot.mjs ${action}`, { timeout: 30_000 })
  const line = String(r.out).trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (!line) return { ok: false, data: null, why: r.err || '没回话' }
  try {
    const j = JSON.parse(line)
    return { ok: j.ok !== false, data: j.data ?? null, why: j.why }
  } catch {
    return { ok: false, data: null, why: '解析不了' }
  }
}

async function qqScope() {
  const [policy, groups, friends, me] = await Promise.all([
    qqPolicy(),
    onebot('get_group_list'),
    onebot('get_friend_list'),
    onebot('get_login_info'),
  ])
  const self = me.data?.user_id ? String(me.data.user_id) : ''
  const listOf = (x) => (Array.isArray(x.data) ? x.data : [])
  return {
    policy,
    bot: me.data?.user_id ? { user_id: String(me.data.user_id), nickname: me.data.nickname } : null,
    groups: listOf(groups).map((g) => ({ id: String(g.group_id), name: g.group_name, count: g.member_count })),
    friends: listOf(friends)
      .filter((f) => String(f.user_id) !== self)
      .map((f) => ({ id: String(f.user_id), name: f.remark || f.nickname || '' })),
    online: groups.ok && friends.ok,
  }
}

// ---------- 说话频率（QQ 和微信共用）----------
// 策略在 ${H}/dsh-plugins/speech/speech.json：dsh-wx 和 QQ 的 vendor 补丁每次都现读，
// 所以这里写完就生效，不用重启。状态文件只用来在面板上显示"最近说了几条"。
const SPEECH_DIR = `${H}/dsh-plugins/speech`
const SPEECH_DEFAULTS = { enabled: true, minGapSeconds: 25, maxPerMinute: 2, maxPerHour: 15 }

const clampNum = (v, def, lo, hi) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

async function speechPolicy() {
  const r = await asHer(`cat ${SPEECH_DIR}/speech.json 2>/dev/null || echo '{}'`)
  let j = {}
  try { j = JSON.parse(String(r.out).trim() || '{}') } catch { j = {} }
  return {
    enabled: j.enabled !== false,
    minGapSeconds: clampNum(j.minGapSeconds, SPEECH_DEFAULTS.minGapSeconds, 0, 3600),
    maxPerMinute: clampNum(j.maxPerMinute, SPEECH_DEFAULTS.maxPerMinute, 1, 1000),
    maxPerHour: clampNum(j.maxPerHour, SPEECH_DEFAULTS.maxPerHour, 1, 10000),
  }
}

async function speechStats() {
  const r = await asHer(`cat ${SPEECH_DIR}/speech-state.json 2>/dev/null || echo '{}'`)
  let state = {}
  try { state = JSON.parse(String(r.out).trim() || '{}') } catch { state = {} }
  const now = Date.now()
  const chats = state && typeof state.chats === 'object' && state.chats !== null ? state.chats : {}
  const out = []
  for (const [chat, times] of Object.entries(chats)) {
    const t = (Array.isArray(times) ? times : []).filter((x) => Number.isFinite(x) && now - x < 3600_000)
    if (t.length === 0) continue
    out.push({
      chat,
      lastHour: t.length,
      lastMinute: t.filter((x) => now - x < 60_000).length,
      quietSeconds: Math.round((now - Math.max(...t)) / 1000),
    })
  }
  return out.sort((a, b) => b.lastHour - a.lastHour)
}

async function saveSpeech(body) {
  const next = {
    enabled: body.enabled !== false,
    minGapSeconds: clampNum(body.minGapSeconds, SPEECH_DEFAULTS.minGapSeconds, 0, 3600),
    maxPerMinute: clampNum(body.maxPerMinute, SPEECH_DEFAULTS.maxPerMinute, 1, 1000),
    maxPerHour: clampNum(body.maxPerHour, SPEECH_DEFAULTS.maxPerHour, 1, 10000),
  }
  const payload = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8').toString('base64')
  const r = await asHer(`
    mkdir -p ${SPEECH_DIR}
    echo '${payload}' | base64 -d > ${SPEECH_DIR}/speech.json
  `)
  return { ok: r.ok, err: r.err, policy: next }
}
async function saveScope(body) {
  const clean = (a) => (Array.isArray(a) ? [...new Set(a.map((x) => String(x).trim()).filter(Boolean))] : [])
  const next = {
    dmPolicy: ['allowlist', 'open', 'disabled'].includes(body.dmPolicy) ? body.dmPolicy : 'allowlist',
    groupPolicy: ['allowlist', 'open', 'disabled'].includes(body.groupPolicy) ? body.groupPolicy : 'allowlist',
    requireMention: body.requireMention !== false,
    allowFrom: clean(body.allowFrom),
    groupAllowFrom: clean(body.groupAllowFrom),
    adminUsers: clean(body.adminUsers),
  }
  const payload = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8').toString('base64')
  const r = await asHer(`
    echo '${payload}' | base64 -d > ${QQ_DIR}/policy.json
    node ${QQ_DIR}/sync.mjs | tail -3
  `)
  let url = ''
  // 手改 patch 不会触发插件的热重载（那是设置页 RPC 的活），所以这里重启 dsh-web 让它读到新配置
  if (body.restart) {
    await asHer('sudo -n /usr/local/sbin/fish-ctl restart dsh-web.service')
    const t = await asHer('~/her-open.sh', { timeout: 60_000 })
    url = (String(t.out).match(/https?:\/\/\S+/) || [''])[0]
  }
  return { ok: r.ok, err: r.err, policy: next, applied: String(r.out).trim(), url }
}

// ---------- 微信：允许说话（开关 + 会话名单）----------
// 真源是 ${H}/.dsh-wx/policy.json，dsh-wx 插件每次调用都现读，改完立刻生效。
// 微信没有 QQ 那种"谁知道她"的通道层，所以这里的名单是**发消息前的闸**：
// 当前窗口里得能看见名单上的会话名，才允许 enter / 点「发送」。
const WX_POLICY = `${H}/.dsh-wx/policy.json`

async function wxPolicy() {
  const r = await asHer(`cat ${WX_POLICY} 2>/dev/null || echo '{}'`)
  try {
    const j = JSON.parse(String(r.out).trim() || '{}')
    return {
      enabled: j.enabled === true,
      allowChats: Array.isArray(j.allowChats) ? j.allowChats.map((s) => String(s)) : [],
      // @ 才回：和 QQ 那条 requireMention 是一个意思，只是微信只能按会话判
      requireMention: j.requireMention !== false,
      mentionWindowMinutes: clampNum(j.mentionWindowMinutes, 3, 1, 120),
      noMentionChats: Array.isArray(j.noMentionChats) ? j.noMentionChats.map((s) => String(s)) : [],
      // 耳朵开关和触发词不显示在面板上，但保存时必须原样带回去：
      // 以前这里重写整个文件，把 watch 丢了（默认变 true），把自定义 trigger 也丢了。
      watch: j.watch !== false,
      trigger: Array.isArray(j.trigger) ? j.trigger.map((s) => String(s)) : [],
    }
  } catch {
    return { enabled: false, allowChats: [], requireMention: true, mentionWindowMinutes: 3, noMentionChats: [], watch: true, trigger: [] }
  }
}

/** 会话候选：从无障碍树的标签里捞，去重后给她勾 */
async function wxScope() {
  const policy = await wxPolicy()
  // 候选只来自「会话列表」那一列（wx.sh chats 输出 JSON）。
  // 以前这里用一条按 tab 切的正则去捞整棵树的 label，格式改了之后要么什么都捞不到，
  // 要么把 Weixin / Contacts / Moments 这些按钮名当成"会话名"摆给人勾。
  const r = await asHer(`bash ${H}/dsh-plugins/dsh-wx/lib/wx.sh chats`, { timeout: 90_000 })
  let chats = []
  let current = ''
  let readOk = false
  try {
    const line = String(r.out).trim().split('\n').filter((l) => l.startsWith('{')).pop()
    const j = JSON.parse(line)
    readOk = j.ok === true
    current = String(j.current || '')
    chats = (j.chats || []).map((c) => String(c.name)).filter(Boolean)
  } catch { /* 读不出就当微信没起来 */ }
  // 现在这个会话到底能不能说？把几层闸合起来算给人看——不然「允许说话」勾着却发不出去，很像按钮接反了。
  const m = await asHer(`cat ${H}/.dsh-wx/mentions.json 2>/dev/null || echo '{}'`)
  let mentions = {}
  try { mentions = JSON.parse(String(m.out).trim() || '{}') } catch { mentions = {} }
  const last = Number(mentions[current]) || 0
  const leftMin = Math.ceil((last + policy.mentionWindowMinutes * 60_000 - Date.now()) / 60_000)
  const speaking = !policy.enabled
    ? { ok: false, why: '「允许说话」关着，微信的工具全部拒绝' }
    : !current
      ? { ok: false, why: '微信没停在任何会话上（先点开一个）' }
      : policy.noMentionChats.includes(current)
        ? { ok: true, why: `「${current}」在免 @ 白名单里（最高权限，随时能说）` }
        : !policy.allowChats.includes(current)
          ? { ok: false, why: `「${current}」不在允许名单里` }
          : policy.requireMention === false
            ? { ok: true, why: '没开 @ 规则，现在能说' }
            : leftMin > 0
              ? { ok: true, why: `被 @ 的窗口还开着，能说（还剩 ${leftMin} 分钟）` }
              : { ok: false, why: last ? `最近没人 @ 她（上一次是 ${Math.round((Date.now() - last) / 60_000)} 分钟前）` : '最近没人 @ 她' }
  const h = await asHer(`cat ${H}/.dsh-wx/health.json 2>/dev/null || echo '{}'`)
  let health = {}
  try { health = JSON.parse(String(h.out).trim() || '{}') } catch { health = {} }
  // 名单里已经坏掉的名字：前端会挑出来提醒，并且不当成会话候选摆出来
  const garbled = [...new Set([...policy.allowChats, ...policy.noMentionChats].filter(looksGarbled))]
  return { ok: r.ok && readOk, policy, labels: [...new Set(chats)].slice(0, 80), current, health, speaking, garbled, err: r.err }
}

/** 名字坏了：编码丢字时每个汉字会变成一个 "?"（或 U+FFFD）。真会话名里几乎不会出现连着的问号。 */
const looksGarbled = (s) => /\?\?|\uFFFD/.test(String(s))

async function saveWxScope(body) {
  const clean = (a) => (Array.isArray(a) ? [...new Set(a.map((x) => String(x).trim()).filter(Boolean))] : [])
  // 2026-10-30：名单文件被某次写入弄成了一排 "?"（汉字全丢），她从此对不上任何群名。
  // 这里宁可拒存，也不把坏名字再写进真源。
  const bad = [...clean(body.allowChats), ...clean(body.noMentionChats)].filter(looksGarbled)
  if (bad.length) {
    return { ok: false, error: `这几个会话名是乱码（汉字变成了问号），没有保存：${bad.join('、')}。去掉它们，或在候选里重新勾选真名后再存。`, policy: await wxPolicy() }
  }
  const before = await wxPolicy()
  const next = {
    enabled: body.enabled === true,
    allowChats: clean(body.allowChats),
    requireMention: body.requireMention !== false,
    mentionWindowMinutes: clampNum(body.mentionWindowMinutes, 3, 1, 120),
    noMentionChats: clean(body.noMentionChats),
    watch: typeof body.watch === 'boolean' ? body.watch : before.watch,
    trigger: clean(body.trigger).length ? clean(body.trigger) : before.trigger,
  }
  const payload = Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8').toString('base64')
  const r = await asHer(`
    mkdir -p ${H}/.dsh-wx
    echo '${payload}' | base64 -d > ${WX_POLICY}
    chown -R str1k3:str1k3 ${H}/.dsh-wx
    cat ${WX_POLICY}
  `)
  return { ok: r.ok, err: r.err, policy: next }
}

/** OneBot action with params（在 WSL 里跑，参数走单引号 JSON） */async function onebotCall(action, params = {}, timeout = 30_000) {
  const json = JSON.stringify(params).replace(/'/g, `'\\''`)
  const r = await asHer(`node ${QQ_DIR}/onebot.mjs ${action} '${json}'`, { timeout })
  const line = String(r.out).trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (!line) return { ok: false, why: r.err || '没回话' }
  try { return JSON.parse(line) } catch { return { ok: false, why: '解析不了' } }
}

const hhmm = (t) => {
  const d = new Date((Number(t) || 0) * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 把 OneBot 的 message 段拼成人能看的一行 */
function renderSegs(segs, selfId) {
  const nameOf = (id) => (String(id) === String(selfId) ? '@她' : `@${id}`)
  return (segs || []).map((s) => {
    const d = s.data || {}
    switch (s.type) {
      case 'text': return String(d.text ?? '')
      case 'at': return String(d.qq) === 'all' ? '@全体' : nameOf(d.qq)
      case 'image': return d.summary ? `[图片:${d.summary}]` : '[图片]'
      case 'face': return '[表情]'
      case 'reply': return '[回复]'
      case 'video': return '[视频]'
      case 'file': return `[文件:${d.name || d.file || ''}]`
      case 'forward': return '[合并转发]'
      case 'record': return '[语音]'
      default: return String(d.text ?? `[${s.type}]`)
    }
  }).join('')
}

async function qqRecent() {
  const r = await onebotCall('get_recent_contact', { count: 20 })
  if (!r.ok) return { ok: false, items: [], why: r.why }
  const self = String((await onebotCall('get_login_info')).data?.user_id ?? '')
  const items = (Array.isArray(r.data) ? r.data : []).map((c) => {
    const kind = Number(c.chatType) === 2 ? 'group' : 'private'
    const id = String(c.peerUin ?? c.peerUid ?? '')
    const m = c.lastestMsg || {}
    return {
      kind,
      id,
      name: String(c.peerName || c.sendNickName || id),
      last: renderSegs(m.message, self).slice(0, 60),
      at: Number(c.msgTime || m.time || 0),
      clock: hhmm(c.msgTime || m.time || 0),
    }
  }).filter((x) => x.id && (x.kind === 'group' || x.id !== self))
  return { ok: true, self, items }
}

async function qqHistory(kind, id, count = 30) {
  const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
  const params = kind === 'group' ? { group_id: Number(id), count } : { user_id: Number(id), count }
  const r = await onebotCall(action, params)
  if (!r.ok) return { ok: false, items: [], why: r.why }
  const self = String((await onebotCall('get_login_info')).data?.user_id ?? '')
  const raw = r.data?.messages ?? (Array.isArray(r.data) ? r.data : [])
  const items = raw.map((m) => ({
    id: String(m.message_id ?? ''),
    self: String(m.user_id) === self,
    who: String(m.sender?.card || m.sender?.nickname || m.user_id || ''),
    text: renderSegs(m.message, self),
    at: Number(m.time || 0),
    clock: hhmm(m.time),
    segs: Array.isArray(m.message) ? m.message.map((s) => s.type) : [],
  }))
  return { ok: true, self, items }
}

async function qqSend(kind, id, text, name = '') {
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const key = kind === 'group' ? 'group_id' : 'user_id'
  const r = await onebotCall(action, { [key]: Number(id), message: [{ type: 'text', data: { text } }] }, 45_000)
  const where = `${kind === 'group' ? '群' : '私聊'}${name ? `「${name}」` : ''} ${id}`
  note('qq', `人工代操作 · 以她的身份发到 ${where}：${text.slice(0, 20)}`, r.ok,
    { operator: 'human', channel: 'qq', target: where, action: 'send' })
  return { ok: r.ok, why: r.why, messageId: r.data?.message_id }
}

/** 把 `k=v` 行解析成对象 */
function kv(text) {
  const o = {}
  for (const line of String(text || '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return o
}

// ---------- 三块资源的状态 ----------

async function qqStatus() {
  const r = await asHer(`
    q=$(pgrep -c -f 'opt/QQ/qq' 2>/dev/null || true); q=\${q:-0}
    p=$(ss -ltn 2>/dev/null | grep -c ':6099' || true); p=\${p:-0}
    o=$(ss -ltn 2>/dev/null | grep -c ':3001' || true); o=\${o:-0}
    s=$(screen -ls 2>/dev/null | grep -c '\\.napcat' || true); s=\${s:-0}
    m=$(stat -c %Y ${NAPCAT}/cache/qrcode.png 2>/dev/null || echo 0)
    printf 'proc=%s\\nwebui=%s\\nonebot=%s\\nscreen=%s\\nqrmtime=%s\\n' "$q" "$p" "$o" "$s" "$m"
  `)
  const v = kv(r.out)
  const running = Number(v.proc) > 0
  const loggedIn = Number(v.onebot) > 0
  return {
    running,
    screen: Number(v.screen) > 0,
    webui: Number(v.webui) > 0,
    loggedIn,
    qrAt: Number(v.qrmtime) || 0,
    label: !running ? '没在跑' : loggedIn ? '在线' : '等扫码',
  }
}

// 微信有时候会多开一个顶层窗（比如那个渲染成纯黑的弹窗），
// 所以不能拿 `search | head -1` 当主窗——按面积挑最大的那个。
const WX_PICK = `
export DISPLAY=:99
BEST=""; AREA=0; BX=0; BY=0; BW=0; BH=0; CNT=0
for id in $(xdotool search --name 'Weixin' 2>/dev/null); do
  CNT=$((CNT+1))
  eval "$(xdotool getwindowgeometry --shell "$id" 2>/dev/null)" || continue
  a=$((WIDTH*HEIGHT))
  if [ "$a" -gt "$AREA" ]; then AREA=$a; BEST=$id; BX=$X; BY=$Y; BW=$WIDTH; BH=$HEIGHT; fi
done
`

async function wxStatus() {
  const r = await asHer(`${WX_PICK}
    n=$(pgrep -c -x wechat 2>/dev/null || true); n=\${n:-0}
    x=$(pgrep -c -x Xvfb 2>/dev/null || true); x=\${x:-0}
    w=$(DISPLAY=:99 xdotool getactivewindow getwindowname 2>/dev/null || true)
    # 「多余界面」不只叫 Weixin：弹出的会话窗标题是会话名、浮层标题可能是空的。
    # 按 class/名字都收一遍，只看可见的，再排掉主窗——和 wx.sh clean 的判据一致。
    e=0
    for id in $( (xdotool search --class wechat 2>/dev/null; xdotool search --name '^wechat$' 2>/dev/null) | sort -u); do
      [ "$id" = "$BEST" ] && continue
      DISPLAY=:99 xwininfo -id "$id" 2>/dev/null | grep -q 'Map State: IsViewable' || continue
      e=$((e+1))
    done
    printf 'proc=%s\\nxvfb=%s\\nwin=%s\\nwid=%s\\nx=%s\\ny=%s\\nw=%s\\nh=%s\\ncount=%s\\nextra=%s\\n' "$n" "$x" "$w" "$BEST" "$BX" "$BY" "$BW" "$BH" "$CNT" "$e"
  `)
  const v = kv(r.out)
  const running = Number(v.proc) > 0
  const count = Number(v.count) || 0
  const extra = Number(v.extra) || 0
  // 无障碍树的状态由 dsh-wx 每轮写在 health.json；这里只读文件，不额外碰微信。
  const h = await asHer(`cat ${H}/.dsh-wx/health.json 2>/dev/null || echo '{}'`)
  let health = {}
  try { health = JSON.parse(String(h.out).trim() || '{}') } catch { health = {} }
  return {
    running,
    xvfb: Number(v.xvfb) > 0,
    window: v.win || '',
    wid: v.wid || '',
    windows: count,
    // 非主窗、可见的窗口数：工作台据此露出「关掉多余界面」，关完就自己收回去。
    extra,
    geom: { x: Number(v.x) || 0, y: Number(v.y) || 0, w: Number(v.w) || 0, h: Number(v.h) || 0 },
    health: { at: health.at || '', stale: health.stale || null, tree: health.tree || null },
    // 微信窗口本来就没有标题（xdotool 读到的名字是空的），所以按「有没有窗口」判，别按名字判，
    // 否则界面会一直显示「进程在，没窗口」，看着像微信挂了
    label: running ? (count > 0 ? '在线' + (v.win ? `（${v.win}）` : '') : '进程在，没窗口') : '没在跑',
  }
}

async function herStatus() {
  const r = await asHer(`
    a=$(systemctl is-active dsh-web 2>/dev/null || true)
    h=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 ${HER_HEALTH} 2>/dev/null || echo 000)
    e=$(wc -l < ${H}/.dsh-fish/events.jsonl 2>/dev/null || echo 0)
    d=$(date -r ${H}/.dsh-fish/events.jsonl '+%m-%d %H:%M' 2>/dev/null || true)
    printf 'service=%s\\nhttp=%s\\nevents=%s\\nlast=%s\\n' "$a" "$h" "$e" "$d"
  `)
  const v = kv(r.out)
  return {
    running: v.service === 'active',
    http: v.http,
    events: Number(v.events) || 0,
    lastEventAt: v.last || '',
    label: v.service === 'active' ? '在跑' : '没在跑',
  }
}

// ---------- QQ 掉线：认日志 + 提醒 ----------
// 手机 QQ 一上线就把 Linux 这边顶掉（日志里是 [KickedOffLine] 你的账号当前登录已失效），
// 之后本地票据一起作废，只能扫码。这里按设置轮询日志，掉了就提醒并把新二维码丢到工作区，
// 免得"她哑了"要你自己发现。
const QQ_LOG = `${H}/napcat-console.log`
const WATCH_PATH = join(DATA, 'watch.json')
const WATCH_DEFAULTS = { enabled: true, pollSeconds: 15, nagMinutes: 10, notifyRecover: true }
const clampInt = (v, d, lo, hi) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
function readWatch() {
  try {
    const j = JSON.parse(readFileSync(WATCH_PATH, 'utf8'))
    return {
      enabled: j.enabled !== false,
      pollSeconds: clampInt(j.pollSeconds, WATCH_DEFAULTS.pollSeconds, 5, 300),
      nagMinutes: clampInt(j.nagMinutes, WATCH_DEFAULTS.nagMinutes, 0, 180),
      notifyRecover: j.notifyRecover !== false,
    }
  } catch { return { ...WATCH_DEFAULTS } }
}
function saveWatch(raw) {
  const cur = readWatch()
  const next = {
    enabled: raw.enabled === undefined ? cur.enabled : raw.enabled === true,
    pollSeconds: clampInt(raw.pollSeconds ?? cur.pollSeconds, cur.pollSeconds, 5, 300),
    nagMinutes: clampInt(raw.nagMinutes ?? cur.nagMinutes, cur.nagMinutes, 0, 180),
    notifyRecover: raw.notifyRecover === undefined ? cur.notifyRecover : raw.notifyRecover === true,
  }
  mkdirSync(DATA, { recursive: true })
  writeFileSync(WATCH_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}
let qqLogin = { phase: 'unknown', at: null, since: null }
let qqKickToastedAt = 0
let qqKickRound = 0

const hhmm2 = (d) => (d ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—')

async function checkQqLogin(cfg = readWatch()) {
  const r = await asHer(`grep -aE 'KickedOffLine|二维码已被扫描|账号状态变更为在线|账号上线' ${QQ_LOG} | tail -6`, { timeout: 20_000 })
  const st = qqState(tailLines(r.out, 20))
  const was = qqLogin.phase
  qqLogin = { phase: st.phase, at: st.at ? st.at.toISOString() : null, since: st.at ? hhmm2(st.at) : null }

  if (st.phase === 'kicked') {
    const first = was !== 'kicked'
    const nag = cfg.nagMinutes > 0 && Date.now() - qqKickToastedAt > cfg.nagMinutes * 60_000
    if (first || nag) {
      qqKickToastedAt = Date.now()
      qqKickRound = first ? 1 : qqKickRound + 1
      await asHer(`${H}/napcat-ctl.sh qr`, { timeout: 30_000 }).catch(() => null)
      const mins = st.at ? Math.round((Date.now() - st.at.getTime()) / 60_000) : 0
      host.notify('QQ 掉线了 · 扫码救她', `${hhmm2(st.at)} 被踢下线（手机登录顶的），已经 ${mins} 分钟。工作台 QQ 卡片里有新二维码，或扫 qq/qq-qrcode.png。`)
      note('qq', `QQ 被踢下线（${hhmm2(st.at)}），等你扫码`, false)
    }
    return
  }

  if (st.phase === 'online' && was === 'kicked' && cfg.notifyRecover) {
    host.notify('QQ 回来了', `${hhmm2(st.at)} 登录成功，她又能说话了。`)
    note('qq', `QQ 恢复登录（${hhmm2(st.at)}）`, true)
  }
}

let watchTimer = null
async function watchLoop(first = false) {
  const cfg = readWatch()
  try {
    if (first || cfg.enabled) await checkQqLogin(cfg)
  } catch { /* WSL 没起来之类，下一轮再来 */ }
  watchTimer = setTimeout(() => { watchLoop(false) }, Math.max(5, cfg.pollSeconds) * 1000)
  watchTimer.unref?.()
}
async function status() {
  const [qq, wx, her] = await Promise.all([qqStatus(), wxStatus(), herStatus()])
  return { at: new Date().toISOString(), qq: { ...qq, login: qqLogin }, wx, her, log: log.slice(0, 20) }
}

// ---------- 动作 ----------

const actions = {
  'qq/start': async () => {
    const r = await asHer(`${H}/napcat-ctl.sh start`)
    note('qq', r.out || r.err || 'started', /started|already/.test(r.out))
    return r
  },
  'qq/stop': async () => {
    const r = await asHer(`${H}/napcat-ctl.sh stop`)
    note('qq', r.out || r.err || 'stopped', true)
    return r
  },
  'qq/restart': async () => {
    const r = await asHer(`${H}/napcat-ctl.sh restart`)
    note('qq', 'restart', true)
    return r
  },
  'wx/start': async () => {
    // 只让 systemd 拉起。工作台再 setsid 一份会变成第二个监管者：system 单元随后退出（255），
    // 微信陷入崩溃循环（2026-11-04 事故）。Xvfb 也由 xvfb-fish.service 管。
    const r = await asHer(`
      sudo -n /usr/local/sbin/fish-ctl start xvfb-fish.service wechat-fish.service
      sleep 2
      pgrep -c -x wechat || true
    `)
    note('wx', `start → ${String(r.out).trim()} 个进程`, r.ok)
    return r
  },
  'wx/stop': async () => {
    // 停单元而不是 pkill：直接杀进程会被 Restart=always 立刻拉回来。
    const r = await asHer(`sudo -n /usr/local/sbin/fish-ctl stop wechat-fish.service; sleep 1; pgrep -c -x wechat || echo 0`)
    note('wx', `stopped → 还剩 ${String(r.out).trim()} 个`, r.ok)
    return r
  },
  'her/start': async () => {
    // 人工启动 = 解除 hold：把 until 写成当前时间，看门狗下一轮即恢复常驻语义。
    await setHold(0)
    const r = await asHer('sudo -n /usr/local/sbin/fish-ctl start dsh-web.service && sleep 1 && systemctl is-active dsh-web.service')
    note('her', `start → ${String(r.out).trim()}（已解除 hold）`, r.ok)
    return r
  },
  'her/stop': async () => {
    // 先放 hold 再停；写失败也照停，但会记一笔，免得以为按了就能停住。
    const h = await setHold(HOLD_SEC)
    if (!h.ok) note('her', `hold 写入失败：${h.err}`, false)
    const r = await asHer('sudo -n /usr/local/sbin/fish-ctl stop dsh-web.service && echo stopped')
    note('her', `stopped（hold ${HOLD_SEC / 60} 分钟）`, r.ok && h.ok)
    return r
  },
}

// ---------- HTTP：Host / Origin / 静态文件边界 ----------

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'"
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

let listenPort = PORT > 0 ? PORT : 0

export function allowedHosts(port = listenPort) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`])
}

export function hostAllowed(host, port = listenPort) {
  return typeof host === 'string' && allowedHosts(port).has(host)
}

export function originAllowed(origin, port = listenPort) {
  if (!origin) return true
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

/** 只服务 index.html 与 assets/；先 resolve 再 relative，拒绝穿越与符号链接逃逸。 */
export function resolveStatic(pathname, root = HERE) {
  if (pathname === '/' || pathname === '/index.html') return join(root, 'index.html')
  if (!pathname.startsWith('/assets/')) return null
  if (/%(2f|5c|00)/i.test(pathname)) return null
  if (pathname.includes('\\') || pathname.includes('\0')) return null
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('..')) return null
  const target = resolve(root, '.' + decoded)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  if (!rel.split(sep).includes('assets')) return null
  return target
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
  const headers = {
    'content-type': type,
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (String(type).startsWith('text/html')) headers['content-security-policy'] = CSP
  res.writeHead(code, headers)
  res.end(buf)
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const p = url.pathname
  if (server.listening) {
    const addr = server.address()
    if (addr && typeof addr === 'object') listenPort = addr.port
  }

  try {
    // 所有请求都校验 Host：防 DNS rebinding。
    if (!hostAllowed(req.headers.host)) return send(res, 403, { error: 'bad host' })

    const method = req.method || 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') {
        return send(res, 403, { error: 'cross-site write rejected' })
      }
      if (!originAllowed(req.headers.origin)) return send(res, 403, { error: 'bad origin' })
    }

    const file = resolveStatic(p, HERE)
    if (file) {
      try {
        if (p !== '/' && p !== '/index.html' && !(await stat(file)).isFile()) return send(res, 404, { error: 'not found' })
        const ext = file.slice(file.lastIndexOf('.'))
        return send(res, 200, await readFile(file), STATIC_TYPES[ext] || 'application/octet-stream')
      } catch {
        return send(res, 404, { error: 'not found' })
      }
    }

    // 鱼侧管理流量：唯一入口，浏览器只看到 /api/fish/*。
    if (p === '/api/fish' || p.startsWith('/api/fish/')) {
      return await fishBff.handle(req, res, url)
    }

    if (p === '/api/status') return send(res, 200, await status())
    // 总览的「动作日志」：只读最近 20 条，不触发任何检查。
    if (p === '/api/status.log') return send(res, 200, { rows: log.slice(0, 20) })
    if (p === '/api/watch' && req.method === 'GET') {
      return send(res, 200, { ok: true, settings: readWatch(), login: qqLogin })
    }
    if (p === '/api/watch' && req.method === 'POST') {
      const raw = await jsonBody(req)
      const settings = saveWatch(raw || {})
      note('qq', `掉线提醒设置：${settings.enabled ? '开' : '关'} · 每 ${settings.pollSeconds} 秒看一次 · ${settings.nagMinutes ? `${settings.nagMinutes} 分钟催一次` : '只提醒一次'}`)
      return send(res, 200, { ok: true, settings })
    }
    if (p === '/api/watch/test' && req.method === 'POST') {
      host.notify('掉线提醒测试', '能看到这条，说明通知这条路是通的。')
      return send(res, 200, { ok: true })
    }

    if (p === '/api/qq/qr') {
      const r = await host.image(`cat ${NAPCAT}/cache/qrcode.png 2>/dev/null`)
      if (!r.ok) return send(res, 404, { error: '现在没有二维码' })
      return send(res, 200, r.buf, 'image/png')
    }

    if (p === '/api/wx/frame.jpg') {
      // 截面积最大的那个 Weixin 窗口（弹窗/黑窗会被跳过）
      const r = await host.image(
        `${WX_PICK} if [ -n "$BEST" ]; then import -window "$BEST" -quality 65 jpg:- 2>/dev/null; ` +
          `else import -window root -quality 65 -resize 1100x jpg:- 2>/dev/null; fi`,
        { timeout: 25_000 },
      )
      if (!r.ok) return send(res, 404, { error: '截不到图：微信或 Xvfb 没在跑' })
      return send(res, 200, r.buf, 'image/jpeg')
    }

    if (p === '/api/wx/close-extra' && req.method === 'POST') {
      // 关掉主窗之外的一切：黑框直接 unmap，弹出的会话窗点自己的 ✕，小浮层也关。
      // 这套判断在耳朵的 wx.sh clean 里（主窗按面积挑，永远不碰），这里复用同一份。
      const r = await asHer(`bash ${JSON.stringify(WX_SH)} clean 2>&1`)
      const text = String(r.out || '').trim()
      const m = text.match(/关掉 (\d+) 个浮层，(\d+) 个弹出的会话窗/)
      if (!m) {
        note('wx', `关多余界面失败：${text.slice(-160) || '没有输出'}`, false)
        return send(res, 500, { error: text.slice(-300) || '清理没有返回结果' })
      }
      const floaters = Number(m[1])
      const popups = Number(m[2])
      const closed = floaters + popups
      note('wx', `关掉 ${closed} 个多余界面`, true)
      return send(res, 200, { ok: true, closed, floaters, popups })
    }

    if (p === '/api/wx/windows') {
      // 看看微信到底开了几个顶层窗，各自多大、是不是全黑
      const r = await asHer(`${WX_PICK}
        for id in $(xdotool search --name 'Weixin' 2>/dev/null); do
          eval "$(xdotool getwindowgeometry --shell "$id" 2>/dev/null)" || continue
          printf 'win=%s pos=%s,%s size=%sx%s\\n' "$id" "$X" "$Y" "$WIDTH" "$HEIGHT"
        done
      `)
      return send(res, 200, { text: String(r.out).trim() })
    }

    if (p === '/api/wx/peek') {
      // 走 CU 的驱动（@trycua/cua-driver）读无障碍树：它看到的是「语义」，跟画面互补
      const r = await asHer(
        'export DISPLAY=:99; export XDG_RUNTIME_DIR=/run/user/1000; ' +
          `cd ${H}/cu-test && node peek-wx.mjs 2>/dev/null`,
        { timeout: 90_000 },
      )
      const line = String(r.out).trim().split('\n').filter((l) => l.startsWith('{')).pop()
      if (!line) {
        note('wx', '识别界面失败', false)
        return send(res, 502, { error: 'CU 驱动没回话', detail: r.err })
      }
      const info = JSON.parse(line)
      if (info.ok) note('wx', `界面：${info.screen}（${info.elements} 个元素）`, true)
      return send(res, 200, info)
    }

    if (p === '/api/diagnostics' && req.method === 'GET') {
      // Read-only fixed-source diagnostics. Never accept arbitrary paths or commands.
      const [services, processes, logs] = await Promise.all([
        asHer("for s in dsh-web wechat-fish xvfb-fish; do printf '%s=' \"$s\"; systemctl is-active \"$s\" 2>/dev/null || true; done", { timeout: 10000 }),
        asHer("ps -eo pid=,comm=,args= | grep -E '[w]echat|[W]eixin|[X]vfb|[d]sh web|[w]orkbench/server' | awk '{print $1, $2}' | head -40", { timeout: 10000 }),
        asHer("for f in /home/str1k3/dsh-web.log /home/str1k3/workbench.log; do if [ -r \"$f\" ]; then echo \"--- $f ---\"; tail -n 100 \"$f\" | grep -Ei 'dsh-wx|wechat|weixin|cua|at-spi|ocr|error|failed|warn' | tail -n 60; fi; done", { timeout: 10000 }),
      ])
      const wx = await asHer(`export DISPLAY=:99; export XDG_RUNTIME_DIR=/run/user/1000; cd ${H}/cu-test && node peek-wx.mjs 2>/dev/null`, { timeout: 30000 })
      const screenshot = await host.image(`${WX_PICK} if [ -n "$BEST" ]; then import -window "$BEST" png:- 2>/dev/null; fi`, { timeout: 15000 })
      const line = String(wx.out).trim().split('\n').filter((l) => l.startsWith('{')).pop()
      let ocr = null
      try { ocr = JSON.parse(line || 'null') } catch {}
      const processRows = processes.out.trim().split('\n').filter(Boolean).map((x) => {
        const [pid, name] = x.trim().split(/\s+/, 2)
        return { pid, name }
      })
      return send(res, 200, { at: new Date().toISOString(), services: services.out.trim().split('\n').filter(Boolean), processes: processRows, ocr, screenshot: screenshot.ok ? screenshot.buf.toString('base64') : null, screenshotType: screenshot.ok ? 'image/png' : null, logs: logs.out.slice(-24000) })
    }

    if (p === '/api/wx/save') {
      const r = await host.image(
        `${WX_PICK} if [ -n "$BEST" ]; then import -window "$BEST" -quality 80 jpg:- 2>/dev/null; ` +
          `else import -window root -quality 80 jpg:- 2>/dev/null; fi`,
      )
      if (!r.ok) return send(res, 404, { error: '截不到图' })
      const name = frameName()
      const pruned = await saveFrame(name, r.buf)
      return send(res, 200, { ok: true, file: name, pruned })
    }

    if (p === '/api/wx/click' && req.method === 'POST') {
      const body = await jsonBody(req)
      const x = Number(body.x), y = Number(body.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return send(res, 400, { error: '要给 x/y' })
      const r = await asHer(`${WX_PICK}
        xdotool mousemove $((BX + ${Math.round(x)})) $((BY + ${Math.round(y)})) click 1
      `)
      note('wx', `点击 (${Math.round(x)}, ${Math.round(y)})`, r.ok)
      return send(res, 200, { ok: r.ok, err: r.err })
    }

    if (p === '/api/wx/type' && req.method === 'POST') {
      const body = await jsonBody(req)
      const text = String(body.text ?? '')
      if (!text) return send(res, 400, { error: '要给 text' })
      const safe = text.replace(/'/g, `'\\''`).slice(0, 500)
      const r = await asHer(`${WX_PICK}
        [ -n "$BEST" ] && xdotool windowfocus "$BEST" 2>/dev/null
        xdotool type --delay 25 -- '${safe}'
      `)
      note('wx', `人工代操作 · 在微信当前窗口输入 ${text.slice(0, 20)}`, r.ok,
        { operator: 'human', channel: 'wx', target: '当前窗口', action: 'type' })
      return send(res, 200, { ok: r.ok, err: r.err })
    }

    if (p === '/api/wx/key' && req.method === 'POST') {
      const body = await jsonBody(req)
      const key = String(body.key ?? 'Return').replace(/[^A-Za-z0-9_+\-]/g, '')
      const r = await asHer(`${WX_PICK}
        [ -n "$BEST" ] && xdotool windowfocus "$BEST" 2>/dev/null
        xdotool key --clearmodifiers '${key}'
      `)
      note('wx', `人工代操作 · 在微信当前窗口按键 ${key}`, r.ok,
        { operator: 'human', channel: 'wx', target: '当前窗口', action: `key:${key}` })
      return send(res, 200, { ok: r.ok, err: r.err })
    }

    if (p === '/api/qq/recent') {
      return send(res, 200, await qqRecent())
    }

    if (p === '/api/qq/history') {
      const u = new URL(req.url, 'http://x')
      const kind = u.searchParams.get('kind') === 'group' ? 'group' : 'private'
      const id = String(u.searchParams.get('id') || '').replace(/\D/g, '')
      if (!id) return send(res, 400, { error: '要 id' })
      return send(res, 200, await qqHistory(kind, id, 30))
    }

    if (p === '/api/qq/send' && req.method === 'POST') {
      const b = await jsonBody(req)
      const kind = b.kind === 'group' ? 'group' : 'private'
      const id = String(b.id || '').replace(/\D/g, '')
      const text = String(b.text || '').slice(0, 500)
      const name = String(b.name || '').slice(0, 40)
      if (!id || !text) return send(res, 400, { error: '要 id 和 text' })
      return send(res, 200, await qqSend(kind, id, text, name))
    }

    if (p === '/api/qq/scope' && req.method !== 'POST') {
      return send(res, 200, await qqScope())
    }

    if (p === '/api/qq/scope' && req.method === 'POST') {
      const body = await jsonBody(req)
      const r = await saveScope(body)
      const n = `${r.policy.allowFrom.length} 人 / ${r.policy.groupAllowFrom.length} 群`
      note('qq', `说话范围已存：${n}${r.policy.requireMention ? ' · 群里要 @' : ''}`, r.ok)
      return send(res, r.ok ? 200 : 500, r)
    }

    if (p === '/api/wx/scope' && req.method !== 'POST') {
      return send(res, 200, await wxScope())
    }

    if (p === '/api/wx/scope' && req.method === 'POST') {
      const body = await jsonBody(req)
      const r = await saveWxScope(body)
      note('wx', `允许说话已存：${r.policy.enabled ? '开' : '关'} · ${r.policy.allowChats.length} 个会话`, r.ok)
      return send(res, r.ok ? 200 : 500, r)
    }

    if (p === '/api/speech') {
      const policy = await speechPolicy()
      if (req.method !== 'POST') return send(res, 200, { ok: true, policy, stats: await speechStats() })
      const body = await jsonBody(req)
      const saved = await saveSpeech(body)
      note('speech', `说话频率：间隔 ${saved.policy.minGapSeconds}s · ${saved.policy.maxPerMinute}/分 · ${saved.policy.maxPerHour}/时${saved.policy.enabled ? '' : '（已关）'}`, saved.ok)
      return send(res, 200, { ...saved, stats: await speechStats() })
    }
    if (p === '/api/qq/panel') {
      // NapCat WebUI 要 token：真值在 webui.json 里（明文），登录页支持 ?token= 直接带过去
      const r = await asHer(`
        c=${NAPCAT}/config/webui.json
        t=$(jq -r .token "$c" 2>/dev/null)
        p=$(jq -r .port "$c" 2>/dev/null)
        echo "token=$t"
        echo "port=\${p:-6099}"
      `)
      const v = kv(r.out)
      const port = v.port || '6099'
      const base = `http://127.0.0.1:${port}`
      const enc = encodeURIComponent(v.token || '')
      note('qq', `WebUI token ${v.token ? '读到了' : '没读到'}`, !!v.token)
      return send(res, 200, {
        token: v.token || '',
        port,
        base,
        url: `${base}/webui/`,
        panelUrl: `${base}/webui/?token=${enc}`,
        loginUrl: `${base}/webui/web_login?token=${enc}`,
      })
    }

    if (p === '/api/frames') {
      return send(res, 200, { files: await listFrames() })
    }

    if (p === '/api/gc') {
      // 工作台的存档 + CU 落在 /tmp 的截图（比 1 天旧的删掉），再报一下各处占用
      const pruned = await pruneFrames()
      const r = await asHer(`
        n=0
        for f in /tmp/*.png /tmp/*.jpg; do
          [ -f "$f" ] || continue
          if [ -n "$(find "$f" -mtime +1 2>/dev/null)" ]; then rm -f "$f"; n=$((n+1)); fi
        done
        echo "tmp_pruned=$n"
        echo "tmp_left=$(ls /tmp/*.png /tmp/*.jpg 2>/dev/null | wc -l)"
        echo "cache=$(du -sh ${H}/.cache 2>/dev/null | cut -f1)"
        echo "cu=$(du -sh ${H}/cu-test 2>/dev/null | cut -f1)"
        echo "her=$(du -sh ${H}/.dsh-fish 2>/dev/null | cut -f1)"
        echo "arch=$(du -sh ${H}/.dsh-fish.archive-20261029 2>/dev/null | cut -f1)"
      `)
      const v = kv(r.out)
      note('gc', `存档删 ${pruned} 张；/tmp 删 ${v.tmp_pruned || 0} 张`, true)
      return send(res, 200, {
        ok: true,
        framesPruned: pruned,
        tmpPruned: Number(v.tmp_pruned) || 0,
        tmpLeft: Number(v.tmp_left) || 0,
        usage: { cache: v.cache, cu: v.cu, her: v.her, archive: v.arch },
      })
    }

    if (p.startsWith('/api/frames/')) {
      const name = decodeURIComponent(p.slice('/api/frames/'.length))
      if (!/^[\w.\-]+\.jpg$/.test(name)) return send(res, 400, { error: '名字不合法' })
      try {
        return send(res, 200, await readFile(join(FRAMES, name)), 'image/jpeg')
      } catch {
        return send(res, 404, { error: '没有这张' })
      }
    }

    if (p === '/api/wx/shot') {
      const r = await host.image('DISPLAY=:99 import -window root png:- 2>/dev/null')
      if (!r.ok) return send(res, 404, { error: '截不到图：微信或 Xvfb 没在跑' })
      return send(res, 200, r.buf, 'image/png')
    }

    if (p === '/api/her/open') {
      const r = await asHer(`bash ${H}/her-open.sh`)
      const link = String(r.out).trim().split('\n').pop()
      if (!/^http/.test(link)) {
        note('her', r.err || '没拿到地址', false)
        return send(res, 502, { error: '她没起来', detail: r.err })
      }
      note('her', '打开她的界面', true)
      return send(res, 200, { url: link })
    }

    const m = p.match(/^\/api\/(qq|wx|her)\/(start|stop|restart)$/)
    if (m) {
      const key = `${m[1]}/${m[2]}`
      const fn = actions[key]
      if (!fn) return send(res, 400, { error: `没有这个动作：${key}` })
      const r = await fn()
      return send(res, 200, { ok: r.ok, out: String(r.out || '').slice(-800), err: r.err })
    }

    return send(res, 404, { error: 'not found' })
  } catch (err) {
    note('server', String(err?.message ?? err), false)
    return send(res, 500, { error: String(err?.message ?? err) })
  }
})

// ---- 启动 ----
// Linux 上保活是空实现——机器常开，服务由 systemd 管。
// 只有作为入口脚本运行时才监听；测试 import 本文件时自己 start(0)。

export async function start(port = PORT) {
  await mkdir(FRAMES, { recursive: true })
  host.keepalive.start()
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.on(sig, () => { host.keepalive.stop(); process.exit(0) })
  }
  process.on('exit', () => host.keepalive.stop())
  note('keepalive', '常开机器，不需要保活')
  if (process.env.WORKBENCH_DISABLE_WATCH !== '1') setTimeout(() => { watchLoop(true) }, 3_000)
  return new Promise((resolvePromise, reject) => {
    const onError = (err) => reject(err)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      const addr = server.address()
      listenPort = typeof addr === 'object' && addr ? addr.port : port
      console.log(`工作台: http://127.0.0.1:${listenPort}/`)
      console.log('（本机直跑，只绑 127.0.0.1）')
      resolvePromise(server)
    })
  })
}

// /opt/fish/workbench 是指向工作树的符号链接：argv[1] 是链接路径，而 ESM 的
// import.meta.url 已经解析成真实路径，直接比字符串会判成「不是入口」然后静默退出。
// 两边都 realpath 再比；测试 import 本文件时 argv[1] 是测试运行器，仍然为 false。
const real = (p) => { try { return realpathSync(resolve(p)) } catch { return null } }
const isMain = Boolean(process.argv[1]) && real(process.argv[1]) === real(fileURLToPath(import.meta.url))
if (isMain) await start()
