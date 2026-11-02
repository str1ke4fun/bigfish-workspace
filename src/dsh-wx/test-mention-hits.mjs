// 耳朵判据的单元测试：群里没 @ 不算，单聊没 @ 也要算。
// 跑：node wx/test-mention-hits.mjs
import assert from 'node:assert/strict'
import { mentionHits, parseTree } from './lib/tree.js'

const chat = (name, unread, preview, extra = {}) => ({ name, unread, preview, mention: false, draft: false, pinned: false, time: '18:40', box: {}, ...extra })
const parsed = (chats) => ({ chats, current: '', messages: [] })

const exempt = ['File Transfer', '计科4223张三']
const allow = ['测试群A', '计科4223张三', 'File Transfer', '测试家园10号楼1302']

// 1. 群里有人说话但没 @ 她、预览里也没有她的名字 → 不该叫
assert.equal(mentionHits(parsed([chat('测试群A', 9, '张三: 今晚吃啥')]), ['大肥鱼'], exempt, allow).length, 0)

// 2. 群里 @ 她（微信标了 @我）→ 叫
const at = mentionHits(parsed([chat('测试群A', 3, '李四: @大肥鱼 看下这个', { mention: true })]), ['大肥鱼'], exempt, allow)
assert.equal(at.length, 1)
assert.equal(at[0].why, '@')

// 3. 群里预览出现她的名字 → 叫
assert.equal(mentionHits(parsed([chat('测试群A', 2, '王五: 大肥鱼在吗')]), ['大肥鱼'], exempt, allow)[0].why, 'name')

// 4. 单聊在免 @ 白名单里，只说「在吗」→ 叫（这是这次修的重点）
const dmExempt = mentionHits(parsed([chat('计科4223张三', 1, '在吗')]), ['大肥鱼'], exempt, allow)
assert.equal(dmExempt.length, 1)
assert.equal(dmExempt[0].why, 'exempt')

// 5. 单聊在允许名单里但不在免 @ 名单里，预览没有「发送者:」前缀 → 也当单聊叫
const dmAllow = mentionHits(parsed([chat('测试家园10号楼1302', 4, '明天几点')]), ['大肥鱼'], exempt, allow)
assert.equal(dmAllow.length, 1)
assert.equal(dmAllow[0].why, 'dm')

// 6. 不在任何名单里的会话（公众号、新闻）有未读 → 不叫
assert.equal(mentionHits(parsed([chat('Tencent News', 7, '今日要闻')]), ['大肥鱼'], exempt, allow).length, 0)

// 7. 单聊但未读=0（她自己刚发过）→ 不叫
assert.equal(mentionHits(parsed([chat('计科4223张三', 0, '她刚发的')]), ['大肥鱼'], exempt, allow).length, 0)

// 8. 群里预览带发送者前缀，即便在允许名单里 → 不按单聊叫
assert.equal(mentionHits(parsed([chat('测试群A', 5, '赵六: 有人吗')]), ['大肥鱼'], exempt, allow).length, 0)

// 9. 真解析一遍侧栏文本，确认 unread / mention / preview 取得对
const tree = `
会话 "测试群A" 未读=9 @我 时间="16:19" 预览="张三: @大肥鱼 看" 中心(711,555) 250x68
会话 "计科4223张三" 未读=2 时间="18:41" 预览="在吗" 中心(711,487) 250x68
`
const p = parseTree(tree)
const hits = mentionHits(p, ['大肥鱼'], exempt, allow)
assert.deepEqual(hits.map((h) => h.chat).sort(), ['测试群A', '计科4223张三'].sort())

console.log('mentionHits: 9 项全部通过')
