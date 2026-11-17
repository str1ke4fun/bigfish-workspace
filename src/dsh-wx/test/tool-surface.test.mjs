// dsh-wx 工具返回投影：只测纯函数，不启动 GUI、不 import 整个插件。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyWxSendBookkeeping,
  boundedText,
  classifyWxSend,
  clipPeekBody,
  lazyRender,
  projectWxContext,
  projectWxOcr,
  projectWxResult,
  projectWxPeek,
  projectWxSend,
  projectWxStickerCollect,
  projectWxStickerSearch,
  projectWxStickerSend,
  projectWxTaskDone,
  projectWxTaskSnooze,
  resolveWxSendTask,
  shouldBookWxSend,
  shouldNoteWxEcho,
} from '../lib/project.js'
import { formatCards } from '../lib/retrieval.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDirectory } from '../lib/directory.js'
import { createTaskBoard } from '../lib/tasks.js'

const T = Date.UTC(2026, 10, 3, 4, 0, 0)
const tempFile = (name) => join(mkdtempSync(join(tmpdir(), 'dsh-wx-binding-')), name)

function bindingFixture({ chat = '测试群A', directoryFile = '', taskChatId = '' } = {}) {
  const directory = createDirectory({ file: directoryFile || tempFile('directory.json'), now: () => T })
  if (!directoryFile) directory.merge({ chats: [{ name: chat }] })
  const target = directory.sendableTarget(chat)
  const chatId = taskChatId || target?.chatId
  const chatName = target?.chatName || chat
  const board = createTaskBoard({ file: tempFile('tasks.jsonl'), now: () => T })
  const made = board.create({
    chatId, chatName, inboundMsgId: 'm1', text: '在吗', at: new Date(T).toISOString(),
  })
  return { directory, board, task: made.task, target }
}

function objectBodyAfter(source, key) {
  const match = new RegExp(`${key}:\\s*\\{`).exec(source)
  if (!match) return ''
  const start = source.indexOf('{', match.index)
  let depth = 0
  let quote = ''
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{') depth++
    if (ch === '}' && --depth === 0) return source.slice(start + 1, i)
  }
  return ''
}

function topLevelKeys(body) {
  const keys = []
  let depth = 0
  let quote = ''
  let start = 0
  const consider = (part) => {
    const match = part.match(/^\s*([A-Za-z_$][\w$]*)\s*:/)
    if (match) keys.push(match[1])
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      consider(body.slice(start, i))
      start = i + 1
    }
  }
  consider(body.slice(start))
  return keys
}

test('wx_send / wx_type 的 confirmed、preview、unconfirmed 是三句不同世界声', () => {
  assert.equal(classifyWxSend({ inMsgs: true, inPreview: true }), 'confirmed')
  assert.equal(classifyWxSend({ inMsgs: false, inPreview: true }), 'preview')
  assert.equal(classifyWxSend({ inMsgs: false, inPreview: false }), 'unconfirmed')

  assert.equal(projectWxSend({ chat: '晚上吃什么', sent: 'confirmed' }), '[发到「晚上吃什么」了，末尾能看见]')
  assert.equal(projectWxSend({ chat: '晚上吃什么', sent: 'preview' }), '[按下去了，末尾还没看见，先别当发出去了]')
  assert.equal(projectWxSend({ chat: '晚上吃什么', sent: 'unconfirmed' }), '[按下去了，没看见落下去。可能出去了，也可能没有]')
  for (const text of [
    projectWxSend({ chat: '晚上吃什么', sent: 'confirmed' }),
    projectWxSend({ chat: '晚上吃什么', sent: 'preview' }),
    projectWxSend({ chat: '晚上吃什么', sent: 'unconfirmed' }),
  ]) {
    assert.doesNotMatch(text, /字|额度|taskId|task_id|回执|t_|消息已出现/)
  }
})

test('信封投影失败只给 message，成功只读 text，不把审计字段带进上下文', () => {
  assert.equal(projectWxResult({ ok: false, code: 'WX_DISABLED', message: '[微信现在没开]', detail: 'policy=false' }), '[微信现在没开]')
  assert.equal(projectWxResult({ ok: true, text: '[看到] 一句话', raw: 'audit-only' }), '[看到] 一句话')
  assert.equal(projectWxPeek({ ok: false, code: 'WX_TREE_STALE', message: '[没看清。屏幕可能慢半拍]' }), '[没看清。屏幕可能慢半拍]')
  assert.equal(projectWxOcr({ ok: false, code: 'WX_DISABLED', message: '[微信现在没开]' }), '[微信现在没开]')
})

