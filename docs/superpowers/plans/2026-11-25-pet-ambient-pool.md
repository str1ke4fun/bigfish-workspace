# 桌宠氛围池（服务端配置 + 管理 API）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把桌宠氛围池从壳内硬编码迁移为“服务端 `config.pet.ambient` 用户策略 + 壳侧 `ambient.json` 默认值”，提供可增删表情、改权重、改频率的管理 API，并让 `event` / `work` / `ambient` / `off` 四种 presence 模式按各自策略驱动 ambient。

**Architecture:** 服务端新增纯数据层 `pet-ambient.js`（校验、合并、CRUD）和固定路径 `GET/POST /pet/ambient`；壳侧新增 `ambient.json` 解析与 IPC catalog，渲染进程按 `presence.mode` 选策略；触发引擎在 policy 存在时走新的调度路径，policy 缺失时保留旧 `ambient` trigger 兼容。

**Tech Stack:** Node.js 24（内置 `node:test`）、零依赖 `dsh-fish`、Electron/TypeScript/React 19、`dsh-pet-component 0.2.5`、8788 BFF。

**Spec:** `docs/research/2026-11-25-pet-ambient-pool-design.md`（策略与 schema）、`docs/research/2026-11-25-desktop-pet-state-and-events.md`（5 类输入/角色）

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 必须保持 `{}`。
- 不写 `events.jsonl`、presence 台账或模型调用；ambient 只写内存与 `config.pet.ambient`。
- presence 模式固定为 `off / event / ambient / work`；不新增 `ambientMode` 设置。
- 用户策略放服务端 `config.pet.ambient`；壳侧 `ambient.json` 只做默认/皮肤覆盖。
- BFF 只支持固定路径，`/pet/ambient` 用 `GET` + `POST { op }`，不要用 `:mode/:action` 动态段。
- 动作 id 使用 `^[a-z0-9-]{1,32}$`；未知动作逐条丢弃，不能让整份策略或手动动作失效。
- `items` 是整体替换；`frequency` 按字段合并；写入 `revision++`。
- UI 可以后做；本轮必须内置数据层与 HTTP API。
- 测试：`src/dsh-fish` 用 `node --test`；`workbench` 用 `node --test`；`desktop-pet` 用 `npm test`。任何一条红都不提交。
- Windows 真机的透明、解码、闪烁、点击穿透仍另做 manual gate；Node 测试不能冒充真机验收。

## Review Focus

- `event` 模式即使长时间空闲也绝不能播 ambient；这是“打游戏陪玩不要跑来跑去”的硬规则。
- `work` / `ambient` 模式不能被 `presence.on === true` 一刀切压住；必须按 `presence.mode` 查策略。
- 坏 `ambient.json`、未知 action、空 items、非法 weight 不能拖垮手动动作或其他 presence 模式。
- 频率调度不能每拍重置 `nextAt` 或连续重复触发；`minGap`、`maxPerIdle`、`maxPerDay`、quiet hours 必须同时成立。
- 写 `/pet/ambient` 不能覆盖 `pet.size / skin / bubbleOpacity / bubbleWidth`；壳必须靠 `revision` 感知并重载。

---

### Task 1: 服务端氛围策略纯数据层

**Files:**
- Create: `src/dsh-fish/lib/pet-ambient.js`
- Test: `src/dsh-fish/test/pet-ambient.test.mjs`

**Interfaces:**
- Produces:
  - `AMBIENT_MODES = ['off', 'event', 'ambient', 'work']`
  - `emptyAmbientConfig() -> { version: 1, revision: 0, quietHours: null, modes: {} }`
  - `normalizeAmbientConfig(raw) -> { config, errors }`
  - `effectiveAmbientModes(config, defaults) -> { [mode]: AmbientModePolicy }`
  - `applyAmbientOp(config, defaults, op, { actionIds }) -> { ok: true, config, errors } | { ok: false, why, errors? }`
- `AmbientModePolicy` shape:
  `{ enabled: boolean, items: [{ action, weight, enabled, cooldownSec, minIdleSec }], frequency: { intervalMinSec, intervalMaxSec, minGapSec, maxPerIdle, maxPerDay, settleSec, actionCooldownSec } }`

- [ ] **Step 1: Write the failing test**

