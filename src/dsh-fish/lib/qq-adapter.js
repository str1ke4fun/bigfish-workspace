/**
 * qq-adapter.js —— QQ（OneBot）vendor 工具的模型投影
 *
 * QQ 的 `qq_*` 工具由 dsh-onebot-qq 注册，返回值是宿主渲染前的完整信封：
 *   - `value` 是工具的原始返回值（发送工具是 `{ sent, messageId }`，历史是消息数组，
 *     NapCat 代理是 action 的 data 负载）；
 *   - `content` 是宿主默认渲染出来的文字，常常带 message_id / chatId / 原始 JSON。
 *
 * 模型只需要「发出去了没有」「群里说了什么」「拿到了什么」，所以这里在
 * `tools/post-execute` 这个宿主 waterfall 上把 content 换成人话。该 waterfall：
 *   - 返回 `{ kind: 'accept', content }` 只替换 content；
 *   - 返回 `{ kind: 'accept', value }` 会重新校验并 render（本适配器不用）；
 *   - 监听器抛错会把一次成功调用变成 isError —— 所以任何异常都必须 `next()`。
 *
 * 零依赖：只用语言内置能力。纯函数 + 一个模块级 legacy 记录。
 */

const SEND_PREFIX = 'qq_send_'
const HISTORY_TOOL = 'qq_group_history'
const NAPCAT_TOOL = 'qq_napcat_api'

/**
 * 只接管这些已知 vendor 工具。未知 `qq_*` 一律返回 null：
 * 它们可能返回模型真正需要的内容，硬吞成 `[拿到了]` 比不接管更糟；
 * 同时在自检的 legacy 列表里留下名字。
 */
const HANDLED_TOOLS = new Set([
  'qq_send_image',
  'qq_send_voice',
  'qq_send_video',
  'qq_send_file',
  'qq_send_forward',
  'qq_group_history',
  'qq_napcat_api',
])

const HISTORY_LIMIT = 4000
const REASON_LIMIT = 200

/** 见过的、projectQqTool 返回 null 的 qq_* 名字（未知 vendor 工具）。 */
const legacyTools = new Set()

function textBlock(text) {
  return [{ type: 'text', text }]
}

/** 按字符截断（中文一个字算一个），尾部标明截断。 */
function cut(text, limit) {
  const chars = [...String(text ?? '')]
  if (chars.length <= limit) return chars.join('')
  return chars.slice(0, limit).join('') + '\n…（已截断）'
}

/** content（块数组或字符串）→ 模型实际读到的纯文本。 */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') parts.push(block)
    else if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * value → 文本。`undefined` 时退回 content；其余值走 JSON.stringify。
 * BigInt / 循环引用等不可序列化的值会在这里抛出，由监听器兜住并原样放行
 * （宿主原有的 content 保持不变，模型仍能看到默认渲染结果）。
 */
function rawText(value, content) {
  if (value === undefined) return contentText(content)
  if (typeof value === 'string') return value
  const json = JSON.stringify(value)
  return typeof json === 'string' ? json : contentText(content)
}

/**
 * 失败原因脱敏：绝不带 message_id / chatId / group_id / 文件路径 / retcode。
 * 认不出原因时给一句「没能确认」，不拼原始 JSON。
 */
function sanitizeReason(input) {
  let text = String(input ?? '').replace(/\r/g, ' ').replace(/\n+/g, ' ').trim()
  text = text.replace(/\b(message_?id|chat_?id|group_?id|user_?id|file_?id|token|cookie)\b\s*[:=]\s*[^\s,;，；]+/gi, '')
  text = text.replace(/\b(private|group):[^\s,;，；]+/gi, '')
  text = text.replace(/\bretcode\s*[=:]?\s*\(?\s*-?\d+\s*\)?/gi, '')
  text = text.replace(/https?:\/\/\S+/gi, '')
  text = text.replace(/[A-Za-z]:\\[^\s，。；,;]+/g, '')
  text = text.replace(/\/(?:[^\s，。；,;：:）)]*)/g, '')
  text = text.replace(/^(?:Error|ToolError|错误)[:：]\s*/i, '')
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/[：:，,；;\s]+$/g, '')
  if (!text) return '没能确认'
  return cut(text, REASON_LIMIT)
}

function reasonOf(value, raw, content) {
  let source = ''
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['message', 'error', 'reason', 'msg']) {
      if (typeof value[key] === 'string' && value[key] !== '') {
        source = value[key]
        break
      }
    }
  }
  if (!source) source = contentText(content).trim()
  if (!source) source = raw
  return sanitizeReason(source)
}

