// 单次采集编排：node --test test-capture-run.mjs
// 用真实 createContextStore（临时台账目录）+ 假 io，不启动微信、不读屏、不联网。
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runCapture } from './lib/capture-run.js'
import { createContextStore } from './lib/context.js'
import { chatIdFor } from './lib/ledger.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'dsh-wx-capture-run-'))
const store = () => createContextStore({ dir: tmp(), log: () => {} })

const box = { x: 100, y: 100, w: 600, h: 60 }
const msg = (text, b = box) => ({ text, box: b })
const snap = (current, messages = [], chats = []) => ({
  parsed: { ok: true, current, chats, messages, window: { scale: 1 } },
})

/** 假 io：记录调用；read/open/scrollUp/restore/ocr 都可以按场景覆盖。 */
function ioOf({ read, open, scrollUp, ocr = { lines: [] }, restore = true, outboxFor } = {}) {
  const calls = { open: [], scrollUp: [], scrollDown: [], restore: [], mention: [] }
  return {
    calls,
    async read() { return typeof read === 'function' ? read() : read },
    async open(chat, before) {
      calls.open.push({ chat, before })
      return typeof open === 'function' ? open(chat, before) : null
    },
    async scrollUp(parsed) {
      calls.scrollUp.push(parsed)
      return typeof scrollUp === 'function' ? scrollUp(calls.scrollUp.length) : null
    },
    async scrollDown(parsed, times) { calls.scrollDown.push({ parsed, times }) },
    async ocrSpeakers() {
      if (ocr === 'throw') throw new Error('OCR 不可用')
      return ocr
    },
    async restore(prev) {
      calls.restore.push(prev)
      return typeof restore === 'function' ? restore(prev) : restore
    },
    async onMention(hit) { calls.mention.push(hit) },
    ...(typeof outboxFor === 'function' ? { outboxFor } : {}),
  }
}

test('1) 已经是当前会话：不点开、不恢复，正文入账', async () => {
  const contextStore = store()
  const io = ioOf({ read: snap('群A', [msg('你好')]) })

  const r = await runCapture({ job: { chat: '群A' }, io, contextStore })

  assert.equal(r.ok, true)
  assert.equal(r.added, 1)
  assert.equal(r.scrolled, 0)
  assert.equal(r.restored, false)
  assert.equal(io.calls.open.length, 0)
  assert.equal(io.calls.restore.length, 0)
  const docs = contextStore.ledger.recent(chatIdFor('群A'), 1)
  assert.equal(docs.length, 1)
  assert.equal(docs[0].text, '你好')
})

test('2) 别的会话 + 首次接触：点开、回滚两屏、恢复', async () => {
  const contextStore = store()
  const opened = snap('群A', [msg('最近一条')], [{ name: '群A', preview: '最近一条' }])
  const read = snap('群B', [])
  const io = ioOf({
    read,
    open: () => opened,
    scrollUp: (n) => {
      if (n === 1) return snap('群A', [msg('较早一条'), msg('最近一条')])
      if (n === 2) return snap('群A', [msg('更早一条'), msg('较早一条'), msg('最近一条')])
      return null
    },
    restore: true,
  })

  const r = await runCapture({
    job: { chat: '群A' }, io, contextStore, settings: { maxScrollPages: 3 },
  })

  assert.equal(r.ok, true)
  assert.equal(r.scrolled, 2)
  assert.equal(r.restored, true)
  assert.deepEqual(
    contextStore.ledger.recent(chatIdFor('群A'), 10).map((d) => d.text),
    ['更早一条', '较早一条', '最近一条'],
  )
  assert.deepEqual(io.calls.open, [{ chat: '群A', before: read }])
  assert.equal(io.calls.scrollDown.length, 1)
  assert.equal(io.calls.scrollDown[0].times, 2)
  assert.equal(io.calls.scrollDown[0].parsed, opened.parsed)
  assert.deepEqual(io.calls.restore, ['群B'])
})

test('3) 点不开：ok=false、why=open-failed，不写台账', async () => {
  const contextStore = store()
  const io = ioOf({ read: snap('群B', []), open: () => null })

  const r = await runCapture({ job: { chat: '群A' }, io, contextStore })

  assert.equal(r.ok, false)
  assert.equal(r.why, 'open-failed')
  assert.equal(contextStore.ledger.recent(chatIdFor('群A'), 5).length, 0)
  assert.equal(io.calls.scrollUp.length, 0)
})