```js
// src/dsh-fish/test/pet-ambient.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AMBIENT_MODES, emptyAmbientConfig, effectiveAmbientModes, applyAmbientOp,
} from '../lib/pet-ambient.js'

const actionIds = new Set(['asset-109', 'asset-087', 'asset-070'])
const defaults = {
  version: 1,
  quietHours: { start: '23:00', end: '07:00', afterJitterSec: 600 },
  modes: {
    work: {
      enabled: true,
      items: [{ action: 'asset-109', weight: 1, enabled: true, cooldownSec: 7200, minIdleSec: 0 }],
      frequency: {
        intervalMinSec: 1200, intervalMaxSec: 2400, minGapSec: 300,
        maxPerIdle: 4, maxPerDay: 16, settleSec: 300, actionCooldownSec: 7200,
      },
    },
  },
}

test('add-item 以 defaults 为基线，写完整 mode 并推进 revision', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'asset-087', weight: 3,
  }, { actionIds })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.modes.work.items.map((x) => x.action), ['asset-109', 'asset-087'])
  assert.equal(r.config.modes.work.items[1].weight, 3)
  assert.equal(r.config.revision, 1)
  assert.notEqual(r.config, defaults)
})

test('remove-item / set-item / set-frequency / set-enabled / reset', () => {
  let r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'asset-087', weight: 2,
  }, { actionIds })
  r = applyAmbientOp(r.config, defaults, { op: 'set-item', mode: 'work', action: 'asset-087', patch: { weight: 5, enabled: false } }, { actionIds })
  assert.equal(r.config.modes.work.items[1].weight, 5)
  assert.equal(r.config.modes.work.items[1].enabled, false)
  r = applyAmbientOp(r.config, defaults, { op: 'set-frequency', mode: 'work', patch: { intervalMinSec: 2400, intervalMaxSec: 1200 } }, { actionIds })
  assert.equal(r.config.modes.work.frequency.intervalMinSec, 1200)
  assert.equal(r.config.modes.work.frequency.intervalMaxSec, 2400)
  r = applyAmbientOp(r.config, defaults, { op: 'set-enabled', mode: 'work', enabled: false }, { actionIds })
  assert.equal(r.config.modes.work.enabled, false)
  r = applyAmbientOp(r.config, defaults, { op: 'reset', mode: 'work' }, { actionIds })
  assert.equal(r.config.modes.work, undefined)
})

test('replace-mode 存完整 mode，未知 item 丢弃并报告', () => {
  const r = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'replace-mode', mode: 'off',
    policy: {
      enabled: true,
      items: [
        { action: 'asset-109', weight: 2 },
        { action: 'nope', weight: 1 },
      ],
      frequency: { intervalMinSec: 480, intervalMaxSec: 1200, maxPerIdle: 10, maxPerDay: 30 },
    },
  }, { actionIds })
  assert.equal(r.ok, true)
  assert.deepEqual(r.config.modes.off.items.map((x) => x.action), ['asset-109'])
  assert.ok(r.errors.some((e) => e.includes('nope')))
})

test('未知 action、坏 weight、空 items、未知 mode 的边界', () => {
  assert.equal(applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'add-item', mode: 'work', action: 'nope', weight: 1,
  }, { actionIds }).ok, false)
  const zero = applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'set-item', mode: 'work', action: 'asset-109', patch: { weight: -1 },
  }, { actionIds })
  assert.equal(zero.ok, true)
  assert.equal(zero.config.modes.work.items[0].weight, 1)
  const empty = applyAmbientOp(emptyAmbientConfig(), { modes: { work: { ...defaults.modes.work, items: [] } } }, {
    op: 'set-enabled', mode: 'work', enabled: true,
  }, { actionIds })
  assert.equal(empty.ok, false)
  assert.equal(empty.why, 'EMPTY_POOL')
  assert.equal(applyAmbientOp(emptyAmbientConfig(), defaults, {
    op: 'reset', mode: 'boss',
  }, { actionIds }).ok, false)
  assert.equal(applyAmbientOp(emptyAmbientConfig(), null, {
    op: 'add-item', mode: 'work', action: 'asset-109',
  }, { actionIds }).why, 'NO_BASE_POLICY')
})

test('effectiveAmbientModes：override 覆盖 defaults，缺失 mode 回落', () => {
  const config = {
    version: 1, revision: 2,
    modes: { work: { ...defaults.modes.work, enabled: false } },
  }
  const modes = effectiveAmbientModes(config, defaults)
  assert.equal(modes.work.enabled, false)
  assert.equal(modes.off, undefined)
  assert.deepEqual(AMBIENT_MODES, ['off', 'event', 'ambient', 'work'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/dsh-fish && node --test test/pet-ambient.test.mjs`
Expected: FAIL — `pet-ambient.js` not found.

- [ ] **Step 3: Implement `pet-ambient.js`**

Implement pure functions with no imports. `applyAmbientOp` must deep-clone the config, never mutate inputs. Ops:
`set-enabled`, `replace-mode`, `set-frequency`, `add-item`, `set-item`, `remove-item`, `reset`.
For ops needing a base, use `config.modes[mode] ?? defaults?.modes?.[mode]`; if neither, return `NO_BASE_POLICY`. `add-item`/`set-item` unknown action returns `UNKNOWN_ACTION`; `replace-mode` drops unknown items and returns `errors`. `set-frequency` swaps min/max and clamps negative to 0. `enabled:true` with empty items returns `EMPTY_POOL`. Every successful mutating op sets `revision = (config.revision ?? 0) + 1`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/dsh-fish && node --test test/pet-ambient.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dsh-fish/lib/pet-ambient.js src/dsh-fish/test/pet-ambient.test.mjs
git commit -m "feat(dsh-fish): add pet ambient policy data layer"
```

---

### Task 2: 配置默认值 + 壳 hello 上报默认策略

**Files:**
- Modify: `src/dsh-fish/lib/settings.js:200-206`（`DEFAULTS.pet`）、`src/dsh-fish/lib/settings.js:340-350`（`normalizeConfig` 的 pet 段）
- Modify: `src/dsh-fish/lib/pet-view.js:309-345`（`noteHello`）、`:418-420`（返回对象）
- Test: `src/dsh-fish/test/settings.test.mjs`、`src/dsh-fish/test/pet-view.test.mjs`

**Interfaces:**
- Produces: `DEFAULTS.pet.ambient = { version: 1, revision: 0, quietHours: null, modes: {} }`
- Produces: `petView.noteHello({ version, skins, actions, ambient })` stores the shell's default `ambient` catalog.
- Produces: `petView.ambientDefaults() -> object | null` (copy, not reference).

- [ ] **Step 1: Write the failing tests**

In `settings.test.mjs`:

```js
test('pet.ambient 保留用户策略，pet 其他键不被重置', () => {
  const cfg = normalizeConfig({
    pet: { size: 320, ambient: { version: 1, revision: 4, modes: { work: { enabled: false } } } },
  })
  assert.equal(cfg.pet.size, 320)
  assert.equal(cfg.pet.ambient.revision, 4)
  assert.equal(cfg.pet.ambient.modes.work.enabled, false)
})

