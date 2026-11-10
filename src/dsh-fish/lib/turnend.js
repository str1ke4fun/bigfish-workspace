/**
 * turnend.js —— 等某条会话的一轮结束
 *
 * 宿主在把消息排进队列时就 resolve 了 `sessionController.prompt()`，不等模型想完。
 * 要判断「她这一轮真的结束了」，只能听 `session/event` 的 `turn/end`。
 *
 * 抽出来是因为 home 唤醒和 B 站出门唤醒都要用同一套判定，别写两份。
 */

/**
 * @param {object} ctx
 * @param {string} sessionId
 * @param {Function} done
 * @returns {{ off: () => void }}
 */
export function watchTurnEnd(ctx, sessionId, done) {
  const off = ctx.on?.('session/event', (session, event) => {
    const id = session?.header?.id ?? session?.id
    if (id !== sessionId) return
    if (event?.type !== 'turn/end') return
    try { off?.() } catch { /* ignore */ }
    try { done?.() } catch { /* ignore */ }
  })
  return { off: () => { try { off?.() } catch { /* ignore */ } } }
}
