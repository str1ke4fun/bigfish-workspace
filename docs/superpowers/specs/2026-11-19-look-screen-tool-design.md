# 陪伴会话按需看屏幕设计

> 状态：**陪伴聊天附图部分已作为独立 bug 修复实现**（2026-11-19，见 CHANGELOG）；`look_screen` 工具待批准，未实现。
> 背景：陪玩模式下她只能看到服务按候选/冷却推过来的帧。用户问「现在呢」时，聊天消息不带图，她只能用上一帧回答（2026-11-19 实测：companion 会话 turn 22 的 reasoning 明确写「no image attached? ... Last frame was WARNO deck」）。事件模式的 30 秒冷却也会让主动推送看起来滞后。
>
> **需求：** 她在当前一轮里能主动抓一次屏幕；陪伴聊天要带上此刻的画面，不能用旧帧回答。没人找她时**不**自主抓屏。

## 1. 现状

- `screen.js` 常驻抓帧（event 1fps / ambient 0.2fps / work 只抓白名单窗口），只有帧通过候选、冷却与每小时配额时才落盘，并把路径投进陪伴会话。
- `onFrame` 不保留最近一帧；`/pet/chat` 走的 `/say` 只带用户原话，没有画面。
- screen 面工具：`growth_commit`、`read_image`、`her_recall`；没有抓屏入口。
- 用户点开关 = 抓屏授权（`presence-watch` 设计：开关即授权）。

## 2. 目标 / 非目标

**目标**

- `look_screen` 工具：陪伴会话里的当前轮次可以主动抓一帧，落盘后返回路径，她再用 `read_image` 看。
- 陪伴聊天自动附图：`/say` 的 `target === 'companion'` 且 presence 开着时，消息带上此刻的一帧路径。
- 不新增第二个 ffmpeg：复用常驻抓帧流。
- 不返回停流前的旧图：work 模式切到非白名单、presence 关闭、抓帧崩溃时直接拒绝。

**非目标 / 反目标**

- 不做自发抓屏：她不会在没有对话时按自己的节奏醒来抓帧。
- 不改 event/ambient 的主动评论节奏（候选与冷却仍按原设计）。
- 不把截图持久化到新状态：`lastFrame` 只在内存；图片文件沿用 `media/` 的按小时清理。
- 不在工具结果里直接塞图片：与现有推帧链路保持一致，返回路径 + `read_image`。

## 3. 方案与取舍

### A. 复用常驻流的最近一帧（选定）

`screen.js` 在 `onFrame` 里保留最新帧；`captureNow()` 在帧太旧时等下一帧（最多 6 秒），落盘后返回路径。

- 收益：不额外起进程；沿用当前模式的裁剪和 work 白名单；和用户授权的抓帧流同源。
- 代价：ambient 下最新帧最多 5 秒旧，需要等待逻辑；等待超时必须拒绝而不是回旧图。

### B. 调用时临时起一次 ffmpeg（否决）

每次都是当下画面，但会和常驻流并存第二个 ddagrab 实例，还要重新套用 crop / denylist，开销和失败面更大。

### C. 返回上一次已落盘的候选图（否决）

可能几十秒甚至更久没更新，还受评论冷却影响；正是用户抱怨的「旧帧」。

## 4. 设计细节

### 4.1 `screen.js`

- `state.lastFrame = { buf, at }`：在 `onFrame` 通过 `state.on` 检查后立刻记录，不受黑帧、候选规则、冷却、`busy` 影响。
- `stopStream()` / `stopCapture()` 清 `lastFrame` 与 `lastLook*`，避免 work 模式切换或抓帧崩溃后返回旧图。
- `waitFrame(ms)`：单 waiter 的 Promise，`onFrame` 收到新帧时 resolve；超时 resolve null。用于 `captureNow`。
- `captureNow({ waitMs = 6000, maxAgeMs = 15_000, freshMs = 1500, cooldownMs = 2000 } = {})`：
  1. 未开启或没有模式 → `{ ok:false, why:'presence-off' }`。
  2. `!state.stream`（work 白名单未命中 / 抓帧停了）→ `{ ok:false, why:'not-capturing' }`。
  3. 最近帧新于 `now - freshMs` 直接用；否则等下一帧，最多 `waitMs`。
  4. 仍拿不到，或最新帧早于 `now - maxAgeMs` → `{ ok:false, why:'no-frame' }`。
  5. `cooldownMs` 内重复调用且 `lastLookPath` 存在 → 原路径复用，不重复落盘。
  6. `saveImage(root, buf, { prefix: 'look' })`，返回 `{ ok:true, path, at, mode, ageMs }`。
