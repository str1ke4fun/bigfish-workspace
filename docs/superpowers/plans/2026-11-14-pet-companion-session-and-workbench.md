# 桌宠陪伴会话与工作台「桌宠」页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌宠对话进入陪伴会话并形成「陪看→对话」闭环，同时在工作台提供桌宠状态、动作试演、尺寸与本地皮肤、陪伴会话卡片。

**Architecture:** `dsh-fish` 的 `/say` 增加 `target` 参数，桌宠传 `companion` 时经 `screen.ensureSession()` 进入陪伴会话并把对话轮次计入轮换；`pet-view` 增加心跳与设置快照，`observe.js` 增加 `/pet/hello`、`/pet/config`、`/pet/rotate`；8788 BFF 转发三条新路由；工作台新增「桌宠」页；Electron 薄壳上报心跳与皮肤清单，并从状态里应用尺寸/皮肤。

**Tech Stack:** Node.js 24、`node:test`、dsh-fish（零依赖）、workbench（零依赖）、Electron 43、React 19、TypeScript。

**Spec:** `docs/superpowers/specs/2026-11-14-pet-session-and-workbench-design.md`

## Global Constraints

- `src/dsh-fish/package.json` 的三个依赖字段永远保持 `{}`；不新增依赖。
- `~/.dsh-fish/events.jsonl` 只追加；不新增事件类型、不写 schema、不把动作/对话写进事件流。
- `pet-view` 全部易失：不落盘、不写 presence 台账、不调用模型。
- 桌宠只拿 `recent` / `activity` / `action` / 设置与皮肤清单，不接触屏幕图像、窗口标题、OCR。
- 新输入口都走 `observe.js` 的统一 `guarded()` 栅栏；三条新路由只接受本机 BFF 转发。
- 不新增人格输入、好感度、情绪标签；`config.pet` 不进入任何提示词。
- 面向用户的文案不出现男字旁的「他」，不出现「三道门 / 四道门」。
- 基线（2026-11-14，`549a9eb`）：`src/dsh-fish` 1093 全绿、`workbench` 113 全绿、`desktop-pet` 21 全绿。陪看生命周期（重启恢复 + 4 小时上限 + 停止原因）已实现，本计划直接在其上继续。
- 每个任务结束时跑对应套件；全套测试新增后同步基线数字。

## Review Focus

- **屏幕服务缺席或会话创建失败**：桌宠那句必须仍然送达（回落 home），返回 `note` 说明；不能吞消息或 500。
- **工作台轮询与在线判定**：工作台自己也会轮询 `/pet/state`；在线必须以 `pet/hello` 心跳为准，关掉桌宠后不能仍显示在线。
- **皮肤损坏/缺动作/缺文件**：桌宠不能白屏或退出，必须保留上一个皮肤并给出可见提示。
- **重启恢复与 4 小时上限**：恢复不能重置起点；超过上限不得恢复。
- **重复下发配置**：同一尺寸/皮肤重复下发必须幂等，不能抖动窗口或反复重载。

---

### Task 1: 陪伴会话路由（`/say` target + screen API）

**Files:**
- Modify: `src/dsh-fish/lib/screen.js`（`state.chatTurns`、`rotateIfNeeded`、`noteChatTurn`、`companionInfo`、导出 `ensureSession`）
- Modify: `src/dsh-fish/lib/say.js`（`resolveSaySession`、`sayToHer` 的 `target`/`screen` 入参）
- Modify: `src/dsh-fish/lib/observe.js`（`/say` 透传 `body.target` 与 `deps.screen`）
- Test: `src/dsh-fish/test/say-target.test.mjs`（新建）
- Test: `src/dsh-fish/test/screen.test.mjs`

**Interfaces:**
- Produces:
  ```js
  screen.ensureSession({ rotate = false } = {}): Promise<string>
  screen.noteChatTurn(): Promise<{ rotated: boolean, sessionId: string }>
  screen.companionInfo(): { sessionId: string, sessionComments: number, chatTurns: number, rotateAfter: number }
  resolveSaySession({ target, screen, talkSession, log }): Promise<{ sessionId, target: 'home'|'companion', fellBack: boolean }>
  sayToHer(ctx, text, deps): Promise<{ ok, note, said, herReply, waitedMs, target, sessionId, fellBack }>
  ```
