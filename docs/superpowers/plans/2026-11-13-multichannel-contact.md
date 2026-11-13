# 多通道 Contact / Absence 实现计划（方案 A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH 网页直聊、微信入站、B 站 owner 回复都算 contact，任何一处都重置 `absence`；同时不让其他通道的 contact 串掉网页 home 的 `heard_share` / `he_silent` 卡。

**Architecture:** 保持 `meta seen:<ISO>` 为全局 contact，新增配套 `meta contact:<channel>:<ISO>` 记录来源；`markSeen` 是唯一写入口。`absence`/`away` 继续读全局 `seen:`；`derive` 用 `contact:` 维护 per-channel 状态，两张跨通道卡只读 `web`。三个源（DSH / 微信 / B 站）各自接入，互不依赖。

**Tech Stack:** Node.js 24 ESM、`node:test`、零新增依赖。

**Spec / Research:**
- `docs/superpowers/specs/2026-11-13-person-memory-design.md` §9
- `docs/research/2026-11-13-multichannel-contact.md`
- `docs/superpowers/specs/2026-11-13-presence-watch-design.md` §7.5（presence 只写 `meta presence`，不参与 contact）

---

## Global Constraints

- 在 `bigfish-workspace-dev` worktree 里实现；它是线上 8710 的部署线，测试通过、迁移/验收前不要重启 `dsh-web`。
- 事件流只追加；不删除、不重排、不改写历史事件。
- **不新增事件类型、不升 schema**：`seen:` / `contact:` 都是 `meta`。
- `seen:` 格式保持 `seen:<ISO>`；`contact:` 格式固定 `contact:<channel>:<ISO>`，channel ∈ `web | wx | qq | bili | screen`。
- `markSeen` 先写 `seen:`，再写 `contact:`；`contact:` 失败不能回滚已经写下的 `seen:`。
- `absence` / `away` 继续读全局 `seen:`；`heard_share` / `he_silent` 只读 web contact。
- v1 只把 **DSH web 面**、**微信 DM/免 @ 白名单**、**B 站 owner 回复** 算 contact；群 owner @、QQ、screen 面暂不算（见 Out of Scope）。
- presence 不写 `seen:`、不写 `contact:`、不重置 absence。
- 同一 channel 60 秒内重复 contact 去重（内存态；重启后失效可接受）。
- 测试命令：
  - `cd src/dsh-fish && node --test`
  - `cd src/dsh-wx && node --test`
  - `cd src/dsh-bili && node --test`
- 提交前在 worktree 根目录跑 `python scripts/audit-staged.py`；只暂存本任务路径。

---

## Review Focus

1. **全局 vs 每通道**：`seen:` 必须重置 absence；`contact:wx` / `contact:bili` 不能把网页 home 的 `heard_share` 触发或 `he_silent` 抑制。
2. **旧事件兼容**：只有 `seen:` 的历史事件继续被当作 web contact，不能因为新增 `contact:` 而丢掉旧行为。
3. **系统回合误报**：唤醒/收盘/出门/系统 poke/逾期提醒不能写 contact；真实用户消息、微信 DM、B站 owner 回复必须写。
4. **owner 识别**：B 站只认 `owner.mid` / `owner.account.mid`；微信 v1 只认 DM/免 @ 白名单，群里陌生人 @ 不算。
5. **失败不阻断**：`markSeen` / `fishCore` 缺席 / 微信投递失败时，不能影响消息投递或主流程；只记日志/返回 why。

---

## Before You Start

- 进入 worktree：`cd /home/str1k3/src/bigfish-workspace-dev`。
- `git status`：允许 `docs/`、`.superpowers/` 等未跟踪文件；不要 `git clean`。
- 基线：
  - `cd src/dsh-fish && node --test` 全绿；
  - `cd src/dsh-wx && node --test` 全绿；
  - `cd src/dsh-bili && node --test` 全绿。
- 读一遍 research 文档的 §1–§4；实现以本计划为准。

---

## File Structure

### 新增

| 文件 | 职责 |
|---|---|
| `src/dsh-fish/lib/contact.js` | `isContactMessage`、`markSeen`、60 秒去重、`resetContactCache` |
| `src/dsh-fish/test/contact.test.mjs` | 过滤规则、写入顺序、去重 |
| `src/dsh-wx/lib/contact.js` | `isContactWhy(why)`（DM/免 @ 白名单） |
| `src/dsh-wx/test/contact.test.mjs` | 微信 contact 口径 |
| `src/dsh-bili/test/contact-reply.test.mjs` | owner mid 命中/路人/去重 |

### 修改

