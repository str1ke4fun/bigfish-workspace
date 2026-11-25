# 宿主 CUA 托管模式实施计划（P0 look_window + P1 托管）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不抢前台、不置顶的前提下，让 dsh-fish 能按窗口看白名单窗口，并在工作台显式开启的 15 分钟托管窗口里对白名单窗口做后台点击/输入/按键；驱动随桌宠安装包分发，但运行时由工作台触发的 dsh-fish 持有。

**Architecture:** 工作台 `POST /api/fish/host-cua/mode` 经 8788 BFF 到 8710 `dsh-fish`；`dsh-fish` 的状态机在 `observe` 下用 PowerShell `PrintWindow` 按 HWND 抓帧，在 `managed` 下经 WSL interop `spawn` 桌宠安装包附带的 `cua-driver.exe mcp --direct`，用插件内置的最小 MCP stdio 客户端执行 5 个窄命令。桌宠只负责附带/落盘驱动、上报路径、显示状态和发“停”，不拉起进程。

**Tech Stack:** Node.js 20+、`node:test`、零依赖插件（`dsh-fish`）、PowerShell + C# `PrintWindow`、cua-driver 0.55.0 的 newline-delimited JSON-RPC MCP、Electron 43 / electron-builder、工作台零依赖 BFF。

**Spec:** `docs/superpowers/specs/2026-11-25-host-cua-architecture-design.md`

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies`、`peerDependencies`、`devDependencies` 必须始终是 `{}`；只用 Node 内置模块。
- `src/dsh-fish` 的全部测试用 `node --test`，不引测试框架；任何一条红都不提交。
- `~/.dsh-fish/events.jsonl` 只追加，不删除、不改写、不重排；本计划不新增事件类型。
- 内容粒度按应用的 `detail` 执行：`full`（树全文 + 截图）、`structure`（只留 role/frame/token，正文 label/value 脱敏，**不带截图**）、`image`（只截图，不带树）、`none`（不调用 `get_window_state`，只回窗口元数据，输入工具也拒绝）。未列出的应用走 `defaultDetail`（默认 `structure`）。
- 不增加任何人设/性格设置入口；新增配置只放环境参数（TTL、白名单、路径）。
- 面向用户的字符串不出现男字旁的“他”；不出现“三道门/四道门”。
- 所有新的外部文本入口（窗口标题、UIA 文本）必须过 `lib/guard.js` 的 `sanitizeForeign`；输入文本必须过凭据形态检查。
- v1 只允许 `delivery_mode:"background"`；任何代码路径不得传 `foreground`、不得调用 `SetForegroundWindow`、不得自动回退。
- 驱动固定 0.55.0；不提交 80MB 二进制；构建时按 SHA256 拉取；安装/首次运行时执行 `telemetry disable`。
- 工作台 BFF 只走 `workbench/fish/routes.mjs` 白名单，不新增通配转发。
- 桌宠不 spawn 驱动、不持有命令通道；`actor:"pet"` 只能关闭托管。
- 不接管现有 subagent；不暴露 `launch_app`、`kill_app`、`set_window_frame`、`run_script`、`run_steps`、剪贴板、CDP、录制回放。

## Review Focus

- **模式到期与在途动作竞态**：TTL 在工作台点“停”时恰好到期，或到期时一个 `host_click` 正在驱动里。预期：停止后不再接受新调用；在途调用最多返回一次结果并写审计，不得再发起第二次动作。
- **驱动中途退出/挂起**：`cua-driver.exe` 在 `tools/call` 途中退出或不再回包。预期：调用在超时内失败，客户端拒绝所有 pending，状态进入 `error`/`off`，不会留下永远 pending 的 Promise。
- **窗口身份在列窗口和动作之间变化**：HWND 被复用、目标应用切换、窗口被最小化。预期：每次动作前重新 `list_windows` 复核 app/pid/window_id，不匹配就拒绝，不按旧 token 硬点。
- **看起来像秘密的文本/窗口内容**：`host_type` 要输入 `sk-...`、Bearer、cookie 赋值；UIA 文本里出现 token。预期：输入被拒绝且给出人话；窗口文本被清洗/截断，不因普通代码或中文误杀。
- **`background_unavailable`**：Chromium/Electron 目标拒绝后台输入。预期：工具返回“这个窗口后台点不了”，不自动前台重试，不把失败伪装成成功。
- **内容粒度被绕过**：`structure` 级别仍带截图、非控制角色的 label/value 没脱、`none` 仍调用 `get_window_state`，或 `host_click` 在 `none` 下仍能盲点。预期：`structure` 无截图且 `text/document/edit` 的正文被替换；`none` 不发驱动调用、输入工具直接拒绝。

---

### Task 1: 托管状态机

**Files:**
- Create: `src/dsh-fish/lib/host-cua-mode.js`
- Test: `src/dsh-fish/test/host-cua-mode.test.mjs`

**Interfaces:**
- Consumes: 无（纯模块）。
- Produces:
  - `createHostCuaMode({ now = Date.now, ttlMs = 15 * 60_000, schedule = setTimeout, cancel = clearTimeout, onChange = () => {} })`
  - 返回 `{ status(), setMode({ mode, actor }), authorize(need), tick(), dispose() }`
  - `status()`：`{ mode: 'off'|'observe'|'managed', phase: 'off'|'on', since: number, expiresAt: number, remainingMs: number, actor: string, reason: string }`
  - `setMode` 返回 `{ ok: true, status }` 或 `{ ok: false, code, status }`
  - `authorize('observe'|'managed')` 返回 `{ ok: true }` 或 `{ ok: false, code }`

- [ ] **Step 1: 写失败测试**

```js
// test/host-cua-mode.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostCuaMode } from '../lib/host-cua-mode.js'

test('初始 off，工作台可开 observe 并返回到期时刻', () => {
  let t = 1000
  const m = createHostCuaMode({ now: () => t, ttlMs: 900_000, schedule: () => 1, cancel: () => {} })
  assert.equal(m.status().mode, 'off')
  const r = m.setMode({ mode: 'observe', actor: 'workbench' })
  assert.equal(r.ok, true)
  assert.equal(r.status.mode, 'observe')
  assert.equal(r.status.expiresAt, 901_000)
  assert.equal(m.authorize('observe').ok, true)
  assert.equal(m.authorize('managed').ok, false)
})

test('桌宠不能开启，只能关闭', () => {
  const m = createHostCuaMode({ schedule: () => 1, cancel: () => {} })
  assert.deepEqual(m.setMode({ mode: 'managed', actor: 'pet' }).code, 'PET_CANNOT_START')
  m.setMode({ mode: 'observe', actor: 'workbench' })
  assert.equal(m.setMode({ mode: 'off', actor: 'pet' }).ok, true)
})

test('managed 可降到 off，不可降回 observe', () => {
  const m = createHostCuaMode({ schedule: () => 1, cancel: () => {} })
  m.setMode({ mode: 'managed', actor: 'workbench' })
  assert.equal(m.setMode({ mode: 'observe', actor: 'workbench' }).code, 'MODE_DOWNGRADE')
})

