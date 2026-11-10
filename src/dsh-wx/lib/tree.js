/**
 * 解析 wx-elements.mjs 的输出（结构化文本）。纯函数，没有副作用，selftest 直接喂样本。
 *
 * 输出长这样（坐标已经换算成屏幕绝对坐标）：
 *   微信窗口 916x666 原点(523,233) · 元素 335 个 · 缩放 1.0417 · …
 *   当前会话："测试群A"
 *   --- 会话列表 ---
 *   会话 "测试群A" 未读=9 @我 草稿 置顶 时间="16:19" 预览="…" 中心(711,555) 250x68
 *   --- 当前聊天里的消息 ---
 *   消息 "…" 中心(1138,715) 602x77
 *   --- 能点的 ---
 *   push button "Chat Info" 中心(1407,292) 29x29
 *
 * 为什么会话名要单独成字段：
 *   发消息的闸、耳朵、工作台的候选名单，以前都是在一整串文字里 includes / 按括号切，
 *   结果"微信别处的字"被当成群名。现在名字只来自会话行的第一行，别处的字不可能是群名。
 */
const AT = /中心\((-?\d+),(-?\d+)\) (\d+)x(\d+)\s*$/

function at(line) {
  const m = line.match(AT)
  if (!m) return null
  const [cx, cy, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return { cx, cy, w, h, x: cx - w / 2, y: cy - h / 2 }
}

export function parseTree(text) {
  const out = {
    ok: false,
    window: null, // { w, h, ox, oy, scale }
    current: '', // 当前打开的会话名；读不到是 ''
    chats: [], // { name, unread, mention, draft, pinned, time, preview, box }
    messages: [], // { text, box }
    clickables: [], // { role, label, box }
  }
  const lines = String(text ?? '').split('\n')
  const head = lines[0]?.match(/^微信窗口 (\d+)x(\d+) 原点\((-?\d+),(-?\d+)\).*?缩放 ([\d.]+)/)
  if (head) {
    out.window = { w: Number(head[1]), h: Number(head[2]), ox: Number(head[3]), oy: Number(head[4]), scale: Number(head[5]) }
    out.ok = true
  }
  for (const line of lines) {
    let m
    if ((m = line.match(/^当前会话："(.*)"\s*$/))) { out.current = m[1]; continue }
    if (line.startsWith('会话 "')) {
      const box = at(line)
      const name = line.match(/^会话 "([^"]*)"/)?.[1]
      if (!box || name == null) continue
      const rest = line.slice(line.indexOf('"', 4) + 1)
      out.chats.push({
        name,
        unread: Number(rest.match(/ 未读=(\d+)/)?.[1] ?? 0),
        mention: / @我(?= |$)/.test(rest),
        draft: / 草稿(?= |$)/.test(rest),
        pinned: / 置顶(?= |$)/.test(rest),
        time: rest.match(/ 时间="([^"]*)"/)?.[1] ?? '',
        preview: rest.match(/ 预览="([^"]*)"/)?.[1] ?? '',
        box,
      })
      continue
    }
    if (line.startsWith('消息 "')) {
      const box = at(line)
      const t = line.match(/^消息 "(.*)" 中心\(/)?.[1]
      if (box && t != null) out.messages.push({ text: t, box })
      continue
    }
    if ((m = line.match(/^([a-z][a-z ]*) "(.*)" 中心\(/))) {
      const box = at(line)
      if (box) out.clickables.push({ role: m[1], label: m[2], box })
    }
  }
  return out
}

/** 名字比较：只做首尾空白和全/半角空格的归一，不做任何"包含"判断。 */
export const sameName = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ') === String(b ?? '').trim().replace(/\s+/g, ' ')

/**
 * 无障碍树的健康状态（只看树本身，不看 OCR 回退）。
 *   ok      —— 窗口、会话列表都读到了
 *   partial —— 树头在、窗口在，但会话列表是空的（Qt 无障碍桥没挂上/行被截断）
 *   down    —— 连树头和窗口都读不到
 *   login   —— 窗口缩成登录页，需要人工登录；不能自动重启
 * 重启策略只看这个状态，不拿"当前会话/未读数"猜。
 */
