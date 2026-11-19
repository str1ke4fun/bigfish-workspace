# 桌宠「起来陪我」长唤醒设计

> 状态：待批准，未实现。
> 背景：日程窗口之外桌面宠物自动进入 `rest` 场景，点她只弹「在休息」。用户要求：从桌宠侧显式唤醒不应受睡觉影响，形式为菜单里的「起来陪我」，做长唤醒。

## 1. 要什么，为什么

- **用户意图优先于日程**：日程窗口是"她自己的作息"，而桌宠上的显式操作是"你叫她"。你叫的时候，她该起来。
- **长唤醒是一个持续状态**，不是一次动画：她醒来、点她可以对话，直到你手动收回。
- **结束条件（已确认）**：手动收回 + 12 小时兜底。点「回去睡吧」或交回日程即结束；忘记收回时 12 小时后自动回日程。
- **不动模型**：不自动让她开口，不调用 `/wake`，不写事件流，不改人格与关系。

## 2. 现状与卡点

```
日程 tick（60s，scheduler.js:34）
  → petView.setScheduleRest({ rest: !inWindow(config) })
  → 把手动 override 重置成 auto（pet-view.js:245）

手动 /pet/rest（observe.js:1007）
  → restOverride = sleep | wake
  → snapshot: out 优先，其次 sleep / (auto && rest)（pet-view.js:332-337）
```

卡点只有一处：**每次 tick 都会清掉手动覆盖**，任何 `wake` 最多活 60 秒。桌宠休息时点击和对话也被 `shouldOpenPetDialogue` 拦掉（`playback-adapter.ts:279`，`App.tsx:1047/1074/1154`）。

`/say` 本身不看窗口，所以"醒着就能聊"只需要解除渲染端的 scene 门槛。

## 3. 非目标 / 反目标

- **不改现有「起来」的短 peek 语义**：它是「叫一声，看一眼」，60 秒后回日程。长唤醒是新入口。
- **不改出门优先级**：`out` 永远压过 `rest` 和长唤醒。
- **不落盘（长唤醒除外）**：`pet-view.js` 的活动、动作、cue 仍全部易失；只有长唤醒的到期时刻写一份 `pet-rest.json`，用于服务重启恢复。
- **不自动调用模型**：长唤醒只解除 UI 门槛，她仍然是你开口才说话。调度器的主动唤醒、每日事件配额仍按原 `window` 走，长唤醒不是"让她主动找你"的开关。
- **本次工作台 8788 不加按钮**：服务端接口统一，页面以后要加直接复用。
- **不把 12 小时做成用户配置项**：它是一条兜底策略，不是"人格/环境"参数。

## 4. 方案与取舍

### A. 服务端加一种长唤醒 override（选定）

`restOverride` 增加 `'awake'`，配一个 `awakeUntil`。日程 tick 照常跑，但在 `awake` 未过期时不重置 override；`snapshot` 里 `awake` 恒为 `scene: null`（出门仍优先）。12 小时到期由下一次 `snapshot` 清回 `auto`。

- **收益**：桌宠、工作台、任何轮询方看到同一个事实；与现有"服务端是唯一 scene 事实源"的架构一致。
- **代价**：`pet-view.js` 状态机、`/pet/rest` 白名单、菜单、测试都要跟着改；长唤醒要落一份 `pet-rest.json`（只存到期时刻，不存其他易失状态）。

### B. 桌宠本地压住 rest（否决）

渲染端收到手动 wake 后自己忽略 `rest`。不改服务端，但工作台仍显示休息；每次轮询都要特判，窗口重载就丢。现有代码刻意把手动意图设计成"只能消费服务端返回的事实"（`playback-adapter.ts:226`），本地覆盖与这个设计相悖。

### C. 让所有手动覆盖都粘住（否决）

改一行 tick 逻辑最小，但会改掉现有「起来」的短暂语义；而且窗口外唤醒会一直醒到**次日 18:50 的下一个休息边界**，副作用比 A 大，且没有兜底。

## 5. 设计细节

### 5.1 服务端状态模型（`src/dsh-fish/lib/pet-view.js`）

```js
const AWAKE_MAX_MS = 12 * 60 * 60 * 1000
const PET_REST_OVERRIDES = new Set(['auto', 'sleep', 'wake', 'awake'])   // 新增 awake

let restOverride = 'auto'
let restOverrideAt = null
let awakeUntil = null          // number | null；仅 awake 时非空

setScheduleRest({ rest, at }):
  scheduleRest = rest
  scheduleRestAt = ...
  if (restOverride !== 'awake') {        // 长唤醒期间日程不收回
    restOverride = 'auto'
    restOverrideAt = null
  }

setRestOverride(value):
  restOverride = value
  restOverrideAt = value === 'auto' ? null : now()
  awakeUntil = value === 'awake' ? restOverrideAt + AWAKE_MAX_MS : null

snapshot():
  if (restOverride === 'awake' && nowMs >= awakeUntil) {
    restOverride = 'auto'
    awakeUntil = null
  }
  scene 判定不变（out > sleep/(auto&&rest) > null）
  返回新增顶层字段 awakeUntil（非 awake 时 null）
```

- 重复点「起来陪我」＝刷新 `awakeUntil`。
- `sleep` / `auto` / `wake` 都清除 `awakeUntil`。
- `clear()` 一并清 `awakeUntil`。

### 5.2 接口（`src/dsh-fish/lib/observe.js`）

