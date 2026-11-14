# 桌宠陪伴会话与工作台「桌宠」页设计

- 日期：2026-11-14
- 状态：设计确认，待实施
- 范围：桌宠对话的会话归属、陪伴会话轮换、工作台「桌宠」页、桌宠状态心跳、尺寸与本地皮肤
- 关联：
  - `docs/superpowers/specs/2026-11-14-desktop-pet-thin-shell-design.md`（薄壳 v1 已落地）
  - `src/dsh-fish/lib/say.js`、`screen.js`、`home.js`、`identity.js`
  - `workbench/fish/routes.mjs`、`workbench/assets/nav.js`
  - `desktop-pet/`（Electron 薄壳）

---

## 0. 摘要

桌宠输入框说出的句子改为进入**陪伴会话**（陪你看屏幕那条），而不是现有的 home 会话；评论与对话轮数合并计数触发轮换。工作台新增「桌宠」页，提供状态、动作试演、外观（尺寸 + 本地皮肤）和陪伴会话卡片。桌宠壳新增心跳上报（皮肤清单、版本），并从 `/pet/state` 的 `settings` 接收尺寸与皮肤变更。

不改事件流、不新增模型工具、不引入人格输入；`dsh-fish` 依赖仍为 `{}`。

---

## 1. 目标与非目标

### 1.1 目标

1. 点桌宠说话 → 进入陪伴会话，形成「陪看 → 对话」闭环；她能带着屏幕上下文接话。
2. 工作台聊天（总览页「说给她」）与自主唤醒继续走 home 会话，不被改动。
3. 陪伴会话的轮换由**评论数 + 对话轮数**共同触发。
4. 工作台「桌宠」页：在线状态、当前活动/动作、presence 状态与最近评论、七个动作试演、尺寸与皮肤、陪伴会话信息与手动换会话。
5. 桌宠壳可被工作台配置尺寸与皮肤，无需到 Windows 右键菜单。
6. 全局记忆（`events.jsonl` + `her_recall` + `fish:owner`）继续共享；陪伴会话天然带 owner 段。

### 1.2 非目标

- 不给 B 站出门 / QQ 增加 owner 段（后续按需求另议）。
- 不做多宠物同屏、不做皮肤商店/在线下载、不改形象素材许可。
- 不新增人格输入、好感度、情绪标签。
- 不把动作/对话写进 `events.jsonl`。
- 不改动 home 会话的轮换规则（`chat.rotateAfter`）。

---

## 2. 现状

| 入口 | 会话 | 工作区 | surface | 轮换 | owner 段 |
| --- | --- | --- | --- | --- | --- |
| 工作台聊天（`overview.js` → `/say`） | home talk | `~/.dsh-fish/home` | web | `chat.rotateAfter` | 有 |
| 自主唤醒 | home talk | 同上 | web | 同上 | 有 |
| 陪看屏幕（presence） | screen | `~/.dsh-fish/home/screen` | screen | `presence.rotateAfter`（评论数） | 有 |
| B 站出门 | outing | `~/.dsh-fish/home/bili` | bili | 每次出门 | 无 |
| 微信 / QQ | dsh-wx | 插件管理 | wx / qq | 插件规则 | wx 有、qq 无 |
| **桌宠对话（现状）** | **home talk** | 同上 | web | `chat.rotateAfter` | 有 |

关键代码事实：

- `say.js` 通过 `talkSessionId(ctx, { root })` 取 home 会话，`addExchange` + `bumpTurns` + `rotateTalkSession` 负责记忆搬运与换会话。
- `screen.js` 内部有 `ensureSession({ rotate })`，会话创建后 `surface.reserve(id, 'screen')`；`rotateIfNeeded()` 以 `presence().rotateAfter` 与 `state.sessionComments` 比较。
- `identity.js` 的 `fish:owner` 只在 web / wx / screen 三个面渲染。
- 桌宠壳只读 `/pet/state` 的 `presence` / `activity` / `action` 文本，不接触会话 id。

---

## 3. 会话分配设计

