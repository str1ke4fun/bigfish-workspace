// 耳朵递话的格式：会话名和内容必须分开，别让她把名字当话回。
// 跑：node wx/test-ear-note.mjs
import assert from 'node:assert/strict'
import { formatEarNote } from './lib/index.js'

const note = formatEarNote(
  [
    { chat: '某个猫', unread: 1, preview: '在吗？', why: 'dm' },
    { chat: '测试群A', unread: 3, preview: '李四: @大肥鱼 看下这个', why: '@' },
  ],
  ['某个猫', '测试群A'],
)

console.log(note)
console.log('---')

// 名字单独一行、内容单独一行，且名字后面不能紧跟内容
assert.match(note, /1\) 会话名：某个猫/)
assert.match(note, /最后一条内容（侧栏预览，不是全文）：「在吗？」/)
assert.ok(!/某个猫：/.test(note), '会话名后面不该跟冒号接内容')
assert.match(note, /2\) 会话名：测试群A/)
assert.match(note, /类型：群里 @ 你/)
assert.match(note, /类型：单聊/)
assert.match(note, /不是你该说出口的话/)

// 没有允许名单时也不能崩
assert.match(formatEarNote([{ chat: 'x', unread: 0, preview: '', why: 'exempt' }], []), /名单为空/)

// 任务 id 跟着对应会话走；没有任务就不多写一行
const withTasks = formatEarNote(
  [
    { chat: '某个猫', unread: 1, preview: '在吗？', why: 'dm' },
    { chat: '测试群A', unread: 3, preview: '@大肥鱼 看下这个', why: '@' },
  ],
  ['某个猫', '测试群A'],
  new Map([
    ['某个猫', { taskId: 't_dm1', chatName: '某个猫' }],
    ['测试群A', { taskId: 't_g1', chatName: '测试群A' }],
  ]),
)
assert.match(withTasks, /1\) 会话名：某个猫[\s\S]*任务：t_dm1（未回）/)
assert.match(withTasks, /2\) 会话名：测试群A[\s\S]*任务：t_g1（未回）/)
assert.doesNotMatch(note, /任务：/)

console.log('formatEarNote: 全部通过')
