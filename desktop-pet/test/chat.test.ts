import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendChat } from '../renderer/chat.ts'

test('sendChat 明确区分成功/失败', async () => {
  const ok = await sendChat('在吗', { fetchImpl: async () => new Response(JSON.stringify({ ok:true, herReply:'在。', note:'' }), { status:200 }) })
  assert.deepEqual(ok, { ok:true, herReply:'在。', note:'' })
  const bad = await sendChat('在吗', { fetchImpl: async () => new Response('{}', { status:502 }) })
  assert.equal(bad.ok, false)
})

test('只发用户原话与陪伴目标：POST /api/fish/say，body 为 { text, target: "companion" }', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  const out = await sendChat('在吗', {
    target: 'companion',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), init: init ?? {} }
      return new Response(JSON.stringify({ ok: true, herReply: '在。', note: '' }), { status: 200 })
    },
  })
  assert.equal(out.ok, true)
  assert.ok(seen)
  assert.equal(seen.url, 'http://127.0.0.1:8788/api/fish/say')
  assert.equal(seen.init.method, 'POST')
  assert.deepEqual(JSON.parse(String(seen.init.body)), { text: '在吗', target: 'companion' })
})

test('桌宠默认就走陪伴会话：不显式传 target 时也发 companion', async () => {
  let body: unknown = null
  await sendChat('在吗', {
    fetchImpl: async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ ok: true, herReply: '在。', note: '' }), { status: 200 })
    },
  })
  assert.deepEqual(body, { text: '在吗', target: 'companion' })
})

test('HTTP 200 但 BFF 说没送到时也按失败返回', async () => {
  const out = await sendChat('在吗', {
    fetchImpl: async () => new Response(
      JSON.stringify({ ok: false, herReply: '', note: '宿主没有会话服务，说不了。' }),
      { status: 200 },
    ),
  })
  assert.equal(out.ok, false)
  assert.equal(out.herReply, '')
  assert.match(out.note, /说不了/)
})

test('超时会中止请求并按失败返回', async () => {
  let aborted = false
  const out = await sendChat('在吗', {
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        aborted = true
        reject(init.signal?.reason)
      }, { once: true })
    }),
  })
  assert.equal(aborted, true)
  assert.equal(out.ok, false)
  assert.equal(out.herReply, '')
  assert.match(out.note, /等太久/)
})
