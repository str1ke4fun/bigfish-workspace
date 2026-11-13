# 人物记忆 Phase 1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `person_note` 事件、owner 事实渲染、`fish:owner` system prompt 段和 11-12 旧事件迁移，让微信/网页/屏幕会话能看到「`cat不到flag的cat` 是老哥」，同时不把这条事实带到 B 站/QQ。

**Architecture:** 在 dsh-fish 内核加 schema v4 的 `person_note` 事件；`derive` 收集 `ownerFacts` / `personNotes`（不进 beliefs、成长门）；`selfdoc` 额外写一份 `home/关于他.md`；`identity` 挂 `fish:owner` 段（web/wx/screen）；`recall` 放行 owner facts；迁移脚本向事件流追加一条 `person_note`，不改旧事件。

**Tech Stack:** Node.js 24 ESM、`node:test`、零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-13-person-memory-design.md`

---

## Global Constraints

- 在 `bigfish-workspace-dev` worktree 里实现；它是线上 8710 的部署线，**不要**在实现中途重启 `dsh-web`，等测试和迁移 dry-run 都过了再部署。
- 事件流只追加；不删除、不重排、不改写历史事件。
- `EVENT_SCHEMA_VERSION` 从 3 升到 **4**；新代码必须能读 v1–v3 事件，旧代码读到 v4 会跳过（已有 `newer` 机制）。
- `person_note` **不进入** `beliefs`、`facts`、`needs`、`tensions`、`solid`、`scars`、成长门、开锁证据、日报的「她说了什么」。
- owner 事实的权威判据是 `person.id === 'owner' && person.kind === 'identity'`；`flags: ['identity']` 只是审计标记，不参与权限判断。
- owner 身份事实必须带 `person.label`；没有 label 的不渲染。
- `fish:owner` 只在 `web` / `wx` / `screen` 渲染；`bili` / `qq` 返回空串。
- Phase 1 不改 `selfdoc.js` 的全局身份文档去引用化（`crossChannel`），不改 `surface.js`、`tool-policy.js`、`restrict.js`。
- `person_note.text` ≤ 2000 字；`person.name` ≤ 24 字；`person.label` ≤ 64 字；owner 文档最多 5 条事实、总长 ≤ 300 字。
- `person_note` 只存她的摘要和 `refs`，不抄整段聊天/屏幕原文。
- 测试命令统一在 `src/dsh-fish` 下跑：`node --test`；单个文件 `node --test test/<file>.mjs`。
- 提交前在 worktree 根目录跑 `python scripts/audit-staged.py`；只暂存本任务路径。

---

## Review Focus

1. **畸形 `person`**：缺 `name` / `channel` / `kind`，或 `impression`/`interaction` 没有 `chatId` → 必须返回 `BAD_PERSON`，不能半写一条事件。
2. **flag 越权**：工具写 `person_note` 时 `flags:['identity']` 保留；工具写 `utterance` 时 `identity` 和 `selfmod` 都应被丢弃（不能借 flag 让信念消失）。
3. **跨面泄露**：`fish:owner` 在 `bili` / `qq` 必须为空；owner facts 的 `her_recall` 只在 web/wx/screen 放行；群/私聊 `person_note` 在 screen 不可见。
4. **改口/撤销**：`supersedes` / `revokes` 指向的旧事实不再渲染；同一 `(channel,label)` 取最新；没有 owner facts 时不输出空标题。
5. **迁移幂等**：同一个旧事件跑两次迁移只追加一条；源事件不存在时 abort、不写；dry-run 不写盘。

---

## Before You Start

- 进入 worktree：`cd /home/str1k3/src/bigfish-workspace-dev`。
- 确认 `git status`：允许 `docs/`、`.superpowers/` 等未跟踪文件；不要 `git clean`，不要动无关改动。
- 基线：`cd src/dsh-fish && node --test` 必须全绿。记录失败项；若基线不绿，先停下说明，不要在这个计划里顺手修。
- 读一遍 spec 的 §1–§8 和 §10；实现时以 spec 的字段/边界为准。

---

## File Structure

### 新增

| 文件 | 职责 |
|---|---|
| `src/dsh-fish/lib/people-view.js` | 纯函数：把 owner facts 渲染成 `fish:owner` 文档/段落；Phase 2 预留 `renderPeopleSection` |
| `src/dsh-fish/lib/owner-fact.js` | 纯函数：从旧事件构造 owner `person_note`；迁移幂等判断 |
| `src/dsh-fish/test/person-note-schema.test.mjs` | schema v4 + `person_note` 校验 |
| `src/dsh-fish/test/person-note-derive.test.mjs` | derive 收集/去重/撤销 |
| `src/dsh-fish/test/people-view.test.mjs` | owner 文档渲染、预算、去重 |
| `src/dsh-fish/test/owner-fact.test.mjs` | 迁移 builder + `run()` 幂等 |
| `scripts/append-owner-fact.mjs` | 迁移 CLI：dry-run 默认，`--apply` 追加 |

### 修改

| 文件 | 修改 |
|---|---|
| `src/dsh-fish/lib/schema.js` | v4、`person_note`、`normalizePerson`、`identity` flag 例外、refs/supersedes/revokes 校验 |
| `src/dsh-fish/lib/store.js` | `person_note` 也读全量 id 做 knownIds 校验 |
| `src/dsh-fish/lib/derive.js` | 收集 `personNotes` / `ownerFacts` / `personNotesByChat` |
| `src/dsh-fish/lib/selfdoc.js` | 额外写 `home/关于他.md`；`ownerDocPath` |
| `src/dsh-fish/lib/identity.js` | `fish:owner` 段、`ownerText` 缓存、`surfaceOf` 过滤 |
| `src/dsh-fish/lib/index.js` | `registerIdentity` 传 `surfaceOf` |
| `src/dsh-fish/lib/capture.js` | `growth_commit` 支持 `person_note` / `person` / `supersedes` / `revokes` |
| `src/dsh-fish/lib/recall.js` | owner facts 在 web/wx/screen 放行 |
| `src/dsh-fish/lib/memory-service.js` | `REFRESH_TYPES` 加 `person_note`；`commit` 支持 person 字段 |
| `src/dsh-fish/lib/observe.js` | `/memory` 增加 `people` 摘要 |
| `src/dsh-fish/test/schema.test.mjs` | HER_TYPES 循环给 `person_note` 补 `person` |
| `src/dsh-fish/test/schema-v3.test.mjs` | 版本断言 3 → 4 |
| `src/dsh-fish/test/backup.test.mjs` | 版本断言 3 → 4 |
| `src/dsh-fish/test/capture.test.mjs` | `person_note` 写入/拒绝 |
| `src/dsh-fish/test/mem.test.mjs` | owner facts 的 recall 范围 |
| `src/dsh-fish/test/memory-service.test.mjs` | `person_note` 刷新与 `appendSystem` 拒绝 |

---

## Task 1: Schema v4 + `person_note`

**Files:**
- Modify: `src/dsh-fish/lib/schema.js`
- Modify: `src/dsh-fish/lib/store.js`
- Modify: `src/dsh-fish/lib/inbox.js`
- Test: `src/dsh-fish/test/person-note-schema.test.mjs`
- Modify: `src/dsh-fish/test/schema.test.mjs`
- Modify: `src/dsh-fish/test/schema-v3.test.mjs`
- Modify: `src/dsh-fish/test/backup.test.mjs`
- Modify: `src/dsh-fish/test/letter.test.mjs`

**Interfaces:**
- `PERSON_CHANNELS = ['wx','web','core']`
- `PERSON_KINDS = ['identity','impression','interaction']`
- `normalizePerson(raw) -> { id, name, label, channel, chatId, kind, confidence }`
- `validateEvent({ type:'person_note', text, person, refs, supersedes, revokes, flags }, { source, knownIds }) -> event`
- `EVENT_SCHEMA_VERSION = 4`; `HER_TYPES` 和 `ALL_TYPES` 都包含 `'person_note'`
- `FLAGS` 包含 `'identity'`；只有 `source==='tool' && type==='person_note'` 时保留该 flag

- [ ] **Step 1: Write failing schema tests**

Create `src/dsh-fish/test/person-note-schema.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EVENT_SCHEMA_VERSION, FLAGS, HER_TYPES, validateEvent,
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
  const ev = validateEvent(base, { source: 'tool' })
  assert.equal(ev.v, 4)
  assert.equal(ev.person.id, 'owner')
  assert.equal(ev.person.label, 'cat不到flag的cat')
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
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `cd src/dsh-fish && node --test test/person-note-schema.test.mjs`
Expected: FAIL with `BAD_TYPE` / `EVENT_SCHEMA_VERSION !== 4`.

