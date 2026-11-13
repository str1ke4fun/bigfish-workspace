/**
 * similarity.js —— 文本相似度、评论归一化与「回声」判定
 *
 * A0 从 derive.js / voices.js 抽出，解掉两个模块的循环依赖：
 *   derive.js → similarity.js
 *   voices.js → similarity.js
 * 两边都不再互相 import。
 */

const DAY_MS = 86_400_000

/** 身份文档里「你读到的一句话」只认 7 天内的。 */
export const VOICE_FRESH_DAYS = 7

/** 评论之后多久内说的话算「回声」。 */
export const ECHO_WINDOW_MS = 3 * DAY_MS

/** 回声的相似度门槛。 */
export const ECHO_MIN_SIM = 0.7

/** 字符二元组 Dice 相似度（跨情境一致与「新话」判定用）。 */
export function similarity(a, b) {
  const A = String(a ?? '')
  const B = String(b ?? '')
  if (A === B) return 1
  if (!A || !B) return 0
  const grams = (s) => {
    const m = new Map()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ga = grams(A)
  const gb = grams(B)
  let inter = 0
  let total = 0
  for (const [g, c] of ga) {
    total += c
    const d = gb.get(g)
    if (d) inter += Math.min(c, d)
  }
  for (const [, c] of gb) total += c
  return total === 0 ? 0 : (2 * inter) / total
}

/**
 * 归一化：只留字。
 *
 * 去 URL / @ / 标点 / 空白；截 120，做 key 时不被长尾稀释。
 */
export function normVoice(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[^\s]+/g, ' ')
    .replace(/[，。！？、；：「」『』（）()[\]{}<>《》~!?,.;:"'`~^*_+=|\\/#%&$@\-]/g, '')
    .replace(/[\s　]+/g, '')
    .slice(0, 120)
}

/**
 * 她有没有认下这条评论（回声）。
 *
 * 只在评论之后 ECHO_WINDOW_MS 内找她说的话；按事件流里的先后判，不按毫秒。
 */
export function findEcho(voice, events = []) {
  const t0 = Date.parse(voice.at ?? '')
  if (!Number.isFinite(t0)) return null
  const mine = normVoice(voice.text)
  const idx = events.findIndex((e) => e.id && e.id === voice.id)
  const after = idx >= 0 ? events.slice(idx + 1) : events
  for (const e of after) {
    if (e.type !== 'utterance' && e.type !== 'revise') continue
    const t = Date.parse(e.ts ?? '')
    if (!Number.isFinite(t) || t - t0 > ECHO_WINDOW_MS) continue
    if (similarity(mine, normVoice(e.text)) >= ECHO_MIN_SIM) return e
  }
  return null
}
