// dsh-wx 自测：node selftest.mjs
// 这些断言守的都是已经踩过的坑，不是覆盖率。每条的名字里写了它防的是哪次事故。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseChatLabel } from './lib/chat-label.js'
import {
  allowedCurrent, contentDigest, createFreshness, hitTest, mentionHits, parseTree, resolveLabel, sameName, sidebarRegion,
} from './lib/index.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }
const real = readFileSync(fileURLToPath(new URL('./fixtures/tree-sample.txt', import.meta.url)), 'utf8')
const P = parseTree(real)

console.log('chat-label')
t('名字就是第一行，预览里的括号不影响', () => {
  const c = parseChatLabel('测试群A\n[9]\n[You were mentioned]\n某个猫: [图片] 看这个\n16:19\n')
  assert.equal(c.name, '测试群A'); assert.equal(c.unread, 9); assert.equal(c.mention, true)
  assert.equal(c.preview, '某个猫: [图片] 看这个'); assert.equal(c.time, '16:19')
})
t('没有括号的行也切得出名字（以前整行糊成"名字+预览"）', () => {
  const c = parseChatLabel('测试群A\n验明正身：本鱼，学名 D33P533K\n16:19\n')
  assert.equal(c.name, '测试群A'); assert.equal(c.unread, 0); assert.equal(c.mention, false)
})
t('草稿 / 置顶 / Yesterday 时间', () => {
  const d = parseChatLabel('File Transfer\n[Draft]\n第五次 dry-run\nYesterday 23:49\n')
  assert.equal(d.draft, true); assert.equal(d.time, 'Yesterday 23:49'); assert.equal(d.preview, '第五次 dry-run')
  assert.equal(parseChatLabel('微信ClawBot\nPinned to top\n\n\n').pinned, true)
})
t('别人发一条 "12:30" 是预览，真正的时间是最后一行', () => {
  const c = parseChatLabel('某群\n12:30\n13:37\n')
  assert.equal(c.preview, '12:30'); assert.equal(c.time, '13:37')
})

console.log('tree（脱敏样本，几何来自真机）')
t('会话名只来自会话行；"Weixin"/"Contacts" 这些按钮不可能进候选', () => {
  const names = P.chats.map((c) => c.name)
  assert.ok(names.includes('测试群A') && names.includes('File Transfer') && names.includes('Weixin Team'))
  for (const bad of ['Weixin', 'Contacts', 'Moments', 'Search', 'Pin', 'Close']) assert.ok(!names.includes(bad), bad)
  assert.equal(P.chats.length, 9)
})
t('当前会话读得到，且不是预览/按钮', () => { assert.equal(P.current, '测试群A') })
t('长预览不影响名字（以前截 40 字后名字也会被截坏）', () => {
  const c = P.chats.find((x) => x.name === 'Tencent News')
  assert.ok(c && c.preview.includes('琶洲') && c.unread === 7)
})
t('坐标是屏幕坐标（已乘缩放）：会话行宽 ≈ 240×1.0417', () => {
  assert.ok(Math.abs(P.window.scale - 1.0417) < 0.001)
  assert.ok(P.chats.every((c) => c.box.w >= 248 && c.box.w <= 252))
})

console.log('发送闸')
t('当前开着别的会话时，即使名单里的群就在侧栏里，也不放行（以前 tree.includes 会放行）', () => {
  const other = parseTree(real.replace('当前会话："测试群A"', '当前会话："File Transfer"'))
  assert.ok(other.chats.some((c) => c.name === '测试群A'))
  assert.equal(allowedCurrent(other, ['测试群A']), null)
  assert.equal(allowedCurrent(P, ['测试群A']), '测试群A')
})
t('读不到当前会话 → 不放行', () => {
  assert.equal(allowedCurrent(parseTree(real.replace('当前会话："测试群A"', '当前会话：（读不到——可能没打开任何聊天）')), ['测试群A']), null)
})
t('名字比较不做"包含"：名单是"测试群A"，当前是"测试群A2"不放行', () => {
  assert.equal(sameName('测试群A', '测试群A2'), false)
  assert.equal(sameName(' 测试群A ', '测试群A'), true)
})

