import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planChatNavigation } from '../lib/tree.js'

const row = (name, cx = 10, cy = 20) => ({ name, box: { cx, cy } })
const partial = { status: 'partial', ok: false, chats: 0 }
const healthy = (chats) => ({ status: 'ok', ok: true, chats })

test('已经在目标会话：不需要导航', () => {
  const plan = planChatNavigation({
    parsed: { ok: true, current: '星晓家园10号楼1302', chats: [] },
    target: '星晓家园10号楼1302',
    tree: partial,
  })
  assert.equal(plan.action, 'current')
})

test('目标在侧栏里：返回可点击的行', () => {
  const hit = row('星晓家园10号楼1302')
  const plan = planChatNavigation({
    parsed: { ok: true, current: '别的群', chats: [row('别的群'), hit] },
    target: '星晓家园10号楼1302',
    tree: healthy(2),
  })
  assert.equal(plan.action, 'navigate')
  assert.equal(plan.target, hit)
})

test('树 partial、会话列表为空：判为不可读，而不是 not found', () => {
  const plan = planChatNavigation({
    parsed: { ok: true, current: 'cat不到flag的cat', chats: [] },
    target: '星晓家园10号楼1302',
    tree: partial,
  })
  assert.equal(plan.action, 'unreadable')
  assert.equal(plan.treeStatus, 'partial')
  assert.equal(plan.chatCount, 0)
})

test('树健康但目标不在侧栏：判为 missing', () => {
  const plan = planChatNavigation({
    parsed: { ok: true, current: '别的群', chats: [row('别的群'), row('另一个群')] },
    target: '星晓家园10号楼1302',
    tree: healthy(2),
  })
  assert.equal(plan.action, 'missing')
  assert.equal(plan.chatCount, 2)
})

test('没有树健康信息、列表也为空：保守判为不可读', () => {
  const plan = planChatNavigation({
    parsed: { ok: true, current: '别的群', chats: [] },
    target: '星晓家园10号楼1302',
  })
  assert.equal(plan.action, 'unreadable')
})

test('树不健康但 OCR 已读到目标行：仍可导航', () => {
  const hit = row('星晓家园10号楼1302')
  const plan = planChatNavigation({
    parsed: { ok: true, current: '别的群', chats: [hit] },
    target: '星晓家园10号楼1302',
    tree: partial,
  })
  assert.equal(plan.action, 'navigate')
  assert.equal(plan.target, hit)
})