- `/say` body 增加 `target?: 'home' | 'companion'`，缺省 `home`。

- [ ] **Step 1: Write the failing test for target routing**

`test/say-target.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSaySession } from '../lib/say.js'

test('companion：先 ensureSession，再计一轮对话', async () => {
  const calls = []
  const screen = {
    ensureSession: async () => { calls.push('ensure'); return 'c1' },
    noteChatTurn: async () => { calls.push('turn'); return { rotated: false, sessionId: 'c1' } },
  }
  const r = await resolveSaySession({ target: 'companion', screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'c1', target: 'companion', fellBack: false })
  assert.deepEqual(calls, ['ensure', 'turn'])
})

test('companion 失败回落 home，并标记 fellBack', async () => {
  const screen = { ensureSession: async () => '', noteChatTurn: async () => ({ rotated: false, sessionId: '' }) }
  const r = await resolveSaySession({ target: 'companion', screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: true })
})

test('缺省走 home，不碰 screen', async () => {
  let touched = false
  const screen = { ensureSession: async () => { touched = true; return 'c1' } }
  const r = await resolveSaySession({ target: undefined, screen, talkSession: async () => 'h1' })
  assert.deepEqual(r, { sessionId: 'h1', target: 'home', fellBack: false })
  assert.equal(touched, false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/dsh-fish && node --test test/say-target.test.mjs`
Expected: FAIL — `resolveSaySession` is not exported.

- [ ] **Step 3: Implement `resolveSaySession` and wire `sayToHer`/route**

- `say.js`：新增并导出 `resolveSaySession({ target, screen, talkSession, log })`；`target === 'companion'` 时先 `screen?.ensureSession?.()`，成功则 `await screen.noteChatTurn?.()` 并返回 `companion`；失败或 screen 缺席时调用 `talkSession()` 返回 `home + fellBack:true`。
- `sayToHer(ctx, text, deps)`：`deps` 增加 `target`、`screen`；把原来的 `sessionId = deps.sessionId ?? await talkSessionId(...)` 换成 `const resolved = await resolveSaySession({ target: deps.target, screen: deps.screen, talkSession: () => talkSessionId(ctx, { root, log }), log })`；后续 `sessionId = resolved.sessionId`。返回值增加 `target: resolved.target, sessionId: resolved.sessionId, fellBack: resolved.fellBack`。
- `sayToHer` 里 home 的 `bumpTurns` / `rotateTalkSession` 只在 `resolved.target === 'home'` 时执行。
- `observe.js` 的 `/say` 路由：`sayToHer(ctx, text, { root, imagePath, target: body.target, screen: deps.screen, log })`。

- [ ] **Step 4: Run the routing test**

Run: `cd src/dsh-fish && node --test test/say-target.test.mjs`
Expected: PASS 3/3.

- [ ] **Step 5: Write the failing rotation test**

在 `test/screen.test.mjs` 增加：

```js
test('对话轮次也计入轮换：评论 0 + 对话到阈值就换会话', async () => {
  await withRoot(async (root) => {
    const h = makeService(root, { config: normalizeConfig({ presence: { rotateAfter: 2 } }) })
    await h.service.setMode({ mode: 'event', on: true })
    const first = h.service.status().sessionId
    await h.service.noteChatTurn()
    assert.equal(h.service.status().sessionId, first)
    await h.service.noteChatTurn()
    assert.notEqual(h.service.status().sessionId, first)
    assert.equal(h.service.companionInfo().chatTurns, 0)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs`
Expected: FAIL — `noteChatTurn` / `companionInfo` 不存在。

- [ ] **Step 7: Implement screen API**

- `state` 增加 `chatTurns: 0`。
- `rotateIfNeeded()`：`const limit = Number(presence()?.rotateAfter ?? 0); if (!(limit > 0) || state.sessionComments + state.chatTurns < limit) return false`；换会话成功后 `state.chatTurns = 0`。
- `noteChatTurn()`：`state.chatTurns += 1; const rotated = await rotateIfNeeded(); return { rotated, sessionId: state.sessionId }`。
- `companionInfo()`：返回上表四个字段，`rotateAfter` 取 `Number(presence()?.rotateAfter ?? 0)`。
- 导出 `ensureSession`、`noteChatTurn`、`companionInfo`。

