/**
 * core-service.js —— 插件内核服务 `fishCore`
 *
 * 一个对象把跨插件通道收口：
 *   - surface：这个会话属于哪个面（web / wx / qq / bili）；
 *   - guard  ：防注入、防泄露的最后一道闸；
 *   - config ：配置的只读入口（写入在后续任务里接）；
 *   - tools  ：统一返回契约的包装器（Task 5/6 在 index.js 里接线）。
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

function asWarn(log) {
  if (typeof log === 'function') return log
  if (typeof log?.warn === 'function') return (...args) => log.warn(...args)
  return undefined
}

/**
 * 创建并登记 `fishCore` 服务。
 *
 * @param {{ get?: (name: string) => any, provide?: (name: string, value: any) => any }} ctx
 * @param {{ root?: string, herDir?: string, log?: Function|{warn?: Function} }} [opts]
 * @returns {{ core: object, registry: object, dispose: () => void }}
 */
export function provideFishCore(ctx, { root, herDir, log } = {}) {
  const baseRoot = root || paths().root
  const homeDir = herDir || join(baseRoot, 'home')

  const warn = asWarn(log)
  const registry = createSurfaceRegistry({ log: warn ? { warn } : undefined })

  // 她的屋子会话 id。reserve() 的预分配表已经优先命中，这里再留一份是因为
  // 宿主在 create 期间就会触发 agent/created——那一刻预分配可能还没登记完。
  let homeSessionId = ''

  function noteHome(id) {
    homeSessionId = String(id ?? '')
  }

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

    // web：屋子会话（id 或 cwd 命中），或 cwd 就是她的房间。
    // 空 id 一定要挡住——`'' === ''` 会把「不知道是谁」默认成 web。
    registry.register({
      id: 'web',
      match: ({ id, cwd }) =>
        (homeSessionId !== '' && id === homeSessionId) || (homeDir !== '' && cwd === homeDir),
    }),
  ]

  // 让调用方能提前登记屋子会话（bootstrapHome 建完会话后调）。
  registry.noteHome = noteHome

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