| 文件 | 修改 |
|---|---|
| `src/dsh-fish/lib/derive.js` | `contact:` prepass、per-channel maps、web 卡值 |
| `src/dsh-fish/lib/events.js` | `heard_share` / `he_silent` 改用 web 值 |
| `src/dsh-fish/lib/say.js` | 写 contact 改走 `markSeen` |
| `src/dsh-fish/lib/capture.js` | 写 contact 改走 `markSeen`；加 `wakeSectionFor` 判断 |
| `src/dsh-fish/lib/memory-service.js` | 暴露 `markSeen` |
| `src/dsh-fish/lib/index.js` | 注册 `session/event` `user/message` 监听 |
| `src/dsh-fish/lib/observe.js` | `/memory` 增加 `contacts.lastByChannel`（可选） |
| `src/dsh-fish/test/derive.test.mjs` | per-channel + 卡片条件 |
| `src/dsh-fish/test/p1.test.mjs` | capture 兜底修正 |
| `src/dsh-fish/test/memory-service.test.mjs` | `markSeen` 门面 |
| `src/dsh-wx/lib/index.js` | `deliver` / `deliverToChat` 的 `{ contact }` |
| `src/dsh-bili/lib/comment.js` | `scanReplies` owner mid + `markSeen` |

---

# PR 1：Contact 地基

## Task 1: `contact.js` 原语

**Files:**
- Create: `src/dsh-fish/lib/contact.js`
- Create: `src/dsh-fish/test/contact.test.mjs`

**Interfaces:**
- `isContactMessage({ event, surface }) -> boolean`
- `markSeen(root = rootDir(), { channel = 'web', at = Date.now(), dedupe = true } = {}) -> Promise<{ ok: boolean, why?: string, contact?: boolean, skipped?: boolean }>`
- `resetContactCache() -> void`

- [ ] **Step 1: Write failing tests**

Create `src/dsh-fish/test/contact.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isContactMessage, markSeen, resetContactCache } from '../lib/contact.js'
import { readEvents } from '../lib/store.js'

const msg = (text, { rpcId = 'rpc-1', kind = 'user', surface = 'web' } = {}) => ({
  event: { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind, rpcId } } },
  surface,
})

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'fish-contact-'))
  try { return await fn(root) } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

test('isContactMessage：真实 web 用户消息算', () => {
  assert.equal(isContactMessage(msg('今天吃什么')), true)
  assert.equal(isContactMessage(msg('')), true, '图片/空文本也算 contact')
})

test('isContactMessage：系统消息与系统 trigger 不算', () => {
  assert.equal(isContactMessage(msg('x', { kind: 'runtime-context' })), false)
  for (const id of ['wake-1', 'wake-fresh-1', 'closing-2026-11-13', 'bili-2026-11-13-1', 'say-2026-11-13-1']) {
    assert.equal(isContactMessage(msg('x', { rpcId: id })), false, id)
  }
  assert.equal(isContactMessage(msg('（醒一醒）')), false)
  assert.equal(isContactMessage(msg('（收工了。）')), false)
  assert.equal(isContactMessage(msg('[微信·主机] poke')), false)
})

test('isContactMessage：非 web 面不算（v1）', () => {
  for (const surface of ['wx', 'bili', 'screen', 'qq']) {
    assert.equal(isContactMessage(msg('x', { surface })), false, surface)
  }
})

test('markSeen：先 seen 再 contact，同一 channel 去重', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const a = await markSeen(root, { channel: 'web', at: Date.parse('2026-11-13T10:00:00Z') })
    assert.equal(a.ok, true)
    const { events } = await readEvents(root)
    assert.deepEqual(events.map((e) => e.text), [
      'seen:2026-11-13T10:00:00.000Z',
      'contact:web:2026-11-13T10:00:00.000Z',
    ])
    const b = await markSeen(root, { channel: 'web', at: Date.parse('2026-11-13T10:00:30Z') })
    assert.equal(b.skipped, true)
    assert.equal((await readEvents(root)).events.length, 2)
    const c = await markSeen(root, { channel: 'wx', at: Date.parse('2026-11-13T10:01:00Z') })
    assert.equal(c.ok, true)
    assert.equal((await readEvents(root)).events.length, 4)
  })
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/contact.test.mjs`
Expected: FAIL with `Cannot find module '../lib/contact.js'`.

- [ ] **Step 3: Implement `contact.js`**