- [ ] **Step 3: Implement schema changes**

In `src/dsh-fish/lib/schema.js`:

1. Bump `EVENT_SCHEMA_VERSION` to `4`.
2. Add `'person_note'` to `ALL_TYPES` and `HER_TYPES`.
3. Add `'identity'` to `FLAGS`.
4. Add constants and `normalizePerson`:

```js
export const PERSON_CHANNELS = Object.freeze(['wx', 'web', 'core'])
export const PERSON_KINDS = Object.freeze(['identity', 'impression', 'interaction'])

function normalizePerson(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Reject('BAD_PERSON', 'person_note 必须带 person 对象')
  }
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const id = str(raw.id, 64)
  const name = str(raw.name, 24)
  const label = str(raw.label, 64)
  const channel = PERSON_CHANNELS.includes(raw.channel) ? raw.channel : ''
  const kind = PERSON_KINDS.includes(raw.kind) ? raw.kind : ''
  const chatId = str(raw.chatId, 64)
  const confidence = ['high', 'medium', 'unknown'].includes(raw.confidence) ? raw.confidence : 'unknown'
  if (!name) throw new Reject('BAD_PERSON', 'person.name 不能为空')
  if (!channel) throw new Reject('BAD_PERSON', `person.channel 必须是 ${PERSON_CHANNELS.join('/')}`)
  if (!kind) throw new Reject('BAD_PERSON', `person.kind 必须是 ${PERSON_KINDS.join('/')}`)
  if ((kind === 'impression' || kind === 'interaction') && !chatId) {
    throw new Reject('BAD_PERSON', 'person.chatId 在 impression/interaction 时必填')
  }
  if (id === 'owner' && kind === 'identity' && !label) {
    throw new Reject('BAD_PERSON', 'owner 身份事实必须带 person.label')
  }
  return { id, name, label, channel, chatId, kind, confidence }
}
```

5. In `validateEvent`, before the `confidence` block, normalize `person` and the two id arrays for `person_note`:

```js
const person = type === 'person_note' ? normalizePerson(raw.person) : null
const idList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length > 0))] : [])
const supersedes = type === 'person_note' ? idList(raw.supersedes) : []
const revokes = type === 'person_note' ? idList(raw.revokes) : []
```

6. In the `knownIds` block, extend the type check and validate all three arrays:

```js
if (knownIds && (type === 'revise' || type === 'narration' || type === 'person_note')) {
  const ids = type === 'person_note' ? [...refs, ...supersedes, ...revokes] : refs
  for (const id of ids) {
    if (!knownIds.has(id)) {
      throw new Reject('REF_NOT_FOUND', `refs 里的 ${id} 在事件流里不存在。要指向具体的某一条，别写自己没查过的 id。`)
    }
  }
}
```

7. In the flags block, keep the existing system-side rule and add the `person_note` exception:

```js
if (source !== 'tool' && Array.isArray(raw.flags)) {
  for (const f of raw.flags) if (FLAGS.includes(f) && !flags.includes(f)) flags.push(f)
} else if (source === 'tool' && type === 'person_note' && Array.isArray(raw.flags)) {
  for (const f of raw.flags) if (f === 'identity' && !flags.includes(f)) flags.push('identity')
}
```

8. In the returned event object, add:

```js
...(type === 'person_note' ? { person, supersedes, revokes } : {}),
```

In `src/dsh-fish/lib/store.js`, include `person_note` in the type list that reads all event ids:

```js
if (type === 'revise' || type === 'narration' || type === 'person_note') {
```

- [ ] **Step 4: Update existing tests for v4 / HER_TYPES**

In `src/dsh-fish/test/schema.test.mjs`, inside the `for (const t of HER_TYPES)` loop, add:

```js
if (t === 'person_note') {
  extra.person = {
    id: 'owner', name: '老哥', label: 'cat不到flag的cat',
    channel: 'wx', chatId: '', kind: 'identity',
  }
}
```

In `src/dsh-fish/test/schema-v3.test.mjs`, change `assert.equal(EVENT_SCHEMA_VERSION, 3)` to `4` and rename the test title to `schema: 版本号与 surface 白名单`.

In `src/dsh-fish/test/backup.test.mjs`, change `assert.equal(EVENT_SCHEMA_VERSION, 3)` to `4`.

In `src/dsh-fish/lib/inbox.js`, `person_note` must not appear as "her words" in the inbox or in `say.js`'s `said` list. Change:

```js
const SPEAK_TYPES = new Set(HER_TYPES)
```

to:

