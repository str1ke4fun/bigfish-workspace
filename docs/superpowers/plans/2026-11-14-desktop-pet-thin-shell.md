# Desktop Pet Thin Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Windows 桌宠通过一个独立的 Electron 薄壳显示大肥鱼的 presence 评论与活动状态，并支持工作台/右键菜单“演一个动作”。

**Architecture:** `dsh-fish` 新增一个纯内存的 `pet-view`（activity reducer + 单槽动作）和两条本机 HTTP 路由；8788 BFF 转发；Windows 侧独立 Electron + React 19 + `dsh-pet-component` 轮询 `/pet/state`，用组件命令面播动作/气泡。桌宠壳不包含 dsh-pet 的 AI/人设/记忆。

**Tech Stack:** Node.js 24、`node:test`、dsh-fish（零依赖）、workbench（零依赖）、Electron 43、React 19、TypeScript、Vite、`dsh-pet-component@0.2.5`、VP9-alpha WebM 素材。

**Spec:** `docs/superpowers/specs/2026-11-14-desktop-pet-thin-shell-design.md`

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 永远保持 `{}`；桌宠依赖只放在 `desktop-pet/package.json`。
- `~/.dsh-fish/events.jsonl` 只追加；本计划不新增事件类型、不写 schema、不把动作/评论写进事件流。
- `pet-view` 全部易失：不落盘、不写 presence 台账、不调用模型。
- 不新增人格输入、好感度数字、情绪标签或能让用户直接指定她性格的入口。
- 面向用户的界面文案不出现男字旁的「他」，不出现「三道门 / 四道门」；统一「四个阶段 / 三道瓶颈」。
- 新输入口都走 `observe.js` 的 `guarded()`；`pet/act` 只接受本机 8788 BFF 转发。
- 桌宠只拿 `recent` / `activity` / `action` 的文本，不接触屏幕图像、窗口标题、OCR。
- 动作白名单与 `dsh-pet-component` 的 `MOTIONS` 一致；`dragging` 不作为用户可选动作。
- 动作文本上限 120 字；`ttlMs` 夹在 1000–60000，默认 15000；单槽覆盖，不排队。
- `dsh-fish` 基线 `node --test` 1077 全绿；`workbench` 基线 110 全绿；新增测试后更新基线数字。
- dsh-pet 代码 MIT；形象/素材 CC BY-NC-SA 4.0（署名、非商业、相同方式共享），必须在 `desktop-pet/assets/ATTRIBUTION.md` 写清。
- 桌宠壳只访问 `127.0.0.1:8788`；不监听端口、不远程、不带 token。
- Windows 薄壳不进入 `src/dsh-fish`；`desktop-pet/` 独立构建。

## Review Focus

- **畸形 `pet/act`**（未知 motion、超长 text、负数/超大 ttl、坏 JSON）：应该明确拒绝且不破坏上一条有效动作，不能抛到路由层。
- **BFF/8710 不可达或很慢**：薄壳不能崩溃、不能刷屏、不能每 2 秒弹错误；恢复后继续轮询。
- **重复评论/重复动作**（重启、轮询重叠、同一 action 多拍）：同一句只弹一次，同一个 action id 只播一次。
- **透明窗点击穿透**（气泡、右键菜单、对话输入框打开时）：宠物身体可点，UI 可点，其余透明区域不能挡游戏。
- **非她的会话**（B 站出门、QQ、别人的会话、宿主工具会话）：不能触发桌宠动作；只有 web/screen 且 `isHerAgent` 的会话进 activity。

---

### Task 1: `pet-view` 纯逻辑与动作槽

**Files:**
- Create: `src/dsh-fish/lib/pet-view.js`
- Test: `src/dsh-fish/test/pet-view.test.mjs`

**Interfaces:**
- Produces:
  ```js
  export const PET_MOTIONS = Object.freeze([
    'idle', 'turn', 'moving-left', 'moving-right', 'waving',
    'thinking', 'working', 'result', 'waiting', 'running',
    'review', 'failed', 'success', 'error',
  ])
  export const PET_ACTION_MOTIONS = Object.freeze(PET_MOTIONS.filter((m) => m !== 'dragging'))
  export const PET_TEXT_LIMIT = 120
  export const PET_ACTION_TTL_MS = 15_000
  export function petSurfaceAllowed(surface): boolean // surface === 'web' || surface === 'screen'
  export function reduceActivity(event): string | null | undefined
  export function pickActivity(entries): { state, at, seq, sessionId } | null
  export function createPetView({ now = Date.now, log } = {}) {
    noteSessionEvent({ sessionId, surface }, event): boolean
    act({ motion, text, ttlMs }): { ok: true, action } | { ok: false, note }
    snapshot(): { activity, action }
    clear(): void
  }
  ```
- `reduceActivity` returns `undefined` = 不关心理会（meta 等），`null` = 清空该会话，字符串 = 六档之一。
- `noteSessionEvent` 只接受 `petSurfaceAllowed(surface)`；不满足返回 `false`。
- `snapshot().activity` 为 `{ state, at, sessionId } | null`；`snapshot().action` 为 `{ id, motion, text, at, ttlMs } | null`，过期返回 `null`。

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PET_MOTIONS, PET_ACTION_MOTIONS, reduceActivity, pickActivity,
  createPetView, petSurfaceAllowed,
} from '../lib/pet-view.js'