/** 发送工具的成败判断：先看结构化 value，再看文本信号，最后默认成功。 */
function sendSucceeded(value, raw, content) {
  let data = value
  if (typeof data === 'string') {
    try { data = JSON.parse(data) } catch { data = null }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (data.sent === false || data.ok === false) return false
    if (data.sent === true || data.ok === true) return true
  }

  if (/\bsent\s*[=:]\s*true\b/i.test(raw)) return true
  if (/\bsent\s*[=:]\s*false\b|\bok\s*[=:]\s*false\b/i.test(raw)) return false

  const text = contentText(content)
  if (/已发送|发出去了|送出去了/.test(text)) return true
  if (/失败|没发|错误|error|failed|not sent/i.test(text)) return false
  return true
}

function projectSend(value, raw, content, isError) {
  if (isError) return textBlock(`[没发出去：${reasonOf(value, raw, content)}]`)
  if (sendSucceeded(value, raw, content)) return textBlock('[发出去了]')
  return textBlock(`[没发出去：${reasonOf(value, raw, content)}]`)
}

function nicknameOf(message) {
  const candidates = [
    message?.nickname,
    message?.sender?.card,
    message?.sender?.nickname,
    message?.sender?.name,
    message?.card,
    message?.sender_name,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return '某人'
}

function messageText(message) {
  const raw = message?.text ?? message?.content ?? message?.message
  if (typeof raw === 'string') return raw.trim()
  if (Array.isArray(raw)) {
    return raw
      .map((segment) => {
        if (typeof segment === 'string') return segment
        if (!segment || typeof segment !== 'object') return ''
        if (segment.type === 'text') return String(segment.data?.text ?? segment.text ?? '')
        return ''
      })
      .join('')
      .trim()
  }
  return ''
}

function projectHistory(raw, content, isError) {
  if (isError) return textBlock(`[群历史] 没拿到：${sanitizeReason(contentText(content) || raw)}`)

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // 解析失败：保留原文本，只截断。
    return textBlock(cut(raw, HISTORY_LIMIT))
  }

  // vendor 直接返回消息数组；测试与部分旧版返回 { messages: [...] }。
  const messages = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)
      ? parsed.messages
      : null
  if (!messages) return textBlock('[群历史] 最近 0 条：\n（没有可读的消息）')

  const lines = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const text = messageText(message)
    lines.push(`${nicknameOf(message)}：${text || '（非文字消息）'}`)
  }
  if (lines.length === 0) return textBlock('[群历史] 最近 0 条：\n（没有可读的消息）')
  return textBlock(`[群历史] 最近 ${lines.length} 条：\n${lines.join('\n')}`)
}

function actionOf(value, args) {
  if (typeof args?.action === 'string' && args.action !== '') return args.action
  if (value && typeof value === 'object' && typeof value.action === 'string') return value.action
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') return parsed.action
    } catch {
      // 不是 JSON：没有 action 可识别。
    }
  }
  return ''
}

/** OneBot 的 call() 通常只给 data 负载；测试/旧版可能给完整信封。 */
function unwrapData(parsed) {
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, 'data') &&
    (Object.prototype.hasOwnProperty.call(parsed, 'retcode') || Object.prototype.hasOwnProperty.call(parsed, 'status'))
  ) {
    return parsed.data
  }
  return parsed
}

function memberName(member) {
  for (const candidate of [member?.card, member?.nickname, member?.name]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return '某成员'
}

function roleLabel(role) {
  if (role === 'owner') return '群主'
  if (role === 'admin') return '管理员'
  if (role === 'member') return '群员'
  return ''
}

function ocrLines(data) {
  const lines = []
  const push = (value) => {
    if (typeof value === 'string' && value.trim() !== '') lines.push(value.trim())
  }
  if (typeof data === 'string') {
    push(data)
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') push(item)
      else if (item && typeof item === 'object') push(item.text ?? item.words)
    }
  } else if (data && typeof data === 'object') {
    if (typeof data.text === 'string') push(data.text)
    if (Array.isArray(data.texts)) {
      for (const item of data.texts) {
        if (typeof item === 'string') push(item)
        else if (item && typeof item === 'object') push(item.text ?? item.words)
      }
    }
  }
  return lines
}

