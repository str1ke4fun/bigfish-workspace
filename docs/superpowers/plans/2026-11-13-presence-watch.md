# 大肥鱼陪伴面 v1 Implementation Plan

> **2026-11-13 落地回写**：本文件与合并稿冲突的段落，以 `docs/superpowers/specs/2026-11-13-new-round-merged-requirements.md` §2 为准。
> 关键差异：D1 UI 落 8788（不改 8710 client.js）；D2 schema v4 同时加 screen；D5 recall 边界（owner facts 仅 web/wx/screen、非 owner Phase 1 不召回、screen 排除 web 事件）；D6 fish:owner 预算 facts 300 / extras 400 / 总 700；D10 absenceDays 回来即 0；D12 browsejob 测试在 dsh-bili；D17 B 站用 s.ctime 且先判 isOwner；D26 收盘报告失败不落完成标记；D27 presence 0 也写、启动补写；D30 v4 事件后不降级；D32 /memory people/contacts/closing 合并响应。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让大肥鱼在用户打开开关时，低频看游戏整屏或工作白名单窗口，在值得说的时候说一句，并把「他正在做什么」作为易失上下文提供给她的主会话。

**Architecture:** 新增 `screen` 面和独立小会话；`host-capture` 负责 Windows ffmpeg `ddagrab` 抓帧（游戏整屏 / 工作裁剪窗口），`foreground` 负责 per-monitor DPI 下的前台窗口与显示器映射，`screen` 负责模式状态机、事件闸门、冷却与 provider，`presence_speak` 是唯一输出工具。评论进 presence 台账，一局结束只写一条 `meta presence:<dk>`。

**Tech Stack:** Node.js 20+，零 npm 依赖；`node:test`；Windows ffmpeg 9.x（`ddagrab`）；PowerShell 5.1 interop；`fishCore.context`（人物记忆线 Phase 3 提供，缺席时 no-op）。

**Spec:** `docs/superpowers/specs/2026-11-13-presence-watch-design.md`

## Global Constraints

- `dependencies` / `peerDependencies` / `devDependencies` 必须永远是 `{}`；测试只用 `node:test` + `node:assert`。
- `events.jsonl` 只能追加；屏幕内容、窗口标题、OCR 文本不得写入；评论只进 `~/.dsh-fish/presence/YYYY-MM-DD.jsonl`。
- 三个模式默认关；全局 `presence.enabled` 为 false 时任何模式都不能启动；关闭后 1 秒内停止采集。
- 工作模式只采前台 allowlist 窗口矩形；`Feishu.exe` / `Lark.exe` / `Weixin.exe` / `WeChat.exe` 硬性 denylist，deny 优先。
- 前台窗口/显示器坐标必须用 `SetProcessDpiAwarenessContext(-4)`（per-monitor V2）；否则副屏 150% 缩放会报错并裁错。
- 不改 `identity.js` / `selfdoc.js` 的全局身份文档；不改 `crossChannel` 去引用化；不新增事件类型（schema v4 由人物记忆线负责）。
- `screen` 是 surface 不是 channel；presence 会话 channel 仍按 cwd 推断为 `web`。
- 界面文案不出现男字旁的「他」，不出现「三道门 / 四道门」；用「你」。
- 模型不能自主开启截屏；只有用户点击开关。

## Review Focus

- **副屏 DPI 缩放**：前台窗口在 150% 缩放的副屏时，若 watcher 不是 per-monitor V2，窗口矩形会变成 2880×1620 而 ddagrab 输出是 1920×1080，裁剪切出错误区域或直接失败。测在 `foreground.test.mjs` 与 T4。
- **切到飞书/微信**：前台切换后必须在下一帧前停止采集；不能把最后一帧保存或发给模型。测在 `screen.test.mjs`。
- **跨屏/最小化窗口**：窗口横跨两块屏或最小化时，裁剪必须夹到重叠最大的一块显示器，不能崩溃或产生越界 crop。测在 `foreground.test.mjs`。
- **没有 Windows ffmpeg / 没有 interop**：模式要明确失败并给出 note，不能静默成功或留下半启动状态。测在 `host-capture.test.mjs` / `screen.test.mjs`。
- **停止与竞态**：关闭/切模式/自动停止时，采集子进程必须退出，不能有下一次候选或重叠的模型轮次。测在 `screen.test.mjs`。

---

### Task 1: `screen` 面与 `presence_speak` 策略

**Files:**
- Modify: `src/dsh-fish/lib/surface.js`
- Modify: `src/dsh-fish/lib/tool-policy.js`
- Test: `src/dsh-fish/test/surface.test.mjs`
- Test: `src/dsh-fish/test/tool-policy.test.mjs`
- Test: `src/dsh-fish/test/tool-policy-contribute.test.mjs`
- Test: `src/dsh-fish/test/tools.test.mjs`
- Test: `src/dsh-fish/test/restrict.test.mjs`

