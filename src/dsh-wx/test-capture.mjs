// 采集配置、服务号过滤、入队与暂停判定：node test-capture.mjs
// 只测纯函数；不启动微信、不读屏、不写台账。
import assert from 'node:assert/strict'

import {
  DEFAULT_IGNORE_CHATS,
  captureSettings,
  isIgnoredChat,
  previewSig,
  shouldEnqueue,
  pauseReason,
} from './lib/capture.js'

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name) }

console.log('采集配置')
t('缺省值与 spec 一致', () => {
  assert.deepEqual(captureSettings({}), {
    ignoreChats: [...DEFAULT_IGNORE_CHATS],
    preview: true,
    rotate: true,
    queueMax: 20,
    chatCooldownSec: 60,
    maxScrollPages: 3,
    quietMs: 10000,
    ocrEveryMs: 20000,
  })
  assert.equal(DEFAULT_IGNORE_CHATS.length, 8)
  assert.equal(DEFAULT_IGNORE_CHATS.includes('Tencent News'), true)
})
t('显式 ignoreChats 照用，空数组就是空', () => {
  assert.equal(captureSettings({ ignoreChats: [] }).ignoreChats.length, 0)
  assert.deepEqual(captureSettings({ ignoreChats: ['自定义'] }).ignoreChats, ['自定义'])
})
t('数值 clamp 到 spec 范围', () => {
  const c = captureSettings({ capture: { queueMax: 0, chatCooldownSec: -5, maxScrollPages: 99, quietMs: 9999999, ocrEveryMs: -1 } })
  assert.equal(c.queueMax, 1)
  assert.equal(c.chatCooldownSec, 0)
  assert.equal(c.maxScrollPages, 10)
  assert.equal(c.quietMs, 600000)
  assert.equal(c.ocrEveryMs, 0)
  assert.equal(captureSettings({ capture: { queueMax: 999 } }).queueMax, 100)
  assert.equal(captureSettings({ capture: { chatCooldownSec: 9999 } }).chatCooldownSec, 3600)
})
t('布尔项只有显式 false 才关', () => {
  const c = captureSettings({ capture: { preview: false, rotate: false } })
  assert.equal(c.preview, false)
  assert.equal(c.rotate, false)
  assert.equal(captureSettings({ capture: { preview: 0, rotate: '' } }).preview, true)
  assert.equal(captureSettings({ capture: { preview: 0, rotate: '' } }).rotate, true)
})

console.log('服务号过滤')
t('trim、压空格、ASCII 小写后精确比较', () => {
  assert.equal(isIgnoredChat(' tencent   news ', DEFAULT_IGNORE_CHATS), true)
  assert.equal(isIgnoredChat('TENCENT NEWS', DEFAULT_IGNORE_CHATS), true)
  assert.equal(isIgnoredChat('微信团队', DEFAULT_IGNORE_CHATS), true)
})
t('前缀相同的正常群不误伤', () => {
  assert.equal(isIgnoredChat('Tencent News 讨论组', DEFAULT_IGNORE_CHATS), false)
})
t('空名单不忽略任何会话', () => {
  assert.equal(isIgnoredChat('Tencent News', []), false)
  assert.equal(isIgnoredChat('', []), false)
})

console.log('预览指纹')
t('未读、时间、预览按竖线拼接', () => {
  assert.equal(previewSig({ unread: 2, time: '14:02', preview: '张三: hi' }), '2|14:02|张三: hi')
})
t('缺字段用空值与 0', () => {
  assert.equal(previewSig({}), '0||')
  assert.equal(previewSig({ unread: 3 }), '3||')
})