test('表情结果投影先看 ok，成功文案仍不暴露确认或标识细节', () => {
  assert.equal(projectWxStickerSend({ ok: false, code: 'WX_STICKER_SEND_FAILED', message: '[表情没发出去]' }), '[表情没发出去]')
  assert.equal(projectWxStickerSend({ ok: true, confirmed: true, chat: '测试群A', outMsgId: 'm1' }), '[表情发到「测试群A」了，末尾看见了]')
  assert.equal(projectWxStickerSend({ ok: true, confirmed: false, chat: '测试群A' }), '[点下去了，没看见落下去。先看看现在停在哪儿，别急着再点]')
  assert.equal(projectWxStickerCollect({ ok: true, confirmed: true, chat: '测试群A' }), '[收进收藏了]')
  assert.equal(projectWxStickerSearch({ ok: false, code: 'WX_STICKER_SEARCH_FAILED', message: '[没找到]' }), '[没找到]')
  assert.equal(projectWxStickerSearch({ ok: true, confirmed: false, chat: '测试群A' }), '[点下去了，没看见落下去]')
})

test('预览发送写回声凭据，但不写历史也不记任务回复', () => {
  assert.equal(shouldNoteWxEcho('confirmed'), true)
  assert.equal(shouldNoteWxEcho('preview'), true)
  assert.equal(shouldNoteWxEcho('unconfirmed'), false)
  assert.equal(shouldBookWxSend('confirmed'), true)
  assert.equal(shouldBookWxSend('preview'), false)
  assert.equal(shouldBookWxSend('unconfirmed'), false)
  assert.equal(shouldBookWxSend('anything-else'), false)

  const calls = []
  const preview = applyWxSendBookkeeping({
    sent: 'preview',
    chat: '测试群A',
    text: '晚上见',
    noteOutbox: (...args) => calls.push(['outbox', ...args]),
    capture: () => calls.push(['history']),
    replyTask: () => calls.push(['task-reply']),
  })
  assert.deepEqual(calls, [['outbox', '测试群A', '晚上见']])
  assert.equal(preview.outMsgId, '')

  calls.length = 0
  const confirmed = applyWxSendBookkeeping({
    sent: 'confirmed',
    chat: '测试群A',
    text: '晚上见',
    noteOutbox: (...args) => calls.push(['outbox', ...args]),
    capture: () => ({ records: [{ msgId: 'm_out' }] }),
    replyTask: (msgId) => calls.push(['task-reply', msgId]),
  })
  assert.deepEqual(calls, [['outbox', '测试群A', '晚上见'], ['task-reply', 'm_out']])
  assert.equal(confirmed.outMsgId, 'm_out')
})
test('unconfirmed 发送不写回声凭据、不记历史，也不记任务回复', () => {
  const calls = []
  const result = applyWxSendBookkeeping({
    sent: 'unconfirmed',
    chat: '测试群A',
    text: '晚上见',
    noteOutbox: (...args) => calls.push(['outbox', ...args]),
    capture: () => calls.push(['history']),
    replyTask: (...args) => calls.push(['task-reply', ...args]),
  })
  assert.deepEqual(calls, [])
  assert.equal(result.outMsgId, '')
})
test('confirmed 但捕获结果没有稳定 msgId 时不挂任务，并明确标未记录', () => {
  const calls = []
  const result = applyWxSendBookkeeping({
    sent: 'confirmed',
    chat: '测试群A',
    text: '晚上见',
    noteOutbox: (...args) => calls.push(['outbox', ...args]),
    capture: () => ({ records: [], added: 0 }),
    replyTask: (...args) => calls.push(['task-reply', ...args]),
  })
  assert.deepEqual(calls, [['outbox', '测试群A', '晚上见']])
  assert.equal(result.outMsgId, '')
  assert.equal(result.status, 'not-recorded')
  assert.equal(result.recorded, false)
  assert.equal(result.reason, 'missing-msg-id')
})

