/**
 * Parse screenshot OCR rows into the conservative subset consumed by the ear.
 * OCR is inherently uncertain: a row is actionable only when its name and
 * preview can be separated without guessing. Coordinates are optional and are
 * deliberately not synthesized here.
 */
const MENTION_BADGE = /(?:\[\s*(?:you were mentioned|you were @ed|有人@我|有人@你)\s*\]|有人@我|有人@你|@我)(?=\s|$)/i
const UNREAD = /^\[(\d{1,3})\]$/
const TIME = /^(?:(?:昨天|星期[一二三四五六日天]|周[一二三四五六日天])\s*)?\d{1,2}:\d{2}$/

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * Accept explicit row objects from a line/box OCR adapter, never flattened
 * whole-window OCR text. Returns the same chat shape used by tree.js.
 */
export function parseOcrChats(rows, { trigger = [] } = {}) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const row of rows) {
    const lines = (Array.isArray(row?.lines) ? row.lines : [row?.text])
      .map(clean).filter(Boolean)
    if (lines.length < 2) continue
    const name = clean(row.name ?? lines[0])
    if (!name || name.length > 80 || /^(?:Weixin|微信|Contacts|通讯录|Moments|朋友圈|Search|搜索)$/i.test(name)) continue
    const body = lines.slice(1)
    let unread = 0
    let mention = false
    const preview = []
    for (const line of body) {
      const n = line.match(UNREAD)
      if (n) { unread = Number(n[1]); continue }
      const badge = MENTION_BADGE.test(line)
      if (badge) mention = true
      const withoutBadge = line.replace(MENTION_BADGE, ' ').trim()
      if (!withoutBadge) continue
      if (TIME.test(line)) continue
      preview.push(withoutBadge)
    }
    const previewText = clean(row.preview ?? preview.join(' '))
    if (trigger.some((needle) => needle && previewText.includes(String(needle)))) mention = true
    // Keep mention signal only when there is unread evidence. This avoids
    // treating old preview text or stale accessibility overlays as a new ping.
    if (unread === 0 && !mention) continue
    if (!previewText && !mention) continue
    out.push({
      name,
      unread,
      mention,
      draft: false,
      pinned: false,
      time: '',
      preview: previewText,
      box: row.box && Number.isFinite(row.box.cx) && Number.isFinite(row.box.cy)
        ? row.box : { cx: 0, cy: 0, x: 0, y: 0, w: 0, h: 0 },
      source: 'ocr',
      confidence: Number.isFinite(row.confidence) ? row.confidence : null,
    })
  }
  return out
}

/** OCR snapshots can detect mentions, but cannot establish the active chat. */
export function ocrSnapshot(input, options = {}) {
  const chats = parseOcrChats(input?.rows, options)
  return {
    ok: input?.ok === true,
    window: input?.bounds ? {
      w: Number(input.bounds.width) || 0,
      h: Number(input.bounds.height) || 0,
      ox: Number(input.bounds.x) || 0,
      oy: Number(input.bounds.y) || 0,
      scale: 1,
    } : null,
    current: '',
    chats,
    messages: Array.isArray(input?.messages) ? input.messages.map((message) => ({
      text: clean(message?.text),
      confidence: Number.isFinite(message?.confidence) ? message.confidence : null,
      box: message?.box && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(message.box[key]))
        ? message.box : null,
      source: 'ocr',
      verified: false,
    })).filter((message) => message.text) : [],
    clickables: [],
    source: 'ocr',
    reliable: input?.reliable === true,
    currentVerified: false,
  }
}
