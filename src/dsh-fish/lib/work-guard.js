/**
 * work-guard.js —— worker 会话的读路径与外发命令守卫（G 方案）
 *
 * 这是代码级 denylist，不是内核隔离：它能挡住常见的秘密路径和裸外发命令，
 * 挡不住任意二进制、混淆或包管理器脚本。真正的读/网络隔离在 P4。
 *
 * 识别 worker：
 *   1. `work-units.json` 里 `backendRef.childId` 等于当前会话 id；
 *   2. 或 `header.parentSession` 是一个 work 工头，且 preset 是 `fish-work-*`。
 * 两者都不命中时，普通会话完全不受影响；如果 parentSession 是 work 工头
 * 但 preset 不可判定，则对该会话的 fs/bash fail closed。
 *
 * 命中只写有界的 guardHits（工具名 + 一个 basename），不把完整命令/路径/秘密
 * 写进状态文件或微信。
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const WORKER_HOST_TOOLS = Object.freeze([
  'read', 'write', 'edit', 'glob', 'grep', 'bash', 'pwsh', 'structured_output',
])

const PATH_TOOLS = new Set(['read', 'write', 'edit', 'read_image', 'glob', 'grep'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
/** 鱼侧工具名：worker 不是她，即使 restrict 没收干净也不能调用。 */
const FISH_TOOL_RE = /^(?:growth_commit|her_|wx_|qq_|bili_|presence_speak|look_screen)/

const REASON = '这件事得先问过用户，不能直接做。'

const SECRET_RE = /(?:^|[\s'"`])(?:~\/\.ssh|~\/\.aws|~\/\.dsh|~\/\.dsh-fish|\/\.ssh|\/\.aws|\/\.dsh|\/\.dsh-fish|\/etc\/shadow|\/etc\/sudoers|id_rsa|id_ed25519|\.netrc)/i
const EGRESS_RE = /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|telnet|socat)\b/i
const GIT_DANGER_RE = /\bgit\s+(?:push|clean\s+-[a-z]*f[a-z]*|reset\s+--hard)\b/i
const SUDO_RE = /(?:^|[\s;&|])sudo\b/i
const RM_ROOT_RE = /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:\s|$)/i

function headerOf(agent) {
  return agent?.session?.header ?? agent?.header ?? {}
}

function safeUnits(state) {
  try {
    return Array.isArray(state?.readUnits?.().units) ? state.readUnits().units : []
  } catch {
    return []
  }
}

