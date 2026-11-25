import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChatLabel } from '../lib/chat-label.js'
import {
  parseTree, reconcileChatName, planChatNavigation, ocrMentionHits, mentionHits, treeMatchesOcr,
} from '../lib/tree.js'
import { looksDM } from '../lib/ear-open.js'

test('会话行 label 保留 emoji/旗帜/keycap，清掉孤立代理', () => {
  assert.equal(parseChatLabel('🌊周末海边🏖️\n[3]\n张三: 在吗\n12:03').name, '🌊周末海边🏖️')
  assert.equal(parseChatLabel('🇨🇳群\n预览\n12:03').name, '🇨🇳群')
  assert.equal(parseChatLabel('1️⃣群\n预览\n12:03').name, '1️⃣群')
  assert.equal(parseChatLabel('😀\uD83D\n预览\n12:03').name, '😀')
})

test('会话行 preview 也清掉不可见字符', () => {
  assert.equal(parseChatLabel('群\n张三: 在吗\uD83D\n12:03').preview, '张三: 在吗')
  assert.equal(parseChatLabel('群\n预览​\n12:03').preview, '预览')
})

test('parseTree 的 current 与行名保留 emoji', () => {
  const text = [
    '微信窗口 100x100 原点(0,0) · 元素 10 个 · 缩放 1.0000 · 测试',
    '当前会话："🌊周末海边🏖️"',
    '--- 会话列表 ---',
    '会话 "🌊周末海边🏖️" 未读=2 预览="张三: 在吗" 中心(10,20) 100x30',
    '--- 当前聊天里的消息 ---',
    '--- 能点的 ---',
  ].join('\n')
  const parsed = parseTree(text)
  assert.equal(parsed.current, '🌊周末海边🏖️')
  assert.equal(parsed.chats[0].name, '🌊周末海边🏖️')
})

test('parseTree 的 current / 行名 / preview 清掉孤立代理', () => {
  const text = [
    '微信窗口 100x100 原点(0,0) · 元素 10 个 · 缩放 1.0000 · 测试',
    '当前会话："群\uD83D"',
    '--- 会话列表 ---',
    '会话 "群\uD83D" 未读=0 预览="x\uD83D" 中心(10,20) 100x30',
    '--- 当前聊天里的消息 ---',
    '--- 能点的 ---',
  ].join('\n')
  const parsed = parseTree(text)
  assert.equal(parsed.current, '群')
  assert.equal(parsed.chats[0].name, '群')
  assert.equal(parsed.chats[0].preview, 'x')
})

test('reconcileChatName 用 skeleton 唯一补全 OCR 丢掉的 emoji', () => {
  assert.equal(reconcileChatName('周末海边', ['🌊周末海边🏖️']), '🌊周末海边🏖️')
  assert.equal(reconcileChatName('周末海边', ['🌊周末海边🏖️', '🏖️周末海边']), '周末海边')
})

test('reconcileChatName 仍保留截断前缀行为', () => {
  const names = ['星晓家园10号楼1302', '内部赤石群']
  assert.equal(reconcileChatName('星晓家园10号楼13...', names), '星晓家园10号楼1302')
  assert.equal(reconcileChatName('星晓家园10号楼13…', names), '星晓家园10号楼1302')
  assert.equal(reconcileChatName('星晓家园10号楼', names), '星晓家园10号楼1302')
  assert.equal(reconcileChatName('星', names), '星')
})

test('reconcileChatName 保留候选更长的 emoji 截断前缀', () => {
  assert.equal(reconcileChatName('🌊周末海...', ['🌊周末海边🏖️']), '🌊周末海边🏖️')
})

test('reconcileChatName 不把截断名缩成等长的短名', () => {
  assert.equal(reconcileChatName('家人...', ['家人']), '家人...')
  assert.equal(reconcileChatName('家人…', ['家人']), '家人…')
  // 真正更长的全名仍然可以补全。
  assert.equal(reconcileChatName('家人...', ['家人群聊2023']), '家人群聊2023')
})

test('reconcileChatName 不把比白名单更长的 OCR 名反向改短', () => {
  assert.equal(reconcileChatName('读书群2', ['读书群']), '读书群2')
  assert.equal(reconcileChatName('家庭群(2)', ['家庭群']), '家庭群(2)')
})