test('六档映射与清空语义', () => {
  assert.equal(reduceActivity({ type: 'turn/start' }), 'thinking')
  assert.equal(reduceActivity({ type: 'tool/call', data: { name: 'read_image' } }), 'working')
  assert.equal(reduceActivity({ type: 'tool/call', data: { name: 'ask_user_question' } }), 'waiting')
  assert.equal(reduceActivity({ type: 'tool/result' }), 'result')
  assert.equal(reduceActivity({ type: 'approval/asked' }), 'waiting')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), 'success')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'error' } } }), 'error')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }), 'error')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }), 'waiting')
  assert.equal(reduceActivity({ type: 'turn/end', data: { reason: { kind: 'aborted' } } }), null)
  assert.equal(reduceActivity({ type: 'meta', text: 'x' }), undefined)
})

test('优先级与同档最近', () => {
  const entries = [
    { state: 'success', at: 1, seq: 1, sessionId: 'a' },
    { state: 'thinking', at: 2, seq: 2, sessionId: 'b' },
    { state: 'working', at: 3, seq: 3, sessionId: 'c' },
    { state: 'working', at: 4, seq: 4, sessionId: 'd' },
  ]
  assert.equal(pickActivity(entries).sessionId, 'd')
  assert.equal(pickActivity([{ state: 'waiting', at: 1, seq: 1, sessionId: 'x' }]).state, 'waiting')
})

test('只接受 web/screen', () => {
  assert.equal(petSurfaceAllowed('web'), true)
  assert.equal(petSurfaceAllowed('screen'), true)
  assert.equal(petSurfaceAllowed('bili'), false)
  assert.equal(petSurfaceAllowed('wx'), false)
  assert.equal(petSurfaceAllowed(''), false)
})

test('动作槽校验、覆盖与过期', () => {
  let t = 1000
  const pv = createPetView({ now: () => t })
  assert.equal(pv.act({ motion: 'nope' }).ok, false)
  assert.equal(pv.act({ motion: 'waving', text: 'x'.repeat(121) }).ok, false)
  assert.equal(pv.act({ motion: 'waving', ttlMs: 10 }).action.ttlMs, 1000)
  const a = pv.act({ motion: 'waving', text: ' 你好 ' }).action
  assert.equal(a.text, '你好')
  assert.equal(pv.snapshot().action.id, a.id)
  t += 1000
  const b = pv.act({ motion: 'success' }).action
  assert.notEqual(b.id, a.id)
  assert.equal(pv.snapshot().action.motion, 'success')
  t += 60_000
  assert.equal(pv.snapshot().action, null)
})