```js
const SPEAK_TYPES = new Set(HER_TYPES.filter((t) => t !== 'person_note'))
```

Add to `src/dsh-fish/test/letter.test.mjs`:

```js
test('person_note 不进信箱', () => {
  const box = buildInbox([
    { id: 'ev_n', type: 'person_note', ts: '2026-10-24T00:00:00Z', text: '人物笔记' },
    { id: 'ev_u', type: 'utterance', ts: '2026-10-24T00:01:00Z', text: '嗯' },
  ])
  assert.deepEqual(box.rows.map((r) => r.id), ['ev_u'])
})
```

- [ ] **Step 5: Run the focused and full tests**

Run: `cd src/dsh-fish && node --test test/person-note-schema.test.mjs test/schema.test.mjs test/schema-v3.test.mjs test/backup.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all tests pass. If a test asserts the old v3 system-type list, update it only if the failure is caused by `person_note` being a HER type; do not change unrelated assertions.

- [ ] **Step 6: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/schema.js src/dsh-fish/lib/store.js src/dsh-fish/lib/inbox.js \
  src/dsh-fish/test/person-note-schema.test.mjs src/dsh-fish/test/schema.test.mjs \
  src/dsh-fish/test/schema-v3.test.mjs src/dsh-fish/test/backup.test.mjs \
  src/dsh-fish/test/letter.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): person_note 事件与 schema v4"
```

---

## Task 2: Derive owner facts and person notes

**Files:**
- Modify: `src/dsh-fish/lib/derive.js`
- Test: `src/dsh-fish/test/person-note-derive.test.mjs`

**Interfaces:**
- `deriveSelf(events, opts)` additionally returns:
  - `ownerFacts: Array<{ id, text, label, name, channel, at }>` — active, latest first, deduped by `(channel, label)`
  - `personNotes: object[]` — active `person_note` events (not superseded/revoked)
  - `personNotesByChat: Map<string, object[]>` — active wx notes with non-empty `chatId`
  - `personNoteCount: number`
- These fields do not affect `beliefs`, `facts`, `needs`, `tensions`, `solid`, `scars`, or gates.

- [ ] **Step 1: Write failing derive tests**

Create `src/dsh-fish/test/person-note-derive.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveSelf, DAY_MS } from '../lib/derive.js'

const T0 = Date.parse('2026-11-12T00:00:00Z')
const ev = (id, type, day, text, extra = {}) => ({
  id, ts: new Date(T0 + (day - 1) * DAY_MS).toISOString(), day, stage: 1,
  type, source: 'tool', text, refs: [], verdict: null, confidence: 0.6, flags: [], ...extra,
})
const note = (id, person, extra = {}) => ev(id, 'person_note', 1, '一条人物笔记', { person, ...extra })
const owner = (label = 'cat不到flag的cat', extra = {}) => ({
  id: 'owner', name: '老哥', label, channel: 'wx', chatId: '', kind: 'identity', confidence: 'high', ...extra,
})

test('person_note 不进入 beliefs / facts / 成长门', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    note('ev_n1', owner()),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })
  assert.equal(m.beliefs.length, 0)
  assert.equal(m.facts.narrations, 0)
  assert.equal(m.personNoteCount, 1)
  assert.equal(m.ownerFacts.length, 1)
  assert.equal(m.ownerFacts[0].label, 'cat不到flag的cat')
  assert.equal(m.ownerFacts[0].channel, 'wx')
})

test('ownerFacts 去重取最新，并过滤 superseded / revoked', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    note('ev_old', owner('old-name'), { ts: new Date(T0).toISOString() }),
    note('ev_new', owner('new-name'), { ts: new Date(T0 + DAY_MS).toISOString() }),
    note('ev_gone', { ...owner(''), label: '' }, { revokes: ['ev_new'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.equal(m.ownerFacts.length, 1)
  assert.equal(m.ownerFacts[0].label, 'old-name')
  assert.ok(!m.personNotes.some((n) => n.id === 'ev_new'))
})

test('supersedes 替换旧 note，不删除事件', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    note('ev_old', owner('old-name')),
    note('ev_new', owner('new-name'), { supersedes: ['ev_old'] }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })
  assert.equal(m.ownerFacts.length, 1)
  assert.equal(m.ownerFacts[0].label, 'new-name')
  assert.equal(m.personNotes.length, 1)
})

test('personNotesByChat 只收 wx + chatId 的 note', () => {
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    note('ev_g', { id: 'qiuzh', name: 'qiuzh', label: '', channel: 'wx', chatId: 'c_7c', kind: 'impression' }),
    note('ev_dm', { id: 'owner', name: '老哥', label: 'cat', channel: 'wx', chatId: '', kind: 'identity' }),
    note('ev_web', { id: 'x', name: 'x', label: '', channel: 'web', chatId: 'c_web', kind: 'impression' }),
  ]
  const m = deriveSelf(evs, { now: T0 + DAY_MS })
  assert.deepEqual([...m.personNotesByChat.keys()], ['c_7c'])
  assert.equal(m.personNotesByChat.get('c_7c').length, 1)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/person-note-derive.test.mjs`
Expected: FAIL with `personNoteCount undefined`.

- [ ] **Step 3: Implement collection in `derive.js`**

1. Near the `saw` array, add `const personNotes = []`.
2. In the event loop, add:

```js
case 'person_note': {
  personNotes.push(ev)
  break
}
```

3. After the loop, compute active notes and owner facts:

```js
const superseded = new Set()
const revoked = new Set()
for (const n of personNotes) {
  for (const id of n.supersedes ?? []) superseded.add(id)
  for (const id of n.revokes ?? []) revoked.add(id)
}
const activePersonNotes = personNotes.filter((n) => !superseded.has(n.id) && !revoked.has(n.id))

const ownerFacts = []
const ownerSeen = new Set()
for (const n of [...activePersonNotes].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))) {
  const p = n.person ?? {}
  if (p.id !== 'owner' || p.kind !== 'identity') continue
  if (!p.label) continue
  const key = `${p.channel ?? 'core'}|${p.label}`
  if (ownerSeen.has(key)) continue
  ownerSeen.add(key)
  ownerFacts.push({ id: n.id, text: n.text, label: p.label, name: p.name ?? '', channel: p.channel ?? 'core', at: n.ts })
}

const personNotesByChat = new Map()
for (const n of activePersonNotes) {
  const p = n.person ?? {}
  if (p.channel !== 'wx' || !p.chatId) continue
  if (!personNotesByChat.has(p.chatId)) personNotesByChat.set(p.chatId, [])
  personNotesByChat.get(p.chatId).push(n)
}
```