```js
import { appendEvent, rootDir } from './store.js'
import { WAKE_TRIGGER } from './wakeconst.js'

// 收盘任务在成长线里可能先于本计划落地；先按字面值排除，避免 import 一个还不存在的常量。
const CLOSING_TRIGGER_TEXT = '（收工了。）'
const CHANNELS = new Set(['web', 'wx', 'qq', 'bili', 'screen'])
const DEDUPE_MS = 60_000
const SYSTEM_RPC = /^(wake-|wake-fresh-|closing-|bili-|say-|presence-)/
let lastByChannel = new Map()

function textOf(data) {
  const content = Array.isArray(data?.content) ? data.content : []
  const [block] = content
  return content.length === 1 && block?.type === 'text' ? String(block.text ?? '') : ''
}

export function isContactMessage({ event, surface } = {}) {
  if (!event || event.type !== 'user/message') return false
  if (surface !== 'web') return false
  const source = event.data?.source
  if (!source || source.kind !== 'user') return false
  if (SYSTEM_RPC.test(String(source.rpcId ?? ''))) return false
  const text = textOf(event.data)
  if (text === WAKE_TRIGGER || text === CLOSING_TRIGGER_TEXT) return false
  if (text.startsWith('[微信·主机]')) return false
  return true
}

export async function markSeen(root = rootDir(), { channel = 'web', at = Date.now(), dedupe = true } = {}) {
  const ch = CHANNELS.has(String(channel)) ? String(channel) : 'web'
  const now = Number(at) || Date.now()
  const last = lastByChannel.get(ch) ?? 0
  if (dedupe && now - last < DEDUPE_MS) return { ok: true, skipped: true }
  const iso = new Date(now).toISOString()
  try {
    await appendEvent({ type: 'meta', text: `seen:${iso}` }, { source: 'system' }, root)
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
  }
  // seen 成功后再生效去重；写失败允许下一次重试。
  lastByChannel.set(ch, now)
  try {
    await appendEvent({ type: 'meta', text: `contact:${ch}:${iso}` }, { source: 'system' }, root)
  } catch (err) {
    return { ok: true, contact: false, why: String(err?.message ?? err).slice(0, 160) }
  }
  return { ok: true, contact: true }
}

export function resetContactCache() { lastByChannel = new Map() }
```

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/contact.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/contact.js src/dsh-fish/test/contact.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): contact 写入口与 seen/contact 双标记"
```

---

## Task 2: Derive per-channel contact + card conditions

**Files:**
- Modify: `src/dsh-fish/lib/derive.js`
- Modify: `src/dsh-fish/lib/events.js`
- Modify: `src/dsh-fish/test/derive.test.mjs`

**Interfaces:**
- `deriveSelf(...)` adds:
  - `lastSeenAtByChannel: { web, wx, qq, bili, screen }`
  - `spokenSinceSeenByChannel: { ... }`
  - `heardSinceWakeByChannel: { ... }`
  - `lastSeenAtWeb`, `spokenSinceSeenWeb`, `heardSinceWakeWeb`
- `heard_share.cond` uses `lastSeenAtWeb` / `spokenSinceSeenWeb`
- `he_silent.cond` uses `heardSinceWakeWeb`

- [ ] **Step 1: Write failing derive tests**

Append to `src/dsh-fish/test/derive.test.mjs` (add `findTemplate` to the existing top import from `../lib/events.js`):

```js

const META = (text, ts = '2026-11-12T00:00:00Z') => ({
  id: `ev_${text}`, ts, day: 1, stage: 1, type: 'meta', source: 'system',
  text, refs: [], verdict: null, confidence: 0.5, flags: [],
})

test('contact:wx 配对的 seen 不算 web contact', () => {
  const iso = '2026-11-12T10:00:00.000Z'
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    META(`seen:${iso}`, iso),
    META(`contact:wx:${iso}`, iso),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.ok(m.lastSeenAt > 0)
  assert.ok(m.lastSeenAtByChannel.wx > 0)
  assert.equal(m.lastSeenAtByChannel.web, 0)
  assert.equal(m.spokenSinceSeenWeb, false)
  assert.equal(m.heardSinceWakeWeb, false)
})

test('只有旧 seen 时按 web 兼容', () => {
  const iso = '2026-11-12T10:00:00.000Z'
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    META(`seen:${iso}`, iso),
  ]
  const m = deriveSelf(evs, { now: T0 + 2 * DAY_MS })
  assert.ok(m.lastSeenAtWeb > 0)
  assert.equal(m.spokenSinceSeenWeb, false)
})

test('heard_share 只认 web contact', () => {
  // 卡的 cond 用真实 Date.now()，所以这里必须用“现在”的时间戳，不能用 T0。
  const iso = new Date().toISOString()
  const seed = ev('ev_seed', 'seed', 1, '种', { source: 'system' })
  const wx = [seed, META(`seen:${iso}`, iso), META(`contact:wx:${iso}`, iso)]
  const web = [seed, META(`seen:${iso}`, iso)]
  const tpl = findTemplate('heard_share')
  assert.equal(tpl.cond(deriveSelf(wx)), false)
  assert.equal(tpl.cond(deriveSelf(web)), true)
})

