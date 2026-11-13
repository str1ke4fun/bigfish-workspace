import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sleepDue } from '../lib/sleep.js'

const meta = (text, day = 1) => ({ type: 'meta', text, day })
const model = (day) => ({ day })

test('无历史、day 6、every 7 → null', () => {
  assert.equal(sleepDue([], model(6), 7, '2026-11-13'), null)
})

test('无历史、day 7 → due 7', () => {
  assert.equal(sleepDue([], model(7), 7, '2026-11-13'), 7)
})

test('上次 sleep day 7、现在 day 20、every 7 → due 14', () => {
  const events = [meta('sleep:2026-11-01', 7)]
  assert.equal(sleepDue(events, model(20), 7, '2026-11-13'), 14)
})

test('上次 sleep day 7、现在 day 20、当天已有 sleep:<dk> → null', () => {
  const events = [
    meta('sleep:2026-11-01', 7),
    meta('sleep:2026-11-13', 20),
  ]
  assert.equal(sleepDue(events, model(20), 7, '2026-11-13'), null)
})

test('everyDays=0 → null', () => {
  assert.equal(sleepDue([], model(20), 0, '2026-11-13'), null)
})

test('model.day<=1 → null', () => {
  assert.equal(sleepDue([], model(1), 7, '2026-11-13'), null)
})