4. Add to the returned model object:

```js
ownerFacts,
personNotes: activePersonNotes,
personNotesByChat,
personNoteCount: activePersonNotes.length,
```

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/person-note-derive.test.mjs test/derive.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/derive.js src/dsh-fish/test/person-note-derive.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): derive 收集 owner facts 与 person notes"
```

---

## Task 3: Owner document renderer

**Files:**
- Create: `src/dsh-fish/lib/people-view.js`
- Test: `src/dsh-fish/test/people-view.test.mjs`

**Interfaces:**
- `channelLabel(channel: string) -> string` (`wx` → `微信私聊`, `web` → `这里`, `core` → `共同`)
- `ownerDocText(ownerFacts, { maxFacts = 5, maxChars = 300 } = {}) -> string`
- `ownerSectionText({ doc, extras = '' }) -> string`

- [ ] **Step 1: Write failing renderer tests**

Create `src/dsh-fish/test/people-view.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { channelLabel, ownerDocText, ownerSectionText } from '../lib/people-view.js'

const fact = (label, channel = 'wx') => ({ id: `ev_${label}`, label, channel, name: '老哥', text: 'x', at: '2026-11-12T09:34:13Z' })

test('空事实返回空串，不输出空标题', () => {
  assert.equal(ownerDocText([]), '')
  assert.equal(ownerSectionText({ doc: '' }), '')
})

test('一条 owner 事实渲染成「关于他」', () => {
  assert.equal(channelLabel('wx'), '微信私聊')
  assert.equal(channelLabel('web'), '这里')
  assert.equal(channelLabel('core'), '共同')
  const doc = ownerDocText([fact('cat不到flag的cat')])
  assert.equal(doc, [
    '## 关于他',
    '他可能从不同的地方找你。下面这些名字都是他：',
    '- 微信私聊：cat不到flag的cat',
    '别的名字不是他。拿不准时先问一句，别把别人当成他。',
  ].join('\n'))
})

test('去重、跳过无 label、最多 5 条', () => {
  const facts = [
    fact('a'), fact('a'),
    { ...fact('b'), label: '' },
    fact('c'), fact('d'), fact('e'), fact('f'), fact('g'),
  ]
  const doc = ownerDocText(facts)
  assert.equal((doc.match(/^- /gm) ?? []).length, 5)
  assert.ok(doc.includes('微信私聊：a'))
  assert.ok(!doc.includes('微信私聊：b'))
})

test('总长超过 300 字时截断', () => {
  const long = '名'.repeat(80)
  const doc = ownerDocText([fact(long), fact(long + '2'), fact(long + '3')])
  assert.ok(doc.length <= 300)
  assert.ok(doc.endsWith('…'))
})