export function treeHealth(raw, parsed) {
  const text = String(raw ?? '')
  const m = text.match(/元素\s*(\d+)\s*个/)
  const elements = m ? Number(m[1]) : 0
  const window = parsed?.window && Number(parsed.window.w) > 0
    ? { w: Number(parsed.window.w), h: Number(parsed.window.h) }
    : null
  const chats = Array.isArray(parsed?.chats) ? parsed.chats.length : 0
  const header = Boolean(parsed?.ok)
  let status = 'down'
  if (header && window && window.w < 400 && chats === 0) status = 'login'
  else if (header && window && window.w >= 400 && elements < 5) status = 'down'
  else if (header && window && chats === 0) status = 'partial'
  else if (header && window) status = 'ok'
  return { status, ok: status === 'ok', elements, chats, window, header }
}

/**
 * OCR 名字对账：微信侧栏会把长名字截断成「星晓家园10号楼13...」，OCR 只能读到前一段。
 * 只在名单里找到**唯一**一个以它开头的名字时才改写成全名；找不到或撞名就原样返回。
 * 不做模糊匹配、不做包含匹配——对不上宁可不动，也不把消息递到错的会话。
 */
export function reconcileChatName(name, names = []) {
  const clean = String(name ?? '').trim().replace(/\s+/g, ' ')
  if (!clean) return ''
  const list = (names ?? []).map((n) => String(n ?? '').trim()).filter(Boolean)
  const exact = list.find((n) => sameName(n, clean))
  if (exact) return exact
  const base = clean.replace(/\s*(?:\.{2,}|…)\s*$/u, '').trim()
  if (base.length < 2) return clean
  const hits = [...new Set(list.filter((n) => String(n).startsWith(base)))]
  return hits.length === 1 ? hits[0] : clean
}

/**
 * 用 OCR 复核树是不是真的落后：OCR 读的是屏幕，树读的是无障碍层。
 * 如果 OCR 的行名按顺序都能在树里找到（微信会截断名字，所以允许前缀），
 * 说明树跟屏幕是一致的，像素差异另有原因（浮层被关掉、悬停高亮、主题）。
 *
 * 只在刚判成「落后」时用一次：直接按像素判的"落后"有可能是外部改动造成的假警报，
 * 而真落后（列表重排/新消息）会让顺序或名字对不上。
 */
export function treeMatchesOcr(treeParsed, ocrParsed, { minRows = 3, ratio = 0.6 } = {}) {
  const tree = (treeParsed?.chats ?? []).map((c) => String(c?.name ?? '').trim()).filter(Boolean)
  const rows = (ocrParsed?.chats ?? []).map((c) => String(c?.name ?? '').trim()).filter(Boolean)
  if (tree.length === 0 || rows.length < minRows) return false
  let cursor = -1
  let hit = 0
  for (const row of rows) {
    for (let i = cursor + 1; i < tree.length; i++) {
      const name = tree[i]
      const short = name.length >= row.length ? row : name
      const prefix = short.length >= 2 && (name.startsWith(row) || row.startsWith(name))
      if (sameName(name, row) || prefix) { cursor = i; hit++; break }
    }
  }
  return hit >= minRows && hit / rows.length >= ratio
}

/**
 * 微信的 MainPID 变了 = 它被重启过（systemd Restart、工作台按钮、手动都算）。
 * 重启后 Qt 的无障碍桥可能没连上总线：树掉了，但「使用中只提醒」那条规矩不适用，
 * 因为这不是用着用着掉的，是重启后没回来。返回是否需要开一轮「重启后恢复」。
 *
 * 恢复期内再换 pid 不重置：那多半就是我们自己重启造成的，重置会变成无限重启。
 */
export function restartEpisode({ prevPid = 0, pid = 0, treeOk = false, phase = 'steady' } = {}) {
  const changed = Number(pid) > 0 && Number(prevPid) > 0 && Number(pid) !== Number(prevPid)
  return { changed, recover: changed && !treeOk && phase === 'steady' }
}

/**
 * 树掉线时该做什么。纯函数，方便列边界。
 *   phase=init    —— 插件刚挂上：允许先确保无障碍总线，再重启微信（有次数和冷却）
 *   phase=recover —— 检测到微信重启且树没回来：和 init 一样有界重启，文案说明是「重启后」
 *   phase=steady  —— 已经见过健康的树：只提醒，不重启
 * 登录页永远不重启（要人扫码）。
 */
