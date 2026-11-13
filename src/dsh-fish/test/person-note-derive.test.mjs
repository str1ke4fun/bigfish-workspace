/**
 * person-note-derive.test.mjs —— 人物记忆 Phase 1 Task 2：derive 收集人物笔记
 *
 * 对应合并裁决：
 *   - D5：非 owner 的 person_note Phase 1 不可 recall（这里只保证数据可被取到，
 *     recall 的门禁在 Task 6；derive 不替它做过滤）。
 *   - D21：ownerFacts 判据严格为 id==='owner' && kind==='identity' && label 非空，
 *     flags 不参与筛选；同 (channel, label) 取最新。
 *   - D24：人物笔记的可见性按 person.channel + person.chatId，不看事件顶层 channel。
 *
 * 覆盖：
 *   - person_note 不进入 beliefs / facts / 成长门；
 *   - ownerFacts 去重取最新、无 identity flag 也进；
 *   - supersedes 替换、revokes 撤销；
 *   - personNotesByChat 只收 wx + chatId；
 *   - personNotesByPerson 按 person.id 归组（空 id 不建 key）；
 *   - 事件顶层 channel=web、person.channel=wx 时仍归 wx。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'

const T0 = Date.parse('2026-11-12T00:00:00Z')

const ev = (id, type, day, text, extra = {}) => ({
  id,
  ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(),
  day,
  stage: 1,
  type,
  source: 'tool',
  text,
  refs: [],
  verdict: null,
  confidence: 0.6,
  flags: [],
  ...extra,
})

const note = (id, person, extra = {}) => ev(id, 'person_note', 1, '一条人物笔记', { person, ...extra })

const owner = (label = 'cat不到flag的cat', extra = {}) => ({
  id: 'owner',
  name: '老哥',
  label,
  channel: 'wx',
  chatId: '',
  kind: 'identity',
  confidence: 'high',
  ...extra,
})

const seed = () => ev('ev_seed', 'seed', 1, '种', { source: 'system' })

test('person_note 不进入 beliefs / facts / 成长门', () => {
  const evs = [seed(), note('ev_n1', owner())]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.equal(m.beliefs.length, 0)
  assert.equal(m.beliefCount, 0)
  assert.equal(m.facts.narrations, 0)
  assert.equal(m.facts.voices, 0)
  assert.equal(m.facts.solid, 0)
  assert.equal(m.tensions.length, 0)
  assert.equal(m.solid.length, 0)
  assert.equal(m.scars.length, 0)
  // 成长门：一条信念都没有，必须还停在 stage 1（不因 person_note 提前开门）。
  assert.equal(m.stage, 1)
  assert.equal(m.stageGate.passed.length, 0)

  // 但人物笔记本身要能被取到。
  assert.equal(m.personNoteCount, 1)
  assert.equal(m.personNotes.length, 1)
  assert.equal(m.ownerFacts.length, 1)
  assert.equal(m.ownerFacts[0].label, 'cat不到flag的cat')
  assert.equal(m.ownerFacts[0].channel, 'wx')
  assert.equal(m.ownerFacts[0].name, '老哥')
  assert.equal(m.ownerFacts[0].id, 'ev_n1')
})

test('ownerFacts 按 (channel, label) 去重取最新，最新在前', () => {
  const evs = [
    seed(),
    // 同一 (wx, cat)：只留最新一条。
    note('ev_dup_old', owner('cat'), { ts: new Date(T0).toISOString(), text: '旧的说法' }),
    note('ev_dup_new', owner('cat'), { ts: new Date(T0 + DAY_MS).toISOString(), text: '新的说法' }),
    // 不同 label 是不同事实，都要保留。
    note('ev_other', owner('另一个名字'), { ts: new Date(T0 + 2 * DAY_MS).toISOString() }),
  ]
  const m = deriveSelf(evs, { now: T0 + 3 * DAY_MS })

  assert.equal(m.ownerFacts.length, 2)
  // 最新在前：另一个名字（day 3）在前，cat 的最新一条（day 2）在后。
  assert.deepEqual(m.ownerFacts.map((f) => f.label), ['另一个名字', 'cat'])
  assert.equal(m.ownerFacts[1].text, '新的说法')
  // 去重只影响 ownerFacts；personNotes 里旧 note 仍保留（事件流只追加，不删）。
  assert.equal(m.personNotes.length, 3)
})

test('无 identity flag 的 owner identity note 仍进 ownerFacts；flags 不参与筛选', () => {
  const evs = [
    seed(),
    // 没有 identity flag，甚至带了别的 flag，仍应进 ownerFacts（D21）。
    note('ev_noflag', owner('无 flag 的名字'), { flags: [] }),
    note('ev_otherflag', owner('别的 flag 的名字'), { flags: ['weak'] }),
    // 有 identity flag 但不是 identity kind → 不进。
    note('ev_impression', { ...owner('impression-label'), kind: 'impression', chatId: 'c_1' }, { flags: ['identity'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.deepEqual(
    m.ownerFacts.map((f) => f.label).sort(),
    ['别的 flag 的名字', '无 flag 的名字'].sort(),
  )
})

test('owner identity note 的 label 为空时不进 ownerFacts', () => {
  const evs = [
    seed(),
    note('ev_blank', { ...owner(''), label: '' }),
    note('ev_ok', owner('cat')),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.equal(m.ownerFacts.length, 1)
  assert.equal(m.ownerFacts[0].label, 'cat')
  // 空 label 的 note 仍是合法 active note（schema 会拒 owner，但 derive 不越权删数据）。
  assert.equal(m.personNoteCount, 2)
})

test('supersedes 替换旧 note，不删除事件', () => {
  const evs = [
    seed(),
    note('ev_old', owner('old-name')),
    note('ev_new', owner('new-name'), { supersedes: ['ev_old'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.equal(m.ownerFacts.length, 1)
  assert.equal(m.ownerFacts[0].label, 'new-name')
  assert.equal(m.ownerFacts[0].id, 'ev_new')
  assert.equal(m.personNotes.length, 1)
  assert.equal(m.personNotes[0].id, 'ev_new')
  assert.equal(m.personNoteCount, 1)
  // 事件流本身没有被改写/删除。
  assert.equal(evs.filter((e) => e.type === 'person_note').length, 2)
})

test('revokes 撤销旧 note；撤销自身的空 label note 不变成 ownerFact', () => {
  const evs = [
    seed(),
    note('ev_old', owner('revoked-name')),
    note('ev_revoke', { ...owner(''), label: '' }, { revokes: ['ev_old'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.equal(m.ownerFacts.length, 0)
  assert.ok(!m.personNotes.some((n) => n.id === 'ev_old'))
  // 撤销事件本身仍是 active note（它没有指向 label，只是没进 ownerFacts）。
  assert.deepEqual(m.personNotes.map((n) => n.id), ['ev_revoke'])
  assert.equal(m.personNoteCount, 1)
})

test('personNotesByChat 只收 wx + chatId 的 note', () => {
  const evs = [
    seed(),
    note('ev_g', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }),
    note('ev_dm', owner('cat')), // wx 但 chatId 为空 → 不进
    note('ev_web', { id: 'x', name: 'x', label: '', channel: 'web', chatId: 'c_web', kind: 'impression' }),
    note('ev_core', { id: 'y', name: 'y', label: '', channel: 'core', chatId: 'c_core', kind: 'interaction' }),
    note('ev_g2', { id: 'tina', name: 'Tina Yu', label: '', channel: 'wx', chatId: 'c_other', kind: 'impression' }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.deepEqual([...m.personNotesByChat.keys()].sort(), ['c_7c', 'c_other'])
  assert.equal(m.personNotesByChat.get('c_7c').length, 1)
  assert.equal(m.personNotesByChat.get('c_7c')[0].id, 'ev_g')
  assert.equal(m.personNotesByChat.get('c_other')[0].id, 'ev_g2')
  assert.ok(!m.personNotesByChat.has('c_web'))
  assert.ok(!m.personNotesByChat.has('c_core'))
})

test('personNotesByPerson 按 person.id 归组，空 id 不建 key', () => {
  const evs = [
    seed(),
    note('ev_q1', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }),
    note('ev_q2', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'interaction' }),
    note('ev_owner', owner('cat')),
    note('ev_noid', { id: '', name: '未知名', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.deepEqual([...m.personNotesByPerson.keys()].sort(), ['owner', 'qiuzh'])
  assert.equal(m.personNotesByPerson.get('qiuzh').length, 2)
  assert.equal(m.personNotesByPerson.get('owner').length, 1)
  assert.ok(!m.personNotesByPerson.has(''))
  // 归组是 active notes 的全部，不受 personNotesByChat 的 chatId 过滤影响。
  assert.equal(m.personNoteCount, 4)
})

test('事件顶层 channel=web、person.channel=wx 时仍按 wx 归入 chat（D24）', () => {
  const evs = [
    seed(),
    // D24：她是在 web 会话里写下这条群笔记的；可见性看 person.channel + person.chatId。
    note(
      'ev_cross',
      { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' },
      { channel: 'web', surface: 'web' },
    ),
    // 反过来：person.channel=web 的人，即使事件顶层 channel=wx，也不能进 wx 群。
    note(
      'ev_cross_back',
      { id: 'y', name: 'y', label: '', channel: 'web', chatId: 'c_7c', kind: 'impression' },
      { channel: 'wx', surface: 'wx' },
    ),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.deepEqual([...m.personNotesByChat.keys()], ['c_7c'])
  assert.deepEqual(m.personNotesByChat.get('c_7c').map((n) => n.id), ['ev_cross'])
})

test('superseded / revoked 的 note 不参与任何派生', () => {
  const evs = [
    seed(),
    note('ev_a', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }),
    note('ev_b', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }),
    note('ev_c', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }),
    note('ev_replace', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }, { supersedes: ['ev_a'] }),
    note('ev_revoke', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }, { revokes: ['ev_b'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })

  assert.deepEqual(
    m.personNotes.map((n) => n.id).sort(),
    ['ev_c', 'ev_replace', 'ev_revoke'].sort(),
  )
  assert.deepEqual(
    m.personNotesByPerson.get('qiuzh').map((n) => n.id).sort(),
    ['ev_c', 'ev_replace', 'ev_revoke'].sort(),
  )
  assert.deepEqual(
    m.personNotesByChat.get('c_7c').map((n) => n.id).sort(),
    ['ev_c', 'ev_replace', 'ev_revoke'].sort(),
  )
  assert.equal(m.personNoteCount, 3)
})

test('没有 person_note 时新增字段为空值，不抛错', () => {
  const m = deriveSelf([seed()], { now: T0 + DAY_MS })
  assert.deepEqual(m.ownerFacts, [])
  assert.deepEqual(m.personNotes, [])
  assert.equal(m.personNotesByChat.size, 0)
  assert.equal(m.personNotesByPerson.size, 0)
  assert.equal(m.personNoteCount, 0)
})