console.log('耳朵')
const withMention = parseTree(real.replace('会话 "某个猫" 未读=5', '会话 "某个猫" 未读=5 @我'))
t('@我 标记命中，名字准确', () => {
  const h = mentionHits(withMention, ['@D33p53Ek'])
  assert.deepEqual(h.map((x) => x.chat), ['某个猫'])
})
t('会话名里带她名字不算；预览里带才算', () => {
  const a = parseTree(real.replace('会话 "示例小组"', '会话 "D33p53Ek 的窝"'))
  assert.equal(mentionHits(a, ['D33p53Ek']).length, 0)
  const b = parseTree(real.replace('预览="在吗，看看这个"', '预览="@D33p53Ek 在吗"'))
  assert.equal(mentionHits(b, ['@D33p53Ek']).length, 1)
})
t('未读数抖动、时间戳变化都不算新的 @（key 里不放这两样）', () => {
  const k = (s) => mentionHits(parseTree(s), ['@D33p53Ek'])[0].key
  const base = real.replace('会话 "某个猫" 未读=5', '会话 "某个猫" 未读=5 @我')
  // key 里故意不放 unread：她一回复未读数就变，数值抖动会被当成新消息重复叫她（见 tree.js）
  assert.equal(k(base), k(base.replace('未读=5 @我', '未读=6 @我')))
  assert.equal(k(base), k(base))
  assert.equal(k(base), k(base.replace('时间="15:58"', '时间="15:59"')))
})
t('窗口挪位置、全屏后仍识别（不依赖写死的 x 范围）', () => {
  const moved = real.replace(/中心\((\d+),(\d+)\)/g, (_m, x, y) => `中心(${Number(x) + 300},${Number(y) - 100})`)
  assert.equal(mentionHits(parseTree(moved.replace('未读=5 时间="15:58"', '未读=5 @我 时间="15:58"')), ['@D33p53Ek']).length, 1)
})
t('消息区里带她名字的旧消息不会触发耳朵（只看会话行）', () => {
  assert.equal(mentionHits(P, ['@D33p53Ek']).length, 0) // 样本的消息区里就有一行 "@D33p53Ek 你什么模型"
})

console.log('点哪里')
t('label 整行贴回来也认得（含 [9]、[You were mentioned]、时间）', () => {
  const r = resolveLabel(P, '测试群A [9] [You were mentioned] 某个猫 16:19')
  assert.equal(r?.name, '测试群A'); assert.equal(r.kind, 'chat')
})
t('会话名优先于输入框（输入框的 text 也叫当前会话名）', () => {
  const r = resolveLabel(P, '测试群A')
  assert.equal(r.kind, 'chat'); assert.equal(r.box.cy, 555)
})
t('消息正文不参与匹配（以前"按标签点"能点到别人说的话）', () => {
  assert.equal(resolveLabel(P, '你什么模型'), null)
})
t('按钮名精确匹配；部分匹配只在唯一时成立', () => {
  assert.equal(resolveLabel(P, 'Chat Info').name, 'Chat Info')
  assert.equal(resolveLabel(P, 'Contacts').kind, 'control')
  assert.equal(resolveLabel(P, 'Voice'), null) // Voice Call / Voice Input / Send Voice 不唯一
})
t('落点判断：Chat Info 中心 → 控件；空白 → null；会话行 → 会话', () => {
  assert.equal(hitTest(P, 1407, 292).name, 'Chat Info')
  assert.equal(hitTest(P, 711, 555).kind, 'chat')
  assert.equal(hitTest(P, 100, 100), null)
})
t('树坐标 ×1.0417 才是屏幕坐标：未换算的坐标会点空 28px 小按钮', () => {
  // Chat Info 在屏幕上是 29×29，中心 (1407,292)；未换算的坐标是 (1351,280)，离中心 56px，必然落在按钮外
  assert.equal(hitTest(P, 1351, 280), null)
})

