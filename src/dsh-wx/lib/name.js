/**
 * 微信名字的底层原语。
 *
 * 微信群名、联系人名大量使用 emoji 组合序列（ZWJ 家庭、带肤色的手势、keycap、
 * 旗帜、苏格兰旗这类 tag 序列），还有 VS15/VS16 变体选择符。这些序列被截断、
 * OCR 误读或输入法拼写不一致时，会留下半截的代理对、孤立的 ZWJ/VS、单个
 * regional indicator。这里提供一套不依赖外部包的规范化、折叠和匹配工具，
 * 供目录、会话树、发送身份、OCR 与工作台共用。
 *
 * 约定：
 * - `displayName` 与各比较键只用于展示/比较；`chatIdSeed` 保留历史语义，只做 trim + 压空白。
 * - `cleanTruncated` 只用于确认被截断的字符串，不能当通用 sanitize 用。
 * - 所有正则都不带捕获组，避免状态泄漏。
 */

const SANITIZE = /[\p{Cc}\p{Cs}�‪-‮⁦-⁩​‌⁠]/gu

/**
 * 清洗不可见字符。
 *
 * 去掉控制符、孤立代理、U+FFFD、bidi 嵌入/覆盖/隔离、零宽空格（U+200B）、
 * 零宽不连字（U+200C）和 word joiner（U+2060）。保留 ZWJ（U+200D）、
 * VS15/VS16、肤色修饰符以及 U+1F3F4 之后的 tag 字符——它们都是合法 emoji
 * 序列的组成部分，提前删掉会让完整名字变形。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeName(value) {
  return String(value ?? '').replace(SANITIZE, '')
}

/**
 * 展示用名字：NFC、压空白、trim，再清洗。完整 emoji 序列的尾部不会被改写。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function displayName(value) {
  return sanitizeName(String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim())
}

/** 名字的精确比较键。 @param {unknown} value @returns {string} */
export function nameKey(value) {
  return displayName(value)
}

/**
 * 折叠键：在 displayName 基础上去掉 VS15/VS16 与零宽字符。
 * 只折叠变体选择符，不折叠 ZWJ、肤色、tag 或 regional indicator。
 */
const FOLDED_DROP = /[︎️​‌⁠]/gu

export function foldedKey(value) {
  return displayName(value).replace(FOLDED_DROP, '')
}

/**
 * 骨架键：只留字母和数字。emoji、标点、符号、组合记号、格式符和空白全部去掉。
 * 纯 emoji 名字的骨架为空字符串。
 */
const SKELETON_DROP = /[\p{P}\p{S}\p{M}\p{Cf}\p{Cs}\s]+/gu

export function skeleton(value) {
  return displayName(value).replace(SKELETON_DROP, '')
}

/**
 * 历史 chat id 的种子：只 trim + 把连续空白压成一个空格。
 * 故意不做 NFC、不清洗、不折叠，保证已有 id 稳定。
 */
export function chatIdSeed(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

/** Intl.Segmenter 只创建一次。 */
const GRAPHEME_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'grapheme' })

/** 按字素簇计数（旗帜、keycap、ZWJ 家庭都算 1）。 */
export function graphemeLength(value) {
  let count = 0
  for (const _ of GRAPHEME_SEGMENTER.segment(String(value ?? ''))) count++
  return count
}

/** 截断后可能悬在末尾的修饰符：ZWJ、VS15/VS16、keycap 组合符、肤色、tag、U+FFFD。 */
const DANGLING_TAIL = new Set([0x200d, 0xfe0e, 0xfe0f, 0x20e3, 0xfffd])

function isDanglingTail(cp) {
  return (
    DANGLING_TAIL.has(cp) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    (cp >= 0xe0020 && cp <= 0xe007f) ||
    (cp >= 0xd800 && cp <= 0xdfff) // 孤立代理（成对代理已被 Array.from 合成）
  )
}

function isRegionalIndicator(cp) {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff
}

/**
 * 清理“确认被截断”的字符串尾部：
 * 1. 去掉末尾的 `...` / `…`；
 * 2. 反复去掉悬空的 ZWJ/VS/keycap/肤色/tag/U+FFFD 与孤立代理；
 * 3. 末尾连续 regional indicator 为奇数时去掉最后一个；
 * 4. trim。
 *
 * 不要对完整名字调用它——它会把合法的尾部修饰符也去掉。
 */
export function cleanTruncated(value) {
  let s = String(value ?? '').replace(/\s*(?:\.{2,}|…)\s*$/u, '')
  const cps = Array.from(s)
  while (cps.length > 0 && isDanglingTail(cps[cps.length - 1].codePointAt(0))) cps.pop()
  let regions = 0
  for (let i = cps.length - 1; i >= 0; i--) {
    if (!isRegionalIndicator(cps[i].codePointAt(0))) break
    regions++
  }
  if (regions % 2 === 1) cps.pop()
  return cps.join('').trim()
}