test('4) OCR 抛错：仍入账，发言人为 null', async () => {
  const contextStore = store()
  const io = ioOf({ read: snap('群A', [msg('你好')]), ocr: 'throw' })

  const r = await runCapture({ job: { chat: '群A' }, io, contextStore })

  assert.equal(r.ok, true)
  assert.equal(r.added, 1)
  assert.deepEqual(r.ocrSenders, [])
  const docs = contextStore.ledger.recent(chatIdFor('群A'), 1)
  assert.equal(docs[0].sender, null)
})

test('5) OCR 命中名册：台账带发言人，ocrSenders 返回名字', async () => {
  const contextStore = store()
  const people = {
    resolve: (raw) => (raw === '张三' ? { name: '张三', matched: true } : { name: raw, matched: false }),
  }
  const io = ioOf({
    read: snap('群A', [msg('大家好')]),
    ocr: { lines: [{ text: '张三', x: 120, y: 105, w: 40, h: 14, conf: 90 }] },
  })

  const r = await runCapture({ job: { chat: '群A' }, io, contextStore, people })

  assert.equal(r.ok, true)
  assert.deepEqual(r.ocrSenders, ['张三'])
  const docs = contextStore.ledger.recent(chatIdFor('群A'), 1)
  assert.equal(docs[0].sender, '张三')
  assert.equal(docs[0].senderConfidence, 'medium')
})

test('6) 正文含 trigger：onMention 调用一次，hit 字段正确', async () => {
  const contextStore = store()
  const io = ioOf({ read: snap('群A', [msg('大肥鱼在吗'), msg('普通消息')]) })

  const r = await runCapture({
    job: { chat: '群A' }, io, contextStore, policy: { trigger: ['大肥鱼'] },
  })

  assert.equal(r.ok, true)
  assert.equal(io.calls.mention.length, 1)
  const hit = io.calls.mention[0]
  assert.equal(hit.chat, '群A')
  assert.equal(hit.chatId, chatIdFor('群A'))
  assert.equal(hit.preview, '大肥鱼在吗')
  assert.equal(hit.why, '@')
  assert.match(hit.key, /^capture:m_/)
  assert.match(hit.msgId, /^m_/)
})

test('7) 回滚后调用 io.scrollDown(parsed, 回滚次数)', async () => {
  const contextStore = store()
  const opened = snap('群A', [msg('最近一条')])
  const io = ioOf({
    read: snap('群B', []),
    open: () => opened,
    scrollUp: (n) => {
      if (n === 1) return snap('群A', [msg('较早一条'), msg('最近一条')])
      if (n === 2) return snap('群A', [msg('更早一条'), msg('较早一条'), msg('最近一条')])
      return null
    },
  })

  await runCapture({ job: { chat: '群A' }, io, contextStore })

  assert.equal(io.calls.scrollDown.length, 1)
  assert.equal(io.calls.scrollDown[0].parsed, opened.parsed)
  assert.equal(io.calls.scrollDown[0].times, 2)
})

test('8) 恢复失败：ok 仍为 true，日志含“恢复”', async () => {
  const contextStore = store()
  const logs = []
  const io = ioOf({
    read: snap('群B', []),
    open: () => snap('群A', [msg('你好')]),
    restore: false,
  })

  const r = await runCapture({
    job: { chat: '群A' }, io, contextStore, log: (line) => logs.push(line),
  })

  assert.equal(r.ok, true)
  assert.equal(r.added, 1)
  assert.equal(r.restored, false)
  assert.ok(logs.some((line) => line.includes('恢复')), `日志里应有恢复失败：${logs.join('|')}`)
})

test('9) 与台账末尾重叠：不再向上回滚', async () => {
  const contextStore = store()
  const chatId = chatIdFor('群A')
  contextStore.capture({ chat: '群A', chatId, messages: [{ text: '最近一条' }], source: 'capture' })

  const io = ioOf({ read: snap('群A', [msg('最近一条')]) })
  const r = await runCapture({ job: { chat: '群A' }, io, contextStore })

  assert.equal(r.ok, true)
  assert.equal(r.scrolled, 0)
  assert.equal(io.calls.scrollUp.length, 0)
  assert.equal(contextStore.ledger.recent(chatId, 1)[0].text, '最近一条')
})
