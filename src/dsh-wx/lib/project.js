/**
 * project.js —— dsh-wx 工具的模型投影
 *
 * 信封模式由 wrapTool 在 render 时读完整结果；旧模式由 wrapRenderOnly 读字符串。
 * 两种模式都只把模型该看见的文字交出去，坐标 / 置信度 / 台账编号留在完整结果里。
 *
 * 纯函数，不 import 任何东西：测试不启动 GUI，也不依赖 dsh-fish 是否安装。
 */

const PEEK_LIMIT = 12_000
const OCR_RENDER_LIMIT = 24_000

const CONTEXT_META = /^\s*(?:匹配|来源|置信度)\s*[：:]/
// 坐标、置信度、以及 OCR 的检索元数据都不进模型投影：她要的是看到的字。
const OCR_SKIP_KEYS = new Set([
  'box', 'confidence', 'score', 'x', 'y', 'width', 'height',
  'source', 'note', 'verified', 'currentVerified', 'ocrName', 'nameConfidence',
  'msgId', 'messageId', 'matchReason', 'matchReasons', 'reason', 'reasons',
])
// 无障碍树每行末尾的屏幕坐标：`中心(711,555) 250x68`。
const PEEK_CENTER = /\s*中心\(-?\d+,-?\d+\) \d+x\d+\s*$/

/** 信封失败只把 message 交给模型；成功才继续走各工具自己的投影。 */
function envelopeFailure(result) {
  if (!result || typeof result !== 'object' || result.ok !== false) return null
  return String(result.message ?? '')
}

function envelopeText(result) {
  if (result && typeof result === 'object' && result.ok === true) return result.text ?? ''
  return result
}

export function projectWxResult(result) {
  const failure = envelopeFailure(result)
  if (failure !== null) return failure
  if (result && typeof result === 'object') return String(result.text ?? '')
  return String(result ?? '')
}

/** 发送确认只能有一个结论：末尾看见、只看见侧栏预览、没看见。 */
export function classifyWxSend({ inMsgs = false, inPreview = false } = {}) {
  if (inMsgs) return 'confirmed'
  if (inPreview) return 'preview'
  return 'unconfirmed'
}

export function shouldBookWxSend(sent) {
  return sent === 'confirmed'
}

/** 回声保护要认出「已确认」和「只在侧栏看见」，但只有前者算真正入账。 */
export function shouldNoteWxEcho(sent) {
  return sent === 'confirmed' || sent === 'preview'
}

/** 会话名比较只用于显式 task_id 的兼容回退；能进目录时以稳定 chatId 为准。 */
const sameChatName = (a, b) => String(a ?? '').trim().replace(/\s+/g, ' ') ===
  String(b ?? '').trim().replace(/\s+/g, ' ')

/** 同一会话的额度/频率必须落在稳定身份上，不能让别名或 VS 变体各记一份。 */
export function resolveSendKeys({ chat = '', canonicalChat = '', chatId = '' } = {}) {
  const fallback = String(chat ?? '').trim()
  const id = String(chatId ?? '').trim()
  const quota = id || String(canonicalChat ?? '').trim() || fallback
  return { quota, speech: id || quota }
}

/**
 * wx_send 的任务绑定：优先认显式 task_id；没给时才走
 * 规范会话名 → 目录 chatId → 该会话唯一活动任务。未知/歧义名不猜。
 */