| 入口 | 会话 | 轮换条件 | 记忆 |
| --- | --- | --- | --- |
| 工作台聊天、自主唤醒 | home talk | `chat.rotateAfter`（现状） | 事件流 + recall + talkmem |
| **陪看屏幕 + 桌宠对话** | companion | `sessionComments + chatTurns >= presence.rotateAfter` | 同上 + `fish:owner` |
| B 站出门 | outing | 现状 | 事件流 + recall |
| 微信 / QQ | dsh-wx | 现状 | 事件流 + recall |

约定：

- 「记忆共享」指全局事件流与 `her_recall`；会话内上下文仍按面分开，轮换时用 `talkmem` 搬最近几句原话。
- 陪伴会话不存在时（presence 从未开启），桌宠对话**创建并复用**一条陪伴会话；关闭 presence 不影响这条会话继续聊天。
- screen 服务缺席或会话创建失败时，回落 home 会话，并在返回 `note` 里说明「这次进了主页会话」。

---

## 4. `/say` 路由改造

### 4.1 请求

`POST /dsh-fish/say` body 增加可选字段：

```jsonc
{ "text": "…", "image": "…", "target": "home" | "companion" }
```

- 缺省 `home`，保持工作台聊天与既有调用不变。
- 桌宠主进程的 `pet:chat` 固定传 `target: "companion"`。

### 4.2 响应

在现有 `{ ok, note, said, herReply, waitedMs, rotated, reaction }` 基础上增加：

```jsonc
{ "target": "companion", "sessionId": "…" }
```

### 4.3 会话解析

新增 `resolveSaySession(ctx, { root, target, log })`：

- `home` → `talkSessionId(ctx, { root, log })`（现状）。
- `companion`：
  1. 取 `fishCore.screen`（`ctx.get('fishCore')` 或 `ctx.fishCore`）。
  2. `await screen.ensureSession()`；返回空则回落 `home` 并标记 `fellBack: true`。
  3. 成功后调用 `await screen.noteChatTurn()`，由 screen 服务负责计数与轮换。
- `say.js` 的 home 轮换逻辑（`bumpTurns` / `rotateTalkSession`）**只对 target=home 生效**。

### 4.4 screen 服务新增接口

```js
ensureSession({ rotate = false } = {}): Promise<string>
noteChatTurn(): Promise<{ rotated: boolean, sessionId: string }>
companionInfo(): {
  sessionId: string,
  sessionComments: number,
  chatTurns: number,
  rotateAfter: number,
}
```

- `noteChatTurn`：`state.chatTurns += 1`；调用 `rotateIfNeeded()`；返回是否换过会话。
- `rotateIfNeeded`：`limit = presence().rotateAfter`；条件改为 `state.sessionComments + state.chatTurns >= limit`；换会话成功后把 `sessionComments` 与 `chatTurns` 归零，`recentComments` 清空。
- `ensureSession` 不要求 presence 开启：复用 `~/.dsh-fish/presence.json` 里保存的会话 id；失效则新建。

### 4.5 talkmem

继续使用全局 `talkmem`（最近几句原话）在换会话时搬运；home 与 companion 共用同一份，不新增存储。

---

## 5. 桌宠状态与心跳

### 5.1 `pet-view.js` 扩展

```js
markPolled(at = now()): void        // /pet/state 每次调用
noteHello({ version, skins }, at = now()): void
snapshot(): {
  activity, action,
  lastPollAt: number | null,
  helloAt: number | null,
  version: string,
  skins: Array<{ id: string, name: string }>,
}
```

- `lastPollAt` / `helloAt` / `version` / `skins` 全部易失，不落盘。
- `skins` 缺省 `[]`。

### 5.2 `GET /dsh-fish/pet/state` 新形状

```jsonc
{
  "at": 1794640000000,
  "presence": { "on": true, "mode": "event", "busy": false, "snapshot": null, "recent": [] },
  "activity": null,
  "action": null,
  "settings": { "size": 400, "skin": "" },
  "companion": { "sessionId": "…", "sessionComments": 3, "chatTurns": 1, "rotateAfter": 30 },
  "pet": {
    "online": true,
    "lastPollAt": 1794640000000,
    "helloAt": 1794640000000,
    "version": "0.1.0",
    "skins": [{ "id": "default", "name": "大肥鱼" }]
  }
}
```

