// 把微信窗口里「能点的东西」按真实坐标列出来（结构化版）。
//
// 2026-11-19：从 ~/cu-test 收进仓库。原来它在运行目录里，长消息 80 字截断这类
// 修复不会跟着 Git 走；现在 wx.sh 直接跑这里，cua-driver 仍从运行目录解析
// （插件保持零依赖）。可用 WX_CU_DIR 指定 cua-driver 所在目录，默认 ~/cu-test。
//
// 三个教训都写在这里：
//  1. 几何在 element.frame（AT-SPI 的 extents），不在 bounds/rect。
//  2. ⚠️ AT-SPI 报的是「逻辑像素」，不是屏幕像素。Xvfb 是 100 DPI，Qt 按 100/96 缩放，
//     所以 树坐标 × (dpi/96) 才是 xdotool 认的屏幕坐标。以前直接拿树坐标去点：
//     x 越靠右偏得越多（x=1350 处偏 56px）——侧栏整行 240 宽碰巧点得中，
//     「发送」「Chat Info」这种 28px 的小按钮就全点空了。
//  3. 会话列表每一行的 label 是 `名字\n[未读]\n预览\n时间\n`，用换行分字段。
//     以前 `\s+ → 空格` 把结构拍扁，名字和预览糊成一串，下游只能靠猜在哪断开。
//     现在按行拆开，名字就是第一行，原样输出。
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 字段解析放在插件里（有自测），这里只管取树和换算坐标。
import { screenScale } from './scale.js'
import { parseChatLabel } from './chat-label.js'

const CU_DIR = process.env.WX_CU_DIR || '/home/str1k3/cu-test'
const CU_ENTRY = join(CU_DIR, 'node_modules/@trycua/cua-driver/dist/index.js')
let cu
try {
  cu = await import(pathToFileURL(CU_ENTRY).href)
} catch (error) {
  console.log(`读取失败: 找不到 cua-driver（${CU_ENTRY}）。用 WX_CU_DIR 指向安装目录，或先在 ${CU_DIR} 里 npm install。`)
  console.log('原因: ' + String(error?.message ?? error).slice(0, 200))
  process.exit(0)
}

