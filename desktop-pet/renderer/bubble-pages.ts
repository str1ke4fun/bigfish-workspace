/**
 * 气泡逐句翻页与外观夹取的纯逻辑：不依赖 React / Electron，测试直接在 Node 里跑。
 */

export const BUBBLE_SENTENCE_MAX = 40
export const BUBBLE_OPACITY_MIN = 40
export const BUBBLE_OPACITY_MAX = 100
export const BUBBLE_OPACITY_DEFAULT = 90
export const BUBBLE_WIDTH_MIN = 220
export const BUBBLE_WIDTH_MAX = 420

const DWELL_MIN_MS = 2500
const DWELL_PER_CHAR_MS = 180

/** 句末标点（含连续标点与省略号）。 */
const SENTENCE_END = /[。？！?!…]+/
const CLAUSE_END = /[，、；,;：:]/

function hardSplit(text: string, max: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max))
  return out
}

/** 一个超长句：优先在逗号处断开，凑到不超过 max；没有逗号再硬切。 */
function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence]
  const clauses: string[] = []
  let current = ''
  for (const ch of sentence) {
    current += ch
    if (CLAUSE_END.test(ch)) {
      clauses.push(current)
      current = ''
    }
  }
  if (current) clauses.push(current)

  const out: string[] = []
  let buffer = ''
  for (const clause of clauses) {
    const pieces = clause.length > max ? hardSplit(clause, max) : [clause]
    for (const piece of pieces) {
      if (buffer && buffer.length + piece.length > max) {
        out.push(buffer)
        buffer = ''
      }
      buffer += piece
    }
  }
  if (buffer) out.push(buffer)
  return out
}

/** 按句末标点与换行切句；超长句再按逗号拆。拼回去与原文（去掉首尾空白/换行）一致。 */
export function splitSentences(text: string, max: number = BUBBLE_SENTENCE_MAX): string[] {
  const result: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rest = trimmed
    while (rest) {
      const match = SENTENCE_END.exec(rest)
      const end = match ? match.index + match[0].length : rest.length
      const sentence = rest.slice(0, end).trim()
      rest = rest.slice(end)
      if (sentence) result.push(...splitLong(sentence, max))
    }
  }
  return result
}

/** 每句停留：保底 2.5 秒，长句按 0.18 秒/字。 */
export function dwellMs(sentence: string): number {
  return Math.max(DWELL_MIN_MS, sentence.length * DWELL_PER_CHAR_MS)
}

export interface PagerDeps {
  show: (text: string, index: number, motion?: string) => void
  close: () => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface Pager {
  play: (text: string, motion?: string) => void
  cancel: () => void
}

/** 一句一句翻：同一个气泡原地换字，新消息取消上一轮，最后一句播完后收起。 */
export function createPager(deps: PagerDeps): Pager {
  let handle: unknown = null
  let active = false

  const clear = (): void => {
    if (handle !== null) deps.clearTimer(handle)
    handle = null
  }

  const play = (text: string, motion?: string): void => {
    clear()
    const sentences = splitSentences(text)
    if (sentences.length === 0) {
      active = false
      return
    }
    active = true
    let index = 0
    const step = (): void => {
      handle = null
      if (index >= sentences.length) {
        active = false
        deps.close()
        return
      }
      const sentence = sentences[index]
      deps.show(sentence, index, index === 0 ? motion : undefined)
      index += 1
      handle = deps.setTimer(step, dwellMs(sentence))
    }
    step()
  }

  const cancel = (): void => {
    clear()
    if (active) deps.close()
    active = false
  }

  return { play, cancel }
}

/** 透明度百分比；非法值回默认。 */
export function clampBubbleOpacity(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return BUBBLE_OPACITY_DEFAULT
  return Math.round(Math.min(BUBBLE_OPACITY_MAX, Math.max(BUBBLE_OPACITY_MIN, numeric)))
}

/** 宽度 px；0 或非法表示「跟随宠物尺寸」。 */
export function clampBubbleWidth(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return 0
  return Math.round(Math.min(BUBBLE_WIDTH_MAX, Math.max(BUBBLE_WIDTH_MIN, numeric)))
}

/** 没手动设宽度时，气泡宽度跟宠物尺寸走。 */
export function defaultBubbleWidth(size: number): number {
  return Math.round(Math.min(360, Math.max(240, size * 0.75)))
}

export const PAGE_BUBBLE_ID = 'pet-pages'

/**
 * 翻页气泡的参数：常驻（`timeout: 0`），收起只由分页器负责。
 * 组件只在时长变化时才重排自己的收起计时器，给每页设限时会让第一页排的计时器
 * 在句长相近时照常触发，翻页中途气泡被收掉。
 * 不带 `motion`：常驻气泡带动作会参与声明式聚合，动作会一直循环；
 * 动作由调用方单独 `pet.motion` 播一次。
 */
export function pageBubble(text: string): { id: string; description: string; timeout: number } {
  return { id: PAGE_BUBBLE_ID, description: text, timeout: 0 }
}