console.log('入队判定')
const row = { name: '群A', unread: 0, preview: 'x', time: '14:02' }
const enqueueReq = (over = {}) => ({
  row,
  sig: '0|14:02|x',
  prevSig: '0|14:02|x',
  capturedSinceStart: true,
  lastCaptureAt: 0,
  now: 1000,
  cooldownMs: 60000,
  allowChats: ['群A'],
  ignoreChats: [],
  ...over,
})
t('指纹没变就不入队', () => {
  assert.deepEqual(shouldEnqueue(enqueueReq()), { enqueue: false, reason: 'unchanged' })
})
t('预览指纹变化 → changed', () => {
  assert.deepEqual(shouldEnqueue(enqueueReq({ prevSig: '0|13:00|old' })), { enqueue: true, reason: 'changed' })
})
t('有未读优先报 unread', () => {
  const r = shouldEnqueue(enqueueReq({ row: { ...row, unread: 3 }, sig: '3|14:02|x', prevSig: '0|14:02|x' }))
  assert.deepEqual(r, { enqueue: true, reason: 'unread' })
})
t('启动后还没采过 → first 优先于未读和变化', () => {
  assert.deepEqual(
    shouldEnqueue(enqueueReq({ capturedSinceStart: false, row: { ...row, unread: 3 } })),
    { enqueue: true, reason: 'first' },
  )
})
t('冷却期内有变化仍入队，dueAt=上次完成+冷却', () => {
  assert.deepEqual(
    shouldEnqueue(enqueueReq({ prevSig: '0|13:00|old', lastCaptureAt: 900000, now: 910000 })),
    { enqueue: true, reason: 'cooldown', dueAt: 960000 },
  )
  assert.deepEqual(
    shouldEnqueue(enqueueReq({ row: { ...row, unread: 2 }, sig: '2|14:02|x', prevSig: '0|14:02|x', lastCaptureAt: 900000, now: 910000 })),
    { enqueue: true, reason: 'cooldown', dueAt: 960000 },
  )
})
t('冷却期内没有变化信号就不入队', () => {
  assert.deepEqual(
    shouldEnqueue(enqueueReq({ lastCaptureAt: 900000, now: 910000 })),
    { enqueue: false, reason: 'unchanged' },
  )
})
t('有草稿不入队', () => {
  assert.deepEqual(shouldEnqueue(enqueueReq({ row: { ...row, draft: true }, prevSig: '0|13:00|old' })), { enqueue: false, reason: 'draft' })
})
t('不在 allowChats 不入队', () => {
  assert.deepEqual(shouldEnqueue(enqueueReq({ allowChats: [], prevSig: '0|13:00|old' })), { enqueue: false, reason: 'not-allowed' })
})
t('服务号不入队', () => {
  assert.deepEqual(
    shouldEnqueue(enqueueReq({
      row: { ...row, name: 'Tencent News' },
      prevSig: '0|13:00|old',
      allowChats: ['Tencent News'],
      ignoreChats: DEFAULT_IGNORE_CHATS,
    })),
    { enqueue: false, reason: 'ignored' },
  )
})
t('not-allowed 先于 ignored 判定', () => {
  assert.deepEqual(
    shouldEnqueue(enqueueReq({ row: { ...row, name: 'Tencent News' }, ignoreChats: DEFAULT_IGNORE_CHATS })),
    { enqueue: false, reason: 'not-allowed' },
  )
})

console.log('暂停判定')
const pause = (over = {}) => pauseReason({ policy: { enabled: true, watch: true }, treeStatus: 'ok', now: 1000, ...over })
t('policy 关闭或只读 → policy-off', () => {
  assert.equal(pause({ policy: { enabled: false } }), 'policy-off')
  assert.equal(pause({ policy: { enabled: true, watch: false } }), 'policy-off')
  assert.equal(pause({ policy: { enabled: false }, hostBusy: true }), 'policy-off')
})
t('登录页先于树状态', () => {
  assert.equal(pause({ login: true, treeStatus: 'partial' }), 'login')
})
t('树不是 ok → tree-<状态>', () => {
  assert.equal(pause({ treeStatus: 'partial' }), 'tree-partial')
})
t('树落后 → stale', () => {
  assert.equal(pause({ stale: true }), 'stale')
})
t('主机忙碌、正在交谈、发送中、有未投递命中依次暂停', () => {
  assert.equal(pause({ hostBusy: true }), 'host-busy')
  assert.equal(pause({ hostActive: true }), 'host-active')
  assert.equal(pause({ sending: true }), 'sending')
  assert.equal(pause({ pendingHits: 1 }), 'pending-hits')
})
t('发送结束后的静默期内暂停', () => {
  assert.equal(pause({ quietUntil: 2000 }), 'quiet')
  assert.equal(pause({ quietUntil: 1000 }), '')
})
t('一切正常不暂停', () => {
  assert.equal(pause(), '')
})

console.log(`\n${n} 项通过`)