function safeSessions(state) {
  try {
    const raw = state?.readSessions?.() ?? {}
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

/** 最接近的存在祖先做 realpath，再把不存在的尾段接回去。 */
function realResolve(path) {
  let cur = resolve(path)
  const tail = []
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(cur)) {
      let real = cur
      try { real = realpathSync(cur) } catch { /* 保持原样 */ }
      return resolve(real, ...tail)
    }
    const parent = dirname(cur)
    if (parent === cur) break
    tail.unshift(basename(cur))
    cur = parent
  }
  return resolve(path)
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function protectedPaths() {
  const home = (() => {
    try { return homedir() } catch { return '' }
  })()
  const out = ['/etc/shadow', '/etc/sudoers']
  if (home) {
    out.push(join(home, '.ssh'), join(home, '.aws'), join(home, '.dsh'), join(home, '.dsh-fish'))
  }
  out.push('/root/.ssh', '/root/.aws')
  return out
}

function hitsProtected(path) {
  return protectedPaths().some((p) => path === p || path.startsWith(p + sep))
}

/**
 * @param {{ state?: object, log?: Function, now?: () => number }} [opts]
 */
export function createWorkGuard({ state, log, now = Date.now } = {}) {
  let registered = false
  let disposed = false
  let totalHits = 0
  const pending = new Map() // childId -> [{unitId?, text}]

  function unitForChild(childId) {
    const id = String(childId ?? '')
    return safeUnits(state).find((u) => String(u?.backendRef?.childId ?? '') === id) ?? null
  }

  function bossSessionIds() {
    const set = new Set()
    for (const rec of Object.values(safeSessions(state))) {
      if (rec && typeof rec === 'object' && rec.sessionId) set.add(String(rec.sessionId))
    }
    return set
  }

  function isWorkSubtree(agent) {
    const parent = String(headerOf(agent).parentSession ?? '')
    return parent !== '' && bossSessionIds().has(parent)
  }

  function isWorkerSession(agent) {
    const header = headerOf(agent)
    const id = String(header.id ?? '')
    if (id && unitForChild(id)) return true
    if (!isWorkSubtree(agent)) return false
    const preset = String(header.agentPreset ?? '')
    return preset.startsWith('fish-work-')
  }

  function noteHit(agent, toolName, detail) {
    totalHits += 1
    const childId = String(headerOf(agent).id ?? '')
    const text = `${toolName}: ${detail}`
    const unit = childId ? unitForChild(childId) : null
    if (unit?.id && typeof state?.appendGuardHit === 'function') {
      Promise.resolve(state.appendGuardHit(unit.id, text)).catch(() => {})
      return
    }
    if (!childId) return
    const list = pending.get(childId) ?? []
    list.push(text)
    pending.set(childId, list)
  }

  function deny(agent, toolName, detail) {
    noteHit(agent, toolName, detail)
    return { ok: false, reason: REASON }
  }

  function checkPath({ agent, toolName, args }) {
    const header = headerOf(agent)
    const cwdRaw = String(header.cwd ?? '')
    if (!cwdRaw) return deny(agent, toolName, 'no-cwd')
    // glob 的 pattern 本身也能用 ../ 或绝对路径逃出工作目录。
    if (toolName === 'glob') {
      const pattern = String(args?.pattern ?? '')
      if (isAbsolute(pattern) || /(^|[\\/])\.\.([\\/]|$)/.test(pattern)) {
        return deny(agent, toolName, 'outside-pattern')
      }
    }
    const cwd = realResolve(cwdRaw)
    const raw = toolName === 'glob' || toolName === 'grep'
      ? (args?.path ?? cwd)
      : args?.file_path
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return deny(agent, toolName, 'no-path')
    }
    const real = realResolve(resolve(cwd, String(raw)))
    if (!inside(cwd, real)) return deny(agent, toolName, 'outside')
    if (hitsProtected(real)) return deny(agent, toolName, 'protected')
    return { ok: true }
  }

  function checkShell({ agent, toolName, args }) {
    const command = String(args?.command ?? '')
    if (!command.trim()) return deny(agent, toolName, 'empty-command')
    const header = headerOf(agent)
    const cwdRaw = String(header.cwd ?? '')
    if (args?.workdir !== undefined && args?.workdir !== null && String(args.workdir).trim() !== '') {
      if (!cwdRaw) return deny(agent, toolName, 'no-cwd')
      const cwd = realResolve(cwdRaw)
      const workdir = realResolve(resolve(cwd, String(args.workdir)))
      if (!inside(cwd, workdir)) return deny(agent, toolName, 'outside-workdir')
    }
    if (SECRET_RE.test(command)) return deny(agent, toolName, 'secret')
    if (EGRESS_RE.test(command)) return deny(agent, toolName, 'egress')
    if (GIT_DANGER_RE.test(command)) return deny(agent, toolName, 'git')
    if (SUDO_RE.test(command)) return deny(agent, toolName, 'sudo')
    if (RM_ROOT_RE.test(command)) return deny(agent, toolName, 'rm-root')
    return { ok: true }
  }

  function check({ toolName, args = {}, agent } = {}) {
    const name = String(toolName ?? '')
    const worker = isWorkerSession(agent)
    if (!worker) {
      // 工头子树里但 preset 不可判定：fs/bash fail closed；普通会话放过。
      if (isWorkSubtree(agent) && (PATH_TOOLS.has(name) || SHELL_TOOLS.has(name))) {
        return deny(agent, name, 'unknown-preset')
      }
      return { ok: true }
    }
    if (FISH_TOOL_RE.test(name)) return deny(agent, name, 'fish-tool')
    if (SHELL_TOOLS.has(name)) return checkShell({ agent, toolName: name, args })
    if (PATH_TOOLS.has(name)) return checkPath({ agent, toolName: name, args })
    return { ok: true }
  }

  function flushHits(childId, unitId) {
    const id = String(childId ?? '')
    const list = pending.get(id) ?? []
    pending.delete(id)
    if (!list.length) return 0
    for (const text of list) {
      try { Promise.resolve(state?.appendGuardHit?.(unitId, text)).catch(() => {}) } catch { /* ignore */ }
    }
    return list.length
  }

  function register(ctx) {
    if (disposed) return () => {}
    if (typeof ctx?.on !== 'function') {
      log?.('[dsh-fish] work-guard 没挂上：ctx.on 不可用')
      return () => {}
    }
    const listener = (exec, next) => {
      const pass = () => (typeof next === 'function' ? next() : undefined)
      try {
        const d = check({
          toolName: exec?.name,
          args: exec?.arguments ?? exec?.args ?? {},
          agent: exec?.agent,
        })
        return d.ok ? pass() : { kind: 'deny', reason: d.reason }
      } catch (err) {
        // 守卫自己出错不把普通会话变成不可用；worker 子树仍按 fail closed。
        try {
          if (isWorkSubtree(exec?.agent)) return { kind: 'deny', reason: REASON }
        } catch { /* ignore */ }
        log?.(`[dsh-fish] work-guard 检查失败：${String(err?.message ?? err).slice(0, 160)}`)
        return pass()
      }
    }
    try {
      const off = ctx.on('tools/pre-execute', listener)
      registered = true
      return () => {
        disposed = true
        registered = false
        try { off?.() } catch { /* ignore */ }
      }
    } catch (err) {
      log?.(`[dsh-fish] work-guard 监听没挂上：${String(err?.message ?? err).slice(0, 160)}`)
      return () => {}
    }
  }

  function status() {
    return { ok: registered && !disposed, hits: totalHits, pending: pending.size, at: now() }
  }

  return { WORKER_HOST_TOOLS, isWorkerSession, isWorkSubtree, check, register, flushHits, status }
}