**Interfaces:**
- Consumes: 现有 `createSurfaceRegistry`、`resolveAllow`、`OWN_TOOL_NAMES`、`BUILTIN`。
- Produces: `SURFACES` 含 `'screen'`；`resolveAllow({surface:'screen',caps:{hasImageRoute:true}})` 返回 `read_image`、`presence_speak`、`her_recall`；`OWN_TOOL_NAMES` 含 `presence_speak`。

- [ ] **Step 0: 与人物记忆线对齐**

把本任务要加的 `SURFACES` / `BUILTIN` 条目发给 `bigfish-workspace-63`（SendMessage），确认不与 schema v4 冲突。对方 Phase 1–2 不改 `surface.js` / `tool-policy.js`；Phase 3 把 `screen` 加进 `fish:owner.surfaces`。收到确认前不要改这两个文件。

- [ ] **Step 1: 写失败测试**

在 `test/surface.test.mjs` 加：

```js
test('screen 面可以 reserve，current 返回 screen', () => {
  const r = createSurfaceRegistry()
  r.reserve('screen-1', 'screen')
  assert.equal(r.current(agent('screen-1')), 'screen')
})
```

在 `test/tool-policy.test.mjs` 加：

```js
test('screen 面只给 read_image / presence_speak / her_recall', () => {
  const names = resolveAllow({ surface: 'screen', caps: { hasImageRoute: true } })
  assert.deepEqual(new Set(names), new Set(['read_image', 'presence_speak', 'her_recall']))
  const web = resolveAllow({ surface: 'web', caps: { hasImageRoute: true } })
  assert.equal(web.includes('presence_speak'), false)
})
```

同时把 `test/tool-policy-contribute.test.mjs` 的 `OWN_TOOL_NAMES.length` 从 7 改为 8；把 `test/tools.test.mjs` 的完整工具清单和 `test/restrict.test.mjs` 的精确断言补上 `presence_speak`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/surface.test.mjs test/tool-policy.test.mjs test/tool-policy-contribute.test.mjs test/tools.test.mjs test/restrict.test.mjs`
Expected: FAIL（`screen` 未知 / `presence_speak` 不存在 / 数量断言不符）。

- [ ] **Step 3: 实现**

`surface.js`：`export const SURFACES = ['web', 'wx', 'qq', 'bili', 'screen']`。

`tool-policy.js`：

```js
export const SURFACES = Object.freeze(['web', 'wx', 'qq', 'bili', 'screen'])

export const OWN_TOOL_NAMES = Object.freeze([
  'growth_commit', 'her_recall', 'her_leave', 'her_remind',
  'her_reminders', 'her_remind_cancel', 'her_inbox',
  'presence_speak',
])

function screenEntries() {
  const s = 'screen'
  return [
    tool('read_image', s, ALWAYS, '', '看一张图', 'read', ['hasImageRoute']),
    tool('presence_speak', s, ALWAYS, '', '看屏幕时说一句', 'write'),
    tool('her_recall', s, ALWAYS, '', '翻自己的旧事和记忆', 'read'),
  ]
}

const BUILTIN = Object.freeze([
  ...coreEntries('web'),
  ...screenEntries(),
  ...coreEntries('wx'),
  ...wxAlways(),
  ...coreEntries('qq'),
  ...qqDeferred(),
  ...coreEntries('bili'),
])
```

不要给 `screen` 面加 `growth_commit` / `her_leave` / `her_tools`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/surface.test.mjs test/tool-policy.test.mjs test/tool-policy-contribute.test.mjs test/tools.test.mjs test/restrict.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/surface.js src/dsh-fish/lib/tool-policy.js src/dsh-fish/test/surface.test.mjs src/dsh-fish/test/tool-policy.test.mjs src/dsh-fish/test/tool-policy-contribute.test.mjs src/dsh-fish/test/tools.test.mjs src/dsh-fish/test/restrict.test.mjs
git commit -m "feat(dsh-fish): 增加 screen 面与 presence_speak 策略"
```

---

### Task 2: `presence_speak` 工具

**Files:**
- Create: `src/dsh-fish/lib/presence-speak.js`
- Modify: `src/dsh-fish/lib/index.js`
- Test: `src/dsh-fish/test/presence-speak.test.mjs`

**Interfaces:**
- Consumes: `core.surface.current(agent)`；`screen.currentMode()`、`screen.canSpeak()`、`screen.recordComment({ text, at, mode, event })`。
- Produces: `registerPresenceSpeak(ctx, { root, core, screen, log })`，注册工具名 `presence_speak`，参数 `{ text: string }`。

- [ ] **Step 1: 写失败测试**

用假 `ctx.tools.register` 捕获工具定义，假 `screen`：

