/**
 * host-cua-mode.js —— 托管授权状态机（off / observe / managed）
 *
 * 纯状态：不信任、不落盘、不碰进程。服务层在 onChange 里启动/停止驱动。
 * 规则：
 *   - 只有 workbench 能开启；pet 只能 off；
 *   - managed 不能降回 observe，只能停掉重开；
 *   - TTL 到期自动 off，不续期。
 */

export const HOST_CUA_MODES = Object.freeze(['off', 'observe', 'managed'])

export function createHostCuaMode({
  now = Date.now,
  ttlMs = 15 * 60_000,
  schedule = setTimeout,
  cancel = clearTimeout,
  onChange = () => {},
} = {}) {
  let mode = 'off'
  let since = 0
  let expiresAt = 0
  let actor = ''
  let reason = ''
  let timer = null

  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : 15 * 60_000

  function clearTimer() {
    if (timer !== null) {
      try { cancel(timer) } catch { /* ignore */ }
      timer = null
    }
  }

  function status() {
    const ms = now()
    return {
      mode,
      phase: mode === 'off' ? 'off' : 'on',
      since,
      expiresAt,
      remainingMs: mode === 'off' ? 0 : Math.max(0, expiresAt - ms),
      actor,
      reason,
    }
  }

  function emit(why) {
    try { onChange(status(), why) } catch { /* 监听器失败不影响状态 */ }
  }

  function arm() {
    clearTimer()
    if (mode === 'off') return
    const delay = Math.max(0, expiresAt - now())
    timer = schedule(() => {
      timer = null
      if (mode !== 'off' && now() >= expiresAt) setOff('expired', 'ttl')
    }, delay)
    if (typeof timer?.unref === 'function') timer.unref()
  }

  function setOff(why, who = 'system') {
    mode = 'off'
    since = now()
    expiresAt = 0
    actor = who
    reason = why
    clearTimer()
    emit(why)
    return { ok: true, status: status() }
  }

  function setMode({ mode: next, actor: who = '' } = {}) {
    if (!HOST_CUA_MODES.includes(next)) {
      return { ok: false, code: 'BAD_MODE', status: status() }
    }
    if (who === 'pet' && next !== 'off') {
      return { ok: false, code: 'PET_CANNOT_START', status: status() }
    }
    if (next === 'off') return setOff('manual', who || 'manual')
    if (mode === 'managed' && next === 'observe') {
      return { ok: false, code: 'MODE_DOWNGRADE', status: status() }
    }
    mode = next
    since = now()
    expiresAt = since + ttl
    actor = who || 'workbench'
    reason = ''
    arm()
    emit('start')
    return { ok: true, status: status() }
  }

  function authorize(need) {
    if (mode === 'off') return { ok: false, code: 'HOST_CUA_OFF' }
    if (need === 'managed' && mode !== 'managed') return { ok: false, code: 'MANAGED_ONLY' }
    return { ok: true, mode }
  }

  function tick() {
    if (mode !== 'off' && now() >= expiresAt) setOff('expired', 'ttl')
    return status()
  }

  function dispose() {
    clearTimer()
    mode = 'off'
    expiresAt = 0
  }

  return { status, setMode, authorize, tick, dispose }
}
