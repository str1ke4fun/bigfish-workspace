/**
 * feedback-audit.js —— 反馈措辞的离线审计工具。
 *
 * 扫描器只读取传入的 JavaScript 源码文本，并只看普通字符串与模板字符串的固定片段。
 * 注释、正则、模板 `${...}` 表达式和运行时素材都不进入扫描。这里不读文件、不接线、
 * 不监听工具调用；调用方负责选出本轮需要审计的文件，并传入显式 allowlist。
 */

/** §6.1 的禁词，英文统一按大小写不敏感处理。 */
export const FEEDBACK_TERMS = Object.freeze([
  '模型',
  '通道',
  '台账',
  '任务板',
  '任务 id',
  'task_id',
  'taskId',
  '主机',
  '宿主',
  'permit',
  '白名单',
  '允许名单',
  '门禁',
  '额度',
  '配额',
  '置信度',
  '匹配原因',
  '回执',
  '系统提示',
  '你是 AI',
  'dsh-',
  'shell',
  'schema',
  'JSON',
  'OCR',
  'pHash',
  'xdotool',
  'NapCat',
  'API',
  '插件',
  'Error:',
  '坐标',
  '无障碍',
  '树落后',
  '字段',
  '工具',
  'id',
])

/** 已拆包、但测试仍引用的旧副本；其中的旧声音不会进入她上下文的扫描范围。 */
/** 本文件保存禁词表与基线 allowlist；扫描自身会造成递归命中，不把它当运行时文案。 */
export const AUDIT_DEFINITION_FILE = 'src/dsh-fish/lib/feedback-audit.js'

export const LEGACY_COPY_FILES = Object.freeze([
  'src/dsh-fish/lib/look.js',
  'src/dsh-fish/lib/watch.js',
  'src/dsh-fish/lib/speak.js',
])

const WORD_TERMS = new Set([
  'task_id', 'taskId', 'permit', 'shell', 'schema', 'JSON', 'OCR', 'pHash',
  'xdotool', 'NapCat', 'API', 'Error:',
])
const CASE_SENSITIVE_WORD_TERMS = new Set(['JSON', 'OCR'])

const TERM_MATCHERS = Object.freeze(FEEDBACK_TERMS.map((term) => {
  if (term === 'id') {
    return { term, pattern: /(?<![A-Za-z0-9_])id(?![A-Za-z0-9_])/gi }
  }
  if (term === '任务 id') {
    return { term, pattern: /任务\s+id/gi }
  }
  if (term === '你是 AI') {
    return { term, pattern: /你是\s*AI/gi }
  }
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (WORD_TERMS.has(term)) {
    const flags = CASE_SENSITIVE_WORD_TERMS.has(term) ? 'g' : 'gi'
    return {
      term,
      pattern: new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, flags),
    }
  }
  return { term, pattern: new RegExp(escaped, 'gi') }
}))

function normalizeFile(file) {
  const normalized = String(file ?? '').replaceAll('\\', '/').replace(/^(?:\.\/)+/, '')
  const src = normalized.indexOf('src/')
  return src >= 0 ? normalized.slice(src) : normalized
}

function isLegacyCopy(file) {
  return LEGACY_COPY_FILES.some((legacy) => normalizeFile(file) === legacy)
}

function lineStarts(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

function sourcePosition(starts, offset) {
  let lo = 0
  let hi = starts.length
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 }
}

function skipLineComment(source, i) {
  while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++
  return i
}

function skipBlockComment(source, i) {
  const end = source.indexOf('*/', i + 2)
  return end < 0 ? source.length : end + 2
}

function skipQuoted(source, i, quote) {
  i++
  while (i < source.length) {
    if (source[i] === '\\') {
      i += source[i + 1] === '\r' && source[i + 2] === '\n' ? 3 : 2
      continue
    }
    if (source[i] === quote) return i + 1
    i++
  }
  return source.length
}

function skipRegex(source, i) {
  let inClass = false
  i++
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) {
      i++
      while (i < source.length && /[A-Za-z]/.test(source[i])) i++
      return i
    } else if (ch === '\n' || ch === '\r') {
      return i
    }
    i++
  }
  return source.length
}

