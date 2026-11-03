/**
 * 树健康判定、OCR 名字对账、初始化重启策略的边界。
 * 口径：初始化才允许重启；使用中掉树只提醒；登录页永远不重启。
 */
import assert from 'node:assert/strict'
import { reconcileChatName, treeAction, treeHealth, treeMatchesOcr } from './lib/tree.js'

const head = (w, h, n) => `微信窗口 ${w}x${h} 原点(261,117) · 元素 ${n} 个 · 缩放 1.0417`
const parsed = (w, chats = [], ok = true) => ({ ok, window: { w, h: 666, ox: 261, oy: 117, scale: 1.0417 }, current: '', chats })

// ---- treeHealth ----
assert.equal(treeHealth('', null).status, 'down')
assert.equal(treeHealth('', null).ok, false)

const collapsed = treeHealth(head(916, 666, 1), parsed(916))
assert.equal(collapsed.status, 'down')
assert.equal(collapsed.elements, 1)

assert.equal(treeHealth(head(916, 666, 335), parsed(916)).status, 'partial')
assert.equal(treeHealth(head(916, 666, 44), parsed(916, [{ name: '内部赤石群' }])).status, 'ok')
assert.equal(treeHealth(head(291, 396, 30), parsed(291)).status, 'login')

// ---- reconcileChatName ----
const names = ['内部赤石群', '星晓家园10号楼1302', '我需要重新集结部队']
assert.equal(reconcileChatName('星晓家园10号楼1302', names), '星晓家园10号楼1302')
assert.equal(reconcileChatName(' 星晓家园10号楼1302 ', names), '星晓家园10号楼1302')
assert.equal(reconcileChatName('星晓家园10号楼13...', names), '星晓家园10号楼1302')
assert.equal(reconcileChatName('星晓家园10号楼13…', names), '星晓家园10号楼1302')
assert.equal(reconcileChatName('星晓家园10号楼', names), '星晓家园10号楼1302')
assert.equal(reconcileChatName('星晓家园10号楼1303', names), '星晓家园10号楼1303') // 对不上就不改
assert.equal(reconcileChatName('星', names), '星') // 太短不猜
assert.equal(reconcileChatName('', names), '')
// 名字撞前缀（两个候选）时不许猜
assert.equal(reconcileChatName('星晓家园10号楼13', ['星晓家园10号楼1302', '星晓家园10号楼1303']), '星晓家园10号楼13')

// ---- treeMatchesOcr ----
const treeRows = (...names) => ({ chats: names.map((name) => ({ name })) })
const asTree = treeRows('微信ClawBot', 'File Transfer', '星晓家园10号楼1302', 'cat不到flag的cat', 'Tencent News', '内部赤石群')

// 实测：OCR 只读到 6/9 行，名字还会把时间粘进来、被截断
const ocrRows = treeRows('微信ClawBot', 'File Transfer Yesterday', '星晓家园10号楼', 'Tencent News')
assert.equal(treeMatchesOcr(asTree, ocrRows), true)

// 顺序对不上 = 列表重排而树没跟上，是真落后
assert.equal(treeMatchesOcr(asTree, treeRows('Tencent News', '微信ClawBot', 'File Transfer', '星晓家园10号楼')), false)

// 屏幕上出现了树里没有的会话（新消息把会话顶上来）= 树落后
assert.equal(treeMatchesOcr(asTree, treeRows('新群A', '新群B', '新群C', '微信ClawBot')), false)

// OCR 行太少或读不成：不下结论
assert.equal(treeMatchesOcr(asTree, treeRows('微信ClawBot', 'File Transfer')), false)
assert.equal(treeMatchesOcr(asTree, treeRows()), false)
assert.equal(treeMatchesOcr(treeRows(), ocrRows), false)
// 一行能对上、其余是乱码：不够比例
assert.equal(treeMatchesOcr(asTree, treeRows('微信ClawBot', '??', '###', '...')), false)

// ---- treeAction ----
const now = 1_800_000_000_000
const ok = treeAction({ health: { status: 'ok' }, phase: 'init', now })
assert.equal(ok.phase, 'steady')
assert.equal(ok.restart, false)

const first = treeAction({ health: { status: 'down' }, phase: 'init', now })
assert.equal(first.restart, true)
assert.equal(first.attempt, 1)

const cooling = treeAction({ health: { status: 'down' }, phase: 'init', attempts: 1, lastRestartAt: now - 10_000, now })
assert.equal(cooling.restart, false)
assert.equal(cooling.wait, true)

const settling = treeAction({ health: { status: 'down' }, phase: 'init', attempts: 1, retryAfter: now + 30_000, now })
assert.equal(settling.restart, false)
assert.equal(settling.wait, true)

// 只是会话列表空（比如微信停在通讯录页）：初始化也不重启，交给 OCR/提醒
const partialInit = treeAction({ health: { status: 'partial' }, phase: 'init', now })
assert.equal(partialInit.restart, false)
assert.match(partialInit.alert, /不自动重启/)

const second = treeAction({ health: { status: 'down' }, phase: 'init', attempts: 1, lastRestartAt: now - 60_000, now })
assert.equal(second.restart, true)
assert.equal(second.attempt, 2)

const exhausted = treeAction({ health: { status: 'down' }, phase: 'init', attempts: 2, lastRestartAt: now - 60_000, now })
assert.equal(exhausted.restart, false)
assert.equal(exhausted.exhausted, true)
assert.equal(exhausted.phase, 'steady')

// 使用中掉树：无论多少次都不重启
const steadyDown = treeAction({ health: { status: 'down' }, phase: 'steady', attempts: 0, now })
assert.equal(steadyDown.restart, false)
assert.match(steadyDown.alert, /不自动重启/)
const steadyPartial = treeAction({ health: { status: 'partial' }, phase: 'steady', attempts: 0, now })
assert.equal(steadyPartial.restart, false)
assert.match(steadyPartial.alert, /不自动重启/)

// 登录页永不重启
const login = treeAction({ health: { status: 'login' }, phase: 'init', now })
assert.equal(login.restart, false)
assert.equal(login.login, true)

console.log('test-tree-recovery: ok')