export function treeAction({
  health,
  phase = 'init',
  attempts = 0,
  lastRestartAt = 0,
  retryAfter = 0,
  now = Date.now(),
  maxAttempts = 2,
  cooldownMs = 45_000,
  // down 的起点（index.js 传 statusSince=treeSince）。0 = 未知，按「已经很久」处理。
  statusSince = 0,
  // 最近一次看到登录页的时刻。登录成功后主窗口可能先出来、树后挂上，这段时间不许重启。
  lastLoginAt = 0,
  confirmMs = 90_000,
  loginLatchMs = 300_000,
} = {}) {
  const status = health?.status ?? 'down'
  const canRestart = phase === 'init' || phase === 'recover'
  if (status === 'ok') return { phase: 'steady', status, healthy: true, restart: false, alert: '' }
  if (status === 'login') {
    return { phase, status, restart: false, login: true, alert: '微信停在登录页（窗口缩小），需要人工登录；不自动重启' }
  }
  // 树头在、只是没有会话行：微信可能停在通讯录/设置页，不是「没连上总线」。
  // 初始化也不重启，交给 OCR 和提醒；真塌成只剩几个元素（down）才重启。
  if (status === 'partial') {
    return {
      phase,
      status,
      restart: false,
      alert: phase === 'init'
        ? '无障碍树在，但会话列表读不到（微信可能停在别的页面）；不自动重启，先用 OCR'
        : phase === 'recover'
          ? '微信重启后无障碍树不完整（会话列表读不到）；不自动重启，先用 OCR'
          : '无障碍树不完整（窗口在，会话列表读不到）；按约定使用中不自动重启，只提醒',
    }
  }
  if (!canRestart) {
    return {
      phase,
      status,
      restart: false,
      alert: '无障碍树掉了（窗口在，元素几乎为空）；按约定使用中不自动重启，只提醒',
    }
  }
  if (attempts >= maxAttempts) {
    return {
      phase: 'steady',
      status,
      restart: false,
      exhausted: true,
      alert: phase === 'recover'
        ? `微信重启后一直没连上无障碍树，已重启 ${attempts} 次；停止自动重启，只提醒`
        : `初始化时微信一直没连上无障碍树，已重启 ${attempts} 次；停止自动重启，只提醒`,
    }
  }
  // 2026-11-04：登录页 -> 主窗口的过渡里，主窗口刚出现、无障碍树还没挂上，
  // 单次采样就是 down。此时重启微信等于把正在登录的人踢下去。
  if (lastLoginAt && now - lastLoginAt < loginLatchMs) {
    return {
      phase,
      status,
      restart: false,
      wait: true,
      alert: '刚看到过微信登录页，先等无障碍树挂上；不自动重启',
    }
  }
  // down 必须持续一段时间才算「没连上」；单次采样不下结论。
  if (statusSince && now - statusSince < confirmMs) {
    return {
      phase,
      status,
      restart: false,
      wait: true,
      alert: '无障碍树还没连上，先观察一会儿；不自动重启',
    }
  }
  if (retryAfter > now) {
    return { phase, status, restart: false, wait: true, retryAfter, alert: '' }
  }
  if (lastRestartAt && now - lastRestartAt < cooldownMs) {
    return { phase, status, restart: false, wait: true, retryAfter: lastRestartAt + cooldownMs, alert: '' }
  }
  return {
    phase,
    status,
    restart: true,
    attempt: attempts + 1,
    alert: phase === 'recover'
      ? attempts === 0
        ? '微信重启后没连上无障碍树：先确认无障碍总线，再重启微信'
        : `微信重启后仍未连上无障碍树：重启第 ${attempts + 1} 次`
      : attempts === 0
        ? '初始化时微信没连上无障碍树：先确认无障碍总线，再重启微信'
        : `初始化时微信仍没连上无障碍树：重启第 ${attempts + 1} 次`,
  }
}

/** 当前会话是不是名单里的某一个。名单里没有、或读不到当前会话，都返回 null。 */
export function allowedCurrent(parsed, allowChats) {
  if (!parsed?.current) return null
  return allowChats.find((n) => sameName(n, parsed.current)) ?? null
}

