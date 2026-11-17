/**
 * 逾期提醒编排。
 *
 * 投递是 async，任务板快照会在这段时间里变旧。所有落盘动作都带版本/计数前置条件；
 * 写盘失败后进入退避，并先探测任务板是否恢复可写，避免同一句话每分钟重投。
 */

export const DEFAULT_REMINDER_BACKOFF_MS = 60_000
export const MAX_REMINDER_BACKOFF_MS = 15 * 60_000

/** 任务级写盘退避；成功写盘后清掉。 */
export function createReminderBackoff({
  baseMs = DEFAULT_REMINDER_BACKOFF_MS,
  maxMs = MAX_REMINDER_BACKOFF_MS,
} = {}) {
  const entries = new Map()
  const base = Math.max(1_000, Number(baseMs) || DEFAULT_REMINDER_BACKOFF_MS)
  const max = Math.max(base, Number(maxMs) || MAX_REMINDER_BACKOFF_MS)
  return {
    blocked(taskId, at = Date.now()) {
      const entry = entries.get(String(taskId))
      return !!entry && entry.until > Number(at)
    },
    fail(taskId, at = Date.now()) {
      const id = String(taskId)
      const previous = entries.get(id)
      const attempts = (previous?.attempts || 0) + 1
      const until = Number(at) + Math.min(max, base * (2 ** (attempts - 1)))
      const entry = { attempts, until }
      entries.set(id, entry)
      return entry
    },
    clear(taskId) {
      entries.delete(String(taskId))
    },
    get(taskId) {
      const entry = entries.get(String(taskId))
      return entry ? { ...entry } : null
    },
  }
}

function canWrite(board, backoff, taskId, at, log) {
  const probe = () => (typeof board.probeWritable === 'function' ? board.probeWritable() : { ok: true })
  if (backoff?.blocked?.(taskId, at)) {
    const p = probe()
    if (p?.ok !== true) {
      log?.(`任务板仍不可写，继续退避（${taskId}）：${p?.why || 'unknown'}`)
      return false
    }
  }
  const p = probe()
  if (p?.ok !== true) {
    backoff?.fail?.(taskId, at)
    log?.(`任务板不可写，先不投递（${taskId}）：${p?.why || 'unknown'}`)
    return false
  }
  return true
}

function recordFailure(result, backoff, taskId, at, log, what) {
  if (result?.code === 'stale') {
    log?.(`${what}快照已过期，拒绝旧状态（${taskId}）：${result.why || ''}`)
    return 'stale'
  }
  if (result?.code === 'persistence') {
    backoff?.fail?.(taskId, at)
    log?.(`${what}落盘失败，进入退避（${taskId}）：${result.why || ''}`)
    return 'failed'
  }
  log?.(`${what}没记上（${taskId}）：${result?.why || 'unknown'}`)
  return 'skipped'
}

/**
 * 跑一轮逾期提醒。deliver 成功只表示“已经叫到她”；只有任务板成功记下这次提醒，
 * persisted 才会增加。最终提醒的自动 block 与 remind 共用一条事件（finalBlock=true）。
 */
export async function runOverdueReminderPass({
  board,
  at = Date.now(),
  maxLevel = 3,
  finalBlock = true,
  backoff = createReminderBackoff(),
  deliver,
  nextCheckAt,
  note,
  onPersisted,
  log,
} = {}) {
  if (!board || typeof board.overdueReminders !== 'function') {
    throw new TypeError('runOverdueReminderPass 需要任务板')
  }
  if (typeof deliver !== 'function') throw new TypeError('runOverdueReminderPass 需要 deliver')
  const now = Number(at) || Date.now()
  const iso = new Date(now).toISOString()
  const cap = Math.max(1, Number(maxLevel) || 3)
  const out = { delivered: 0, persisted: 0, repaired: 0, stale: 0, failed: 0, skipped: 0 }

  // 旧实现可能只把第三次 remind 写进去、block 写失败；这类半截状态只补 block，不重投。
  const repairs = typeof board.reminderBlocksNeedingRepair === 'function'
    ? board.reminderBlocksNeedingRepair({ maxLevel: cap })
    : []
  for (const task of repairs) {
    if (!canWrite(board, backoff, task.taskId, now, log)) continue
    const result = board.reconcileReminderBlock(task.taskId, {
      maxLevel: cap,
      expectedVersion: task.version,
      expectedOverdueCount: task.overdueCount,
      at: iso,
    })
    if (result?.ok) {
      out.repaired += 1
      backoff?.clear?.(task.taskId)
      continue
    }
    const kind = recordFailure(result, backoff, task.taskId, now, log, '最终 block ')
    if (kind === 'stale') out.stale += 1
    else if (kind === 'failed') out.failed += 1
    else out.skipped += 1
  }

  const due = board.overdueReminders({ at: now, maxLevel: cap })
  for (const task of due) {
    if (!canWrite(board, backoff, task.taskId, now, log)) continue
    const level = Math.min(cap, (Number(task.overdueCount) || 0) + 1)
    let chat
    try {
      const delivered = await deliver(task, level)
      if (delivered && typeof delivered === 'object' && delivered.ok === false) {
        out.failed += 1
        log?.(`逾期提醒投不进去（${task.chatName || task.chatId || task.taskId}）：${delivered.code || delivered.message || 'delivery-failed'}`)
        continue
      }
      chat = delivered && typeof delivered === 'object' && delivered.ok === true
        ? (delivered.chat ?? delivered.sessionId ?? '')
        : delivered
    } catch (err) {
      log?.(`逾期提醒投不进去（${task.chatName || task.chatId || task.taskId}）：${String(err?.message ?? err).slice(0, 120)}`)
      continue
    }
    out.delivered += 1

    const next = typeof nextCheckAt === 'function'
      ? nextCheckAt(task, level, now)
      : new Date(now + 15 * 60_000).toISOString()
    const noteText = typeof note === 'function'
      ? note(task, level)
      : `第 ${level} 次逾期提醒`
    const marked = board.markReminded(task.taskId, {
      level,
      nextCheckAt: next,
      note: noteText,
      maxLevel: cap,
      finalBlock: finalBlock !== false,
      expectedVersion: task.version,
      expectedOverdueCount: task.overdueCount,
      at: iso,
    })
    if (!marked?.ok) {
      const kind = recordFailure(marked, backoff, task.taskId, now, log, '提醒')
      if (kind === 'stale') out.stale += 1
      else if (kind === 'failed') out.failed += 1
      else out.skipped += 1
      continue
    }

    out.persisted += 1
    backoff?.clear?.(task.taskId)
    await onPersisted?.({ task, level, chat, updated: marked.task, at: iso })

    // 回滚路径保留旧的两条事件：提醒成功后再 block；若这条写失败，下一轮由 repair 补。
    if (finalBlock === false && level >= cap) {
      const blocked = board.block(task.taskId, {
        why: '连续多次逾期提醒后仍未处理',
        uncertain: true,
        expectedVersion: marked.task.version,
        expectedOverdueCount: marked.task.overdueCount,
        at: iso,
      })
      if (!blocked?.ok) {
        const kind = recordFailure(blocked, backoff, task.taskId, now, log, '最终 block ')
        if (kind === 'stale') out.stale += 1
        else if (kind === 'failed') out.failed += 1
        else out.skipped += 1
      }
    }
  }
  return out
}