test('ownerSectionText 拼接 extras，并保留预算', () => {
  assert.equal(ownerSectionText({ doc: 'A', extras: 'B' }), 'A\n\nB')
  assert.equal(ownerSectionText({ doc: '', extras: 'B' }), 'B')
  assert.ok(ownerSectionText({ doc: 'A'.repeat(300), extras: 'B' }).length <= 300)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/people-view.test.mjs`
Expected: FAIL with `Cannot find module '../lib/people-view.js'`.

- [ ] **Step 3: Implement `people-view.js`**

Implement:

- `channelLabel(channel)` with the three mappings and raw fallback.
- `ownerDocText(ownerFacts, { maxFacts=5, maxChars=300 })`:
  - filter facts with a non-empty `label`;
  - dedupe by `${channel}|${label}`, first occurrence wins (caller already sorts newest first);
  - take ≤ `maxFacts`;
  - if none, return `''`;
  - build the 4-line header/fact/footer block as in the test;
  - if `length > maxChars`, cut at `maxChars - 1` and append `…`; do not cut a line in the middle of a label if avoidable (simple char cut is acceptable for Phase 1).
- `ownerSectionText({ doc, extras = '' })`:
  - parts = `[doc, extras].filter(Boolean)`;
  - join with `\n\n`;
  - cap at 300 chars with `…`.
- Add a Phase 2 reserved export (do not implement behavior beyond returning `''`):

```js
export function renderPeopleSection() { return '' }
```

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/people-view.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/people-view.js src/dsh-fish/test/people-view.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): owner 事实渲染"
```

---

## Task 4: Owner document + `fish:owner` section

**Files:**
- Modify: `src/dsh-fish/lib/selfdoc.js`
- Modify: `src/dsh-fish/lib/identity.js`
- Modify: `src/dsh-fish/lib/index.js`
- Modify: `src/dsh-fish/test/identity.test.mjs`

**Interfaces:**
- `ownerDocPath(root) -> string` (`<root>/home/关于他.md`)
- `writeSelfDoc(root)` writes both `她的身份.md` and `关于他.md`; return adds `ownerFile`, `ownerChanged`.
- `OWNER_SECTION = 'fish:owner'`; `OWNER_ORDER = 75`
- `ownerText(root) -> string` (mtime cache)
- `attachIdentity(agent, root, { canRemind, inboxText, surfaceOf })` adds the `fish:owner` section.
- `surfaceOf(agent)` returns `web|wx|screen|bili|qq`; the section returns `''` unless `web|wx|screen`.

- [ ] **Step 1: Write failing identity tests**

Append to `src/dsh-fish/test/identity.test.mjs`:

```js
import { appendEvent } from '../lib/store.js'

test('writeSelfDoc 额外写「关于他.md」，包含 owner 别名', async () => {
  const root = tmp()
  await appendEvent({
    type: 'person_note',
    text: '微信私聊名「cat不到flag的cat」是他。',
    person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
    refs: [], flags: ['identity'],
  }, { day: 1, stage: 1, source: 'system' }, root)
  await writeSelfDoc(root)
  const owner = fs.readFileSync(ownerDocPath(root), 'utf8')
  assert.match(owner, /cat不到flag的cat/)
  const identity = fs.readFileSync(selfDocPath(root), 'utf8')
  assert.doesNotMatch(identity, /cat不到flag的cat/)
})

test('fish:owner 只在 web/wx/screen 渲染', async () => {
  const root = tmp()
  await appendEvent({
    type: 'person_note',
    text: '微信私聊名「cat不到flag的cat」是他。',
    person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
    refs: [], flags: ['identity'],
  }, { day: 1, stage: 1, source: 'system' }, root)
  await writeSelfDoc(root)
  resetIdentityCache()

  const sections = new Map()
  const agent = { ctx: { systemPrompt: { section: (s) => sections.set(s.name, s) } } }
  attachIdentity(agent, root, { surfaceOf: () => 'wx' })
  assert.match(sections.get('fish:owner').text(), /cat不到flag的cat/)

  sections.clear()
  attachIdentity(agent, root, { surfaceOf: () => 'bili' })
  assert.equal(sections.get('fish:owner').text(), '')
})
```

Add imports at the top if not already present: `writeSelfDoc`, `ownerDocPath`, `OWNER_SECTION` (use the literal `'fish:owner'` or import), `resetIdentityCache` already imported; `fs` already imported.

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/identity.test.mjs`
Expected: FAIL with `ownerDocPath is not a function` / section missing.

- [ ] **Step 3: Implement owner doc in `selfdoc.js`**

1. Import `ownerDocText` from `./people-view.js`.
2. Add:

```js
export function ownerDocPath(root = rootDir()) {
  return join(paths(root).herDir, '关于他.md')
}
```

3. In `writeSelfDoc`, after `const model = deriveSelf(...)` and before `renderSelfDoc`, compute:

```js
const ownerTextValue = ownerDocText(model.ownerFacts)
const ownerFile = ownerDocPath(root)
```

4. After writing the identity file, write the owner file with the same `prev`/`writeAtomic` pattern:

```js
let ownerPrev = null
try { ownerPrev = await fs.readFile(ownerFile, 'utf8') } catch { /* 首次 */ }
const ownerChanged = ownerPrev !== ownerTextValue
if (ownerChanged) await writeAtomic(ownerFile, ownerTextValue)
```

Wrap the owner-file write in its own `try/catch`: a failure must not undo the identity write. On failure, keep `ok:true` for the identity doc, return `ownerChanged:false, ownerWhy:<message>`, and let `identity.js` render an empty owner section.

5. Add `ownerFile, ownerChanged, ownerWhy` to the returned object (both success and failure branches; failure can return `ownerFile: '', ownerChanged: false, ownerWhy: ''`).

- [ ] **Step 4: Implement `fish:owner` in `identity.js`**

1. Import `ownerDocPath` from `./selfdoc.js` and `ownerSectionText` from `./people-view.js`.
2. Add constants:

```js
export const OWNER_SECTION = 'fish:owner'
export const OWNER_ORDER = 75
```

3. Add an mtime cache like `identityText`:

```js
const ownerCache = { file: '', mtimeMs: -1, text: '' }

export function ownerText(root) {
  try {
    const file = ownerDocPath(root)
    const st = statSync(file)
    if (ownerCache.file !== file || ownerCache.mtimeMs !== st.mtimeMs) {
      ownerCache.text = readFileSync(file, 'utf8')
      ownerCache.file = file
      ownerCache.mtimeMs = st.mtimeMs
    }
    return ownerCache.text
  } catch {
    return ownerCache.text
  }
}

export function resetOwnerCache() {
  ownerCache.file = ''
  ownerCache.mtimeMs = -1
  ownerCache.text = ''
}
```

4. Update `resetIdentityCache` to also call `resetOwnerCache()`.
5. In `attachIdentity`, add the section:

```js
sp.section({
  name: OWNER_SECTION,
  order: OWNER_ORDER,
  text: () => {
    const surface = surfaceOf?.(agent) ?? 'web'
    if (surface !== 'web' && surface !== 'wx' && surface !== 'screen') return ''
    return ownerSectionText({ doc: ownerText(root) })
  },
})
```

Change the signature to `attachIdentity(agent, root, { canRemind, inboxText, surfaceOf } = {})`.

6. In `registerIdentity`, accept `surfaceOf` in the options and pass it to `attachIdentity`.

- [ ] **Step 5: Pass `surfaceOf` from `index.js`**

In `src/dsh-fish/lib/index.js`, change:

```js
const off = registerIdentity(ctx, { root, herDir, log: (...a) => logger.info(...a) })
```

to:

```js
const off = registerIdentity(ctx, {
  root,
  herDir,
  surfaceOf: (agent) => {
    try { return fishCore?.surface?.current?.(agent) ?? '' } catch { return '' }
  },
  log: (...a) => logger.info(...a),
})
```

- [ ] **Step 6: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/identity.test.mjs test/selfcheck.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/selfdoc.js src/dsh-fish/lib/identity.js \
  src/dsh-fish/lib/index.js src/dsh-fish/test/identity.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): 写「关于他」并挂 fish:owner 段"
```

---

## Task 5: `growth_commit` writes `person_note`

**Files:**
- Modify: `src/dsh-fish/lib/capture.js`
- Modify: `src/dsh-fish/test/capture.test.mjs`

**Interfaces:**
- `growth_commit` parameters add `person` (object), `supersedes` (string[]), `revokes` (string[]).
- `execute({ type:'person_note', text, person, supersedes?, revokes?, refs? })` writes one `person_note` event and returns `{ ok:true, id, note:'已记下。' }`.
- Malformed `person` returns `{ ok:false, id:'', note:'<Reject message>' }`.

- [ ] **Step 1: Write failing capture tests**

Append to `src/dsh-fish/test/capture.test.mjs`:

```js
test('growth_commit 写 person_note，保留 person/label/flags', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    const out = await tool.execute({
      type: 'person_note',
      text: '微信私聊名「cat不到flag的cat」是他。',
      person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
      flags: ['identity'],
    })
    assert.equal(out.ok, true)
    const { events } = await readEvents(root)
    const note = events.find((e) => e.type === 'person_note')
    assert.ok(note)
    assert.equal(note.person.label, 'cat不到flag的cat')
    assert.deepEqual(note.flags, ['identity'])
    assert.equal(note.source, 'tool')
  })
})

test('growth_commit 拒绝缺 person 的 person_note', async () => {
  await withRoot(async (root) => {
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const out = await ctx.regs.get('growth_commit').execute({
      type: 'person_note',
      text: '一条没有 person 的笔记',
    })
    assert.equal(out.ok, false)
    assert.match(out.note, /person/)
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'person_note').length, 0)
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/capture.test.mjs`
Expected: FAIL because `person_note` is not accepted / `person` missing.

- [ ] **Step 3: Implement in `capture.js`**

1. Extend the tool description with the `person_note` rule from the spec §5.1.
2. Add parameters to `toJsonSchema`:

```js
person: {
  type: 'object', required: false,
  description: 'person_note 必填：{ id, name, label, channel, chatId, kind, confidence }。owner 身份事实用 id=owner、kind=identity、flags=[identity]。',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    label: { type: 'string' },
    channel: { type: 'string' },
    chatId: { type: 'string' },
    kind: { type: 'string' },
    confidence: { type: 'string' },
  },
},
supersedes: { type: 'array', required: false, items: { type: 'string' }, description: '替换旧 person_note 的 id。' },
revokes: { type: 'array', required: false, items: { type: 'string' }, description: '撤销旧 person_note 的 id。' },
flags: { type: 'array', required: false, items: { type: 'string' }, description: '可选；owner 身份事实用 ["identity"]。' },
```

3. In the generic `appendEvent` branch, add:

```js
person: args?.person,
supersedes: args?.supersedes,
revokes: args?.revokes,
flags: args?.flags,
```

`validateEvent` will keep `person/supersedes/revokes` only for `person_note`, and `flags` only for the allowed cases.

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/capture.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/capture.js src/dsh-fish/test/capture.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): growth_commit 支持 person_note"
```

---

## Task 6: Owner facts in `her_recall`

**Files:**
- Modify: `src/dsh-fish/lib/recall.js`
- Modify: `src/dsh-fish/test/mem.test.mjs`

**Interfaces:**
- `registerRecall(ctx, deps)` unchanged.
- Owner facts (`type==='person_note' && person.id==='owner'`) are recallable when:
  - `channelOfAgent(agent)` is `web` or `wx`, or
  - `deps.core.surface.current(agent)` is `screen`.
- Non-owner `person_note` and group/private notes are not recallable in Phase 1.
- B 站/QQ remain unchanged (no owner facts).

- [ ] **Step 1: Write failing recall tests**

Append to `src/dsh-fish/test/mem.test.mjs`:

```js
test('owner facts：web/wx 翻得到，bili 翻不到', async () => withRoot(async (root) => {
  const { appendEvent } = await import('../lib/store.js')
  await appendEvent({
    type: 'person_note',
    text: '微信私聊名「cat不到flag的cat」是他。',
    person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
    refs: [], flags: ['identity'],
  }, { source: 'system' }, root)

  const defs = new Map()
  const ctx = { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } }
  const web = { session: { header: { id: 'session-web' } } }
  registerRecall(ctx, { root })
  const hit = await defs.get('her_recall').execute({ query: 'cat不到flag' }, { agent: web })
  assert.equal(hit.found, true)

  const biliCore = { surface: { current: () => 'bili' } }
  registerRecall(ctx, { root, core: biliCore })
  const miss = await defs.get('her_recall').execute({ query: 'cat不到flag' }, { agent: web })
  assert.equal(miss.found, false)
}))