console.log('对账（树落后判断）')
const snap = (o = {}) => ({
  parsed: { ok: true }, region: { x: 60, y: 90, w: 220, h: 500 }, mouse: '711,555', at: 0, digest: 'D1', hash: 'H1', hash0: 'H1', ...o,
})
t('树没变、像素变、鼠标没动，连续两次 → 判落后；树变化后解除', () => {
  const f = createFreshness()
  assert.equal(f.observe(snap({ at: 0 })), 'baseline')
  assert.equal(f.observe(snap({ at: 5000, hash: 'H2', hash0: 'H2' })), 'suspect')
  assert.equal(f.observe(snap({ at: 10000, hash: 'H2', hash0: 'H2' })), 'stale')
  assert.ok(f.notice(12000).includes('[提示]'))
  assert.equal(f.observe(snap({ at: 20000, hash: 'H2', hash0: 'H2', digest: 'D2' })), 'live')
  assert.equal(f.notice(), '')
})
t('只出现一次不判（消息刚到，事件还在路上）', () => {
  const f = createFreshness()
  f.observe(snap())
  assert.equal(f.observe(snap({ at: 5000, hash: 'H2', hash0: 'H2' })), 'suspect')
  assert.equal(f.observe(snap({ at: 6000, hash: 'H2', hash0: 'H2', digest: 'D2' })), 'live')
  assert.equal(f.notice(), '')
})
t('鼠标动过不判（悬停高亮会改像素）', () => {
  const f = createFreshness()
  f.observe(snap())
  assert.equal(f.observe(snap({ at: 5000, hash: 'H2', hash0: 'H2', mouse: '711,600' })), 'rebase')
  assert.equal(f.observe(snap({ at: 10000, hash: 'H2', hash0: 'H2', mouse: '711,600' })), 'ok')
})
t('读树期间像素在变（前后摘要不一致）→ 这次不下结论', () => {
  const f = createFreshness()
  f.observe(snap())
  assert.equal(f.observe(snap({ at: 5000, hash: 'H3', hash0: 'H2' })), 'unstable')
  assert.equal(f.notice(), '')
})
t('落后判定后鼠标被动过，仍保持落后（不会因为 rebase 被洗掉）', () => {
  const f = createFreshness()
  f.observe(snap()); f.observe(snap({ at: 5000, hash: 'H2', hash0: 'H2' })); f.observe(snap({ at: 6000, hash: 'H2', hash0: 'H2' }))
  assert.equal(f.observe(snap({ at: 9000, hash: 'H4', hash0: 'H4', mouse: '1,1' })), 'stale')
})
t('屏幕回到树对应的样子 → 解除；超过 10 分钟 → 放弃判定', () => {
  const f = createFreshness()
  f.observe(snap()); f.observe(snap({ at: 5000, hash: 'H2', hash0: 'H2' })); f.observe(snap({ at: 6000, hash: 'H2', hash0: 'H2' }))
  assert.equal(f.observe(snap({ at: 7000, hash: 'H1', hash0: 'H1' })), 'live')
  assert.equal(f.notice(), '')
  const g = createFreshness()
  g.observe(snap()); g.observe(snap({ at: 5000, hash: 'H2', hash0: 'H2' })); g.observe(snap({ at: 6000, hash: 'H2', hash0: 'H2' }))
  assert.equal(g.observe(snap({ at: 6000 + 11 * 60_000, hash: 'H2', hash0: 'H2' })), 'live')
})
t('会话列表区域取自真实布局，且避开右侧滚动条', () => {
  const r = sidebarRegion(P)
  assert.ok(r && r.x >= 0 && r.w > 150 && r.w <= 250 && r.h > 300 && r.x + r.w <= P.window.w && r.y + r.h <= P.window.h)
})
t('内容摘要不含坐标：窗口挪位置不算内容变化', () => {
  const moved = real.replace(/中心\((\d+),(\d+)\)/g, (_m, x, y) => `中心(${Number(x) + 40},${Number(y)})`)
  assert.equal(contentDigest(parseTree(moved)), contentDigest(P))
})

console.log(`\n${n} 条断言全部通过`)