test('tick 到期回到 off 并通知 onChange', () => {
  let t = 0
  const seen = []
  const m = createHostCuaMode({ now: () => t, ttlMs: 10, schedule: () => 1, cancel: () => {}, onChange: (s, why) => seen.push([s.mode, why]) })
  m.setMode({ mode: 'managed', actor: 'workbench' })
  t = 11
  m.tick()
  assert.equal(m.status().mode, 'off')
  assert.deepEqual(seen.at(-1), ['off', 'expired'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/host-cua-mode.test.mjs`
Expected: FAIL，`Cannot find module '../lib/host-cua-mode.js'`

- [ ] **Step 3: 实现 `createHostCuaMode`**

实现要点：`setMode` 只接受 `off|observe|managed`；`actor:"pet"` 且目标不是 `off` 返回 `PET_CANNOT_START`；`managed→observe` 返回 `MODE_DOWNGRADE`；每次成功切换更新 `since/expiresAt/actor/reason` 并调用 `onChange(status, reason)`；`tick()` 在 `now() >= expiresAt` 时清空到 `off`（reason `expired`）；用 `schedule` 重新武装一个 `ttlMs` 定时器并在 `dispose()` 里 `cancel`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/host-cua-mode.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/host-cua-mode.js src/dsh-fish/test/host-cua-mode.test.mjs
git commit -m "feat(dsh-fish): add host CUA authorization state machine"
```

---

### Task 2: PrintWindow 与窗口内容策略

**Files:**
- Create: `src/dsh-fish/lib/host-window.js`
- Create: `src/dsh-fish/lib/host-cua-detail.js`
- Test: `src/dsh-fish/test/host-window.test.mjs`, `src/dsh-fish/test/host-cua-detail.test.mjs`

**Interfaces:**
- Produces:
  - `DEFAULT_HOST_APPS`（`['Code.exe','WindowsTerminal.exe','notepad.exe','chrome.exe']`）
  - `DEFAULT_HOST_DENY`（`['Weixin.exe','WeChat.exe','Feishu.exe','Lark.exe','KeePass.exe','1Password.exe','Bitwarden.exe']`）
  - `isHostAppAllowed(app, { allow = DEFAULT_HOST_APPS, deny = DEFAULT_HOST_DENY } = {}) -> boolean`
  - `HOST_CUA_DETAILS = ['full','structure','image','none']`
  - `normalizeAppKey(app) -> string`（trim、去 `.exe`、转小写）
  - `resolveDetail(app, config = {}) -> 'full'|'structure'|'image'|'none'`（`config` 是 `config.hostCua`；查 `detail[app]`，未命中用 `defaultDetail`，非法值退回 `'structure'`）
  - `isStableDriverPath(winPath) -> boolean`：只接受 `\\bigfish\\host-cua\\<version>\\cua-driver.exe` 形状
  - `redactElements(elements) -> Array<{ role, label, value, frame, element_token }>`：保留 `button|tab|menuitem|checkbox|radio|link|toolbar|list|scrollbar` 的 label；其它 label 换成 `[text:N]`；所有 value 换成 `[text:N]`；frame/token 原样
  - `buildWindowListScript({ allow = DEFAULT_HOST_APPS, deny = DEFAULT_HOST_DENY } = {}) -> string`：脚本内按 allow/deny 过滤，被拒应用的标题不离开 Windows
  - `buildWindowCaptureScript({ hwnd, maxDimension = 1600 }) -> string`
  - `parseWindowList(stdout) -> { ok: true, windows: Array<{ id, pid, app, title, minimized }> } | { ok: false, code }`
  - `parseWindowCapture(stdout) -> { ok: true, app, title, width, height, buf } | { ok: false, code }`
  - `createPrintWindow({ spawn, powershellExe = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', timeoutMs = 15_000, log }) -> { list({ allow, deny }), capture(hwnd) }`
  - `winPathToWsl('C:\\Users\\ASUS\\x') -> '/mnt/c/Users/ASUS/x'`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isHostAppAllowed, parseWindowList, parseWindowCapture, winPathToWsl, buildWindowListScript,
} from '../lib/host-window.js'
import { resolveDetail, redactElements, isStableDriverPath } from '../lib/host-cua-detail.js'

test('allowlist 去掉 .exe 比较，deny 优先', () => {
  assert.equal(isHostAppAllowed('Code.exe'), true)
  assert.equal(isHostAppAllowed('code'), true)
  assert.equal(isHostAppAllowed('Weixin.exe'), false)
  assert.equal(isHostAppAllowed('explorer.exe'), false)
})

test('窗口列表只保留合法条目并截断标题', () => {
  const r = parseWindowList(JSON.stringify([
    { hwnd: 12, pid: 34, app: 'Code.exe', title: 'x'.repeat(400), minimized: false },
    { hwnd: 0, pid: 0, app: '', title: '', minimized: false },
  ]))
  assert.equal(r.ok, true)
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].id, '12')
  assert.equal(r.windows[0].title.length, 200)
})

test('坏 JSON 返回 ok:false，不抛', () => {
  assert.equal(parseWindowList('not json').ok, false)
  assert.equal(parseWindowCapture('{"ok":false,"code":"printwindow-failed"}').code, 'printwindow-failed')
})

test('Windows 路径映射到 /mnt', () => {
  assert.equal(winPathToWsl('C:\\Users\\ASUS\\AppData\\Local\\bigfish\\cua-driver.exe'), '/mnt/c/Users/ASUS/AppData/Local/bigfish/cua-driver.exe')
  assert.equal(winPathToWsl('D:\\fish\\cua-driver.exe'), '/mnt/d/fish/cua-driver.exe')
})

test('列表脚本带 allow/deny，拒绝应用的标题不离开 Windows', () => {
  const s = buildWindowListScript({ allow: ['Code.exe'], deny: ['Weixin.exe'] })
  assert.match(s, /Code\.exe/)
  assert.match(s, /Weixin\.exe/)
  assert.match(s, /IsWindowVisible/)
})

// 下面三条放 host-cua-detail.test.mjs；上面的放 host-window.test.mjs。
test('detail：显式映射优先，未列出的走 defaultDetail', () => {
  const cfg = { detail: { 'Code.exe': 'full', 'weixin.exe': 'structure' }, defaultDetail: 'structure' }
  assert.equal(resolveDetail('Code.exe', cfg), 'full')
  assert.equal(resolveDetail(' code ', cfg), 'full')
  assert.equal(resolveDetail('Weixin.exe', cfg), 'structure')
  assert.equal(resolveDetail('chrome.exe', cfg), 'structure')
  assert.equal(resolveDetail('chrome.exe', { defaultDetail: 'bogus' }), 'structure')
})

test('driver 注册路径只认稳定目录', () => {
  assert.equal(isStableDriverPath('C:\\Users\\ASUS\\AppData\\Local\\bigfish\\host-cua\\0.55.0\\cua-driver.exe'), true)
  assert.equal(isStableDriverPath('C:\\Users\\ASUS\\evil\\cua-driver.exe'), false)
  assert.equal(isStableDriverPath('/tmp/cua-driver.exe'), false)
})

test('structure 脱敏：控制角色 label 保留，正文/值替换，token 保留', () => {
  const out = redactElements([
    { role: 'button', label: '发送', value: '', frame: { x: 1 }, element_token: 's1:2' },
    { role: 'text', label: '晚上吃什么', value: '', frame: { x: 2 }, element_token: 's1:3' },
    { role: 'edit', label: '输入', value: '秘密内容', frame: { x: 3 }, element_token: 's1:4' },
  ])
  assert.equal(out[0].label, '发送')
  assert.equal(out[1].label, '[text:5]')
  assert.equal(out[2].label, '[text:2]')
  assert.equal(out[2].value, '[text:4]')
  assert.equal(out[2].element_token, 's1:4')
  assert.deepEqual(out[0].frame, { x: 1 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/host-window.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 PowerShell 脚本、解析与内容策略**

脚本要点：`SetProcessDpiAwarenessContext(-4)`；`EnumWindows` + `IsWindowVisible` + `GetWindowTextLength>0` + `GetWindowThreadProcessId` + `Process.ProcessName+'.exe'` + `GetWindowRect`；**先按传入的 allow/deny 过滤进程名，再读标题/输出**，被拒应用标题不离开 Windows；跳过 `IsIconic` 的窗口只在列表里标记 `minimized:true`。抓帧：`PrintWindow(hwnd, hdc, 2)`，画到位图后按 `maxDimension` 等比缩放，PNG 存 `MemoryStream`，输出 `{ok,app,title,width,height,png}`；失败输出 `{ok:false,code}`。所有输出只有一行 JSON，错误走 stderr。

`createPrintWindow` 用注入的 `spawn(powershellExe, ['-NoProfile','-NonInteractive','-Command', script], { windowsHide:true })`；脚本超过 Windows 命令行长度时改用 `-EncodedCommand`（UTF-16LE base64）。收集 stdout/stderr；超时 kill 并返回 `{ok:false,code:'timeout'}`；退出码非 0 返回 `{ok:false,code:'powershell-exit'}`。

`host-cua-detail.js` 是纯模块：`normalizeAppKey` 去空白、去 `.exe`、转小写；`resolveDetail` 先按规范化 key 查 `config.detail`，未命中用 `config.defaultDetail`，非法值退回 `'structure'`；`isStableDriverPath` 只匹配 `\\bigfish\\host-cua\\<version>\\cua-driver.exe`（大小写不敏感）；`redactElements` 按角色保留控制标签，其余 label 和所有 value 换成 `[text:<字符数>]`，frame/token 不动。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/host-window.test.mjs test/host-cua-detail.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/host-window.js src/dsh-fish/lib/host-cua-detail.js src/dsh-fish/test/host-window.test.mjs src/dsh-fish/test/host-cua-detail.test.mjs
git commit -m "feat(dsh-fish): add PrintWindow capture and host content policy"
```

---

### Task 3: `look_window` 工具

**Files:**
- Create: `src/dsh-fish/lib/look-window.js`
- Test: `src/dsh-fish/test/look-window.test.mjs`

**Interfaces:**
- Consumes: `createHostCuaMode` 的 `authorize`；`createPrintWindow` 的 `{ list(), capture() }`；`resolveDetail`；`sanitizeForeign`（guard.js）；`saveImage(root, buf, { prefix })`；`registerTool(ctx, def)`；`toJsonSchema`。
- Produces: `registerLookWindow(ctx, { mode, printWindow, root, config, saveImage = defaultSaveImage, log }) -> disposer`
- 工具参数：`{ windowId?: string, app?: string }`
- 工具输出：`{ ok, windows?, path?, app?, title?, width?, height?, detail?, code?, message? }`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerLookWindow } from '../lib/look-window.js'

function fakeCtx() {
  const defs = new Map()
  return { defs, ctx: { tools: { register: (d) => { defs.set(d.name, d); return () => {} } } } }
}

test('没授权时拒绝，并给人话', async () => {
  const { ctx, defs } = fakeCtx()
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: false, code: 'HOST_CUA_OFF' }) },
    printWindow: {}, root: '/tmp/x', config: {},
  })
  const r = await defs.get('look_window').execute({}, {})
  assert.equal(r.ok, false)
  assert.match(defs.get('look_window').project(r).text, /托管|看窗口/)
})

test('无 windowId 时列白名单窗口', async () => {
  const { ctx, defs } = fakeCtx()
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: true }) },
    printWindow: { list: async () => ({ ok: true, windows: [
      { id: '1', pid: 2, app: 'Code.exe', title: 'a', minimized: false },
      { id: '3', pid: 4, app: 'explorer.exe', title: 'b', minimized: false },
    ] }) },
    root: '/tmp/x', config: {},
  })
  const r = await defs.get('look_window').execute({}, {})
  assert.equal(r.windows.length, 1)
  assert.equal(r.windows[0].app, 'Code.exe')
  assert.equal(r.windows[0].title, '[标题已隐藏]')
})

test('按 windowId 抓帧会落盘并返回路径', async () => {
  const { ctx, defs } = fakeCtx()
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: true }) },
    printWindow: {
      list: async () => ({ ok: true, windows: [{ id: '9', pid: 8, app: 'notepad.exe', title: 't', minimized: false }] }),
      capture: async () => ({ ok: true, app: 'notepad.exe', title: 't', width: 10, height: 10, buf: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }),
    },
    root: '/tmp/x', config: { hostCua: { apps: ['notepad.exe'], deny: [], detail: { 'notepad.exe': 'full' } } }, saveImage: async () => ({ ok: true, path: '/tmp/x/media/a.png' }),
  })
  const r = await defs.get('look_window').execute({ windowId: '9' }, {})
  assert.equal(r.ok, true)
  assert.equal(r.path, '/tmp/x/media/a.png')
  assert.equal(r.detail, 'full')
})

test('structure / none 的应用在 look_window 里不抓图', async () => {
  const { ctx, defs } = fakeCtx()
  let captured = false
  registerLookWindow(ctx, {
    mode: { authorize: () => ({ ok: true }) },
    printWindow: {
      list: async () => ({ ok: true, windows: [{ id: '9', pid: 8, app: 'Weixin.exe', title: 't', minimized: false }] }),
      capture: async () => { captured = true; return { ok: true } },
    },
    root: '/tmp/x', config: { hostCua: { apps: ['Weixin.exe'], deny: [], detail: { 'Weixin.exe': 'structure' } } },
  })
  const r = await defs.get('look_window').execute({ windowId: '9' }, {})
  assert.equal(r.ok, false)
  assert.equal(r.code, 'DETAIL_NO_IMAGE')
  assert.equal(captured, false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/look-window.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `look_window`**

执行顺序：`mode.authorize('observe')` → 无授权返回 `{ok:false, code, message}`；`printWindow.list({ allow, deny })`（列表脚本自己按 allow/deny 过滤，缺省用 `DEFAULT_HOST_APPS/DEFAULT_HOST_DENY`）；再在 JS 侧按 `isHostAppAllowed` 复核；列表里 `structure|none` 的窗口只给 `app/id/pid/minimized`，`title` 显示 `[标题已隐藏]`；其它窗口的 `title` 过 `sanitizeForeign` 单行并截 200；无 `windowId` 返回列表；`windowId` 不在过滤后的列表就返回 `WINDOW_NOT_ALLOWED`；`resolveDetail(app, config.hostCua)` 为 `structure|none` 时返回 `{ok:false, code:'DETAIL_NO_IMAGE', message:'这个应用只允许看结构/不允许看图。'}`，不调用 `capture`；`full|image` 才 `capture(Number(windowId))`，`saveImage(root, buf, {prefix:'look-window'})`，返回路径、窗口信息与 `detail`。`project` 成功时输出“看一眼：〔路径〕（用 read_image 看）”或窗口列表的人话；失败用固定短句，不抛。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/look-window.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/look-window.js src/dsh-fish/test/look-window.test.mjs
git commit -m "feat(dsh-fish): add look_window on-demand window capture"
```

---

### Task 4: 最小 MCP stdio 客户端

**Files:**
- Create: `src/dsh-fish/lib/mcp-stdio.js`
- Test: `src/dsh-fish/test/mcp-stdio.test.mjs`

**Interfaces:**
- Produces:
  - `createMcpStdioClient({ command, args = [], cwd, env = {}, spawn, requestTimeoutMs = 30_000, maxLineBytes = 32 * 1024 * 1024, onExit = () => {}, log = () => {} })`
  - 返回 `{ initialize({ clientInfo }), listTools(), callTool(name, args, { timeoutMs }), dispose(), get closed() }`
  - `initialize` 发送 `{protocolVersion:'2025-06-18', capabilities:{}, clientInfo}`，再发 `notifications/initialized`，返回 `result`。
  - `listTools()` 返回 `tools` 数组。
  - `callTool()` 返回 MCP `result` 对象。

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createMcpStdioClient } from '../lib/mcp-stdio.js'

function fakeSpawn() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {}
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {}
  child.writes = []
  child.stdin = { write: (s) => child.writes.push(JSON.parse(s.trim())), end: () => {} }
  child.kill = () => { child.killed = true }
  return { child, spawn: () => child }
}

test('initialize 后发 initialized 通知', async () => {
  const { child, spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  const p = c.initialize({ clientInfo: { name: 't', version: '0' } })
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'cua' } } }) + '\n')
  assert.equal((await p).serverInfo.name, 'cua')
  assert.equal(child.writes.at(-1).method, 'notifications/initialized')
})

