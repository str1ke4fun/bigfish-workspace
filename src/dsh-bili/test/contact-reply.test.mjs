import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanReplies } from '../lib/comment.js'
import { setCore } from '../lib/core.js'
import { fakeCore } from './helpers.mjs'
import { dateKey } from '../lib/support.js'

const BV = 'BV1xx411c7mD'
const OWNER = '278453995'
const ACCOUNT = '3546984285735227'

async function run({ replyMid, ownerMid = OWNER, accountMid = ACCOUNT } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-contact-'))
  const markSeen = []
  const events = [{ type: 'meta', text: `comment:${dateKey()} ${BV} 123`, ts: new Date().toISOString() }]
  const { core } = fakeCore({ events, config: {} })
  core.owner.read = async () => ({ mid: ownerMid, account: { mid: accountMid } })
  setCore(core)
  const client = {
    view: async () => ({ data: { aid: 1 } }),
    subReplies: async () => ({ ok: true, data: [{ rpid: 42, text: '回你一句', mid: replyMid, user: '某人', ctime: 1700000000 }] }),
  }
  const memory = {
    appendSystem: async () => ({ ok: true }),
    markSeen: async (o) => { markSeen.push(o); return { ok: true } },
  }
  try {
    const out = await scanReplies({ root, events, client, memory })
    return { out, markSeen }
  } finally {
    setCore(null)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

test('owner.mid 回复算 contact，时间戳用 ctime', async () => {
  const { out, markSeen } = await run({ replyMid: Number(OWNER) })
  assert.equal(out[0].isOwner, true)
  assert.equal(out[0].mid, OWNER)
  assert.deepEqual(markSeen, [{ source: 'bili', at: 1700000000000 }])
})

test('owner.account.mid 回复也算 contact', async () => {
  const { out, markSeen } = await run({ replyMid: Number(ACCOUNT) })
  assert.equal(out[0].isOwner, true)
  assert.equal(out[0].mid, ACCOUNT)
  assert.equal(markSeen.length, 1)
})

test('路人回复不算 contact', async () => {
  const { out, markSeen } = await run({ replyMid: 999 })
  assert.equal(out[0].isOwner, false)
  assert.equal(markSeen.length, 0)
})
