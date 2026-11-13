/**
 * presence-speak.js —— 陪伴面唯一的输出工具 `presence_speak`
 *
 * 陪你看屏幕的小会话能看图、能翻旧事，但**只能通过这一个工具说一句**：
 *   - 只允许 screen 面。cwd/reserve 判出来的面不是 screen 就直接拒绝；
 *   - 空话、超过 120 字、冷却中/超小时上限，一律拒绝，不写台账；
 *   - 真正的落盘在 `screen.recordComment()`（presence/YYYY-MM-DD.jsonl），
 *     这里不碰 events.jsonl，也不把屏幕上的文字带进事件流。
 *
 * 工具说明只说“值得说才说”，不复述屏幕文字——她读到的图里写了什么，
 * 不该被这段说明二次确认成“可以照着念”。
 */

import { defineTool } from './tool.js'
import { registerTool } from './tool-result.js'
import { toJsonSchema } from './toolschema.js'

/** 一句话的上限（字符数）。 */
export const PRESENCE_TEXT_LIMIT = 120

/** 当前候选帧对应的事件；screen 服务没提供时按 null 记。 */
function currentEventOf(screen) {
  try {
    if (typeof screen?.currentEvent === 'function') return screen.currentEvent() ?? null
    const status = screen?.status?.()
    return status?.lastEvent ?? null
  } catch {
    return null
  }
}

/**
 * 注册 `presence_speak`。
 *
 * @param {object} ctx
 * @param {{
 *   root?: string,
 *   core?: object,
 *   screen?: object,
 *   log?: Function,
 * }} [deps]
 *   `root` 预留给台账路径（台账由 screen 服务持有）；`core.surface.current(agent)`
 *   决定这条会话是不是 screen 面。
 */
export function registerPresenceSpeak(ctx, { root, core, screen, log } = {}) {
  void root // 台账由 screen 服务统一写，工具本身不需要 root

  return registerTool(ctx, defineTool({
    name: 'presence_speak',
    description:
      '你在陪他看屏幕。只有真的觉得这一刻值得说，才用这个工具说一句；不想说就不要调用。' +
      '说场景和感受就好，不要复述屏幕上的具体文字、账号或聊天内容。',
    parameters: toJsonSchema({
      text: { type: 'string', required: true, description: '一句话，120 字以内。不要复述屏幕上的文字。' },
    }),
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        additionalProperties: true,
      },
    },
    project: (out) => ({ text: out?.ok ? '[说下了]' : `[没说：${out?.message ?? ''}]` }),
    async execute(args, exec) {
      const surface = core?.surface?.current?.(exec?.agent)
      if (surface !== 'screen') {
        return { ok: false, code: 'NOT_SCREEN', message: '这里不是说这个的地方。' }
      }

      const text = String(args?.text ?? '').trim()
      if (!text) return { ok: false, code: 'EMPTY', message: '没说话。' }
      if (text.length > PRESENCE_TEXT_LIMIT) {
        return { ok: false, code: 'TOO_LONG', message: '太长，短一点。' }
      }

      const gate = screen?.canSpeak?.()
      if (gate && gate.ok === false) {
        return { ok: false, code: 'PRESENCE_COOLDOWN', message: '现在先别说。' }
      }

      if (typeof screen?.recordComment !== 'function') {
        log?.('[dsh-fish] presence_speak 没记下来：screen 服务没有 recordComment')
        return { ok: false, code: 'PRESENCE_WRITE_FAILED', message: '没记下来。' }
      }

      let result = null
      try {
        result = await screen.recordComment({
          text,
          at: new Date().toISOString(),
          mode: screen?.currentMode?.() ?? null,
          event: currentEventOf(screen),
        })
      } catch (err) {
        log?.(`[dsh-fish] presence_speak 没记下来：${String(err?.message ?? err).slice(0, 160)}`)
        return { ok: false, code: 'PRESENCE_WRITE_FAILED', message: '没记下来。' }
      }

      return result?.ok
        ? { ok: true }
        : { ok: false, code: 'PRESENCE_WRITE_FAILED', message: '没记下来。' }
    },
  }))
}
