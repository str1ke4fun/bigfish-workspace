/**
 * session-service.js —— `fishCore.sessions`（A1.6）
 *
 * 设计 §7.8 的窄接口：create / find / prompt / rename / list。
 * dsh-bili 搬出去以后不能直接 import outing.js / home.js，创建与投递会话
 * 只能走这里；本文件不 import 任何业务模块，只查宿主服务。
 *
 * 两条容易踩的顺序：
 *   - `surface.reserve(id, face)` 必须在 `sessionController.create` **之前**：
 *     agent/created 是同步发出的，等 create 返回再登记就晚了一步；
 *   - preset 不被宿主接受时要回退到不带 preset 的创建方式，不能一次失败就放弃。
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 宿主服务可能还没挂上；get / 属性两条路都试，永不抛。 */
function readService(ctx, name) {
  try { return ctx?.get?.(name) ?? ctx?.[name] ?? null } catch { return null }
}

/** 工作区路径比较：去掉尾部分隔符、解析成绝对路径，Windows 下不区分大小写。 */
function pathKey(p) {
  let s = String(p ?? '').replace(/[\\/]+$/, '')
  try { s = resolve(s) } catch { /* 保持原样 */ }
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * @param {{ ctx?: object, surface?: object, root?: string, log?: Function }} [opts]
 */
export function createSessionService({ ctx, surface, root = '', log } = {}) {
  const reserve = (id, face) => {
    if (!id || !face) return
    try { surface?.reserve?.(id, face) } catch { /* 面登记失败不挡创建 */ }
  }

  // 宿主列表形状在不同版本间有差异（items / value.items），统一取一次。
  async function hostSessions() {
    const sc = readService(ctx, 'sessionController')
    if (!sc || typeof sc.list !== 'function') return []
    try {
      const l = await sc.list({})
      return l?.items ?? l?.value?.items ?? []
    } catch (err) {
      log?.(`[dsh-fish] 会话列表读不到：${String(err?.message ?? err).slice(0, 120)}`)
      return []
    }
  }

  async function create({ title = '', cwd = '', preset = '', surface: face = '', agentId = '' } = {}) {
    const sc = readService(ctx, 'sessionController')
    if (!sc?.create) return { ok: false, why: 'NO_SESSION_CONTROLLER' }

    const requested = String(agentId || randomUUID())
    reserve(requested, face)

    // 有 cwd 就尽量挂进对应工作区：侧栏才看得见这条会话。
    let wsId = ''
    if (cwd) {
      const reg = readService(ctx, 'workspaceRegistry')
      try {
        const list = typeof reg?.list === 'function' ? reg.list() : []
        const hit = (list ?? []).find((w) => w?.path && pathKey(w.path) === pathKey(cwd))
        if (hit) wsId = String(hit.id ?? hit.workspaceId ?? '')
        else if (typeof reg?.create === 'function') {
          const ws = await reg.create(cwd, title || cwd)
          wsId = String(ws?.id ?? ws?.workspaceId ?? '')
        }
      } catch (err) {
        log?.(`[dsh-fish] 会话工作区没建成：${String(err?.message ?? err).slice(0, 120)}`)
      }
    }

    // 宿主 create 的几种形状：workspaceId / cwd 二选一，preset 可能不认识。
    // 与 outing.js 的 ensureBiliSession 同一套回退顺序。
    const attempts = []
    if (wsId) {
      if (preset) attempts.push({ workspaceId: wsId, sessionId: requested, agentPreset: preset })
      attempts.push({ workspaceId: wsId, sessionId: requested })
      attempts.push({ workspaceId: wsId })
    } else if (cwd) {
      if (preset) attempts.push({ cwd, sessionId: requested, agentPreset: preset })
      attempts.push({ cwd, sessionId: requested })
      attempts.push({ cwd })
    } else {
      if (preset) attempts.push({ sessionId: requested, agentPreset: preset })
      attempts.push({ sessionId: requested })
    }

    let created = null
    let lastWhy = ''
    for (const req of attempts) {
      try {
        const r = await sc.create(req)
        if (String(r?.sessionId ?? r?.id ?? '')) { created = r; break }
      } catch (err) {
        lastWhy = String(err?.message ?? err).slice(0, 120)
      }
    }
    const sessionId = String(created?.sessionId ?? created?.id ?? '')
    if (!sessionId) return { ok: false, why: lastWhy || 'HOST_NO_SESSION_ID' }

    reserve(sessionId, face)
    if (title && typeof sc.rename === 'function') {
      try { await sc.rename({ sessionId, title: String(title) }) } catch { /* 改不了不影响使用 */ }
    }
    return { ok: true, sessionId, wsId, reused: false }
  }

  async function list({ surface: face = '' } = {}) {
    const rows = await hostSessions()
    if (!face) return rows
    return rows.filter((x) => {
      const id = String(x?.sessionId ?? x?.id ?? '')
      if (!id) return false
      try {
        return surface?.current?.({ session: { header: { id } } }) === face
      } catch {
        return false
      }
    })
  }

  async function find({ title = '', surface: face = '' } = {}) {
    const want = String(title ?? '')
    // 先查 B 站记下的出门会话（设计 §7.8）：重启后它还没被 reserve，
    // surface.current 会把它判成 web，只查宿主列表等于看不见它，A2 会重复建会话。
    if (face === 'bili' && root) {
      const saved = await readFile(join(root, 'bili-session.json'), 'utf8')
        .then((s) => JSON.parse(s))
        .catch(() => null)
      if (saved?.sessionId && (!want || String(saved.title ?? '') === want)) {
        const id = String(saved.sessionId)
        reserve(id, 'bili')
        return { sessionId: id, wsId: String(saved.wsId ?? ''), title: String(saved.title ?? want) }
      }
    }
    const rows = await list({ surface: face })
    return rows.find((x) => String(x?.title ?? '') === want) ?? null
  }

  async function prompt(sessionId, text, { signal } = {}) {
    const sc = readService(ctx, 'sessionController')
    if (!sc?.prompt) return { ok: false, why: 'NO_SESSION_CONTROLLER' }
    const sig = signal ?? new AbortController().signal
    try {
      await sc.prompt({
        requestId: `fish-${Date.now()}-${randomUUID().slice(0, 8)}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: String(text ?? '') }],
      }, sig)
      return { ok: true }
    } catch (err) {
      return { ok: false, why: String(err?.message ?? err).slice(0, 200) }
    }
  }

  async function rename(sessionId, title) {
    const sc = readService(ctx, 'sessionController')
    if (!sc?.rename) return { ok: false, why: 'NO_SESSION_CONTROLLER' }
    try {
      await sc.rename({ sessionId, title: String(title ?? '') })
      return { ok: true }
    } catch (err) {
      return { ok: false, why: String(err?.message ?? err).slice(0, 200) }
    }
  }

  return { create, find, prompt, rename, list }
}