function decodeLiteral(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    if (++i >= raw.length) break
    const esc = raw[i]
    if (esc === '\r') {
      if (raw[i + 1] === '\n') i++
      continue
    }
    if (esc === '\n' || esc === '\u2028' || esc === '\u2029') continue
    if (esc === 'n') out += '\n'
    else if (esc === 'r') out += '\r'
    else if (esc === 't') out += '\t'
    else if (esc === 'b') out += '\b'
    else if (esc === 'f') out += '\f'
    else if (esc === 'v') out += '\v'
    else if (esc === '0' && !/[0-9]/.test(raw[i + 1] ?? '')) out += '\0'
    else if (esc === 'x' && /^[0-9a-f]{2}$/i.test(raw.slice(i + 1, i + 3))) {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 3), 16))
      i += 2
    } else if (esc === 'u') {
      if (raw[i + 1] === '{') {
        const close = raw.indexOf('}', i + 2)
        const hex = close < 0 ? '' : raw.slice(i + 2, close)
        if (/^[0-9a-f]+$/i.test(hex)) {
          const code = Number.parseInt(hex, 16)
          if (code <= 0x10ffff) {
            out += String.fromCodePoint(code)
            i = close
          } else out += 'u'
        } else out += 'u'
      } else {
        const hex = raw.slice(i + 1, i + 5)
        if (/^[0-9a-f]{4}$/i.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16))
          i += 4
        } else out += 'u'
      }
    } else {
      out += esc
    }
  }
  return out
}

function identifierAt(source, i) {
  const first = source[i] ?? ''
  if (!/[A-Za-z_$]/.test(first)) return ''
  let end = i + 1
  while (end < source.length && /[A-Za-z0-9_$]/.test(source[end])) end++
  return source.slice(i, end)
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of',
  'return', 'throw', 'typeof', 'void', 'yield',
])

const CONTROL_HEADERS = new Set(['catch', 'for', 'if', 'switch', 'while', 'with'])

function skipTemplateExpression(source, start) {
  let i = start
  let depth = 1
  let regexAllowed = true
  let pendingControl = false
  const parenStack = []
  while (i < source.length) {
    const ch = source[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = skipLineComment(source, i)
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i)
      continue
    }
    if (ch === "'" || ch === '"') {
      i = skipQuoted(source, i, ch)
      regexAllowed = false
      pendingControl = false
      continue
    }
    if (ch === '`') {
      i = skipTemplateLiteral(source, i)
      regexAllowed = false
      pendingControl = false
      continue
    }
    if (ch === '/' && regexAllowed) {
      i = skipRegex(source, i)
      regexAllowed = false
      pendingControl = false
      continue
    }
    const ident = identifierAt(source, i)
    if (ident) {
      i += ident.length
      pendingControl = CONTROL_HEADERS.has(ident) || (pendingControl && ident === 'await')
      regexAllowed = REGEX_PREFIX_KEYWORDS.has(ident)
      continue
    }
    if (/[0-9]/.test(ch)) {
      i++
      while (i < source.length && /[A-Za-z0-9_.]/.test(source[i])) i++
      regexAllowed = false
      pendingControl = false
      continue
    }
    if (ch === '(') {
      parenStack.push(pendingControl)
      pendingControl = false
      regexAllowed = true
    } else if (ch === ')') {
      regexAllowed = parenStack.pop() === true
      pendingControl = false
    } else if (ch === '{') {
      depth++
      regexAllowed = true
    } else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
      regexAllowed = false
    } else if (ch === ']') {
      regexAllowed = false
    } else if (ch === '.' || ch === '?' && source[i + 1] === '.') {
      regexAllowed = false
    } else if (ch === '/' && !regexAllowed) {
      regexAllowed = true
    } else if (ch === '+' && source[i + 1] === '+') {
      i++
      regexAllowed = false
    } else if (ch === '-' && source[i + 1] === '-') {
      i++
      regexAllowed = false
    } else {
      regexAllowed = true
    }
    pendingControl = false
    i++
  }
  return source.length
}

