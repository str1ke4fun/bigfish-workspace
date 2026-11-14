/**
 * 点宠物说话：把用户的原话 POST 给本机 BFF 的 `/api/fish/say`。
 *
 * 纯函数，不 import Electron / React —— 单元测试注入 `fetchImpl`，
 * 真正发请求的是主进程（渲染进程从 `file://` 加载，BFF 没有 CORS 头）。
 *
 * 失败必须显式返回 `ok: false`，绝不把「没送到」包装成成功。
 */

const SAY_URL = 'http://127.0.0.1:8788/api/fish/say'
const DEFAULT_TIMEOUT_MS = 90_000

export interface ChatResult {
  ok: boolean
  herReply: string
  note: string
}

export interface SendChatOptions {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function failure(note: string): ChatResult {
  return { ok: false, herReply: '', note }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 把一句话递给她，等她的回话。
 *
 * @param text 用户原话（只发这一个字段，不带人设或任何宿主拼装的内容）
 * @param options.fetchImpl 可注入的 fetch；缺省用当前运行时的全局 fetch
 * @param options.timeoutMs 整次请求的上限，缺省 90s
 */
export async function sendChat(
  text: string,
  { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: SendChatOptions = {},
): Promise<ChatResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let response: Response
    try {
      response = await fetchImpl(SAY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      })
    } catch (cause) {
      if (controller.signal.aborted) return failure('等太久了，没等到回应。')
      const detail = cause instanceof Error ? cause.message : String(cause)
      return failure(`连不上本机服务：${detail.slice(0, 120)}`)
    }

    if (!response.ok) return failure(`BFF 没接住（HTTP ${response.status}）`)

    let body: Record<string, unknown>
    try {
      const parsed: unknown = await response.json()
      if (!parsed || typeof parsed !== 'object') return failure('回话没读懂。')
      body = parsed as Record<string, unknown>
    } catch {
      return failure('回话没读懂。')
    }

    // say.js 会以 HTTP 200 返回业务失败（比如宿主没有会话服务），
    // 只看状态码会把这种情况误报成成功。
    if (body.ok !== true) {
      return failure(asText(body.note) || '这句没送到。')
    }

    return { ok: true, herReply: asText(body.herReply), note: asText(body.note) }
  } finally {
    clearTimeout(timer)
  }
}
