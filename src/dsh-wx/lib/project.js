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

/** wx_peek 在 OCR 模式下返回 JSON：转成模型能读的几行，字段全部脱敏。 */
function renderPeekOcr(data) {
  if (!data || typeof data !== 'object') return null
  const chats = Array.isArray(data.chats) ? data.chats : []
  const messages = Array.isArray(data.messages) ? data.messages : []
  if (!Array.isArray(data.chats) && !Array.isArray(data.messages)) return null
  const lines = ['[屏幕上看到（OCR 未校验）]']
  for (const chat of chats) {
    if (!chat || typeof chat !== 'object') continue
    const name = String(chat.name ?? '').trim()
    let line = '会话：' + (name || '（未识别）')
    const unread = Number(chat.unread)
    if (Number.isFinite(unread) && unread > 0) line += `（未读 ${unread}）`
    if (chat.mention === true) line += '（@我）'
    const preview = String(chat.preview ?? '').trim()
    if (preview) line += '｜' + preview
    lines.push(line)
  }
  if (messages.length) {
    lines.push('最近消息：')
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const text = String(message.text ?? '').trim()
      if (text) lines.push(text)
    }
  }
  return lines.join('\n')
}

/**
 * wx_peek：无障碍树每行都带 box=[…] 屏幕坐标。坐标是给 wx_click 用的，
 * 模型要的是名字、预览和消息文字；整段可能有几十行，超长截断。
 * OCR 分支返回的是 JSON，同样只留可读文字。
 */
export function projectWxPeek(raw) {
  const text = String(raw ?? '')
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const rendered = renderPeekOcr(JSON.parse(trimmed))
      if (rendered) return cut(rendered, PEEK_LIMIT)
    } catch {
      // 解析失败：退回普通文本路径。
    }
  }
  return cut(text.replace(/\s*box=\[[^\]]*\]/g, ''), PEEK_LIMIT)
}

/**
 * 懒投影 render：插件加载顺序不确定，dsh-fish 的 fishCore 可能在 dsh-wx 的
 * apply() 之后才出现。所以不在注册时判断，而是在每次 render 时现取：
 *   - 拿到 core 的包装器后缓存委托函数，之后直接走它；
 *   - 没拿到（或包装失败）就退回 base 原来的 render，下次继续重试。
 *
 * 纯函数，不 import 任何东西、不改 base、不做 I/O。
 */
export function lazyRender(ctx, base) {
  let delegate
  return function render(args, result) {
    if (!delegate) {
      try {
        const core = ctx?.get?.('fishCore')
        if (core?.tools?.wrapRender) {
          delegate = core.tools.wrapRender(base, { core }).output.render
        }
      } catch {
        // core 解析失败：这一轮照旧渲染，不缓存失败。
      }
    }
    if (delegate) {
      try {
        return delegate(args, result)
      } catch {
        // 委托失败也退回旧渲染。
      }
    }
    const legacy = base?.output?.render
    if (typeof legacy === 'function') return legacy(args, result)
    return [{ type: 'text', text: String(result ?? '') }]
  }
}
