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

const isOnebot = (exec) => String(exec?.agent?.session?.id ?? '').startsWith('onebot-')

/**
 * @param {object} ctx
 * @param {{getWx?:()=>object, log?:(msg:string, err?:unknown)=>void}} [opts]
 * @returns {() => void} 注销函数
 */
export function registerInbox(ctx, { getWx, log } = {}) {
  const wx = () => {
    try {
      return getWx ? getWx() : ctx.get?.('wx')
    } catch {
      return null
    }
  }

  const off = ctx.tools.register({
    name: 'her_inbox',
    description: '看微信里还没回完的任务：会话名、谁在等、等了多久、最后一句、状态和 taskId。只在微信通道里可用；没有任务时如实说没有。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, out) => [{ type: 'text', text: String(out?.text ?? '') }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      if (isOnebot(exec)) throw new Error('微信任务只能在微信通道里看。')
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
  })
  return typeof off === 'function' ? off : () => {}
}
