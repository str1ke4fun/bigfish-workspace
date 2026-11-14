# 大肥鱼桌宠：复用 dsh-pet 组件、自建 Windows 薄壳

- 日期：2026-11-14
- 状态：设计草案，待评审；未实施
- 范围：Windows 原生桌宠壳 + “让宠物演一个动作” + 接大肥鱼的 presence/活动状态
- 关联：
  - `docs/superpowers/specs/2026-11-13-presence-watch-design.md`（presence v1 已落地）
  - `src/dsh-fish/lib/screen.js`（陪伴状态机、presence 台账）
  - `src/dsh-fish/lib/observe.js`（`/presence/status`）
  - `workbench/fish/routes.mjs`（8788 BFF 白名单）
  - 本地调研包：`D:\dsh-pet\`（v0.4.8，未执行）
  - 上游：<https://github.com/PC2005-cloud/dsh-pet>
  - 组件：<https://github.com/dsh-tauri/dsh-pet-component>

---

## 0. 摘要

结论：**不复用 dsh-pet 的宿主/AI，只复用它的表现层组件与动画素材，自建一个 Windows Electron 薄壳。**

薄壳只做四件事：

1. 透明、置顶、可点击穿透的窗口；
2. 用 `dsh-pet-component` 播透明 WebM 动画、弹气泡；
3. 轮询 8788 BFF 的 `/api/fish/pet/state`，把她的话和活动状态翻译成动作；
4. 本地右键菜单 + 工作台按钮，点一下就让宠物演一个动作。

大肥鱼侧只新增一个**只读状态聚合 + 无模型的动作队列**（内存，不写 `events.jsonl`），不新增模型工具，不引入人格设置，不把屏幕内容交给桌宠。

---

## 1. 目标与非目标

### 1.1 目标

1. 用户可以在工作台 `#her/presence` 或宠物右键菜单选择一个动作，Windows 桌宠立即表演；动作失败/过期要显式忽略，不假装成功。
2. presence 有新评论时，桌宠自动弹气泡并演一个动作；气泡是她的原话，不是工具结果。
3. presence 模式开启/关闭、她思考/调工具/完成时，桌宠能跟着切工作状态动画（v2）。
4. 点宠物可以输入一句话，转给大肥鱼 `/say`，把回复显示成气泡（v2，可选）。
5. 薄壳只识别 `127.0.0.1` 上的 BFF；不做远程、不做屏幕采集、不注入游戏。
6. `dsh-fish` 保持零依赖；桌宠代码全部在独立目录，不进入插件包。
7. 复用 dsh-pet 的 100+ 动画资产与 React 组件；许可证与署名写进 About。

### 1.2 非目标

- 不移植 dsh-pet 的 whisper/chat/memory/persona/balance/weather/todos/AI provider；这些会和大肥鱼形成第二个“她”。
- 不新增“人格输入框”“好感度数字”或任何能直接指定性格的界面。
- 不做 WSLg/像素透传：生产路径是 Windows 原生渲染 + localhost 桥接。
- v1 不做甩动/碰撞物理、多宠物、语音、表情包、待办、余额；先保证“动作 + 气泡 + 穿透”。
- 不把屏幕画面、窗口标题、OCR 文本写给桌宠；桌宠只拿她说过的话和活动状态。

---

## 2. dsh-pet 已实现的动作链路（调研）

### 2.1 宿主侧：状态叶子 + 公开 API

dsh-pet 把动作写进 `sections`/`pets.<id>` 的状态叶子，渲染端按 `counter` 变化消费：

- `GET /dsh-pet-7340/state` 是唯一状态出口；叶子形状 `{ counter, data }`，`counter` 变了才重绘；支持 `?since=&timeout=` 长轮询（`D:\dsh-pet\docs\API.md` 的「state 详解」）。
- `POST /dsh-pet-7340/anim?pet=` 点播动画，body `{ name | url, facing? }`，**需要占用锁** `?lock=<lockId>`；返回 `playbackId`，可用 `/playback/{id}` 等回执（`API.md` §四）。
- `POST /dsh-pet-7340/work-status` 是外部写入工作状态的槽：`{ state, task? }`，`state ∈ thinking|working|result|waiting|success|error`；`DELETE` 回空闲（`API.md` §八）。
- `POST /broadcast?pet=` 把第三方文本写进气泡，可带 `image`/`url`/`duration`/`anim`/`speak`；**需要锁**，默认不念（`API.md` §三）。
- `POST /lock?pet=` / `/lock/release?pet=` 是占用租约；持锁期间宠物完全静止，第三方演出不会被它自己的事件打断（`API.md` §二）。
- 工作状态 reducer 在 `src/host/work-status.ts`：`turn/start→thinking`、`tool/call→working`、`tool/result→result`、`approval/asked→waiting`、`turn/end completed→success`、错误/超时→`error`、`blocked→waiting`、aborted 清空；`ask_user_question` 归 waiting（`D:\dsh-pet\package\src\host\work-status.ts`）。
- 渲染端动作池在 `assets/config.jsonc` 的 `animations`：`idle` / `turn` / `drag` / `clicks` / `moves` / `categories` / `events.workStatus` / `events.whisper` / `sleep`。