/**
 * 侧栏里「有人在叫她」的会话。
 * 三种判据：
 *   1. 微信自己标的 `@我`；
 *   2. 预览里出现 trigger（只看预览，会话名里有她的名字不算）；
 *   3. 单聊：群里预览是「发送者: 内容」，单聊没有这个前缀。所以
 *      - 免 @ 名单里的会话，只要有未读就算叫她（她自己点名的私聊白名单，最高权限）；
 *      - 允许名单里的会话，未读 + 预览没有「发送者:」前缀，也当单聊。
 */
export function mentionHits(parsed, trigger, exempt = [], allow = []) {
  const out = []
  const looksDM = (c) => Boolean(c.preview) && !/^[^:：]{1,20}[:：]\s/.test(c.preview)
  const inList = (list, name) => list.some((n) => sameName(n, name))
  for (const c of parsed?.chats ?? []) {
    const byTrigger = c.unread > 0 && trigger.some((t) => t && c.preview.includes(t))
    const byExempt = c.unread > 0 && inList(exempt, c.name)
    const byDM = c.unread > 0 && !byExempt && looksDM(c) && inList(allow, c.name)
    // OCR may confirm an explicit unread @ badge or trigger text, but uncertain
    // OCR must never widen the single-chat / exempt-chat automatic reply rules.
    const ocrConfirmed = c.source === 'ocr' && c.mention && Number(c.nameConfidence) >= 55
    if (!c.mention && !byTrigger && !byExempt && !byDM) continue
    if (c.source === 'ocr' && !ocrConfirmed) continue
    out.push({
      chat: c.name,
      unread: c.unread,
      preview: c.preview,
      why: c.mention ? '@' : byTrigger ? 'name' : byExempt ? 'exempt' : 'dm',
      // key 里不放 unread：她一回复未读数就变，数值抖动会被当成"新消息"重复叫她
      key: `${c.name}|${c.mention ? '@' : ''}|${c.preview}`,
    })
  }
  return out
}

/** OCR recovery is intentionally narrower than the AT-SPI path: only an
 * explicit unread @ badge with a confidently read chat name may wake the ear.
 * It never infers direct messages or triggers from OCR preview text. */
export function ocrMentionHits(parsed) {
  return (parsed?.chats ?? [])
    .filter((chat) => chat.source === 'ocr' && chat.mention === true && Number(chat.nameConfidence) >= 55 &&
      !/^[\p{P}\p{S}\s]+$/u.test(String(chat.name ?? '')))
    .map((chat) => ({
      chat: chat.name,
      unread: chat.unread,
      preview: chat.preview,
      why: '@',
      key: `${chat.name}|@|${chat.preview}`,
    }))
}

/**
 * 「树看到的东西」的摘要：会话列表（顺序、未读、预览）+ 当前会话 + 最后几条消息。
 * 不含时间戳，也不含坐标（窗口一挪坐标全变，但那不代表内容变了）。
 */
export function contentDigest(parsed) {
  // 时间要进摘要：它是屏幕上看得见的字（"Yesterday"→"Mon" 只改时间不改别的），树真的变了就该算变
  const chats = (parsed?.chats ?? []).map((c) => [c.name, c.unread, c.mention ? 1 : 0, c.draft ? 1 : 0, c.pinned ? 1 : 0, c.time, c.preview].join('|'))
  const msgs = (parsed?.messages ?? []).slice(-6).map((m) => m.text)
  return JSON.stringify({ chats, current: parsed?.current ?? '', msgs })
}

/**
 * 会话列表在窗口截图里的区域（相对窗口左上角），用来取像素摘要。
 * 右边留 26px 不要：滚动条悬停时才出现，会让像素摘要自己抖。
 */
export function sidebarRegion(parsed) {
  const w = parsed?.window
  const rows = parsed?.chats ?? []
  if (!w || rows.length === 0) return null
  const left = Math.min(...rows.map((c) => c.box.x))
  const right = Math.max(...rows.map((c) => c.box.x + c.box.w)) - 26
  const top = Math.min(...rows.map((c) => c.box.y))
  const bottom = Math.max(...rows.map((c) => c.box.y + c.box.h))
  const x = Math.max(0, Math.round(left - w.ox))
  const y = Math.max(0, Math.round(top - w.oy))
  const width = Math.min(w.w - x, Math.round(right - left))
  const height = Math.min(w.h - y, Math.round(bottom - top))
  if (width < 40 || height < 40) return null
  return { x, y, w: width, h: height }
}
