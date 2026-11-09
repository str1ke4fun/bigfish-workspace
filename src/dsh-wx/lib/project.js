/**
 * project.js —— dsh-wx 工具的模型投影
 *
 * `wrapRenderOnly` 只在 render 时读这里的结果：execute 的返回值和 output.schema
 * 都不变，模型看到的是去掉坐标 / 置信度 / 台账编号之后的文字。
 *
 * 纯函数，不 import 任何东西：测试不启动 GUI，也不依赖 dsh-fish 是否安装。
 */

const OCR_LIMIT = 2000
const PEEK_LIMIT = 12_000

const CONTEXT_META = /^\s*(?:匹配|来源|置信度)\s*[：:]/
const OCR_SKIP_KEYS = new Set(['box', 'confidence', 'score', 'x', 'y', 'width', 'height'])

/** 按字符截断（中文一个字算一个），尾部标明截断。 */
function cut(text, limit) {
  const chars = [...String(text ?? '')]
  if (chars.length <= limit) return chars.join('')
  return chars.slice(0, limit).join('') + '\n…（已截断）'
}

/**
 * wx_context：每条引用卡片第三行是「匹配：…；来源：台账 msg_1；置信度：…」。
 * 这些是给维护者看的检索元数据，模型只需要原文和发言人，整行去掉。
 */
export function projectWxContext(raw) {
  return String(raw ?? '')
    .split('\n')
    .filter((line) => !CONTEXT_META.test(line))
    .join('\n')
    .trim()
}

/**
 * wx_ocr：OCR 的原始 JSON 带 box / confidence / score 等字段，模型读不了也不需要。
 * 递归收集字符串，跳过这些键，去重后按出现顺序输出。
 */
function collectStrings(value, out, seen, key) {
  if (key && OCR_SKIP_KEYS.has(key)) return
  if (typeof value === 'string') {
    const text = value.trim()
    if (text && !seen.has(text)) {
      seen.add(text)
      out.push(text)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, seen)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) collectStrings(v, out, seen, k)
  }
}

export function projectWxOcr(raw) {
  const text = String(raw ?? '')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return '[屏幕上看到]\n' + cut(text, OCR_LIMIT)
  }
  const lines = []
  collectStrings(data, lines, new Set())
  return '[屏幕上看到]\n' + (lines.length ? lines.join('\n') : '（没有识别到文字）')
}

/**
 * wx_peek：无障碍树每行都带 box=[…] 屏幕坐标。坐标是给 wx_click 用的，
 * 模型要的是名字、预览和消息文字；整段可能有几十行，超长截断。
 */
export function projectWxPeek(raw) {
  const text = String(raw ?? '').replace(/\s*box=\[[^\]]*\]/g, '')
  return cut(text, PEEK_LIMIT)
}