test('callTool 按 id 配对，支持分片与多行', async () => {
  const { child, spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  const p = c.callTool('list_windows', {}, { timeoutMs: 1000 })
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\n'
  child.stdout.emit('data', line.slice(0, 10))
  child.stdout.emit('data', line.slice(10))
  const r = await p
  assert.equal(r.content[0].text, 'ok')
})

test('服务器请求 ping 被应答，未知方法回 -32601', async () => {
  const { child, spawn } = fakeSpawn()
  createMcpStdioClient({ command: 'x', spawn })
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }) + '\n')
  assert.deepEqual(child.writes.at(-1), { jsonrpc: '2.0', id: 99, result: {} })
})

test('子进程退出会拒绝 pending 并关闭', async () => {
  const { child, spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  const p = c.callTool('x', {}, { timeoutMs: 5000 })
  child.emit('exit', 1, null)
  await assert.rejects(p, /exited/)
  assert.equal(c.closed, true)
})

test('超时会拒绝', async () => {
  const { spawn } = fakeSpawn()
  const c = createMcpStdioClient({ command: 'x', spawn })
  await assert.rejects(c.callTool('x', {}, { timeoutMs: 10 }), /timeout/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/mcp-stdio.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现客户端**

实现要点：构造时 `spawn(command, args, { cwd, env, stdio:['pipe','pipe','pipe'], windowsHide:true })`；stdout 按 `\n` 切行，超过 `maxLineBytes` 视为协议错误并 `dispose`；`pending` Map 存 `{resolve,reject,timer}`；`#write` 用 `JSON.stringify(msg)+'\n'`；服务器请求只应答 `ping`、`resources/list`（空）、`prompts/list`（空）、`roots/list`（空），其余 `-32601`；`onExit` 在 exit/error 时调用一次；`dispose` 清 pending、`stdin.end()`、`kill('SIGTERM')`，2 秒后 `SIGKILL`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/mcp-stdio.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/mcp-stdio.js src/dsh-fish/test/mcp-stdio.test.mjs
git commit -m "feat(dsh-fish): add minimal MCP stdio client"
```

---

### Task 5: 驱动生命周期、白名单与审计

**Files:**
- Create: `src/dsh-fish/lib/host-cua.js`
- Test: `src/dsh-fish/test/host-cua.test.mjs`

**Interfaces:**
- Consumes: `createHostCuaMode`；`createMcpStdioClient`；`winPathToWsl`；`isHostAppAllowed`；`resolveDetail`；`isStableDriverPath`；`writeAtomic`/`readJson`（store）。
- Produces:
  - `createHostCua({ root, config = {}, log, now = Date.now, spawn, exists = existsSync, createClient = createMcpStdioClient })`
  - 返回 `{ status(), setMode({ mode, actor }), authorize(need), call(tool, args, { timeoutMs }), refreshRegistration({ version, exe }), petState(), dispose() }`
  - `status()`：`{ ok, mode, phase, since, expiresAt, remainingMs, driver: { connected, exe, version, pid } | null, apps: Array<{ app, detail }>, lastError }`
  - `call(tool, args)` 只在 `managed` 且驱动已连接时执行，串行队列。
  - `refreshRegistration({ version, exe })` 只接受 `\bigfish\host-cua\<version>\cua-driver.exe` 形状的稳定路径；其它路径记日志并忽略。
  - 驱动解析顺序：`config.hostCua.exe` → `~/.dsh-fish/host-cua.json`；都失败返回 `CODE:'DRIVER_NOT_FOUND'`。

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHostCua } from '../lib/host-cua.js'

function fakeClient(overrides = {}) {
  return {
    calls: [],
    pid: 123,
    async initialize() { return { serverInfo: { name: 'cua-driver', version: '0.55.0' } } },
    async listTools() { return ['list_windows', 'get_window_state', 'click', 'type_text', 'press_key'].map((name) => ({ name })) },
    async callTool(name, args) { this.calls.push([name, args]); return { content: [{ type: 'text', text: 'ok' }] } },
    dispose() { this.disposed = true },
    get closed() { return false },
    ...overrides,
  }
}

test('managed 启动驱动、required tools 缺失则 fail closed', async () => {
  let client
  const svc = createHostCua({
    root: '/tmp/host-cua-test',
    config: { hostCua: { exe: '/tmp/cua-driver.exe' } },
    exists: () => true,
    createClient: () => (client = fakeClient({ listTools: async () => [{ name: 'list_windows' }] })),
  })
  const r = await svc.setMode({ mode: 'managed', actor: 'workbench' })
  assert.equal(r.ok, false)
  assert.equal(svc.status().mode, 'off')
  assert.equal(client.disposed, true)
  assert.match(svc.status().lastError, /get_window_state|click/)
})

test('observe 不启动驱动；managed 成功后 call 转发 background', async () => {
  let client
  const svc = createHostCua({
    root: '/tmp/host-cua-test',
    config: { hostCua: { exe: '/tmp/cua-driver.exe' } },
    exists: () => true,
    createClient: () => (client = fakeClient()),
  })
  await svc.setMode({ mode: 'observe', actor: 'workbench' })
  assert.equal(client, undefined)
  await svc.setMode({ mode: 'managed', actor: 'workbench' })
  assert.equal(svc.status().mode, 'managed')
  await svc.call('click', { window_id: 1, delivery_mode: 'background' })
  assert.deepEqual(client.calls[0], ['click', { window_id: 1, delivery_mode: 'background' }])
})

test('注册文件只接受稳定目录，稳定路径会落 host-cua.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-cua-reg-'))
  try {
    const svc = createHostCua({ root, config: {}, createClient: () => fakeClient() })
    await svc.refreshRegistration({ version: '0.55.0', exe: 'C:\\Users\\ASUS\\evil\\cua-driver.exe' })
    assert.equal(await readFile(join(root, 'host-cua.json'), 'utf8').catch(() => null), null)
    await svc.refreshRegistration({ version: '0.55.0', exe: 'C:\\Users\\ASUS\\AppData\\Local\\bigfish\\host-cua\\0.55.0\\cua-driver.exe' })
    assert.match(await readFile(join(root, 'host-cua.json'), 'utf8'), /cua-driver\.exe/)
    assert.equal(svc.petState().mode, 'off')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('status.apps 带每个应用的 detail', async () => {
  const svc = createHostCua({ root: '/tmp/host-cua-test', config: { hostCua: { apps: ['Code.exe'], detail: { 'Code.exe': 'full' }, defaultDetail: 'structure' } }, createClient: () => fakeClient() })
  assert.deepEqual(svc.status().apps, [{ app: 'Code.exe', detail: 'full' }])
})

test('驱动退出会 fail closed', async () => {
  let onExit
  const svc = createHostCua({
    root: '/tmp/host-cua-test',
    config: { hostCua: { exe: '/tmp/cua-driver.exe' } },
    exists: () => true,
    createClient: ({ onExit: cb }) => { onExit = cb; return fakeClient() },
  })
  await svc.setMode({ mode: 'managed', actor: 'workbench' })
  onExit(new Error('boom'))
  assert.equal(svc.status().mode, 'off')
  assert.match(svc.status().lastError, /boom/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/host-cua.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现 `createHostCua`**

要点：
- 解析 exe：`config.hostCua.exe`（显式覆盖，信任）→ `readJson(join(root,'host-cua.json')).exe`（必须过 `isStableDriverPath`）；统一 `winPathToWsl`；`existsSync`；必须是 `cua-driver.exe`；都没有返回 `DRIVER_NOT_FOUND`。
- `status().apps`：`(config.hostCua.apps ?? DEFAULT_HOST_APPS).filter(app => isHostAppAllowed(app, { allow: config.hostCua.apps ?? DEFAULT_HOST_APPS, deny: config.hostCua.deny ?? DEFAULT_HOST_DENY })).map(app => ({ app, detail: resolveDetail(app, config.hostCua) }))`。
- `setMode('managed')`：先写 `starting`；第一次成功解析 exe 时执行一次 `spawn(exe,['telemetry','disable'])`（失败只记日志）；创建客户端 `spawn` 用 `['mcp','--direct']`、`cwd=dirname(exe)`、`env` 带 `CUA_DRIVER_TELEMETRY_ENABLED:'0'`；`initialize`；`listTools`；要求 5 个名字齐全；成功后 `mode.setMode({mode:'managed'})`、`phase:'on'`。任何一步失败：`dispose` 客户端、`mode` 回 `off`、`lastError`、返回 `{ok:false, code}`。
- `setMode('observe')`：不建客户端，`mode.setMode`。
- `setMode('off')`：dispose 客户端，`mode.setMode`。
- `onExit`：客户端退出 → 清引用、`mode.setMode({mode:'off', actor:'driver', reason:'driver-exit'})`、`lastError`。
- `call`：校验 managed、串行队列（模块内 `tail = tail.then(...)`）、超时、审计。
- `refreshRegistration`：`isStableDriverPath(exe)` 为真才写 `{version, exe, at}` 到 `root/host-cua.json`（原子写）；否则只 `log`。
- 审计：`appendAudit(root, entry)` 用 `fs.promises.appendFile` 写 `host-cua/audit-YYYY-MM-DD.jsonl`，失败只 `log` 一次。
- `petState()`：`{ mode, phase, remainingMs, driverConnected }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/host-cua.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/host-cua.js src/dsh-fish/test/host-cua.test.mjs
git commit -m "feat(dsh-fish): own cua-driver lifecycle and audit"
```

---

### Task 6: 四个托管工具

**Files:**
- Create: `src/dsh-fish/lib/host-cua-tools.js`
- Test: `src/dsh-fish/test/host-cua-tools.test.mjs`

**Interfaces:**
- Consumes: `createHostCua` 的 `call/authorize`；`saveImage`；`guard.looksLikeSecret`；`guard.sanitizeForeign`；`resolveDetail`、`redactElements`（`host-cua-detail.js`）；`registerTool`。
- Produces: `registerHostCuaTools(ctx, { hostCua, root, config, guard, log }) -> disposer`
- 工具：`host_look`、`host_click`、`host_type`、`host_key`。

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHostCuaTools } from '../lib/host-cua-tools.js'

function setup(hostCua, config = {}) {
  const defs = new Map()
  registerHostCuaTools({ tools: { register: (d) => { defs.set(d.name, d); return () => {} } } }, {
    hostCua, root: '/tmp/x', config,
    guard: { looksLikeSecret: (s) => /sk-|Bearer/.test(s), sanitizeForeign: (s) => String(s).replace(/token=\w+/g, 'token=***') },
  })
  return defs
}

test('四个工具都注册', () => {
  const defs = setup({})
  assert.deepEqual([...defs.keys()].sort(), ['host_click', 'host_key', 'host_look', 'host_type'])
})

test('click 永远传 background', async () => {
  const calls = []
  const defs = setup({ authorize: () => ({ ok: true }), call: async (n, a) => {
    calls.push([n, a])
    if (n === 'list_windows') return { structuredContent: { windows: [{ pid: 8, window_id: '9', app_name: 'notepad.exe', title: 't' }] } }
    return { content: [{ type: 'text', text: 'ok' }] }
  } })
  await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2, captureId: 's1' }, {})
  const click = calls.find(([n]) => n === 'click')
  assert.equal(click[1].delivery_mode, 'background')
  assert.equal(click[1].capture_id, 's1')
})

test('type 拒绝像秘密的文本，不转发', async () => {
  const calls = []
  const defs = setup({ authorize: () => ({ ok: true }), call: async (n, a) => { calls.push([n, a]); return {} } })
  const r = await defs.get('host_type').execute({ windowId: '9', text: 'Bearer abc' }, {})
  assert.equal(r.ok, false)
  assert.equal(calls.length, 0)
})

test('key 拒绝 win / alt+f4', async () => {
  const defs = setup({ authorize: () => ({ ok: true }), call: async () => ({}) })
  assert.equal((await defs.get('host_key').execute({ windowId: '9', key: 'l', modifiers: ['win'] }, {})).ok, false)
  assert.equal((await defs.get('host_key').execute({ windowId: '9', key: 'f4', modifiers: ['alt'] }, {})).ok, false)
})

test('background_unavailable 映射成人话且不重试', async () => {
  const calls = []
  const defs = setup({ authorize: () => ({ ok: true }), call: async (n, a) => {
    calls.push(n)
    if (n === 'list_windows') return { structuredContent: { windows: [{ pid: 8, window_id: '9', app_name: 'notepad.exe', title: 't' }] } }
    return { content: [{ type: 'text', text: 'background_unavailable' }], structuredContent: { errorCode: 'background_unavailable' } }
  } })
  const r = await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2 }, {})
  assert.equal(r.ok, false)
  assert.match(r.message, /前台/)
  assert.equal(calls.filter((n) => n === 'click').length, 1)
})

test('structure：不带截图、正文脱敏、token 保留', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n, a) => {
      calls.push([n, a])
      if (n === 'list_windows') return { structuredContent: { windows: [{ pid: 8, window_id: '9', app_name: 'Code.exe', title: 't' }] } }
      return { content: [{ type: 'image', data: 'xx' }], structuredContent: { snapshot_id: 's1', elements: [
        { role: 'button', label: '保存', value: '', frame: { x: 1 }, element_token: 's1:2' },
        { role: 'text', label: '秘密正文', value: '', frame: { x: 2 }, element_token: 's1:3' },
      ] } }
    },
  }, { hostCua: { apps: ['Code.exe'], deny: [], detail: { 'Code.exe': 'structure' } } })
  const r = await defs.get('host_look').execute({ windowId: '9' }, {})
  assert.equal(r.ok, true)
  assert.equal(r.detail, 'structure')
  assert.equal(r.path, undefined)
  assert.match(r.tree, /保存/)
  assert.doesNotMatch(r.tree, /秘密正文/)
  assert.match(r.tree, /s1:3/)
  assert.equal(r.window.title, '[标题已隐藏]')
  assert.equal(r.snapshotId, 's1')
  const lookCall = calls.find(([n]) => n === 'get_window_state')
  assert.equal(lookCall[1].include_screenshot, false)
  assert.equal(lookCall[1].tree_format, 'elements')
})

test('none：不调 get_window_state，输入工具直接拒绝', async () => {
  const calls = []
  const defs = setup({
    authorize: () => ({ ok: true }),
    call: async (n, a) => { calls.push(n); return { structuredContent: { windows: [{ pid: 8, window_id: '9', app_name: 'Weixin.exe', title: 't' }] } } },
  }, { hostCua: { apps: ['Weixin.exe'], deny: [], detail: { 'Weixin.exe': 'none' } } })
  const look = await defs.get('host_look').execute({ windowId: '9' }, {})
  assert.equal(look.ok, true)
  assert.equal(look.detail, 'none')
  assert.equal(look.path, undefined)
  assert.equal(look.tree, undefined)
  assert.ok(calls.includes('list_windows'))
  assert.ok(!calls.includes('get_window_state'))
  const click = await defs.get('host_click').execute({ windowId: '9', x: 1, y: 2 }, {})
  assert.equal(click.ok, false)
  assert.equal(click.code, 'DETAIL_NONE')
  assert.ok(!calls.some((n) => ['click', 'type_text', 'press_key'].includes(n)))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/host-cua-tools.test.mjs`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现四个工具**

要点：
- 公共前置：`hostCua.authorize('managed')`；调用 `list_windows` 复核 `window_id` 属于 allowlist 的 app；不匹配返回 `WINDOW_NOT_ALLOWED`；`detail = resolveDetail(app, config.hostCua)`。
- `host_look` 按 detail 分四支（`window.title` 先过 `sanitizeForeign` 单行；`structure|none` 的标题改成 `[标题已隐藏]`）：
  - `none`：不调 `get_window_state`，返回 `{ok:true, detail:'none', window:{id,app,title:'[标题已隐藏]'}}`。
  - `image`：`get_window_state({include_accessibility_tree:false, include_screenshot:true, max_image_dimension:1280})`；图片块 base64 → `saveImage`；返回 `{ok, path, detail:'image', snapshotId, window}`。
  - `structure`：`get_window_state({include_accessibility_tree:true, include_screenshot:false, tree_format:'elements', max_elements:200})`；`redactElements` 后渲染成 `[token] role label @ x,y wxh` 行，再截断 12000 字符；返回 `{ok, detail:'structure', tree, snapshotId, window:{ id, app, title:'[标题已隐藏]' }}`，没有 `path`。
  - `full`：`get_window_state({include_accessibility_tree:true, include_screenshot:true, max_elements:200, max_image_dimension:1280})`；图片块 base64 → `saveImage`；文本树逐行过 `sanitizeForeign`，含 `looksLikeSecret` 命中的行替换成 `[已隐去]`，再截断 12000 字符；返回 `{ok, path, tree, snapshotId, detail:'full', window}`。
- `host_click` / `host_type` / `host_key`：`detail === 'none'` 直接返回 `{ok:false, code:'DETAIL_NONE'}`，不发 `click/type_text/press_key`。
- `host_click`：只接受 `elementToken` 或 `x,y`；有 `captureId` 时原样传 `capture_id`；传 `delivery_mode:'background'`；不传 `foreground`；`structuredContent.errorCode`（或 `error_code`）或文本含 `background_unavailable` → `{ok:false, code:'BACKGROUND_UNAVAILABLE'}`。
- `host_type`：`text` 非空、长度 ≤ `config.hostCua.maxTextChars`（默认 2000）、`guard.looksLikeSecret(text)` 为真（兼容 `{hit:true}` 与布尔两种返回）则拒绝；传 background。
- `host_key`：`key` 只允许 `^[a-z0-9]+$|^(return|enter|tab|escape|space|delete|backspace|up|down|left|right|home|end|pageup|pagedown|f[0-9]{1,2})$`；`modifiers` 只允许 `ctrl|shift|alt`；拒绝 `alt+f4`、`ctrl+shift+escape`；传 background。
- `project` 全部输出人话，不贴 JSON；`structure` 投影只说“看到结构化控件，正文已隐去”，不复述被脱敏内容。
- 本轮**不**跳过全局 tool-ledger：`host_look` 的结果和 `host_type` 的 `args.text` 会按现有台账规则落盘（凭据形态仍脱敏），这是稳定期有意保留的 debug/audit 数据；README 要写明。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/host-cua-tools.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/host-cua-tools.js src/dsh-fish/test/host-cua-tools.test.mjs
git commit -m "feat(dsh-fish): add narrow managed-mode host tools"
```

---

### Task 7: 接入插件、路由、策略与桌宠状态

**Files:**
- Modify: `src/dsh-fish/lib/index.js`
- Modify: `src/dsh-fish/lib/observe.js`
- Modify: `src/dsh-fish/lib/tool-policy.js`
- Modify: `src/dsh-fish/lib/settings.js`
- Test: `src/dsh-fish/test/tool-policy.test.mjs`, `src/dsh-fish/test/observe-pet.test.mjs`, `src/dsh-fish/test/settings.test.mjs`

**Interfaces:**
- Consumes: Task 1–6 的 `createHostCua`、`createPrintWindow`、`registerLookWindow`、`registerHostCuaTools`。
- Produces: `/dsh-fish/host-cua/status`、`/dsh-fish/host-cua/mode`；`/pet/state.hostCua`；`/pet/hello` 接受 `hostCua`；策略表新增 5 个名字。

- [ ] **Step 1: 写失败测试**

```js
// tool-policy.test.mjs 追加
test('host-cua 工具进 web 面策略：look_window 常驻，输入工具在 host 组', () => {
  const always = resolveAllow({ surface: 'web', hostNames: null })
  assert.ok(always.includes('look_window'))
  assert.ok(!always.includes('host_click'))
  const cat = catalog({ surface: 'web', hostNames: null })
  for (const n of ['host_look', 'host_click', 'host_type', 'host_key']) {
    assert.equal(cat.find((e) => e.name === n)?.group, 'host')
  }
})
```

```js
// observe-pet.test.mjs 追加：用 fake hostCua 调路由
test('/host-cua/mode 把 pet 的开启挡回去，status 带上 hostCua', async () => {
  // 参照文件里现有 fake ctx/webServer 的搭法；断言 POST {mode:'managed',actor:'pet'} 返回 400，
  // GET /pet/state 的 body.hostCua 等于 fake 服务的 petState()
})
```

```js
// settings.test.mjs 追加
test('hostCua.detail 规范化：key 去 .exe/小写，非法值丢掉，默认 structure', () => {
  const cfg = normalizeConfig({ hostCua: { detail: { ' Code.exe ': 'full', 'Weixin.exe': 'bogus' }, defaultDetail: 'nope' } })
  assert.equal(cfg.hostCua.detail['code'], 'full')
  assert.equal(cfg.hostCua.detail['weixin'], undefined)
  assert.equal(cfg.hostCua.defaultDetail, 'structure')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/tool-policy.test.mjs test/observe-pet.test.mjs test/settings.test.mjs`
Expected: FAIL，缺少条目/字段

- [ ] **Step 3: 接入**

- `tool-policy.js`：`OWN_TOOL_NAMES` 增加 `look_window`、`host_look`、`host_click`、`host_type`、`host_key`；`web` 面内置表增加 `look_window`（always），`host_look/host_click/host_type/host_key`（deferred，group `'host'`）。
- `settings.js`：`hostCua` 默认 `{ ttlMs: 900000, exe: '', apps: [...DEFAULT_HOST_APPS], deny: [...DEFAULT_HOST_DENY], maxTextChars: 2000, defaultDetail: 'structure', detail: { 'Code.exe': 'full', 'WindowsTerminal.exe': 'full', 'notepad.exe': 'full', 'chrome.exe': 'full' } }`；LIMITS 增加 `hostCua.ttlMs`、`hostCua.maxTextChars`；`CONFIG_PATCH_KEYS` 加入 `hostCua`；`normalizeConfig` 里 `exe` trim、`apps/deny` 用现有 `dedupe()`、`detail` 的 key 走 `normalizeAppKey`、value 不在 `HOST_CUA_DETAILS` 的直接丢掉、`defaultDetail` 非法退回 `'structure'`、`ttlMs` 走 LIMITS 夹值。
- `index.js`：在 `logger` 后创建 `const printWindow = createPrintWindow(...)`、`const hostCua = createHostCua({ root, config, log })`；`inject` 不需要改；`disposers.push(() => hostCua.dispose())`；工具注册列表加 `registerLookWindow(ctx,{ mode: hostCua, printWindow, root, config })` 与 `registerHostCuaTools(ctx,{ hostCua, root, config, guard:{ looksLikeSecret, sanitizeForeign }, log })`；`registerObserve` 的 deps 加 `hostCua`。
- `observe.js`：`/host-cua/status` 返回 `deps.hostCua.status()`；`/host-cua/mode` 解析 body，`actor:'pet'` 且 `mode!=='off'` 返回 400；`/pet/state` 增加 `hostCua: deps.hostCua?.petState?.() ?? null`；`/pet/hello` 调 `deps.hostCua?.refreshRegistration(body.hostCua)`。

- [ ] **Step 4: 跑全套核心测试**

Run: `cd src/dsh-fish && node --test`
Expected: 全绿（含新增测试）

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/index.js src/dsh-fish/lib/observe.js src/dsh-fish/lib/tool-policy.js src/dsh-fish/lib/settings.js src/dsh-fish/test
git commit -m "feat(dsh-fish): wire host CUA mode into routes, policy, and pet state"
```

---

### Task 8: 工作台开关与状态卡

**Files:**
- Modify: `workbench/fish/routes.mjs`
- Modify: `workbench/assets/pages/pet.js`
- Test: `workbench/test/routes.test.mjs`, `workbench/test/pages.test.mjs`, `workbench/test/bff.test.mjs`（如阶段断言需要）

**Interfaces:**
- Consumes: `dsh-fish` 的 `/host-cua/status`、`/host-cua/mode`。
- Produces: 她·桌宠页的“托管模式”卡片；两个 BFF 路由。

- [ ] **Step 1: 写失败测试**

```js
// routes.test.mjs
test('host-cua 路由只开状态读与模式写', () => {
  assert.deepEqual(matchRoute('host-cua/status')?.route.methods, { GET: 'P1' })
  assert.equal(matchRoute('host-cua/mode')?.route.methods.POST, 'P2')
  assert.equal(matchRoute('host-cua/mode')?.route.sideEffect, true)
})
```

```js
// pages.test.mjs
test('桌宠页有托管模式卡，开关走 host-cua/mode', () => {
  const s = src('pet.js')
  assert.match(s, /fish\('host-cua\/status'\)/)
  assert.match(s, /postFish\('host-cua\/mode'/)
  assert.match(s, /托管/)
  assert.match(s, /15 分钟/)
  assert.match(s, /background|后台/)
  assert.match(s, /detail/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/routes.test.mjs test/pages.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

- `routes.mjs`：加两条路由，`mode` 带 `sideEffect:true`、`maxBody:64*1024`。
- `pet.js`：
  - `SPEC.hostCuaCard = card('托管模式', { note: '15 分钟后自动结束；关掉立即停止。只允许白名单应用，只做后台操作，不抢前台；每个应用能看多少由内容粒度决定。' })`；
  - 状态行显示 `mode/phase/remainingMs/driver.version`，以及 `apps.map(x => `${x.app}（${x.detail}）`)`；
  - 按钮“允许看窗口” → `postFish('host-cua/mode', { mode:'observe', actor:'workbench' })`；“开启托管” → 用状态里的 `apps.map(x => x.app)` 拼确认文案（`开启后她可以在 … 里后台点击和打字，15 分钟自动结束。继续？`），确认后 POST `{mode:'managed'}`；“立即停止” → `{mode:'off'}`；
  - `load()` 里 `fish('host-cua/status')`，失败静默；`leave()` 清定时器（沿用现有 poll）。
  - 人话不出现“他”。

- [ ] **Step 4: 跑工作台测试**

Run: `cd workbench && node --test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add workbench/fish/routes.mjs workbench/assets/pages/pet.js workbench/test
git commit -m "feat(workbench): add managed-mode control card"
```

---

### Task 9: 桌宠附带驱动、稳定落盘与 hello 上报

**Files:**
- Create: `desktop-pet/scripts/fetch-host-cua.mjs`
- Create: `desktop-pet/electron/host-cua.ts`
- Modify: `desktop-pet/electron/main.ts`
- Modify: `desktop-pet/electron-builder.yml`
- Modify: `desktop-pet/package.json`
- Modify: `desktop-pet/.gitignore`（若不存在则创建）
- Test: `desktop-pet/test/host-cua.test.ts`

**Interfaces:**
- Produces:
  - `HOST_CUA_VERSION = '0.55.0'`
  - `resolveInstallTarget({ localAppData, version }) -> string`
  - `installBundledHostCua({ bundledDir, localAppData, copyDir, exists, readManifest }) -> Promise<{ ok, exe?, version?, code? }>`
  - `toHelloPayload(version, skins, actions, hostCua)` 增加 `hostCua` 字段。

- [ ] **Step 1: 写失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveInstallTarget, installBundledHostCua } from '../electron/host-cua.ts'

test('安装目录按版本稳定，不落在 portable 解压目录', () => {
  assert.equal(resolveInstallTarget({ localAppData: 'C:\\Users\\ASUS\\AppData\\Local', version: '0.55.0' }),
    'C:\\Users\\ASUS\\AppData\\Local\\bigfish\\host-cua\\0.55.0')
})

test('已有 exe 时幂等；缺 manifest 时明确失败', async () => {
  const r1 = await installBundledHostCua({ bundledDir: 'b', localAppData: 'l', exists: (p) => p.endsWith('cua-driver.exe'), readManifest: async () => ({ version: '0.55.0' }), copyDir: async () => { throw new Error('should not copy') } })
  assert.equal(r1.ok, true)
  const r2 = await installBundledHostCua({ bundledDir: 'b', localAppData: 'l', exists: () => false, readManifest: async () => null, copyDir: async () => {} })
  assert.equal(r2.ok, false)
  assert.equal(r2.code, 'manifest-missing')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（Windows）: `cd desktop-pet && node --test --experimental-strip-types test/host-cua.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现拉取与安装**

- `fetch-host-cua.mjs`：下载 `https://registry.npmjs.org/dsh-cua-driver/-/dsh-cua-driver-0.1.2.tgz`，校验 SHA256 `0a3a46c6e84006444c34122a5600d1f53c240087f94589d3beb26b776c7b20d3`；用 `tar` 解出 `package/vendor/cua-driver-rs-0.55.0-windows-x86_64/*` 到 `desktop-pet/host-cua/`；写 `manifest.json`（`{version:'0.55.0', source, sha256}`）；已存在且版本一致时跳过。
- `.gitignore` 加 `host-cua/`。
- `electron-builder.yml`：`extraResources: [{ from: 'host-cua', to: 'host-cua' }]`。
- `package.json`：`"host-cua:fetch": "node scripts/fetch-host-cua.mjs"`；`dist:win` 先跑 fetch。
- `host-cua.ts`：`installBundledHostCua` 先读 `manifest.json`，确认 bundled exe 存在；若目标 `cua-driver.exe` 已存在直接返回；否则 `fs.cp(bundledDir, temp, {recursive:true})`，再 `fs.rename(temp, target)`；**只复制文件，不执行驱动命令**（遥测关闭由 dsh-fish 第一次启动时做）。
- `main.ts`：`app.whenReady()` 后在后台发起安装（`void install...`，不阻塞窗口创建）；`localAppData` 取 `process.env.LOCALAPPDATA`（缺失时退回 `app.getPath('userData')` 的父目录）；安装完成且 `ok:true` 才让 `toHelloPayload` 带 `hostCua`。
- `toHelloPayload(version, skins, actions, hostCua)` 的签名变更；更新所有调用与测试。

- [ ] **Step 4: 跑桌宠测试与构建**

Run（Windows）: `cd desktop-pet && node --test`
Expected: 全绿
Run（Windows）: `npm run host-cua:fetch && npm run build`
Expected: `host-cua/manifest.json` 与构建产物存在；`desktop-pet/release/win-unpacked/resources/host-cua/cua-driver.exe` 存在

- [ ] **Step 5: 提交**

```bash
git add desktop-pet/scripts/fetch-host-cua.mjs desktop-pet/electron/host-cua.ts desktop-pet/electron/main.ts desktop-pet/electron-builder.yml desktop-pet/package.json desktop-pet/.gitignore desktop-pet/test/host-cua.test.ts
git commit -m "feat(desktop-pet): ship cua-driver into a stable install dir"
```

---

### Task 10: 桌宠托管指示与停止

**Files:**
- Modify: `desktop-pet/electron/main.ts`
- Modify: `desktop-pet/renderer/controller.ts`
- Modify: `desktop-pet/renderer/App.tsx`
- Modify: `desktop-pet/renderer/styles.css`
- Test: `desktop-pet/test/controller.test.ts`, `desktop-pet/test/shell.test.ts`

**Interfaces:**
- Consumes: `/pet/state.hostCua`；`POST /api/fish/host-cua/mode`。
- Produces: `readHostCua(state) -> { mode, phase, remainingMs, driverConnected } | null`；托盘菜单“托管模式：开/关”“停止托管”；渲染层一个常驻小标记 `host-cua-badge`。

- [ ] **Step 1: 写失败测试**

```ts
test('pet state 解析出 hostCua，缺字段不炸', () => {
  assert.equal(readHostCua({ hostCua: { mode: 'managed', phase: 'on', remainingMs: 1000, driverConnected: true } }).mode, 'managed')
  assert.equal(readHostCua({}), null)
})
```

```ts
test('桌宠源码有停止托管调用，不包含启动调用', () => {
  const s = readFileSync(join(import.meta.dirname, '../electron/main.ts'), 'utf8')
  assert.match(s, /host-cua\/mode/)
  assert.match(s, /mode:\s*'off'/)
  assert.doesNotMatch(s, /mode:\s*'managed'/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run（Windows）: `cd desktop-pet && node --test --experimental-strip-types test/controller.test.ts test/shell.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

- `main.ts`：从 `/pet/state` 读 `hostCua`，缓存；菜单模型加一项只读状态 + “停止托管”。点击时 POST `http://127.0.0.1:8788/api/fish/host-cua/mode` `{mode:'off',actor:'pet'}`，超时 5s，失败不弹窗。
- `controller.ts`：`PetState` 增加 `hostCua`；`readHostCua` 校验 `mode ∈ off|observe|managed`。
- `App.tsx`：`hostCua.mode !== 'off'` 时渲染 `<div className="host-cua-badge">托管中</div>`，`title` 显示剩余分钟；不改变动作/气泡逻辑。
- `styles.css`：右上角小圆点/文字，半透明，`pointer-events:none`，不遮挡拖拽。

- [ ] **Step 4: 跑测试**

Run（Windows）: `cd desktop-pet && node --test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add desktop-pet/electron/main.ts desktop-pet/renderer/controller.ts desktop-pet/renderer/App.tsx desktop-pet/renderer/styles.css desktop-pet/test
git commit -m "feat(desktop-pet): show managed mode and stop control"
```

---

### Task 11: 文档、版本与全量验证

**Files:**
- Modify: `src/dsh-fish/CHANGELOG.md`
- Modify: `src/dsh-fish/README.md`
- Modify: `desktop-pet/README.md`
- Modify: `workbench/README.md`
- Modify: `src/dsh-fish/lib/index.js`（`VERSION` 从 `0.9.0` 提到 `0.9.1`）

- [ ] **Step 1: 写文档**

- `dsh-fish/README.md`：新增“宿主托管”一节：工作台入口、白名单、15 分钟、后台 only、驱动来源、日志位置、按应用的 `detail` 粒度（full/structure/image/none）；写明 host-cua 调用会进本地 tool-ledger、`/backup` 会带走，`/log/export` 不含台账内容。
- `desktop-pet/README.md`：新增“附带的 host-cua”：拉取命令、安装位置、不启动进程、hello 上报。
- `workbench/README.md`：BFF 新增两条路由，页面卡片说明内容粒度。
- `CHANGELOG.md`：`0.9.1` 条目，列出 P0/P1、安全边界、内容粒度、未做项。

- [ ] **Step 2: 全量测试**

Run: `cd src/dsh-fish && node --test`
Expected: 全绿
Run: `cd workbench && node --test`
Expected: 全绿
Run（Windows）: `cd desktop-pet && node --test`
Expected: 全绿

- [ ] **Step 3: 暂存 diff 与凭据检查**

Run: `git diff --cached --check`（暂存后）
Run: `python scripts/audit-staged.py`
Expected: 无凭据告警；若报警必须查明原因

- [ ] **Step 4: 提交**

```bash
git add src/dsh-fish/CHANGELOG.md src/dsh-fish/README.md src/dsh-fish/lib/index.js desktop-pet/README.md workbench/README.md
git commit -m "docs: document host CUA managed mode"
```

---

## 已拍板：tool-ledger 先保留

- 本轮**不**给 `createToolLedger` 传 `skipTools`；host-cua 的调用继续进全局工具台账，用于 debug 与审计。
- 已知代价：`host_look` 的 `full` UIA 树、`host_type` 的 `args.text` 会落 `tool-ledger/`（大结果进 `artifacts/`），并随 `/backup` 导出；现有脱敏只覆盖 `sk-`/cookie/token 这类凭据形态，普通私密文字会保留。
- 这是**有意保留的稳定期取舍**：先保证能排查“她到底点了什么、看到了什么”，等托管稳定后再收缩。
- 后续收缩按当时证据选 A（5 个工具整体跳过）或 B（按工具脱敏为 `{chars, sha256}`）；无论选哪个，都要给台账加对应钩子并补测试。
- Task 11 的 README/CHANGELOG 要写明：当前 host-cua 调用会进本地台账，`/backup` 会带走；`/log/export` 不含台账内容。

## Self-Review

- **Spec coverage**：P0 `look_window`（Task 2–3）、P1 状态机（Task 1）、驱动分发（Task 9）、驱动生命周期（Task 5）、窄工具与内容粒度（Task 2/6）、工作台触发（Task 8）、桌宠指示/停止（Task 10）、审计（Task 5）、安全边界（Task 4–6 Review Focus）、文档（Task 11）。DSH MCP 只在技术验证计划里，不在生产代码。
- **Step scan**：每个任务的首步是一个具体失败测试；代码步给签名与固定值；没有“TBD/适当处理”类步骤。
- **Type consistency**：`setMode({mode,actor})`、`authorize(need)`、`call(tool,args,{timeoutMs})`、`petState()` 在 Task 1/5/6/7/10 中名称一致；`resolveDetail`/`redactElements` 在 Task 2/3/6 中签名一致；`look_window` 的 `windowId` 是字符串，驱动层再转数字。
- **Review Focus**：6 条都在测试里有对应（Task 5 的 exit/超时、Task 6 的 background_unavailable/secret/key/内容粒度、Task 3/6 的 allowlist 复核、Task 1 的到期竞态）。
- **Proportion**：计划给出接口与断言，不抄实现正文；C#/PowerShell 只规定行为与输出形状。
