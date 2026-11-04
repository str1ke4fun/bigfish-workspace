/**
 * speaker-align.js —— OCR 名字行与消息气泡的几何对齐
 *
 * 微信 4.x 的树里没有发言人，但群聊气泡上方会画出「群名片」和「时间」。
 * `wx.sh speakers` 用 OCR 把左侧那一列读成文字行；这里只做几何对齐：
 *
 *   1. 名字行必须落在消息项的顶部 45% 带内，才可能是这条消息的发言人；
 *   2. 时间、贴纸、正文本身都不能冒充名字；
 *   3. 没有名字行时，用正文行的水平位置判断是对方（in）还是她（out）；
 *   4. OCR 会把头像图标读成 `+e `、`< ` 之类的前缀，精确查不到时用最后一个
 *      空白后的片段再查一次名册；
 *   5. 读不出就留空，绝不从正文猜人。
 *
 * 坐标约定：messages[].box 和 lines[] 都是屏幕绝对坐标。
 * `wx-elements.mjs` 已乘过 screenScale()，`ocr-speakers.mjs` 已加过裁剪原点，
 * 这里不再乘任何缩放、不再加任何原点，两侧直接比较。
 *
 * 纯函数：不读屏、不写盘、不看时钟。
 */

import { isTimeMarker, kindOfLabel } from './transcript.js'

const str = (v) => String(v ?? '').trim()
/** 名字只压空白：连续空白变一个空格，保留原始字符。 */
const squeeze = (v) => str(v).replace(/\s+/gu, ' ')
/** 正文比对忽略空白差异，避免 OCR 空格把同一条判成两条。 */
const flat = (v) => squeeze(v).replace(/\s+/gu, '')
const chars = (v) => [...v].length
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const MIN_CONF = 50
const MAX_NAME = 24
const BODY_PREFIX_MIN = 4
// 时间行的冒号会切出「14」这样的假名字；整行 time marker 之外还要挡住时间前缀。
const TIME_PREFIX = /^(?:\d{1,2}[:：]\d{2})/u
// 微信会把系统提示也画在同一列，整行不是名字。
const SYSTEM_NAME = /^(?:你)?(?:撤回了一条消息|拍了拍.*|加入了群聊|退出了群聊|修改了群名为.*|以上是打招呼的内容|以下是新消息|系统消息)$/u

/**
 * 能不能当群名片：长度合适，不是时间或系统提示，也不是正文。
 * 昵称可以是任意字符串（纯 emoji、纯数字、标点结尾都行），不按字符类别过滤。
 */
function plausibleName(raw) {
  const s = squeeze(raw)
  const len = chars(s)
  if (len < 1 || len > MAX_NAME) return false
  if (TIME_PREFIX.test(s)) return false
  if (isTimeMarker(s)) return false
  if (kindOfLabel(s) !== 'text') return false
  if (SYSTEM_NAME.test(s)) return false
  return true
}

/** 名字候选不能就是这条消息的正文；正文够长时，互相包含也算正文。 */
function looksLikeBody(lineText, bodyText) {
  const a = flat(lineText)
  const b = flat(bodyText)
  if (!a || !b) return false
  if (a === b) return true
  if (chars(b) < BODY_PREFIX_MIN) return false
  return a.includes(b) || b.includes(a)
}

/** 正文行对齐：归一化相等，或短串（≥4 字）是长串前缀。 */
function matchesBody(lineText, bodyText) {
  const a = flat(lineText)
  const b = flat(bodyText)
  if (!a || !b) return false
  if (a === b) return true
  const [short, long] = chars(a) <= chars(b) ? [a, b] : [b, a]
  return chars(short) >= BODY_PREFIX_MIN && long.startsWith(short)
}

/** pane 没给就从消息框推导：最左边界到最右边界。 */
function resolvePane(pane, messages) {
  const paneLeft = num(pane?.left)
  const paneRight = num(pane?.right)
  if (paneLeft !== null && paneRight !== null) return { left: paneLeft, right: paneRight }

  let left = null
  let right = null
  for (const message of messages) {
    const box = message?.box
    if (!box || typeof box !== 'object') continue
    const x = num(box.x)
    const w = num(box.w)
    if (x === null || w === null) continue
    left = left === null ? x : Math.min(left, x)
    right = right === null ? x + w : Math.max(right, x + w)
  }
  return left === null ? null : { left, right }
}

/**
 * 在消息项顶部 45% 带里找名字行。
 * 多个候选取离 top 最近的；距离并列取 conf 高的。
 */
function pickNameLine(lines, box, bodyText) {
  const top = num(box?.y)
  const height = num(box?.h)
  if (top === null || height === null) return null
  const low = top - 2
  const high = top + Math.max(0, height) * 0.45

  let best = null
  let bestDistance = Infinity
  let bestConf = -Infinity
  for (const line of lines) {
    const y = num(line.y)
    const h = num(line.h)
    const conf = num(line.conf)
    if (y === null || h === null || conf === null || conf < MIN_CONF) continue
    if (y < low || y > high) continue
    if (!plausibleName(line.text)) continue
    if (looksLikeBody(line.text, bodyText)) continue

    const distance = Math.abs(y + h / 2 - top)
    if (distance < bestDistance || (distance === bestDistance && conf > bestConf)) {
      best = line
      bestDistance = distance
      bestConf = conf
    }
  }
  return best
}