test('reconcileChatName 不拿空 skeleton 改写纯 emoji/符号名', () => {
  assert.equal(reconcileChatName('😀', ['🌊']), '😀')
  assert.equal(reconcileChatName('???', ['🌊']), '???')
})

test('planChatNavigation 命中多行返回 ambiguous，不点第一行', () => {
  const rows = [
    { name: '❤️读书群', box: { cx: 1, cy: 1 } },
    { name: '❤读书群', box: { cx: 2, cy: 2 } },
  ]
  const plan = planChatNavigation({
    parsed: { ok: true, current: '别的群', chats: rows },
    target: '❤读书群',
    tree: { status: 'ok', ok: true, chats: 2 },
  })
  assert.equal(plan.action, 'ambiguous')
  assert.equal(plan.matches.length, 2)
  assert.equal(plan.chatCount, 2)
})

test('planChatNavigation 折叠变体只命中一行时仍可导航', () => {
  const hit = { name: '❤️读书群', box: { cx: 1, cy: 1 } }
  const plan = planChatNavigation({
    parsed: { ok: true, current: '别的群', chats: [hit, { name: '另一个群', box: { cx: 2, cy: 2 } }] },
    target: '❤读书群',
    tree: { status: 'ok', ok: true, chats: 2 },
  })
  assert.equal(plan.action, 'navigate')
  assert.equal(plan.target, hit)
})

test('mentionHits 的名单匹配接受 VS 变体', () => {
  const row = { name: '❤读书群', unread: 1, preview: '在吗', mention: false, box: {} }
  const byAllow = mentionHits({ chats: [row], current: '' }, ['大肥鱼'], [], ['❤️读书群'])
  assert.equal(byAllow.length, 1)
  assert.equal(byAllow[0].why, 'dm')
  const byExempt = mentionHits({ chats: [row], current: '' }, ['大肥鱼'], ['❤️读书群'], [])
  assert.equal(byExempt.length, 1)
  assert.equal(byExempt[0].why, 'exempt')
})

test('mentionHits 的名单匹配不做前缀/包含', () => {
  const row = { name: '读书群', unread: 1, preview: '在吗', mention: false, box: {} }
  assert.equal(mentionHits({ chats: [row], current: '' }, ['大肥鱼'], ['读书'], ['读书']).length, 0)
})

test('ocrMentionHits 接受纯旗帜，拒绝纯问号', () => {
  const flag = ocrMentionHits({ chats: [{ source: 'ocr', name: '🇨🇳', mention: true, unread: 1, nameConfidence: 80 }] })
  assert.equal(flag.length, 1)
  const noise = ocrMentionHits({ chats: [{ source: 'ocr', name: '???', mention: true, unread: 1, nameConfidence: 80 }] })
  assert.equal(noise.length, 0)
})

test('looksDM 按字素判断发送者前缀', () => {
  assert.equal(looksDM({ preview: '午安' }), true)
  assert.equal(looksDM({ preview: '张三: 午安' }), false)
  assert.equal(looksDM({ preview: '' }), false)
  // 11 面旗帜是 11 个字素（22 个码元），按旧的字数码元上限会被误判成单聊。
  assert.equal(looksDM({ preview: `${'🇨🇳'.repeat(11)}: 午安` }), false)
  assert.equal(looksDM({ preview: `${'🇨🇳'.repeat(21)}: 午安` }), true)
})

test('treeMatchesOcr 的前缀按字素比较', () => {
  const tree = { chats: [{ name: '🌊周末海边🏖️' }, { name: '甲群' }, { name: '乙群' }] }
  assert.equal(treeMatchesOcr(tree, { chats: [{ name: '🌊周末海边' }, { name: '甲群' }, { name: '乙群' }] }), true)
  // 半个旗帜（单个 regional indicator）是一个字素，不够前缀的最短长度，不能算命中。
  const flagTree = { chats: [{ name: '🇨🇳群' }, { name: '甲群' }, { name: '乙群' }] }
  assert.equal(treeMatchesOcr(flagTree, { chats: [{ name: '🇨' }, { name: '甲群' }, { name: '乙群' }] }), false)
})
