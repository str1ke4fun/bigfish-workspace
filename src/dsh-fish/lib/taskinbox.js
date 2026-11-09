/**
 * taskinbox.js —— 看「微信里还有什么没回完」
 *
 * 任务板在 dsh-wx 那边（~/.dsh-wx/tasks.jsonl），dsh-fish 不直接读它的文件，
 * 只通过 wx 服务的 inboxSummary 拿摘要。服务不在（没装 dsh-wx / 还没起来）
 * 就如实说看不到，不编。
 *
 * 通道边界：QQ 会话里不给看。微信任务里可能有私聊内容，不能顺手带到别的通道。
 *
 * 注意：这里不是 `lib/inbox.js`。那个是「她留给人的话」的信箱；
 * 两个都叫 inbox 会混，所以文件名带上 task。
 */

import { registerTool, ToolError } from './tool-result.js'

const isOnebot = (exec) => String(exec?.agent?.session?.id ?? '').startsWith('onebot-')

/**
 * @param {object} ctx
 * @param {{getWx?:()=>object, log?:(msg:string, err?:unknown)=>void, core?:object}} [opts]
 * @returns {() => void} 注销函数
 */
export function registerInbox(ctx, { getWx, log, core } = {}) {
  const wx = () => {
    try {
      return getWx ? getWx() : ctx.get?.('wx')
    } catch {
      return null
    }
  }

  const off = registerTool(ctx, {
    name: 'her_inbox',
    description: '看微信里还没回完的任务：会话名、谁在等、等了多久、最后一句、状态和 taskId。只在微信通道里可用；没有任务时如实说没有。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    // 模型投影：有任务就给一句状态 + 摘要；没有就说没有，不编。
    project: (out) => {
      const text = String(out?.text ?? '').trim()
      if (!text || text.includes('没有要回')) return { text: '[没有要回的]' }
      if (text.includes('看不到') || text.includes('读不出来')) return { text: `[没看到] ${text}` }
      return { text: `[待回] ${text}` }
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      // 用 ToolError：包装器只会透传它的 message，普通 Error 会被换成通用兜底话。
      if (isOnebot(exec)) throw new ToolError('WX_CHANNEL_ONLY', '微信任务只能在微信通道里看。')
      const w = wx()
      if (!w?.inboxSummary) {
        log?.('her_inbox：wx 服务没接上')
        return { text: '微信任务板没接上，现在看不到待回的消息。' }
      }
      let text = ''
      try {
        text = String(w.inboxSummary({ max: 10 }) ?? '').trim()
      } catch (err) {
        log?.('her_inbox：读任务摘要失败', err)
        return { text: '任务摘要读不出来，现在看不到待回的消息。' }
      }
      return { text: text || '现在没有要回的微信消息。' }
    },
  }, { core })
  return typeof off === 'function' ? off : () => {}
}