function projectNapcat(value, raw, content, args, isError) {
  if (isError) return textBlock(`[没拿到：${sanitizeReason(contentText(content) || raw)}]`)

  let parsed
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    parsed = null
  }
  const data = unwrapData(parsed)
  const action = actionOf(value, args)

  if (action === 'get_group_member_list') {
    const members = Array.isArray(data) ? data : Array.isArray(data?.members) ? data.members : null
    if (members && members.length > 0) {
      const lines = members.map((member) => {
        const name = memberName(member)
        const role = roleLabel(member?.role)
        return role ? `${name}（${role}）` : name
      })
      return textBlock(`[群成员] ${lines.length} 人：\n${lines.join('\n')}`)
    }
  }

  if (action === 'get_group_member_info') {
    if (data && typeof data === 'object') {
      const name = memberName(data)
      if (name !== '某成员') {
        const role = roleLabel(data.role)
        return textBlock(`[群成员] ${name}${role ? `（${role}）` : ''}`)
      }
    }
  }

  if (action === 'ocr_image') {
    const lines = ocrLines(data)
    return textBlock(lines.length > 0 ? `[看到文字]\n${lines.join('\n')}` : '[没看到文字]')
  }

  // 其他 action / 未知 action：只报「拿到了」，绝不输出原始 JSON 或 retcode。
  return textBlock('[拿到了]')
}

/**
 * QQ 工具返回 → 模型投影。纯函数。
 *
 * @param {string} name 工具名
 * @param {any} value 完整信封里的 value（宿主已冻结）
 * @param {any} content 宿主默认渲染的 content
 * @param {{ args?: object, isError?: boolean }} [options]
 * @returns {Array<{ type: 'text', text: string }> | null} 未覆盖的工具返回 null（不接管）
 */
export function projectQqTool(name, value, content, options = {}) {
  const tool = typeof name === 'string' ? name : ''
  // 非 qq_* 与未知 qq_*（vendor 将来新增的）都不接管；由监听器记入 legacy 后 next()。
  if (!HANDLED_TOOLS.has(tool)) return null

  const isError = options?.isError === true
  // 先把 value 归一成文本：不可序列化的值在这里抛，交给监听器 next()。
  const raw = rawText(value, content)

  if (tool.startsWith(SEND_PREFIX)) return projectSend(value, raw, content, isError)
  if (tool === HISTORY_TOOL) return projectHistory(raw, content, isError)
  return projectNapcat(value, raw, content, options?.args, isError)
}

function asWarn(log) {
  if (typeof log === 'function') return log
  if (typeof log?.warn === 'function') return (...args) => log.warn(...args)
  return undefined
}

/**
 * 注册 `tools/post-execute` 监听器。
 *
 * 只在 QQ 面接管；任何异常（面判定失败、value 不可序列化、投影 bug）都
 * `return next()`，绝不把成功的工具调用变成 isError。
 *
 * @returns {() => void} disposer
 */
export function registerQqAdapter(ctx, { core, log } = {}) {
  if (typeof ctx?.on !== 'function') return () => {}
  const warn = asWarn(log)

  const listener = async (exec, result, next) => {
    const pass = () => (typeof next === 'function' ? next() : undefined)
    try {
      const surface = core?.surface?.current?.(exec?.agent)
      if (surface !== 'qq') return pass()

      const blocks = projectQqTool(exec?.name, result?.value, result?.content, {
        args: exec?.arguments,
        isError: result?.isError === true,
      })
      if (blocks == null) {
        const name = typeof exec?.name === 'string' ? exec.name : ''
        if (name.startsWith('qq_')) legacyTools.add(name)
        return pass()
      }
      // post-execute 只替换 content；失败结果（isError）也允许替换 content。
      return { kind: 'accept', content: blocks }
    } catch (err) {
      try { warn?.(`[dsh-fish] QQ 投影失败，保留原结果：${String(err?.message ?? err).slice(0, 160)}`) } catch { /* ignore */ }
      return pass()
    }
  }

  try {
    const off = ctx.on('tools/post-execute', listener)
    return typeof off === 'function' ? off : () => {}
  } catch (err) {
    try { warn?.(`[dsh-fish] QQ 投影监听没挂上：${String(err?.message ?? err).slice(0, 160)}`) } catch { /* ignore */ }
    return () => {}
  }
}

/** 自检用：projectQqTool 没覆盖的 qq_* 工具名（排序去重）。 */
export function qqAdapterStatus() {
  return { legacy: [...legacyTools].sort() }
}

/** 仅测试用：清空 legacy 记录。 */
export function resetQqAdapterStatus() {
  legacyTools.clear()
}
