/**
 * BFF 轮询器。
 *
 * 不 import `electron`，也不直接依赖真实时钟：`fetchImpl`、`schedule`、
 * `cancel` 和 `signal` 全部由调用方注入，所以能在纯 Node 下测试。
 *
 * 失败退避：2s → 4s → 8s → 16s → 30s（封顶），成功后回到 `intervalMs`。
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
export const MAX_BACKOFF_MS = 30_000

export function createPoller(options: PollerOptions): Poller {
  const {
    fetchImpl,
    url,
    intervalMs = DEFAULT_INTERVAL_MS,
    onState,
    onError,
    signal,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  } = options

  const controller = new AbortController()
  let timer: unknown = null
  let failures = 0
  let started = false
  let stopped = false

  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  function clearTimer(): void {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }

  async function tick(): Promise<void> {
    if (stopped || controller.signal.aborted) return
    clearTimer()

    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const state: unknown = await response.json()
      failures = 0
      if (!stopped) onState(state)
    } catch (error) {
      if (!stopped && !controller.signal.aborted) {
        failures += 1
        if (failures === 1) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[desktop-pet] 状态轮询失败，稍后重试：${message}`)
        }
        onError?.(error)
      }
    }

    if (stopped || controller.signal.aborted) return
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
    controller.abort()
  }

  return { start, stop, tick }
}