test('owner facts：screen 面翻得到', async () => withRoot(async (root) => {
  const { appendEvent } = await import('../lib/store.js')
  await appendEvent({
    type: 'person_note',
    text: '微信私聊名「cat不到flag的cat」是他。',
    person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
    refs: [], flags: ['identity'],
  }, { source: 'system' }, root)

  const defs = new Map()
  const ctx = { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } }
  const core = { surface: { current: () => 'screen' } }
  registerRecall(ctx, { root, core })
  const hit = await defs.get('her_recall').execute({ query: 'cat不到flag' }, { agent: { session: { header: { id: 'session-screen' } } } })
  assert.equal(hit.found, true)
}))
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/mem.test.mjs`
Expected: FAIL — owner fact is filtered out.

- [ ] **Step 3: Implement in `recall.js`**

In `execute`, after `let channel = channelOfAgent(exec?.agent)`, compute `surface` first, then apply the existing B 站 special case, then compute the owner allowlist:

```js
const surface = (() => {
  try { return deps.core?.surface?.current?.(exec?.agent) ?? '' } catch { return '' }
})()
try {
  if (surface === 'bili') channel = ''
} catch { /* 面判定不可用就按通道走 */ }
const allowOwnerFacts = channel === 'web' || channel === 'wx' || surface === 'screen'
```

Keep the existing B 站 comment. Replace the `mine` filter with:

```js
const mine = events.filter((e) => {
  if (e.type === 'person_note' && e.person?.id === 'owner') return allowOwnerFacts
  const c = e.channel ?? 'core'
  return c === 'core' || (channel !== '' && c === channel)
})
```

Keep the existing B 站 special case (`channel = ''` for bili); owner facts are still excluded there because `surface === 'bili'` and `channel === ''`.

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/mem.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/recall.js src/dsh-fish/test/mem.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): her_recall 放行 owner 身份事实"
```

---

## Task 7: Memory service refresh + `/memory` people summary

**Files:**
- Modify: `src/dsh-fish/lib/memory-service.js`
- Modify: `src/dsh-fish/lib/observe.js`
- Modify: `src/dsh-fish/lib/people-view.js`
- Modify: `src/dsh-fish/test/memory-service.test.mjs`
- Modify: `src/dsh-fish/test/people-view.test.mjs`

**Interfaces:**
- `REFRESH_TYPES` includes `'person_note'`.
- `memory.commit(text, { type:'person_note', person, refs?, supersedes?, revokes? })` writes and refreshes.
- `memory.appendSystem('person_note', ...)` returns `{ ok:false, why:'NOT_SYSTEM_TYPE' }` (because it is a HER type).
- `peopleSummary(model) -> { ownerFacts, counts: { personNotes, activePersonNotes } }` exported from `people-view.js`.
- `/memory` response adds `people: peopleSummary(model)`.

- [ ] **Step 1: Write failing tests**

Append to `src/dsh-fish/test/memory-service.test.mjs`:

```js
test('person_note：commit 写入并刷新，appendSystem 拒绝', async () => {
  await withRoot(async (root) => {
    let refreshed = 0
    const m = mem(root, { refreshSelfDoc: async () => { refreshed += 1; return { ok: true } } })
    const r = await m.commit('微信私聊名「cat不到flag的cat」是他。', {
      type: 'person_note',
      person: { id: 'owner', name: '老哥', label: 'cat不到flag的cat', channel: 'wx', chatId: '', kind: 'identity' },
      flags: ['identity'],
    })
    assert.equal(r.ok, true)
    assert.equal(refreshed, 1)
    const events = await diskEvents(root)
    assert.equal(events.filter((e) => e.type === 'person_note').length, 1)
    const bad = await m.appendSystem('person_note', 'x', {})
    assert.deepEqual(bad, { ok: false, why: 'NOT_SYSTEM_TYPE' })
  })
})
```

The `mem(root, opts)` helper may not accept refresh options; inspect `test/memory-service.test.mjs` and adapt if needed (the test helper is at the top). If it doesn't, create the service directly with `createMemoryService({ root, refreshSelfDoc: ... })`.

Append to `src/dsh-fish/test/people-view.test.mjs` (add `peopleSummary` to the import from `../lib/people-view.js` first):

