/**
 * work-backend.js —— DelegationBackend 的 v1 subagent 适配器
 *
 * 上层只认这里，不直接碰 `ctx.subagents` 的细节。v1 只有一个后端：
 * 宿主进程内 spawn 的 durable 子会话。P3 的工作头子不走这个适配器
 * （Team 工具由工作头子自己调用），所以这里不实现 team。
 *
 * 关键契约：
 *   - spawn 返回 childId + 结算 Promise + dispose；
 *   - 结算结果只在这里收口：stopReason / closing text / structured；
 *   - 没有 subagents 服务或没有 spawn provider 时 fail closed。
 */

function textOf(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  const parts = []
  for (const block of output) {
    if (typeof block === 'string') parts.push(block)
    else if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function whyOf(err) {
  return String(err?.message ?? err ?? '').slice(0, 240)
}

function codeOf(err, fallback) {
  const code = err?.code
  return typeof code === 'string' && code ? code : fallback
}

function readService(getService) {
  try {
    return getService?.() ?? null
  } catch {
    return null
  }
}

/**
 * @param {{ getService: () => any, log?: Function }} opts
 *   getService 每次现取 `ctx.get('subagents')`，插件启动时服务可能还没挂上。
 */
export function createSubagentBackend({ getService, log } = {}) {
  const capabilities = Object.freeze({
    structuredOutput: true,
    peerMessaging: true,
    taskBoard: false,
    maxConcurrent: 2,
  })

  function available() {
    const service = readService(getService)
    if (!service || typeof service.startActivation !== 'function') return false
    try {
      return Array.isArray(service.list?.()) && service.list().includes('spawn')
    } catch {
      return false
    }
  }

  async function spawn({ parent, dir, preset, prompt, outputSchema, label = '', signal } = {}) {
    const service = readService(getService)
    if (!service || typeof service.startActivation !== 'function') {
      return { ok: false, code: 'NO_SUBAGENTS', why: '这台机器不支持派活' }
    }
    if (!available()) {
      return { ok: false, code: 'NO_SUBAGENTS', why: '这台机器不支持派活' }
    }
    if (!parent || typeof parent !== 'object') {
      return { ok: false, code: 'BAD_PARENT', why: '找不到工头会话' }
    }
    if (!dir || typeof dir !== 'string') {
      return { ok: false, code: 'BAD_DIR', why: '没有工作目录' }
    }

    const request = {
      parent,
      cwd: dir,
      agentPreset: preset,
      prompt: [{ type: 'text', text: String(prompt ?? '') }],
      maxDepth: 1,
    }
    if (outputSchema !== undefined && outputSchema !== null) request.outputSchema = outputSchema

    try {
      const started = await service.startActivation({
        provider: 'spawn',
        label: String(label ?? ''),
        delivery: 'parent',
        signal: signal ?? new AbortController().signal,
        request,
      })
      const childId = String(started?.childId ?? '')
      if (!childId) return { ok: false, code: 'NO_CHILD_ID', why: '宿主没有给出 worker 的 id' }
      return {
        ok: true,
        childId,
        result: started.result,
        dispose: started.dispose,
      }
    } catch (err) {
      log?.(`[dsh-fish] worker 启动失败：${whyOf(err)}`)
      return { ok: false, code: codeOf(err, 'START_FAILED'), why: whyOf(err) }
    }
  }

  async function message({ sender, childId, text, signal } = {}) {
    const service = readService(getService)
    if (!service || typeof service.sendMessage !== 'function') {
      return { ok: false, code: 'NO_SUBAGENTS', why: '这台机器不支持派活' }
    }
    try {
      const messageId = await service.sendMessage(
        sender,
        childId,
        [{ type: 'text', text: String(text ?? '') }],
        { signal: signal ?? new AbortController().signal },
      )
      return { ok: true, messageId: String(messageId ?? '') }
    } catch (err) {
      return { ok: false, code: codeOf(err, 'MESSAGE_FAILED'), why: whyOf(err) }
    }
  }

  async function interrupt({ sender, childId } = {}) {
    const service = readService(getService)
    if (!service || typeof service.interrupt !== 'function') {
      return { ok: false, code: 'NO_SUBAGENTS', why: '这台机器不支持派活' }
    }
    try {
      service.interrupt(childId, { kind: 'ancestor', agent: sender })
      return { ok: true, accepted: true }
    } catch (err) {
      return { ok: false, code: codeOf(err, 'INTERRUPT_FAILED'), why: whyOf(err) }
    }
  }

  /**
   * 结算监听。返回取消函数；v1 的 result 是 Promise，取消只表示不再回调。
   */
  function onSettle(resultPromise, cb) {
    let active = true
    const done = (result) => {
      if (active) cb(result)
      active = false
    }
    Promise.resolve(resultPromise).then(
      (result) => done({
        stopReason: String(result?.stopReason ?? 'unknown'),
        closingText: textOf(result?.output),
        structured: result?.structured ?? null,
        diagnostic: result?.diagnostic ? String(result.diagnostic) : '',
      }),
      (err) => done({
        stopReason: 'error',
        closingText: '',
        structured: null,
        diagnostic: whyOf(err),
      }),
    )
    return () => { active = false }
  }

  return { name: 'subagent', capabilities, available, spawn, message, interrupt, onSettle }
}