test('implicit task binding 只把规范会话名对应到唯一活动任务', () => {
  const exact = bindingFixture()
  const exactResult = resolveWxSendTask({ chat: '测试群A', directory: exact.directory, board: exact.board })
  assert.equal(exactResult.ok, true)
  assert.equal(exactResult.source, 'implicit')
  assert.equal(exactResult.chatName, '测试群A')
  assert.equal(exactResult.chatId, exact.target.chatId)
  assert.equal(exactResult.task.taskId, exact.task.taskId)

  const resolvedDirectory = createDirectory({ file: tempFile('resolved-directory.json'), now: () => T })
  resolvedDirectory.merge({ chats: [{ name: '星晓家园10号楼13...' }], knownNames: ['星晓家园10号楼1301'] })
  const resolvedTarget = resolvedDirectory.sendableTarget('星晓家园10号楼13...')
  const resolvedBoard = createTaskBoard({ file: tempFile('resolved-tasks.jsonl'), now: () => T })
  const resolvedTask = resolvedBoard.create({
    chatId: resolvedTarget.chatId, chatName: resolvedTarget.chatName,
    inboundMsgId: 'm_resolved', text: '在吗', at: new Date(T).toISOString(),
  }).task
  const resolved = resolveWxSendTask({ chat: '星晓家园10号楼13...', directory: resolvedDirectory, board: resolvedBoard })
  assert.equal(resolved.source, 'implicit')
  assert.equal(resolved.chatName, '星晓家园10号楼1301')
  assert.equal(resolved.task.taskId, resolvedTask.taskId)

  const unknown = resolveWxSendTask({ chat: '没见过的群', directory: exact.directory, board: exact.board })
  assert.equal(unknown.ok, true)
  assert.equal(unknown.source, 'unresolved')
  assert.equal(unknown.task, null)
})

test('implicit task binding 不猜歧义名，改名别名仍走同一个目录 id', () => {
  const ambiguousFile = tempFile('ambiguous-directory.json')
  writeFileSync(ambiguousFile, JSON.stringify({ version: 1, chats: [{
    chatId: 'c_ambiguous', displayName: '星晓', fullName: '星晓', aliases: [],
    nameConfidence: 'ambiguous', firstSeenAt: new Date(T).toISOString(),
  }] }), 'utf8')
  const ambiguous = bindingFixture({ chat: '星晓', directoryFile: ambiguousFile, taskChatId: 'c_ambiguous' })
  const ambiguousResult = resolveWxSendTask({ chat: '星晓', directory: ambiguous.directory, board: ambiguous.board })
  assert.equal(ambiguousResult.ok, false)
  assert.equal(ambiguousResult.code, 'WX_CHAT_AMBIGUOUS')
  assert.equal(ambiguousResult.source, 'unresolved')
  assert.equal(ambiguousResult.status, 'ambiguous')
  assert.equal(ambiguousResult.task, undefined)

  const renamedFile = tempFile('renamed-directory.json')
  writeFileSync(renamedFile, JSON.stringify({ version: 1, chats: [{
    chatId: 'c_renamed', displayName: '新群名', fullName: '新群名', aliases: ['旧群名'],
    nameConfidence: 'exact', firstSeenAt: new Date(T).toISOString(),
  }] }), 'utf8')
  const renamed = bindingFixture({ chat: '新群名', directoryFile: renamedFile })
  const byOldName = resolveWxSendTask({ chat: '旧群名', directory: renamed.directory, board: renamed.board })
  assert.equal(byOldName.source, 'implicit')
  assert.equal(byOldName.chatName, '新群名')
  assert.equal(byOldName.chatId, 'c_renamed')
  assert.equal(byOldName.task.taskId, renamed.task.taskId)
})

test('implicit task binding 默认开，可显式关；显式 task_id 仍可回退', () => {
  const fixture = bindingFixture()
  const explicit = resolveWxSendTask({
    chat: '测试群A', taskId: fixture.task.taskId,
    directory: fixture.directory, board: fixture.board, implicitTaskBinding: false,
  })
  assert.equal(explicit.ok, true)
  assert.equal(explicit.source, 'explicit')
  assert.equal(explicit.task.taskId, fixture.task.taskId)

  const disabled = resolveWxSendTask({
    chat: '测试群A', directory: fixture.directory, board: fixture.board, implicitTaskBinding: false,
  })
  assert.equal(disabled.ok, true)
  assert.equal(disabled.source, 'disabled')
  assert.equal(disabled.task, null)

  const unresolvedDirectory = createDirectory({ file: tempFile('unresolved-directory.json'), now: () => T })
  const unresolvedBoard = createTaskBoard({ file: tempFile('unresolved-tasks.jsonl'), now: () => T })
  const unresolvedTask = unresolvedBoard.create({
    chatId: 'c_unresolved', chatName: '目录还没见过', inboundMsgId: 'm_unresolved',
    text: '在吗', at: new Date(T).toISOString(),
  }).task
  const fallback = resolveWxSendTask({
    chat: '目录还没见过', taskId: unresolvedTask.taskId,
    directory: unresolvedDirectory, board: unresolvedBoard,
  })
  assert.equal(fallback.source, 'explicit')
  assert.equal(fallback.task.taskId, unresolvedTask.taskId)
})