/** 找与正文对得上的一行；多条取置信度高者，再按离 top 最近。 */
function pickBodyLine(lines, bodyText, box) {
  const top = num(box?.y) ?? 0
  let best = null
  let bestConf = -Infinity
  let bestDistance = Infinity
  for (const line of lines) {
    const conf = num(line.conf)
    if (conf === null || conf < MIN_CONF) continue
    if (!matchesBody(line.text, bodyText)) continue
    const y = num(line.y)
    const h = num(line.h)
    const distance = y === null ? Infinity : Math.abs(y + (h ?? 0) / 2 - top)
    if (conf > bestConf || (conf === bestConf && distance < bestDistance)) {
      best = line
      bestConf = conf
      bestDistance = distance
    }
  }
  return best
}

/** 正文行中心在 pane 中线右侧就是她自己发的，否则是对方。 */
function directionOf(line, pane) {
  if (!line || !pane) return 'in'
  const x = num(line.x)
  const w = num(line.w)
  if (x === null || w === null) return 'in'
  const center = x + w / 2
  return center > (pane.left + pane.right) / 2 ? 'out' : 'in'
}

/**
 * 给一屏消息对齐发言人。返回与 messages 等长同序的新数组，不改输入。
 *
 * 每条结果都带 `text`（原消息正文），因此可以直接组合：
 *   `planSpeakerRepairs(alignSpeakers(messages, lines), docs)`
 * 后者按 `text` 找回台账记录，不需要调用方再手工拼接消息正文。
 *
 * @param {Array<{text?:string, box?:{x:number,y:number,w:number,h:number}}>} messages
 * @param {Array<{text:string,x:number,y:number,w:number,h:number,conf:number}>} lines 屏幕绝对坐标
 * @param {{roster?:{resolve:(raw:string)=>{name:string,matched:boolean}}, pane?:{left:number,right:number}}|null} [options]
 * @returns {Array<{text:string, sender:string|null, senderConfidence:'medium'|'low'|'unknown', direction:'in'|'out'}>}
 */
export function alignSpeakers(messages, lines, options = {}) {
  const { roster, pane } = options ?? {}
  const list = Array.isArray(messages) ? messages : []
  const lineList = (Array.isArray(lines) ? lines : []).filter((line) => line && typeof line === 'object')
  const bounds = resolvePane(pane, list)
  const resolve = typeof roster?.resolve === 'function' ? roster.resolve.bind(roster) : null

  return list.map((message) => {
    if (!message || typeof message !== 'object') {
      return { text: '', sender: null, senderConfidence: 'unknown', direction: 'in' }
    }
    const text = str(message.text)
    const box = message.box && typeof message.box === 'object' ? message.box : null

    const nameLine = pickNameLine(lineList, box, text)
    if (nameLine) {
      const raw = squeeze(nameLine.text)
      const resolved = resolve ? resolve(raw) : null
      if (resolved && resolved.matched) {
        return { text, sender: str(resolved.name) || raw, senderConfidence: 'medium', direction: 'in' }
      }
      // 头像图标常被 OCR 读成 `+e `、`< ` 之类的前缀，真名在最后一个空白之后。
      // 精确匹配失败时拿这段 tail 再查一次名册；命中才采用，tail 本身也照旧
      // 走 resolve，防止把任意垃圾后缀当名字。
      const tail = raw.split(/\s+/u).at(-1) ?? ''
      const tailResolved = resolve && tail && tail !== raw ? resolve(tail) : null
      if (tailResolved && tailResolved.matched) {
        return { text, sender: str(tailResolved.name) || tail, senderConfidence: 'medium', direction: 'in' }
      }
      // 名册不认识也保留 OCR 原文，标 low；不拿 resolve 的返回值硬套。
      return { text, sender: raw, senderConfidence: 'low', direction: 'in' }
    }

    const bodyLine = pickBodyLine(lineList, text, box)
    return { text, sender: null, senderConfidence: 'unknown', direction: directionOf(bodyLine, bounds) }
  })
}

const unrecognized = (sender) => sender === null || sender === undefined || sender === ''

/**
 * 把这一屏对齐出来的发言人变成台账 repair。
 * 只补台账里 sender 为空、且这段文本最后一条未识别记录；已有发言人的不覆盖。
 *
 * `aligned` 可以直接用 `alignSpeakers(...)` 的返回值：每条结果自带 `text`，
 * 这里按 `text` 找台账记录，所以两个函数可以不经手工转换直接组合。
 *
 * @param {Array<{text?:string, sender:string|null, senderConfidence?:string}>} aligned
 * @param {Array<{msgId?:string, text?:string, sender?:string|null}>} docs 台账最近记录
 * @returns {Array<{msgId:string, sender:string, senderConfidence:string}>}
 */
export function planSpeakerRepairs(aligned, docs) {
  const index = new Map()
  for (const doc of Array.isArray(docs) ? docs : []) {
    if (!doc || typeof doc !== 'object') continue
    const text = flat(doc.text)
    if (!text) continue
    if (!unrecognized(doc.sender)) continue
    // 同一文本多轮看到时，补最后一轮还没识别出人的那条。
    index.set(text, doc)
  }

  const out = []
  const seen = new Set()
  for (const item of Array.isArray(aligned) ? aligned : []) {
    if (!item || typeof item !== 'object') continue
    const sender = str(item.sender)
    if (!sender) continue
    const doc = index.get(flat(item.text))
    if (!doc) continue
    const msgId = str(doc.msgId)
    if (!msgId || seen.has(msgId)) continue
    seen.add(msgId)
    out.push({
      msgId,
      sender,
      senderConfidence: str(item.senderConfidence) || 'unknown',
    })
  }
  return out
}