- [ ] **Step 8: Run screen tests**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs`
Expected: PASS（含新增 1 条）。

- [ ] **Step 9: Run the full suite and commit**

Run: `cd src/dsh-fish && node --test`
Expected: PASS（基线 1093 + 本任务新增的 4 条；以实际输出为准，并记录在报告里）。

```bash
git add src/dsh-fish/lib/screen.js src/dsh-fish/lib/say.js src/dsh-fish/lib/observe.js src/dsh-fish/test/say-target.test.mjs src/dsh-fish/test/screen.test.mjs
git commit -m "feat(dsh-fish): 桌宠对话进入陪伴会话"
```

---

### Task 2: `pet-view` 心跳、设置与三条新路由

**Files:**
- Modify: `src/dsh-fish/lib/pet-view.js`
- Modify: `src/dsh-fish/lib/observe.js`
- Modify: `src/dsh-fish/lib/settings.js`（`DEFAULTS.pet`、`CONFIG_PATCH_KEYS`）
- Test: `src/dsh-fish/test/pet-view.test.mjs`
- Test: `src/dsh-fish/test/observe-pet.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `screen.companionInfo()`。
- Produces:
  ```js
  petView.markPolled(at = Date.now()): void
  petView.noteHello({ version, skins }, at = Date.now()): void
  petView.snapshot(): {
    activity, action,
    lastPollAt: number | null,
    helloAt: number | null,
    version: string,
    skins: Array<{ id: string, name: string }>,
  }
  ```
- `/pet/state` 增加 `settings`、`companion`、`pet`；新增 `/pet/hello`、`/pet/config`、`/pet/rotate`。
- `config.pet = { size: number, skin: string }`，缺省 `{ size: 400, skin: '' }`。

- [ ] **Step 1: Write failing pet-view tests**

在 `test/pet-view.test.mjs` 增加：

```js
test('心跳与轮询是易失的；online 只看 hello', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })
  assert.equal(pv.snapshot().helloAt, null)
  pv.noteHello({ version: '0.1.0', skins: [{ id: '', name: '默认' }] })
  pv.markPolled()
  assert.equal(pv.snapshot().version, '0.1.0')
  assert.equal(pv.snapshot().skins.length, 1)
  assert.equal(pv.snapshot().lastPollAt, 1000)
  assert.equal(pv.snapshot().helloAt, 1000)
  t += 91_000
  assert.equal(pv.snapshot().helloAt, 1000, 'hello 时间戳不随轮询刷新')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd src/dsh-fish && node --test test/pet-view.test.mjs`
Expected: FAIL — `noteHello` 不存在。

- [ ] **Step 3: Implement pet-view extension**

签名见 Interfaces；`helloAt`/`lastPollAt`/`version`/`skins` 全部内存字段，初值 `null`/`''`/`[]`；`noteHello` 只接受字符串 version 与数组 skins，非法项丢弃。

- [ ] **Step 4: Write failing route tests**

在 `test/observe-pet.test.mjs` 增加：

```js
test('hello / config / rotate 三条新路由', async () => {
  const petView = createPetView({ now: () => 1000 })
  const screen = {
    status: () => ({ on: true, mode: 'event', busy: false, snapshot: null, recent: [] }),
    companionInfo: () => ({ sessionId: 's1', sessionComments: 2, chatTurns: 1, rotateAfter: 30 }),
    ensureSession: async () => 's1',
  }
  registerObserve(ctx, { root, petView, screen })

  assert.equal((await callRoute(ctx.routes, '/pet/hello', 'POST', { version: '0.1.0', skins: [{ id: '', name: '默认' }] })).status, 200)
  assert.equal((await callRoute(ctx.routes, '/pet/state', 'GET')).body.pet.version, '0.1.0')

  const cfg = await callRoute(ctx.routes, '/pet/config', 'POST', { size: 320, skin: '' })
  assert.equal(cfg.status, 200)
  assert.equal(cfg.body.pet.size, 320)
  assert.equal((await callRoute(ctx.routes, '/pet/config', 'POST', { skin: 'Bad ID' })).status, 400)

  const rot = await callRoute(ctx.routes, '/pet/rotate', 'POST', {})
  assert.equal(rot.status, 200)
  assert.equal(rot.body.sessionId, 's1')
})
```

