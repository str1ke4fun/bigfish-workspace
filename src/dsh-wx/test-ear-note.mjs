// 耳朵和逾期只把世界里发生的事递给她，不给工单。
// 跑：node wx/test-ear-note.mjs
import assert from 'node:assert/strict'
import { formatEarNote, formatOverdueNote } from './lib/index.js'

const note = formatEarNote(
  [
    { chat: '某个猫', unread: 1, preview: '在吗？', why: 'dm' },
    { chat: '测试群A', unread: 3, preview: '李四: @大肥鱼 看下这个', why: '@' },
  ],
  ['某个猫', '测试群A'],
  new Map([
    ['某个猫', { taskId: 't_dm1', chatName: '某个猫' }],
    ['测试群A', { taskId: 't_g1', chatName: '测试群A' }],
  ]),
  {
    requester: new Map([
      ['某个猫', { name: '阿明', confidence: 'low' }],
      ['测试群A', { name: '李四', confidence: 'medium' }],
    ]),
    recent: new Map([
      ['某个猫', ['台账里不该出现的一行']],
      ['测试群A', ['台账里也不该出现的一行']],
    ]),
  },
)

assert.equal(note, [
  '[有人找你]',
  '「某个猫」里，有人说：在吗？',
  '这句是侧栏上的预览，不一定是全文。',
  '〔t_dm1〕',
  '',
  '「测试群A」里，李四说：@大肥鱼 看下这个',
  '这句是侧栏上的预览，不一定是全文。',
  '〔t_g1〕',
].join('\n'))

for (const bad of ['未读', '类型：', '名单', '允许发送', '台账', '任务：', '1)', '置信度', 'exempt', '单聊']) {
  assert.equal(note.includes(bad), false, `耳朵里不该出现 ${bad}`)
}
assert.equal(note.split('\n').filter((line) => line.startsWith('〔t_')).every((line) => line.endsWith('〕')), true)

const withTasks = formatEarNote(
  [{ chat: '某个猫', unread: 1, preview: '在吗？', why: 'dm' }],
  ['某个猫', '测试群A'],
  new Map([['某个猫', { taskId: 't_dm1', chatName: '某个猫' }]]),
  { requester: new Map([['某个猫', { name: '阿明', confidence: 'high' }]]) },
)
assert.equal(withTasks.split('\n').at(-1), '〔t_dm1〕')
assert.equal(formatEarNote([{ chat: 'x', preview: '在吗', why: 'exempt' }], []).includes('〔'), false)

const overdue = formatOverdueNote({
  chatName: '测试群A',
  taskId: 't_overdue',
  requester: { name: '阿明', confidence: 'medium' },
  reason: '@',
  lastText: '阿明: @大肥鱼 晚上来吗',
}, 2)
assert.equal(overdue, [
  '[还没回]',
  '「测试群A」里，阿明的那句还在：晚上来吗',
  '搁了有一会儿了。',
  '〔t_overdue〕',
].join('\n'))
for (const bad of ['第 2 次', '已等', '分钟', '小时', 'wx_', '任务：', '@', '台账']) {
  assert.equal(overdue.includes(bad), false, `逾期里不该出现 ${bad}`)
}

const third = formatOverdueNote({
  chatName: '测试群A',
  taskId: 't_third',
  requester: { name: '' },
  lastText: '还在吗',
}, 3)
assert.match(third, /^\[这件事先放着\]/)
assert.match(third, /「测试群A」里，有人/)
assert.equal(third.split('\n').at(-1), '〔t_third〕')

console.log('formatEarNote: 全部通过')
