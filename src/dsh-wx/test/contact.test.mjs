import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isContactWhy } from '../lib/contact.js'

test('微信 contact：单聊/免 @ 白名单算，群 @/点名不算', () => {
  assert.equal(isContactWhy('dm'), true)
  assert.equal(isContactWhy('exempt'), true)
  assert.equal(isContactWhy('name'), false)
  assert.equal(isContactWhy('at'), false)
  assert.equal(isContactWhy(''), false)
  assert.equal(isContactWhy(undefined), false)
})
