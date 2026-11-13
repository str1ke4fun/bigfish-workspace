/**
 * sleep.js —— 「每 N 天让她想一想」的到期判断（growth 自触发 item 8）。
 *
 * 旧逻辑是 `model.day % everyDays === 0`：错过那一天就再等一整轮，而且只有
 * 普通唤醒才会走到这里。现在改成「到期即触发」：上次 sleep 的成长日 + N，
 * 下一次唤醒/收盘补上；当天已经写过 `sleep:<dk>` 就不重复。
 *
 * 纯函数，不读盘、不抛。
 */

/**
 * 今天是不是该想一想了。
 *
 * @param {object[]} events 事件流（只读）
 * @param {{day?:number}} model deriveSelf 的结果
 * @param {number} everyDays 每几天一次；<=0 表示关闭
 * @param {string} dk 本地日期键（YYYY-MM-DD）
 * @returns {number|null} 到期的成长日；不需要触发时 null
 */
export function sleepDue(events, model, everyDays, dk) {
  const every = Number(everyDays)
  const day = Number(model?.day)
  if (!(every > 0) || !Number.isFinite(day) || day <= 1) return null

  const list = Array.isArray(events) ? events : []
  // 当天已经想过（或收盘已经问过）就不再问第二次。
  if (list.some((e) => e?.type === 'meta' && String(e?.text ?? '').startsWith(`sleep:${dk}`))) {
    return null
  }

  let lastDay = 0
  for (const e of list) {
    if (e?.type !== 'meta') continue
    if (!String(e?.text ?? '').startsWith('sleep:')) continue
    const d = Number(e.day)
    if (Number.isFinite(d) && d > lastDay) lastDay = d
  }

  const due = lastDay > 0 ? lastDay + every : every
  return day >= due ? due : null
}