- `online` 以 **`helloAt`** 为准：`helloAt !== null && at - helloAt <= 90_000`。`/pet/state` 同时被桌宠壳和工作台轮询，`lastPollAt` 只能用于诊断，不能判断壳是否在线。
- `companion` 取 `screen.companionInfo()`；screen 缺席时为 `null`。
- `settings` 取自 dsh-fish 配置 `pet` 段。

### 5.3 新路由

| 路由 | 方法 | 语义 |
| --- | --- | --- |
| `/dsh-fish/pet/hello` | POST | body `{ version, skins }`；写 petView 心跳；200 `{ ok: true }`。桌宠壳**启动时与每 60 秒**上报一次 |
| `/dsh-fish/pet/config` | POST | body `{ size?, skin? }`；校验后写 `config.pet`；200 `{ ok: true, pet }`；非法值 400 |
| `/dsh-fish/pet/rotate` | POST | 调 `screen.ensureSession({ rotate: true })`；200 `{ ok, sessionId }`；screen 缺席 200 `{ ok:false, note }` |

- 三条都只接受本机 BFF 转发；`registerObserve` 的统一 `guarded()` 栅栏自动覆盖。
- `/pet/config` 通过 `config-service.patch({ pet })` 写入；`CONFIG_PATCH_KEYS` 增加 `pet`。

### 5.4 BFF 白名单

`workbench/fish/routes.mjs` 增加：

```js
{ path: 'pet/hello',  methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
{ path: 'pet/config', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
{ path: 'pet/rotate', methods: { POST: 'P2' }, upstream: 'fish', maxBody: 64 * 1024 },
```

---

## 6. 工作台「桌宠」页

### 6.1 导航

- 新文件 `workbench/assets/pages/pet.js`，页面对象 `{ id: 'her-pet', nav: 'her', slug: 'pet', label: '桌宠', order: 40, enter, leave }`。
- 注册进 `nav.js` 的 `her` 组，排在「陪伴」之后。

### 6.2 四块内容

1. **状态**：在线/离线、最后一次轮询、当前 activity、当前 action、presence 开关与模式、最近 5 条评论。
2. **动作试演**：七个按钮（`waving / thinking / working / result / waiting / success / error`），点击 `postFish('pet/act', { motion })`；离线时禁用并显示「桌宠没在跑」。
3. **外观**：尺寸 小 320 / 中 400 / 大 462（单选），皮肤下拉（来自 `pet.skins`，含「默认」）；改动 `postFish('pet/config', { size?, skin? })`，成功后提示「已下发，桌宠 2 秒内跟上」。
4. **陪伴会话**：会话短码、评论数、对话轮数、阈值；「换一条」按钮 `postFish('pet/rotate', {})`，确认后展示新会话短码。

### 6.3 轮询与生命周期

- `enter` 起 3 秒轮询 `/api/fish/pet/state`；`leave` 停止。
- 所有请求走 `postFish` / `fish`；不使用 `innerHTML`。
- 文案不出现「他」「三道门 / 四道门」。

### 6.4 陪伴页调整

- `her-presence.js` 移除「让她演一个动作」卡片（迁到桌宠页），保留开关、状态与最近评论。
- 对应页面契约测试同步迁移。

---

## 7. 外观：尺寸与皮肤

### 7.1 配置

```jsonc
// dsh-fish config.json
"pet": { "size": 400, "skin": "" }
```

- `size`：240–560，缺省 400；非法值夹取。
- `skin`：`""` 表示默认皮肤（现有 `assets/config.json` + `assets/webm`）；非空为皮肤 id（仅 `[a-z0-9-]{1,32}`）。

### 7.2 皮肤目录

```text
desktop-pet/assets/skins/
  <id>/
    skin.json     # { "name": "大肥鱼", "motions": { ...14 个动作... }, "size": 400 }
    webm/*.webm
```

- 默认皮肤不放进 `skins/`；壳在 `skin === ""` 时沿用现有资源路径。
- 壳启动时扫描 `assets/skins/*/skin.json`，校验 `motions` 覆盖 14 个动作，合法项加入清单。
- `pet/hello` 上报 `[{ id, name }]`，首项固定为 `{ id: '', name: '默认' }`。

### 7.3 切换流程

