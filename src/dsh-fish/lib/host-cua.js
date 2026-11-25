/**
 * host-cua.js —— 托管模式的服务层：授权、驱动生命周期、预算、审计
 *
 * 职责：
 *   - 解析桌宠上报的驱动路径，spawn cua-driver mcp --direct；
 *   - 只允许 5 个驱动工具名，别的名字在客户端拒绝；
 *   - 输入动作预算/频率限制；
 *   - 驱动退出/TTL/停止都 fail closed；
 *   - 写 host-cua/audit-YYYY-MM-DD.jsonl（不记正文）。
 *
 * 不碰 UI、不碰事件流；工作台路由和桌宠状态由上层接。
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

import { createHostCuaMode } from './host-cua-mode.js'
import { createMcpStdioClient } from './mcp-stdio.js'
import {
  DEFAULT_HOST_APPS, DEFAULT_HOST_DENY, isHostAppAllowed, winPathToWsl,
} from './host-window.js'
import {
  resolveDetail, resolveInput, isStableDriverPath,
} from './host-cua-detail.js'
import { readJson, writeAtomic } from './store.js'

export const ALLOWED_DRIVER_TOOLS = Object.freeze([
  'list_windows', 'get_window_state', 'click', 'type_text', 'press_key',
])

const INPUT_TOOLS = new Set(['click', 'type_text', 'press_key'])
const DEFAULT_BUDGET = Object.freeze({ maxActions: 40, maxActionsPer10s: 8, maxTypedChars: 5000 })
const RATE_WINDOW_MS = 10_000

/** 剔除可能带凭据的环境变量；保留 Windows/interop 必需变量。 */
export function scrubEnv(env = process.env) {
  const out = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (/KEY|PASSWORD|SECRET|TOKEN|COOKIE|CREDENTIAL/i.test(key)) continue
    if (/^DSH_/.test(key)) continue
    out[key] = value
  }
  return out
}

function budgetOf(config) {
  const raw = config?.hostCua?.budget ?? {}
  const pick = (v, d, lo, hi) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return d
    return Math.max(lo, Math.min(hi, Math.round(n)))
  }
  return {
    maxActions: pick(raw.maxActions, DEFAULT_BUDGET.maxActions, 1, 200),
    maxActionsPer10s: pick(raw.maxActionsPer10s, DEFAULT_BUDGET.maxActionsPer10s, 1, 60),
    maxTypedChars: pick(raw.maxTypedChars, DEFAULT_BUDGET.maxTypedChars, 0, 20_000),
  }
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} [opts.config]
 * @param {Function} [opts.log]
 * @param {Function} [opts.now]
 * @param {Function} [opts.spawn]
 * @param {Function} [opts.exists]
 * @param {Function} [opts.createClient]
 */