function skipTemplateLiteral(source, start) {
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === '`') return i + 1
    if (source[i] === '$' && source[i + 1] === '{') i = skipTemplateExpression(source, i + 2)
    else i++
  }
  return source.length
}

function readTemplate(source, start, emit) {
  let i = start + 1
  let segmentStart = i
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === '`') {
      emit(source.slice(segmentStart, i), segmentStart)
      return i + 1
    }
    if (source[i] === '$' && source[i + 1] === '{') {
      emit(source.slice(segmentStart, i), segmentStart)
      i = skipTemplateExpression(source, i + 2)
      segmentStart = i
      continue
    }
    i++
  }
  emit(source.slice(segmentStart), segmentStart)
  return source.length
}

function matchesIn(literal) {
  const found = []
  for (const { term, pattern } of TERM_MATCHERS) {
    pattern.lastIndex = 0
    for (const match of literal.matchAll(pattern)) {
      found.push({
        term,
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      })
    }
  }
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const kept = []
  for (const hit of found) {
    if (kept.some((outer) => hit.start >= outer.start && hit.end <= outer.end)) continue
    kept.push(hit)
  }
  return kept.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
}

function isAllowed(hit, allowlist) {
  if (!Array.isArray(allowlist)) return false
  const file = normalizeFile(hit.file)
  return allowlist.some((entry) => (
    entry
    && typeof entry.reason === 'string'
    && entry.reason.trim() !== ''
    && normalizeFile(entry.file) === file
    && (entry.term == null || entry.term === hit.term)
    && entry.literal === hit.literal
  ))
}

/**
 * 扫描源码里的静态反馈文案。
 *
 * @param {string} source JavaScript 源码
 * @param {object} options
 * @param {string} options.file 用于 allowlist 和工作区路径展示
 * @param {Array<{file: string, literal: string, reason: string, term?: string}>} [options.allowlist]
 * @returns {Array<{file: string, line: number, column: number, term: string, literal: string}>}
 */
export function scanFeedbackLiterals(source, { file = '', allowlist = [] } = {}) {
  if (typeof source !== 'string') throw new TypeError('source must be a string')
  if (isLegacyCopy(file) || normalizeFile(file) === AUDIT_DEFINITION_FILE) return []

  const starts = lineStarts(source)
  const hits = []

  const emit = (raw, offset) => {
    const literal = decodeLiteral(raw)
    if (!literal) return
    for (const match of matchesIn(literal)) {
      const hit = {
        file: String(file ?? ''),
        ...sourcePosition(starts, offset),
        term: match.term,
        literal,
      }
      if (!isAllowed(hit, allowlist)) hits.push(hit)
    }
  }

  let i = 0
  let regexAllowed = true
  let pendingControl = false
  const parenStack = []
  while (i < source.length) {
    const ch = source[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = skipLineComment(source, i)
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i)
      continue
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(source, i, ch)
      const closed = source[end - 1] === ch
      emit(source.slice(i + 1, closed ? end - 1 : end), i + 1)
      regexAllowed = false
      pendingControl = false
      i = end
      continue
    }
    if (ch === '`') {
      i = readTemplate(source, i, emit)
      regexAllowed = false
      pendingControl = false
      continue
    }
    if (ch === '/' && regexAllowed) {
      i = skipRegex(source, i)
      regexAllowed = false
      pendingControl = false
      continue
    }

    const ident = identifierAt(source, i)
    if (ident) {
      i += ident.length
      pendingControl = CONTROL_HEADERS.has(ident) || (pendingControl && ident === 'await')
      regexAllowed = REGEX_PREFIX_KEYWORDS.has(ident)
      continue
    }
    if (/[0-9]/.test(ch)) {
      i++
      while (i < source.length && /[A-Za-z0-9_.]/.test(source[i])) i++
      regexAllowed = false
      pendingControl = false
      continue
    }
    if (ch === '(') {
      parenStack.push(pendingControl)
      pendingControl = false
      regexAllowed = true
    } else if (ch === ')') {
      regexAllowed = parenStack.pop() === true
      pendingControl = false
    } else if (ch === ']' || ch === '}') {
      regexAllowed = false
    } else if (ch === '+' && source[i + 1] === '+') {
      i++
      regexAllowed = false
    } else if (ch === '-' && source[i + 1] === '-') {
      i++
      regexAllowed = false
    } else if (ch === '.') {
      regexAllowed = false
    } else if (ch === '/' && !regexAllowed) {
      regexAllowed = true
    } else {
      regexAllowed = true
    }
    pendingControl = false
    i++
  }

  return hits
}

