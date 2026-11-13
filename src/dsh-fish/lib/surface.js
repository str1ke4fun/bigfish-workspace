// Surface registry: decides which face (web | wx | qq | bili | screen) an agent belongs to.
//
// 注意：这里的 SURFACES 是**会话面**，与 schema.js 的“事件来源面”
// （core/web/wx/qq/bili/screen）以及 tool-policy.js 的“工具面”同名不同层。
//
// A surface is "reserved" for a session id before the session exists (e.g. dsh-wx
// reserves the id it is about to create), which wins over matcher probing. Unknown
// sessions resolve to null; they are never assumed to be `web`.
//
// This is a pure module: no imports and no I/O.

export const SURFACES = ['web', 'wx', 'qq', 'bili', 'screen']

const SURFACE_SET = new Set(SURFACES)

export function agentSessionId(agent) {
  return agent?.session?.header?.id ?? agent?.session?.id ?? agent?.id ?? ''
}

function agentCwd(agent) {
  return agent?.session?.header?.cwd ?? agent?.header?.cwd ?? agent?.session?.cwd
}

// screen 必须进 priority，否则 core-service 注册的 cwd matcher 永远不会被探测。
export function createSurfaceRegistry({ log, priority = ['bili', 'wx', 'qq', 'screen', 'web'] } = {}) {
  const handlers = new Map() // surfaceId -> { match, sections }
  const reserved = new Map() // sessionId -> surfaceId

  function register({ id, match, sections = [] } = {}) {
    if (!SURFACE_SET.has(id)) throw new Error(`SURFACE_UNKNOWN: ${id}`)
    if (typeof match !== 'function') throw new Error(`SURFACE_INVALID: ${id} matcher must be a function`)
    if (handlers.has(id)) throw new Error(`SURFACE_DUPLICATE: ${id} already registered`)
    const entry = { match, sections: Array.isArray(sections) ? [...sections] : [] }
    handlers.set(id, entry)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (handlers.get(id) === entry) handlers.delete(id)
    }
  }

  function reserve(sessionId, surfaceId) {
    if (!sessionId) return
    if (!SURFACE_SET.has(surfaceId)) {
      log?.warn?.(`[dsh-fish] surface reserve ignored: unknown surface ${surfaceId}`)
      return
    }
    reserved.set(sessionId, surfaceId)
  }

  function release(sessionId) {
    if (!sessionId) return
    reserved.delete(sessionId)
  }

  function current(agent) {
    const id = agentSessionId(agent)
    if (id) {
      const surfaceId = reserved.get(id)
      if (surfaceId) return surfaceId
    }
    const input = { id, cwd: agentCwd(agent), serviceState: undefined }
    for (const surfaceId of priority) {
      const entry = handlers.get(surfaceId)
      if (!entry) continue
      try {
        if (entry.match(input)) return surfaceId
      } catch (err) {
        log?.warn?.(`[dsh-fish] surface matcher ${surfaceId} failed`, err?.message ?? err)
      }
    }
    return null
  }

  function list() {
    return [...handlers].map(([id, entry]) => ({ id, sections: [...entry.sections] }))
  }

  function known() {
    return [...reserved.keys()]
  }

  return { register, reserve, release, current, list, known }
}