/** 至少含一个字母、数字或 emoji（旗帜、keycap、© 也算名字字符）。 */
const NAME_CHARACTER = /[\p{L}\p{N}\p{Emoji}]/u

export function hasNameCharacter(value) {
  return NAME_CHARACTER.test(String(value ?? ''))
}

/** 两个名字在展示层面是否相同。 */
export function sameName(a, b) {
  return nameKey(a) === nameKey(b)
}

const TIER_KEYS = {
  exact: nameKey,
  folded: foldedKey,
  skeleton,
}

/**
 * 取某个匹配层级上的键。
 * @param {unknown} value
 * @param {'exact'|'folded'|'skeleton'} tier
 * @returns {string}
 */
export function tierKey(value, tier) {
  const keyFn = TIER_KEYS[tier]
  if (!keyFn) throw new Error(`unknown name tier: ${tier}`)
  return keyFn(value)
}

/**
 * 在候选名字里找一个最可能的匹配。
 *
 * 折叠撞名优先：只要 tiers 含 folded，先统计与输入 foldedKey 相同的候选；
 * 多于一个就立即 ambiguous，哪怕其中一个和输入完全相等也不选它。
 *
 * 然后按 tiers 顺序逐层过滤（默认 exact → folded）；某一层命中多个立即
 * ambiguous，不再下降到更宽的层；全部落空返回 unknown。
 *
 * `prefix` 允许前缀匹配，但较短一方至少要有 2 个字素，避免单字/单个 emoji 把整组
 * 候选都吸进来。`prefix: true` 对称（两边任一方向前缀都算）；`prefix: 'candidate'`
 * 只接受候选比输入长（候选以输入开头），用于 OCR 截断；`prefix: 'input'` 只接受
 * 输入比候选长。截断对账必须用 `'candidate'`，否则「家庭群(2)」会被反向缩成「家庭群」。
 *
 * skeleton 层只在输入和候选的骨架都非空、且各 ≥ 2 个字素时参与（design §4.1）；
 * 纯 emoji/符号名的骨架是空串，不能靠骨架互相改写。
 *
 * @param {string} input
 * @param {string[]} candidates
 * @param {{ tiers?: Array<'exact'|'folded'|'skeleton'>, prefix?: boolean|'candidate'|'input' }} [opts]
 * @returns {{ status: 'exact'|'folded'|'resolved'|'ambiguous'|'unknown', match: string|null, matches: string[] }}
 */
export function matchOne(input, candidates, opts = {}) {
  const tiers = opts.tiers ?? ['exact', 'folded']
  const prefixMode = opts.prefix === true
    ? 'both'
    : (opts.prefix === 'candidate' || opts.prefix === 'input' ? opts.prefix : null)
  const list = Array.isArray(candidates) ? candidates : []

  if (tiers.includes('folded')) {
    const foldedInput = foldedKey(input)
    const clashes = list.filter((candidate) => foldedKey(candidate) === foldedInput)
    if (clashes.length > 1) return { status: 'ambiguous', match: null, matches: clashes }
  }

  for (const tier of tiers) {
    const keyFn = TIER_KEYS[tier]
    if (!keyFn) throw new Error(`unknown name tier: ${tier}`)
    const key = keyFn(input)
    // skeleton 只留字母/数字；空骨架（纯 emoji/符号）或 1 个字素不参与，避免互相改写。
    if (tier === 'skeleton' && (!key || graphemeLength(key) < 2)) continue
    const hits = list.filter((candidate) => {
      const candidateKey = keyFn(candidate)
      if (tier === 'skeleton' && (!candidateKey || graphemeLength(candidateKey) < 2)) return false
      if (candidateKey === key) return true
      if (!prefixMode) return false
      const candidateExtends = candidateKey.startsWith(key)
      const inputExtends = key.startsWith(candidateKey)
      if (prefixMode === 'candidate' && !candidateExtends) return false
      if (prefixMode === 'input' && !inputExtends) return false
      if (prefixMode === 'both' && !candidateExtends && !inputExtends) return false
      return Math.min(graphemeLength(candidateKey), graphemeLength(key)) >= 2
    })
    if (hits.length === 1) {
      return { status: tier === 'skeleton' ? 'resolved' : tier, match: hits[0], matches: hits }
    }
    if (hits.length > 1) return { status: 'ambiguous', match: null, matches: hits }
  }

  return { status: 'unknown', match: null, matches: [] }
}