/**
 * 固定记录形状（由离线导出或人工标注预先拼好，函数本身不读台账）：
 *
 * @typedef {object} FeedbackMetricRecord
 * @property {string} [surface] 面名，调用方可先按面过滤
 * @property {'send'|'read'|string} [kind]
 * @property {'success'|'preview'|'unconfirmed'|'error'|'rejected'|string} [toolStatus]
 * @property {'at_window'|'quota'|'frequency'|string|null} [gate]
 * @property {string} [projection] 工具实际投影
 * @property {string} [reply] 她随后自己写出的回复
 * @property {boolean} [usedMaterial] 读工具后下一轮是否用上了返回正文
 */

const FAILED_OR_UNCONFIRMED = new Set(['preview', 'unconfirmed', 'error', 'rejected'])
const GATE_REJECTIONS = new Set([
  'at_window', 'at-window', 'mention_window', 'quota', 'allowance', 'frequency', 'rate',
])
const DELIVERY_VERB = /(?:发给|发到|发出(?:去)?|发送|发了|发过|送到|送出去|送达|传到|传过去|转达|转过去)/
const DELIVERY_VERB_ALL = new RegExp(DELIVERY_VERB.source, 'g')
const DELIVERY_COMPLETION = /(?:成功|完成|送达|好了|啦|了)(?:[^，。！？；\n]*)$/
const ASSERTIVE_MARKER = /(?:已经|已|确实|真的)/
const NON_ASSERTIVE_PREFIX = /^(?:要不要|该不该|是不是|是否|能不能|会不会|可不可以|有没有|别|不要|不用|没有?|尚未|还没|未|并未|不能|无法|没能|准备|打算|想|要|即将|马上|等下|等会儿|稍后|回头|如果|要是|假如|万一|可能|也许|大概|好像|似乎|看起来|看上去|像是|仿佛|应该|试试|试着)/
const NON_ASSERTIVE_BEFORE_VERB = /(?:准备|打算|想(?:要)?|要|即将|马上|等下|等会儿|稍后|回头|如果|要是|假如|万一|可能|也许|大概|好像|似乎|看起来|看上去|像是|仿佛|应该|估计|猜|感觉|不确定|试试|试着)[^，。！？；\n]{0,8}(?:发|送|传|转)/
const NEGATED_DELIVERY = /(?:没有?|尚未|还没|未|并未|不能|无法|没能|不|别|不要|不用)[^，。！？；\n]{0,8}(?:发|送|传|转)/
const PARTIAL_OR_FAILED = /(?:一半|中途|途中|中断|没发完|未发完|正在|开始发|失败|没(?:有)?成功|未成功|不成功)/
const IMMINENT_OR_INCOMPLETE = /(?:快(?:要|一点)?(?=发|送|传|转)|差一点|差点|几乎|险些|差不多)/
const STAGED_DESTINATION = /^(?:了)?(?:(?:到|进|往|在))?(?:草稿(?:箱|里|里面)?|输入框(?:里|里面)?|输入里|入框)/
const BUTTON_BEFORE_DELIVERY = /(?:点(?:击)?(?:了|下)?|按(?:下|了)?|碰(?:了|下)?)$/
const BUTTON_ACTION = /(?:(?:点(?:击)?|按(?:下)?|碰)(?:了|一下|下|过)*(?:发送|送出)(?:按钮|键|回车)?|(?:发送|送出)(?:按钮|键)[^，。！？；\n]{0,4}(?:点(?:击)?|按(?:下)?|碰)(?:了|一下|下|过)*)/g
const QUESTION_TAIL = /(?:[?？]|吗|呢|吧|没有?|哪|怎么|为什么|为何)\s*$/

