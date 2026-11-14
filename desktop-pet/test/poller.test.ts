import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPoller } from '../electron/poller.ts'

const okState = { at: 1, presence: null, activity: null, action: null }

test('成功时 onState，失败时 onError 并退避，不抛', async () => {
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
  await p.tick()
  assert.equal(errors, 1)
  assert.equal(delays[0], 2000)
  await p.tick()
  assert.equal(states, 1)
})
