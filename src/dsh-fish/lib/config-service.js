/**
 * config-service.js —— `fishCore.config`（A1.7）
 *
 * 设计 §7.5：读取、按 bili 命名空间写入、订阅变更。
 * 三条硬边界：
 *   - `persona` 永不在白名单里——人格不是我该替她改的东西；
 *   - 未知键整次拒绝，不做"先存下再说"：写错的旋钮名字混进 config.json，
 *     下次读配置时会被 fillDefaults 原样保留，等于永远没人读的幽灵配置；
 *   - 归一与夹值只走 settings.normalizeConfig，界面和插件看到的必须是同一份。
 *
 * 写入串行化：两次并发 patch 各自 load→merge→write 会丢掉其中一次，
 * 所以这里排一个 Promise 链，后一次等前一次落盘再读。
 */

import { DEFAULTS, CONFIG_PATCH_KEYS, loadConfig, updateConfig } from './settings.js'

/** config.patch 能用的 bili 视图键；顶层键见 settings.CONFIG_PATCH_KEYS。 */
export const BILI_VIEW_KEYS = ['browse', 'video', 'comment', 'avoid']

/**
 * @param {{ root?: string, log?: Function }} [opts]
 */
export function createConfigService({ root, log } = {}) {
  const listeners = new Set()
  let chain = Promise.resolve()

  async function get() {
    try {
      const { config } = await loadConfig(root)
      return config ?? { ...DEFAULTS }
    } catch {
      return { ...DEFAULTS }
    }
  }

  async function getView(name) {
    if (name !== 'bili') return null
    const cfg = await get()
    return { browse: cfg.browse, video: cfg.video, comment: cfg.comment, avoid: cfg.avoid }
  }

  /** 把 `{ bili: {...} }` 摊平成顶层键；任何不认识的键整次拒绝。 */
  function plan(input) {
    const mapped = {}
    for (const [key, value] of Object.entries(input)) {
      if (key === 'persona') return { ok: false, why: 'PERSONA_READONLY' }
      if (key === 'bili') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, why: 'UNKNOWN_KEY' }
        for (const [bk, bv] of Object.entries(value)) {
          if (!BILI_VIEW_KEYS.includes(bk)) return { ok: false, why: 'UNKNOWN_KEY' }
          mapped[bk] = bv
        }
        continue
      }
      if (!CONFIG_PATCH_KEYS.includes(key)) return { ok: false, why: 'UNKNOWN_KEY' }
      mapped[key] = value
    }
    return { ok: true, mapped }
  }

  async function patch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, why: 'BAD_PATCH' }
    }
    const planned = plan(input)
    if (!planned.ok) return planned

    const changedKeys = Object.keys(planned.mapped)
    const run = chain.then(() => updateConfig(planned.mapped, root))
    chain = run.catch(() => {})
    let config
    try {
      config = await run
    } catch (err) {
      log?.(`[dsh-fish] config.patch 没写进去：${String(err?.message ?? err).slice(0, 200)}`)
      return { ok: false, why: 'WRITE_FAILED' }
    }

    const event = { config, changedKeys }
    for (const fn of [...listeners]) {
      try {
        fn(event)
      } catch (err) {
        log?.(`[dsh-fish] config.onChange 回调抛错：${String(err?.message ?? err).slice(0, 160)}`)
      }
    }
    return { ok: true, config, changedKeys }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') return () => {}
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return { get, getView, patch, onChange }
}