export function resolveWxSendTask({
  chat = '', taskId = '', directory = null, board = null, implicitTaskBinding = true,
} = {}) {
  const requestedChat = String(chat ?? '').trim()
  const lookup = typeof directory?.sendableLookup === 'function'
    ? directory.sendableLookup(requestedChat)
    : { status: 'unknown', target: directory?.sendableTarget?.(requestedChat) ?? null }
  const target = lookup.target ?? null
  const chatName = target?.chatName || requestedChat
  const chatId = target?.chatId || ''
  const explicitTaskId = String(taskId ?? '').trim()
  const base = { requestedChat, chatName, targetChat: chatName, chatId }

  if (lookup.status === 'ambiguous' || lookup.status === 'truncated') {
    return {
      ok: false,
      code: 'WX_CHAT_AMBIGUOUS',
      source: 'unresolved',
      status: lookup.status,
      ...base,
    }
  }

  if (explicitTaskId) {
    const task = board?.get?.(explicitTaskId) ?? null
    if (!task) {
      return { ok: false, code: 'WX_TASK_NOT_FOUND', source: 'explicit', status: 'task-not-found', ...base }
    }
    const matches = target
      ? task.chatId === target.chatId
      : sameChatName(task.chatName, requestedChat)
    if (!matches) {
      return { ok: false, code: 'WX_TASK_CHAT_MISMATCH', source: 'explicit', status: 'chat-mismatch', ...base }
    }
    return {
      ok: true,
      source: 'explicit',
      status: 'bound',
      ...base,
      chatName: target?.chatName || task.chatName || chatName,
      targetChat: target?.chatName || task.chatName || chatName,
      chatId: task.chatId,
      task,
    }
  }

  if (implicitTaskBinding === false) {
    return {
      ok: true, source: 'disabled', status: 'disabled', ...base, chatName: requestedChat,
      targetChat: requestedChat, task: null,
    }
  }
  if (!target) {
    return { ok: true, source: 'unresolved', status: 'unresolved', ...base, task: null }
  }
  const task = board?.activeForChat?.(chatId) ?? null
  return {
    ok: true,
    source: task ? 'implicit' : 'none',
    status: task ? 'bound' : 'no-active-task',
    ...base,
    task,
  }
}

/** 发送后的调用点统一按三态处理回声、历史和任务回复，避免几处闸再次绑在一起。 */
export function applyWxSendBookkeeping({
  sent,
  chat = '',
  text = '',
  noteOutbox,
  capture,
  replyTask,
} = {}) {
  if (shouldNoteWxEcho(sent) && typeof noteOutbox === 'function') noteOutbox(chat, text)
  if (!shouldBookWxSend(sent)) {
    return { outMsgId: '', recorded: false, status: 'not-booked', reason: 'not-confirmed' }
  }

  let outMsgId = ''
  let captureReason = ''
  try {
    const captured = typeof capture === 'function' ? capture() : null
    outMsgId = String(captured?.records?.at(-1)?.msgId ?? '').trim()
  } catch {
    // 历史没记下，不影响已经确认发出的消息。
    captureReason = 'capture-failed'
  }
  if (!outMsgId) {
    return {
      outMsgId: '', recorded: false, status: 'not-recorded', reason: captureReason || 'missing-msg-id',
    }
  }
  if (typeof replyTask !== 'function') {
    return { outMsgId, recorded: false, status: 'no-task', reason: 'no-active-task' }
  }
  try {
    const booked = replyTask(outMsgId)
    if (booked?.ok === false) {
      return { outMsgId, recorded: false, status: 'not-recorded', reason: 'reply-not-recorded' }
    }
    return {
      outMsgId,
      recorded: true,
      status: booked?.duplicate === true ? 'duplicate' : 'recorded',
    }
  } catch {
    return { outMsgId, recorded: false, status: 'not-recorded', reason: 'reply-not-recorded' }
  }
}

/** wx_send / wx_type 回车后的三句世界声。 */
export function projectWxSend({ chat = '', sent = 'unconfirmed' } = {}) {
  const target = String(chat ?? '').trim() || '那个会话'
  if (sent === 'confirmed') return `[发到「${target}」了，末尾能看见]`
  if (sent === 'preview') return '[按下去了，末尾还没看见，先别当发出去了]'
  return '[按下去了，没看见落下去。可能出去了，也可能没有]'
}

export function projectWxStickerSend(result) {
  const failure = envelopeFailure(result)
  if (failure !== null) return failure
  if (!result?.confirmed) return '[点下去了，没看见落下去。先看看现在停在哪儿，别急着再点]'
  return `[表情发到「${String(result.chat ?? '').trim() || '那个会话'}」了，末尾看见了]`
}

export function projectWxStickerCollect(result) {
  const failure = envelopeFailure(result)
  if (failure !== null) return failure
  return result?.confirmed ? '[收进收藏了]' : '[点了收藏，没确认下来]'
}

export function projectWxStickerSearch(result) {
  const failure = envelopeFailure(result)
  if (failure !== null) return failure
  if (!result?.confirmed) return '[点下去了，没看见落下去]'
  return `[表情发到「${String(result.chat ?? '').trim() || '那个会话'}」了，末尾看见了]`
}

export function projectWxTaskSnooze() {
  return '[先搁一会儿]'
}

export function projectWxTaskDone() {
  return '[这件事放下了]'
}