```js
test('presence_speak 只在 screen 面可用', async () => {
  const def = captureRegistered((ctx) => registerPresenceSpeak(ctx, { root, core, screen }))
  const exec = { agent: { session: { header: { cwd: '/root/home/screen' } } } }
  const r = await def.execute({ text: '这一下有点意思。' }, exec)
  assert.equal(r.ok, true)
  assert.equal(screen.comments.length, 1)
})

test('非 screen 面拒绝，超长/冷却拒绝，且不写台账', async () => {
  const def = captureRegistered((ctx) => registerPresenceSpeak(ctx, { root, core, screen }))
  const webExec = { agent: { session: { header: { cwd: '/root/home' } } } }
  core.surface.current = () => 'web'
  assert.deepEqual(await def.execute({ text: '好' }, webExec), {
    ok: false, code: 'NOT_SCREEN', message: '这里不是说这个的地方。',
  })

  core.surface.current = () => 'screen'
  assert.equal((await def.execute({ text: 'x'.repeat(121) }, screenExec)).code, 'TOO_LONG')
  screen.canSpeak = () => ({ ok: false, why: 'cooldown' })
  assert.equal((await def.execute({ text: '好' }, screenExec)).code, 'PRESENCE_COOLDOWN')
  assert.equal(screen.comments.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/presence-speak.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`presence-speak.js`：

```js
import { defineTool } from './tool.js'
import { registerTool } from './tool-result.js'
import { toJsonSchema } from './toolschema.js'

export function registerPresenceSpeak(ctx, { core, screen, log } = {}) {
  return registerTool(ctx, defineTool({
    name: 'presence_speak',
    description: '你在陪他看屏幕。只有真的觉得这一刻值得说，才用这个工具说一句；不想说就不要调用。',
    parameters: toJsonSchema({
      text: { type: 'string', required: true, description: '一句话，120 字以内。不要复述屏幕上的文字。' },
    }),
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true } },
    project: (out) => ({ text: out?.ok ? '[说下了]' : `[没说：${out?.message ?? ''}]` }),
    async execute(args, exec) {
      const surface = core?.surface?.current?.(exec?.agent)
      if (surface !== 'screen') return { ok: false, code: 'NOT_SCREEN', message: '这里不是说这个的地方。' }
      const text = String(args?.text ?? '').trim()
      if (!text) return { ok: false, code: 'EMPTY', message: '没说话。' }
      if (text.length > 120) return { ok: false, code: 'TOO_LONG', message: '太长，短一点。' }
      const gate = screen?.canSpeak?.()
      if (gate && gate.ok === false) return { ok: false, code: 'PRESENCE_COOLDOWN', message: '现在先别说。' }
      const r = await screen.recordComment({ text, at: new Date().toISOString(), mode: screen.currentMode() })
      return r?.ok ? { ok: true } : { ok: false, code: 'PRESENCE_WRITE_FAILED', message: '没记下来。' }
    },
  }))
}
```

`index.js` 的工具注册循环里加：

```js
() => registerPresenceSpeak(ctx, { root, core: fishCore, screen, log: (...a) => logger.warn(...a) }),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/presence-speak.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/presence-speak.js src/dsh-fish/lib/index.js src/dsh-fish/test/presence-speak.test.mjs
git commit -m "feat(dsh-fish): 注册 presence_speak 输出工具"
```

---

### Task 3: `host-capture` 抓帧流

**Files:**
- Create: `src/dsh-fish/lib/host-capture.js`
- Test: `src/dsh-fish/test/host-capture.test.mjs`

**Interfaces:**
- Consumes: `node:child_process.spawn`（可注入）。
- Produces:
  - `buildDdagrabArgs({ outputIdx, fps, crop, mode, scaleWidth = 1280 })` → `string[]`
  - `parseJpegStream(readable, onFrame)` → `() => void`
  - `parseCaptureStderr(line)` → `{ yavg?, scene?, freeze?: 'start'|'end' } | null`
  - `detectHostCapture({ ffmpegExe, powershellExe })` → `{ ok, backend: 'ddagrab'|null, ffmpegExe, why }`
  - `startFrameStream({ spawn, ffmpegExe, outputIdx, fps, crop, mode, scaleWidth, onFrame, onEvent, onError, log })` → `{ stop(): Promise<void>, pid }`

- [ ] **Step 1: 写失败测试**

```js
test('buildDdagrabArgs 生成整屏参数', () => {
  assert.deepEqual(buildDdagrabArgs({ outputIdx: 1, fps: 0.2, mode: 'ambient' }), [
    '-hide_banner', '-loglevel', 'error', '-init_hw_device', 'd3d11va',
    '-f', 'lavfi', '-i', 'ddagrab=output_idx=1:framerate=0.2',
    '-vf', 'hwdownload,format=bgra,scale=1280:-2',
    '-q:v', '4', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-',
  ])
})

test('parseJpegStream 按 SOI/EOI 切出两帧，跨 chunk 不丢', async () => {
  const { Readable } = await import('node:stream')
  const frames = []
  const s = Readable.from([Buffer.from([0xff, 0xd8, 1]), Buffer.from([2, 0xff, 0xd9, 0xff, 0xd8, 3, 0xff, 0xd9])])
  parseJpegStream(s, (b) => frames.push(b.length))
  await new Promise((r) => s.on('end', r))
  assert.deepEqual(frames, [6, 4])
})

