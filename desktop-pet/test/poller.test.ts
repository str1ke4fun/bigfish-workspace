import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPoller, createStateForwarder } from '../electron/poller.ts'

const okState = { at: 1, presence: null, activity: null, action: null }

/** 断线/超时是测试里有意制造的失败，别把日志打到测试输出里。 */
function muteConsoleError() {
  const original = console.error
  let calls = 0
  console.error = () => { calls += 1 }
  return {
    calls: () => calls,
    restore: () => { console.error = original },
  }
}

test('成功时 onState，失败时 onError 并退避，不抛', async () => {
  const mute = muteConsoleError()
  const delays: number[] = []
  let calls = 0
  let states = 0
  let errors = 0
  const p = createPoller({
    url: 'http://127.0.0.1:8788/api/fish/pet/state',
    intervalMs: 2000,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new Error('down')
      return new Response(JSON.stringify(okState), { status: 200 })
    },
    schedule: (_fn, ms) => { delays.push(ms); return 0 },
    cancel: () => {},
    onState: () => { states += 1 },
    onError: () => { errors += 1 },
  })
  try {
    await p.tick()
    assert.equal(errors, 1)
    assert.equal(delays[0], 2000)
    await p.tick()
    assert.equal(states, 1)
    assert.equal(mute.calls(), 1, '整段断线只记一次首次失败')
  } finally {
    mute.restore()
    p.stop()
  }
})

test('单次请求超时会中止并进入退避，不卡住轮询', async () => {
  const mute = muteConsoleError()
  const delays: number[] = []
  let calls = 0
  let errors = 0
  const p = createPoller({
    url: 'http://127.0.0.1:8788/api/fish/pet/state',
    intervalMs: 2000,
    requestTimeoutMs: 25,
    fetchImpl: (_url, init) => new Promise<Response>((_resolve, reject) => {
      calls += 1
      // BFF 接了连接却永不响应：只有请求级的 signal 会中止它。
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
    schedule: (_fn, ms) => { delays.push(ms); return 0 },
    cancel: () => {},
    onState: () => { throw new Error('超时不应上报状态') },
    onError: () => { errors += 1 },
  })
  // 修复前没有请求超时，用 watchdog 结束挂起的 tick，让失败断言能落地。
  const watchdog = setTimeout(() => p.stop(), 500)
  try {
    await p.tick()
    assert.equal(calls, 1)
    assert.equal(errors, 1)
    assert.equal(delays[0], 2000)
    assert.equal(mute.calls(), 1)
  } finally {
    clearTimeout(watchdog)
    mute.restore()
    p.stop()
  }
})

test('状态不变时不重复推送，ready 时补发缓存', () => {
  const sent: unknown[] = []
  const forward = createStateForwarder((state) => { sent.push(state) })
  const a = { at: 1, presence: null, activity: { state: 'thinking', at: 1, sessionId: 's' }, action: null }
  forward.onState(a)
  forward.onState({ ...a, at: 2 })
  assert.equal(sent.length, 1, '只差 at 不算变化')
  forward.resend()
  assert.equal(sent.length, 2, 'ready 补发绕过去重')
  assert.deepEqual(sent[1], { ...a, at: 2 })
})

test('还没有任何状态时 ready 不补发', () => {
  const sent: unknown[] = []
  const forward = createStateForwarder((state) => { sent.push(state) })
  forward.resend()
  assert.equal(sent.length, 0)
})