const q = (s) => String(s).replace(/\s+/g, ' ').replace(/"/g, '＂')

const d = cu.CuaDriver.create()
try {
  const S = screenScale()
  const all = await d.listWindows(cu.ListWindowsInput.new({}))
  const w = (all.windows ?? [])
    .filter((x) => /Weixin/i.test(x.title ?? ''))
    .sort((a, b) => (b.bounds?.width ?? 0) - (a.bounds?.width ?? 0))[0]
  if (!w) { console.log('没有微信窗口'); process.exit(0) }

  const st = await d.getWindowState(cu.GetWindowStateInput.new({
    pid: w.pid, windowId: BigInt(w.windowId), includeAccessibilityTree: true, includeScreenshot: false,
  }))
  const els = st.elements ?? []
  const W = Math.round(Number(w.bounds?.width ?? 0))
  const H = Math.round(Number(w.bounds?.height ?? 0))
  const OX = Math.round(Number(w.bounds?.x ?? 0))
  const OY = Math.round(Number(w.bounds?.y ?? 0))

  // 屏幕绝对坐标（已乘缩放）
  const box = (e) => {
    const f = e.frame
    if (!f || !(Number(f.w) > 0) || !(Number(f.h) > 0)) return null
    const x = Number(f.x) * S, y = Number(f.y) * S, ww = Number(f.w) * S, hh = Number(f.h) * S
    return { x, y, w: ww, h: hh, cx: Math.round(x + ww / 2), cy: Math.round(y + hh / 2), W: Math.round(ww), H: Math.round(hh) }
  }
  const at = (b) => `中心(${b.cx},${b.cy}) ${b.W}x${b.H}`
  const role = (e) => String(e.role ?? '')
  const label = (e) => String(e.label ?? e.value ?? '')

  const chatsList = els.find((e) => role(e) === 'list' && label(e) === 'Chats' && box(e))
  const msgsList = els.find((e) => role(e) === 'list' && label(e) === 'Messages' && box(e))
  const cb = chatsList ? box(chatsList) : null
  const mb = msgsList ? box(msgsList) : null
  const inside = (b, host, pad = 4) => b && host && b.cx >= host.x - pad && b.cx <= host.x + host.w + pad && b.cy >= host.y - pad && b.cy <= host.y + host.h + pad

  const out = []
  out.push(`微信窗口 ${W}x${H} 原点(${OX},${OY}) · 元素 ${els.length} 个 · 缩放 ${S.toFixed(4)} · 下面坐标都是屏幕绝对坐标，直接给 wx_click`)

  // 当前会话：输入框那个 text 的 label 就是当前聊天的名字（标题栏不在无障碍树里）。
  // 位置条件：在消息列表下方、同一列。
  let current = ''
  if (mb) {
    const cand = els.filter((e) => role(e) === 'text' && label(e).trim() && label(e) !== 'Search').map((e) => ({ e, b: box(e) })).filter((x) => x.b)
      .filter((x) => x.b.cy > mb.y + mb.h - 8 && x.b.x >= mb.x - 40 && x.b.x <= mb.x + mb.w)
    if (cand[0]) current = label(cand[0].e).trim()
  }
  out.push(`当前会话：${current ? `"${q(current)}"` : '（读不到——可能没打开任何聊天）'}`)

  out.push('--- 会话列表（从上到下；名字就是微信里显示的名字）---')
  const rows = els.filter((e) => role(e) === 'list item' && cb && inside(box(e), cb)).map((e) => ({ e, b: box(e) }))
    .sort((a, b) => a.b.cy - b.b.cy)
  for (const { e, b } of rows) {
    const c = parseChatLabel(label(e))
    if (!c.name) continue
    const flags = [
      c.unread ? `未读=${c.unread}` : '',
      c.mention ? '@我' : '',
      c.draft ? '草稿' : '',
      c.pinned ? '置顶' : '',
    ].filter(Boolean).join(' ')
    out.push(`会话 "${q(c.name)}"${flags ? ' ' + flags : ''}${c.time ? ` 时间="${q(c.time)}"` : ''}${c.preview ? ` 预览="${q(c.preview).slice(0, 80)}"` : ''} ${at(b)}`)
  }

  if (mb) {
    out.push('--- 当前聊天里的消息（从上到下；只有内容，没有发言人）---')
    const msgs = els.filter((e) => role(e) === 'list item' && inside(box(e), mb)).map((e) => ({ e, b: box(e) })).sort((a, b) => a.b.cy - b.b.cy)
    // 微信的 AT-SPI label 是全文，80 字是桥接层自己截的：长消息会被当成「就到这里」，
    // 下游再按 msgId 去重时，预览和整屏两条都对不上，同一句话会被投多次。
    // 这里只做上限保护，不再把正文截在 80 字。
    for (const { e, b } of msgs.slice(-12)) out.push(`消息 "${q(label(e)).slice(0, 4000)}" ${at(b)}`)
  }

  out.push('--- 能点的 ---')
  const seen = new Set()
  for (const e of els) {
    const b = box(e)
    const l = q(label(e)).slice(0, 40)
    if (!b || !l) continue
    if (!/button|entry|edit|text field|link|tab|menu|check/i.test(role(e)) && !(role(e) === 'text' && b.cy > (mb ? mb.y + mb.h - 8 : 0))) continue
    if (role(e) === 'list item') continue
    const k = `${l}|${b.cx}|${b.cy}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(`${role(e)} "${l}" ${at(b)}`)
    if (seen.size >= 60) break
  }
  console.log(out.join('\n'))
} catch (e) {
  console.log('读取失败: ' + String(e?.message ?? e).slice(0, 300))
} finally {
  try { await d.shutdown() } catch {}
}