`POST /pet/rest` 的 action 白名单加 `awake`；响应继续回 `{ ok, action, scene }`，可附带 `awakeUntil`。BFF 白名单 `workbench/fish/routes.mjs` 已有 `pet/rest`，无需改。

### 5.3 桌宠菜单（`desktop-pet/electron/menu-model.ts` + `main.ts`）

- `MenuState` 新增 `scene: {kind:'rest'|'out'}|null` 与 `awakeUntil: number|null`；`main.ts` 的 state 转发处缓存这两个值（现在只缓存 `presence`）。
- 休息中（`scene.kind === 'rest'`）显示 **「起来陪我」**：从注册动作里找 `petRestAction(action) === 'wake'` 的那条（如 `asset-093`），点击调 `rest(id, 'awake')`；没有注册动作时 id 传空串，只改状态。
- 长唤醒中（`awakeUntil != null`）显示 **「回去睡吧」**：找 `petRestAction(action) === 'sleep'` 的动作，调 `rest(id, 'sleep')`；没有就只发状态。
- 两项都只在对应状态下出现，避免菜单常驻噪音。
- `PetRestAction` 扩充为 `'sleep' | 'wake' | 'awake'`；`runRestAction` POST `{ action }`。**发给渲染进程的 IPC 仍归一成 `rest: 'wake'`**，播放层不需要认识 `awake`。
- id 为空时不发 `pet:action`；2 秒内的下一次 `/pet/state` 轮询会经 `scene:rest:exit` 正常播「起来」（`assets/triggers.json` 已挂 `asset-093`）。

### 5.4 渲染端

不改。`scene` 只有 `rest|out|null`；`awake` 期间为 `null`，点击和对话门槛自然解除；`PetState` 多出的 `awakeUntil` 字段被忽略。

### 5.5 跨重启持久化

- `/pet/rest` 处理 `awake` 时，把 `{ override: 'awake', awakeUntil, at }` 原子写入 `~/.dsh-fish/pet-rest.json`；`sleep` / `wake` / `auto` 写入 `{ override: 'auto' }`。
- 插件启动时读这份文件：只有 `override === 'awake'` 且 `awakeUntil > now` 才调用 `petView.restoreRestState(saved)`，恢复后**不延长** 12 小时上限。
- 文件读取/写入失败都不影响本次操作；最坏情况是重启后回到日程。
- `pet-view.js` 的活动、动作、cue 不落盘，保持原约定。

### 5.6 边界与失败

| 情况 | 行为 |
| --- | --- |
| B 站出门进行中 | `scene` 仍是 `out`；长唤醒不抢出门 |
| 12 小时到期 | 下一次 `snapshot` 清回 `auto`，按当前窗口回到 `rest` 或 `null` |
| 服务重启 / 插件重载 | 未到期的长唤醒从 `pet-rest.json` 恢复（不延长 12 小时上限）；其他手动覆盖回到日程 |
| 日程窗口内点「起来陪我」 | 她本来就没睡；长唤醒仍会压过当天之后的休息边界，直到手动收回或 12 小时到期 |
| 点「回去睡吧」时仍在窗口内 | `sleep` 覆盖只维持到下一拍（现有语义），窗口内她会重新醒着 |
| 桌宠关闭但长唤醒未收回 | 服务端状态仍在；12 小时后自愈，工作台可看到 `awakeUntil` |
| `/pet/rest` 收到未知 action | 仍 400，白名单只多一个 `awake` |

## 6. 改动文件

- `src/dsh-fish/lib/pet-view.js` — 状态机与快照字段
- `src/dsh-fish/lib/observe.js` — `/pet/rest` 白名单与响应
- `src/dsh-fish/test/pet-view.test.mjs` — 长唤醒生命周期
- `src/dsh-fish/test/observe-pet.test.mjs` — 路由接受 `awake`
- `desktop-pet/electron/menu-model.ts` — 菜单项与状态字段
- `desktop-pet/electron/main.ts` — 缓存 scene/awakeUntil，`runRestAction` 归一 IPC
- `desktop-pet/test/shell.test.ts` — 菜单项可见性与回调
- `src/dsh-fish/CHANGELOG.md` — 一条行为记录

## 7. 测试与验收

**单元测试**

1. `awake` 设置后，连续多次 `setScheduleRest({ rest: true })` 不改变 `scene: null`，且 `awakeUntil` 稳定。
2. 时间推进到 12 小时后，下一次 `snapshot` 回 `auto`；窗口外回到 `rest`，窗口内为 `null`。
3. `sleep` / `auto` / `wake` 都能立即结束长唤醒。
4. `out` 仍压过 `awake`。
5. `/pet/rest` 接受 `awake`，仍然拒绝未知 action。
6. 菜单：休息中显示「起来陪我」，长唤醒中显示「回去睡吧」，并走对应回调。

**手工验收**

1. 20:49（窗口 09:30–18:50 外）右键桌宠 →「起来陪我」→ 她播「起来」、场景不再是休息；点她可以打开对话。
2. 等过 60 秒，她不会自己睡回去；工作台 `/pet/state` 能看到 `awakeUntil`。
3. 菜单点「回去睡吧」→ 回到「在休息」。
4. B 站出门会话活跃时，以上操作都不改变 `out`。

**测试基线**：`src/dsh-fish` 走 `node --test`，原有 1104 条加新增用例全绿；`desktop-pet` 跑 `npm test` 全绿。

## 8. 留给实现者的决定

无阻塞项。文案「起来陪我」「回去睡吧」可按皮肤/素材实际情况微调，但语义不变。