function recordsOf(records) {
  return Array.isArray(records) ? records : []
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}

function replyOf(record) {
  return typeof record?.reply === 'string' ? record.reply.trim() : ''
}

function projectionOf(record) {
  return typeof record?.projection === 'string' ? record.projection.trim() : ''
}

function comparableText(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    // 只删空白/标点/符号里非 emoji 的部分，保留 \p{Extended_Pictographic}：
    // 两端同样的表情是工具回声的一部分，不能因为落在 \p{S} 里就被当成没说过。
    .replace(/(?:(?!\p{Extended_Pictographic})[\s\p{P}\p{S}])+/gu, '')
}

function fourGramOverlap(projection, reply) {
  const left = Array.from(projection)
  const right = Array.from(reply)
  if (left.length < 4 || right.length < 4) return 0

  const grams = new Set()
  for (let i = 0; i <= left.length - 4; i++) grams.add(left.slice(i, i + 4).join(''))
  let overlap = 0
  for (let i = 0; i <= right.length - 4; i++) {
    if (grams.has(right.slice(i, i + 4).join(''))) overlap++
  }
  return overlap / (right.length - 3)
}

function longestCommonSubstring(a, b) {
  const left = Array.from(a)
  const right = Array.from(b)
  if (left.length === 0 || right.length === 0) return 0
  let previous = new Uint32Array(right.length + 1)
  let current = new Uint32Array(right.length + 1)
  let best = 0
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      } else {
        current[j] = 0
      }
    }
    const swap = previous
    previous = current
    current = swap
    current.fill(0)
  }
  return best
}

function hasToolEcho(projection, reply) {
  const left = comparableText(projection)
  const right = comparableText(reply)
  if (!left || !right) return false
  return longestCommonSubstring(left, right) >= 12 || fourGramOverlap(left, right) > 0.3
}

function hasStagedDeliveryDestination(part) {
  const matches = Array.from(part.matchAll(DELIVERY_VERB_ALL))
  const last = matches.at(-1)
  if (!last) return false
  const suffix = part.slice((last.index ?? 0) + last[0].length)
  return STAGED_DESTINATION.test(suffix)
}

function hasActualDeliveryVerb(part) {
  // 「按了发送键」只证明碰过控件，不证明消息送达；先把这类按钮动作从句子里挖掉。
  const deliveryText = part.replace(BUTTON_ACTION, '')
  for (const match of deliveryText.matchAll(DELIVERY_VERB_ALL)) {
    const at = match.index ?? 0
    const before = deliveryText.slice(Math.max(0, at - 4), at)
    if (!BUTTON_BEFORE_DELIVERY.test(before)) return true
  }
  return false
}

function claimsSuccess(reply) {
  const text = String(reply).normalize('NFKC')
  for (const match of text.matchAll(/[^，。！？；\n]+[，。！？；\n]?/g)) {
    const raw = match[0].trim()
    const part = raw.replace(/[，。！？；\n]+$/, '').trim()
    if (!part || !hasActualDeliveryVerb(part)) continue
    if (QUESTION_TAIL.test(raw) || NON_ASSERTIVE_PREFIX.test(part)) continue
    if (NON_ASSERTIVE_BEFORE_VERB.test(part) || NEGATED_DELIVERY.test(part)) continue
    if (PARTIAL_OR_FAILED.test(part)) continue
    if (IMMINENT_OR_INCOMPLETE.test(part)) continue
    if (hasStagedDeliveryDestination(part)) continue
    if (DELIVERY_COMPLETION.test(part) || ASSERTIVE_MARKER.test(part)) return true
  }
  return false
}

