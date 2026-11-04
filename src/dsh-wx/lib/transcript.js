/**
 * transcript.js —— 聊天区一行 label → 消息字段。
 *
 * 微信 4.x 的无障碍树里，聊天区的每条消息是一个 label。纯文字就是正文，
 * 但是还有三类东西混在同一层：
 *   1. 时间分隔行（14:02 / Yesterday 16:29 / Monday / 昨天 09:05）
 *   2. 引用回复（正文 \n Quote 某某's message: 原文）
 *   3. 贴纸/图片等占位标记（Animated Stickers / [Image] / [图片]）
 *
 * 这里只做整行解析，不碰屏幕、不写台账。时间只能读到侧栏那种粒度，
 * 所以一律标 medium；读不出就留空并标 low，绝不猜。
 */

const str = (v) => String(v ?? '').trim()

const KIND_RULES = [
  ['sticker', /^(?:\[(?:sticker|animated stickers?|表情|动画表情|贴纸|自定义表情)\]|animated stickers?)$/i],
  ['image', /^\[(?:image|photo|图片|照片)\]$/i],
  ['file', /^\[(?:file|文件)\]$/i],
  ['voice', /^\[(?:voice|audio|语音)\]$/i],
  ['video', /^\[(?:video|视频)\]$/i],
  ['link', /^\[(?:link|链接)\]$/i],
]

/** 整行是不是占位标记；是就返回对应类型，否则 text。 */
export function kindOfLabel(label) {
  const s = str(label)
  for (const [kind, re] of KIND_RULES) if (re.test(s)) return kind
  return 'text'
}

const CLOCK = '(?:[01]?\\d|2[0-3]):[0-5]\\d'
const EN_DAY_FULL = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
const EN_DAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)'
const CN_DAY = '(?:周|星期)[一二三四五六日天]'

// 整行匹配：HH:MM / Yesterday 16:29 / 昨天 09:05 / Monday (14:02) / 星期三 (09:00)
const TIME_MARKER_RE = new RegExp(
  '^(?:' +
    `${CLOCK}` +
    `|(?:yesterday|today)\\s+${CLOCK}` +
    `|(?:昨天|今天)\\s*${CLOCK}` +
    `|${EN_DAY_FULL}(?:\\s+${CLOCK})?` +
    `|${CN_DAY}(?:\\s*${CLOCK})?` +
  ')$',
  'i',
)

/** 整行是时间分隔行才算；「14:02 开会」是正文。 */
export function isTimeMarker(text) {
  return TIME_MARKER_RE.test(str(text))
}

const CLOCK_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/
const REL_RE = /^(yesterday|today|昨天|今天)\s*([01]?\d|2[0-3]):([0-5]\d)$/i
const EN_DAY_RE = new RegExp(`^(${EN_DAY})(?:\\s+([01]?\\d|2[0-3]):([0-5]\\d))?$`, 'i')
const CN_DAY_RE = /^((?:周|星期)[一二三四五六日天])(?:\s*([01]?\d|2[0-3]):([0-5]\d))?$/

const EN_DAY_INDEX = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
}
const CN_DAY_INDEX = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }
const LOW = { at: '', confidence: 'low' }

const localAt = (y, m, d, h = 0, min = 0) => new Date(y, m, d, h, min, 0, 0)

/**
 * 侧栏时间 → ISO 时间。
 * 只有日期粒度，一律 medium；读不出返回 {at:'', confidence:'low'}。
 * 「14:02」若晚于 now 一分钟以上，说明是昨天同一时刻。
 */
export function parseSidebarTime(text, now = Date.now()) {
  const s = str(text)
  const ms = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const base = new Date(ms)
  const y = base.getFullYear()
  const m = base.getMonth()
  const d = base.getDate()

  let at = null
  let match
  if ((match = s.match(CLOCK_RE))) {
    at = localAt(y, m, d, Number(match[1]), Number(match[2]))
    if (at.getTime() > ms + 60_000) at = localAt(y, m, d - 1, Number(match[1]), Number(match[2]))
  } else if ((match = s.match(REL_RE))) {
    const h = Number(match[2])
    const min = Number(match[3])
    const day = /^(?:yesterday|昨天)$/i.test(match[1]) ? d - 1 : d
    at = localAt(y, m, day, h, min)
  } else if ((match = s.match(EN_DAY_RE))) {
    at = weekdayAt(ms, EN_DAY_INDEX[match[1].toLowerCase()], match[2], match[3])
  } else if ((match = s.match(CN_DAY_RE))) {
    at = weekdayAt(ms, CN_DAY_INDEX[match[1].slice(-1)], match[2], match[3])
  }

  return at ? { at: at.toISOString(), confidence: 'medium' } : { ...LOW }
}

/** 最近一次该星期几；带时间且落在未来就再退一周。 */
function weekdayAt(ms, target, h, min) {
  const base = new Date(ms)
  const daysBack = (base.getDay() - target + 7) % 7
  const y = base.getFullYear()
  const m = base.getMonth()
  const d = base.getDate()
  const hasTime = h !== undefined
  let at = localAt(y, m, d - daysBack, hasTime ? Number(h) : 0, hasTime ? Number(min) : 0)
  if (at.getTime() > ms + 60_000) at = localAt(y, m, d - daysBack - 7, hasTime ? Number(h) : 0, hasTime ? Number(min) : 0)
  return at
}

const QUOTE_RE = /^([\s\S]*?)\nQuote (.+?)'s message: ([\s\S]+)$/u

/**
 * 一行拆成正文、引用和类型。引用识别失败时整行都是正文，不硬切。
 * 正文若是 [Image] 这类占位标记，text 保留标记原文，kind 标明类型。
 */
export function splitMessageLabel(label) {
  const raw = String(label ?? '')
  const m = raw.match(QUOTE_RE)
  const text = (m ? m[1] : raw).trim()
  const quote = m ? { author: m[2].trim(), text: m[3].trim() } : null
  return { text, quote, kind: kindOfLabel(text) }
}

/**
 * 整屏归一：时间行推进当前时间，其余产出消息。
 * 末尾连续 ≥3 条相同的非文字行是表情面板浮层，整段丢弃。
 * box 原样带出，供后面的点击定位用。
 */
export function normalizeMessages(items, { now = Date.now() } = {}) {
  const out = []
  let at = ''
  let atConfidence = 'unknown'

  for (const item of items ?? []) {
    if (!item || typeof item !== 'object') continue
    const label = String(item.text ?? '')
    if (isTimeMarker(label)) {
      const parsed = parseSidebarTime(label, now)
      if (parsed.at) {
        at = parsed.at
        atConfidence = parsed.confidence
      }
      continue
    }
    const { text, quote, kind } = splitMessageLabel(label)
    if (!text) continue
    const rec = { text, kind, quote, at, atConfidence }
    if (item.box && typeof item.box === 'object') rec.box = item.box
    out.push(rec)
  }

  const last = out.at(-1)
  if (last && last.kind !== 'text') {
    let start = out.length
    while (start > 0 && out[start - 1].kind !== 'text' && out[start - 1].text === last.text) start--
    if (out.length - start >= 3) out.splice(start, out.length - start)
  }
  return out
}
