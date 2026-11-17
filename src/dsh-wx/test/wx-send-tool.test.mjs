import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createDirectory } from '../lib/directory.js'
import { createTaskBoard } from '../lib/tasks.js'
import { applyWxSendBookkeeping } from '../lib/project.js'
import { canSendWithPolicy, createPermitStore } from '../lib/reminder.js'
import { createSendGate } from '../lib/send-gate.js'
import { allowedCurrent, sameName } from '../lib/tree.js'
import { parseWxToolError } from '../lib/tool-error.js'
import { createWxSendTool } from '../lib/wx-send-tool.js'

const T = Date.UTC(2026, 10, 3, 4, 0, 0)
const temp = (name) => join(mkdtempSync(join(tmpdir(), 'dsh-wx-send-tool-')), name)
const iso = (minute = 0) => new Date(T + minute * 60_000).toISOString()

function seededDirectory(chats) {
  const file = temp('directory.json')
  writeFileSync(file, JSON.stringify({ version: 1, chats }, null, 2), 'utf8')
  return createDirectory({ file, now: () => T, log: () => {} })
}

function task(board, chatId, chatName, msgId) {
  return board.create({ chatId, chatName, inboundMsgId: msgId, text: '在吗', at: iso() }).task
}

test('旧别名在允许名单里时，发送闸按规范当前会话放行', async () => {
  const sendPolicy = {
    enabled: true,
    allowChats: ['旧群名'],
    noMentionChats: [],
    requireMention: true,
    mentionWindowMinutes: 3,
    proactivePerDay: 0,
    proactiveChats: {},
  }
  let mentionChat = ''
  const gate = createSendGate({
    policy: () => sendPolicy,
    hostBlocksSend: () => false,
    look: async () => ({ parsed: { ok: true, current: '新群名', chats: [], messages: [] } }),
    isStale: () => false,
    staleDetail: () => '',
    allowedCurrent,
    sameName,
    canSpeak: (_mentions, chat) => { mentionChat = chat; return { ok: true } },
    readMentions: () => ({}),
    loadState: () => ({ day: '2026-11-03', used: {} }),
    decideProactive: () => ({ ok: true, proactive: false, left: 0 }),
    consumeProactive: () => ({ state: {}, left: 0 }),
    saveState: () => true,
    logInbound: () => {},
    now: () => T,
  })
  const result = await gate({ target: { chat: '旧群名', canonicalChat: '新群名' } })
  assert.equal(result.chat, '旧群名')
  assert.equal(mentionChat, '新群名')
})