test('he_silent 不被 wx contact 抑制', () => {
  const wakeIso = new Date(Date.now() - 30 * 3600_000).toISOString()
  const wxIso = new Date().toISOString()
  const evs = [
    ev('ev_seed', 'seed', 1, '种', { source: 'system' }),
    { ...META(`wake:${wakeIso.slice(0, 10)} why_here`, wakeIso), day: 1 },
    META(`seen:${wxIso}`, wxIso),
    META(`contact:wx:${wxIso}`, wxIso),
  ]
  const m = deriveSelf(evs)
  assert.equal(m.heardSinceWakeWeb, false)
  assert.equal(findTemplate('he_silent').cond(m), true)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/derive.test.mjs`
Expected: FAIL with `lastSeenAtByChannel` undefined / cond false.

- [ ] **Step 3: Implement derive**

At the top of `deriveSelf` (near `let lastSeenAt = 0`), add:

```js
const CONTACT_CHANNELS = ['web', 'wx', 'qq', 'bili', 'screen']
const zero = () => Object.fromEntries(CONTACT_CHANNELS.map((c) => [c, 0]))
const bools = (v) => Object.fromEntries(CONTACT_CHANNELS.map((c) => [c, v]))
const lastSeenAtByChannel = zero()
const spokenSinceSeenByChannel = bools(false)
const heardSinceWakeByChannel = bools(false)
```

After `evs` is ordered and before the main loop, add a prepass:

```js
const contactByIso = new Map()
for (const ev of evs) {
  if (ev.type !== 'meta') continue
  const m = /^contact:([a-z]+):(.+)$/.exec(String(ev.text ?? ''))
  if (!m) continue
  const ch = m[1]
  if (!CONTACT_CHANNELS.includes(ch)) continue
  const iso = m[2]
  const at = Date.parse(iso) || Date.parse(ev.ts) || 0
  contactByIso.set(iso, ch)
  if (at > lastSeenAtByChannel[ch]) lastSeenAtByChannel[ch] = at
  spokenSinceSeenByChannel[ch] = false
  heardSinceWakeByChannel[ch] = true
}
```

In the `meta` case, replace the `seen:` branch with:

```js
if (t.startsWith('seen:')) {
  const iso = t.slice(5)
  const at = Date.parse(iso) || Date.parse(ev.ts) || 0
  if (at > lastSeenAt) lastSeenAt = at
  spokenSinceSeen = false
  heardSinceWake = true
  if (!contactByIso.has(iso)) {
    if (at > lastSeenAtByChannel.web) lastSeenAtByChannel.web = at
    spokenSinceSeenByChannel.web = false
    heardSinceWakeByChannel.web = true
  }
} else if (t.startsWith('wake:')) {
  const at = Date.parse(ev.ts) || 0
  if (at > lastWakeAt) lastWakeAt = at
  heardSinceWake = false
  heardSinceWakeByChannel.web = false
}
```

Add to the returned model object (near `lastSeenAt`):

```js
lastSeenAtByChannel,
spokenSinceSeenByChannel,
heardSinceWakeByChannel,
lastSeenAtWeb: lastSeenAtByChannel.web,
spokenSinceSeenWeb: spokenSinceSeenByChannel.web,
heardSinceWakeWeb: heardSinceWakeByChannel.web,
```

In `events.js`:

- `heard_share.cond`: replace `m.lastSeenAt` / `m.spokenSinceSeen` with `m.lastSeenAtWeb` / `m.spokenSinceSeenWeb`.
- `he_silent.cond`: replace `!m.heardSinceWake` with `!m.heardSinceWakeWeb`.

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/derive.test.mjs test/events.test.mjs test/events-pace.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass. If existing tests construct a model without the new fields and call `heard_share`/`he_silent`, update them to include the web fields (the new fields are the only change in behavior).

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/derive.js src/dsh-fish/lib/events.js src/dsh-fish/test/derive.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): per-channel contact 与跨通道卡隔离"
```

---

## Task 3: `say.js` / `capture.js` 走 `markSeen`

**Files:**
- Modify: `src/dsh-fish/lib/say.js`
- Modify: `src/dsh-fish/lib/capture.js`
- Modify: `src/dsh-fish/test/p1.test.mjs`

**Interfaces:**
- `sayToHer` writes `markSeen(root, { channel: deps.channel ?? 'web' })` instead of a bare `seen:`.
- `capture.js` writes `markSeen(root, { channel: channelOfAgent(exec.agent) })` only when `!inWake() && !wakeSectionFor(exec.agent)`.

- [ ] **Step 1: Write failing capture test**

Append to `src/dsh-fish/test/p1.test.mjs`:

```js
import { setWakeSection, clearWakeSection } from '../lib/identity.js'

test('捕获里挂着 fish:wake 段时，即使 inWake 已退出也不写 contact', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    await writeConfig(normalizeConfig({}), root)
    const ctx = fakeCtx()
    registerCapture(ctx, { root })
    const tool = ctx.regs.get('growth_commit')
    const exec = { agent: { session: { header: { id: 's1' } } } }
    setWakeSection('（醒一醒）', 's1')
    try {
      await tool.execute({ type: 'utterance', text: '这是唤醒回合里写的。' }, exec)
    } finally {
      clearWakeSection('s1')
    }
    const { events } = await readEvents(root)
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('seen:')).length, 0)
    assert.equal(events.filter((e) => e.type === 'meta' && String(e.text).startsWith('contact:')).length, 0)
  })
})
```

Also update the existing “窗口外写东西 → 记一条 seen” test: `markSeen` now writes `seen:` + `contact:web:`, so filter by prefix rather than exact count; assert one `seen:` and one `contact:web:`. Import `resetContactCache` from `../lib/contact.js` and call it at the start of the test (module-level dedupe state is shared across tests).

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/p1.test.mjs`
Expected: FAIL — the wake-section case still writes `seen:` / the exact count changed.

- [ ] **Step 3: Implement**

`say.js`:

- Import `markSeen` from `./contact.js`.
- Replace the `appendEvent({ type:'meta', text:`seen:...` })` block with:

```js
await markSeen(root, { channel: deps.channel ?? 'web' }).catch(() => {})
```

`capture.js`:

- Import `markSeen` from `./contact.js` and `wakeSectionFor` from `./identity.js`.
- Replace the `if (!inWake()) { ... }` block with:

```js
if (!inWake() && !wakeSectionFor(exec?.agent)) {
  await markSeen(root, { channel: channelOfAgent(exec?.agent) }).catch(() => {})
}
```

- Keep the existing comment about `source:'system'`, but update it to explain `markSeen` writes the meta.

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/p1.test.mjs test/p3.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass. Update any test that asserted the exact old `seen:` event count.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/say.js src/dsh-fish/lib/capture.js src/dsh-fish/test/p1.test.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-fish): contact 走统一写入口，唤醒回合不再误记"
```

---

## Task 4: Expose `markSeen` on `fishCore.memory`

**Files:**
- Modify: `src/dsh-fish/lib/memory-service.js`
- Modify: `src/dsh-fish/test/memory-service.test.mjs`

**Interfaces:**
- `fishCore.memory.markSeen({ channel = 'web', at, dedupe } = {}) -> Promise<{ ok, why?, contact?, skipped? }>`
- Internally calls `contact.markSeen(baseRoot, opts)`.

- [ ] **Step 1: Write failing test**

Append to `src/dsh-fish/test/memory-service.test.mjs`:

```js
test('markSeen：门面写 seen + contact，去重可关', async () => {
  await withRoot(async (root) => {
    resetContactCache()
    const m = mem(root)
    const a = await m.markSeen({ channel: 'wx', at: Date.parse('2026-11-13T10:00:00Z') })
    assert.equal(a.ok, true)
    const events = await diskEvents(root)
    assert.deepEqual(events.map((e) => e.text), [
      'seen:2026-11-13T10:00:00.000Z',
      'contact:wx:2026-11-13T10:00:00.000Z',
    ])
    const b = await m.markSeen({ channel: 'wx', at: Date.parse('2026-11-13T10:00:10Z') })
    assert.equal(b.skipped, true)
  })
})
```

Add `import { resetContactCache } from '../lib/contact.js'` at the top.

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-fish && node --test test/memory-service.test.mjs`
Expected: FAIL with `m.markSeen is not a function`.

- [ ] **Step 3: Implement**

In `memory-service.js`:

```js
import { markSeen as markSeenAt } from './contact.js'
// ...
async function markSeen(opts = {}) {
  return markSeenAt(baseRoot, opts)
}
// return { ..., markSeen }
```

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-fish && node --test test/memory-service.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/memory-service.js src/dsh-fish/test/memory-service.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): fishCore.memory.markSeen 门面"
```

---

# PR 2：DSH 网页直聊

## Task 5: `session/event` `user/message` 监听

**Files:**
- Modify: `src/dsh-fish/lib/index.js`
- Modify: `src/dsh-fish/test/contact.test.mjs`（过滤规则已覆盖；这里补 index 常量/路径测试）

**Interfaces:**
- `isContactMessage` from Task 1.
- `index.js` registers `ctx.on('session/event', (session, event) => ...)` after `herDir` is known.
- Only `surface === 'web'`; `isHerAgent({ session }, herDir)`.

- [ ] **Step 1: Add an integration-style test for the filter wiring**

If `index.js` boot is hard to test, add to `contact.test.mjs`:

```js
test('isContactMessage 只接受 web 面', () => {
  assert.equal(isContactMessage(msg('你好', { surface: 'web' })), true)
  assert.equal(isContactMessage(msg('你好', { surface: 'wx' })), false)
  assert.equal(isContactMessage(msg('你好', { surface: 'screen' })), false)
})
```

(The filter tests already exist in Task 1; this step is a guard if the wiring changes.)

- [ ] **Step 2: Implement the listener**

At the top of `index.js`, add static imports (do not put `import` inside `boot()`):

```js
import { isContactMessage, markSeen } from './contact.js'
import { isHerAgent } from './restrict.js'
```

Then, inside `boot()`, after `const herDir = await ensureHer(root)` and before `bootstrapHome`:

```js
try {
  const onSessionEvent = (session, event) => {
    try {
      if (!isHerAgent({ session }, herDir)) return
      const surface = fishCore?.surface?.current?.({ session }) ?? ''
      if (!isContactMessage({ event, surface })) return
      void markSeen(root, { channel: surface }).catch(() => {})
    } catch { /* 一个消息不能拖垮总线 */ }
  }
  const off = ctx.on?.('session/event', onSessionEvent)
  if (typeof off === 'function') disposers.push(off)
} catch (err) {
  logger.warn('[dsh-fish] contact 监听没挂上', err?.message ?? err)
}
```

- [ ] **Step 3: Verify imports and disposal**

- `isHerAgent` import path `./restrict.js`; it is already imported elsewhere in index? Check and avoid duplicate imports.
- `disposers` is in scope.
- `fishCore` is in scope.
- The listener must be registered before `bootstrapHome` creates agents.

- [ ] **Step 4: Run tests**

Run: `cd src/dsh-fish && node --test test/contact.test.mjs test/boot.test.mjs`
Expected: PASS.
Run: `cd src/dsh-fish && node --test`
Expected: all pass.

- [ ] **Step 5: Manual verification (after deployment, not now)**

- In the web home session, type a message; confirm a `seen:` + `contact:web:` pair appears in `~/.dsh-fish/events.jsonl`.
- Trigger a wake; confirm no `seen:`/`contact:` pair is added for the wake turn.
- This step is verification only; do not restart the service until the user approves deployment.

- [ ] **Step 6: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/index.js src/dsh-fish/test/contact.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-fish): DSH 网页直聊写 contact"
```

---

# PR 3：微信入站

## Task 6: dsh-wx `deliver` contact 标志

**Files:**
- Create: `src/dsh-wx/lib/contact.js`
- Create: `src/dsh-wx/test/contact.test.mjs`
- Modify: `src/dsh-wx/lib/index.js`

**Interfaces:**
- `isContactWhy(why) -> boolean` (`dm` / `exempt`)
- `deliver(sessionId, text, { contact = false } = {})`
- `deliverToChat(chatName, chatId, text, { contact = false } = {})`
- On success and `contact`, call `fishCore.memory.markSeen({ channel:'wx' })`.

- [ ] **Step 1: Write failing helper test**

Create `src/dsh-wx/lib/contact.js`:

```js
/** 微信里哪些“有人找你”算 contact：单聊、免 @ 白名单。群 @/点名 v1 不算。 */
export function isContactWhy(why) {
  return why === 'dm' || why === 'exempt'
}
```

Create `src/dsh-wx/test/contact.test.mjs`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isContactWhy } from '../lib/contact.js'

test('微信 contact：单聊/免 @ 白名单算，群 @/点名不算', () => {
  assert.equal(isContactWhy('dm'), true)
  assert.equal(isContactWhy('exempt'), true)
  assert.equal(isContactWhy('name'), false)
  assert.equal(isContactWhy('at'), false)
  assert.equal(isContactWhy(''), false)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-wx && node --test test/contact.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `deliver` / `deliverToChat`**

In `src/dsh-wx/lib/index.js`:

- Import `isContactWhy` from `./contact.js`.
- Add:

```js
const markContact = () => {
  try {
    const core = ctx.get?.('fishCore')
    const p = core?.memory?.markSeen?.({ channel: 'wx' })
    if (p?.catch) p.catch(() => {})
  } catch { /* 记忆写失败不影响投递 */ }
}
```

- Change `deliver`:

```js
const deliver = (sessionId, text, { contact = false } = {}) => {
  const p = controller().prompt({
    sessionId,
    requestId: randomUUID(),
    content: [{ type: 'text', text }],
  }, new AbortController().signal)
  if (contact) p.then(markContact).catch(() => {})
  return p
}
```

- Change `deliverToChat` signature and fallback:

```js
const deliverToChat = async (chatName, chatId, text, opts = {}) => {
  const sid = await sessionForChat(chatName, chatId)
  try {
    await deliver(sid, text, opts)
    return sid
  } catch (err) {
    // ...
    await deliver(main, text, opts)
    return main
  }
}
```

- At the real mention call (around 2263):

```js
const sid = await deliverToChat(chat, chatId, note, { contact: isContactWhy(h.why) })
```

- Leave the overdue call (`overdueText`) and the `[微信·主机]` poke call unchanged (contact defaults false).

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-wx && node --test test/contact.test.mjs`
Expected: PASS.
Run: `cd src/dsh-wx && node --test`
Expected: all pass.
Run: `cd src/dsh-fish && node --test`
Expected: all pass (no cross-package imports changed).

- [ ] **Step 5: Manual verification (after deployment, not now)**

- Send a WeChat DM to her; confirm `seen:` + `contact:wx:` appear.
- Trigger an overdue reminder / poke; confirm no new contact pair.
- This is verification only; no service restart until approved.

- [ ] **Step 6: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-wx/lib/contact.js src/dsh-wx/test/contact.test.mjs src/dsh-wx/lib/index.js
python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 微信入站写 contact"
```

---

# PR 4：B 站 owner 回复

## Task 7: `scanReplies` owner mid

**Files:**
- Modify: `src/dsh-bili/lib/comment.js`
- Create: `src/dsh-bili/test/contact-reply.test.mjs`

**Interfaces:**
- `scanReplies()` return rows add `mid: string`, `isOwner: boolean`.
- owner set = `owner.mid` ∪ `owner.account.mid`.
- On `isOwner && memory?.markSeen`, call `memory.markSeen({ channel:'bili' })`.

- [ ] **Step 1: Write failing test**

Create `src/dsh-bili/test/contact-reply.test.mjs`:

```js
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

async function run({ replyMid, ownerMid = OWNER, accountMid = ACCOUNT, markSeen = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-contact-'))
  const events = [{ type: 'meta', text: `comment:${dateKey()} ${BV} 123`, ts: new Date().toISOString() }]
  const { core } = fakeCore({ events, config: {} })
  core.owner.read = async () => ({ mid: ownerMid, account: { mid: accountMid } })
  setCore(core)
  const client = {
    view: async () => ({ data: { aid: 1 } }),
    subReplies: async () => ({ ok: true, data: [{ rpid: 42, text: '回你一句', mid: replyMid, user: '某人' }] }),
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

test('owner.mid 回复算 contact', async () => {
  const { out, markSeen } = await run({ replyMid: Number(OWNER) })
  assert.equal(out[0].isOwner, true)
  assert.deepEqual(markSeen, [{ channel: 'bili' }])
})

test('owner.account.mid 回复也算', async () => {
  const { out, markSeen } = await run({ replyMid: Number(ACCOUNT) })
  assert.equal(out[0].isOwner, true)
  assert.equal(markSeen.length, 1)
})

test('路人回复不算', async () => {
  const { out, markSeen } = await run({ replyMid: 999 })
  assert.equal(out[0].isOwner, false)
  assert.equal(markSeen.length, 0)
})
```

- [ ] **Step 2: Run and verify failure**

Run: `cd src/dsh-bili && node --test test/contact-reply.test.mjs`
Expected: FAIL — `isOwner` undefined / `markSeen` not called.

- [ ] **Step 3: Implement**

In `src/dsh-bili/lib/comment.js` `scanReplies`:

```js
const ow = await readOwner().catch(() => null)
const ownerMids = new Set([ow?.mid, ow?.account?.mid].filter(Boolean).map(String))
```

Inside the reply loop:

```js
const mid = String(s.mid ?? '')
const isOwner = ownerMids.has(mid)
// ... existing bili_reply write ...
if (isOwner && typeof memory?.markSeen === 'function') {
  await memory.markSeen({ channel: 'bili' }).catch(() => {})
}
out.push({ bvid: c.bvid, aid, rootRpid: c.rpid, rpid: s.rpid, user, text: dirty.text, ctime: s.ctime, mid, isOwner })
```

- [ ] **Step 4: Run focused and full tests**

Run: `cd src/dsh-bili && node --test test/contact-reply.test.mjs`
Expected: PASS.
Run: `cd src/dsh-bili && node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-bili/lib/comment.js src/dsh-bili/test/contact-reply.test.mjs
python scripts/audit-staged.py
git commit -m "feat(dsh-bili): owner 回复 B 站评论写 contact"
```

---

# PR 5：观测与最终验收

## Task 8: Observability + full acceptance

**Files:**
- Modify: `src/dsh-fish/lib/observe.js`（可选，`/memory` 增加 `contacts.lastByChannel`）
- Modify: `docs/research/2026-11-13-multichannel-contact.md`（记录实施结果）
- Modify: `docs/superpowers/specs/2026-11-13-person-memory-design.md`（§9.2 的 contact 信号已定；如有实现差异，回写）

**Interfaces:**
- `/memory` response adds:

```js
contacts: {
  lastAt: model.lastSeenAt,
  lastByChannel: model.lastSeenAtByChannel,
}
```

- [ ] **Step 1: Add the `/memory` field**

In `observe.js` `/memory`, add `contacts` near `events`/`diaries`:

```js
contacts: {
  lastAt: model.lastSeenAt,
  lastByChannel: model.lastSeenAtByChannel,
},
```

- [ ] **Step 2: Add a pure summary helper test (if the route is hard to test)**

Add to `src/dsh-fish/test/people-view.test.mjs` or a small `contact-summary` test:

```js
test('contacts summary 只暴露每通道最后时间', () => {
  const model = { lastSeenAt: 100, lastSeenAtByChannel: { web: 100, wx: 0, qq: 0, bili: 50, screen: 0 } }
  const summary = {
    lastAt: model.lastSeenAt,
    lastByChannel: model.lastSeenAtByChannel,
  }
  assert.equal(summary.lastByChannel.web, 100)
  assert.equal(summary.lastByChannel.bili, 50)
})
```

- [ ] **Step 3: Run the full suites**

Run:

```bash
cd src/dsh-fish && node --test
cd ../dsh-wx && node --test
cd ../dsh-bili && node --test
```

Expected: all pass.

- [ ] **Step 4: Manual acceptance checklist (after deployment, not now)**

- Web UI message → `seen:` + `contact:web`; absence resets.
- Wake/closing/outing turn → no contact pair.
- WeChat DM → `seen:` + `contact:wx`; overdue/poke → no contact.
- B站 owner reply → `seen:` + `contact:bili`; stranger reply → no contact.
- Web `heard_share` not triggered by wx/B站 contact; `he_silent` not suppressed by them.
- Presence meta → no `seen:`/`contact:`; absence unchanged.
- `/memory` `contacts.lastByChannel` reflects the latest per-channel times.

- [ ] **Step 5: Commit**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/observe.js docs/research/2026-11-13-multichannel-contact.md docs/superpowers/specs/2026-11-13-person-memory-design.md
python scripts/audit-staged.py
git commit -m "docs(dsh-fish): 多通道 contact 观测与实现记录"
```

---

## Out of Scope

These are intentionally **not** in this plan; do not implement without a separate spec:

- **QQ contact**: `say.js` may cover QQ adapters; the per-channel `contact:qq` and card behavior are not added. `markSeen` accepts `qq`, but no source writes it.
- **微信群 owner @**: v1 only DM/免 @ 白名单. Group `@`/点名 needs owner WeChat aliases (from `person_note` owner facts) before it can be counted; otherwise strangers @ing her would count.
- **B站实时通知**: `scanReplies` runs on the existing outing/service cadence; owner replies outside the window are picked up later. A dedicated B站 notification poll is a separate task.
- **presence persona 冷话分支**: `persona.js` still says “他没出现” when absence + presence; the user has not finalized that wording. Presence data is available via `presenceRecent`, but no persona change in this plan.
- **screen 面 contact**: presence sessions are system-driven; no contact.

---

## Reserved Interfaces

- `contact:<channel>:<ISO>` is the stable per-channel marker. Future sources (QQ, group owner, B站 notification) write it via `markSeen`.
- `lastSeenAtByChannel` / `spokenSinceSeenByChannel` / `heardSinceWakeByChannel` are stable model fields; future cards should use them instead of the global values when the card is channel-specific.
- `isContactMessage` is web-only in v1. To add QQ, change the surface check to `surface === 'web' || surface === 'qq'` and add `contact:qq` tests.

---

## Self-Review Notes

- **Spec/research coverage:** global `seen:` → Task 1/3/4; per-channel contact → Task 2; DSH web → Task 5; WeChat → Task 6; B站 → Task 7; observability → Task 8; out-of-scope items listed.
- **Type consistency:** `markSeen`, `isContactMessage`, `resetContactCache`, `lastSeenAtByChannel`, `spokenSinceSeenByChannel`, `heardSinceWakeByChannel`, `lastSeenAtWeb`, `spokenSinceSeenWeb`, `heardSinceWakeWeb`, `isContactWhy`, `isOwner` are used consistently.
- **Review Focus tests:** global vs per-channel → Task 2; legacy `seen:` → Task 2; system-turn false positives → Task 1/3/5/6; owner identity → Task 7; failure isolation → Task 1/6.
- **Proportion:** code blocks are limited to the non-obvious algorithms (`markSeen`, derive prepass) and test fixtures; other steps specify signatures and assertions.
