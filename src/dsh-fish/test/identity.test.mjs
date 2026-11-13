/**
 * identity.test.mjs —— 身份走 system prompt，不走对话（2026-10-25 改）
 *
 * 背景（用户 m04984）：他在面板里看见她每轮都带着「规则约束 / 人格设定」，要求
 * 除开发环境外，用户绝对看不到提示词。
 *
 * 根因（内核 0.2.1-rc.3 已核实）：`home/AGENTS.md` 走的是宿主的「工作区指令」，
 * 注入的是**普通 user 消息**、带 `<system-reminder>` 外壳、留在对话历史里。
 * 现在改成 `agent.ctx.systemPrompt.section(...)`：system 角色消息、不进历史。
 *
 * 这个文件守三件事：
 *   1. 落盘副本换了名字（不叫 AGENTS.md，否则又会被注入）；
 *   2. 旧的 AGENTS.md 会被删掉（迁移），不然它继续注入，等于没改；
 *   3. 身份段只在**她那个 agent** 上注册，且拿不到 systemPrompt 时降级不崩。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  IDENTITY_ORDER,
  IDENTITY_SECTION,
  INBOX_ORDER,
  INBOX_SECTION,
  OWNER_ORDER,
  OWNER_SECTION,
  REMIND_ORDER,
  REMIND_SECTION,
  WAKE_ORDER,
  WAKE_SECTION,
  attachIdentity,
  clearWakeSection,
  identityText,
  registerIdentity,
  resetIdentityCache,
  setWakeSection,
} from '../lib/identity.js'
import { legacySelfDocPath, ownerDocPath, selfDocPath, writeSelfDoc } from '../lib/selfdoc.js'
import { appendEvent } from '../lib/store.js'
import { DEFAULTS } from '../lib/settings.js'
import { BELIEF_SHOWN, SELF_DOC_BUDGET } from '../lib/persona.js'

const INDEX = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const CLIENT = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const SAY = fs.readFileSync(new URL('../lib/say.js', import.meta.url), 'utf8')

const tmp = () => fs.mkdtempSync(join(os.tmpdir(), 'fish-identity-'))

test('落盘副本叫「她的身份.md」，不再叫 AGENTS.md', () => {
  const root = tmp()
  assert.ok(selfDocPath(root).endsWith('她的身份.md'))
  assert.ok(!selfDocPath(root).endsWith('AGENTS.md'), 'AGENTS.md 会被宿主当指令注入，不能用这个名')
  assert.ok(legacySelfDocPath(root).endsWith('AGENTS.md'))
})

test('identityText：文件不存在返回空串，不抛', () => {
  resetIdentityCache()
  const root = tmp()
  assert.equal(identityText(root), '')
})

test('identityText：读到文件内容，改文件后（mtime 变）能拿到新内容', async () => {
  resetIdentityCache()
  const root = tmp()
  const file = selfDocPath(root)
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(file, '第一版身份', 'utf8')
  assert.equal(identityText(root), '第一版身份')

  // 改内容并把 mtime 推开（同毫秒写入在部分文件系统上 mtime 不变）
  fs.writeFileSync(file, '第二版身份', 'utf8')
  const later = new Date(Date.now() + 5000)
  fs.utimesSync(file, later, later)
  assert.equal(identityText(root), '第二版身份')
})

test('attachIdentity：挂五段——身份 + 处境 + 提醒说明 + 任务摘要 + 关于他', () => {
  resetIdentityCache()
  clearWakeSection()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  const calls = []
  const agent = { ctx: { systemPrompt: { section: (o) => calls.push(o) } } }
  const r = attachIdentity(agent, root, { inboxText: () => 't_1｜测试群A｜未回' })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 5, '身份 + 处境 + 提醒说明 + 任务摘要 + 关于他')
  const sec = calls[0]
  assert.equal(sec.name, IDENTITY_SECTION)
  assert.equal(sec.order, IDENTITY_ORDER)
  assert.equal(typeof sec.text, 'function', 'text 必须是函数：每轮组装时现读，文件变了立即生效')
  assert.equal(sec.text(), '我是她')

  // 第二段：这一次的处境。平时空串（等于不存在），唤醒前才填。
  const wake = calls[1]
  assert.equal(wake.name, WAKE_SECTION)
  assert.equal(wake.order, WAKE_ORDER)
  assert.equal(typeof wake.text, 'function')
  assert.equal(wake.text(), '', '没唤醒时这段必须是空，否则他聊天时她还带着上一次的处境')
  setWakeSection('第 1 天，你醒了。')
  assert.equal(wake.text(), '第 1 天，你醒了。')
  clearWakeSection()
  assert.equal(wake.text(), '')

  // 第三段：定时提醒的工具说明。固定文本，不随唤醒清空。
  const remind = calls[2]
  assert.equal(remind.name, REMIND_SECTION)
  assert.equal(remind.order, REMIND_ORDER)
  assert.equal(typeof remind.text, 'function')
  assert.match(remind.text(), /her_remind/)
  assert.match(remind.text(), /wx_send/)

  // 第四段：任务摘要。有任务才出标题，没有就是空串。
  const inbox = calls[3]
  assert.equal(inbox.name, INBOX_SECTION)
  assert.equal(inbox.order, INBOX_ORDER)
  assert.equal(typeof inbox.text, 'function')
  assert.match(inbox.text(), /t_1/)
  assert.match(inbox.text(), /还没回完/)

  // 第五段：关于他（owner 身份事实）。没有「关于他.md」时也是空串。
  const owner = calls[4]
  assert.equal(owner.name, OWNER_SECTION)
  assert.equal(owner.order, OWNER_ORDER)
  assert.equal(typeof owner.text, 'function')
  assert.equal(owner.text(), '')

  assert.equal(attachIdentity(agent, root, { inboxText: () => '' }).ok, true)
  assert.equal(calls[8].name, INBOX_SECTION, '第二次 attach 的五段从下标 5 开始')
  assert.equal(calls[8].text(), '')
  assert.equal(calls[9].name, OWNER_SECTION)
})

test('writeSelfDoc 额外写「关于他.md」，身份文档里不出现别名', async () => {
  const root = tmp()
  await appendEvent({
    type: 'person_note',
    text: '微信私聊名「cat不到flag的cat」是他。',
    person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
    refs: [], flags: ['identity'],
  }, { day: 1, stage: 1, source: 'system' }, root)

  const first = await writeSelfDoc(root)
  assert.equal(first.ok, true)
  assert.equal(first.ownerFile, ownerDocPath(root))
  assert.equal(first.ownerChanged, true)
  assert.equal(first.ownerWhy, '')

  const owner = fs.readFileSync(ownerDocPath(root), 'utf8')
  assert.match(owner, /cat不到flag的cat/)
  assert.match(owner, /微信私聊/)
  const identity = fs.readFileSync(selfDocPath(root), 'utf8')
  assert.doesNotMatch(identity, /cat不到flag的cat/, 'owner 事实只进 fish:owner，不进全局身份文档')

  const second = await writeSelfDoc(root)
  assert.equal(second.ownerChanged, false, '内容没变就不重写')
})

test('fish:owner：web/wx 有内容，bili/qq 为空；没有 owner 文档时为空串', async () => {
  const root = tmp()
  await appendEvent({
    type: 'person_note',
    text: '微信私聊名「cat不到flag的cat」是他。',
    person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
    refs: [], flags: ['identity'],
  }, { day: 1, stage: 1, source: 'system' }, root)
  await writeSelfDoc(root)
  resetIdentityCache()

  const ownerTextFor = (atRoot, surface) => {
    const sections = []
    const agent = { ctx: { systemPrompt: { section: (o) => sections.push(o) } } }
    assert.equal(attachIdentity(agent, atRoot, { surfaceOf: () => surface }).ok, true)
    return sections.find((s) => s.name === OWNER_SECTION).text()
  }

  assert.match(ownerTextFor(root, 'web'), /cat不到flag的cat/)
  assert.match(ownerTextFor(root, 'wx'), /cat不到flag的cat/)
  assert.equal(ownerTextFor(root, 'bili'), '')
  assert.equal(ownerTextFor(root, 'qq'), '')
  assert.equal(ownerTextFor(root, ''), '')

  resetIdentityCache()
  const emptyRoot = tmp()
  assert.equal(ownerTextFor(emptyRoot, 'web'), '', '没有「关于他.md」时是空串，不抛')
})

test('attachIdentity：不是微信那条会话时，提醒说明和任务摘要都返回空串', () => {
  resetIdentityCache()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')
  const calls = []
  const agent = { ctx: { systemPrompt: { section: (o) => calls.push(o) } } }
  assert.equal(attachIdentity(agent, root, { canRemind: () => false, inboxText: () => 't_1' }).ok, true)
  assert.equal(calls[2].text(), '')
  assert.equal(calls[3].text(), '')
  assert.equal(attachIdentity(agent, root, { canRemind: () => true, inboxText: () => 't_1' }).ok, true)
  assert.match(calls[7].text(), /her_remind/)
  assert.match(calls[8].text(), /t_1/)
})

test('处境段按会话分开：home 和 B 站出门会话各看各的，互不串', () => {
  resetIdentityCache()
  clearWakeSection()
  const root = tmp()
  fs.mkdirSync(join(root, 'home'), { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  const sectionFor = (id) => {
    const calls = []
    const agent = { session: { header: { id } }, ctx: { systemPrompt: { section: (o) => calls.push(o) } } }
    assert.equal(attachIdentity(agent, root, { inboxText: () => '' }).ok, true)
    return calls[1].text
  }
  const homeWake = sectionFor('ses-home')
  const biliWake = sectionFor('ses-bili')

  setWakeSection('屋子里的事', 'ses-home')
  setWakeSection('外面的事', 'ses-bili')
  assert.equal(homeWake(), '屋子里的事')
  assert.equal(biliWake(), '外面的事')
  // 不传 sessionId 的旧调用仍写全局；没有自己那条的会话退回全局
  setWakeSection('全局的处境')
  assert.equal(sectionFor('ses-other')(), '全局的处境')
  assert.equal(homeWake(), '屋子里的事', '有自己那条的会话不看全局')
  // 只清一条：另一条和全局都还在
  clearWakeSection('ses-bili')
  assert.equal(biliWake(), '全局的处境')
  assert.equal(homeWake(), '屋子里的事')
  clearWakeSection()
  assert.equal(homeWake(), '')
  assert.equal(biliWake(), '')
})

test('attachIdentity：没有 systemPrompt 时返回 ok:false，不抛', () => {
  const r = attachIdentity({ ctx: {} }, tmp())
  assert.equal(r.ok, false)
  assert.match(r.why, /systemPrompt/)
  const r2 = attachIdentity(undefined, tmp())
  assert.equal(r2.ok, false)
})

test('registerIdentity：只给她那个 agent 挂（按 cwd 判），别人不受影响', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  let handler = null
  const ctx = { on: (evt, fn) => { assert.equal(evt, 'agent/created'); handler = fn; return () => {} } }
  const off = registerIdentity(ctx, { root, herDir, log: () => {} })
  assert.equal(typeof off, 'function')
  assert.equal(typeof handler, 'function')

  const mine = []
  handler({ agent: { session: { header: { cwd: herDir } }, ctx: { systemPrompt: { section: (o) => mine.push(o) } } } })
  const others = []
  handler({ agent: { session: { header: { cwd: join(root, 'other') } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })
  handler({ agent: { session: { header: { cwd: '' } }, ctx: { systemPrompt: { section: (o) => others.push(o) } } } })

  assert.equal(mine.length, 5, '她那条会话必须挂上（身份 + 处境 + 提醒说明 + 任务摘要 + 关于他五段）')
  assert.equal(others.length, 0, '用户自己的会话不许挂')
})

test('registerIdentity：任务摘要从 wx 服务现取', () => {
  resetIdentityCache()
  const root = tmp()
  const herDir = join(root, 'home')
  fs.mkdirSync(herDir, { recursive: true })
  fs.writeFileSync(selfDocPath(root), '我是她', 'utf8')

  let handler = null
  const ctx = {
    on: (_evt, fn) => { handler = fn; return () => {} },
    get: (name) => (name === 'wx'
      ? { isWxSession: () => true, inboxSummary: () => 't_9｜测试群A｜未回' }
      : undefined),
  }
  registerIdentity(ctx, { root, herDir, log: () => {} })
  const sections = []
  handler({ agent: { session: { header: { id: 'wx-1', cwd: herDir } }, ctx: { systemPrompt: { section: (o) => sections.push(o) } } } })
  const inbox = sections.find((s) => s.name === INBOX_SECTION)
  assert.ok(inbox)
  assert.match(inbox.text(), /t_9/)
})

test('registerIdentity：ctx.on 不可用时返回空函数，不抛', () => {
  const off = registerIdentity({}, { root: tmp(), herDir: tmp(), log: () => {} })
  assert.equal(typeof off, 'function')
  off()
})

test('index.js：先写身份文本、再注册身份段、最后才建屋子', () => {
  const iPre = INDEX.indexOf('await writeSelfDoc(root')
  const iReg = INDEX.indexOf('registerIdentity(ctx')
  const iHome = INDEX.indexOf('await bootstrapHomeWithRetry(')
  assert.ok(iPre > 0 && iReg > 0 && iHome > 0)
  assert.ok(iPre < iReg, '文本要先生成，否则她第一轮拿到空串')
  assert.ok(iReg < iHome, '必须早于 bootstrapHome：她那条会话就是在里面创建的')
  assert.ok(!/身份文件：宿主每轮会重读它/.test(INDEX), '旧注释里「宿主每轮重读」已经不成立')
})

test('默认预算 1200 → 1800，且三处（配置、常量、界面）一致', () => {
  assert.equal(DEFAULTS.memory.docBudget, 1800)
  assert.equal(SELF_DOC_BUDGET, 1800)
  assert.ok(CLIENT.includes('useState(1800)'), '界面初始值要跟着改')
  assert.ok(CLIENT.includes("cfg.memory?.docBudget ?? 1800"))
  assert.ok(!CLIENT.includes('useState(1200)'), '旧的 1200 不许残留')
  // 判断区仍固定 3 条：这一条是「像工作记忆」，与预算无关
  assert.equal(BELIEF_SHOWN, 3)
})

test('say.js 不再把身份/工具说明塞进 user 消息（否则用户能在对话里看见）', () => {
  const say = SAY
  assert.ok(!/from '\.\/persona\.js'/.test(say), 'say.js 不该再 import persona')
  assert.ok(!say.includes('TOOL_BRIEF'), '工具说明由 system prompt 提供')
  assert.ok(!say.includes('personaLine'), '身份由 system prompt 提供')
  assert.ok(say.includes("const content = ['## 这次', '', ...parts]"))
})
