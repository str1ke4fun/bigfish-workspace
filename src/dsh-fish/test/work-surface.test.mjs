import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryService } from '../lib/memory-service.js'

test('工头写事件时 surface/channel 仍落 web，不新增 work 事件面', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-work-memory-'))
  const core = { surface: { current: () => 'work' } }
  const memory = createMemoryService({ root, core })
  const r = await memory.append(
    { type: 'utterance', text: '工作里想留下的一句话。' },
    { agent: { session: { header: { id: 'boss-1', cwd: '/tmp/proj' } } } },
  )
  assert.equal(r.ok, true)
  const line = (await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n').at(-1)
  const event = JSON.parse(line)
  assert.equal(event.surface, 'web')
  assert.equal(event.channel, 'web')
})