- [ ] **Step 5: Run to verify it fails**

Run: `cd src/dsh-fish && node --test test/observe-pet.test.mjs`
Expected: FAIL — 路由 404/未注册。

- [ ] **Step 6: Implement settings + routes**

- `settings.js`：`DEFAULTS.pet = { size: 400, skin: '' }`；`CONFIG_PATCH_KEYS` 增加 `'pet'`。
- `observe.js` `/pet/state`：`petView.markPolled()`；`const cfg = await (ctx.get?.('fishCore')?.config?.get?.() ?? null)`；返回增加
  - `settings: { size: Number(cfg?.pet?.size ?? 400), skin: String(cfg?.pet?.skin ?? '') }`
  - `companion: deps.screen?.companionInfo?.() ?? null`
  - `pet: { online: helloAt !== null && at - helloAt <= 90_000, lastPollAt, helloAt, version, skins }`
- `/pet/hello`：POST，body `{ version, skins }`，`petView.noteHello(...)`，200 `{ ok:true }`。
- `/pet/config`：POST，校验 `size` 为数字（越界夹取 240–560）、`skin` 为 `''` 或 `/^[a-z0-9-]{1,32}$/`，否则 400 `{ ok:false, note }`；通过 `ctx.get?.('fishCore')?.config?.patch?.({ pet })` 写入（`fishCore.config.patch` 是既有服务）；返回 `{ ok:true, pet }`。
- `/pet/rotate`：POST，`deps.screen.ensureSession({ rotate: true })`；缺席返回 200 `{ ok:false, note:'陪看没在跑。' }`。

- [ ] **Step 7: Run the pet tests**

Run: `cd src/dsh-fish && node --test test/pet-view.test.mjs test/observe-pet.test.mjs`
Expected: PASS。

- [ ] **Step 8: Full suite and commit**

Run: `cd src/dsh-fish && node --test`
Expected: PASS（记录实际数字）。

```bash
git add src/dsh-fish/lib/pet-view.js src/dsh-fish/lib/observe.js src/dsh-fish/lib/settings.js src/dsh-fish/test/pet-view.test.mjs src/dsh-fish/test/observe-pet.test.mjs
git commit -m "feat(dsh-fish): 桌宠心跳、设置与陪伴会话路由"
```

---

### Task 3: 8788 BFF 与工作台「桌宠」页

