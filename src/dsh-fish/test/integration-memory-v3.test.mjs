/**
 * integration-memory-v3.test.mjs —— v3 事件流的端到端验收（A1.9）
 *
 * 三件事：
 *   1. 同一 fixture 走旧路径（直接 appendEvent）与新路径（fishCore.memory），
 *      事件类型序列与 surface/channel 必须一致——升级不能悄悄改变事件形状；
 *   2. 微信原话（channel=wx）不进 bili/core 视图，公开的 B 站内容任何面都看得到；
 *   3. 版本号已经升到 0.9.0（迁移说明与 CHANGELOG 同批交付）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendEvent, readEvents } from '../lib/store.js'
import { createMemoryService } from '../lib/memory-service.js'
import { VERSION } from '../lib/index.js'

// source 跟随真实生产者：saw/voice/bili_reply 由系统写，utterance 是她开口后工具写的
// （`appendSystem` 只收系统类型，utterance 走 `commit`/`append`）。
const FIXTURE = [
  { type: 'saw', text: 'B站｜一条视频', refs: ['BV1'], source: 'system' },
  { type: 'voice', text: '评论区里别人的一句话', refs: ['BV1'], source: 'system' },
  { type: 'utterance', text: '她发出去的话', refs: ['BV1'], source: 'tool' },
  { type: 'bili_reply', text: '有人回了她一句', source: 'system', reply: { bvid: 'BV1', rpid: '222', root: '111' } },
]

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-v3-'))
  try { return await fn(root) } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

const shape = (events) => events.map((e) => ({
  type: e.type,
  surface: e.surface,
  channel: e.channel,
  text: e.text,
}))

test('旧路径与新路径产出同一组事件形状', async () => {
  await withRoot(async (oldRoot) => {
    for (const raw of FIXTURE) {
      await appendEvent({ ...raw, surface: 'bili', channel: 'core' }, { source: raw.source }, oldRoot)
    }
    const oldShape = shape((await readEvents(oldRoot)).events)

    await withRoot(async (newRoot) => {
      const memory = createMemoryService({ root: newRoot })
      for (const raw of FIXTURE) {
        // 与生产路径一致：系统类型走 appendSystem，她的话走 commit。
        const r = raw.source === 'system'
          ? await memory.appendSystem(raw.type, raw.text, {
              surface: 'bili',
              channel: 'core',
              refs: raw.refs,
              reply: raw.reply,
            })
          : await memory.commit(raw.text, {
              refs: raw.refs,
              surface: 'bili',
              channel: 'core',
              type: raw.type,
            })
        assert.equal(r.ok, true, `${raw.type}: ${r.why}`)
      }
      const newShape = shape((await readEvents(newRoot)).events)
      assert.deepEqual(newShape, oldShape)
      assert.deepEqual(newShape.map((e) => e.type), ['saw', 'voice', 'utterance', 'bili_reply'])
      assert.ok(newShape.every((e) => e.surface === 'bili' && e.channel === 'core'))
    })
  })
})

test('微信原话不进 bili/core 视图；公开的 B 站内容任何面都看得到', async () => {
  await withRoot(async (root) => {
    const memory = createMemoryService({ root })
    await memory.append(
      { type: 'utterance', text: '微信里的原话' },
      { source: 'tool', surface: 'wx', channel: 'wx' },
    )
    await memory.appendSystem('saw', 'B站公开视频', { surface: 'bili', channel: 'core' })

    const core = await memory.read({ channel: 'core' })
    assert.deepEqual(core.map((e) => e.text), ['B站公开视频'])
    const bili = await memory.read({ surface: 'bili' })
    assert.deepEqual(bili.map((e) => e.text), ['B站公开视频'])
    const wx = await memory.read({ channel: 'wx' })
    assert.deepEqual(wx.map((e) => e.text), ['微信里的原话'])
  })
})

test('版本号已升到 0.9.0', () => {
  assert.equal(VERSION, '0.9.0')
})