test('显式 task_id 不存在时明确拒绝', () => {
  const fixture = bindingFixture()
  const missing = resolveWxSendTask({
    chat: '测试群A', taskId: 't_missing', directory: fixture.directory, board: fixture.board,
  })
  assert.deepEqual(missing, {
    ok: false, code: 'WX_TASK_NOT_FOUND', source: 'explicit', status: 'task-not-found',
    requestedChat: '测试群A', chatName: '测试群A', targetChat: '测试群A', chatId: fixture.target.chatId,
  })
})

test('显式 task_id 指到别的会话时拒绝绑定', () => {
  const first = bindingFixture()
  const second = bindingFixture({ chat: '测试群B' })
  const wrong = resolveWxSendTask({
    chat: '测试群B', taskId: first.task.taskId,
    directory: second.directory, board: first.board,
  })
  assert.deepEqual(wrong, {
    ok: false, code: 'WX_TASK_CHAT_MISMATCH', source: 'explicit', status: 'chat-mismatch',
    requestedChat: '测试群B', chatName: '测试群B', targetChat: '测试群B', chatId: second.target.chatId,
  })
})

test('wx_task_snooze / wx_task_done 的状态句不带内部任务号', () => {
  assert.equal(projectWxTaskSnooze(), '[先搁一会儿]')
  assert.equal(projectWxTaskDone(), '[这件事放下了]')
  for (const text of [projectWxTaskSnooze(), projectWxTaskDone()]) {
    assert.doesNotMatch(text, /任务|taskId|task_id|t_/)
  }
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /projectWxTaskSnooze\(\)/)
  assert.match(src, /projectWxTaskDone\(\)/)
})

test('wx_context 投影改成翻到几段原话，不带匹配原因/来源/置信度/msgId', () => {
  const raw = [
    '[上下文 1/2] 晚上吃什么｜阿明｜2026-11-09 12:30',
    '「晚上来吗」',
    '匹配：关键词 + 同线程；来源：台账 msg_1；置信度：high',
    '',
    '[上下文 2/2] 晚上吃什么｜大肥鱼（发出）｜2026-11-09 12:31',
    '「看情况」',
    '匹配：同一条线；来源：台账 msg_2；置信度：high',
  ].join('\n')
  const text = projectWxContext(raw)
  assert.equal(text, [
    '[翻到] 「晚上吃什么」里相关的 2 条：',
    '阿明（2026-11-09 12:30）：晚上来吗',
    '你（2026-11-09 12:31）：看情况',
  ].join('\n'))
  for (const bad of ['上下文', '匹配', '来源', '置信度', 'msg_', '台账']) assert.equal(text.includes(bad), false)
})

test('wx_context 解析不了结构时也不回吐原始数据', () => {
  const text = projectWxContext('{"msgId":"m1","matchReason":"x","confidence":0.9}')
  assert.equal(text, '[翻到]\n（这段记录没能显示出来）')
  assert.equal(projectWxContext('[上下文 1/2] 坏掉的卡片'), '[翻到]\n（这段记录没能显示出来）')
})

test('wx_context 的内部检索卡也能直接生成世界声', () => {
  const hits = [
    {
      doc: { chatName: '晚上吃什么', sender: '阿明', senderConfidence: 'high', text: '晚上来吗', at: '2026-11-09 12:00' },
      score: 1,
      reasons: ['关键词'],
    },
    {
      doc: { chatName: '晚上吃什么', sender: null, direction: 'out', text: '看情况', at: '2026-11-09 12:01' },
      score: 0.9,
      reasons: ['同一条线'],
    },
  ]
  const out = formatCards(hits, { world: true, now: Date.parse('2026-11-09T12:30:00') })
  assert.equal(out.text, [
    '[翻到] 「晚上吃什么」里相关的 2 条：',
    '阿明（今天 12:00）：晚上来吗',
    '你（今天 12:01）：看情况',
  ].join('\n'))
  for (const bad of ['匹配', '来源', '置信度', 'msg_', '台账']) assert.equal(out.text.includes(bad), false)
  const older = formatCards([{
    doc: { chatName: '晚上吃什么', sender: '阿明', text: '之前那句', at: '2026-11-08 12:00' },
    score: 1,
    reasons: ['按时间翻页'],
  }], { world: true, now: Date.parse('2026-11-09T12:30:00') })
  assert.match(older.text, /更早的话/)
  assert.deepEqual(formatCards([], { world: true }), {
    text: '[翻到]\n没有找到。',
    cards: [],
    shown: 0,
    dropped: 0,
  })
})

