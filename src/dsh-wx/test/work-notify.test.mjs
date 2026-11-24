import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ownerNoticeText, OWNER_NOTICE_LIMIT } from '../lib/notify-owner.js'

test('汇总压平换行并截到 500 字', () => {
  const r = ownerNoticeText('第一行\n第二行\n\n第三行')
  assert.equal(r.ok, true)
  assert.equal(r.text, '第一行 第二行 第三行')
  const long = ownerNoticeText('字'.repeat(600))
  assert.equal([...long.text].length, OWNER_NOTICE_LIMIT)
})

test('空汇总拒绝；秘密命中改成通用文案', () => {
  assert.equal(ownerNoticeText('   \n  ').ok, false)
  const secret = ownerNoticeText('token=abcdefghijklmnopqrstuvwxyz012345', { looksLikeSecret: () => true })
  assert.equal(secret.ok, true)
  assert.equal(secret.text, '做完了，详情在电脑上')
})
