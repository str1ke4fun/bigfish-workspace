/**
 * BFF 轮询器。
 *
 * 不 import `electron`，也不直接依赖真实时钟：`fetchImpl`、`schedule`、
 * `cancel` 和 `signal` 全部由调用方注入，所以能在纯 Node 下测试。
 *
 * 失败退避：2s → 4s → 8s → 16s → 30s（封顶），成功后回到 `intervalMs`。
 * 每次请求另有独立的超时（默认 5s）：BFF 接了连接却不响应时也会中止、
 * 走失败退避，不会把轮询卡死。
 * 只在一次断线首次失败时打日志，避免刷屏。
 */

export type PollerFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<Response>

export interface PollerOptions {
  fetchImpl: PollerFetch
  url: string
  intervalMs?: number
  /** 单次请求超时；默认 5000ms。测试可缩短。 */
  requestTimeoutMs?: number
  onState: (state: unknown) => void
  onError?: (error: unknown) => void
  signal?: AbortSignal
  /** 默认 `setTimeout`；测试注入假实现。 */
  schedule?: (fn: () => void, ms: number) => unknown
  /** 默认 `clearTimeout`；测试注入假实现。 */
  cancel?: (handle: unknown) => void
}

export interface Poller {
  start: () => void
  stop: () => void
  tick: () => Promise<void>
}

export const DEFAULT_INTERVAL_MS = 2000
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000
export const MAX_BACKOFF_MS = 30_000

export function createPoller(options: PollerOptions): Poller {
  const {
    fetchImpl,
    url,
    intervalMs = DEFAULT_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onState,
    onError,
    signal,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options

  // 生命周期信号：stop() / 外部 signal 中止它，在途请求经监听器一起中止。
  const lifecycle = new AbortController()
  let timer: unknown = null
  let failures = 0
  let started = false
  let stopped = false

  if (signal) {
    if (signal.aborted) lifecycle.abort()
    else signal.addEventListener('abort', () => lifecycle.abort(), { once: true })
  }

  function clearTimer(): void {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }

  async function tick(): Promise<void> {
    if (stopped || lifecycle.signal.aborted) return
    clearTimer()

    const request = new AbortController()
    const abortRequest = (): void => request.abort(lifecycle.signal.reason)
    if (lifecycle.signal.aborted) abortRequest()
    else lifecycle.signal.addEventListener('abort', abortRequest, { once: true })

    const timeout = setTimeout(() => {
      request.abort(new Error(`请求超过 ${requestTimeoutMs}ms`))
    }, requestTimeoutMs)

    try {
      const response = await fetchImpl(url, { signal: request.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const state: unknown = await response.json()
      failures = 0
      if (!stopped) onState(state)
    } catch (error) {
      // stop()/外部 signal 主动中止不算失败；请求超时算正常失败并退避。
      if (!stopped && !lifecycle.signal.aborted) {
        failures += 1
        if (failures === 1) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[desktop-pet] 状态轮询失败，稍后重试：${message}`)
        }
        onError?.(error)
      }
    } finally {
      clearTimeout(timeout)
      lifecycle.signal.removeEventListener('abort', abortRequest)
    }

    if (stopped || lifecycle.signal.aborted) return
    const delay = failures === 0
      ? intervalMs
      : Math.min(intervalMs * 2 ** (failures - 1), MAX_BACKOFF_MS)
    timer = schedule(() => {
      void tick()
    }, delay)
  }

  function start(): void {
    if (started || stopped) return
    started = true
    void tick()
  }

  function stop(): void {
    stopped = true
    started = false
    clearTimer()
    lifecycle.abort()
  }

  return { start, stop, tick }
}

export interface StateForwarder {
  /** 收到一次状态：忽略顶层 `at` 后与上次相同则不推送。 */
  onState: (state: unknown) => void
  /** 渲染进程就绪时补发最近一次状态，绕过去重。 */
  resend: () => void
}

/**
 * main 进程的状态转发器。
 *
 * 渲染进程订阅 `pet:state` 之前主进程可能已经轮询到第一拍；把最近状态缓存下来，
 * 等渲染进程发 `pet:ready` 时补发一次，避免首帧状态被丢掉后永远不再推送。
 * 纯逻辑、不 import `electron`，可在 Node 测试里直接跑。
 */
export function createStateForwarder(send: (state: unknown) => void): StateForwarder {
  let latest: unknown = null
  let hasState = false
  let lastSignature: string | null = null

  function signature(state: unknown): string {
    if (!state || typeof state !== 'object') return JSON.stringify(state) ?? 'undefined'
    const { at: _at, ...rest } = state as Record<string, unknown>
    return JSON.stringify(rest)
  }

  return {
    onState(state: unknown): void {
      latest = state
      hasState = true
      const next = signature(state)
      if (next === lastSignature) return
      lastSignature = next
      send(state)
    },
    resend(): void {
      if (hasState) send(latest)
    },
  }
}
