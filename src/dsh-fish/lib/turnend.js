/**
 * turnend.js —— 等某条会话的一轮结束
 *
 * 宿主在把消息排进队列时就 resolve 了 `sessionController.prompt()`，不等模型想完。
 * 要判断「她这一轮真的结束了」，只能听 `session/event` 的 `turn/end`。
 *
 * 抽出来是因为 home 唤醒和 B 站出门唤醒都要用同一套判定，别写两份。
 */

/**
 * 从宿主事件里取她这一轮真正说出口的文本。
 *
 * 只认 `assistant/message` 的 `text` block：reasoning 是她没打算说出口的草稿，
 * tool-call 是动作，都不是“对他说话”。宿主把一轮拆成多个 step，文本会分几条
 * 送来，这里按到达顺序拼起来。
 *
 * @param {object} event 宿主的 session/event
 * @returns {string} 没有文本时返回空串
 */
export function assistantTextOf(event) {
  if (event?.type !== 'assistant/message') return ''
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim())
    .map((b) => b.text.trim())
    .join('\n')
}

/**
 * 等这一轮结束，同时收下她自然说出口的话。
 *
 * 和 `watchTurnEnd` 的区别只有一个：这里不要求她调用任何工具。陪玩/对话里她
 * 直接说的那句，本来就不是工具结果；把它丢掉会变成“她说了，但我们没听见”。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {{ onText?: (text: string) => void, onEnd?: (text: string) => void }} [handlers]
 * @returns {{ off: () => void, text: () => string }}
 */
export function watchTurn(ctx, sessionId, { onText, onEnd } = {}) {
  let text = ''
  const off = ctx.on?.('session/event', (session, event) => {
    const id = session?.header?.id ?? session?.id
    if (id !== sessionId) return
    const fresh = assistantTextOf(event)
    if (fresh) {
      text = text ? `${text}\n${fresh}` : fresh
      try { onText?.(fresh) } catch { /* ignore */ }
    }
    if (event?.type !== 'turn/end') return
    try { off?.() } catch { /* ignore */ }
    try { onEnd?.(text) } catch { /* ignore */ }
  })
  return {
    off: () => { try { off?.() } catch { /* ignore */ } },
    text: () => text,
  }
}

/**
 * @param {object} ctx
 * @param {string} sessionId
 * @param {Function} done
 * @returns {{ off: () => void }}
 */
export function watchTurnEnd(ctx, sessionId, done) {
  const w = watchTurn(ctx, sessionId, { onEnd: () => done?.() })
  return { off: w.off }
}