/** 按字符截断（中文一个字算一个），尾部标明截断。 */
function cut(text, limit) {
  const chars = [...String(text ?? '')]
  if (chars.length <= limit) return chars.join('')
  return chars.slice(0, limit).join('') + '\n…（已截断）'
}

/**
 * wx_ocr 旧渲染路径（fishCore / 投影不可用时）的上限。
 * execute 现在返回完整 JSON，台账会把大字段落 artifact；但上下文里不能整段塞。
 */
export function boundedText(text, limit = OCR_RENDER_LIMIT) {
  return cut(text, limit)
}

/**
 * wx_peek 的尾巴（[提示] + 气氛）必须在 12k 截断之外活下来。
 * execute 用它在拼尾巴之前给正文留预算；正文按字符算，避免把中文切坏。
 */
export function clipPeekBody(text, tail = '', limit = PEEK_LIMIT) {
  const tailText = String(tail ?? '')
  const budget = Math.max(0, limit - [...tailText].length - 20)
  const chars = [...String(text ?? '')]
  const body = chars.length > budget ? chars.slice(0, budget).join('') + '\n…（已截断）' : chars.join('')
  return body + tail
}

/**
 * wx_context：每条引用卡片第三行是「匹配：…；来源：台账 msg_1；置信度：…」。
 * 这些是给维护者看的检索元数据，模型只需要原文和发言人，整行去掉。
 */
const cleanParty = (value, confidence = 'unknown') => {
  const who = String(value ?? '').trim()
  if (/^大肥鱼(?:（发出）)?$/.test(who)) return '你'
  const certainty = String(confidence ?? 'unknown').toLowerCase()
  if (!who || !certainty || certainty === 'low' || certainty === 'unknown' || certainty === '低') return '看不出是谁'
  return who
}

