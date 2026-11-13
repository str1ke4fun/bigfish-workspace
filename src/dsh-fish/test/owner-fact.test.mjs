import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent, readEvents } from '../lib/store.js'
import { buildOwnerNote, hasOwnerNote, run, extractQuotedLabel } from '../lib/owner-fact.js'

const OLD = {
  id: 'ev_01M77HQ4TDZJT4SJMQ49JP8RNH',
  ts: '2026-11-12T09:34:13.325Z',
  type: 'utterance',
  source: 'tool',
  channel: 'web',
  text: '老哥说，他有时候在微信找我，用的那个私聊名是「cat不到flag的cat」。记下来：那个名字是他，别的名字不是。',
}

test('extractQuotedLabel：取第一个「…」', () => {
  assert.equal(extractQuotedLabel(OLD.text), 'cat不到flag的cat')
  assert.equal(extractQuotedLabel('没有引号里的名字'), '')
})

test('buildOwnerNote 从旧事件构造 owner person_note', () => {
  const r = buildOwnerNote({ sourceEvent: OLD })
  assert.equal(r.ok, true)
  assert.equal(r.note.type, 'person_note')
  assert.equal(r.note.person.id, 'owner')
  assert.equal(r.note.person.label, 'cat不到flag的cat')
  assert.deepEqual(r.note.refs, [OLD.id])
  assert.deepEqual(r.note.flags, ['identity'])
})

test('buildOwnerNote：没有别名时失败', () => {
  const r = buildOwnerNote({ sourceEvent: { ...OLD, text: '没有引号里的名字' } })
  assert.equal(r.ok, false)
  assert.match(r.why, /label|别名/)
})

test('hasOwnerNote 按 refs 找已有 note', () => {
  const note = buildOwnerNote({ sourceEvent: OLD }).note
  const found = hasOwnerNote([note], OLD.id)
  assert.ok(found)
  assert.deepEqual(found.refs, [OLD.id])
  assert.equal(hasOwnerNote([], OLD.id), null)
})

test('run：dry-run 不写，apply 写一次，第二次幂等', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-owner-'))
  try {
    await appendEvent({ id: OLD.id, type: 'utterance', text: OLD.text, channel: 'web' }, { day: 1, stage: 1, source: 'tool' }, root)
    const first = await run({ root, eventId: OLD.id, apply: false })
    assert.equal(first.ok, true)
    assert.equal(first.wrote, false)
    assert.equal((await readEvents(root)).events.filter((e) => e.type === 'person_note').length, 0)

    const second = await run({ root, eventId: OLD.id, apply: true })
    assert.equal(second.wrote, true)
    assert.equal((await readEvents(root)).events.filter((e) => e.type === 'person_note').length, 1)

    const third = await run({ root, eventId: OLD.id, apply: true })
    assert.equal(third.wrote, false)
    assert.equal((await readEvents(root)).events.filter((e) => e.type === 'person_note').length, 1)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

test('run：源事件不存在时 abort，不写', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fish-owner-'))
  try {
    const r = await run({ root, eventId: 'ev_missing', apply: true })
    assert.equal(r.ok, false)
    assert.match(r.why, /不存在/)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
