/**
 * person-note-schema.test.mjs —— schema v4：person_note 事件
 *
 * 覆盖计划 Task 1 的 5 个用例，外加合并裁决 D2 的 `screen` 事件面：
 *   - 版本 4、HER_TYPES / FLAGS 常量；
 *   - person 必填字段与枚举；
 *   - impression / interaction 的 chatId 义务；
 *   - refs / supersedes / revokes 的 knownIds 校验；
 *   - identity flag 只对 person_note 的工具写入保留；
 *   - 事件面白名单同时接受 screen。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVENT_SCHEMA_VERSION, FLAGS, HER_TYPES, PERSON_CHANNELS, PERSON_KINDS,
  SURFACES, validateEvent,
} from '../lib/schema.js'

const OWNER = {
  id: 'owner', name: '老哥', label: 'cat不到flag的cat',
  channel: 'wx', chatId: '', kind: 'identity', confidence: 'high',
}
const base = {
  type: 'person_note',
  text: '微信私聊名「cat不到flag的cat」是他，别的名字不是。',
  person: OWNER,
}

test('v4: person_note 合法，版本与字段完整', () => {
  assert.equal(EVENT_SCHEMA_VERSION, 4)
  assert.ok(HER_TYPES.includes('person_note'))
  assert.ok(FLAGS.includes('identity'))
  assert.deepEqual([...PERSON_CHANNELS], ['wx', 'web', 'core'])
  assert.deepEqual([...PERSON_KINDS], ['identity', 'impression', 'interaction'])
  const ev = validateEvent(base, { source: 'tool' })
  assert.equal(ev.v, 4)
  assert.equal(ev.person.id, 'owner')
  assert.equal(ev.person.label, 'cat不到flag的cat')
  assert.equal(ev.person.confidence, 'high')
  assert.deepEqual(ev.supersedes, [])
  assert.deepEqual(ev.revokes, [])
})

test('v4: 缺 person / 缺字段 / 坏枚举被拒', () => {
  assert.throws(() => validateEvent({ type: 'person_note', text: 'x' }, { source: 'tool' }), (e) => e.code === 'BAD_PERSON')
  assert.throws(
    () => validateEvent({ ...base, person: { ...OWNER, name: '' } }, { source: 'tool' }),
    (e) => e.code === 'BAD_PERSON',
  )
  assert.throws(
    () => validateEvent({ ...base, person: { ...OWNER, channel: 'telegram' } }, { source: 'tool' }),
    (e) => e.code === 'BAD_PERSON',
  )
  assert.throws(
    () => validateEvent({ ...base, person: { ...OWNER, kind: 'friend' } }, { source: 'tool' }),
    (e) => e.code === 'BAD_PERSON',
  )
  assert.throws(
    () => validateEvent({ ...base, person: { ...OWNER, label: '' } }, { source: 'tool' }),
    (e) => e.code === 'BAD_PERSON',
    'owner identity 必须带 label',
  )
})

test('v4: impression / interaction 必须带 chatId', () => {
  for (const kind of ['impression', 'interaction']) {
    assert.throws(
      () => validateEvent({ ...base, person: { ...OWNER, kind, chatId: '' } }, { source: 'tool' }),
      (e) => e.code === 'BAD_PERSON',
    )
    assert.doesNotThrow(
      () => validateEvent({ ...base, person: { ...OWNER, kind, chatId: 'c_7c55c2507c92' } }, { source: 'tool' }),
    )
  }
})

test('v4: knownIds 校验 refs / supersedes / revokes', () => {
  const knownIds = new Set(['ev_01J9ZK0000000000000000000A'])
  for (const field of ['refs', 'supersedes', 'revokes']) {
    assert.throws(
      () => validateEvent({ ...base, [field]: ['ev_missing'] }, { source: 'tool', knownIds }),
      (e) => e.code === 'REF_NOT_FOUND',
      field,
    )
  }
  assert.doesNotThrow(() =>
    validateEvent({ ...base, refs: ['ev_01J9ZK0000000000000000000A'] }, { source: 'tool', knownIds }),
  )
})

test('v4: identity flag 只对 person_note 工具写入保留', () => {
  const note = validateEvent({ ...base, flags: ['identity'] }, { source: 'tool' })
  assert.deepEqual(note.flags, ['identity'])
  const utterance = validateEvent({ type: 'utterance', text: '普通一句', flags: ['identity'] }, { source: 'tool' })
  assert.deepEqual(utterance.flags, [])
  const selfmod = validateEvent({ type: 'utterance', text: '普通一句', flags: ['selfmod'] }, { source: 'tool' })
  assert.deepEqual(selfmod.flags, [])
})

test('v4: 事件面白名单同时接受 screen（合并裁决 D2）', () => {
  assert.ok(SURFACES.includes('screen'))
  const ev = validateEvent(
    { type: 'utterance', text: '屏幕里的一句', channel: 'web', surface: 'screen' },
    { source: 'system' },
  )
  assert.equal(ev.surface, 'screen')
})
