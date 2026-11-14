import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideEffects } from '../renderer/controller.ts'

const base = { at: 1, presence: null, activity: null, action: null }
test('显式动作优先，过期不播', () => {
  const r = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, {
    ...base, action:{ id:'a1', motion:'success', text:null, at:1000, ttlMs:15000 },
  }, 2000)
  assert.equal(r.motion, 'success')
  const stale = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, {
    ...base, action:{ id:'a2', motion:'error', text:null, at:0, ttlMs:1000 },
  }, 2000)
  assert.notEqual(stale.motion, 'error')
})
test('同一评论只弹一次，新评论弹气泡', () => {
  const state = { ...base, presence:{ on:true, mode:'event', busy:false, snapshot:null, recent:[{ at:'2026-11-14T08:00:00Z', mode:'event', event:'scene_change', text:'你好' }] } }
  const a = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, state, 1)
  assert.equal(a.bubble?.text, '你好')
  const b = decideEffects(a.seen, state, 2)
  assert.equal(b.bubble, undefined)
})
test('activity 变化才切动作，动作过期后回落 activity', () => {
  const s = { ...base, activity:{ state:'thinking', at:1, sessionId:'s' } }
  const a = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, s, 2)
  assert.equal(a.motion, 'thinking')
  const b = decideEffects(a.seen, s, 3)
  assert.equal(b.motion, undefined)
  const act = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, {
    ...s, action:{ id:'a1', motion:'success', text:'好耶', at:10, ttlMs:100 },
  }, 20)
  assert.equal(act.motion, 'success')
  assert.equal(act.bubble?.text, '好耶')
  const back = decideEffects(act.seen, s, 200)
  assert.equal(back.motion, 'thinking')
})
test('settlement 评论用 success，其余用 waving', () => {
  const mk = (event: string) => ({ ...base, presence:{ on:true, mode:'event', busy:false, snapshot:null, recent:[{ at:'t', mode:'event', event, text:'x' }] } })
  assert.equal(decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, mk('settlement'), 1).bubble?.motion, 'success')
  assert.equal(decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, mk('scene_change'), 1).bubble?.motion, 'waving')
})