test('parseCaptureStderr 认 YAVG/scene/freeze', () => {
  assert.deepEqual(parseCaptureStderr('lavfi.signalstats.YAVG=44.8'), { yavg: 44.8 })
  assert.deepEqual(parseCaptureStderr('lavfi.scene_score=0.31'), { scene: 0.31 })
  assert.deepEqual(parseCaptureStderr('freeze_start: 1.2'), { freeze: 'start' })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/host-capture.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

关键点：

- `buildDdagrabArgs`：`crop` 存在时 `vf` 加 `crop=${w}:${h}:${x}:${y},`；`mode === 'event'` 时在 `select` 前后加 `freezedetect=n=0.003:d=${freezeSeconds}` 与 `select='gt(scene,${sceneThreshold})'`；`hospital` 不需要。
- `parseJpegStream`：用 Buffer 累积，找 `FF D8` 起点和 `FF D9` 终点；每次切出完整 JPEG 调 `onFrame(buf)`；`stream.on('error')` 只转发不抛。
- `parseCaptureStderr`：正则匹配 `YAVG=`、`scene_score=`、`freeze_start` / `freeze_end`。
- `startFrameStream`：`spawn(ffmpegExe, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] })`；stdout 走 `parseJpegStream`；stderr 按行解析并 `onEvent`；`child.on('error')` / 非零退出 → `onError({ok:false, why})`。
- `stop()`：先 `child.kill()`，1 秒后仍未退出再 `child.kill('SIGKILL')`；幂等。
- `detectHostCapture({ ffmpegExe })`：`fs.access` + 一次 `-hide_banner -h filter=ddagrab` 探测；返回 `{ok, backend, why}`。没有 ffmpeg 时 `ok:false`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/host-capture.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/host-capture.js src/dsh-fish/test/host-capture.test.mjs
git commit -m "feat(dsh-fish): 增加 ddagrab 抓帧流"
```

---

### Task 4: `foreground` 前台窗口与裁剪

**Files:**
- Create: `src/dsh-fish/lib/foreground.js`
- Test: `src/dsh-fish/test/foreground.test.mjs`

**Interfaces:**
- Produces:
  - `pickMonitor(rect, monitors)` → `{ index, monitor }`
  - `cropForWindow(rect, monitor)` → `{ w, h, x, y }`
  - `isAllowed(name, allow, deny)` → `boolean`
  - `buildForegroundScript({ intervalMs })` → `string`
  - `parseForegroundSample(line)` → `{ hwnd, pid, name, rect, monitors } | null`
  - `startForegroundWatcher({ spawn, powershellExe, intervalMs, onSample, onError, log })` → `{ stop(): Promise<void> }`

- [ ] **Step 1: 写失败测试**

```js
const monitors = [
  { device: 'DISPLAY1', primary: true, x: 0, y: 0, w: 2560, h: 1600 },
  { device: 'DISPLAY2', primary: false, x: -1920, y: 509, w: 1920, h: 1080 },
]

test('跨屏窗口取重叠最大的显示器并夹紧 crop', () => {
  const rect = { left: -1931, top: 498, right: 11, bottom: 1552 }
  const { index, monitor } = pickMonitor(rect, monitors)
  assert.equal(index, 1)
  assert.deepEqual(cropForWindow(rect, monitor), { w: 1920, h: 1054, x: 0, y: 0 })
})

test('deny 优先且大小写不敏感', () => {
  assert.equal(isAllowed('Code.exe', ['code.exe'], ['weixin.exe']), true)
  assert.equal(isAllowed('Weixin.exe', ['weixin.exe'], ['weixin.exe']), false)
  assert.equal(isAllowed('unknown.exe', ['code.exe'], []), false)
})

test('前台脚本含 per-monitor V2，且不含 EncodedCommand', () => {
  const s = buildForegroundScript({ intervalMs: 2000 })
  assert.match(s, /SetProcessDpiAwarenessContext/)
  assert.doesNotMatch(s, /EncodedCommand|WindowStyle Hidden/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/foreground.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

- `pickMonitor`：用窗口中心点命中；否则按矩形与各显示器重叠面积取最大。
- `cropForWindow`：`x = max(0, rect.left - monitor.x)`、`y = max(0, rect.top - monitor.y)`、`w = min(rect.right - rect.left, monitor.w - x)`、`h = min(rect.bottom - rect.top, monitor.h - y)`；`w/h <= 0` 返回 `{w:0,h:0,x:0,y:0}`，调用方跳过。
- `isAllowed`：进程名小写、去 `.exe` 后比较；deny 集合优先。
- `buildForegroundScript`：内联 PowerShell，先 `SetProcessDpiAwarenessContext(-4)`，再 `Add-Type -AssemblyName System.Windows.Forms`，循环输出 JSON 行（`hwnd,pid,name,left,top,right,bottom,monitors`）；`Start-Sleep -Milliseconds interval`。不要 `-EncodedCommand`、不要隐藏窗口。
- `startForegroundWatcher`：`spawn(powershellExe, ['-NoProfile','-NonInteractive','-Command', script], { windowsHide:true })`；stdout 按行 `parseForegroundSample`；`stop()` kill 并等待。
- 只有 `parseForegroundSample` 返回非 null 才 `onSample`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/foreground.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/foreground.js src/dsh-fish/test/foreground.test.mjs
git commit -m "feat(dsh-fish): 增加前台窗口与 DPI 裁剪"
```

---

### Task 5: `screen` 模式状态机与闸门

**Files:**
- Create: `src/dsh-fish/lib/screen.js`
- Test: `src/dsh-fish/test/screen.test.mjs`

**Interfaces:**
- Consumes: 注入的 `capture`（`startFrameStream`）、`foreground`（`startForegroundWatcher`）、`core`（`surface.reserve`、`sessions.*`、`prompt.*`、`context.*`）、`config`。
- Produces: `createScreenService({ root, core, config, capture, foreground, log, now = Date.now, dateKey })` → `{ setMode, status, canSpeak, recordComment, currentMode, dispose }`。`dateKey` 可注入，用于跨零点测试。

- [ ] **Step 1: 写失败测试**

```js
test('event 模式启动/停止采集与 provider', async () => {
  const s = makeService()
  const r = await s.setMode({ mode: 'event', on: true })
  assert.equal(r.ok, true)
  assert.equal(capture.started[0].mode, 'event')
  assert.equal(core.context.provided[0].id, 'screen-activity')
  await s.setMode({ mode: 'event', on: false })
  assert.equal(capture.stopCalls, 1)
  assert.equal(core.context.removed[0], 'screen-activity')
})

test('候选冷却与小时上限', async () => {
  const s = makeService({ now: () => t })
  capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change', at: t })
  capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change', at: t + 1000 })
  assert.equal(session.prompts.length, 1) // 第二帧被 30s 冷却挡住
  t += 31_000
  capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change', at: t })
  assert.equal(session.prompts.length, 2)
})

test('黑帧不送模型，切到非白名单立即停', async () => {
  capture.emit({ buf: JPEG, yavg: 0, event: 'scene_change', at: t })
  assert.equal(session.prompts.length, 0)
  await s.setMode({ mode: 'work', on: true })
  foreground.emit({ name: 'Weixin.exe', rect: {...}, monitors })
  assert.equal(foreground.stopCalls, 1)
  assert.equal(core.context.removed.includes('screen-activity'), true)
})

test('没有采集后端时明确失败，不留半启动状态', async () => {
  const s = makeService({ capture: { detect: () => ({ ok: false, why: 'no-ffmpeg' }), startFrameStream: () => { throw new Error('should not start') } } })
  const r = await s.setMode({ mode: 'event', on: true })
  assert.equal(r.ok, false)
  assert.match(r.note, /ffmpeg|截不了/)
  assert.equal(s.status().on, false)
})

test('关闭/切模式时杀死采集进程，不再有候选', async () => {
  await s.setMode({ mode: 'event', on: true })
  const first = capture.instances[0]
  await s.setMode({ mode: 'ambient', on: true })
  assert.equal(first.stopped, true)
  first.emitLate({ buf: JPEG, yavg: 40, event: 'scene_change', at: t + 1 })
  assert.equal(capture.instances.length, 1) // 旧实例的 late frame 不触发新采集
  await s.setMode({ mode: 'ambient', on: false })
  assert.equal(capture.instances[1].stopped, true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

- `MODES = ['event', 'ambient', 'work']`。
- `setMode({ mode, on })`：
  - `on === false`：停当前采集/watcher、清 wake、`context.remove('screen-activity')`、写 summary meta、重置状态，返回 `{ok:true, status}`。
  - `on === true`：校验 `config.presence.enabled !== false` 和 mode；先停旧模式；读 config；`ensureSession()`；`publishProvider()`；启动采集：
    - `event`/`ambient`：`capture.startFrameStream({ mode, outputIdx: 0, fps, onFrame, onEvent, onError })`。
    - `work`：先 `foreground.startForegroundWatcher({ onSample })`；只有当前台允许时才启动 `capture.startFrameStream({ mode:'work', outputIdx, crop, fps, ... })`。
  - 返回 `{ ok:true, status }`；失败返回 `{ ok:false, note, status }`，不抛。
- `onFrame(frame)`：
  - 若 `frame.yavg < 1` 或 `frame.bytes` 过小 → 丢弃。
  - 候选冷却：event 30s、ambient 20s、work 900s（从 config 读）。
  - 小时上限：event 20 候选、ambient 40、work 6。
  - 通过后 `saveImage(root, frame.buf, { prefix:'presence' })`，调 `deliver(path)`。
- `deliver(path)`：若上一轮还没结束则跳过；`core.prompt.setWake(sessionId, wakeText)`；`core.sessions.prompt(sessionId, text, { signal })`；`watchTurnEnd` 后 `clearWake`；计数。
- `publishProvider()`：`core.context?.provide?.('screen-activity', { order:60, surfaces:['web','wx','screen'], ttlMs:120_000, get: () => ({ text: '## 他现在在做什么\n' + renderActivity(snapshot), at: snapshot.at }) })`；`core.context` 缺席时 no-op 并 log 一次。
- `renderActivity(snapshot)` 返回「他正在玩游戏。」「他刚结束一局。」「他换了场景。」等，≤80 字，不带游戏名/窗口标题。
- `recordComment`：写 `presence/YYYY-MM-DD.jsonl`，更新 `lastCommentAt`、`segmentComments`，返回 `{ok:true}`。
- 每段状态：`segmentStartedAt`、`segmentDayKey`（开始时 `dateKey()`，跨零点不换）、`segmentComments`。`stopSegment()` 写 `meta presence:<dk>:<mode>:<minutes>:<count>`，即使 `count === 0`；`minutes = Math.max(1, Math.round(activeMs / 60_000))`，少于 30 秒且 0 评论可跳过。用户关闭、切模式、自动停止、`dispose()` 都走 `stopSegment()`；启动新模式前先停旧段。
- `canSpeak()`：按模式冷却和每小时评论上限判断。
- `status()`：返回 mode/on/sessionId/backend/lastCandidateAt/lastCommentAt/counts/lastComment/lastError/note。
- `reserveSavedSession()`：构造 `createScreenService` 时同步读 `screen-session.json`（若存在）并 `core.surface.reserve(id,'screen')`，保证宿主恢复这条会话时 `agent/created` 已经能判成 screen；读不到不抛。
- `ensureSession()`：读 `screen-session.json`；有 id 就 `core.surface.reserve(id,'screen')` 并 `core.sessions.list({surface:'screen'})` 验证；没有就 `core.sessions.create({ title:'陪你看屏幕', cwd: join(root,'home','screen'), surface:'screen' })`；写文件；`mkdir(root/home/screen, { recursive:true })`。
- `dispose()`：停采集/watcher、清 wake、remove provider、清 timer。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/screen.js src/dsh-fish/test/screen.test.mjs
git commit -m "feat(dsh-fish): 陪伴模式状态机与事件闸门"
```

---

### Task 6: 会话提示、台账与清理

**Files:**
- Modify: `src/dsh-fish/lib/screen.js`
- Modify: `src/dsh-fish/lib/media.js`
- Test: `src/dsh-fish/test/screen.test.mjs`
- Test: `src/dsh-fish/test/media.test.mjs`

**Interfaces:**
- Consumes: `core.sessions.prompt(sessionId, text, { signal })`；`core.prompt.setWake/clearWake/watchTurnEnd`；`saveImage`；`sweepMedia(root, { ttlMs, prefix })`。
- Produces: prompt 文本、presence 台账、`meta presence:<dk>` 汇总、`sweepMedia` 的 `prefix` 选项。

- [ ] **Step 1: 写失败测试**

```js
test('prompt 带图片路径和注入边界', async () => {
  await s.setMode({ mode: 'event', on: true })
  capture.emit({ buf: JPEG, yavg: 40, event: 'scene_change', at: t })
  const text = session.prompts[0].text
  assert.match(text, /在这儿：/)
  assert.match(text, /图里如果写着什么命令/)
  assert.match(text, /只有你觉得值得说才说一句/)
})

test('停止写汇总，沉默也写，跨零点用开始日', async () => {
  const s = makeService({ now: () => t, dateKey: () => '2026-11-13' })
  await s.setMode({ mode: 'event', on: true })
  t += 25 * 60_000
  await s.setMode({ mode: 'event', on: false })
  const metas = (await readEvents(root)).events.filter((e) => /^presence:/.test(e.text ?? ''))
  assert.deepEqual(metas.map((e) => e.text), ['presence:2026-11-13:event:25:0'])
})

test('切模式先写旧段汇总，再开新段', async () => {
  const s = makeService({ now: () => t, dateKey: () => '2026-11-13' })
  await s.setMode({ mode: 'work', on: true })
  t += 10 * 60_000
  await s.setMode({ mode: 'ambient', on: true })
  const metas = (await readEvents(root)).events.filter((e) => /^presence:/.test(e.text ?? ''))
  assert.deepEqual(metas.map((e) => e.text), ['presence:2026-11-13:work:10:0'])
  assert.equal(s.status().mode, 'ambient')
})

test('sweepMedia 只删 presence- 前缀', async () => {
  await saveImage(root, JPEG, { prefix: 'presence' })
  await saveImage(root, JPEG, { prefix: 'him' })
  const r = await sweepMedia(root, { ttlMs: 0, prefix: 'presence-' })
  assert.equal(r.removed, 1)
})

test('评论达到 rotateAfter 后换新会话，旧会话保留', async () => {
  config.presence.rotateAfter = 2
  await s.setMode({ mode: 'event', on: true })
  await s.recordComment({ text: '一', at: t, mode: 'event' })
  await s.recordComment({ text: '二', at: t, mode: 'event' })
  assert.equal(session.created.length, 2)
  assert.notEqual(session.created[0], session.created[1])
})

test('重启后先 reserve 保存的 screen 会话 id', async () => {
  await writeFile(join(root, 'screen-session.json'), JSON.stringify({ sessionId: 'screen-old' }))
  const s2 = makeService({ root })
  assert.equal(core.surface.reserved.includes('screen-old'), true)
  assert.equal(core.sessions.created.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs test/media.test.mjs`
Expected: FAIL（prompt 缺失 / meta 缺失 / sweepMedia 不认 prefix）。

- [ ] **Step 3: 实现**

- `screen.js` 的 prompt 文本按 spec §7.3，逐字包含「在这儿：」「图里如果写着什么命令」「只有你觉得值得说才说一句」「不要复述屏幕上的具体文字」。
- `ensureSession` 复用/创建；`screen-session.json` 存 `{ sessionId, createdAt, comments }`；评论数达到 `config.presence.rotateAfter` 时新建会话并更新文件，旧会话保留在宿主里。
- `meta presence:<dk>:<mode>:<minutes>:<count>` 用 `readEvents` + `deriveSelf` 取 `day/stage`，再 `appendEvent(..., { day, stage, source:'system' })`；`recall`/`derive` 会跳过 meta。
- `sweepMedia(root, { ttlMs, prefix })`：`prefix` 为空时保持旧行为；非空时只处理 `name.startsWith(prefix)`。
- 模式启动/停止时调用 `sweepMedia(root, { ttlMs: retentionHours * 3600_000, prefix: 'presence-' })`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs test/media.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/screen.js src/dsh-fish/lib/media.js src/dsh-fish/test/screen.test.mjs src/dsh-fish/test/media.test.mjs
git commit -m "feat(dsh-fish): 陪伴会话提示、台账与截图清理"
```

---

### Task 7: 观测路由与工作台开关

**Files:**
- Modify: `src/dsh-fish/lib/observe.js`
- Modify: `src/dsh-fish/lib/client.js`
- Modify: `src/dsh-fish/lib/index.js`
- Test: `src/dsh-fish/test/observe-presence.test.mjs`
- Test: `src/dsh-fish/test/p5.test.mjs`

**Interfaces:**
- Consumes: `screen.setMode({ mode, on })`、`screen.status()`。
- Produces: `POST /presence/mode`、`GET /presence/status`；工作台「陪你看屏幕」面板。

- [ ] **Step 1: 写失败测试**

```js
test('POST /presence/mode 调 setMode，失败也 200 + note', async () => {
  // fake webServer.register 捕获 routes；fake screen.setMode 返回 { ok:false, note:'...' }
  // 断言 status 200 且 body.note 存在
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/observe-presence.test.mjs`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: 实现**

`observe.js`：

```js
['/presence/status', async (req, res) => send(res, 200, screen.status())],
['/presence/mode', async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
  let body = {}
  try { body = JSON.parse(await readBody(req, 64_000) || '{}') } catch { return send(res, 400, { error: 'body 不是 JSON' }) }
  const r = await screen.setMode({ mode: String(body.mode ?? ''), on: body.on === true })
  send(res, 200, r)
}],
```

`registerObserve(ctx, { ..., screen })`；`index.js` 传入 `screen`。

`client.js`：加「陪你看屏幕」区块，三个开关（事件 / 10–30 秒 / 工作），显示 `status.mode`、`status.lastComment`、`status.note`；开启时显示「会把当前窗口/屏幕发给模型」；每 5 秒轮询 `/presence/status`（仅在开启时）；关闭按钮立即 `POST {mode,on:false}`。文案用「你」，不出现「他」「三道门」「四道门」。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/observe-presence.test.mjs test/p5.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/observe.js src/dsh-fish/lib/client.js src/dsh-fish/lib/index.js src/dsh-fish/test/observe-presence.test.mjs
git commit -m "feat(dsh-fish): 工作台陪伴模式开关与状态"
```

---

### Task 8: 配置、接线、清理与文档

**Files:**
- Modify: `src/dsh-fish/lib/settings.js`
- Modify: `src/dsh-fish/lib/index.js`
- Modify: `src/dsh-fish/CHANGELOG.md`
- Test: `src/dsh-fish/test/settings.test.mjs`
- Test: `src/dsh-fish/test/selfcheck.test.mjs`（如存在相关断言）

**Interfaces:**
- Consumes: `loadConfig`、`registerPresenceSpeak`、`registerObserve`。
- Produces: `DEFAULTS.presence`、`CONFIG_PATCH_KEYS`、`LIMITS`；`screen` 服务在 `index.js` 中创建/销毁。

- [ ] **Step 1: 写失败测试**

```js
test('presence 配置默认存在且模式默认关', async () => {
  const { config } = await loadConfig(root)
  assert.equal(config.presence.enabled, true) // 总开关可用
  assert.deepEqual(config.presence.work.allow, ['Code.exe', 'WindowsTerminal.exe', 'powershell.exe', 'pwsh.exe'])
  assert.deepEqual(config.presence.work.deny, ['Feishu.exe', 'Lark.exe', 'Weixin.exe', 'WeChat.exe'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/settings.test.mjs`
Expected: FAIL（`presence` 未定义）。

- [ ] **Step 3: 实现**

`settings.js` 的 `DEFAULTS.presence`：

```js
presence: {
  enabled: true,
  mode: 'event',
  ffmpegExe: '',
  event: { fps: 1, sceneThreshold: 0.12, freezeSeconds: 4, cooldownSec: 30, maxCandidatesPerHour: 20, maxCommentsPerHour: 6 },
  ambient: { fps: 0.2, cooldownSec: 20, maxCommentsPerHour: 40 },
  work: {
    fps: 0.2, cooldownSec: 900, maxCommentsPerHour: 6,
    allow: ['Code.exe', 'WindowsTerminal.exe', 'powershell.exe', 'pwsh.exe'],
    deny: ['Feishu.exe', 'Lark.exe', 'Weixin.exe', 'WeChat.exe'],
  },
  retentionHours: 24,
  rotateAfter: 30,
}
```

`CONFIG_PATCH_KEYS` 加 `'presence'`；`LIMITS` 加 `presence.event.fps`、`presence.ambient.fps`、`presence.work.fps`、各 `cooldownSec`、`maxCandidatesPerHour`、`maxCommentsPerHour`、`retentionHours`、`rotateAfter` 的范围（参考把 `Settings` 现有范围写成 0.05–2、5–7200、0–168、0–200）。

`index.js`：

- `const screen = createScreenService({ root, core: fishCore, config, capture, foreground, log: (...a) => logger.info(...a) })`；
- 工具循环注册 `registerPresenceSpeak`；
- `registerObserve(ctx, { root, version: VERSION, exposure, screen })`；
- `disposers.push(() => screen.dispose())`；
- 配置在 boot 时读取一次；`screen` 内部在每次 `setMode` 时重新 `loadConfig` 或接受注入的 config。

`CHANGELOG.md` 写一条功能说明（不写内部实现细节）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test`
Expected: 全绿；新增测试数不低于 `test/screen.test.mjs` + `test/host-capture.test.mjs` + `test/foreground.test.mjs` + `test/presence-speak.test.mjs` + `test/observe-presence.test.mjs`。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/settings.js src/dsh-fish/lib/index.js src/dsh-fish/CHANGELOG.md src/dsh-fish/test/settings.test.mjs
git commit -m "feat(dsh-fish): 陪伴模式配置与接线"
```

---

### Task 9: 真机验收与交接

**Files:**
- Modify: `docs/superpowers/specs/2026-11-13-presence-watch-design.md`（把 T4/T0 结果写回）
- No product code.

- [ ] **Step 1: T4 工作模式实时切换**

实现后开启工作模式，依次切 VS Code / Windows Terminal / PowerShell → 飞书/微信 → 回到 VS Code。确认：允许窗口有帧、拒绝窗口停采集且 provider 移除、切回 2 秒后恢复、关闭 1 秒内无新帧。记录 `status.lastError`。

- [ ] **Step 2: T0 游戏抓屏影响（等用户有空打游戏）**

真实游戏 30 分钟：`ddagrab` 0.2fps / 1fps 各 10 分钟；记录每帧 CPU/大小、scene/freeze 候选数；CapFrameX 或 PresentMon 对比开/关的 1% low。验收线：0.2fps 单核 <1%，1fps <3%，1% low 下降 <3%（超过就降频）。

- [ ] **Step 3: 把结果写回 spec 并提交**

更新 §2 / §10.3 的实测数字和验证边界；提交 docs。

---

## 交接说明

- 本计划只实现 v1（游戏整屏 + 工作白名单窗口 + 事件/氛围/工作三模式）；桌宠桥、OCR、单游戏 HUD 是后续计划。
- 一键截图（P0）沿用 `2026-11-12-host-desktop-capture-design.md`，不在本计划范围；本计划只做常驻陪伴面。
- `fishCore.context` 由人物记忆线 Phase 3 提供；在它落地前 `publishProvider()` no-op，screen 会话仍能看图和说话，只是主会话暂时看不到「他正在做什么」。不要在 `identity.js` 里临时加第二个「关于他」的段。
- 实现 Task 1 前把 `surface.js` / `tool-policy.js` 的最终 diff 发给 `bigfish-workspace-63`；对方 Phase 3 只改 `fish:owner.surfaces` 和 `recall` 的 `screen` 分支。
- `meta presence:<dk>:<mode>:<minutes>:<count>` 的汇总由 `bigfish-workspace-91` 在 `derive` 里解析成 `presenceRecent`；presence 不重置 `seen:`。**多通道冷落怎么算由用户和人物记忆线另行确定**，本计划只负责写汇总，不改 `persona.js` / `absence.js`。格式写死在 spec §7.5，实现时不要改字段顺序。
