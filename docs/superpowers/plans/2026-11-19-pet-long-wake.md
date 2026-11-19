# 桌宠「起来陪我」长唤醒 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌宠菜单新增「起来陪我」，让用户在日程休息期间显式长唤醒，直到手动收回或 12 小时兜底。

**Architecture:** 服务端 `pet-view.js` 增加 `awake` 覆盖状态与 `awakeUntil`；日程 tick 在长唤醒期间不重置覆盖。`/pet/rest` 接受 `awake`。桌宠菜单按 `scene` / `awakeUntil` 显示「起来陪我」或「回去睡吧」，IPC 播放层仍归一成 `wake`，渲染端不改。

**Tech Stack:** Node.js（内置 `node:test`）、Electron/TypeScript 桌宠壳。

**Spec:** `docs/superpowers/specs/2026-11-19-pet-long-wake-design.md`

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 必须保持 `{}`。
- 不新增人格/关系设置入口；长唤醒不是配置项。
- `scene` 仍只有 `rest | out | null`；出门（`out`）优先于长唤醒。
- 服务端状态易失，不落盘、不写事件流。
- 测试：`src/dsh-fish` 用 `node --test`；`desktop-pet` 用 `npm test`。任何一条红都不提交。

## Review Focus

- 日程 tick 在长唤醒期间仍要更新 `scheduleRest/scheduleRestAt`，否则到期后会回到错误 scene。
- `awakeUntil` 过期必须在下一次 `snapshot` 自动清回 `auto`，不能只依赖用户操作。
- `/pet/rest` 的未知 action 仍然 400，白名单只多 `awake` 一个值。
- 菜单在 `scene` / `awakeUntil` 缺失或异常时不能崩，也不显示错误项。
- 12 小时兜底按本地时间推进，不因系统时钟回拨提前结束。

---

### Task 1: 服务端 `awake` 状态机

**Files:**
- Modify: `src/dsh-fish/lib/pet-view.js:35`（白名单）、`:139-148`（状态变量）、`:238-265`（setScheduleRest / setRestOverride）、`:323-355`（snapshot）、`:358-373`（clear）
- Test: `src/dsh-fish/test/pet-view.test.mjs`

**Interfaces:**
- Produces: `setRestOverride('awake')`；`snapshot().awakeUntil: number | null`；`AWAKE_MAX_MS = 12 * 60 * 60 * 1000`（模块内常量）。

- [ ] **Step 1: Write the failing test**

在 `src/dsh-fish/test/pet-view.test.mjs` 增加：

```js
test('awake 长唤醒：跨过日程 tick、12 小时到期、显式结束', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })
  pv.setScheduleRest({ rest: true, at: 900 })
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 900 })

  t = 2000
  assert.equal(pv.setRestOverride('awake'), true)
  assert.equal(pv.snapshot().scene, null)
  const until = pv.snapshot().awakeUntil
  assert.equal(until, 2000 + 12 * 60 * 60 * 1000)

  // 日程 tick 不再收回
  t = 62_000
  pv.setScheduleRest({ rest: true, at: 62_000 })
  assert.equal(pv.snapshot().scene, null)
  assert.equal(pv.snapshot().awakeUntil, until)

  // 出门仍优先
  pv.setOuting({ active: true, at: 63_000 })
  assert.equal(pv.snapshot().scene.kind, 'out')
  pv.setOuting({ active: false, at: 64_000 })
  assert.equal(pv.snapshot().scene, null)

  // 显式 sleep 结束长唤醒
  t = 65_000
  pv.setRestOverride('sleep')
  assert.equal(pv.snapshot().awakeUntil, null)
  assert.equal(pv.snapshot().scene.kind, 'rest')

  // 重新 awake，到期自动回日程
  t = 70_000
  pv.setRestOverride('awake')
  t = 70_000 + 12 * 60 * 60 * 1000
  assert.deepEqual(pv.snapshot().scene, { kind: 'rest', at: 62_000 })
  assert.equal(pv.snapshot().awakeUntil, null)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/dsh-fish && node --test test/pet-view.test.mjs`
Expected: FAIL — `setRestOverride('awake')` returns `false` / `awakeUntil` undefined。

- [ ] **Step 3: Implement**