- `sweep()` 除 `presence-` 外再清 `look-`，TTL 用 `retentionHours`。
- `status()` 增加 `lastFrameAt`（可选，便于看抓帧是否还活着）。

### 4.2 工具 `look_screen`

- `tool-policy.js` 的 `screenEntries()` 增加 `tool('look_screen', 'screen', ALWAYS, '', '看一眼此刻的屏幕', 'read')`。
- 新文件 `lib/look-screen.js`：
  - `execute` 先判 `core.surface.current(exec.agent) === 'screen'`，否则 `NOT_SCREEN`。
  - 调 `screen.captureNow()`；失败按 `why` 回一句（presence-off / not-capturing / no-frame）。
  - 成功返回 `{ ok:true, path, at, mode }`。
- 投影：`看一眼：〔path〕（用 read_image 看）`；失败：`现在看不到屏幕（…）`。
- 工具描述明确：只有真的想现在看一眼才调用；不要连续反复调用；拿到路径后用 `read_image` 看。
- `index.js` 注册，与 `presence_speak` 并列。

### 4.3 陪伴聊天附图

- `say.js` 的 `sayContent` 增加 `screenPath`：当 `deps.target === 'companion'` 且 `deps.screen.captureNow` 存在时，先调用
  `captureNow({ waitMs: 1500, maxAgeMs: 15_000 })`；
  - 成功：内容里追加
    ```
    （你看到他此刻的屏幕）
    〔/path/to/look-....jpg〕
    ```
  - 失败：聊天照常进行，不带图，不因为抓不到画面而拦住这句话。
- 不把屏幕帧写成「他发了张图」：它是她眼前的画面，不是用户上传的图片。
- 只对 `target === 'companion'` 生效；工作台聊天（home）不自动附图。

### 4.4 边界与失败

| 情况 | 行为 |
| --- | --- |
| presence 关闭 | 工具拒绝、聊天无图 |
| work 模式切到 denylist / 抓帧停 | `not-capturing`；聊天无图，绝不回停流前的旧图 |
| 黑屏 / 锁屏 | 帧可能是黑的；工具仍返回（她看到黑屏），聊天附图同理 |
| 抓帧流卡住但进程在 | 超时后 `no-frame`，不返回过期画面 |
| 服务重启 | `lastFrame` 清空；首次工具调用等下一帧或拒绝 |
| 模型没调 `read_image` | 只看到路径；工具描述与推帧链路一致地要求读图 |
| 评论配额用完 | `look_screen` 不受影响；它只抓图，不评论 |

## 5. 改动文件

- `src/dsh-fish/lib/screen.js` — lastFrame、waitFrame、captureNow、清理、status
- `src/dsh-fish/lib/look-screen.js`（新） — 工具实现
- `src/dsh-fish/lib/tool-policy.js` — screen 面工具清单
- `src/dsh-fish/lib/index.js` — 注册工具
- `src/dsh-fish/lib/say.js` — companion 聊天附图
- `src/dsh-fish/test/screen.test.mjs` — captureNow 生命周期
- `src/dsh-fish/test/look-screen.test.mjs`（新） — 工具门禁与投影
- `src/dsh-fish/test/say.test.mjs` / `observe-pet.test.mjs` — 聊天附图
- `src/dsh-fish/CHANGELOG.md`

## 6. 测试与验收

**单元测试**

1. presence 开、有帧 → `captureNow` 返回落盘路径；帧新时不等待。
2. 没有新帧时按 `waitMs` 超时；过期帧返回 `no-frame`，不回旧图。
3. presence 关 → `presence-off`；work 停流 → `not-capturing`。
4. 2 秒内重复调用复用同一路径。
5. `look_screen` 只在 screen 面可见；非 screen 面执行拒绝。
6. companion `/say` 带图路径；presence 关或抓帧失败时 chat 照常返回且无图。
7. 清理覆盖 `look-` 文件。

**手工验收**

1. 陪玩开着，桌宠发「现在呢」→ 她的这一轮能看到当前屏幕，不再用上一帧回答。
2. 同一个会话里说「你自己看一眼」→ 她调用 `look_screen` 并 `read_image`，回复描述的是当下画面。
3. 关掉陪玩再发消息 → 聊天正常、无图；强行调用工具应被拒绝。
4. work 模式切到微信/飞书 → 聊天无图、工具拒绝，不能看到被排除窗口。

**测试基线**：`src/dsh-fish` 下 `node --test` 全绿。