export function createHostCua({
  root,
  config = {},
  log = () => {},
  now = Date.now,
  spawn = nodeSpawn,
  exists = existsSync,
  createClient = createMcpStdioClient,
} = {}) {
  const cfg = config?.hostCua ?? {}
  const ttlMs = Number.isFinite(Number(cfg.ttlMs)) && Number(cfg.ttlMs) > 0 ? Number(cfg.ttlMs) : 15 * 60_000
  const budget = budgetOf(config)

  let phase = 'off'
  let client = null
  let driver = null
  let lastError = ''
  let disposed = false
  let telemetryTried = false
  let actionTimes = []
  let actions = { count: 0, typedChars: 0, lastAt: 0 }
  let callTail = Promise.resolve()
  let auditTail = Promise.resolve()

  const mode = createHostCuaMode({
    now,
    ttlMs,
    onChange: (status, why) => {
      if (status.mode === 'off') {
        stopClient()
        phase = why === 'expired' ? 'off' : phase === 'starting' ? 'error' : 'off'
        if (why === 'expired') void audit({ kind: 'mode', mode: 'off', action: 'stop', actor: 'ttl', reason: 'expired' })
      }
    },
  })

  function appStatus() {
    const allow = Array.isArray(cfg.apps) ? cfg.apps : [...DEFAULT_HOST_APPS]
    const deny = Array.isArray(cfg.deny) ? cfg.deny : [...DEFAULT_HOST_DENY]
    return allow
      .filter((app) => isHostAppAllowed(app, { allow, deny }))
      .map((app) => {
        const detail = resolveDetail(app, cfg)
        return {
          app,
          detail,
          input: detail === 'none' ? 'deny' : resolveInput(app, cfg),
        }
      })
  }

  function status() {
    mode.tick()
    return {
      ok: true,
      mode: mode.status().mode,
      phase,
      since: mode.status().since,
      expiresAt: mode.status().expiresAt,
      remainingMs: mode.status().remainingMs,
      driver: driver && client && !client.closed ? {
        connected: true,
        exe: driver.exe,
        version: driver.version,
        pid: client.pid,
      } : null,
      apps: appStatus(),
      actions: { ...actions },
      lastError,
    }
  }

  function petState() {
    const s = status()
    return {
      mode: s.mode,
      phase: s.phase,
      remainingMs: s.remainingMs,
      driverConnected: Boolean(s.driver?.connected),
      actionCount: s.actions.count,
      lastActionAt: s.actions.lastAt,
    }
  }

  function resetActions() {
    actions = { count: 0, typedChars: 0, lastAt: 0 }
    actionTimes = []
  }

  function stopClient() {
    const current = client
    client = null
    driver = null
    try { current?.dispose?.() } catch { /* ignore */ }
  }

  async function resolveDriverExe() {
    const explicit = String(cfg.exe ?? '').trim()
    if (explicit) return winPathToWsl(explicit)
    const reg = await readJson(join(root, 'host-cua.json'), null)
    const reported = String(reg?.exe ?? '').trim()
    if (reported && isStableDriverPath(reported)) return winPathToWsl(reported)
    return ''
  }

  async function refreshRegistration({ version, exe } = {}) {
    const raw = String(exe ?? '').trim()
    if (!raw || !isStableDriverPath(raw)) {
      log(`[host-cua] 忽略非稳定路径的驱动注册：${raw.slice(0, 160) || '(empty)'}`)
      return false
    }
    const body = {
      version: String(version ?? '').slice(0, 64),
      exe: raw,
      at: now(),
    }
    try {
      await writeAtomic(join(root, 'host-cua.json'), JSON.stringify(body, null, 2))
      return true
    } catch (err) {
      log(`[host-cua] 写 host-cua.json 失败：${String(err?.message ?? err).slice(0, 200)}`)
      return false
    }
  }

  function telemetryDisable(exe) {
    if (telemetryTried) return
    telemetryTried = true
    try {
      const child = spawn(exe, ['telemetry', 'disable'], {
        cwd: dirname(exe),
        env: { ...scrubEnv(process.env), CUA_DRIVER_TELEMETRY_ENABLED: '0' },
        windowsHide: true,
        stdio: 'ignore',
      })
      child?.on?.('error', () => { /* ignore */ })
      child?.unref?.()
    } catch (err) {
      log(`[host-cua] telemetry disable 没跑成：${String(err?.message ?? err).slice(0, 200)}`)
    }
  }

  async function startManaged() {
    phase = 'starting'
    lastError = ''
    const exe = await resolveDriverExe()
    if (!exe || !exists(exe)) {
      lastError = 'DRIVER_NOT_FOUND'
      mode.setMode({ mode: 'off', actor: 'system' })
      phase = 'error'
      return { ok: false, code: 'DRIVER_NOT_FOUND', status: status() }
    }

    telemetryDisable(exe)
    let created = null
    try {
      created = createClient({
        command: exe,
        args: ['mcp', '--direct'],
        cwd: dirname(exe),
        env: { ...scrubEnv(process.env), CUA_DRIVER_TELEMETRY_ENABLED: '0' },
        onExit: (err) => {
          if (disposed || client !== created) return
          client = null
          driver = null
          mode.setMode({ mode: 'off', actor: 'system' })
          phase = 'error'
          lastError = `driver-exit: ${String(err?.message ?? err).slice(0, 200)}`
          void audit({ kind: 'mode', mode: 'off', action: 'error', reason: lastError })
        },
        log: (...args) => log(...args),
      })
      client = created
      const init = await created.initialize({ clientInfo: { name: 'dsh-fish-host-cua', version: '0.9.1' } })
      const tools = await created.listTools()
      const names = new Set((Array.isArray(tools) ? tools : []).map((t) => String(t?.name ?? '')))
      const missing = ALLOWED_DRIVER_TOOLS.filter((name) => !names.has(name))
      if (missing.length) {
        throw Object.assign(new Error(`驱动缺少工具：${missing.join(',')}`), { code: 'DRIVER_TOOLS_MISSING' })
      }
      driver = {
        exe,
        version: String(init?.serverInfo?.version ?? ''),
        pid: created.pid,
      }
      phase = 'on'
      resetActions()
      return { ok: true, status: status() }
    } catch (err) {
      stopClient()
      mode.setMode({ mode: 'off', actor: 'system' })
      phase = 'error'
      lastError = String(err?.message ?? err).slice(0, 300)
      void audit({ kind: 'mode', mode: 'off', action: 'error', reason: lastError })
      return { ok: false, code: err?.code ?? 'DRIVER_START_FAILED', status: status() }
    }
  }

  async function setMode({ mode: next, actor = '' } = {}) {
    if (disposed) return { ok: false, code: 'DISPOSED', status: status() }
    const changed = mode.setMode({ mode: next, actor })
    if (!changed.ok) return changed

    if (next === 'off') {
      stopClient()
      phase = 'off'
      resetActions()
      void audit({ kind: 'mode', mode: 'off', action: 'stop', actor, reason: 'manual' })
      return { ok: true, status: status() }
    }
    if (next === 'observe') {
      stopClient()
      phase = 'on'
      resetActions()
      void audit({ kind: 'mode', mode: 'observe', action: 'start', actor })
      return { ok: true, status: status() }
    }
    void audit({ kind: 'mode', mode: 'managed', action: 'start', actor })
    return startManaged()
  }

  function audit(entry) {
    const line = JSON.stringify({
      at: now(),
      ...entry,
    }) + '\n'
    const file = join(root, 'host-cua', `audit-${dayKey(now())}.jsonl`)
    auditTail = auditTail.then(async () => {
      await fs.mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 })
    }).catch((err) => {
      log(`[host-cua] 审计写入失败：${String(err?.message ?? err).slice(0, 200)}`)
    })
    return auditTail
  }

  function call(tool, args = {}, { timeoutMs } = {}) {
    if (!ALLOWED_DRIVER_TOOLS.includes(tool)) {
      return Promise.reject(Object.assign(new Error('TOOL_NOT_ALLOWED'), { code: 'TOOL_NOT_ALLOWED' }))
    }
    if (mode.status().mode !== 'managed' || !client || client.closed) {
      return Promise.reject(Object.assign(new Error('托管模式没开'), { code: 'MANAGED_OFF' }))
    }

    const isInput = INPUT_TOOLS.has(tool)
    const ms = now()
    if (isInput) {
      actionTimes = actionTimes.filter((at) => ms - at < RATE_WINDOW_MS)
      if (actionTimes.length >= budget.maxActionsPer10s) {
        void audit({ kind: 'call', tool, ok: false, code: 'RATE_LIMITED', ms: 0 })
        return Promise.reject(Object.assign(new Error('RATE_LIMITED'), { code: 'RATE_LIMITED' }))
      }
      if (actions.count >= budget.maxActions) {
        void audit({ kind: 'call', tool, ok: false, code: 'ACTION_BUDGET', ms: 0 })
        return Promise.reject(Object.assign(new Error('ACTION_BUDGET'), { code: 'ACTION_BUDGET' }))
      }
      const textLen = tool === 'type_text' ? String(args?.text ?? '').length : 0
      if (actions.typedChars + textLen > budget.maxTypedChars) {
        void audit({ kind: 'call', tool, ok: false, code: 'ACTION_BUDGET', ms: 0 })
        return Promise.reject(Object.assign(new Error('ACTION_BUDGET'), { code: 'ACTION_BUDGET' }))
      }
      actionTimes.push(ms)
      actions.count += 1
      actions.typedChars += textLen
      actions.lastAt = ms
    }

    const started = now()
    const run = () => client.callTool(tool, args, { timeoutMs })
    const result = callTail.then(run, run)
    callTail = result.then(() => undefined, () => undefined)
    return result.then(
      (value) => {
        void audit({ kind: 'call', tool, ok: true, code: '', ms: now() - started })
        return value
      },
      (err) => {
        void audit({ kind: 'call', tool, ok: false, code: String(err?.code ?? 'CALL_FAILED'), ms: now() - started })
        throw err
      },
    )
  }

  function dispose() {
    disposed = true
    stopClient()
    try { mode.dispose() } catch { /* ignore */ }
    phase = 'off'
  }

  return {
    status,
    setMode,
    authorize: (need) => mode.authorize(need),
    call,
    refreshRegistration,
    petState,
    dispose,
  }
}
