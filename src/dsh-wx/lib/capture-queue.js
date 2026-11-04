/**
 * capture-queue.js —— 后台采集的调度队列：去重、冷却、上限与失败退避。
 *
 * 纯内存、零依赖；时间全部由注入的 now() 提供，方便测试和回放。
 * due() 只挑选、不消费；调用方处理完必须 done() 或 fail()。
 */

const DEFAULT_QUEUE_MAX = 20
const DEFAULT_COOLDOWN_MS = 60_000
const DEFAULT_BACKOFF_MS = 120_000

const chatKey = (chat) => String(chat ?? '').trim()

const numberOr = (value, fallback) => {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

/**
 * 创建采集队列。
 * @param {object} [options]
 * @param {() => number} [options.now] 注入时钟，默认 Date.now
 * @param {number} [options.queueMax] 队列上限，默认 20（与 captureSettings 一致）
 * @param {number} [options.cooldownMs] 同会话冷却，默认 60000（captureSettings chatCooldownSec 默认 60）
 */
export function createCaptureQueue({
  now = () => Date.now(),
  queueMax = DEFAULT_QUEUE_MAX,
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now()
  const max = Math.max(1, Math.floor(numberOr(queueMax, DEFAULT_QUEUE_MAX)))
  const cooldown = Math.max(0, numberOr(cooldownMs, DEFAULT_COOLDOWN_MS))

  // Map 保留插入顺序，既做索引又天然是 FIFO；
  // lastDone[chat] = { at, retry }：done 记录完成时间，fail 记录可重试时间。
  const jobs = new Map()
  const lastDone = new Map()

  const at = () => numberOr(clock(), 0)

  // 冷却只叠加在成功完成上；fail 的 at 已经是“可重试时间”，不再加冷却。
  const availableAt = (chat) => {
    const record = lastDone.get(chat)
    if (!record) return 0
    return record.retry ? record.at : record.at + cooldown
  }

  const copy = (job) => ({
    chat: job.chat,
    reason: job.reason,
    unread: job.unread,
    dueAt: job.dueAt,
    tries: job.tries,
  })

  /**
   * 入队或更新。同一会话不重复入队：更新 reason/unread，
   * dueAt 取新旧较小值，冷却期内的新消息不会被拒绝或丢失。
   * @returns {boolean} 是否新增了一个 job（更新已有 job 返回 false）
   */
  const offer = ({ chat, reason, unread, dueAt } = {}) => {
    const key = chatKey(chat)
    if (!key) return false

    const base = dueAt === undefined || dueAt === null ? at() : numberOr(dueAt, at())
    const when = Math.max(base, availableAt(key))

    const existing = jobs.get(key)
    if (existing) {
      if (reason !== undefined && reason !== null) existing.reason = String(reason)
      if (unread !== undefined && unread !== null) existing.unread = Math.max(0, numberOr(unread, 0))
      existing.dueAt = Math.min(existing.dueAt, when)
      return false
    }

    jobs.set(key, {
      chat: key,
      reason: reason === undefined || reason === null ? '' : String(reason),
      unread: Math.max(0, numberOr(unread, 0)),
      dueAt: when,
      tries: 0,
    })
    // 超过上限时删最早插入的 job（Map 迭代顺序即插入顺序）。
    while (jobs.size > max) jobs.delete(jobs.keys().next().value)
    return true
  }

  /**
   * 取插入顺序中第一个已到期的 job 副本，不从队列删除。
   * 每次取出把 tries 加一，表示一次调度尝试。
   */
  const due = (when) => {
    const limit = when === undefined || when === null ? at() : numberOr(when, at())
    for (const job of jobs.values()) {
      if (job.dueAt <= limit) {
        job.tries += 1
        return copy(job)
      }
    }
    return null
  }

  /** 采集成功：删除 job，记录完成时间。 */
  const done = (chat) => {
    const key = chatKey(chat)
    if (!key) return
    jobs.delete(key)
    lastDone.set(key, { at: at(), retry: false })
  }

  /** 采集失败：删除 job，记录“可重试时间”（默认退避 120000）。 */
  const fail = (chat, { backoffMs = DEFAULT_BACKOFF_MS } = {}) => {
    const key = chatKey(chat)
    if (!key) return
    jobs.delete(key)
    const backoff = Math.max(0, numberOr(backoffMs, DEFAULT_BACKOFF_MS))
    lastDone.set(key, { at: at() + backoff, retry: true })
  }

  const size = () => jobs.size

  /** 按入队顺序返回 job 副本数组。 */
  const list = () => [...jobs.values()].map(copy)

  /** 无记录返回 0；fail 后返回可重试时间。 */
  const lastDoneAt = (chat) => {
    const record = lastDone.get(chatKey(chat))
    return record ? record.at : 0
  }

  /** 清空队列以及冷却/退避记录，回到全新状态。 */
  const clear = () => {
    jobs.clear()
    lastDone.clear()
  }

  return { offer, due, done, fail, size, jobs: list, lastDoneAt, clear }
}