```js
test('peopleSummary 只暴露 owner facts 和计数', () => {
  const summary = peopleSummary({
    ownerFacts: [{ id: 'ev_1', label: 'cat', channel: 'wx', text: 'x', at: 't' }],
    personNotes: [{ id: 'ev_1' }, { id: 'ev_2' }],
    personNoteCount: 2,
  })
  assert.equal(summary.ownerFacts.length, 1)
  assert.deepEqual(summary.counts, { personNotes: 2, activePersonNotes: 2 })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/memory-service.test.mjs test/people-view.test.mjs`
Expected: FAIL — no refresh for `person_note` / `peopleSummary` missing.

- [ ] **Step 3: Implement**

1. `memory-service.js`: add `'person_note'` to `REFRESH_TYPES`.
2. `memory-service.js` `commit` signature: add `person, supersedes, revokes` options; include them in `raw`:

```js
function commit(text, { type = 'utterance', refs = [], verdict, confidence, agent, surface, channel, person, supersedes, revokes, flags } = {}) {
  const raw = { type, text, refs }
  if (person !== undefined) raw.person = person
  if (supersedes !== undefined) raw.supersedes = supersedes
  if (revokes !== undefined) raw.revokes = revokes
  if (flags !== undefined) raw.flags = flags
  // ...
}
```

3. `people-view.js`: add:

```js
export function peopleSummary(model = {}) {
  return {
    ownerFacts: Array.isArray(model.ownerFacts) ? model.ownerFacts : [],
    counts: {
      personNotes: Array.isArray(model.personNotes) ? model.personNotes.length : 0,
      activePersonNotes: Number(model.personNoteCount ?? 0),
    },
  }
}
```

4. `observe.js` `/memory`: import `peopleSummary`; add `people: peopleSummary(model)` to the JSON response near `events`/`diaries`.
5. Add a minimal `/memory` assertion only if an existing route test harness is easy; otherwise the pure `peopleSummary` test is sufficient for Phase 1.
6. Selfcheck 的 `people` 项留到 Phase 2：Phase 1 只做 `/memory`，避免改动 `selfcheck.test.mjs` 对检查项数量/顺序的断言。

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/memory-service.test.mjs test/people-view.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/memory-service.js src/dsh-fish/lib/observe.js \
  src/dsh-fish/lib/people-view.js src/dsh-fish/test/memory-service.test.mjs \
  src/dsh-fish/test/people-view.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): person_note 刷新与 /memory 人物摘要"
```

---

## Task 8: Old-event migration

**Files:**
- Create: `src/dsh-fish/lib/owner-fact.js`
- Create: `scripts/append-owner-fact.mjs` (worktree 根目录；不要放到 `src/dsh-fish/scripts`)
- Test: `src/dsh-fish/test/owner-fact.test.mjs`

**Interfaces:**
- `buildOwnerNote({ sourceEvent, name = '老哥', label, channel = 'wx', text }) -> { ok:true, note } | { ok:false, why }`
- `hasOwnerNote(events, sourceId) -> object | null`
- `run({ root, eventId, label, name, text, apply = false, log }) -> { ok, wrote, note?, why? }`
  - dry-run (`apply:false`) never writes; `apply:true` appends one event; second call with the same source is a no-op.

- [ ] **Step 1: Write failing migration tests**

Create `src/dsh-fish/test/owner-fact.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent, readEvents } from '../lib/store.js'
import { buildOwnerNote, hasOwnerNote, run } from '../lib/owner-fact.js'

const OLD = {
  id: 'ev_01M77HQ4TDZJT4SJMQ49JP8RNH',
  ts: '2026-11-12T09:34:13.325Z',
  type: 'utterance',
  source: 'tool',
  channel: 'web',
  text: '老哥说，他有时候在微信找我，用的那个私聊名是「cat不到flag的cat」。记下来：那个名字是他，别的名字不是。',
}

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
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/owner-fact.test.mjs`
Expected: FAIL with `Cannot find module '../lib/owner-fact.js'`.

- [ ] **Step 3: Implement `lib/owner-fact.js`**

Add imports at the top of `src/dsh-fish/lib/owner-fact.js`:

```js
import { appendEvent, readEvents } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
```

Implement:

- `extractQuotedLabel(text)`: first `「([^」]{1,64})」` capture; return `''` if none.
- `buildOwnerNote({ sourceEvent, name='老哥', label, channel='wx', text })`:
  - if `!sourceEvent?.id` → `{ ok:false, why:'source event 不存在' }`;
  - `const resolvedLabel = String(label ?? '').trim() || extractQuotedLabel(sourceEvent.text)`;
  - if no label → `{ ok:false, why:'找不到别名 label；请用 --label 指定' }`;
  - `text` default: source event text; trim to 2000;
  - return `{ ok:true, note: { type:'person_note', text, person:{ id:'owner', name, label:resolvedLabel, channel, chatId:'', kind:'identity', confidence:'high' }, refs:[sourceEvent.id], flags:['identity'] } }`.
- `hasOwnerNote(events, sourceId)`: find `e.type==='person_note' && e.person?.id==='owner' && (e.refs ?? []).includes(sourceId)`.
- `run({ root, eventId, label, name, text, apply=false, log })`:
  - `const { events } = await readEvents(root)`;
  - `const source = events.find((e) => e.id === eventId)`;
  - if no source → `{ ok:false, wrote:false, why:'源事件不存在' }`;
  - if `hasOwnerNote` → `{ ok:true, wrote:false, note, why:'已存在' }`;
  - build note; if !ok → return;
  - if !apply → `{ ok:true, wrote:false, note }`;
  - `const { config } = await loadConfig(root)`; `const model = deriveSelf(events, { growthDays: config.growthDays })`;
  - `await appendEvent(note, { day: model.day, stage: model.stage, source: 'system' }, root)`;
  - return `{ ok:true, wrote:true, note }`.

- [ ] **Step 4: Implement the CLI**

Create `scripts/append-owner-fact.mjs` at the worktree root:

```js
#!/usr/bin/env node
import { run } from '../src/dsh-fish/lib/owner-fact.js'
import { rootDir } from '../src/dsh-fish/lib/store.js'

const args = process.argv.slice(2)
const get = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const eventId = get('event', 'ev_01M77HQ4TDZJT4SJMQ49JP8RNH')
const label = get('label', 'cat不到flag的cat')
const name = get('name', '老哥')
const text = get('text', '')
const apply = args.includes('--apply')
const root = get('root', rootDir())

const out = await run({ root, eventId, label, name, text, apply, log: console.log })
console.log(JSON.stringify(out, null, 2))
if (!out.ok) process.exit(1)
```

- [ ] **Step 5: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/owner-fact.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/owner-fact.js src/dsh-fish/test/owner-fact.test.mjs \
  scripts/append-owner-fact.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): 旧事件迁移为 owner person_note"
```

