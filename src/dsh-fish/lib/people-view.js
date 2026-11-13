/**
 * people-view.js —— `fish:owner` 文档与提示段的纯渲染（person-memory Phase 1 Task 3）
 *
 * 这里只做“把派生出来的 owner 事实翻译成文本”，不读盘、不碰事件流：
 *   - `ownerDocText` 写 `<屋子>/home/关于他.md` 的正文；
 *   - `ownerSectionText` 拼 `fish:owner` 提示段（doc + 宿主扩展点 extras）；
 *   - `peopleSummary` 给 `/memory` 的 `people` 观测用（Phase 1 只有 owner facts）。
 *
 * 预算与注入边界（合并裁决 D6 / D34）：
 *   - owner 文档 ≤300 字、≤5 条，超预算按整行丢 fact，不切半个别名；
 *   - doc ≤300、extras ≤400、拼接后 ≤700；超总预算先截 extras；
 *   - 外来 label/name 先过 `guard.sanitizeForeign({ notice: false })`；
 *     命中 `looksLikeRewriting` 的整条 fact 丢弃，不做“劝她别听”的提示。
 *
 * `fish:people`（群/私聊笔记）是 Phase 2；这里只留一个返回空串的占位，避免调用方
 * 提前依赖还没实现的渲染。
 */

import { looksLikeRewriting, sanitizeForeign } from './guard.js'

/** owner 文档的标题、引导语与落款。三行固定，事实夹在中间。 */
const OWNER_HEADING = '## 关于他'
const OWNER_INTRO = '他可能从不同的地方找你。下面这些名字都是他：'
const OWNER_FOOTER = '别的名字不是他。拿不准时先问一句，别把别人当成他。'

/** 渠道的中文说法。未知渠道原样回退——宁可露出原值，也不要猜错。 */
export function channelLabel(channel) {
  const value = String(channel ?? '')
  if (value === 'wx') return '微信私聊'
  if (value === 'web') return '这里'
  if (value === 'core') return '共同'
  return value
}

/**
 * 清洗一个别名/名字：先识别重塑人格，再剥掉冒充系统的行。
 * @returns {string|null} null 表示整条 fact 应丢弃
 */
function cleanField(raw) {
  const value = String(raw ?? '')
  if (!value.trim()) return ''
  if (looksLikeRewriting(value).hit) return null
  const safe = sanitizeForeign(value, { notice: false }).text
  // 换行会破坏“一行一个别名”的格式，压成一行；清完为空也不能拿去渲染。
  const oneLine = safe.replace(/\s*\r?\n+\s*/g, ' ').trim()
  if (value.trim() && !oneLine) return null
  return oneLine
}

/** 按字符预算截断，保留一个省略号，绝不越界。 */
function capChars(text, maxChars) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return value
  if (maxChars <= 0) return ''
  return value.slice(0, maxChars - 1) + '…'
}

/**
 * 把 owner 事实渲染成 `关于他.md` 的正文。
 *
 * @param {Array<{label?:string, name?:string, channel?:string}>} ownerFacts
 *   调用方已按“最新在前”排序；这里只做去重与预算。
 * @param {{maxFacts?:number, maxChars?:number}} [opts]
 * @returns {string} 没有可渲染事实时返回空串（不输出空标题）
 */
export function ownerDocText(ownerFacts, { maxFacts = 5, maxChars = 300 } = {}) {
  const facts = Array.isArray(ownerFacts) ? ownerFacts : []
  const seen = new Set()
  const lines = []

  for (const fact of facts) {
    if (lines.length >= maxFacts) break
    const rawLabel = String(fact?.label ?? '')
    if (!rawLabel.trim()) continue
    const rawName = String(fact?.name ?? '')

    const label = cleanField(rawLabel)
    const name = cleanField(rawName)
    // D34：命中注入整条丢弃；name 坏掉也不渲染这条（它可能和别名一起被伪造）。
    if (label === null || name === null) continue
    if (!label) continue

    const channel = String(fact?.channel ?? '')
    const key = `${channel}|${label}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`- ${channelLabel(channel)}：${label}`)
  }

  if (!lines.length) return ''
  if (!Number.isFinite(maxChars) || maxChars <= 0) return ''

  const skeleton = [OWNER_HEADING, OWNER_INTRO]
  const tail = [OWNER_FOOTER]

  // 先试完整内容；放不下就从最后一条 fact 开始整行丢。
  // 丢弃发生后补一行 `…`，让读者知道“还有没列出来的别名”。
  for (let count = lines.length; count >= 1; count--) {
    const kept = lines.slice(0, count)
    const truncated = count < lines.length
    const body = [...skeleton, ...kept, ...tail, ...(truncated ? ['…'] : [])].join('\n')
    if (body.length <= maxChars) return body
  }
  // 连一条别名都放不下（正常不会发生）：不输出半个别名。
  return ''
}

/**
 * 拼 `fish:owner` 提示段。doc 与 extras 各有独立预算：
 *   doc ≤300、extras ≤400、总 ≤700；总预算超了先截 extras，doc 不被挤占。
 *
 * @param {{doc?:string, extras?:string}} [input]
 * @returns {string}
 */
export function ownerSectionText({ doc = '', extras = '' } = {}) {
  let docText = String(doc ?? '')
  let extrasText = String(extras ?? '')

  docText = capChars(docText, 300)
  extrasText = capChars(extrasText, 400)

  if (!docText) return extrasText
  if (!extrasText) return docText

  const sep = '\n\n'
  if (docText.length + sep.length + extrasText.length > 700) {
    extrasText = capChars(extrasText, Math.max(0, 700 - docText.length - sep.length))
    if (!extrasText) return docText
  }
  return docText + sep + extrasText
}

/**
 * `/memory` 的 `people` 观测数据（合并裁决 D32）。
 * Phase 1 没有数据也返回空数组/空对象，绝不返回 undefined。
 *
 * @param {object} [model] deriveSelf 的结果
 * @returns {{ownerFacts:object[], notesByChat:Record<string,object[]>, counts:{ownerFacts:number, personNotes:number, activePersonNotes:number}}}
 */
export function peopleSummary(model) {
  const source = model ?? {}
  const ownerFacts = Array.isArray(source.ownerFacts) ? source.ownerFacts : []

  const notesByChat = {}
  const grouped = source.personNotesByChat
  if (grouped instanceof Map) {
    for (const [chatId, notes] of grouped) {
      notesByChat[chatId] = Array.isArray(notes) ? notes : []
    }
  } else if (grouped && typeof grouped === 'object') {
    for (const [chatId, notes] of Object.entries(grouped)) {
      notesByChat[chatId] = Array.isArray(notes) ? notes : []
    }
  }

  const personNotes = Array.isArray(source.personNotes)
    ? source.personNotes
    : Object.values(notesByChat).flat()
  const activePersonNotes = Number.isFinite(source.personNoteCount)
    ? source.personNoteCount
    : personNotes.length

  return {
    ownerFacts,
    notesByChat,
    counts: {
      ownerFacts: ownerFacts.length,
      personNotes: personNotes.length,
      activePersonNotes,
    },
  }
}

/**
 * Phase 2 预留：`fish:people` 的群/私聊笔记渲染。
 * Phase 1 不实现；调用方拿到空串就当这段不存在。
 */
export function renderPeopleSection() {
  return ''
}
