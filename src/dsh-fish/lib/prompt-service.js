/**
 * prompt-service.js —— `fishCore.prompt`（A1.6）
 *
 * 把 identity / wakewin / turnend 这几个内部实现收成一个窄接口，
 * dsh-bili 这类插件只能通过这里读写「此刻的处境」和挂自己的提示段。
 *
 * 设计 §7.4 是绑定契约：
 *   - setWake / clearWake 的参数顺序固定 `(sessionId, text)`——旧内部实现
 *     `identity.setWakeSection(text, sessionId)` 顺序相反，只留内部用；
 *   - wake 段按 session 隔离，clear 一条不碰另一条；
 *   - section 只对匹配面挂，id 必须以 `fish:` 开头；render 抛错只记日志、返回空串。
 */

import {
  setWakeSection,
  clearWakeSection,
  getWakeSection,
  wakeSectionFor,
} from './identity.js'
import { withWake } from './wakewin.js'
import { watchTurnEnd } from './turnend.js'

/**
 * @param {{ ctx?: object, surface?: object, log?: Function }} [opts]
 *   ctx 与 surface 用于 watchTurnEnd / section 的按面挂载；设计 §7.4 只写了
 *   `{root, log}`，但这两件事离不开宿主会话总线与面登记，实现时随调用方注入。
 */
export function createPromptService({ ctx, surface, log } = {}) {
  const disposers = new Set()

  function section({ id, order = 8600, surface: face, render } = {}) {
    const name = String(id ?? '')
    if (!name.startsWith('fish:')) {
      log?.(`[dsh-fish] prompt.section 拒绝：id 必须以 fish: 开头（${name || '空'}）`)
      return () => {}
    }
    if (typeof render !== 'function') {
      log?.(`[dsh-fish] prompt.section 拒绝：${name} 没有 render`)
      return () => {}
    }

    const onCreated = ({ agent } = {}) => {
      try {
        if (face && surface?.current?.(agent) !== face) return
        const sp = agent?.ctx?.systemPrompt
        if (!sp || typeof sp.section !== 'function') return
        sp.section({
          name,
          order,
          text: () => {
            try {
              return String(render(agent) ?? '')
            } catch (err) {
              log?.(`[dsh-fish] 提示段 ${name} 渲染失败：${String(err?.message ?? err).slice(0, 160)}`)
              return ''
            }
          },
        })
      } catch (err) {
        log?.(`[dsh-fish] 提示段 ${name} 没挂上：${String(err?.message ?? err).slice(0, 160)}`)
      }
    }

    const off = ctx?.on?.('agent/created', onCreated)
    const dispose = () => {
      try { off?.() } catch { /* ignore */ }
      disposers.delete(dispose)
    }
    disposers.add(dispose)
    return dispose
  }

  return {
    setWake(sessionId, text) { setWakeSection(text, sessionId) },
    clearWake(sessionId) { clearWakeSection(sessionId) },
    getWake(sessionId) { return getWakeSection(sessionId) },
    wakeSectionFor(agent) { return wakeSectionFor(agent) },
    withWake(fn) { return withWake(fn) },
    watchTurnEnd(sessionId, fn) { return watchTurnEnd(ctx, sessionId, fn) },
    section,
    dispose() {
      for (const d of [...disposers]) d()
    },
  }
}
