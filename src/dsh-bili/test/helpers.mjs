/**
 * 测试替身：假 fishCore / 假宿主 ctx。
 *
 * 只实现 dsh-bili 实际用到的窄接口（memory / config / owner / guard / self /
 * toolLedger / prompt / sessions / schedule / toolPolicy），不用真宿主。
 */
export function fakeCore({
  events = [],
  config = {},
  ledger = { ok: true, rows: [] },
  identity = '',
} = {}) {
  const calls = { append: [], refresh: 0, contributions: [], sections: [] }
  const hooks = { tick: new Map(), wake: new Map() }

  const core = {
    memory: {
      readAll: async () => events,
      read: async () => events.filter((e) => e.type !== 'meta'),
      append: async (raw, ctx = {}) => {
        const event = { id: `ev_${calls.append.length + 1}`, ts: new Date().toISOString(), ...raw }
        calls.append.push({ raw, ctx, event })
        events.push(event)
        return { ok: true, event }
      },
      derive: async () => ({ day: 1, stage: 1, name: 'x', beliefs: [], growthDays: 30 }),
      refreshSelfDoc: async () => { calls.refresh += 1; return { ok: true } },
      eventById: async () => null,
      similarity: () => 0,
    },
    config: {
      get: async () => config,
      getView: async () => null,
      patch: async () => ({ ok: true }),
      onChange: (fn) => { calls.onChange = fn; return () => {} },
    },
    owner: {
      read: async () => ({ name: '测试' }),
      credentials: async () => ({ cookie: 'SESSDATA=x; bili_jct=y' }),
      write: async () => ({ ok: true }),
      mentionPrefix: async () => '@测试 ',
    },
    guard: {
      sanitizeForeign: (x) => x,
      screenOutgoing: (x) => x,
      looksLikeSecret: () => false,
      looksLikeRewriting: () => false,
    },
    self: {
      identity: () => identity,
      refresh: async () => { calls.refresh += 1; return { ok: true } },
    },
    toolLedger: {
      // 真 core 返回行数组；数组不能展开（会变成数字键），对象形式留给查询回显。
      read: async (q) => (Array.isArray(ledger) ? ledger : { ...ledger, query: q }),
    },
    tools: { wrap: null, wrapRender: null, reveal: null },
    toolPolicy: {
      contribute: (def, opts) => {
        calls.contributions.push({ def, opts })
        return { ok: true, off: () => {} }
      },
    },
    schedule: {
      onTick: ({ id, fn }) => { hooks.tick.set(id, fn); return () => hooks.tick.delete(id) },
      onWake: ({ id, fn }) => { hooks.wake.set(id, fn); return () => hooks.wake.delete(id) },
      status: () => ({
        tick: [...hooks.tick.keys()].map((id) => ({ id })),
        wake: [...hooks.wake.keys()].map((id) => ({ id })),
      }),
    },
    prompt: {
      setWake: () => {},
      clearWake: () => {},
      getWake: () => '',
      withWake: (fn) => fn(),
      watchTurnEnd: () => ({ off: () => {} }),
      section: (def) => { calls.sections.push(def); return () => {} },
    },
    sessions: {
      prompt: async () => ({ ok: true }),
      create: async () => ({ ok: true }),
      find: async () => null,
      rename: async () => ({ ok: true }),
      list: async () => [],
    },
    surface: { current: () => 'bili', reserve: () => {} },
  }

  return { core, calls, hooks }
}

export function fakeHost({ core, tools = [], services = {}, sessionPrompt } = {}) {
  const provided = new Map()
  const registered = []
  const routes = []
  const sections = []
  const listeners = new Map()
  if (core) provided.set('fishCore', core)

  const ctx = {
    provided,
    registered,
    routes,
    sections,
    get(key) {
      if (provided.has(key)) return provided.get(key)
      if (services[key] !== undefined) return services[key]
      return undefined
    },
    provide(key, value) {
      provided.set(key, value)
      return () => provided.delete(key)
    },
    tools: {
      register(def) { registered.push(def); return () => {} },
      get(name) { return tools.includes(name) ? { name } : undefined },
      view() { return { restrictableNames: new Set(tools) } },
    },
    on(evt, fn) {
      const arr = listeners.get(evt) ?? []
      arr.push(fn)
      listeners.set(evt, arr)
      return () => {}
    },
    emit(evt, payload) {
      for (const fn of listeners.get(evt) ?? []) fn(payload)
    },
    webServer: {
      register(def) { routes.push(def); return () => {} },
    },
    get sessionController() {
      return services.sessionController
    },
  }
  void sessionPrompt
  return ctx
}

export function fakeSessions(overrides = {}) {
  return {
    prompt: async () => ({ ok: true }),
    create: async ({ workspaceId, sessionId }) => ({ sessionId: sessionId ?? `s-${workspaceId}`, workspaceId }),
    rename: async () => ({ ok: true }),
    ...overrides,
  }
}

export function fakeWorkspaces(overrides = {}) {
  return {
    list: () => [],
    create: async (path, title) => ({ id: 'ws-bili', path, title, sessionIds: [] }),
    get: () => null,
    archivedSessionIds: [],
    ...overrides,
  }
}
