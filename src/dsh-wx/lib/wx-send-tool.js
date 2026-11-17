import { projectWxSend, resolveWxSendTask } from './project.js'
import { wxFailure } from './tool-error.js'

const BINDING_FAILURE_TEXT = {
  WX_CHAT_AMBIGUOUS: '[这个名字对不上是哪一个会话，先别发]',
}

function unresolvedWarning(sent) {
  if (sent === 'confirmed') return '[发出去了，但没认出是哪一个会话；这句没记到待回里。别再重发。]'
  if (sent === 'preview') return '[还没确认发出去，也没认出是哪一个会话；这句没记到待回里。先看清再说。]'
  return '[没看见落下去，也没认出是哪一个会话；这句没记到待回里。先别重发。]'
}

/**
 * wx_send 工具注册与执行共用的窄编排层。
 * 请求名原样交给策略与许可；规范名只用于导航和任务绑定。
 */
export async function runWxSendTool({
  args = {},
  exec = null,
  getPolicy,
  directory,
  board,
  sendToChat,
  recordReply,
  deny = () => {},
} = {}) {
  deny(exec)
  const policy = getPolicy()
  if (!policy?.enabled) return wxFailure('WX_DISABLED', '[微信现在没开]')

  const binding = resolveWxSendTask({
    chat: args.chat,
    taskId: args.task_id,
    directory,
    board,
    implicitTaskBinding: policy.implicitTaskBinding !== false,
  })
  if (!binding.ok) {
    return wxFailure(binding.code, BINDING_FAILURE_TEXT[binding.code] || '[没做成，过会儿再试]')
  }

  const task = binding.task
  const taskId = task?.taskId ?? ''
  const result = await sendToChat({
    chat: binding.requestedChat,
    targetChat: binding.targetChat,
    targetChatId: binding.chatId,
    text: args.text,
    permit: String(args.permit ?? '').trim(),
    taskId,
    replyTask: task
      ? (outMsgId) => recordReply({ taskId, msgId: outMsgId })
      : null,
  }) || {}
  if (result.ok === false) {
    return wxFailure(result.code, result.message, result.detail)
  }
  if (result.ok !== true) return wxFailure('WX_SEND_FAILED', '[没做成，过会儿再试]')

  const booking = result.booking?.status ?? (task ? 'unknown' : 'no-task')
  const recorded = result.booking?.recorded === true
  const warnings = []
  if (binding.status === 'unresolved') {
    warnings.push(unresolvedWarning(result.sent))
  } else if (result.sent === 'confirmed' && task && booking === 'not-recorded') {
    warnings.push('[发出去了，但没记到待回里。别再发一遍。]')
  }

  const text = [projectWxSend({ chat: binding.requestedChat, sent: result.sent }), ...warnings].join('\n')
  return {
    ...result,
    ok: true,
    text,
    outcome: {
      source: binding.source,
      status: binding.status,
      requestedChat: binding.requestedChat,
      targetChat: binding.targetChat,
      chatId: binding.chatId,
      taskId,
      sent: result.sent,
      booking,
      recorded,
      warnings,
      retry: binding.status === 'unresolved' ? 'correct-chat-name' : (booking === 'not-recorded' ? 'do-not-resend' : ''),
    },
  }
}

/** 生成真正注册到宿主上的 execute；onOutcome 只给测试观察结构化结果。 */
export function createWxSendTool(options = {}) {
  return {
    execute: async (args, exec) => {
      const result = await runWxSendTool({ ...options, args: args || {}, exec })
      options.onOutcome?.(result.outcome)
      return result
    },
  }
}