---

## Task 9: Acceptance and migration dry-run

**Files:** none (verification only; no commit unless a test needs fixing).

- [ ] **Step 1: Run the full suite**

Run: `cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test`
Expected: all tests pass. Record the count.

- [ ] **Step 2: Run the migration dry-run**

Run:

```bash
cd /home/str1k3/src/bigfish-workspace-dev
node scripts/append-owner-fact.mjs --event ev_01M77HQ4TDZJT4SJMQ49JP8RNH --label cat不到flag的cat
```

Expected: JSON with `ok:true`, `wrote:false`, and a `note` whose `person.label` is `cat不到flag的cat` and `refs` contains the old event id. No event is written.

- [ ] **Step 3: Ask for approval, then apply**

Show the dry-run output to the user. Only after explicit approval:

```bash
cd /home/str1k3/src/bigfish-workspace-dev
node scripts/append-owner-fact.mjs --event ev_01M77HQ4TDZJT4SJMQ49JP8RNH --label cat不到flag的cat --apply
```

Expected: `wrote:true`. Run it a second time; expected `wrote:false` (idempotent).

- [ ] **Step 4: Verify the owner document**

Run:

```bash
cd /home/str1k3/src/bigfish-workspace-dev
node -e "import('./src/dsh-fish/lib/selfdoc.js').then(async (m) => { const { rootDir } = await import('./src/dsh-fish/lib/store.js'); await m.writeSelfDoc(rootDir()); const fs = await import('node:fs'); console.log(fs.readFileSync(m.ownerDocPath(rootDir()), 'utf8')) })"
```

Expected: `## 关于他`, a `- 微信私聊：cat不到flag的cat` line, and no raw chat text. The global `她的身份.md` remains redacted and does not gain the alias.

- [ ] **Step 5: Report**

Report separately: local tests, commit SHA(s), migration dry-run/apply status, and that **deployment has not happened**. The service restart and live verification are a separate deployment step after the user reviews the commits.

---

## Out of Scope for This Plan: Multi-channel Contact / Absence

The user decided (2026-11-13) that **any channel contact counts as “he came”**: a B站 reply from the owner, a WeChat inbound message, or a DSH user message should write the global `seen:` marker and reset absence. This is a separate change set; do **not** implement it in Phase 1. It needs:

- a global `session/event` `user/message` listener (exclude `runtime-context`, system `rpcId` prefixes, wake trigger texts, `[微信·主机]` pokes);
- dsh-wx marks `seen:` on successful inbound delivery (not on system pokes);
- `scanReplies` compares reply `mid` to `owner.mid` / `owner.account.mid` and marks `seen:`;
- migration/tests for all three paths.

Presence remains separate: it does not write `seen:` and does not reset absence. The `persona.js` presence wording branch is still undecided until the user chooses the phrasing.

---

## Reserved Interfaces for Phase 2 / 3

Do not implement these in Phase 1; keep the names stable so the later plans do not rename them.

**Phase 2 — group/private person notes**

- `people-view.js` already exports `renderPeopleSection()` returning `''`. Phase 2 implements:
  `renderPeopleSection({ model, surface, chatId, participants, now }) -> string`.
- `deriveSelf` already returns `personNotesByChat: Map<chatId, note[]>`.
- `identity.js` reserves `fish:people` (order 76); Phase 2 attaches it only for `surface === 'wx'`.
- dsh-wx reserves `wx.peopleForChat(chatId)` and `wx.chatParticipants(chatId)`.

**Phase 3 — `fish:owner` extension / presence**

- `ownerSectionText({ doc, extras })` already accepts `extras`; Phase 3 passes `fishCore.context.render({ section:'owner', agent, surface })`.
- `identity.js` `fish:owner` surface list is `web|wx|screen`; Phase 3 relies on the presence spec adding `screen` to `SURFACES` and `fish:owner.surfaces`.
- `recall.js` already has the `screen` branch; Phase 3 activates it when `surface.current` returns `screen`.
- `fishCore.context.provide/render` is Phase 3; do not add it in Phase 1.
- **Home presence summary (Phase 3; format fixed by presence spec §7.5):**
  - `deriveSelf` parses `meta presence:<dk>:<mode>:<minutes>:<count>` into
    `presenceRecent: Array<{ dk, workMin, eventMin, ambientMin, lastAt }>` (last 7 days).
    `<dk>` is the segment start day; `<minutes>` is floored to 1; `<count>` may be 0;
    mode switches write multiple lines; aggregate by day + mode.
  - `presence-view.js` exports `presenceDocText(presenceRecent, { maxDays=3, maxChars=200 }) -> string`
    and `presenceSectionText({ doc, extras })`.
  - `selfdoc.js` writes `home/他这几天.md`; `identity.js` reads it with an mtime cache and
    `fish:owner` appends it **only when `surface === 'web'`**.
  - `persona.js` absence line is **NOT decided**: multi-channel absence semantics
    (web/wx/qq/bili) are pending a user decision. Presence only supplies data; do not
    implement the persona branch, do not write `seen:` from presence, and do not reset
    absence until that decision is made.
  - No new event type; `meta` is still skipped by `her_recall`/growth.

---

## Self-Review Notes

- **Spec coverage:** §4.2 → Task 1/5; §4.3 → Task 2/3/4; §4.4 → schema + `personNotesByChat` (render Phase 2); §4.5 → Phase 2; §4.6 → Task 1/2; §5.1 → Task 5; §5.2 → Task 8; §6.1 → Task 2; §6.2 → Task 6; §7.1 → Task 3/4; §7.2 → Phase 2 reserved; §8 → Phase 3 reserved; §9 → Task 4/6; §10 → Task 1/8; §11 → Task 7（`/memory`；selfcheck 的 `people` 项明确留到 Phase 2）。
- **Type consistency:** `personNoteCount`, `ownerFacts`, `personNotesByChat`, `ownerDocPath`, `ownerText`, `OWNER_SECTION`, `ownerDocText`, `ownerSectionText`, `buildOwnerNote`, `hasOwnerNote`, `run` are used consistently across tasks.
- **Review Focus tests:** malformed person → Task 1; flag abuse → Task 1; cross-surface → Task 4/6; supersede/revoke → Task 2/3; migration idempotency → Task 8.
- **Proportion:** Tasks carry signatures and assertions; implementation bodies appear only for `normalizePerson`, derive collection, owner renderer, and migration builder — the four places where the algorithm is not determined by the signature.