test('wx_context 的低置信发言人不能写成确定的人', () => {
  const out = formatCards([{
    doc: {
      chatName: '测试群A', sender: '阿明', senderConfidence: 'low',
      text: '在吗', at: '2026-11-09 12:00',
    },
    score: 1,
    reasons: ['关键词'],
  }], { world: true, now: Date.parse('2026-11-09T12:30:00') })
  assert.equal(out.text, [
    '[翻到] 「测试群A」里相关的 1 条：',
    '看不出是谁（今天 12:00）：在吗',
  ].join('\n'))
})

test('wx_context 的旧卡片也遵守低置信发言人', () => {
  const raw = [
    '[上下文 1/1] 测试群A｜阿明｜2026-11-09 12:00',
    '「在吗」',
    '匹配：关键词；来源：台账 msg_1；置信度：low',
  ].join('\n')
  assert.equal(projectWxContext(raw), [
    '[翻到] 「测试群A」里相关的 1 条：',
    '看不出是谁（2026-11-09 12:00）：在吗',
  ].join('\n'))
})

test('wx_context 旧卡片里发出去的话，低置信或缺置信都还是你', () => {
  for (const senderConfidence of ['low', undefined]) {
    const legacy = formatCards([{
      doc: {
        chatName: '测试群A', sender: null, senderConfidence, direction: 'out',
        text: '看情况', at: '2026-11-09 12:01',
      },
      score: 1,
      reasons: ['最近'],
    }]).text
    assert.match(legacy, /置信度：低/)
    assert.equal(projectWxContext(legacy), [
      '[翻到] 「测试群A」里相关的 1 条：',
      '你（11/09 12:01）：看情况',
    ].join('\n'))
  }
})

test('wx_context 的多行原话原样穿过世界声投影', () => {
  const world = [
    '[翻到] 「测试群A」里相关的 2 条：',
    '阿明（今天 12:00）：晚上来吗',
    '匹配：这是原话的一部分',
    '置信度：这也是原话',
    '你（今天 12:01）：看情况',
  ].join('\n')
  assert.equal(projectWxContext(world), world)
})

test('wx_ocr 投影只保留可读文字，不返回 JSON 字段', () => {
  const raw = JSON.stringify({ lines: [{ text: '晚上来吗', box: [1, 2, 3, 4], confidence: 0.9 }] })
  const text = projectWxOcr(raw)
  assert.match(text, /晚上来吗/)
  assert.equal(text.includes('confidence'), false)
  assert.equal(text.includes('[1,2'), false)
})

test('wx_ocr 的结构化结果说成屏幕上的会话和最后几句', () => {
  const raw = JSON.stringify({
    source: 'ocr',
    current: '',
    currentVerified: false,
    chats: [{ name: '测试群', unread: 2, mention: true, preview: '晚上来吗', box: [1, 2, 3, 4], nameConfidence: 0.9 }],
    messages: [{ text: '明天见', confidence: 0.8, verified: false }],
    note: 'OCR cannot verify the active conversation or authorize sending.',
  })
  assert.equal(projectWxOcr(raw), [
    '[微信] 屏幕可能慢半拍，下面可能是刚才的。',
    '侧栏：',
    '- 「测试群」2 条未读，最后一句：晚上来吗',
    '当前对话最后几句（看不出是谁）：',
    '明天见',
  ].join('\n'))
})

test('wx_ocr 投影递归收集字符串并去重，跳过坐标与置信度', () => {
  const raw = JSON.stringify({
    rows: [
      { text: '晚上来吗', box: { x: 1, y: 2, w: 3, h: 4 }, confidence: 0.9, score: 0.8 },
      { text: '晚上来吗', lines: ['明天见', '  '] },
    ],
    width: 1280,
    height: 720,
  })
  const text = projectWxOcr(raw)
  assert.match(text, /晚上来吗/)
  assert.match(text, /明天见/)
  assert.equal(text.split('晚上来吗').length - 1, 1)
  assert.equal(text.includes('confidence'), false)
  assert.equal(text.includes('0.9'), false)
})

test('wx_ocr 投影不把消息号或匹配原因当屏幕文字', () => {
  const raw = JSON.stringify({
    rows: [
      { text: '晚上来吗', msgId: 'm_secret', matchReason: '关键词命中', confidence: 0.9 },
    ],
  })
  const text = projectWxOcr(raw)
  assert.match(text, /晚上来吗/)
  for (const bad of ['m_secret', '关键词命中', 'msgId', 'matchReason', 'confidence']) {
    assert.equal(text.includes(bad), false, `投影里不该出现 ${bad}`)
  }
})