test('noteSessionEvent 忽略非她面/非六档事件', () => {
  const pv = createPetView({ now: () => 1 })
  assert.equal(pv.noteSessionEvent({ sessionId: 's', surface: 'bili' }, { type: 'turn/start' }), false)
  assert.equal(pv.noteSessionEvent({ sessionId: 's', surface: 'web' }, { type: 'meta' }), false)
  assert.equal(pv.noteSessionEvent({ sessionId: 's', surface: 'web' }, { type: 'turn/start' }), true)
  assert.equal(pv.snapshot().activity.state, 'thinking')
  pv.noteSessionEvent({ sessionId: 's', surface: 'web' }, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
  assert.equal(pv.snapshot().activity, null)
})

test('MOTIONS 白名单与 dsh-pet-component 一致', () => {
  assert.deepEqual(PET_MOTIONS, [
    'idle', 'turn', 'moving-left', 'moving-right', 'waving',
    'thinking', 'working', 'result', 'waiting', 'running',
    'review', 'failed', 'success', 'error',
  ])
  assert.equal(PET_ACTION_MOTIONS.includes('dragging'), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/dsh-fish && node --test test/pet-view.test.mjs`
Expected: FAIL with `Cannot find module '../lib/pet-view.js'`.

- [ ] **Step 3: Implement `src/dsh-fish/lib/pet-view.js`**

- `reduceActivity`: copy the six-state mapping from dsh-pet `src/host/work-status.ts` (MIT; add a file-header attribution). `ask_user_question` → waiting; `turn/end` completed→success, error/max-tokens/timeout→error, blocked→waiting, anything else→null.
- `pickActivity`: priority `waiting 60 > error 50 > working 40 > thinking 30 > result 25 > success 20`; ties by larger `seq`.
- `createPetView`: `Map<sessionId, {state, at, seq, sessionId}>`; `seq` increments on every accepted event; `null` deletes the session; `undefined` does nothing.
- `act`: motion must be in `PET_ACTION_MOTIONS`; text `String(...).trim()` and >120 rejects; `ttlMs` numeric clamp 1000–60000 default 15000; id `pet-${now()}-${++counter}`; replace slot.
- `snapshot`: activity from `pickActivity([...map.values()])`; action null if `now() - at >= ttlMs`.
- No timers, no fs, no imports from other dsh-fish modules.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/dsh-fish && node --test test/pet-view.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dsh-fish/lib/pet-view.js src/dsh-fish/test/pet-view.test.mjs
git commit -m "feat(dsh-fish): 桌宠动作槽与活动状态聚合"
```

---

### Task 2: `dsh-fish` 的 `/pet/state` 与 `/pet/act`

**Files:**
- Modify: `src/dsh-fish/lib/observe.js`（在 `/presence/*` 后面加两条路由）
- Test: `src/dsh-fish/test/observe-pet.test.mjs`
- `index.js` 的 `petView` 注入在 Task 3 完成。

**Interfaces:**
- Consumes: `deps.petView.snapshot()`, `deps.petView.act(...)`, `deps.screen.status()`.
- Produces:
  - `GET /dsh-fish/pet/state` → 200
    ```json
    {
      "at": 1794640000000,
      "presence": { "on": false, "mode": null, "busy": false, "snapshot": null, "recent": [] },
      "activity": null,
      "action": null
    }
    ```
  - `POST /dsh-fish/pet/act` body `{ motion, text?, ttlMs? }` → 200 `{ ok:true, action }`；未知 motion/超长 text/坏 ttl → 400 `{ ok:false, note }`；非 POST → 405。
  - `petView` 缺席时两条路由都返回 200 `{ ok:false, note:'桌宠状态没在跑。' }`，不 500。

- [ ] **Step 1: Write the failing test**

Copy the `fakeCtx` / `callRoute` pattern from `test/observe-reports.test.mjs`. Use a real `createPetView` and a fake screen:

```js
const petView = createPetView({ now: () => 1000 })
petView.noteSessionEvent({ sessionId: 's1', surface: 'web' }, { type: 'turn/start' })
petView.act({ motion: 'waving', text: '你好' })
const screen = { status: () => ({ on: true, mode: 'event', busy: false, snapshot: null, recent: [{ at: '2026-11-14T08:00:00Z', mode: 'event', event: 'scene_change', text: '这一下有点意思。' }] }) }
registerObserve(ctx, { root, petView, screen })

const s = await callRoute(ctx.routes, '/pet/state', 'GET')
assert.equal(s.status, 200)
assert.equal(s.body.activity.state, 'thinking')
assert.equal(s.body.action.motion, 'waving')
assert.equal(s.body.presence.recent[0].text, '这一下有点意思。')

const ok = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'success' })
assert.equal(ok.status, 200)
assert.equal(ok.body.action.motion, 'success')

const bad = await callRoute(ctx.routes, '/pet/act', 'POST', { motion: 'dragging' })
assert.equal(bad.status, 400)
assert.equal(bad.body.ok, false)
assert.equal((await callRoute(ctx.routes, '/pet/act', 'GET')).status, 405)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/dsh-fish && node --test test/observe-pet.test.mjs`
Expected: FAIL because `/pet/state` is not registered.

- [ ] **Step 3: Implement routes in `observe.js`**

- Add after the `/presence/mode` block:
  ```js
  ['/pet/state', async (req, res) => {
    const pet = deps.petView
    if (!pet?.snapshot) return send(res, 200, { ok: false, note: '桌宠状态没在跑。' })
    const s = pet.snapshot()
    const raw = deps.screen?.status?.() ?? null
    const presence = raw ? {
      on: Boolean(raw.on), mode: raw.mode ?? null, busy: Boolean(raw.busy),
      snapshot: raw.snapshot ?? null, recent: Array.isArray(raw.recent) ? raw.recent : [],
    } : null
    return send(res, 200, { at: Date.now(), presence, activity: s.activity, action: s.action })
  }],
  ['/pet/act', async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
    const pet = deps.petView
    if (!pet?.act) return send(res, 200, { ok: false, note: '桌宠状态没在跑。' })
    let body = {}
    try { body = JSON.parse(await readBody(req, 64_000) || '{}') }
    catch { return send(res, 400, { ok: false, note: 'body 不是 JSON' }) }
    const r = pet.act({ motion: body?.motion, text: body?.text, ttlMs: body?.ttlMs })
    if (!r.ok) return send(res, 400, r)
    return send(res, 200, r)
  }],
  ```
- Do not add these paths to the public docs page; they are BFF-only.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/dsh-fish && node --test test/observe-pet.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dsh-fish/lib/observe.js src/dsh-fish/test/observe-pet.test.mjs
git commit -m "feat(dsh-fish): 桌宠状态与动作 HTTP 路由"
```

---

### Task 3: 把 `pet-view` 接到她自己的会话事件

**Files:**
- Modify: `src/dsh-fish/lib/index.js:280-360`（`session/event` 监听与 `screen` 创建附近）
- Modify: `src/dsh-fish/lib/index.js:430`（`registerObserve` 参数）

**Interfaces:**
- Consumes: `isHerAgent({session}, herDir)`, `fishCore.surface.current({session})`, `createPetView`, `petSurfaceAllowed`.
- Produces: `deps.petView` for `registerObserve`；disposer 清理监听。

这是纯接线，不新增可单测的算法；`petSurfaceAllowed` 的守卫已由 Task 1 覆盖，路由形状由 Task 2 覆盖。接线失败的表现是 `/pet/state` 的 `activity` 永远为 null，Task 10 的手工验收会抓。

- [ ] **Step 1: Implement wiring in `index.js`**

- Import:
  ```js
  import { createPetView, petSurfaceAllowed } from './pet-view.js'
  ```
- After `const screen = createScreenService(...)`:
  ```js
  const petView = createPetView({ log: (...a) => logger.warn(...a) })
  try {
    const offPet = ctx.on?.('session/event', (session, event) => {
      try {
        if (!isHerAgent({ session }, herDir)) return
        const surface = String(fishCore?.surface?.current?.({ session }) ?? '')
        if (!petSurfaceAllowed(surface)) return
        const sessionId = session?.header?.id ?? session?.id
        if (!sessionId) return
        petView.noteSessionEvent({ sessionId, surface }, event)
      } catch { /* 一条事件不能拖垮总线 */ }
    })
    if (typeof offPet === 'function') disposers.push(offPet)
  } catch (err) {
    logger.warn('[dsh-fish] 桌宠活动监听没挂上', err?.message ?? err)
  }
  ```
- Change `registerObserve(ctx, { root, version: VERSION, exposure, screen })` to include `petView`.
- Ensure `petView.clear()` is called on dispose if it has timers; v1 has none.

- [ ] **Step 2: Run the dsh-fish suite**

Run: `cd src/dsh-fish && node --test`
Expected: PASS（1077 + 新增）。

- [ ] **Step 3: Commit**

```bash
git add src/dsh-fish/lib/index.js
git commit -m "feat(dsh-fish): 接线桌宠活动状态"
```

---

### Task 4: 8788 BFF 与工作台“演一个动作”

**Files:**
- Modify: `workbench/fish/routes.mjs:24`（presence 两条后面）
- Modify: `workbench/assets/pages/her-presence.js`
- Test: `workbench/test/routes.test.mjs`
- Test: `workbench/test/pages.test.mjs`

**Interfaces:**
- Produces:
  - BFF `GET /api/fish/pet/state` → upstream `/dsh-fish/pet/state`
  - BFF `POST /api/fish/pet/act` → upstream `/dsh-fish/pet/act`, `maxBody: 64*1024`
  - 页面按钮 `postFish('pet/act', { motion })`；动作：`waving / thinking / working / result / waiting / success / error`

- [ ] **Step 1: Write failing tests**

In `routes.test.mjs`:
```js
test('桌宠状态/动作两条 BFF 路由', () => {
  const byPath = Object.fromEntries(ROUTES.map((r) => [r.path, r]))
  assert.equal(byPath['pet/state'].methods.GET, 'P1')
  assert.equal(byPath['pet/state'].upstream, 'fish')
  assert.equal(byPath['pet/act'].methods.POST, 'P2')
  assert.equal(byPath['pet/act'].maxBody, 64 * 1024)
})
```

In `pages.test.mjs`:
```js
test('陪伴页可以让她演一个动作', () => {
  const s = src('her-presence.js')
  assert.match(s, /postFish\('pet\/act'/)
  for (const m of ['waving', 'thinking', 'working', 'result', 'waiting', 'success', 'error']) {
    assert.ok(s.includes(m), m)
  }
  assert.doesNotMatch(s, /innerHTML|他/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd workbench && node --test test/routes.test.mjs test/pages.test.mjs`
Expected: FAIL for missing routes/buttons.

- [ ] **Step 3: Implement**

- `routes.mjs` add:
  ```js
  { path: 'pet/state', methods: { GET: 'P1' }, upstream: 'fish' },
  { path: 'pet/act', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
  ```
- `her-presence.js` add a card `让她演一个动作` under the presence card:
  - `SPEC.actions = el('div', { class: 'row' })`
  - buttons via `el('button', { class: 'small', type:'button', text: label, onclick: () => act(motion) })`
  - `act(motion)`: disable button, `postFish('pet/act', { motion })`, show `r.data?.note || '动作没送到。'` on failure; re-enable.
  - No persona/number fields; no `innerHTML`.
- Keep polling `presence/status` unchanged.

- [ ] **Step 4: Run tests**

Run: `cd workbench && node --test`
Expected: PASS（110 + 新增）。

- [ ] **Step 5: Commit**

```bash
git add workbench/fish/routes.mjs workbench/assets/pages/her-presence.js workbench/test/routes.test.mjs workbench/test/pages.test.mjs
git commit -m "feat(workbench): 桌宠动作控制与 BFF 路由"
```

---

### Task 5: `desktop-pet` 薄壳脚手架与最小渲染

**Files:**
- Create: `desktop-pet/package.json`
- Create: `desktop-pet/tsconfig.json`
- Create: `desktop-pet/vite.config.ts`
- Create: `desktop-pet/electron/main.ts`
- Create: `desktop-pet/electron/preload.ts`
- Create: `desktop-pet/renderer/index.html`
- Create: `desktop-pet/renderer/main.tsx`
- Create: `desktop-pet/renderer/App.tsx`
- Create: `desktop-pet/renderer/styles.css`
- Create: `desktop-pet/assets/config.json`
- Create: `desktop-pet/assets/ATTRIBUTION.md`
- Create: `desktop-pet/.gitignore`
- Test: `desktop-pet/test/config.test.ts`

**Interfaces:**
- Consumes: `dsh-pet-component` `<Pet>`, `useControllablePet`.
- Produces:
  - `createPetWindow()`：500×340 透明、无边框、置顶、跳过任务栏的 `BrowserWindow`。
  - `pet-asset://local/config.json` 与 `pet-asset://local/webm/<name>.webm` 协议。
  - `window.petBridge` 只暴露 `onState(cb)`、`onAction(cb)`、`setIgnoreMouse(ignore)`、`requestAction(motion)`；前两个返回 unsubscribe。
  - `assets/config.json` 的 `animations.motions` 映射 14 个动作到动画名。

- [ ] **Step 1: Write the failing test**

`desktop-pet/test/config.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '../assets/config.json'), 'utf8'))

test('config 覆盖 14 个动作，且没有重复动画名', () => {
  const names = new Set<string>()
  for (const m of ['idle','turn','moving-left','moving-right','waving','thinking','working','result','waiting','running','review','failed','success','error']) {
    assert.ok(cfg.animations.motions[m], m)
    names.add(cfg.animations.motions[m])
  }
  assert.ok(names.size >= 10)
})

test('config 不包含人设/提示词/数值字段', () => {
  const text = JSON.stringify(cfg)
  for (const bad of ['whisperPrompt', 'chatModel', 'balanceEnabled']) assert.equal(text.includes(bad), false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd desktop-pet && node --test --experimental-strip-types test/config.test.ts`
Expected: FAIL because `assets/config.json` does not exist.

- [ ] **Step 3: Scaffold the app**

- `package.json`:
  - `"type": "module"`, `"main": "dist-electron/main.js"`.
  - dependencies: `electron@43.3.0`, `react@19.2.8`, `react-dom@19.2.8`, `dsh-pet-component@0.2.5`.
  - devDependencies: `typescript`, `vite`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`, `electron-builder`.
  - scripts: `dev`, `build`, `test`（Task 5 先只指 `test/config.test.ts`；Task 9 再收敛为全部五个文件）, `dist:win`。
- `vite.config.ts`: React plugin；`build.outDir = 'dist-renderer'`；`base: './'`。
- `electron/main.ts`:
  - `protocol.registerSchemesAsPrivileged([{ scheme:'pet-asset', privileges:{ standard:true, secure:true, supportFetchAPI:true }}])` before ready.
  - `app.whenReady()` → `protocol.handle('pet-asset', ...)` mapping to `assets/`; `createPetWindow()`.
  - `BrowserWindow`: `width:500, height:340, transparent:true, frame:false, alwaysOnTop:true, skipTaskbar:true, hasShadow:false, resizable:false, webPreferences:{ preload, contextIsolation:true, nodeIntegration:false, sandbox:true }`.
  - load `dist-renderer/index.html` (or `VITE_DEV_SERVER_URL` if set).
- `preload.ts`: `contextBridge.exposeInMainWorld('petBridge', {...})`; only the four functions above (`onState`/`onAction` subscribe, `setIgnoreMouse`, `requestAction`).
- `App.tsx`: load config from `pet-asset://local/config.json`; `<Pet config={config} uri={{ default:'pet-asset://local/webm' }} size={462} />`; no action controller yet.
- `assets/config.json`: use the subset mapping below and `size: 462`.
- `assets/ATTRIBUTION.md`: dsh-pet MIT + character CC BY-NC-SA + source URLs.
- `.gitignore`: `node_modules/`, `dist-electron/`, `dist-renderer/`, `release/`, `assets/webm/`（素材用脚本同步，不进 Git）。

Subset mapping (v1, copy these WebM files from `D:\dsh-pet\package\assets\webm`):

```json
{
  "size": 462,
  "animations": {
    "idle": ["待机呼吸休闲"],
    "turn": ["东张西望"],
    "drag": ["被鼠标拖拽悬空反馈"],
    "clicks": ["点击回应-元气挥手"],
    "moves": { "default": { "minDist": 60, "maxDist": 240, "margin": 20, "leadSec": 2, "tailSec": 2 }, "actions": [{ "name": "螃蟹走路" }] },
    "motions": {
      "idle": "待机呼吸休闲",
      "turn": "东张西望",
      "moving-left": "螃蟹走路",
      "moving-right": "螃蟹走路",
      "waving": "点击回应-元气挥手",
      "thinking": "工作状态-思考冒泡",
      "working": "工作状态-忙碌点按",
      "result": "工作状态-清点归档",
      "waiting": "工作状态-原地踱步张望",
      "running": "工作状态-忙碌点按",
      "review": "工作状态-清点归档",
      "failed": "工作状态-垂头叹气冒汗",
      "success": "工作状态-雀跃庆祝",
      "error": "工作状态-垂头叹气冒汗",
      "dragging": "被鼠标拖拽悬空反馈"
    }
  }
}
```

Copy list: `待机呼吸休闲.webm`, `东张西望.webm`, `被鼠标拖拽悬空反馈.webm`, `点击回应-元气挥手.webm`, `螃蟹走路.webm`, `工作状态-思考冒泡.webm`, `工作状态-忙碌点按.webm`, `工作状态-清点归档.webm`, `工作状态-原地踱步张望.webm`, `工作状态-雀跃庆祝.webm`, `工作状态-垂头叹气冒汗.webm`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd desktop-pet && node --test --experimental-strip-types test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Build and smoke-load**

Run: `cd desktop-pet && npm run build && npm start`
Expected: 一个透明小窗出现，宠物处于 `idle`；控制台无 uncaught error。**Windows 上执行；WSL 不做这一步。**

- [ ] **Step 6: Commit**

```bash
git add desktop-pet/package.json desktop-pet/package-lock.json desktop-pet/tsconfig.json desktop-pet/vite.config.ts desktop-pet/electron desktop-pet/renderer desktop-pet/assets/config.json desktop-pet/assets/ATTRIBUTION.md desktop-pet/.gitignore desktop-pet/test/config.test.ts
git commit -m "feat(desktop-pet): 薄壳脚手架与最小渲染"
```

---

### Task 6: 动作控制器与轮询

**Files:**
- Create: `desktop-pet/renderer/controller.ts`
- Create: `desktop-pet/electron/poller.ts`
- Modify: `desktop-pet/electron/main.ts`（启动 poller，IPC 推 state）
- Modify: `desktop-pet/renderer/App.tsx`（订阅 state，调用 `pet.motion` / `pet.bubble`）
- Test: `desktop-pet/test/controller.test.ts`
- Test: `desktop-pet/test/poller.test.ts`

**Interfaces:**
- `type PetState = { at:number; presence:{on:boolean;mode:string|null;busy:boolean;snapshot:unknown;recent:Array<{at:string;mode:string;event:string;text:string}>}|null; activity:{state:string;at:number;sessionId:string}|null; action:{id:string;motion:string;text:string|null;at:number;ttlMs:number}|null }`
- `decideEffects(prev, state, now): { motion?: string; bubble?: { id:string; text:string; motion?:string }; seen: Seen }`
- `createPoller({ fetchImpl, url, intervalMs=2000, onState, onError, signal, schedule, cancel })` → `{ start, stop, tick }`
- `Seen` 持久化：`{ lastActionId:string; lastCommentAt:string; activity:string|null }`
- 动作优先级：显式 action（未过期）> 新评论气泡 > activity > idle；显式 action 过期/消失后回落到当前 activity（没有则 idle）。
- 评论气泡带动作：`event==='settlement'` → `success`，其余 → `waving`；显式 action 的 `text` 也弹气泡。
- 同一 `action.id` 只播一次；同一 `recent.at` 只弹一次；activity 变化才切动作。

- [ ] **Step 1: Write failing controller tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideEffects } from '../renderer/controller.ts'

const base = { at: 1, presence: null, activity: null, action: null }
test('显式动作优先，过期不播', () => {
  const r = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, {
    ...base, action:{ id:'a1', motion:'success', text:null, at:1000, ttlMs:15000 },
  }, 2000)
  assert.equal(r.motion, 'success')
  const stale = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, {
    ...base, action:{ id:'a2', motion:'error', text:null, at:0, ttlMs:1000 },
  }, 2000)
  assert.notEqual(stale.motion, 'error')
})
test('同一评论只弹一次，新评论弹气泡', () => {
  const state = { ...base, presence:{ on:true, mode:'event', busy:false, snapshot:null, recent:[{ at:'2026-11-14T08:00:00Z', mode:'event', event:'scene_change', text:'你好' }] } }
  const a = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, state, 1)
  assert.equal(a.bubble?.text, '你好')
  const b = decideEffects(a.seen, state, 2)
  assert.equal(b.bubble, undefined)
})
test('activity 变化才切动作，动作过期后回落 activity', () => {
  const s = { ...base, activity:{ state:'thinking', at:1, sessionId:'s' } }
  const a = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, s, 2)
  assert.equal(a.motion, 'thinking')
  const b = decideEffects(a.seen, s, 3)
  assert.equal(b.motion, undefined)
  const act = decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, {
    ...s, action:{ id:'a1', motion:'success', text:'好耶', at:10, ttlMs:100 },
  }, 20)
  assert.equal(act.motion, 'success')
  assert.equal(act.bubble?.text, '好耶')
  const back = decideEffects(act.seen, s, 200)
  assert.equal(back.motion, 'thinking')
})
test('settlement 评论用 success，其余用 waving', () => {
  const mk = (event) => ({ ...base, presence:{ on:true, mode:'event', busy:false, snapshot:null, recent:[{ at:'t', mode:'event', event, text:'x' }] } })
  assert.equal(decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, mk('settlement'), 1).bubble?.motion, 'success')
  assert.equal(decideEffects({ lastActionId:'', lastCommentAt:'', activity:null }, mk('scene_change'), 1).bubble?.motion, 'waving')
})
```

`desktop-pet/test/poller.test.ts`:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPoller } from '../electron/poller.ts'

const okState = { at: 1, presence: null, activity: null, action: null }

test('成功时 onState，失败时 onError 并退避，不抛', async () => {
  const delays: number[] = []
  let calls = 0
  let states = 0
  let errors = 0
  const p = createPoller({
    url: 'http://127.0.0.1:8788/api/fish/pet/state',
    intervalMs: 2000,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1) throw new Error('down')
      return new Response(JSON.stringify(okState), { status: 200 })
    },
    schedule: (_fn, ms) => { delays.push(ms); return 0 },
    cancel: () => {},
    onState: () => { states += 1 },
    onError: () => { errors += 1 },
  })
  await p.tick()
  assert.equal(errors, 1)
  assert.equal(delays[0], 2000)
  await p.tick()
  assert.equal(states, 1)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd desktop-pet && node --test --experimental-strip-types test/controller.test.ts`
Expected: FAIL module missing.

- [ ] **Step 3: Implement controller and poller**

- `decideEffects`: pure; no React/Electron imports; from `recent` take the entry with the largest ISO `at`; compare it to `lastCommentAt`; action TTL uses the shell clock (`now`); action text bubble; comment motion mapping; when a previously seen action is gone/expired, return activity state or `idle`; return `seen`.
- `createPoller`: `fetchImpl(url, { signal })`; parse JSON; on non-ok/throw call `onError`; exponential backoff 2s→30s; `stop()` aborts. No console spam; log first failure only.
- `main.ts`: start poller with `fetch` from Node; `webContents.send('pet:state', state)`; stop on `before-quit`.
- `App.tsx`: `petRef`, `useControllablePet`; `useEffect` subscribe `window.petBridge.onState`; call `pet.motion({ type: effect.motion, replay: true })`; `pet.bubble({ id:'bigfish', description: effect.bubble.text, motion: effect.bubble.motion, timeout: 10000 })`; persist `Seen` in `localStorage`.

- [ ] **Step 4: Run tests**

Run: `cd desktop-pet && node --test --experimental-strip-types test/config.test.ts test/controller.test.ts test/poller.test.ts`
Expected: PASS（config + controller + poller）。

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/renderer/controller.ts desktop-pet/electron/poller.ts desktop-pet/electron/main.ts desktop-pet/renderer/App.tsx desktop-pet/test/controller.test.ts desktop-pet/test/poller.test.ts
git commit -m "feat(desktop-pet): 轮询与动作控制器"
```

---

### Task 7: 透明窗口、点击穿透、位置与右键动作

**Files:**
- Create: `desktop-pet/electron/window.ts`
- Create: `desktop-pet/electron/pointer.ts`
- Modify: `desktop-pet/electron/main.ts`
- Modify: `desktop-pet/renderer/App.tsx`
- Test: `desktop-pet/test/pointer.test.ts`

**Interfaces:**
- `shouldIgnoreMouse({ overPet, overUi, dragging }): boolean` — `true` = 整窗穿透；`overPet || overUi || dragging` → false。
- `clampToDisplays({ x, y, width, height }, displays, workAreaOf)` → `{ x, y }`（主屏兜底）。
- `createPetWindow()`：默认 `setIgnoreMouseEvents(true,{forward:true})`；`pointer.ts` 经 IPC `setIgnoreMouse`.
- 右键菜单：`演一个动作` 子菜单（waving/thinking/working/result/waiting/success/error）+ `隐藏/退出`。
- 位置持久化：`app.getPath('userData')/position.json`。

- [ ] **Step 1: Write failing tests**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldIgnoreMouse, clampToDisplays } from '../electron/pointer.ts'

test('身体/UI/拖拽时可交互，其余穿透', () => {
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:false, dragging:false }), true)
  assert.equal(shouldIgnoreMouse({ overPet:true, overUi:false, dragging:false }), false)
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:true, dragging:false }), false)
  assert.equal(shouldIgnoreMouse({ overPet:false, overUi:false, dragging:true }), false)
})
test('窗口位置夹到显示器工作区', () => {
  const displays = [{ x:0, y:0, width:1920, height:1080 }]
  assert.deepEqual(clampToDisplays({ x:2000, y:-50, width:400, height:260 }, displays, (d) => ({ x:d.x, y:d.y, width:d.width, height:d.height })), { x:1520, y:0 })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd desktop-pet && node --test --experimental-strip-types test/pointer.test.ts`
Expected: FAIL module missing.

- [ ] **Step 3: Implement**

- `pointer.ts`: pure functions only.
- `window.ts`: create window, restore/clamp position, save on `moved`, apply `setIgnoreMouseEvents`.
- `main.ts`: IPC `pet:ignore-mouse`; `pet:get-state` maybe; context menu via `Menu.buildFromTemplate`; `pet:action` sends IPC to renderer.
- `App.tsx`: on mousemove over pet body/UI send `overPet/overUi`; `useEffect` subscribe `window.petBridge.onAction((motion) => pet.motion({ type: motion, replay: true }))` for the context menu; click-through test.
- Do not implement physics; `dragging` always false in v1.

- [ ] **Step 4: Run tests and manual Windows check**

Run: `cd desktop-pet && node --test --experimental-strip-types test/config.test.ts test/controller.test.ts test/poller.test.ts test/pointer.test.ts`
Expected: PASS.
Manual: 透明区域点击能落到下层窗口；宠物身体点击有反应；右键菜单可选动作。

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/electron/window.ts desktop-pet/electron/pointer.ts desktop-pet/electron/main.ts desktop-pet/renderer/App.tsx desktop-pet/test/pointer.test.ts
git commit -m "feat(desktop-pet): 透明窗与点击穿透"
```

---

### Task 8: 点宠物说话（P3，可选）

**Files:**
- Modify: `desktop-pet/renderer/App.tsx`
- Modify: `desktop-pet/electron/main.ts`
- Create: `desktop-pet/renderer/chat.ts`
- Test: `desktop-pet/test/chat.test.ts`

**Interfaces:**
- `sendChat(text, { fetchImpl, timeoutMs = 90_000 } = {}): Promise<{ ok:boolean; herReply:string; note:string }>` — POST BFF `/api/fish/say` body `{text}`；超时 90s。
- `App`：`dialogue` + `onDialogue`；先 `pet.bubble({ id:'chat', title:'…', loading:true, motion:'thinking' })`，成功后 `pet.reply(reply)`，失败 `pet.bubble({ id:'chat', title:'没送到', description:note, variant:'danger', timeout:4000 })`。
- 不使用 dsh-pet 的 `/chat`。

- [ ] **Step 1: Write failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendChat } from '../renderer/chat.ts'

test('sendChat 明确区分成功/失败', async () => {
  const ok = await sendChat('在吗', { fetchImpl: async () => new Response(JSON.stringify({ ok:true, herReply:'在。', note:'' }), { status:200 }) })
  assert.deepEqual(ok, { ok:true, herReply:'在。', note:'' })
  const bad = await sendChat('在吗', { fetchImpl: async () => new Response('{}', { status:502 }) })
  assert.equal(bad.ok, false)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd desktop-pet && node --test --experimental-strip-types test/chat.test.ts`
Expected: FAIL module missing.

- [ ] **Step 3: Implement `chat.ts` and wire `onDialogue`**

- `sendChat` posts to `http://127.0.0.1:8788/api/fish/say`, `AbortController` timeout; non-2xx/throw → `{ ok:false, herReply:'', note }`.
- `App.tsx` uses `dialogue` + `onDialogue`; loading bubble `pet.bubble({ id:'chat', title:'正在想…', loading:true, motion:'thinking' })`; success `pet.reply(reply)`; failure `pet.bubble({ id:'chat', title:'没送到', description:note, variant:'danger', timeout:4000 })`.

- [ ] **Step 4: Run tests**

Run: `cd desktop-pet && node --test --experimental-strip-types test/config.test.ts test/controller.test.ts test/poller.test.ts test/pointer.test.ts test/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add desktop-pet/renderer/chat.ts desktop-pet/renderer/App.tsx desktop-pet/electron/main.ts desktop-pet/test/chat.test.ts
git commit -m "feat(desktop-pet): 点宠物和大肥鱼说话"
```

---

### Task 9: 打包、素材同步与许可

**Files:**
- Create: `desktop-pet/scripts/sync-assets.mjs`
- Create: `desktop-pet/scripts/check-assets.mjs`
- Modify: `desktop-pet/package.json`（`assets`, `dist:win` scripts）
- Create: `desktop-pet/electron-builder.yml`
- Modify: `desktop-pet/assets/ATTRIBUTION.md`

**Interfaces:**
- `sync-assets.mjs --from <dsh-pet assets/webm dir>`：只复制 `assets/config.json` 里引用的动画文件；缺失时列出名字并退出 1。
- `check-assets.mjs`：构建前检查每个 `motions` 名字都有 `.webm`；不联网。
- `electron-builder.yml`：`win.target: [portable]`，`appId: com.bigfish.desktop-pet`，`files: [dist-electron, dist-renderer, assets]`。

- [ ] **Step 1: Write failing check**

Run: `cd desktop-pet && node scripts/check-assets.mjs`
Expected: FAIL with a list of missing WebM files.

- [ ] **Step 2: Set the full test script and sync assets**

- Modify `desktop-pet/package.json` `test` to `node --test --experimental-strip-types test/config.test.ts test/controller.test.ts test/poller.test.ts test/pointer.test.ts test/chat.test.ts`.


```bash
node scripts/sync-assets.mjs --from /mnt/d/dsh-pet/package/assets/webm
node scripts/check-assets.mjs
```
Expected: `assets ok: 11 files`.

- [ ] **Step 3: Build**

Run: `cd desktop-pet && npm run build && npm run dist:win`
Expected: `desktop-pet/release/*.exe` 生成；不提交 `release/`。

- [ ] **Step 4: Commit**

```bash
git add desktop-pet/scripts desktop-pet/electron-builder.yml desktop-pet/package.json desktop-pet/assets/ATTRIBUTION.md desktop-pet/assets/config.json
git commit -m "chore(desktop-pet): 素材同步与 Windows 打包"
```

---

### Task 10: 手工验收与基线更新

**Files:**
- Modify: `src/dsh-fish/AGENTS.md`、`src/dsh-fish/README.md`（测试基线）
- Modify: `src/dsh-fish/CHANGELOG.md`（功能说明）
- Modify: `README.md`（如果根 README 有测试计数）

- [ ] **Step 1: Run all tests**

```bash
cd src/dsh-fish && node --test
cd ../../workbench && node --test
cd ../desktop-pet && npm test
```
Expected: all green；记录实际数字。

- [ ] **Step 2: Manual Windows acceptance**

1. 启动薄壳；透明、置顶、穿透正常。
2. 工作台点 7 个动作按钮；每个都能播；重复点同一动作会重播。
3. 触发 presence 评论；气泡显示原话 + 动作；同一评论不重复。
4. 关闭 8788/BFF；壳不崩溃、不刷屏；恢复后继续。
5. 拖到副屏/混合 DPI；位置正确，重启恢复。
6. 点宠物第二次打开输入框；发一句；回复显示；失败有明确提示（Task 8 已做时）。

- [ ] **Step 3: Update baselines and changelog**

把实际 `node --test` 数字写进 `src/dsh-fish/AGENTS.md` / `README.md`；`CHANGELOG.md` 增加“桌宠薄壳”条目；记录未验收项（物理/多宠物/全量素材）。

- [ ] **Step 4: Commit**

```bash
git add src/dsh-fish/AGENTS.md src/dsh-fish/README.md src/dsh-fish/CHANGELOG.md README.md
git commit -m "docs: 桌宠薄壳验收与测试基线"
```

---

## Plan Self-Review

- **Spec coverage:** 动作契约/HTTP/BFF/工作台 = Tasks 1–4；薄壳渲染/轮询/动作/穿透/说话 = Tasks 5–8；许可/打包/验收 = Tasks 9–10。Spec §5 的优先级与 TTL 在 Task 1/6；§8 的隐私/许可在 Global Constraints 与 Task 9。
- **Type consistency:** `PetState`、`Seen`、`PetAction` 在 Task 1/6 命名一致；`pet.motion`/`pet.bubble`/`pet.reply` 使用组件真实 API；`petSurfaceAllowed` 在 Task 1/3 一致。
- **Review Focus tests:** 畸形输入 Task 1/2；BFF 断线 Task 6；重复 Task 1/6；点击穿透 Task 7；非她的会话 Task 1/3。
- **Proportion:** 计划给出签名、测试断言和文件，不转写实现正文；Electron 脚手架与素材同步保留为可执行步骤。