1. 工作台 `pet/config` 写 `config.pet.skin`。
2. 桌宠下次轮询（≤2 秒）读到 `state.settings.skin`。
3. 壳按新皮肤加载 `pet-asset://local/skins/<id>/skin.json` 与 `pet-asset://local/skins/<id>/webm`；默认皮肤回到现有路径。
4. 加载失败：保留上一个皮肤，气泡显示「皮肤没载入」，不退出。

### 7.4 许可

- 每个皮肤自带 `assets/skins/<id>/ATTRIBUTION.md`；默认皮肤的署名仍在 `assets/ATTRIBUTION.md`。
- 不提供在线下载；用户自行放置皮肤目录。

---

## 8. 主人认知与记忆

- `fish:owner` 继续只在 web / wx / screen 渲染；陪伴会话是 screen，**天然带上主人认知段**，无需改动。
- B 站出门 / QQ 暂不接入（本设计不做，后续按面需求另议）。
- 全局记忆仍为 `events.jsonl` + `her_recall`；本设计不新增记忆类型、不改 schema。
- `/pet/config` 只写 `pet` 段；`pet` 段不进入任何提示词，避免变成人格入口。

---

## 9. 安全与边界

- 三条新路由都在 `registerObserve` 内，自动经过 `guarded()`；桌宠壳仍只访问 `127.0.0.1:8788`。
- `pet/hello` 只存内存；`pet/config` 只接受 `size` / `skin` 两个键并校验；`pet/rotate` 只换陪伴会话，不改 presence 开关。
- 离线判定只看 `helloAt` 心跳（90 秒窗口），不新增端口、不做反向连接。
- 桌宠侧不解析会话 id，只显示/使用服务端给的文本与设置。
- 皮肤只从本地 `assets/skins` 读取，路径经 `isInside` 校验。

---

## 10. 测试

### 10.1 `src/dsh-fish`

- `say` target：`companion` 走 `screen.ensureSession`；screen 缺席回落 home 且 note 说明；`home` 行为不变。
- 轮换：`sessionComments + chatTurns >= rotateAfter` 时换会话并归零；单靠对话也能触发。
- `pet-view`：`markPolled` / `noteHello` / `snapshot` 新字段；hello 缺失时默认值；`online` 以 hello 为准（workbench 轮询不影响在线判定）。
- `observe`：`/pet/state` 新形状；`/pet/hello` 200；`/pet/config` 合法/越界/非法皮肤 id；`/pet/rotate` screen 缺席不 500。
- `config-service`：`pet` 键可写、未知键仍拒绝。

### 10.2 `workbench`

- 路由白名单新增三条，`maxBody` 与 `upstream` 正确。
- 桌宠页契约：`postFish('pet/act'|'pet/config'|'pet/rotate')`、无 `innerHTML`、无「他」。
- 陪伴页不再包含动作按钮。

### 10.3 `desktop-pet`

- 皮肤扫描纯函数：合法/缺动作/坏 JSON。
- `state.settings` 应用：尺寸变化重建窗口、皮肤变化换 config 与 uri。
- `pet/hello` 载荷形状（版本、皮肤清单）。

---

## 11. 分期与验收

1. **P1 后端闭环**：`/say` target、`screen.ensureSession/noteChatTurn`、评论+对话轮换。
   验收：presence 开着时桌宠说一句，回复出现在陪伴会话；关闭 presence 后仍能聊；工作台聊天仍在 home。
2. **P2 状态与心跳**：`pet-view` 扩展、`/pet/hello`、`/pet/state` 新形状、BFF 三条路由、工作台「桌宠」页第一版（状态/动作/会话卡片）。
   验收：桌宠在线/离线正确；动作按钮生效；手动换会话生效。
3. **P3 外观**：`config.pet`、皮肤目录与扫描、壳应用尺寸/皮肤、页面外观区。
   验收：工作台改尺寸/皮肤，桌宠 2 秒内跟上；坏皮肤不崩。

---

## 12. 开放问题

1. 皮肤 id 是否允许中文目录名？（建议只允许 `[a-z0-9-]`，显示名放 `skin.json` 的 `name`）
2. 「换一条」是否需要二次确认？（建议要，避免误点清空当前上下文）
3. 陪伴会话轮换阈值是否继续沿用 `presence.rotateAfter`，还是新增 `pet.rotateAfter`？（建议沿用，减少配置项）