test('wx_ocr 解析失败不回吐原始 JSON', () => {
  const raw = '{"lines": [' + '字'.repeat(3000)
  const text = projectWxOcr(raw)
  assert.equal(text.includes('{'), false, '解析失败也不能把 JSON 片段交给她')
  assert.equal(text.includes('"lines"'), false)
  assert.match(text, /\[屏幕上看到\]/)
  assert.match(text, /没读完/)
})

test('wx_ocr 超长合法 JSON：投影仍只给可读文字，不回吐字段名', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => ({
    text: `第${i}行文字内容`,
    box: [i, i + 1, 10, 10],
    confidence: 0.9,
    nameConfidence: 0.8,
  }))
  const raw = JSON.stringify({
    lines,
    source: 'ocr',
    note: 'OCR cannot verify the active conversation or authorize sending.',
    verified: false,
    currentVerified: false,
  })
  assert.ok(raw.length > 24_000, `fixture 应超过 24k，实际 ${raw.length}`)
  const text = projectWxOcr(raw)
  assert.match(text, /第0行文字内容/)
  assert.match(text, /第1999行文字内容/)
  for (const bad of ['{', 'box', 'confidence', 'nameConfidence', 'source', 'OCR cannot verify', 'verified']) {
    assert.equal(text.includes(bad), false, `投影里不该出现 ${bad}`)
  }
  const rows = text.split('\n').map((l) => l.trim())
  assert.equal(rows.includes('ocr'), false, 'source 的值不该单独成行')
  assert.equal(rows.includes('false'), false, 'verified 的值不该单独成行')
})

test('wx_ocr 投影跳过 source/note/verified/ocrName 等元数据', () => {
  const raw = JSON.stringify({
    source: 'ocr',
    note: 'OCR cannot verify the active conversation or authorize sending.',
    verified: false,
    currentVerified: false,
    chats: [{ name: '测试群', ocrName: '测试群（缓存）', nameConfidence: 0.9, text: '晚上来吗' }],
    messages: [{ text: '明天见', verified: false }],
  })
  const text = projectWxOcr(raw)
  assert.match(text, /测试群/)
  assert.match(text, /晚上来吗/)
  assert.match(text, /明天见/)
  assert.equal(text.split('\n').map((l) => l.trim()).includes('ocr'), false, 'source 的值不该单独成行')
  assert.equal(text.includes('测试群（缓存）'), false, 'ocrName 是元数据')
  assert.equal(text.includes('OCR cannot verify'), false, 'note 不该进投影')
})

test('wx_ocr 旧渲染路径最多 24000 字', () => {
  const text = boundedText('x'.repeat(50_000))
  // cut 在 24000 字之后追加 '\n…（已截断）'，共 7 个字符。
  assert.equal([...text].length, 24_007)
  assert.match(text, /截断/)
})

test('wx_peek 旧格式也不再回吐 box 或树的字段口吻', () => {
  const raw = '会话「测试群」 box=[10,20,300,40] 预览="晚上来吗"\n' + '正'.repeat(13000)
  const text = projectWxPeek(raw)
  assert.equal(text.includes('box=['), false)
  assert.match(text, /测试群/)
  assert.match(text, /晚上来吗/)
  assert.equal(text.includes('box'), false)
})

test('wx_peek 生产树格式投影成停在哪儿、侧栏和最后几句', () => {
  const raw = [
    '微信窗口 916x666 原点(523,233) · 元素 335 个 · 缩放 1.0417 · 当前会话："测试群A"',
    '当前会话："测试群A"',
    '--- 会话列表 ---',
    '会话 "测试群A" 未读=9 @我 草稿 置顶 时间="16:19" 预览="晚上来吗" 中心(711,555) 250x68',
    '--- 当前聊天里的消息 ---',
    '消息 "明天见" 中心(1138,715) 602x77',
    '--- 能点的 ---',
    'push button "Chat Info" 中心(1407,292) 29x29',
  ].join('\n')
  const text = projectWxPeek(raw)
  assert.equal(text, [
    '[微信] 停在「测试群A」。',
    '侧栏：',
    '- 「测试群A」9 条未读，最后一句：晚上来吗',
    '当前对话最后几句（看不出是谁）：',
    '明天见',
  ].join('\n'))
  for (const bad of ['微信窗口', '原点(', '中心(', 'box', '缩放', '916x666', '250x68', '602x77', '未读=', '时间=', 'push button']) {
    assert.equal(text.includes(bad), false, `投影里不该出现 ${bad}`)
  }
})