### 2.2 表现层：透明视频 + 14 个同构动作

- 素材是 640×360 的 VP9-alpha WebM，共 114 段、约 56 MB；桌面与浏览器共用（`D:\dsh-pet\package\assets\webm`）。
- `dsh-pet-component` 把上游协议收成一个 React `<Pet>`：
  - 14 个动作：`idle / turn / moving-left / moving-right / waving / thinking / working / result / waiting / running / review / failed / success / error`；另有手势态 `dragging`（`dist/index.d.mts` 的 `MOTIONS`）。
  - 循环动作：idle / moving-* / thinking / working / result / waiting / running / dragging；单次动作：turn / waving / review / failed / success / error，播完自动回 `idle`。
  - 命令面：`pet.motion({ type, loop?, replay? })`、`pet.clear()`、`pet.current`；声明式 `motion` prop 作为回落值，命令面优先，直到 prop 变化（`README.md`「外部控制与插播」）。
  - 气泡：`pet.bubble({ id, title, description, image, variant, motion, timeout, placement })`；同一 `id` 原地更新；气泡可捆绑动作，按优先级聚合。
  - 交互：`dragging`、`onFling`/`onBounce`/`squash`、`onHitboxPointerMove`、`onDoubleClick`、`onContextMenu`；组件只做渲染与回调，不驱动物理。
  - 对话：`dialogue` + `onDialogue(text)` 打开内置输入 toast；组件不请求模型，宿主自己生成后 `pet.reply(text)`。
  - 配置：`config` 可以是对象或地址；`uri` 是素材基地址；`motions` 可为每个动作显式指定动画名（`DshPetAnimations.motions`）。
- 桌面 Helper（`runtime/electron-helper`）已经把“宠物窗口”做全了：透明/无边框/置顶/不占任务栏、命中区外整窗穿透、Windows 指针兜底、多屏工作区、DPI 线性化、拖拽/抛掷/碰撞、气泡/右键菜单/托盘。**这是最值得借鉴的一层，但不在本方案的 v1 复用范围内。**

### 2.3 许可与边界

- 代码 MIT；素材与形象 **CC BY-NC-SA 4.0**（署名、非商业、相同方式共享）。见 `D:\dsh-pet\docs\README.md` 的「许可」。
- dsh-pet 的本地 API 无鉴权，只监听 127.0.0.1；不能转发公网。
- 它的 AI/人设/记忆/余额/待办与我们的约束冲突，明确不搬。
- dsh-pet 宿主声明的 DSH 兼容版本是 0.2.1-rc.3 / 0.2.2-alpha.2 / rc.1；我们当前是 0.2.1-rc.5。本方案只复用 `dsh-pet-component` 与素材，不装宿主，因此不受这份兼容列表约束；若以后走 A/C 方案，先在临时 profile 验证 rc.5。

### 2.4 为什么不用完整 dsh-pet 宿主

完整宿主已经解决窗口/穿透/物理/公开 API，但这些能力绑着它自己的 AI、人设、对话记忆、余额、天气、待办和设置界面。我们要么把它当黑盒（A 方案，快速验证），要么 fork 后把 AI 层挖掉（C 方案）。本设计选 B：只取**表现层组件 + 素材**，窗口/桥/控制器自己写一小层，产品边界最干净。

---

## 3. 大肥鱼架构的接入点

### 3.1 已有能力