- `PET_REST_OVERRIDES` 加 `'awake'`。
- 模块常量 `const AWAKE_MAX_MS = 12 * 60 * 60 * 1000`。
- `let awakeUntil = null`。
- `setScheduleRest`：更新 `scheduleRest/scheduleRestAt` 后，仅当 `restOverride !== 'awake'` 时重置为 `auto`。
- `setRestOverride`：设置 `awakeUntil = value === 'awake' ? now() + AWAKE_MAX_MS : null`；`auto` 清 `restOverrideAt`。
- `snapshot` 开头：`restOverride === 'awake' && nowMs >= awakeUntil` 时清回 `auto`、`awakeUntil = null`；返回值加 `awakeUntil: restOverride === 'awake' ? awakeUntil : null`。
- `clear()` 清 `awakeUntil = null`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/dsh-fish && node --test test/pet-view.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dsh-fish/lib/pet-view.js src/dsh-fish/test/pet-view.test.mjs
git commit -m "feat(dsh-fish): add sticky awake override to pet view"
```

### Task 2: `/pet/rest` 接受 `awake`

**Files:**
- Modify: `src/dsh-fish/lib/observe.js:1007-1020`
- Test: `src/dsh-fish/test/observe-pet.test.mjs:270`

**Interfaces:**
- Consumes: Task 1 的 `setRestOverride('awake')` / `snapshot().awakeUntil`。
- Produces: `POST /pet/rest { action: 'awake' }` → `{ ok: true, action: 'awake', scene: null, awakeUntil }`。

- [ ] **Step 1: Write the failing test**

在 `observe-pet.test.mjs` 的 `/pet/rest` 用例里追加：

```js
const awake = await callRoute(ctx.routes, '/pet/rest', 'POST', { action: 'awake' })
assert.equal(awake.status, 200)
assert.equal(awake.body.ok, true)
assert.equal(awake.body.scene, null)
assert.equal(typeof awake.body.awakeUntil, 'number')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/dsh-fish && node --test test/observe-pet.test.mjs`
Expected: FAIL — 400，`awake` 不在白名单。

- [ ] **Step 3: Implement**

`action !== 'auto' && action !== 'sleep' && action !== 'wake' && action !== 'awake'` 时仍 400；响应 `{ ok: true, action, scene, awakeUntil: scene ? null : undefined }` —— 具体取 `pet.snapshot?.()` 的 `awakeUntil` 一并返回。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/dsh-fish && node --test test/observe-pet.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dsh-fish/lib/observe.js src/dsh-fish/test/observe-pet.test.mjs
git commit -m "feat(dsh-fish): accept awake in pet rest route"
```

### Task 3: 桌宠菜单「起来陪我」/「回去睡吧」

**Files:**
- Modify: `desktop-pet/electron/menu-model.ts:8-16`（MenuState）、`:35`（PetRestAction）、`buildMenuModel`
- Modify: `desktop-pet/electron/main.ts:905-912`（缓存 scene/awakeUntil）、`:822-845`（runRestAction）
- Test: `desktop-pet/test/shell.test.ts`

**Interfaces:**
- Consumes: `/pet/state` 新增的 `awakeUntil`；现有 `petRestAction()`。
- Produces: `MenuState.scene: { kind: 'rest' | 'out' } | null`、`MenuState.awakeUntil: number | null`；`PetRestAction = 'sleep' | 'wake' | 'awake'`；菜单项 `起来陪我` / `回去睡吧`。

- [ ] **Step 1: Write the failing test**

在 `shell.test.ts` 增加：

```ts
test('休息中显示「起来陪我」，长唤醒中显示「回去睡吧」', () => {
  const catalog = [
    registered('sleep-action', '睡觉', '休息'),
    registered('wake-action', '起来', '休息'),
  ]
  const sleeping = buildMenuModel(
    { ...baseState, scene: { kind: 'rest' }, awakeUntil: null },
    catalog,
    callbacks([]),
    'context',
  )
  find(sleeping, '起来陪我').click?.()
  const awake = buildMenuModel(
    { ...baseState, scene: null, awakeUntil: Date.now() + 1000 },
    catalog,
    callbacks([]),
    'context',
  )
  find(awake, '回去睡吧').click?.()
})
```

并断言 `callbacks` 收到 `rest:awake:wake-action` 与 `rest:sleep:sleep-action`。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop-pet && npm test`
Expected: FAIL — `MenuState` 没有 `scene`；菜单里找不到两项。

- [ ] **Step 3: Implement**

- `MenuState` 加 `scene` / `awakeUntil`；`baseState` 测试夹具补默认值。
- `PetRestAction` 加 `'awake'`。
- `buildMenuModel` 在「演一个动作」之前：
  - `state.scene?.kind === 'rest'` 时插入 `{ label: '起来陪我', click: () => callbacks.rest(wakeActionId, 'awake') }`；
  - `state.awakeUntil != null` 时插入 `{ label: '回去睡吧', click: () => callbacks.rest(sleepActionId, 'sleep') }`；
  - id 找不到时传空串。
- `main.ts` state 转发处缓存 `lastScene` / `lastAwakeUntil`（非法值归一成 `null`），传进 `buildMenuModel`。
- `runRestAction` POST 原始 action；`sendActionMessage` 里把 `'awake'` 归一成 `'wake'`；`actionId === ''` 时不发 `pet:action`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop-pet && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/electron/menu-model.ts desktop-pet/electron/main.ts desktop-pet/test/shell.test.ts
git commit -m "feat(desktop-pet): add long wake menu entries"
```

### Task 4: 变更记录与全套验证

**Files:**
- Modify: `src/dsh-fish/CHANGELOG.md`

- [ ] **Step 1:** 在 CHANGELOG 最新一节加一条：桌宠「起来陪我」长唤醒、`awake` 覆盖、12 小时兜底、出门优先。
- [ ] **Step 2:** `cd src/dsh-fish && node --test` → 全绿。
- [ ] **Step 3:** `cd desktop-pet && npm test` → 全绿。
- [ ] **Step 4:** `git add` 本任务相关文件并提交。