test('wx_peek 长正文截断时为 [提示] 与气氛尾巴留位置', () => {
  const raw = '微信窗口 916x666 原点(523,233) · 元素 335 个 · 缩放 1.0417\n' +
    '会话 "测试群A" 未读=9 预览="晚上来吗" 中心(711,555) 250x68\n'.repeat(1000)
  assert.ok(raw.length > 12_000)
  const tail = '\n[提示] 屏幕上的会话列表已变化，读到的树没有跟上。\n[气氛] 今天有点安静'
  const text = projectWxPeek(clipPeekBody(raw, tail))
  assert.match(text, /^\[微信\] 屏幕可能慢半拍，下面可能是刚才的。/)
  assert.match(text, /\[气氛\] 今天有点安静/)
  assert.match(text, /已截断/)
  assert.ok(text.length <= 12_040, `长度应不超过 12000 左右，实际 ${text.length}`)
  assert.doesNotMatch(text, /\[提示\]|树|秒|坐标/)
})

test('wx_peek 的 OCR JSON 投影成可读文本，不泄露坐标与置信度', () => {
  const raw = JSON.stringify({
    source: 'ocr', current: '', currentVerified: false,
    chats: [{ name: '测试群', unread: 2, mention: true, preview: '晚上来吗', box: [1, 2, 3, 4], nameConfidence: 0.9 }],
    messages: [{ text: '明天见', confidence: 0.8, verified: false }],
    note: 'OCR cannot verify the active conversation or authorize sending.',
  })
  const text = projectWxPeek(raw)
  assert.match(text, /^\[微信\] 屏幕可能慢半拍，下面可能是刚才的。/)
  assert.match(text, /「测试群」2 条未读，最后一句：晚上来吗/)
  assert.match(text, /明天见/)
  assert.equal(text.includes('box'), false)
  assert.equal(text.includes('Confidence'), false)
  assert.equal(text.includes('0.9'), false)
  assert.equal(text.includes('0.8'), false)
  assert.equal(text.includes('OCR cannot verify'), false)
  assert.equal(text.includes('{'), false)
  assert.equal(text.includes('retcode'), false)
})

test('微信工具返回文案不把机械词交给她', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  for (const bad of [
    "const OFF = '微信通道已关闭。'",
    '坐标可能是旧的',
    'OCR cannot verify the active conversation or authorize sending.',
    '这条用了主动额度',
    'wx_context: 需要 task_id。',
    'wx_task_snooze: 需要 task_id。',
    'wx_task_done: 需要 task_id。',
    'wx_sticker_tag: id 不能为空。',
    '[微信·主机] ${poke}',
    '回执：消息已出现在列表末尾。',
    "throw new Error('树落后于屏幕",
    ' 台账：${r.outMsgId}',
  ]) {
    assert.equal(src.includes(bad), false, `返回文案仍含机械词：${bad}`)
  }
})