- `screen.js` 的 `recordComment()` 把她的陪伴评论写进 `~/.dsh-fish/presence/YYYY-MM-DD.jsonl`，并维护内存 `recentComments`；`status()` 已返回 `recent`（最近 10 条）、`lastComment`、`busy`、`snapshot`、`on`、`mode`。
- `observe.js` 的 `GET /presence/status` 已通过 BFF 暴露给工作台；8788 的 `#her/presence` 已轮询。
- `index.js` 已经有 `ctx.on('session/event')` 的监听先例（contact、屏幕会话）；`turn/start`、`tool/call`、`tool/result`、`approval/asked`、`turn/end` 都能拿到。
- `screen.js` 已经用 `watchTurn` 收她的自然文本；presence 评论不经过模型工具。
- 8788 BFF 是 Windows 侧唯一稳定入口；Windows→WSL 的 `127.0.0.1:8788` 已实测可用。

### 3.2 缺口

- 没有“宠物动作”的读取接口：评论可以复用 `presence/status.recent`，但显式动作队列、工作状态没有出口。
- 没有把 `session/event` 压成 `thinking/working/result/waiting/success/error` 的聚合；dsh-pet 的 reducer 可直接借鉴。
- 没有桌宠壳；不能把窗口层塞进 `dsh-fish`（零依赖、插件职责不允许）。

### 3.3 新边界

新增一个**只读/易失**的 `pet-view`：

```text
src/dsh-fish/lib/pet-view.js
  - 订阅她（屋子 + 陪伴面）的 session/event
  - 压成 activity: { state, text?, at, sessionId } | null
  - 保存一个内存动作槽 action: { id, motion, text?, at, ttlMs } | null
  - 不写 events.jsonl、不写 presence 台账、不调用模型
```

`observe.js` 暴露：

```text
GET  /dsh-fish/pet/state
POST /dsh-fish/pet/act   { motion, text?, ttlMs? }
```

`workbench/fish/routes.mjs` 增加：

```text
pet/state  GET  P1
pet/act    POST P2  maxBody 64KB
```

工作台 `#her/presence` 增加一排「演一个动作」按钮，POST `pet/act`；不新增人格/数值配置。

---

## 4. 总体架构

```text
Windows 原生（薄壳，独立 Electron 应用）
┌──────────────────────────────────────────────┐
│ renderer: React 19 + <Pet> (dsh-pet-component)│
│   ├─ 透明 WebM 动画 / 14 个动作 / 气泡        │
│   ├─ 右键菜单：演一个动作 / 说话 / 隐藏      │
│   └─ onDialogue → IPC                         │
│ main: 窗口/穿透/托盘/位置持久化               │
│   └─ poller → http://127.0.0.1:8788/api/fish/pet/state
└──────────────────────────────────────────────┘
                    │ Windows → WSL localhost
                    ▼
8788 BFF ──► 8710 dsh-fish
              ├─ pet-view: activity + action
              ├─ screen: presence.recent / snapshot
              └─ /say（点宠物说话时）
```

- 没有 WSLg、没有像素流、没有 Windows 侧监听端口。
- 壳只主动出站 HTTP；不暴露服务，不需要 token。
- v1 单宠物、单窗口；多宠物/物理后续再加。

---

## 5. 动作契约

### 5.1 动作词汇

直接采用 `dsh-pet-component` 的 `Motion`：

```text
idle, turn, moving-left, moving-right, waving,
thinking, working, result, waiting, running, review, failed, success, error
```

`dragging` 只作为手势态，不进用户可选菜单。

### 5.2 动作请求

```ts
type PetAction = {
  id: string            // dsh-fish 生成，壳按 id 去重
  motion: Motion
  text?: string         // 可选，一起弹气泡；≤120 字
  at: number            // epoch ms
  ttlMs: number         // 默认 15000；过期不播
}
```

`POST /pet/act` 校验：

- `motion` 必须在白名单内；未知 → 400；
- `text` trim 后 ≤120 字；空串等价不传；
- `ttlMs` 夹在 1000–60000，缺省 15000；
- 单槽覆盖：新动作直接替换旧动作（v1 不做队列）；
- 返回 `{ ok, action }`；不写事件流。

### 5.3 状态读取

```jsonc
GET /dsh-fish/pet/state
{
  "at": 1794640000000,
  "presence": {
    "on": true, "mode": "event", "busy": false,
    "snapshot": { "app": "game", "mode": "event", "event": "scene_change", "at": 0 },
    "recent": [{ "at": "2026-11-14T08:11:43.116Z", "mode": "event", "event": "scene_change", "text": "…" }]
  },
  "activity": { "state": "thinking", "text": "正在看屏幕", "at": 0, "sessionId": "…" },
  "action": { "id": "…", "motion": "waving", "text": null, "at": 0, "ttlMs": 15000 }
}
```