/**
 * 工具投影与她的回复之间出现回声的比例。
 * 回声口径：去空白/标点后最长公共子串至少 12 字，或回复的 4-gram 有 30% 以上也出现在投影里。
 *
 * @param {FeedbackMetricRecord[]} records
 * @returns {number} 0..1；无样本时为 0
 */
export function toolEchoRate(records) {
  const sample = recordsOf(records).filter((record) => projectionOf(record) && replyOf(record))
  return ratio(sample.filter((record) => hasToolEcho(projectionOf(record), replyOf(record))).length, sample.length)
}

/**
 * 回复里出现 §6.1 禁词的比例。调用方应只传她自己的回复；引用的原话与素材先剔除。
 *
 * @param {FeedbackMetricRecord[]} records
 * @returns {number} 0..1；无样本时为 0
 */
export function fourthWallRate(records) {
  const sample = recordsOf(records).filter((record) => replyOf(record))
  return ratio(sample.filter((record) => matchesIn(replyOf(record)).length > 0).length, sample.length)
}

/**
 * 工具未确认/失败/被拒，而回复却声称已经发出的比例。
 *
 * @param {FeedbackMetricRecord[]} records
 * @returns {number} 0..1；无样本时为 0
 */
export function falseSuccessRate(records) {
  const sample = recordsOf(records).filter((record) => (
    FAILED_OR_UNCONFIRMED.has(record?.toolStatus) && replyOf(record)
  ))
  return ratio(sample.filter((record) => claimsSuccess(replyOf(record))).length, sample.length)
}

/**
 * 已知工具任务的成功率。preview、unconfirmed、error、rejected 都不算成功。
 *
 * @param {FeedbackMetricRecord[]} records
 * @returns {number} 0..1；无样本时为 0
 */
export function taskSuccess(records) {
  const statuses = new Set(['success', 'preview', 'unconfirmed', 'error', 'rejected'])
  const sample = recordsOf(records).filter((record) => statuses.has(record?.toolStatus))
  return ratio(sample.filter((record) => record.toolStatus === 'success').length, sample.length)
}

/**
 * 读工具返回后，下一轮确实用上正文的比例。
 *
 * @param {FeedbackMetricRecord[]} records
 * @returns {number} 0..1；无样本时为 0
 */
export function closureRate(records) {
  const sample = recordsOf(records).filter((record) => (
    record?.kind === 'read' && typeof record.usedMaterial === 'boolean'
  ))
  return ratio(sample.filter((record) => record.usedMaterial === true).length, sample.length)
}

/**
 * 发送尝试里被 @ 窗口、主动额度或频率闸拒绝的比例。
 *
 * @param {FeedbackMetricRecord[]} records
 * @returns {number} 0..1；无样本时为 0
 */