test('所有微信工具说明压短，参数集合与 required 集合保持不变', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const expectedDescriptions = {
    wx_see: '看一眼微信窗口。这里看不见图，想知道屏幕上的文字就换个办法。',
    wx_peek: '看微信现在停在哪、侧栏有哪些会话、当前对话最后几句。屏幕可能慢半拍。',
    wx_click: '点刚看见的会话名或按钮名。找不到那个名字，就别猜位置。',
    wx_type: '往当前输入框里打字。回车会直接发出去，先看清停在哪个会话。',
    wx_send: '把一句话发到某个微信会话。一个字里不要换行。',
    wx_context: '翻这个会话更早的话。给不出全文就说没有。',
    wx_history: '翻微信里以前记下的话。没翻到就说没翻到，别编。',
    wx_task_snooze: '这会儿回不了，但还得回，就先搁一会儿。',
    wx_task_done: '这件事不用再跟了，就放下。发了一句不等于放下。',
    wx_ocr: '读屏幕上的字。认不全就说认不全，别拿它证明停在哪个会话。',
    wx_key: '按一个键或组合键。回车会直接发出去，先看清停在哪个会话。',
    wx_sticker_scan: '看看收藏里现在有哪些表情。扫的时候会打开面板，再把它关上。',
    wx_sticker_list: '看看收藏里有哪些表情。什么也没看到时，先扫一遍再说。',
    wx_sticker_find: '按词找收藏里的表情。找到的只是候选，没把握就别挑。',
    wx_sticker_tag: '给收藏里的那张表情补上字、描述或标签。看不清就不要猜。',
    wx_sticker_send: '发一张收藏里的表情。你看不见图，点下去就出去了，没把握就别用。',
    wx_sticker_collect: '把聊天里的一张表情收进收藏。菜单里没有那一项，就别点。',
    wx_sticker_search: '按词直接发一张表情，你看不见图，点下去就出去了。没把握就别用。',
  }
  const expectedSchemas = {
    wx_see: [[], []],
    wx_peek: [[], []],
    wx_click: [['label', 'x', 'y', 'button'], []],
    wx_type: [['text', 'enter'], ['text']],
    wx_send: [['chat', 'text', 'permit', 'task_id'], ['chat', 'text']],
    wx_context: [['task_id', 'query', 'before', 'limit'], ['task_id']],
    wx_history: [['chat', 'query', 'hours', 'limit'], []],
    wx_task_snooze: [['task_id', 'minutes'], ['task_id']],
    wx_task_done: [['task_id', 'note'], ['task_id']],
    wx_ocr: [[], []],
    wx_key: [['keys'], ['keys']],
    wx_sticker_scan: [[], []],
    wx_sticker_list: [['limit'], []],
    wx_sticker_find: [['query', 'limit'], ['query']],
    wx_sticker_tag: [['id', 'text', 'desc', 'tags', 'textConf', 'descConf'], ['id']],
    wx_sticker_send: [['chat', 'id', 'task_id'], ['chat', 'id']],
    wx_sticker_collect: [['chat', 'which'], []],
    wx_sticker_search: [['chat', 'keyword', 'pick', 'task_id'], ['chat', 'keyword']],
  }

  const markers = [...src.matchAll(/name: '(wx_[^']+)'/g)]
  assert.equal(markers.length, Object.keys(expectedDescriptions).length)
  const banned = ['模型', '通道', '台账', '任务板', 'task_id', 'taskId', '主机', '宿主', 'permit', '白名单', '允许名单', '门禁', '额度', '配额', '置信度', '匹配原因', '回执', '系统提示', 'dsh-', 'shell', 'schema', 'JSON', 'OCR', 'pHash', 'xdotool', 'NapCat', 'API', '插件', 'Error:', '坐标', '无障碍', '树落后', '字段', '索引', '盲选', '工具']

  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]
    const name = marker[1]
    const block = src.slice(marker.index, markers[i + 1]?.index ?? src.length)
    const description = block.match(/^ {4}description: '([^']*)'/m)?.[1]
    assert.equal(description, expectedDescriptions[name], `${name} description`)

    const propertyDescriptions = [...block.matchAll(/description: '([^']*)'/g)].map((m) => m[1])
    for (const text of propertyDescriptions) {
      assert.ok([...text].length <= 48, `${name} 的参数说明过长：${text}`)
      for (const word of banned) assert.equal(text.includes(word), false, `${name} 参数说明含 ${word}：${text}`)
    }

    const params = block.slice(block.indexOf('parameters:'))
    const properties = objectBodyAfter(params, 'properties')
    const keys = topLevelKeys(properties)
    const required = [...(params.match(/required: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    assert.deepEqual(keys, expectedSchemas[name][0], `${name} property keys`)
    assert.deepEqual(required, expectedSchemas[name][1], `${name} required keys`)
  }
})

test('所有微信注册共用 wrapWxTool 边界和单一回滚开关', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const registrations = [...src.matchAll(/\n  reg\(\{/g)]
  const names = [...src.matchAll(/name: '(wx_[^']+)'/g)]
  assert.equal(registrations.length, names.length)
  assert.match(src, /returnEnvelopes: raw\.returnEnvelopes !== false/)
  assert.match(src, /const toolEnvelopesEnabled = policy\(\)\.returnEnvelopes !== false/)
  assert.match(src, /if \(toolEnvelopesEnabled\) \{\n      const def = wrapWxTool/)
  assert.match(src, /wrapWxTool\(\{ \.\.\.base, project \}, \{ envelopes: false \}\)/)
  assert.equal([...src.matchAll(/ctx\.tools\.register\(/g)].length, 2, '注册只能发生在统一 reg 边界')
})

test('lazyRender 在 core 晚到时仍能接上投影', () => {
  let core = null
  const ctx = { get: (k) => (k === 'fishCore' ? core : undefined) }
  const base = {
    name: 'wx_peek',
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
    project: (out) => ({ text: '投影：' + out }),
    execute: async () => 'raw',
  }
  const render = lazyRender(ctx, base)

  // core 还没出现：走旧渲染。
  assert.equal(render({}, 'raw')[0].text, 'raw')

  // core 晚到：同一个 render 下一次调用就接上投影。
  core = {
    tools: {
      wrapRender: (b) => ({ output: { render: (_a, v) => [{ type: 'text', text: b.project(v).text }] } }),
    },
  }
  assert.equal(render({}, 'raw')[0].text, '投影：raw')
})
