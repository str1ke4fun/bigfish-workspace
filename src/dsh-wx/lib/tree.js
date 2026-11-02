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
    if (!c.mention && !byTrigger && !byExempt && !byDM) continue
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