const cleanClock = (value) => {
  const text = String(value ?? '').trim()
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/)
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]} ${iso[4]}:${iso[5]}` : text || '时间不明'
}

/**
 * wx_context：检索层保留可解释卡片供内部审计；模型这里只看见谁在何时说了什么。
 */
export function projectWxContext(raw) {
  const failure = envelopeFailure(raw)
  if (failure !== null) return failure
  const text = String(envelopeText(raw) ?? '').trim()
  if (!text) return '[翻到]\n没有找到。'

  // 新投影已经是世界声；正文里以“匹配/来源/置信度”开头的行也可能是原话。
  if (text.startsWith('[翻到]')) return text

  if (/^[\[{]/.test(text) && !text.startsWith('[上下文')) {
    return '[翻到]\n（这段记录没能显示出来）'
  }

  const cards = []
  let current = null
  for (const line of text.split('\n')) {
    const confidence = line.match(/置信度\s*[：:]\s*(high|medium|low|unknown|高|中|低)/i)
    if (confidence && current) current.confidence = confidence[1]
    if (CONTEXT_META.test(line)) continue
    const header = line.match(/^\[上下文\s+\d+\/\d+\]\s*(.*?)\s*[｜|]\s*(.*?)\s*[｜]\s*(.*)$/)
    if (header) {
      current = { chat: header[1].trim(), who: header[2].trim(), at: header[3].trim(), text: '', confidence: 'unknown' }
      cards.push(current)
      continue
    }
    const body = line.trim().match(/^「([\s\S]*)」$/)
    if (body && current && !current.text) {
      current.text = body[1]
    }
  }

  if (cards.length) {
    const chat = cards[0].chat || '那个会话'
    const lines = [`[翻到] 「${chat}」里相关的 ${cards.length} 条：`]
    for (const card of cards) {
      if (!card.text) continue
      lines.push(`${cleanParty(card.who, card.confidence)}（${cleanClock(card.at)}）：${card.text}`)
    }
    return lines.join('\n')
  }

  const safe = text
    .split('\n')
    .filter((line) => !CONTEXT_META.test(line))
    .filter((line) => !/^（只查这个任务自己的会话/.test(line.trim()))
    .join('\n')
    .trim()
  if (!safe || safe.includes('[上下文') || /[{}]|\bmsg_|taskId|matchReason|confidence/.test(safe)) {
    return '[翻到]\n（这段记录没能显示出来）'
  }
  if (safe.includes('没有找到')) return '[翻到]\n没有找到。'
  return `[翻到]\n${safe}`
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
  const failure = envelopeFailure(raw)
  if (failure !== null) return failure
  const text = String(envelopeText(raw) ?? '')
  let data
  try {
    data = JSON.parse(text)
  } catch {
    // 绝不把原始 JSON（含字段名和坐标）交给她：解析不了就只说结果没读完。
    return '[屏幕上看到]\n（结果太长，没读完）'
  }
  const screen = renderScreen(data, { untrusted: true })
  if (screen) return screen
  const lines = []
  collectStrings(data, lines, new Set())
  return '[屏幕上看到]\n' + (lines.length ? lines.join('\n') : '（没有识别到文字）')
}

/**
 * 把 structured screen 数据写成世界声。OCR 的结果天生慢半拍，所以不冒充“现在停在”。
 */
function renderScreen(data, { untrusted = false } = {}) {
  if (!data || typeof data !== 'object') return null
  const chats = Array.isArray(data.chats) ? data.chats : []
  const messages = Array.isArray(data.messages) ? data.messages : []
  if (!Array.isArray(data.chats) && !Array.isArray(data.messages)) return null

  const current = String(data.current ?? '').trim()
  const lines = [untrusted
    ? '[微信] 屏幕可能慢半拍，下面可能是刚才的。'
    : current
      ? `[微信] 停在「${current}」。`
      : '[微信] 看不出现在停在哪个会话。']

  if (chats.length) lines.push('侧栏：')
  for (const chat of chats) {
    if (!chat || typeof chat !== 'object') continue
    const name = String(chat.name ?? '').trim()
    let line = `- 「${name || '没认出来的会话'}」`
    const unread = Number(chat.unread)
    if (Number.isFinite(unread) && unread > 0) line += `${unread} 条未读`
    else line += '没有未读'
    const preview = String(chat.preview ?? chat.text ?? '').trim()
    if (preview) line += `，最后一句：${preview}`
    lines.push(line)
  }
  if (messages.length) {
    lines.push('当前对话最后几句（看不出是谁）：')
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue
      const text = String(message.text ?? '').trim()
      if (text) lines.push(text)
    }
  }
  return lines.join('\n')
}

/**
 * wx_peek：无障碍树带屏幕坐标（生产格式 `中心(x,y) wxh`，旧格式 `box=[…]`）。
 * 坐标只给 wx_click 内部回退用，模型要的是名字、预览和消息文字；
 * 树头那一行也整行换成固定标记，避免窗口尺寸/原点/缩放漏进上下文。
 * 整段可能有几十行，超长截断。OCR 分支返回的是 JSON，同样只留可读文字。
 */
export function projectWxPeek(raw) {
  const failure = envelopeFailure(raw)
  if (failure !== null) return failure
  const text = String(envelopeText(raw) ?? '')
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      const rendered = renderScreen(JSON.parse(trimmed), { untrusted: true })
      if (rendered) return cut(rendered, PEEK_LIMIT)
    } catch {
      // 解析失败：退回普通文本路径。
    }
  }

  const currentMatch = text.match(/当前会话[：:]\s*(?:"([^"]*)"|“([^”]*)”|「([^」]*)」)/)
  const current = currentMatch ? (currentMatch[1] ?? currentMatch[2] ?? currentMatch[3] ?? '').trim() : ''
  const stale = text.includes('[提示]')
  const chats = []
  const messages = []

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(PEEK_CENTER, '').trim()
    const chat = line.match(/^会话\s*(?:["“「])(.*?)(?:["”」])\s*(.*)$/)
    if (chat) {
      const tail = chat[2]
      const unread = Number((tail.match(/未读(?:=|\s*[：:])?\s*(\d+)/) ?? [])[1] || 0)
      const preview = (tail.match(/预览\s*=\s*"([^"]*)"/) ?? tail.match(/预览\s*[：:]\s*["“「]([^"”」]*)/) ?? [])[1] ?? ''
      chats.push({ name: chat[1].trim(), unread, preview: preview.trim() })
      continue
    }
    const message = line.match(/^消息\s*(?:["“「])(.*?)(?:["”」])/)
    if (message) messages.push({ text: message[1].trim() })
  }

  if (!chats.length && !messages.length && !current && !stale) {
    return '[微信] 没看清。'
  }

  const rendered = renderScreen({ current, chats, messages }, { untrusted: stale })
  const extras = text
    .split('\n')
    .filter((line) => line.startsWith('[气氛]'))
    .map((line) => line.trim())
  if (text.includes('…（已截断）')) extras.unshift('…（已截断）')
  return cut([rendered, ...extras].filter(Boolean).join('\n'), PEEK_LIMIT)
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