- `activity` 只给当前展示的一条（按 dsh-pet 的优先级：waiting > error > working > thinking > result > success；同档取最近）。
- `recent` 直接复用 presence 的最近 10 条；壳用 `at` 去重。
- 所有字段都可为 `null`/空；不 500。

### 5.4 事件 → 动作映射

| 大肥鱼事件 | 桌宠动作 | 气泡 |
| --- | --- | --- |
| presence 开启 | `thinking`（循环） | 无 |
| presence 关闭 | `idle` | 无 |
| 新 presence 评论（`event=scene_change`） | `waving` | 她的原话 |
| 新 presence 评论（`event=settlement`） | `success` | 她的原话 |
| `turn/start` | `thinking` | 无 |
| `tool/call`（非 `ask_user_question`） | `working` | 无 |
| `tool/result` | `result` | 无 |
| `approval/asked` / `ask_user_question` | `waiting` | 无 |
| `turn/end completed` | `success` | 无 |
| `turn/end error/max-tokens/timeout` | `error` | 无 |
| `turn/end blocked` | `waiting` | 无 |
| `turn/end aborted` | `idle` | 无 |
| 用户显式点动作 | 所选动作 | 可选 `text` |

优先级（壳内）：

1. 显式 `action`（TTL 内）；
2. 新评论气泡（一次性，播完回 activity）；
3. `activity`；
4. `idle`。

同一动作重复下发默认不重播；显式动作带 `replay: true`。

---

## 6. 薄壳设计

### 6.1 目录

```text
desktop-pet/                 # 独立项目，不进 src/dsh-fish
  package.json
  electron/
    main.ts                  # 窗口、穿透、托盘、位置、poller
    preload.ts               # IPC 白名单
  renderer/
    main.tsx
    App.tsx                  # <Pet> + action controller
    menu.tsx                 # 右键「演一个动作」
  assets/
    config.json              # 我们自己的 motions 映射，不含人设/提示词
    webm/                    # v1 子集，后续再补全
    ATTRIBUTION.md
  test/
```

Electron + React 19 + `dsh-pet-component`；不引入 dsh-pet 的 host/standalone/AI。

### 6.2 窗口

- `BrowserWindow`：`transparent: true`、`frame: false`、`alwaysOnTop: true`、`skipTaskbar: true`、`hasShadow: false`、固定尺寸（默认 462×260，按素材比例）。
- 默认 `setIgnoreMouseEvents(true, { forward: true })`；renderer 用 `pet.geometry` / 命中框判断光标是否在宠物身体或 UI 上，经 IPC 翻转。气泡、右键菜单、对话输入框打开时保持可交互。
- 多屏：`screen.getAllDisplays()`；窗口位置持久化在 `app.getPath('userData')/position.json`；启动时夹到当前工作区。
- 托盘：显示/隐藏、回到主屏、退出；v1 可选。
- 不做窗内漫游/甩动；`dragging` 只用于拖拽手势的姿势切换（v1 固定位置，可先不接）。

### 6.3 渲染与动作控制器

```tsx
<Pet
  ref={petRef}
  config={config}
  uri={{ default: assetBase }}
  size={462}
  dialogue
  onDialogue={sendToBigfish}
  onContextMenu={openActionMenu}
  onHitboxPointerMove={reportPointer}
  onReady={...}
  onError={...}
/>
```

- `assetBase`：Electron 自定义协议 `pet-asset://` 或本地静态服务，避免 `file://` 的 fetch/CORS 问题。
- `config.json` 用 `animations.motions` 显式映射 14 个动作到动画名；v1 只需要：
  - 待机 1、工作状态 6、点击回应 1、拖拽 1、转向/移动各 1；约 12–15 段 WebM。
  - 后续要全量 114 段时直接换 `assets/webm`，不动代码。
- `pet.bubble({ id: 'bigfish', description, motion, timeout })` 展示她的话；同一条评论用 `id` 原地更新。
- `pet.motion({ type, loop, replay })` 播动作；单次动作自动回 idle；循环动作由控制器在 activity 变化时切回。
- 显式动作 TTL：`setTimeout` 后回落到 activity/idle；新动作取消旧定时器。
- 去重：`lastActionId`、`lastCommentAt` 存 `localStorage`，重启不重播旧评论。
- 轮询：main 进程每 2000ms `fetch` BFF，`AbortController` 5s 超时；失败指数退避到 30s；状态不变不 IPC。

### 6.4 说话（v2）

