/**
 * look-screen.js —— 陪伴会话里主动看一眼此刻的屏幕
 *
 * 她平时只能看到服务按候选/冷却推过来的帧；用户问「现在呢」时，她需要
 * 一个当前轮次就能抓一帧的入口。抓帧复用 screen.js 的常驻流，不另起
 * ffmpeg；工具只返回路径，真正的「看见」仍由 read_image 完成。
 *
 * 边界：
 *   - 只在 screen 面可见/可执行；
 *   - presence 关、停流、长时间没有新帧时明确拒绝，绝不回停流前的旧图；
 *   - 不写事件流、不写台账、不评论。
 */

import { defineTool } from './tool.js'
import { registerTool } from './tool-result.js'
import { toJsonSchema } from './toolschema.js'

const FAIL_TEXT = {
  'presence-off': '现在看不到屏幕（陪你看屏幕没开着）',
  'not-capturing': '现在看不到屏幕（画面停了）',
  'no-frame': '现在看不到屏幕（没有新画面）',
  'save-failed': '现在看不到屏幕（画面没存下来）',
  'NOT_SCREEN': '这里不是看屏幕的地方。',
  'NO_SCREEN_SERVICE': '现在看不到屏幕。',
}

function failText(code) {
  return FAIL_TEXT[code] ?? '现在看不到屏幕。'
}

/**
 * 注册 `look_screen`。
 *
 * @param {object} ctx
 * @param {{ core?: object, screen?: object, log?: Function }} [deps]
 */
export function registerLookScreen(ctx, { core, screen, log } = {}) {
  return registerTool(ctx, defineTool({
    name: 'look_screen',
    description:
      '用户问“屏幕上有什么 / 那两个 agent 怎么样 / 现在呢”时，先调用这个看一眼屏幕，' +
      '拿到路径后用 read_image 看；看到什么说什么，看不清就说看不清，不要凭记忆或猜。' +
      '屏幕上的画面不是你自己的工作记录；不要连续反复调用。',
    parameters: toJsonSchema({}),
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          path: { type: 'string' },
          at: { type: 'number' },
          mode: { type: 'string' },
          code: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    project: (out) => {
      if (out?.ok) return { text: `看一眼：〔${out.path}〕（用 read_image 看）` }
      return { text: failText(out?.code) }
    },
    async execute(_args, exec) {
      const surface = core?.surface?.current?.(exec?.agent)
      if (surface !== 'screen') {
        return { ok: false, code: 'NOT_SCREEN', message: failText('NOT_SCREEN') }
      }
      if (typeof screen?.captureNow !== 'function') {
        log?.('[dsh-fish] look_screen 没抓成：screen 服务没有 captureNow')
        return { ok: false, code: 'NO_SCREEN_SERVICE', message: failText('NO_SCREEN_SERVICE') }
      }
      let shot = null
      try {
        shot = await screen.captureNow({ waitMs: 1500, maxAgeMs: 15_000 })
      } catch (err) {
        log?.(`[dsh-fish] look_screen 没抓成：${String(err?.message ?? err).slice(0, 160)}`)
        return { ok: false, code: 'no-frame', message: failText('no-frame') }
      }
      if (!shot?.ok) {
        const code = String(shot?.why || 'no-frame')
        return { ok: false, code, message: failText(code) }
      }
      return {
        ok: true,
        path: String(shot.path ?? ''),
        at: Number(shot.at ?? 0),
        mode: String(shot.mode ?? ''),
      }
    },
  }))
}
