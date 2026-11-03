// 定时提醒许可的判定测试：node test-remind-permit.mjs
// 只测纯逻辑（文件用临时路径），不启动微信、不碰 CUA。
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import {
  canSendWithPolicy, createPermitStore, findAllowedChat, findInputBox, newPermitId, provideWxService,
} from './lib/reminder.js'
import { parseTree } from './lib/tree.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const T = Date.UTC(2026, 10, 3, 4, 0, 0) // 2026-11-03T04:00:00Z
let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

const file = () => join(tmpdir(), `dsh-wx-permit-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
const storeAt = (now = T) => createPermitStore({ file: file(), now: () => now, log: () => {} })

console.log('名单')
t('总开关关着 → 不能发', () => {
  const r = canSendWithPolicy({ enabled: false, allowChats: ['测试群A'] }, '测试群A')
  assert.equal(r.ok, false)
  assert.match(r.why, /关闭/)
})
t('允许名单里的名字返回策略里的标准写法', () => {
  assert.equal(findAllowedChat({ allowChats: ['测试群A'], noMentionChats: [] }, ' 测试群A '), '测试群A')
  assert.deepEqual(canSendWithPolicy({ enabled: true, allowChats: ['测试群A'] }, '测试群A'), { ok: true, chat: '测试群A' })
})
t('免 @ 名单也算能发；两张都不在就不行', () => {
  assert.deepEqual(
    canSendWithPolicy({ enabled: true, allowChats: [], noMentionChats: ['某个猫'] }, '某个猫'),
    { ok: true, chat: '某个猫' },
  )
  assert.equal(canSendWithPolicy({ enabled: true, allowChats: ['测试群A'] }, '别的群').ok, false)
})

console.log('许可')
t('发一张 → 查得到，会话和原文都对得上', () => {
  const s = storeAt()
  const g = s.grant({ id: 'permit-0001', chat: '测试群A', text: '到点了，喝水', dueAt: T + 30 * 60_000 })
  assert.equal(g.ok, true)
  assert.equal(g.expiresAt, T + 30 * 60_000 + 12 * 60 * 60_000)
  const v = s.check({ id: 'permit-0001', chat: '测试群A', text: '到点了，喝水' })
  assert.equal(v.ok, true)
  assert.equal(v.permit.chat, '测试群A')
})
t('换会话 / 换原文 → 拒绝', () => {
  const s = storeAt()
  s.grant({ id: 'permit-0002', chat: '测试群A', text: '原文', dueAt: T + 60_000 })
  assert.equal(s.check({ id: 'permit-0002', chat: '别的群', text: '原文' }).ok, false)
  assert.match(s.check({ id: 'permit-0002', chat: '测试群A', text: '改过的' }).why, /不一致/)
})
t('用掉一次 → 第二次拒绝', () => {
  const s = storeAt()
  s.grant({ id: 'permit-0003', chat: '测试群A', text: '原文', dueAt: T + 60_000 })
  assert.equal(s.consume({ id: 'permit-0003', chat: '测试群A', text: '原文' }).ok, true)
  const again = s.check({ id: 'permit-0003', chat: '测试群A', text: '原文' })
  assert.equal(again.ok, false)
  assert.match(again.why, /用过/)
})
t('到点后过了宽限 → 过期', () => {
  const f = file()
  const s = createPermitStore({ file: f, now: () => T, log: () => {} })
  s.grant({ id: 'permit-0004', chat: '测试群A', text: '原文', dueAt: T + 60_000, ttlMs: 60_000 })
  // 用同一个文件、把时钟拨到宽限之后
  const later = createPermitStore({ file: f, now: () => T + 3 * 60_000, log: () => {} })
  assert.equal(later.check({ id: 'permit-0004', chat: '测试群A', text: '原文' }).ok, false)
})
t('过期 / 用过太久会被清掉；取消能删掉', () => {
  const s = storeAt()
  s.grant({ id: 'permit-0005', chat: '测试群A', text: '原文', dueAt: T + 60_000 })
  assert.equal(s.list().length, 1)
  assert.equal(s.revoke('permit-0005').ok, true)
  assert.equal(s.list().length, 0)

  assert.equal(s.grant({ id: 'permit-0006', chat: '测试群A', text: '原文', dueAt: T - 60_000, ttlMs: 1000 }).ok, false, '到点时间已过，不该发许可')
})
t('新 id 是 UUID，重复 id 不许覆盖', () => {
  const s = storeAt()
  assert.match(newPermitId(), /^[0-9a-f-]{36}$/)
  assert.match(randomUUID(), /^[0-9a-f-]{36}$/)
  assert.equal(s.grant({ id: newPermitId(), chat: '测试群A', text: '原文', dueAt: T + 60_000 }).ok, true)
  const id = s.list()[0].id
  assert.equal(s.grant({ id, chat: '测试群A', text: '另一句', dueAt: T + 60_000 }).ok, false)
})

console.log('输入框')
t('从 fixture 的树里找到底部那个 text（内容是当前会话名）', () => {
  const raw = readFileSync(fileURLToPath(new URL('./fixtures/tree-sample.txt', import.meta.url)), 'utf8')
  const parsed = parseTree(raw)
  const box = findInputBox(parsed)
  assert.ok(box, '应该找到输入框')
  assert.equal(box.label, '测试群A')
  assert.equal(box.box.cy, 804)
})
t('没有同名文本时，取底部最宽的一条', () => {
  const parsed = {
    current: '测试群A',
    clickables: [
      { role: 'text', label: '顶部标题', box: { x: 0, y: 10, w: 600, h: 30, cx: 300, cy: 25 } },
      { role: 'text', label: '输入区', box: { x: 0, y: 700, w: 500, h: 40, cx: 250, cy: 720 } },
    ],
  }
  assert.equal(findInputBox(parsed).label, '输入区')
})

console.log('服务')
t('provideWxService 把窄接口挂到 ctx.provide 上', () => {
  let got = null
  const ctx = { provide: (name, value) => { got = { name, value }; return () => { got.disposed = true } } }
  const r = provideWxService(ctx, { canSend: () => ({ ok: true, chat: '测试群A' }) })
  assert.equal(r.ok, true)
  assert.equal(got.name, 'wx')
  assert.equal(got.value.canSend('测试群A').ok, true)
  r.dispose()
  assert.equal(got.disposed, true)
})
t('没有 ctx.provide 时只回 ok:false，不抛', () => {
  const r = provideWxService({}, {})
  assert.equal(r.ok, false)
  assert.match(r.why, /provide/)
})

console.log(`\n${n} 条断言全部通过`)
