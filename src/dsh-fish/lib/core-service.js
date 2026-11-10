/**
 * core-service.js —— 插件内核服务 `fishCore`
 *
 * 一个对象把跨插件通道收口：
 *   - surface：这个会话属于哪个面（web / wx / qq / bili）；
 *   - guard  ：防注入、防泄露的最后一道闸；
 *   - config ：配置的只读入口（写入在后续任务里接）；
 *   - tools  ：统一返回契约的包装器（Task 5/6 在 index.js 里接线）；
 *   - memory ：事件流的唯一写/读门面（A1.2，见 memory-service.js）；
 *   - toolPolicy：工具策略贡献入口（A1.4，见 tool-policy.js）。
 *
 * 为什么要有这层：`dsh-wx` / `dsh-bili` 这类输入通道不能 import 本插件的内部文件，
 * 但面判定、过滤和工具返回契约必须只有一份实现。宿主服务名就是边界。
 *
 * 这个模块是纯的：不 import 任何别的插件，只用 `ctx.get('wx')` 之类的服务查询。
 */

import { join } from 'node:path'

import { createSurfaceRegistry } from './surface.js'
import { looksLikeRewriting, looksLikeSecret, sanitizeForeign, screenOutgoing } from './guard.js'
import { DEFAULTS, loadConfig } from './settings.js'
import { paths } from './store.js'
import { createMemoryService } from './memory-service.js'
import { contribute, ownTools, status, setAgentProbe, setHostNamesProvider } from './tool-policy.js'

function asWarn(log) {
  if (typeof log === 'function') return log
  if (typeof log?.warn === 'function') return (...args) => log.warn(...args)
  return undefined
}

/**
 * 创建并登记 `fishCore` 服务。
 *
 * @param {{ get?: (name: string) => any, provide?: (name: string, value: any) => any }} ctx
 * @param {{ root?: string, herDir?: string, log?: Function|{warn?: Function}, refreshSelfDoc?: Function }} [opts]
 * @returns {{ core: object, registry: object, dispose: () => void }}
 */
export function provideFishCore(ctx, { root, herDir, log, refreshSelfDoc } = {}) {
  const baseRoot = root || paths().root
  const homeDir = herDir || join(baseRoot, 'home')

  const warn = asWarn(log)
  const registry = createSurfaceRegistry({ log: warn ? { warn } : undefined })

  const surfaceDisposers = [
    // bili：她刷站用的专属 cwd。不是这个目录就不算 bili。
    registry.register({
      id: 'bili',
      match: ({ cwd }) => cwd === join(baseRoot, 'home', 'bili'),
    }),

    // wx：会话 id 由 dsh-wx 预分配。服务可能还没挂上，matcher 抛错按 false。
    registry.register({
      id: 'wx',
      match: ({ id }) => {
        try {
          const wx = ctx.get?.('wx')
          return wx?.isWxSession?.(id) === true || wx?.isReservedSession?.(id) === true
        } catch {
          return false
        }
      },
    }),

    // qq：OneBot 桥接出来的会话 id 固定前缀。
    registry.register({
      id: 'qq',
      match: ({ id }) => typeof id === 'string' && id.startsWith('onebot-'),
    }),

    // web：cwd 就是她的房间。屋子会话 id 由 bootstrapHome 建完后调用
    // `surface.reserve(id, 'web')` 登记（reserve 的预分配表优先于 matcher）；
    // 不再维护一份看起来像第二道保险、实际没人写的 homeSessionId。
    registry.register({
      id: 'web',
      match: ({ cwd }) => homeDir !== '' && cwd === homeDir,
    }),
  ]

  async function getConfig() {
    try {
      const { config } = await loadConfig(baseRoot)
      return config ?? { ...DEFAULTS }
    } catch {
      // 根目录不可读 / 配置坏了：给默认值，绝不把启动链路带走。
      return { ...DEFAULTS }
    }
  }

  const core = {
    surface: registry,
    guard: { sanitizeForeign, looksLikeSecret, looksLikeRewriting, screenOutgoing },
    config: {
      // loadConfig 是异步的（每次现读，配置改了不用重启）。
      get: getConfig,
      // 本任务先不实现写入，返回当前配置；后续任务再补 patch。
      patch: async () => getConfig(),
    },
    tools: { wrap: null, wrapRender: null, reveal: null },
  }

  // 事件流门面（A1.2）。挂在同一个 core 对象上：dsh-wx / dsh-bili 通过宿主服务
  // 拿到的就是这一份，后续任务往里加字段两边都看得见。
  // refreshSelfDoc 由 index.js 注入（core-service 不 import selfdoc），未注入时
  // memory 照常读写，只是 refresh 返回 NO_REFRESH。
  core.memory = createMemoryService({ root: baseRoot, core, refreshSelfDoc })

  // 工具策略贡献（A1.4）。dsh-bili / dsh-wx 从宿主服务拿到的必须是**同一个**
  // core 对象上的入口；再 provide 一个服务会让两边看到两份状态。
  core.toolPolicy = { contribute, ownTools, status, setAgentProbe, setHostNamesProvider }
  // 设计 §7.2 保留的兼容别名：老代码用 `surface.contribute` 也照样能贡献。
  registry.contribute = contribute

  let offProvide = null
  try {
    if (typeof ctx.provide === 'function') offProvide = ctx.provide('fishCore', core)
  } catch (err) {
    warn?.(`[dsh-fish] fishCore 服务没挂上：${String(err?.message ?? err).slice(0, 160)}`)
  }

  let disposed = false
  function dispose() {
    if (disposed) return
    disposed = true
    for (const off of surfaceDisposers) {
      try { off() } catch { /* ignore */ }
    }
    try { offProvide?.() } catch { /* ignore */ }
  }

  return { core, registry, dispose }
}