- `onDialogue(text)` → `POST /api/fish/say`；先 `pet.bubble({ id:'chat', title:'…', loading:true, motion:'thinking' })`，回复后原地更新为 `pet.reply(text)`/`pet.bubble`。
- `/say` 最长 75s；壳的请求超时 90s；失败明确显示「没送到」，不假装。
- 不使用 dsh-pet 的 `/chat`（那是它自己的模型）。

### 6.5 物理（v2）

- v1 固定位置，只做动作/气泡；不接 `onFling`/`onBounce`。
- v2 再借鉴 dsh-pet helper 的物理：拖拽采样、初速、重力/反弹/摩擦、跨屏夹取；`dsh-pet-component` 只给回调与参数，运动由宿主积分。
- 物理不是本设计的验收门槛，单独排期。

---

## 7. dsh-fish 侧实现

### 7.1 `lib/pet-view.js`

纯函数 + 一个小服务：

- `reduceWorkStatus(event)`：直接移植 dsh-pet `host/work-status.ts` 的映射（MIT，文件头注明来源）；v1 不做 goal 续跑细分。
- `createPetView({ screen, log, now })`：
  - `noteSessionEvent(session, event)`：只认 `isHerAgent` 且在 web/screen 面的会话；按会话维护 state/task/seq；`turn/end aborted` 清除。
  - `act({ motion, text, ttlMs })`：校验、生成 id、写单槽、返回 action。
  - `snapshot()`：`{ activity, action }`；action 过期返回 null。
  - 纯内存，不落盘；重启后空。
- 不在 `pet-view` 里读屏幕、不写事件流、不调模型。

### 7.2 `lib/index.js`

- 在 `registerObserve` 前创建 `petView`，`deps.petView = petView`。
- 在已有 `session/event` 监听处增加一个：`petView.noteSessionEvent(session, event)`；只处理她屋子/陪伴面的会话。
- `dispose` 时清理定时器。

### 7.3 `lib/observe.js`

- `GET /pet/state`：`{ at, presence: screen.status() 的子集, activity, action }`。
- `POST /pet/act`：读 JSON、校验、`petView.act`；`motion` 白名单与 `dsh-pet-component` 的 `MOTIONS` 一致（复制常量，不 import 外部包）。
- 失败一律 200 + `{ ok:false, note }` 或 400 参数错，遵循现有 `/presence/*` 语义。
- 不新增事件类型，不改 schema。

### 7.4 8788 BFF / 工作台

- `workbench/fish/routes.mjs`：
  - `{ path:'pet/state', methods:{GET:'P1'}, upstream:'fish' }`
  - `{ path:'pet/act', methods:{POST:'P2'}, upstream:'fish', maxBody: 64*1024 }`
- `workbench/assets/pages/her-presence.js`：
  - 增加「演一个动作」一排按钮（waving / thinking / result / waiting / success / error），POST `pet/act`；
  - 不新增人格/数值设置；文案避免「他」「三道门」。
- 测试：BFF 白名单、页面契约、按钮不触发模型。

---

## 8. 安全、隐私与许可

- 壳只访问 `127.0.0.1:8788`；不监听端口、不远程、不落 token。
- 桌宠只显示 `recent`/`activity`/`action` 的文本；不接触屏幕图像、窗口标题、OCR；presence 的隐私边界继续由 `screen.js` 的提示词与 guard 承担。
- `pet/act` 是用户显式动作，不经过模型；不新增可被外部文本诱导的工具。
- 动作/评论不写 `events.jsonl`；`pet-view` 全部易失。
- 素材：代码 MIT；形象 CC BY-NC-SA 4.0，非商业、署名、相同方式共享；About/README 写清来源。若产品要商用，必须换自有人工形象。
- 不把 dsh-pet 的 API 暴露给 Windows 外网；如果未来壳自己起服务，只绑 127.0.0.1。

---

## 9. 测试与验收

### 9.1 单元

- `pet-view`：六档映射、优先级、同档最近、`aborted` 清空、action 白名单/长度/ttl/过期、单槽覆盖。
- `observe`：`/pet/state` 空状态不抛；`/pet/act` 非法参数 400；成功 200。
- BFF：两条新路由在白名单/阶段内；未知路径仍 404。
- 壳：动作优先级、去重、TTL、轮询退避（纯函数单测）。

### 9.2 手工（Windows）

