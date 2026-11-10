/**
 * schedule-hooks.js —— 调度钩子表（A1.5）
 *
 * 做什么：给内核一个「到点做什么」的注册表，但**不新建任何定时器**。
 * 钩子由 scheduler 已有的串行 tick（以及真正发生唤醒的那一次）调用：
 *
 *   runTick(ctx)  —— 每个串行 tick 跑一次；多个钩子按 order 串行，不并发。
 *   runWake(ctx)  —— 只在真要唤醒时跑一次；结果按顺序合并成唤醒素材。
 *
 * 三条约定：
 *   1. **everyMs 是「至少间隔」**，不是精确周期。调度漂移、上一轮跑得久，
 *      只会让它更晚，不会叠加补跑。执行前先写 lastRun，所以抛错的钩子也照样
 *      等下一个间隔，不会每分钟重试。
 *   2. **单个钩子抛错只记一行日志**（含 id 与 message），不影响同轮其它钩子；
 *      runTick / runWake 自身永不 reject。
 *   3. **不碰定时器**。dispose() 只清表、置 disposed，之后 runTick 返回
 *      `{changed:false}`、runWake 返回空素材。
 *
 * 零依赖：这个文件只做注册、排序与合并。
 */

function messageOf(err) {
  return String(err?.message ?? err)
}

function asMs(v) {
  if (v instanceof Date) {
    const t = v.getTime()
    if (Number.isFinite(t)) return t
  }
  const n = Number(v)
  return Number.isFinite(n) ? n : Date.now()
}

export function createScheduleHooks({ log } = {}) {
  /** @type {{id:string, everyMs:number, order:number, lastRun:number|null, seq:number, fn:Function}[]} */
  const ticks = []
  /** @type {{id:string, order:number, seq:number, fn:Function}[]} */
  const wakes = []
  const ids = new Set()
  let disposed = false
  let seq = 0

  function record(kind, { id, order = 0, fn }) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error(`${kind} hook 的 id 必须是非空字符串`)
    }
    if (!Number.isFinite(order)) {
      throw new Error(`${kind} hook「${id}」的 order 必须是有限数`)
    }
    if (typeof fn !== 'function') {
      throw new Error(`${kind} hook「${id}」的 fn 必须是函数`)
    }
    if (ids.has(id)) {
      throw new Error(`schedule hook id 重复：${id}`)
    }
    ids.add(id)
    return { id, order, fn, seq: seq++ }
  }

  function onTick({ id, everyMs = 0, order = 0, fn } = {}) {
    if (!Number.isFinite(everyMs)) {
      throw new Error(`tick hook「${id}」的 everyMs 必须是有限数`)
    }
    const rec = { ...record('tick', { id, order, fn }), everyMs, lastRun: null }
    if (disposed) {
      // dispose 之后再注册：不留在表里，给一个安全的空 disposer。
      ids.delete(rec.id)
      return () => {}
    }
    ticks.push(rec)
    let off = false
    return function disposeTickHook() {
      if (off) return
      off = true
      const i = ticks.indexOf(rec)
      if (i >= 0) ticks.splice(i, 1)
      ids.delete(rec.id)
    }
  }

  function onWake({ id, order = 0, fn } = {}) {
    const rec = record('wake', { id, order, fn })
    if (disposed) {
      ids.delete(rec.id)
      return () => {}
    }
    wakes.push(rec)
    let off = false
    return function disposeWakeHook() {
      if (off) return
      off = true
      const i = wakes.indexOf(rec)
      if (i >= 0) wakes.splice(i, 1)
      ids.delete(rec.id)
    }
  }

  function ordered(list) {
    return [...list].sort((a, b) => (a.order - b.order) || (a.seq - b.seq))
  }

  function report(kind, rec, err) {
    try {
      log?.(`${kind} hook failed: ${rec.id}: ${messageOf(err)}`)
    } catch { /* 日志自己炸了也不能影响调度 */ }
  }

  async function runTick(ctx = {}) {
    if (disposed) return { changed: false }
    const nowMs = asMs(ctx.now)
    let changed = false
    for (const rec of ordered(ticks)) {
      if (disposed) break
      if (rec.everyMs > 0 && rec.lastRun != null && nowMs - rec.lastRun < rec.everyMs) continue
      // 先写 lastRun：钩子抛错也照样等下一个间隔，不每分钟重试。
      if (rec.everyMs > 0) rec.lastRun = nowMs
      try {
        const r = await rec.fn(ctx)
        if (r?.changed === true) changed = true
      } catch (err) {
        report('tick', rec, err)
      }
    }
    return { changed }
  }

  async function runWake(ctx = {}) {
    const empty = { text: '', intro: '', picks: [], riskNote: '' }
    if (disposed) return empty
    const text = []
    const intro = []
    const picks = []
    const riskNote = []
    for (const rec of ordered(wakes)) {
      if (disposed) break
      let r
      try {
        r = await rec.fn(ctx)
      } catch (err) {
        report('wake', rec, err)
        continue
      }
      if (!r || typeof r !== 'object') continue
      if (typeof r.text === 'string' && r.text !== '') text.push(r.text)
      if (typeof r.intro === 'string' && r.intro !== '') intro.push(r.intro)
      if (typeof r.riskNote === 'string' && r.riskNote !== '') riskNote.push(r.riskNote)
      if (Array.isArray(r.picks)) picks.push(...r.picks)
    }
    return {
      text: text.join('\n\n'),
      intro: intro.join('\n\n'),
      picks,
      riskNote: riskNote.join('\n\n'),
    }
  }

  function status() {
    return {
      tick: ticks.map(({ id, everyMs, order, lastRun }) => ({ id, everyMs, order, lastRun })),
      wake: wakes.map(({ id, order }) => ({ id, order })),
      disposed,
    }
  }

  function dispose() {
    disposed = true
    ticks.length = 0
    wakes.length = 0
    ids.clear()
  }

  return { onTick, onWake, runTick, runWake, status, dispose }
}