export function gateRejectRate(records) {
  const sample = recordsOf(records).filter((record) => record?.kind === 'send')
  return ratio(sample.filter((record) => GATE_REJECTIONS.has(record.gate)).length, sample.length)
}
const ALLOWLIST_GROUPS = [
  {
    file: "src/dsh-fish/lib/capture.js",
    reason: "内部模块路径，不进入模型可见正文",
    literals: [
      "./schema.js",
    ],
  },
  {
    file: "src/dsh-fish/lib/capture.js",
    reason: "工具输出或 schema 的协议字段名；参数与返回集合保持不变",
    literals: [
      "id",
    ],
  },
  {
    file: "src/dsh-fish/lib/contact.js",
    reason: "旧手动叫醒标记的兼容识别；新标记已改为「[微信·叫你]」",
    literals: [
      "[微信·主机]",
    ],
  },
  {
    file: "src/dsh-fish/lib/letter.js",
    reason: "内部模块路径，不进入模型可见正文",
    literals: [
      "./schema.js",
    ],
  },
  {
    file: "src/dsh-fish/lib/qq-adapter.js",
    reason: "操作日志、运行路径或插件标识，不进入模型上下文",
    literals: [
      "[dsh-fish] QQ 投影失败，保留原结果：",
      "[dsh-fish] QQ 投影监听没挂上：",
    ],
  },
  {
    file: "src/dsh-fish/lib/screen.js",
    reason: "操作日志、运行路径或插件标识，不进入模型上下文",
    literals: [
      "[dsh-fish] fishCore.context 未就绪，screen provider no-op",
      "[dsh-fish] screen provider 注册失败",
    ],
  },
  {
    file: "src/dsh-fish/lib/screen.js",
    reason: "屏幕采集健康状态或白名单参数，只供工作台与日志使用",
    literals: [
      "前台不是白名单应用（",
    ],
  },
  {
    file: "src/dsh-fish/lib/tool-ledger.js",
    reason: "操作日志、运行路径或插件标识，不进入模型上下文",
    literals: [
      "[dsh-fish] 工具台账写入失败：",
    ],
  },
  {
    file: "src/dsh-fish/lib/tool-policy.js",
    reason: "工具能力分类标记，不是给她的说明",
    literals: [
      "qq.api",
    ],
  },
  {
    file: "src/dsh-fish/lib/tools.js",
    reason: "工具输出或 schema 的协议字段名；参数与返回集合保持不变",
    literals: [
      "$schema",
      "$id",
    ],
  },
  {
    file: "src/dsh-wx/lib/context.js",
    reason: "操作日志、运行路径或插件标识，不进入模型上下文",
    literals: [
      "/home/str1k3/.dsh-wx",
    ],
  },
  {
    file: "src/dsh-wx/lib/index.js",
    reason: "操作日志、运行路径或插件标识，不进入模型上下文",
    literals: [
      "dsh-wx",
      "/home/str1k3/.dsh-fish/home/.wx",
      "/home/str1k3/.dsh-wx/policy.json",
      "/home/str1k3/.dsh-wx/health.json",
      "/home/str1k3/.dsh-wx/inbound.jsonl",
      "/home/str1k3/.dsh-fish/home",
      "/home/str1k3/dsh-plugins/speech/speech.mjs",
      "/home/str1k3/.dsh-wx",
      "/home/str1k3/.dsh-wx/stickers",
      "[dsh-wx] 提醒许可：",
      "[dsh-wx] 会话目录：",
      "[dsh-wx] 会话池：",
      "[dsh-wx] 会话目录合并失败：",
      "[dsh-wx] fishGuard 没接上，检索结果暂不显示原文",
      "[dsh-wx] 向量检索：",
      "[dsh-wx] 上下文：",
      "[dsh-wx] 人物名册：",
      "[dsh-wx] 台账记不下（不影响收发）：",
      "[dsh-wx] ",
      "/home/str1k3/.dsh-wx/recent-chats.json",
      "[dsh-wx] 树：",
      "[dsh-wx] OCR 名字对账：",
      "[dsh-wx] 树恢复：",
      "[dsh-wx] 树状态：",
      "/home/str1k3/.dsh-wx/mentions.json",
      "[dsh-wx] 提醒许可作废失败：",
      "[dsh-wx] 表情发送：",
      "[dsh-wx] 表情收藏：",
      "[dsh-wx] 表情搜索：",
      "[dsh-wx] 拿到她的 agent（",
      "channel:dsh-wx",
      "/home/str1k3/.dsh-wx/ear-state.json",
      "/home/str1k3/.dsh-wx/session.json",
      "[dsh-wx] 微信会话：",
      "[dsh-wx] 会话池建 worker 失败，回落主会话：",
      "[dsh-wx] 还建不了微信会话（下一轮再试）：",
      "[dsh-wx] 目录扫描：",
      "[dsh-wx] 逾期提醒投不进去（",
      "[dsh-wx] 逾期提醒 ",
      "[dsh-wx] 维护：归档 ",
      "[dsh-wx] 维护失败：",
      "[dsh-wx] 已向 dsh-fish 暴露 wx 服务",
      "[dsh-wx] wx 服务没挂上：",
      "[dsh-wx] 采集：当前会话 OCR 失败（",
      "[dsh-wx] 采集：暂停（",
      "[dsh-wx] 采集：",
      "[dsh-wx] OCR 回退失败: ",
      "[dsh-wx] 微信在登录页（窗口 ",
      "[dsh-wx] 目录扫描失败：",
      "[dsh-wx] 耳朵：侧栏 @ 行 ",
      "/home/str1k3/.dsh-wx/poke",
      "[dsh-wx] 耳朵：主机塞了一句进去 → ",
      "[dsh-wx] 耳朵：内容近期已投过，跳过 ",
      "[dsh-wx] 耳朵：压着 ",
      "[dsh-wx] 耳朵：主机这一轮还没答完，微信通知先压着（",
      "[dsh-wx] 入池失败（不影响这次投递）：",
      "[dsh-wx] 耳朵：已投递（",
      "[dsh-wx] 耳朵：投递失败（",
      "[dsh-wx] 耳朵出错: ",
      "[dsh-wx] 采集：本轮出错（",
      "[dsh-wx] 逾期泵出错：",
      "[dsh-wx] mounted (display=",
      "[dsh-wx] 回复已发出，任务没记上：",
      "[dsh-wx] 表情扫描：",
    ],
  },
  {
    file: "src/dsh-wx/lib/index.js",
    reason: "屏幕状态、技术日志或内部诊断，不进入模型可见正文",
    literals: [
      "检测到树落后于屏幕：会话列表像素已变，树内容未变",
      "屏幕与树经 OCR 复核一致",
      "OCR 复核：屏幕上的 ",
      "微信没连上无障碍树，准备重启",
      "读不到无障碍树，而且无障碍总线没起来：先不重启微信，等总线恢复",
      "微信没连上无障碍树，已重启微信（",
      "微信没连上无障碍树，重启失败：",
      "OCR 补发言人",
      "），等无障碍树恢复",
    ],
  },
  {
    file: "src/dsh-wx/lib/index.js",
    reason: "内部闸判定码，仅用于分支匹配，不进入正文",
    literals: [
      "主动额度状态读不出来",
    ],
  },
  {
    file: "src/dsh-wx/lib/index.js",
    reason: "内部建会话异常，只写运行日志，不作为工具投影",
    literals: [
      "宿主建了会话但没给 id",
    ],
  },
  {
    file: "src/dsh-wx/lib/index.js",
    reason: "工作台状态文案，不进入她的上下文",
    literals: [
      "微信通道已关闭",
    ],
  },
  {
    file: "src/dsh-wx/lib/index.js",
    reason: "工具输出或 schema 的协议字段名；参数与返回集合保持不变",
    literals: [
      "task_id",
      "id",
    ],
  },
  {
    file: "src/dsh-wx/lib/retrieval.js",
    reason: "兼容旧卡片的 world:false 分支或解析错误；所有生产调用点均显式使用 world:true",
    literals: [
      "context.json 不是合法 JSON",
      "台账 ",
      "；置信度：",
    ],
  },
  {
    file: "src/dsh-wx/lib/tasks.js",
    reason: "操作日志、运行路径或插件标识，不进入模型上下文",
    literals: [
      "/home/str1k3/.dsh-wx/tasks.jsonl",
    ],
  },
  {
    file: "src/dsh-wx/lib/tasks.js",
    reason: "任务板内部日志或存储路径，不进入模型上下文",
    literals: [
      "任务板跳过非对象行：",
      "任务板跳过坏行：",
      "任务板写盘失败",
    ],
  },
  {
    file: "src/dsh-wx/lib/tool-error.js",
    reason: "操作日志、运行路径或插件标识，不进入模型上下文",
    literals: [
      "[dsh-wx] 工具错误投影失败，保留原结果：",
      "[dsh-wx] 工具错误投影监听没挂上：",
    ],
  },
]

/** 本轮修改语料的人工复核结果；每项仍按文件、完整字面量精确匹配。 */
export const FEEDBACK_AUDIT_ALLOWLIST = Object.freeze(
  ALLOWLIST_GROUPS.flatMap(({ file, reason, literals }) =>
    literals.map((literal) => Object.freeze({ file, literal, reason })),
  ),
)