1. 启动薄壳，确认透明、置顶、命中区外点击穿透（能点到下面的游戏/桌面）。
2. 工作台点「演一个动作」→ 2 秒内宠物表演；重复点同一个动作会重播。
3. 触发一次 presence 评论（或手工写 presence 测试）→ 气泡显示她的原话 + `waving`；同一评论不重复。
4. 打开对话输入 → 发一句 → 大肥鱼回复显示成气泡；失败有明确提示。
5. 拖到副屏/混合 DPI，确认位置和尺寸不跑偏；重启后位置恢复。
6. 关闭 BFF/断网，确认壳不崩溃、不刷屏、恢复后继续。

### 9.3 基线

- `src/dsh-fish` 的 `node --test` 全绿（当前 1077，新增后更新）。
- `workbench` 的 `node --test` 全绿（当前 110）。
- 桌宠项目独立测试；不把 Electron 测试塞进 dsh-fish。

---

## 10. 文件改动清单（预计）

| 文件 | 改动 |
| --- | --- |
| `docs/superpowers/specs/2026-11-14-desktop-pet-thin-shell-design.md` | 本文 |
| `src/dsh-fish/lib/pet-view.js` | 新增：activity reducer + action 槽 |
| `src/dsh-fish/lib/index.js` | 接线 petView、session/event |
| `src/dsh-fish/lib/observe.js` | `/pet/state`、`/pet/act` |
| `src/dsh-fish/test/pet-view.test.mjs` | 新增 |
| `src/dsh-fish/test/observe-*.mjs` | 补路由测试 |
| `workbench/fish/routes.mjs` | 两条 BFF 路由 |
| `workbench/assets/pages/her-presence.js` | 动作按钮 |
| `workbench/test/pages.test.mjs` / `routes.test.mjs` | 契约 |
| `desktop-pet/**` | 新增独立 Electron 壳 |
| `desktop-pet/assets/ATTRIBUTION.md` | dsh-pet 素材署名/许可 |

`dsh-fish` 不新增 `dependencies`/`devDependencies`；桌宠项目的 React/Electron 依赖只在 `desktop-pet/package.json`。

---

## 11. 分阶段

- **P1（先做）**：`pet-view` + `/pet/state` + `/pet/act` + BFF + 工作台按钮；用 curl 验证动作队列。
- **P2**：Electron 薄壳 + `dsh-pet-component` + 动作菜单 + presence 评论气泡；Windows 手工验收。
- **P3**：activity 工作状态联动 + 点宠物说话（`/say`）。
- **P4**：拖拽/甩动/多屏/托盘/多宠物/全量动画；再评估是否借鉴 dsh-pet helper 的物理与窗口层。

---

## 12. 开放问题

1. 动作词表是否只要 6 个工作状态 + `waving`，还是允许全部 14 个？菜单文案需要产品定。
2. v1 动画只打包子集（约 15 段）还是全量 114 段（56 MB）？建议先子集，验收后再全量。
3. 薄壳是否要支持“点一下宠物打开工作台聊天”，还是只做内置对话输入？`/say` 的 75 秒等待需要 loading 气泡。
4. activity 是否只跟踪她的屋子会话，还是包括 B 站出门会话/其他面？建议 v1 只 web + screen。
5. 动作队列是否需要持久化/多槽？建议 v1 单槽内存，丢失可接受。
6. 窗口层：薄壳自己写最小透明窗，还是直接借 dsh-pet helper 的窗口/穿透/物理代码（MIT，需署名）？建议 P2 先写最小版，P4 再评估。
7. 素材许可：个人使用可直接用 CC BY-NC-SA；若要商用/公开分发，必须换成自有人工形象。
8. 她能不能自己要求“演一个动作”？v1 不做：不给模型新增工具，避免工具感；先只允许用户显式点击和 presence 评论自动触发。若以后要做，应走一次性授权/按钮预发 token，而不是常驻工具。

---

## 13. 参考与致谢

- dsh-pet v0.4.8（代码 MIT；形象/素材 CC BY-NC-SA 4.0）：<https://github.com/PC2005-cloud/dsh-pet>
  - 本地包与文档：`D:\dsh-pet\`（未执行、未安装）
  - `docs/API.md`、`docs/openapi.yaml`、`docs/CONFIG.md`、`docs/README.md`
- dsh-pet-component 0.2.5（React 组件，MIT）：<https://github.com/dsh-tauri/dsh-pet-component>
  - 本地包：`D:\dsh-pet\related\dsh-pet-component-0.2.5.tgz`
- dsh-pet 的 `host/work-status.ts` 映射逻辑在实现时按 MIT 注明来源。
- 角色“大肥鱼”形象授权：CC BY-NC-SA 4.0（署名、非商业、相同方式共享）。