**Files:**
- Modify: `workbench/fish/routes.mjs`
- Create: `workbench/assets/pages/pet.js`
- Modify: `workbench/assets/nav.js`
- Modify: `workbench/assets/pages/her-presence.js`（移除「让她演一个动作」卡片与 `MOTIONS`/`act`）
- Test: `workbench/test/routes.test.mjs`
- Test: `workbench/test/pages.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `/pet/state`、`/pet/hello`、`/pet/config`、`/pet/rotate`。
- Produces: BFF 路由 `pet/hello`、`pet/config`、`pet/rotate`（POST P2，64 KB，upstream fish）；页面对象 `{ id:'her-pet', nav:'her', slug:'pet', label:'桌宠', order:40 }`。

- [ ] **Step 1: Write failing route tests**

`test/routes.test.mjs` 增加：

```js
test('桌宠心跳/配置/轮换三条 BFF 路由', () => {
  const byPath = Object.fromEntries(ROUTES.map((r) => [r.path, r]))
  for (const p of ['pet/hello', 'pet/config', 'pet/rotate']) {
    assert.equal(byPath[p].methods.POST, 'P2', p)
    assert.equal(byPath[p].upstream, 'fish', p)
    assert.equal(byPath[p].maxBody, 64 * 1024, p)
  }
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workbench && node --test test/routes.test.mjs`
Expected: FAIL — 路由不存在。

- [ ] **Step 3: Add BFF routes and page**

- `routes.mjs`：在 `pet/act` 后加三条同形状条目。
- `assets/pages/pet.js`：`enter` 起 3 秒轮询 `fish('pet/state')`，`leave` 停止；四张卡片：
  1. 状态（在线/离线、最后轮询、activity、action、presence 开关与模式、最近 5 条评论）
  2. 动作试演（七个按钮 → `postFish('pet/act', { motion })`；离线禁用）
  3. 外观（尺寸 小/中/大 → `postFish('pet/config', { size })`；皮肤下拉来自 `pet.skins` → `{ skin }`）
  4. 陪伴会话（短码、评论数、对话轮数、阈值；`postFish('pet/rotate', {})`，先 `confirm`）
- `nav.js`：`import { herPet } from './pages/pet.js'`，`her` 组加入 `herPet`。
- `her-presence.js`：删除 `MOTIONS`、`act()`、`SPEC.actions*` 与动作卡片；保留开关、状态、最近评论。

- [ ] **Step 4: Write failing page tests**

`test/pages.test.mjs` 增加：

```js
test('桌宠页：状态、动作、外观、陪伴会话四块齐全', async () => {
  const { herPet } = await import('../assets/pages/pet.js')
  const s = src('pet.js')
  assert.equal(herPet.id, 'her-pet')
  assert.equal(herPet.slug, 'pet')
  for (const call of ["fish('pet/state')", "postFish('pet/act'", "postFish('pet/config'", "postFish('pet/rotate'"]) assert.ok(s.includes(call), call)
  assert.match(s, /在线|离线/)
  assert.match(s, /皮肤/)
  assert.doesNotMatch(s, /innerHTML|他/)
})
test('陪伴页不再重复动作按钮', () => {
  const s = src('her-presence.js')
  assert.doesNotMatch(s, /postFish\('pet\/act'/)
})
```

- [ ] **Step 5: Run all workbench tests**

Run: `cd workbench && node --test`
Expected: PASS（数字以实际输出为准，更新基线）。

- [ ] **Step 6: Commit**

```bash
git add workbench/fish/routes.mjs workbench/assets/pages/pet.js workbench/assets/nav.js workbench/assets/pages/her-presence.js workbench/test/routes.test.mjs workbench/test/pages.test.mjs
git commit -m "feat(workbench): 桌宠页与 BFF 路由"
```

---

### Task 4: 薄壳心跳、设置应用与本地皮肤

**Files:**
- Create: `desktop-pet/electron/skin.ts`
- Modify: `desktop-pet/electron/main.ts`
- Modify: `desktop-pet/electron/preload.ts`
- Modify: `desktop-pet/renderer/App.tsx`
- Modify: `desktop-pet/package.json`（`test` 脚本加入 `test/skin.test.ts`）
- Test: `desktop-pet/test/skin.test.ts`（新建）

**Interfaces:**
- Consumes: `/pet/state` 的 `settings`、`pet.skins`；`/pet/config`；`/pet/hello`。
- Produces:
  ```ts
  scanSkins(rootDir: string): Array<{ id: string, name: string, config: unknown }>
  validateSkin(json: unknown): { ok: true, name: string, motions: Record<string, unknown> } | { ok: false, why: string }
  shouldApplySettings(current: { size: number, skin: string }, next: { size?: number, skin?: string }): boolean
  SIMPLE_SKIN_ID: RegExp  // /^[a-z0-9-]{1,32}$/
  ```
- `window.petBridge` 增加 `onSkin(handler)`；`App` 用皮肤 config/uri 渲染 `<Pet>`。

- [ ] **Step 1: Write failing skin tests**

`test/skin.test.ts`：

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateSkin, SIMPLE_SKIN_ID } from '../electron/skin.ts'

test('skin.json 必须覆盖 14 个动作', () => {
  const motions = Object.fromEntries(['idle','turn','moving-left','moving-right','waving','thinking','working','result','waiting','running','review','failed','success','error'].map(m => [m, 'x']))
  assert.equal(validateSkin({ name: '测试', motions }).ok, true)
  assert.equal(validateSkin({ name: '缺动作', motions: { idle: 'x' } }).ok, false)
  assert.equal(validateSkin(null).ok, false)
})
test('皮肤 id 只允许小写字母数字与连字符', () => {
  assert.equal(SIMPLE_SKIN_ID.test('maid-blue'), true)
  assert.equal(SIMPLE_SKIN_ID.test('大肥鱼'), false)
  assert.equal(SIMPLE_SKIN_ID.test('../escape'), false)
})
test('同一设置重复下发不重复应用（避免抖动/重载）', () => {
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { size: 400, skin: '' }), false)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { size: 320 }), true)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, { skin: 'maid-blue' }), true)
  assert.equal(shouldApplySettings({ size: 400, skin: '' }, {}), false)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd desktop-pet && node --test --experimental-strip-types test/skin.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: Implement `skin.ts`**

- `validateSkin`：对象、`name` 非空字符串、`motions` 覆盖 `MOTIONS` 全部 14 项（值非空字符串）→ ok；否则 `{ ok:false, why }`。
- `shouldApplySettings`：只在 `next` 给出的字段与 `current` 不同时返回 `true`；`next` 空对象返回 `false`。
- `scanSkins(rootDir)`：读 `assets/skins/*/skin.json`，跳过非法目录/非法 JSON/未通过校验项，首项固定 `{ id: '', name: '默认', config: null }`。

- [ ] **Step 4: Run skin tests**

Run: `cd desktop-pet && node --test --experimental-strip-types test/skin.test.ts`
Expected: PASS。

- [ ] **Step 5: Wire heartbeat and settings in `main.ts`**

- 启动后与每 60 秒 `POST http://127.0.0.1:8788/api/fish/pet/hello`，body `{ version, skins: scanSkins(...).map(({id,name}) => ({id,name})) }`；失败静默（不刷屏）。
- 轮询 state 时比较 `settings.size`：与当前不同则 `changePetSize`（不写回本地 settings 以免循环）；`settings.skin` 与当前不同则加载皮肤：`pet-asset://local/skins/<id>/skin.json`；失败保留旧皮肤并记录。
- 右键「大小」继续本地生效，并尽力 `POST /api/fish/pet/config` 同步服务端；失败不影响本地。
- `preload.ts` 增加 `onSkin(handler)`；`App.tsx` 保存 `skinConfig`/`skinUri`，变化时传给 `<Pet config uri>`，并在登录/变化时把尺寸 CSS 变量同步。

- [ ] **Step 6: Run desktop-pet tests**

Run: `cd desktop-pet && npm test`（脚本已含六个文件）
Expected: PASS 24（21 + 3 新增，按实际输出更新基线）。

- [ ] **Step 7: Commit**

```bash
git add desktop-pet/electron/skin.ts desktop-pet/electron/main.ts desktop-pet/electron/preload.ts desktop-pet/renderer/App.tsx desktop-pet/package.json desktop-pet/test/skin.test.ts
git commit -m "feat(desktop-pet): 心跳、远程尺寸与本地皮肤"
```

---

### Task 5: 文档、基线与手工验收

**Files:**
- Modify: `src/dsh-fish/AGENTS.md`、`src/dsh-fish/README.md`、`src/dsh-fish/CHANGELOG.md`
- Modify: `desktop-pet/README.md`（皮肤目录与工作台操作说明）

- [ ] **Step 1: Run all suites**

```bash
cd src/dsh-fish && node --test
cd ../../workbench && node --test
cd ../desktop-pet && npm test
```

记录实际数字。

- [ ] **Step 2: Update baselines and changelog**

把实际数字写进 `src/dsh-fish/AGENTS.md` / `README.md`；`CHANGELOG.md` 增加「桌宠陪伴会话与工作台页」条目，写明：桌宠对话进陪伴会话、轮换合并计数、heartbeat 在线判定、尺寸/皮肤下发、皮肤目录结构；未验收项（Windows 真机皮肤切换、工作台手动验收）单列。

- [ ] **Step 3: Manual acceptance（Windows + 工作台）**

1. presence 开着时桌宠说一句 → 回复在「陪你看屏幕」会话里；关闭 presence 后再说 → 仍进同一条会话，轮换计数增长。
2. 工作台聊天仍进 home。
3. 桌宠页：在线/离线正确（关掉桌宠 90 秒内变离线）；七个动作可播；改尺寸 2 秒内生效；改皮肤 2 秒内生效；坏皮肤不崩。
4. 「换一条」后新会话出现，旧会话保留在侧栏。

- [ ] **Step 4: Commit**

```bash
git add src/dsh-fish/AGENTS.md src/dsh-fish/README.md src/dsh-fish/CHANGELOG.md desktop-pet/README.md
git commit -m "docs: 桌宠陪伴会话与工作台页验收与基线"
```