test('pet.ambient 坏值回落到空策略', () => {
  const cfg = normalizeConfig({ pet: { ambient: 'nope' } })
  assert.deepEqual(cfg.pet.ambient, { version: 1, revision: 0, quietHours: null, modes: {} })
})
```

In `pet-view.test.mjs`:

```js
test('noteHello 保存壳上报的 ambient 默认策略，clear 清空', () => {
  const pv = createPetView({ now: () => 1000 })
  const ambient = { version: 1, quietHours: null, modes: { work: { enabled: true } } }
  pv.noteHello({ ambient })
  assert.deepEqual(pv.ambientDefaults(), ambient)
  assert.notEqual(pv.ambientDefaults(), ambient)
  pv.clear()
  assert.equal(pv.ambientDefaults(), null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/dsh-fish && node --test test/settings.test.mjs test/pet-view.test.mjs`
Expected: FAIL — `DEFAULTS.pet.ambient` missing / `ambientDefaults` not a function.

- [ ] **Step 3: Implement**

- Add `ambient: { version: 1, revision: 0, quietHours: null, modes: {} }` to `DEFAULTS.pet`.
- In `normalizeConfig`, after existing pet handling add:
  a plain-object check `v && typeof v === 'object' && !Array.isArray(v)`; merge `cfg.pet = { ...DEFAULTS.pet, ...cfg.pet }`; if `cfg.pet.ambient` is not a plain object, reset to `{ ...DEFAULTS.pet.ambient }`.
- In `pet-view.js`, add `let ambientDefaults = null`; in `noteHello` accept `ambient` and set it to a deep-ish copy when it is a plain object; `clear()` sets null.
- Add `function ambientDefaultsCopy() { return ambientDefaults === null ? null : JSON.parse(JSON.stringify(ambientDefaults)) }` and return it from the object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/dsh-fish && node --test test/settings.test.mjs test/pet-view.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dsh-fish/lib/settings.js src/dsh-fish/lib/pet-view.js src/dsh-fish/test/settings.test.mjs src/dsh-fish/test/pet-view.test.mjs
git commit -m "feat(dsh-fish): store shell ambient defaults and pet config"
```

---

### Task 3: `/pet/ambient` 路由 + BFF 白名单

**Files:**
- Modify: `src/dsh-fish/lib/observe.js:890-930`（`/pet/state` settings）、在 `/pet/rest` 前插入 `/pet/ambient`
- Modify: `workbench/fish/routes.mjs`
- Test: `src/dsh-fish/test/observe-pet.test.mjs`、`workbench/test/routes.test.mjs`

**Interfaces:**
- Produces:
  - `GET /pet/ambient` → `{ ok, revision, defaults, overrides, effective, actions, errors }`
  - `POST /pet/ambient` with the Task 1 op union → `{ ok, revision, modes, errors }`
  - `/pet/state.settings.ambient` = `config.pet.ambient` (user overrides)
- Consumes: `petView.ambientDefaults()`, `petView.snapshot().actions`, `applyAmbientOp`, `effectiveAmbientModes`.

- [ ] **Step 1: Write the failing route tests**

```js
test('/pet/ambient GET 返回默认、覆盖、合并结果和动作目录', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.noteHello({
    actions: [{ id: 'asset-109', label: '伸懒腰', group: '日常' }],
    ambient: {
      version: 1, quietHours: null,
      modes: { work: { enabled: true, items: [{ action: 'asset-109', weight: 1 }], frequency: { intervalMinSec: 1200, intervalMaxSec: 2400, maxPerIdle: 4, maxPerDay: 16 } } },
    },
  })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const r = await callRoute(ctx.routes, '/pet/ambient', 'GET')
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  assert.equal(r.body.defaults.modes.work.items[0].action, 'asset-109')
  assert.equal(r.body.effective.work.enabled, true)
  assert.deepEqual(r.body.actions.map((a) => a.id), ['asset-109'])
})

test('/pet/ambient POST add-item 写 config.pet.ambient，不覆盖其他 pet 键', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  const petView = createPetView({ now: () => 1000 })
  petView.noteHello({
    actions: [{ id: 'asset-109', label: '伸懒腰', group: '日常' }, { id: 'asset-087', label: '照镜子', group: '日常' }],
    ambient: { version: 1, quietHours: null, modes: { work: { enabled: true, items: [{ action: 'asset-109', weight: 1 }], frequency: { intervalMinSec: 1200, intervalMaxSec: 2400, maxPerIdle: 4, maxPerDay: 16 } } } },
  })
  await ctx.fishCore.config.patch({ pet: { size: 320, skin: 'x', ambient: null } })
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView })

  const r = await callRoute(ctx.routes, '/pet/ambient', 'POST', {
    op: 'add-item', mode: 'work', action: 'asset-087', weight: 3,
  })
  assert.equal(r.status, 200)
  assert.equal(r.body.ok, true)
  const cfg = await ctx.fishCore.config.get()
  assert.equal(cfg.pet.size, 320)
  assert.equal(cfg.pet.skin, 'x')
  assert.equal(cfg.pet.ambient.modes.work.items.length, 2)
})

test('/pet/ambient 拒绝未知 op / 未知 mode / 非 JSON', async () => {
  const ctx = fakeCtx()
  ctx.cfg.connection = { requestRejection: () => null }
  registerObserve(ctx, { root: '/tmp/fish-pet-unused', petView: createPetView() })
  assert.equal((await callRoute(ctx.routes, '/pet/ambient', 'POST', { op: 'nope' })).status, 400)
  assert.equal((await callRoute(ctx.routes, '/pet/ambient', 'POST', { op: 'reset', mode: 'boss' })).status, 400)
  assert.equal((await callRoute(ctx.routes, '/pet/ambient', 'GET')).status, 200)
})
```

BFF test in `workbench/test/routes.test.mjs`:

```js
test('桌宠氛围策略走 fish 上游：GET P1、POST P2', () => {
  const route = ROUTES.find((r) => r.path === 'pet/ambient')
  assert.equal(route.methods.GET, 'P1')
  assert.equal(route.methods.POST, 'P2')
  assert.equal(route.upstream, 'fish')
  assert.equal(route.maxBody, 64 * 1024)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/dsh-fish && node --test test/observe-pet.test.mjs`
Run: `cd workbench && node --test test/routes.test.mjs`
Expected: FAIL — route not registered / BFF path missing.

- [ ] **Step 3: Implement**

- In `observe.js`, import `applyAmbientOp`, `effectiveAmbientModes`, `normalizeAmbientConfig` from `pet-ambient.js`.
- Add `/pet/ambient` route before `/pet/rest`:
  - GET: read `cfg = await fishCore.config.get()`, `overrides = normalizeAmbientConfig(cfg?.pet?.ambient).config`, `defaults = pet.ambientDefaults?.()`, `actions = pet.snapshot().actions`, return.
  - POST: parse JSON; require `op`; call `applyAmbientOp(overrides, defaults, body, { actionIds: new Set(actions.map(a => a.id)) })`; on failure return 400 `{ ok:false, why, errors }`; on success patch `{ pet: { ...(cfg?.pet ?? {}), ambient: result.config } }` and return 200.
- In `/pet/state`, add `ambient: cfg?.pet?.ambient ?? null` to `settings`.
- Add BFF route `{ path: 'pet/ambient', methods: { GET: 'P1', POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 }`.
- Update `fakeCtx.config.patch` in tests only if needed; the route already sends the full `pet` object, so a shallow patch preserves keys.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/dsh-fish && node --test test/observe-pet.test.mjs`
Run: `cd workbench && node --test test/routes.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dsh-fish/lib/observe.js src/dsh-fish/test/observe-pet.test.mjs workbench/fish/routes.mjs workbench/test/routes.test.mjs
git commit -m "feat: expose pet ambient policy over BFF"
```

---

### Task 4: 壳侧 ambient 模型与解析

**Files:**
- Create: `desktop-pet/shared/ambient-model.ts`
- Create: `desktop-pet/electron/ambient.ts`
- Create: `desktop-pet/test/ambient.test.ts`
- Modify: `desktop-pet/package.json` test script to include `test/ambient.test.ts`

**Interfaces:**
- Produces:
  - `AmbientItem`, `AmbientFrequency`, `AmbientModePolicy`, `AmbientCatalog`, `AmbientOverrides`
  - `emptyAmbientCatalog()`
  - `parseAmbientCatalog(raw, { actionIds, log }) -> { catalog, errors }`
  - `readAmbientCatalog(assetsRoot, skinId, actionIds, log) -> Promise<AmbientCatalog>`
  - `mergeAmbientCatalogs(defaults, skin) -> AmbientCatalog`
  - `filterAmbientCatalog(catalog, actionIds) -> AmbientCatalog`
  - `mergeAmbientMode(base, override) -> AmbientModePolicy`
  - `selectAmbientPolicy(catalog, overrides, mode, presenceOn) -> AmbientModePolicy | null`

- [ ] **Step 1: Write the failing tests**

```ts
// desktop-pet/test/ambient.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmbientCatalog, mergeAmbientCatalogs, filterAmbientCatalog } from '../electron/ambient.ts'
import { selectAmbientPolicy } from '../shared/ambient-model.ts'

const ids = new Set(['asset-109', 'asset-087'])
const base = {
  version: 1,
  quietHours: { start: '23:00', end: '07:00', afterJitterSec: 600 },
  modes: {
    work: {
      enabled: true,
      items: [{ action: 'asset-109', weight: 2 }],
      frequency: { intervalMinSec: 1200, intervalMaxSec: 2400, maxPerIdle: 4, maxPerDay: 16 },
    },
  },
}

test('parse 丢弃未知 action、重复 action 后者覆盖、坏 weight 归 1', () => {
  const raw = {
    ...base,
    modes: { work: { ...base.modes.work, items: [
      { action: 'asset-109', weight: 2 },
      { action: 'nope', weight: 5 },
      { action: 'asset-109', weight: -1 },
    ] } },
  }
  const { catalog, errors } = parseAmbientCatalog(raw, { actionIds: ids, log: () => {} })
  assert.equal(catalog.modes.work.items.length, 1)
  assert.equal(catalog.modes.work.items[0].action, 'asset-109')
  assert.equal(catalog.modes.work.items[0].weight, 1)
  assert.ok(errors.some((e) => e.includes('nope')))
})

test('皮肤同 mode 覆盖默认，缺失 mode 回落', () => {
  const skin = { ...base, modes: { work: { ...base.modes.work, enabled: false } } }
  const merged = mergeAmbientCatalogs(base, skin)
  assert.equal(merged.modes.work.enabled, false)
})

test('filter 按动作目录裁 item；空池保留但 enabled 不动', () => {
  const filtered = filterAmbientCatalog(base, new Set(['asset-087']))
  assert.equal(filtered.modes.work.items.length, 0)
})

test('selectAmbientPolicy：presence off 用 off，未知 mode 返回 null', () => {
  const catalog = { ...base, modes: { ...base.modes, off: base.modes.work } }
  assert.equal(selectAmbientPolicy(catalog, null, 'work', false)!.mode, 'off')
  assert.equal(selectAmbientPolicy(catalog, null, 'unknown', true), null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop-pet && node --test --experimental-strip-types test/ambient.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

- `shared/ambient-model.ts`: types + pure merge/select. Validate/clip numbers; `items` keyed by action, last wins; default weight 1; `enabled` default true; `cooldownSec`/`minIdleSec` default 0.
- `electron/ambient.ts`: read default `ambient.json` then optional skin file; JSON parse failures throw for the caller to keep the previous catalog; per-item errors are dropped and logged. `readAmbientCatalog` uses `readFile`, `join`, `SIMPLE_SKIN_ID` (reuse `skin.ts`), and `ACTION_ID_RE` from `actions.ts`.
- `selectAmbientPolicy`: `modeKey = presenceOn ? mode : 'off'`; invalid/unknown mode with `presenceOn` returns null; merge override if present; return null if missing.
- Add `test/ambient.test.ts` to the `npm test` list.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop-pet && node --test --experimental-strip-types test/ambient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/shared/ambient-model.ts desktop-pet/electron/ambient.ts desktop-pet/test/ambient.test.ts desktop-pet/package.json
git commit -m "feat(desktop-pet): parse ambient policy catalogs"
```

---

### Task 5: 壳主进程 / preload 接入 ambient catalog

**Files:**
- Modify: `desktop-pet/electron/main.ts:105-115`（state）、`:240-280`（send/ready）、`:440-560`（loaders）、`:640-700`（applySkin）、`:555-620`（reload）、`:1088-1110`（startup）、`:945-960`（IPC）
- Modify: `desktop-pet/electron/preload.ts`
- Modify: `desktop-pet/renderer/App.tsx:70-120`（window bridge declaration）
- Test: `desktop-pet/test/shell.test.ts`

**Interfaces:**
- Consumes: `AmbientCatalog`, `readAmbientCatalog`, `mergeAmbientCatalogs`, `filterAmbientCatalog`.
- Produces:
  - `main` hello payload includes `ambient: ambientCatalog`
  - IPC `pet:get-ambient-catalog` → `AmbientCatalog`
  - IPC event `pet:ambient-catalog` → `AmbientCatalog`
  - preload `onAmbientCatalog`, `getAmbientCatalog` (reload folds into existing `reloadActions`)

- [ ] **Step 1: Write the failing test**

In `shell.test.ts`, mirror the trigger catalog tests:

```ts
test('ambient catalog 从磁盘载入并推给 renderer / hello', async () => {
  const getAmbient = electronMock.ipcHandled.get('pet:get-ambient-catalog')
  assert.equal(typeof getAmbient, 'function')
  const catalog = await getAmbient!()
  assert.equal(catalog.version, 1)
  assert.ok(catalog.modes.off)
  assert.equal(typeof catalog.modes.work.enabled, 'boolean')
})
```

Add a bridge test:

```ts
test('preload 暴露 ambient catalog 订阅与主动拉取', async () => {
  // 参照现有 trigger catalog bridge test，断言 channel 名与返回值
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop-pet && npm test`
Expected: FAIL — `pet:get-ambient-catalog` not registered.

- [ ] **Step 3: Implement**

- `main.ts`: add `let ambientCatalog: AmbientCatalog = emptyAmbientCatalog()`.
- Add `sendAmbientCatalog(win, catalog)` and include it in `sendPetReadySnapshot`.
- Add `loadAmbientCandidate(assetsRoot, skinId, revision, actions)` analogous to `loadTriggerCandidate`, keeping the previous catalog on failure.
- `applySkin` and `reloadRegisteredActions` load the ambient candidate before publishing; update the hello payload `toHelloPayload` with `ambient: ambientCatalog`.
- Startup loads ambient after actions; IPC `pet:get-ambient-catalog` returns a filtered copy; `pet:ambient-catalog` pushes on change.
- Fold ambient into the existing `pet:actions-reload` path: one reload refreshes actions, triggers, and ambient. Do not add a separate reload IPC or menu item.
- `preload.ts`: add types and `onAmbientCatalog` / `getAmbientCatalog`; if using the folded reload, no new reload method is required.
- `App.tsx` window declaration: add the two bridge methods.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop-pet && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/electron/main.ts desktop-pet/electron/preload.ts desktop-pet/renderer/App.tsx desktop-pet/test/shell.test.ts
git commit -m "feat(desktop-pet): publish ambient catalog to renderer"
```

---

### Task 6: 默认 `ambient.json`

**Files:**
- Create: `desktop-pet/assets/ambient.json`
- Test: `desktop-pet/test/ambient.test.ts`

**Interfaces:**
- Produces the shipped default catalog with four modes. `event` is disabled; `off` / `ambient` / `work` share the same 19 items with different frequency.

- [ ] **Step 1: Write the failing test**

Add to `ambient.test.ts`; `ALL_ACTION_IDS` is built from `assets/actions.json` in the test setup:

```ts
test('仓库默认 ambient.json 解析出 4 个模式，event 默认关闭', async () => {
  const raw = JSON.parse(await readFile(join(ASSETS_ROOT, 'ambient.json'), 'utf8'))
  const { catalog, errors } = parseAmbientCatalog(raw, { actionIds: ALL_ACTION_IDS, log: () => {} })
  assert.deepEqual(Object.keys(catalog.modes).sort(), ['ambient', 'event', 'off', 'work'])
  assert.equal(catalog.modes.event.enabled, false)
  assert.equal(catalog.modes.work.items.length, 19)
  assert.equal(errors.length, 0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop-pet && node --test --experimental-strip-types test/ambient.test.ts`
Expected: FAIL — `ambient.json` missing.

- [ ] **Step 3: Create `ambient.json`**

Use this item set in `off`, `ambient`, and `work`; `event` is `{ "enabled": false, "items": [] }`.

| id | weight |
| --- | ---: |
| `asset-109` 超大伸懒腰 | 3 |
| `asset-087` 照镜子 | 3 |
| `asset-070` 撸猫 | 3 |
| `asset-063` 悠闲哼歌 | 3 |
| `asset-069` 摇扇纳凉 | 3 |
| `asset-112` 轻快记录 | 3 |
| `asset-110` 踢毽子 | 3 |
| `asset-099` 荡秋千 | 3 |
| `asset-018` 原地专心玩魔方 | 2 |
| `asset-002` 下五子棋 | 2 |
| `asset-001` 三球抛接 | 2 |
| `asset-066` 抽陀螺 | 2 |
| `asset-047` 吹气球 | 2 |
| `asset-113` 骑木马 | 2 |
| `asset-054` 小提琴演奏 | 1 |
| `asset-064` 扑克魔术 | 1 |
| `asset-114` 鲸鱼吐泡泡特效 | 1 |
| `asset-102` 蝴蝶蜜蜂环绕头顶开花 | 1 |
| `asset-027` 可爱宅舞 | 1 |

Frequencies:

| mode | interval | minGap | maxPerIdle | maxPerDay |
| --- | --- | ---: | ---: | ---: |
| `off` | 480–1200 | 300 | 10 | 30 |
| `ambient` | 720–1500 | 300 | 6 | 20 |
| `work` | 1200–2400 | 300 | 4 | 16 |

Global `quietHours`: `{ "start": "23:00", "end": "07:00", "afterJitterSec": 600 }`.
Each mode's `frequency` may omit `settleSec`/`actionCooldownSec`; the parser defaults them (300 / 7200).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop-pet && node --test --experimental-strip-types test/ambient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/assets/ambient.json desktop-pet/test/ambient.test.ts
git commit -m "feat(desktop-pet): ship default ambient pool"
```

---

### Task 7: Renderer 订阅 ambient catalog + 按 presence.mode 选策略

**Files:**
- Modify: `desktop-pet/renderer/App.tsx:70-120`（bridge）、`:300-340`（catalog state）、`:620-680`（trigger catalog subscription）、`:910-925`（reduceTriggers config）
- Modify: `desktop-pet/renderer/controller.ts`（`PetState.settings` 类型）
- Test: `desktop-pet/test/ambient.test.ts`（`selectAmbientPolicy` 已覆盖）、`desktop-pet/test/trigger-engine.test.ts`（Task 8）

**Interfaces:**
- Consumes: `onAmbientCatalog`, `getAmbientCatalog`, `selectAmbientPolicy`.
- Produces: `TriggerEngineConfig.ambient` = selected `AmbientModePolicy | null` on every state tick.

- [ ] **Step 1: Write the failing test**

`selectAmbientPolicy` is already tested in Task 4. Add a `PetState` type test only if a compile check exists; otherwise this task is verified by `npm test` and `npm run build`.

- [ ] **Step 2: Implement**

- Add `ambientCatalogRef`, `ambientCatalogReadyRef`, `setAmbientCatalog`, and a `catalogEpoch` dependency.
- Subscribe with `onAmbientCatalog` + `getAmbientCatalog` exactly like the trigger catalog; mark ready only when actions, triggers, and ambient are all ready.
- On each state tick:
  `const ambient = selectAmbientPolicy(ambientCatalogRef.current, (state as PetState | null)?.settings?.ambient, presence?.mode ?? '', presence?.on === true)`
  and pass `ambient` in the `reduceTriggers({ ..., config: { ...TRIGGER_ENGINE_CONFIG, ambient } })`.
- Add `settings?: { ambient?: AmbientOverrides }` to `PetState` in `controller.ts`.
- Do not block manual actions if ambient catalog is missing; use `null` policy (legacy path) until ready.

- [ ] **Step 3: Run type/build verification**

Run: `cd desktop-pet && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add desktop-pet/renderer/App.tsx desktop-pet/renderer/controller.ts
git commit -m "feat(desktop-pet): select ambient policy by presence mode"
```

---

### Task 8: Trigger engine 的策略驱动 ambient 调度

**Files:**
- Modify: `desktop-pet/renderer/trigger-engine.ts:28-120`（types/seen）、`:238-260`（eligibility）、`:420-460`（ambient branch）
- Test: `desktop-pet/test/trigger-engine.test.ts`

**Interfaces:**
- Consumes: `AmbientModePolicy` from `shared/ambient-model.ts` via `TriggerEngineConfig.ambient`.
- Produces: `TriggerSeen` new fields:
  `ambientMode: string | null`, `ambientNextAt: number | null`, `ambientIdleSince: number | null`, `ambientIdleCount: number`, `ambientDayKey: string`, `ambientCountToday: number`, `ambientLastAt: number | null`, `ambientActionKeys: string[]`.
- Keeps `ambientConsumed` for the legacy path when `config.ambient` is null.

- [ ] **Step 1: Write the failing tests**

Add tests with a helper:

```ts
function ambientPolicy(overrides: Partial<AmbientModePolicy> = {}): AmbientModePolicy {
  return {
    mode: 'work',
    enabled: true,
    items: [{ action: 'a', weight: 1, enabled: true, cooldownSec: 0, minIdleSec: 0 }],
    frequency: {
      intervalMinSec: 1200, intervalMaxSec: 1200, minGapSec: 300,
      maxPerIdle: 4, maxPerDay: 16, settleSec: 300, actionCooldownSec: 7200,
    },
    ...overrides,
  }
}
```

Key assertions:

```ts
test('event 模式即使空闲也不播 ambient', ...)
test('work 模式进入空闲后等 interval 才播一次', ...)
test('maxPerIdle 与 maxPerDay 生效', ...)
test('quiet hours 不播，并把 nextAt 推到结束后', ...)
test('manualBusy / cue 结束当前空闲段，不立刻重播', ...)
test('mode 变化重置调度', ...)
test('items 的 minIdleSec / cooldownSec 生效', ...)
test('加权选择可复现，跳过 disabled / 冷却中的 item', ...)
test('policy 缺失时保留 legacy ambient trigger 兼容', ...)
test('policy 存在时 legacy ambient trigger 不再触发', ...)
test('date inAmbient 在 event 模式不播', ...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop-pet && node --test --experimental-strip-types test/trigger-engine.test.ts`
Expected: FAIL — `config.ambient` unused / new seen fields missing.

- [ ] **Step 3: Implement**

- Add the new `TriggerSeen` fields to `emptyTriggerSeen` and `cloneSeen`; bound `ambientActionKeys` to `TRIGGER_SEEN_LIMIT`.
- `ambientEligible` becomes:
  - policy present: `state.scene === null && state.activity === null && policy.enabled === true`.
  - policy absent: existing `isAmbientState(state)` (legacy, presence off required).
- Policy path:
  - On mode change, reset `ambientNextAt=null`, `ambientIdleSince=null`, `ambientIdleCount=0`, `ambientLastAt=null`, `ambientActionKeys=[]`.
  - On leaving idle, reset idle fields.
  - On entering idle, set `ambientIdleSince=now`, `ambientIdleCount=0`, `ambientNextAt=now + max(settleSec, randomInterval)`.
  - On `manualBusy` / a consumed cue, end the idle segment (`ambientNextAt=null`, `ambientIdleSince=null`).
  - On `actionBusy`, return without changing the schedule.
  - Day rollover: reset `ambientCountToday` when local day key changes.
  - When `now >= nextAt`, caps/minGap/quiet hours pass, select a weighted eligible item (enabled, action exists, `minIdleSec`, per-action cooldown) and fire one `startAction` with `loop:false`; increment counters, append `actionKey`, draw the next interval.
  - If no item is eligible, set `nextAt = now + 60_000` and return.
  - Quiet hours: set `nextAt = max(nextAt, quietEndAt + afterJitterSec*1000)`.
- Legacy path: keep current `ambientConsumed` branch only when `config.ambient` is null.
- Remove the `ambient` trigger branch from the policy path; date triggers use the new `ambientEligible`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop-pet && node --test --experimental-strip-types test/trigger-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/renderer/trigger-engine.ts desktop-pet/test/trigger-engine.test.ts
git commit -m "feat(desktop-pet): drive ambient by presence policy"
```

---

### Task 9: Seen 持久化与旧记录兼容

**Files:**
- Modify: `desktop-pet/renderer/trigger-engine.ts:28-120`
- Modify: `desktop-pet/renderer/playback-adapter.ts`（`emptyPetSeen` / `parsePetSeen` / `mergePetSeen`）
- Test: `desktop-pet/test/playback-adapter.test.ts`

**Interfaces:**
- Produces: `PetSeen` includes the eight ambient fields from Task 8; old records parse to safe defaults.

- [ ] **Step 1: Write the failing test**

```ts
test('旧 Seen 没有 ambient 调度字段时补 0/null，新字段可往返', () => {
  const parsed = parsePetSeen({
    lastActionId: '', lastCommentAt: '',
    cueIds: [], occurrenceKeys: [],
    lastActivityState: null, lastSceneKind: null,
    sceneLoopActionId: null, sceneLoopActive: false,
    sceneLoopNeedsRevalidation: false,
  })
  assert.equal(parsed.ambientNextAt, null)
  assert.equal(parsed.ambientCountToday, 0)
  assert.deepEqual(parsed.ambientActionKeys, [])
  const round = parsePetSeen({ ...parsed, ambientActionKeys: ['a|1000'], ambientNextAt: 123 })
  assert.equal(round.ambientNextAt, 123)
  assert.deepEqual(round.ambientActionKeys, ['a|1000'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop-pet && node --test --experimental-strip-types test/playback-adapter.test.ts`
Expected: FAIL — fields missing.

- [ ] **Step 3: Implement**

- `emptyTriggerSeen` / `emptyPetSeen` initialize all ambient fields.
- `cloneSeen` / `parsePetSeen` validate types and bound `ambientActionKeys`.
- `mergePetSeen` preserves ambient fields from the reducer's `TriggerSeen`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop-pet && node --test --experimental-strip-types test/playback-adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/renderer/trigger-engine.ts desktop-pet/renderer/playback-adapter.ts desktop-pet/test/playback-adapter.test.ts
git commit -m "feat(desktop-pet): persist ambient schedule"
```

---

### Task 10: 默认触发表移除 legacy ambient + 文档

**Files:**
- Modify: `desktop-pet/assets/triggers.json`（删除 `ambient` 条目）
- Modify: `desktop-pet/README.md`
- Modify: `src/dsh-fish/CHANGELOG.md`
- Test: `desktop-pet/test/triggers.test.ts`（默认表引用仍合法）

**Interfaces:**
- The shipped shell no longer uses the `ambient` trigger; it uses `ambient.json`. Legacy trigger parsing remains for old skins.

- [ ] **Step 1: Remove the default `ambient` trigger**

Delete the `{"when":"ambient", ...}` entry from `desktop-pet/assets/triggers.json`. Keep `date:*`.

- [ ] **Step 2: Run trigger tests**

Run: `cd desktop-pet && node --test --experimental-strip-types test/triggers.test.ts`
Expected: PASS — every remaining action id exists.

- [ ] **Step 3: Document**

Add to `desktop-pet/README.md`:

- `assets/ambient.json` per-mode policy and skin override.
- User policy lives in `config.pet.ambient`; `GET/POST /api/fish/pet/ambient` ops.
- `event` defaults off; `work` defaults full 19 pool at 20–40 min / 4 per idle / 16 per day.
- UI is deferred; use the API/JSON.

Add a `src/dsh-fish/CHANGELOG.md` bullet: ambient policy, API, shell defaults, legacy trigger deprecation.

- [ ] **Step 4: Commit**

```bash
git add desktop-pet/assets/triggers.json desktop-pet/README.md src/dsh-fish/CHANGELOG.md
git commit -m "docs: document ambient policy and retire default ambient trigger"
```

---

### Task 11: 全套验证

**Files:** none (verification only)

- [ ] **Step 1: Run `dsh-fish` full suite**

Run: `cd src/dsh-fish && node --test`
Expected: all tests pass; note the count.

- [ ] **Step 2: Run `workbench` suite**

Run: `cd workbench && node --test`
Expected: all tests pass.

- [ ] **Step 3: Run `desktop-pet` suite**

Run: `cd desktop-pet && npm test`
Expected: all tests pass, including `test/ambient.test.ts`.

- [ ] **Step 4: Build the shell**

Run: `cd desktop-pet && npm run build`
Expected: Vite builds renderer, main, preload with no TypeScript errors.

- [ ] **Step 5: Windows manual gate**

On Windows, with the shell running:

1. `presence.mode = event`, idle 60 分钟：不出现 ambient 动作。
2. `presence.mode = work`，空闲超过一个 interval：出现池内动作；activity 不为空时不出现。
3. `off` / `ambient` 模式按各自间隔和上限出现。
4. 安静时段不出现；点击/聊天后 5 分钟内不出现。
5. 通过 `POST /pet/ambient` 加/删一个动作、改权重、改频率，壳下一轮生效。
6. `pet.size` / `skin` / `bubbleOpacity` / `bubbleWidth` 未被 ambient 写入覆盖。
7. 未知 action / 坏 `ambient.json` 不影响手动动作。

- [ ] **Step 6: Record verification boundary**

Report separately: local unit tests, build, WSL service, Windows real-machine, model/message chain. Do not claim the last two from Node tests.