test('wx_send 工具级集成：绑定、别名回滚、回执与三个确认态', async () => {
  const at = iso()
  const directory = seededDirectory([
    { chatId: 'c_exact', displayName: '群甲', fullName: '群甲', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    {
      chatId: 'c_resolved', displayName: '星晓家园10号楼1301', fullName: '星晓家园10号楼1301',
      aliases: ['星晓家园10号楼13...'], nameConfidence: 'resolved', firstSeenAt: at,
    },
    { chatId: 'c_amb_a', displayName: '撞名群', fullName: '撞名群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    { chatId: 'c_amb_b', displayName: '撞名群', fullName: '撞名群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    {
      chatId: 'c_renamed', displayName: '新群名', fullName: '新群名',
      aliases: ['旧群名'], nameConfidence: 'exact', firstSeenAt: at,
    },
    {
      chatId: 'c_rollback', displayName: '回滚新名', fullName: '回滚新名',
      aliases: ['回滚旧名'], nameConfidence: 'exact', firstSeenAt: at,
    },
    { chatId: 'c_disabled', displayName: '关闭绑定', fullName: '关闭绑定', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    { chatId: 'c_none', displayName: '没任务群', fullName: '没任务群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    { chatId: 'c_confirmed', displayName: '确认群', fullName: '确认群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    { chatId: 'c_preview', displayName: '预览群', fullName: '预览群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
    { chatId: 'c_unconfirmed', displayName: '没看见群', fullName: '没看见群', aliases: [], nameConfidence: 'exact', firstSeenAt: at },
  ])
  const board = createTaskBoard({ file: temp('tasks.jsonl'), now: () => T, log: () => {} })
  const exactTask = task(board, 'c_exact', '群甲', 'm_exact')
  const resolvedTask = task(board, 'c_resolved', '星晓家园10号楼1301', 'm_resolved')
  const renamedTask = task(board, 'c_renamed', '新群名', 'm_renamed')
  const disabledTask = task(board, 'c_disabled', '关闭绑定', 'm_disabled')
  const confirmedTask = task(board, 'c_confirmed', '确认群', 'm_confirmed')
  const previewTask = task(board, 'c_preview', '预览群', 'm_preview')
  const unconfirmedTask = task(board, 'c_unconfirmed', '没看见群', 'm_unconfirmed')

  const policy = {
    enabled: true,
    allowChats: [
      '群甲', '星晓家园10号楼13...', '旧群名', '回滚旧名', '关闭绑定',
      '没任务群', '确认群', '预览群', '没看见群', '陌生群',
    ],
    noMentionChats: [],
    implicitTaskBinding: true,
  }
  const permits = createPermitStore({ file: temp('permits.json'), now: () => T, log: () => {} })
  assert.equal(permits.grant({ id: 'permit-old-1', chat: '旧群名', text: '回旧名', dueAt: T + 60_000 }).ok, true)

  const sends = []
  const outcomes = []
  const receipt = {
    回甲: ['confirmed', 'm_out_exact'],
    回截断: ['confirmed', 'm_out_resolved'],
    回旧名: ['confirmed', 'm_out_renamed'],
    回滚旧名: ['confirmed', 'm_out_rollback'],
    回关闭: ['confirmed', 'm_out_disabled'],
    回没任务: ['confirmed', 'm_out_none'],
    回确认: ['confirmed', 'm_out_confirmed'],
    回预览: ['preview', 'm_out_preview'],
    回没看见: ['unconfirmed', 'm_out_unconfirmed'],
    回无记号: ['confirmed', ''],
  }
  const tool = createWxSendTool({
    getPolicy: () => ({ ...policy }),
    directory,
    board,
    deny: () => {},
    recordReply: ({ taskId, msgId }) => board.reply(taskId, { msgId }),
    onOutcome: (outcome) => outcomes.push(outcome),
    sendToChat: async (req) => {
      assert.equal(canSendWithPolicy(policy, req.chat).ok, true, `policy 应接受请求名 ${req.chat}`)
      if (req.permit) {
        assert.equal(permits.check({ id: req.permit, chat: req.chat, text: req.text }).ok, true, '许可应按请求名核对')
      }
      sends.push(req)
      const [sent, msgId] = receipt[req.text] ?? ['confirmed', 'm_out_default']
      const booking = applyWxSendBookkeeping({
        sent,
        chat: req.targetChat,
        text: req.text,
        capture: () => ({ records: msgId ? [{ msgId }] : [] }),
        replyTask: req.replyTask,
      })
      return { ok: true, sent, booking }
    },
  })

  assert.match(await tool.execute({ chat: '群甲', text: '回甲' }, {}), /末尾能看见/)
  assert.equal(board.get(exactTask.taskId).replyCount, 1)
  assert.deepEqual(
    { source: outcomes.at(-1).source, status: outcomes.at(-1).status, booking: outcomes.at(-1).booking },
    { source: 'implicit', status: 'bound', booking: 'recorded' },
  )

  assert.match(await tool.execute({ chat: '星晓家园10号楼13...', text: '回截断' }, {}), /末尾能看见/)
  assert.equal(sends.at(-1).targetChat, '星晓家园10号楼1301')
  assert.equal(board.get(resolvedTask.taskId).replyCount, 1)

  assert.match(await tool.execute({ chat: '旧群名', text: '回旧名', permit: 'permit-old-1' }, {}), /末尾能看见/)
  assert.equal(sends.at(-1).chat, '旧群名', '策略与许可保留请求名')
  assert.equal(sends.at(-1).targetChat, '新群名', '导航使用规范名')
  assert.equal(board.get(renamedTask.taskId).replyCount, 1)

  policy.implicitTaskBinding = false
  assert.match(await tool.execute({ chat: '关闭绑定', text: '回关闭' }, {}), /末尾能看见/)
  assert.equal(sends.at(-1).taskId, '')
  assert.equal(sends.at(-1).replyTask, null)
  assert.equal(board.get(disabledTask.taskId).replyCount, 0)
  assert.deepEqual(
    { source: outcomes.at(-1).source, status: outcomes.at(-1).status },
    { source: 'disabled', status: 'disabled' },
  )
  assert.match(await tool.execute({ chat: '回滚旧名', text: '回滚旧名' }, {}), /末尾能看见/)
  assert.equal(sends.at(-1).chat, '回滚旧名')
  assert.equal(sends.at(-1).targetChat, '回滚旧名', '回滚开关关闭时不改用规范名')
  policy.implicitTaskBinding = true

  const beforeAmbiguous = sends.length
  await assert.rejects(
    () => tool.execute({ chat: '撞名群', text: '别发错' }, {}),
    (error) => parseWxToolError(error.message)?.code === 'WX_CHAT_AMBIGUOUS',
  )
  assert.equal(sends.length, beforeAmbiguous, '歧义会话在发送前失败')

  assert.match(await tool.execute({ chat: '没任务群', text: '回没任务' }, {}), /末尾能看见/)
  assert.deepEqual(
    { source: outcomes.at(-1).source, status: outcomes.at(-1).status, booking: outcomes.at(-1).booking },
    { source: 'none', status: 'no-active-task', booking: 'no-task' },
  )

  assert.match(await tool.execute({ chat: '陌生群', text: '回陌生' }, {}), /没认出是哪一个会话/)
  assert.deepEqual(
    { source: outcomes.at(-1).source, status: outcomes.at(-1).status, booking: outcomes.at(-1).booking },
    { source: 'unresolved', status: 'unresolved', booking: 'no-task' },
  )

  assert.match(await tool.execute({ chat: '确认群', text: '回确认' }, {}), /末尾能看见/)
  assert.equal(board.get(confirmedTask.taskId).replyCount, 1)
  assert.equal(outcomes.at(-1).booking, 'recorded')

  assert.match(await tool.execute({ chat: '预览群', text: '回预览' }, {}), /先别当发出去了/)
  assert.equal(board.get(previewTask.taskId).replyCount, 0)
  assert.equal(outcomes.at(-1).booking, 'not-booked')

  assert.match(await tool.execute({ chat: '没看见群', text: '回没看见' }, {}), /可能出去了，也可能没有/)
  assert.equal(board.get(unconfirmedTask.taskId).replyCount, 0)
  assert.equal(outcomes.at(-1).booking, 'not-booked')

  assert.match(await tool.execute({ chat: '确认群', text: '回无记号' }, {}), /没记到待回里/)
  assert.equal(board.get(confirmedTask.taskId).replyCount, 1, '空 msgId 不产生第二次回复记账')
  assert.equal(outcomes.at(-1).booking, 'not-recorded')
})
