# 大肥鱼 B 站功能集成工作台——设计（修订版 v2）

- 日期：2026-11-10
- 状态：A0 已实施；A1 进行中
- 取代：`2026-11-10-bili-workbench-integration-design.md`（`f53bd0c`）
- 评审：`docs/superpowers/reviews/2026-11-10-bili-workbench-design-review.md`
- 目标架构：`ARCHITECTURE.md`
- 上游：`2026-11-09-bigfish-tool-exposure-top-level-design.md`、`2026-11-09-bigfish-person-core-surfaces-design.md`、`2026-11-09-bigfish-tool-return-contract-design.md`、`2026-11-10-bili-outing-session.md`
- 范围：A0 解依赖 + A1 接口与事件 v3 + A2 拆包 + A3 工作台全量迁移

---

## 0. 摘要

B 站能力今天整包长在 `src/dsh-fish` 里，已经按「面」拆开了判定、工具策略、台账与出门会话，但还有三条硬约束：

1. 记忆层没有对外写入口；
2. 工具面不能由外部插件贡献；
3. 调度只能有一个节拍，而 `wake()` 内部还藏着一次现场刷站。

修订版先做 A0：把 core 对 B 站的反向依赖（`owner→bili.normalizeCookie`、`derive↔voices`、`selfdoc→browse/persona`）解开，避免 A2 搬文件时先弄坏 core。A1 让 core 长出窄接口（`memory` / `toolPolicy.contribute` / `schedule.onTick+onWake` / `prompt` / `config` / `owner` / `sessions` / `toolLedger`），同时把事件升到 v3，并落地两层记忆：

- **原始经历层**按 `channel` 隔离：微信群聊/私聊的原话不会出现在 B 站评论的上下文里；
- **学习层**（她的判断、改口、自述）跨面共享，但跨面渲染必须去引用化，只留她自己的总结。

A2 把 15 个 B 站专属模块、3 个工具、调度钩子、路由搬进新的零依赖包 `src/dsh-bili`，core 删除直接调用并保留一个版本的兼容代理。A3 把 B 站设置页、足迹页、出门页、证据面全部迁到插件自己的 `settings.section`，core 只留聚合与代理。

每段独立验收、独立回滚。A1 期间 B 站代码仍在 core，行为变化限制在记忆层；A2 之后插件缺席时 core 优雅降级。

---

## 1. 背景与现状

### 1.1 今天的事实（2026-11-10 核对）

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 包 | `src/dsh-fish` 0.7.0、`src/dsh-wx` 0.2.0；`src/dsh-bili` 不存在 | `package.json`、目录 |
| 事件 | 323 行，v1=119、v2=204、无 v3；meta 209、saw 75、voice 29、utterance 6 | `~/.dsh-fish/events.jsonl` |
| 测试 | 核心 813 pass / 45.44s；微信 67 pass / 0.25s | `node --test` |
| 运行 | 仅 8710 在跑；8720 未监听；8788 工作台独立运行 | `ps`/`ss` |
| 出门会话 | `bili-session.json` 存在；14:29 新建、14:36/15:20 复用 | 日志、文件 |
| 交付 | WSL `main@f53bd0c` 比 `origin/main` 多 1 个文档提交；Windows 仓停在 11-02，落后 107 个提交 | `git` |

### 1.2 B 站代码的真实边界

**B 专属 lib 文件 15 个 / 3812 行**：

`bili.js`、`browse.js`、`browsejob.js`、`look.js`、`watch.js`、`speak.js`、`comment.js`、`video.js`、`ocr.js`、`cover.js`、`history.js`、`footprint.js`、`voices.js`、`risk.js`、`outing.js`。

`client.js`、`observe.js` 是 core 共用文件，包含 B 站页面与路由，但不能整搬；`prompts.js` 今天不存在，提示常量散在 `browse.js`、`persona.js`、`selfdoc.js`。

### 1.3 三个硬约束（保留自 v1）

1. **记忆层没有对外写入口。** `fishCore` 只有 `surface` / `guard` / `config` / `tools`（`core-service.js:88-98`），`config.patch` 是空桩。
2. **面与策略表是 core 私有的。** `POLICY` 是冻结常量（`tool-policy.js:125-137`），`restrict.js:48-59` 还写死了 10 个工具名；外部插件新增的工具进不了 `resolveAllow` / `catalog` / `her_tools`。
3. **调度必须唯一。** `scheduler.js` 的 `running` 闸串行化 tick；但 `wake()` 内部还会调用 `lookBeforeWake()` 现场刷站（`scheduler.js:296`），只加 `onTick` 会漏掉唤醒素材或双刷。

### 1.4 上游设计与本次偏差

修订版保留上游的「一份记忆、展示分面」「单一策略表」「零依赖」「事件只追加」，但有三处明确偏差，均已获用户裁定：

| 偏差 | 上游 | 本设计 | 理由 |
| --- | --- | --- | --- |
| 召回边界 | recall 取消 channel 过滤 | 原始层按 channel 隔离，学习层共享 | 用户明确不希望微信原话透传到 B 站 |
| 调度 | dsh-bili 自己调度 | core 单 tick + `onTick`/`onWake` | 双定时器会双刷、双写 |
| UI | 第一版可暂留 core | A3 全量迁移 | 用户要求完整拆包 |

---

## 2. 目标与非目标

### 2.1 目标

1. 新增零依赖包 `src/dsh-bili`，拥有 B 站的网络、动作、素材、调度、面提示与工作台 UI。
2. `dsh-fish` 只保留人格、记忆、面判定、guard、台账、调度节拍与聚合状态。
3. 事件升到 v3：`surface` 字段 + `bili_reply` 一等事件；原始层按通道隔离，学习层跨面共享且去引用化。
4. 工作台补齐：出门会话视图、抽帧图、台账单条、待回复正文、风控解冻，以及三个没有入口的配置键。
5. 两包各自 `node --test` 全绿；插件缺席时 core 优雅降级。
6. 修掉 A0 发现的四类反向依赖，core 不再 import 任何 B 站模块。

### 2.2 非目标

- 不新增人格设置入口；B 站配置仍是环境参数（`src/dsh-fish/AGENTS.md` 第 2 条）。
- 不做 QQ 的调度迁移；QQ 仍按旧调度。
- 不改宿主（DSH）代码；只用现有 `ctx.tools` / `systemPrompt.section` / `webServer` / `sessionController` / `workspaceRegistry` / `ctx.slots`。
- 不把 `dsh-mem` 引进来；当前「记忆层」就是 core。
- 不删除、改写、重排任何历史事件；v3 只新增字段与类型。
- 不做「替她发评论」按钮；B 站说话仍由她自己决定。

---

## 3. 不变量（不可协商）

1. **零依赖**：两个包的 `dependencies` / `peerDependencies` / `devDependencies` 永远是 `{}`；测试只用 `node:test`。
2. **事件只追加**：`events.jsonl` 不删、不改、不重排；v3 迁移只在读路径补默认值，不回写。
3. **两层记忆**：原始经历层按 `channel` 隔离；学习层跨面共享，但跨面渲染必须去引用化。`surface` 只记来源与展示位置，不是隐私边界。
4. **工具可见性只由 `tool-policy` 决定**；`config.tools.allow` 仅 web 面兼容。
5. **策略只能收窄**：`contribute` 登记的工具必须在宿主已注册；不改变任何发送闸、配额与 guard。
6. **秘密不外发**：cookie/token 不进模型、投影、台账、日志；所有外来文本过 `guard.sanitizeForeign`，发评论前过 `guard.screenOutgoing`。
7. **两个包互不 import 源码**：dsh-bili 只通过 `fishCore` / `ctx.get('bili')` 与宿主服务通信。
8. **单调度**：B 站只允许 `schedule.onTick` / `schedule.onWake`，不自起 `setInterval`。
9. **UI 文案守门词**：不出现男字旁的「他」、不出现「三道门/四道门」。
10. **插件缺席可降级**：core 不报错、页面有明确文案、bili 面回到 5 个 core 工具。

---

## 4. 目标架构

### 4.1 职责划分

| 包 | 拥有 | 不拥有 |
| --- | --- | --- |
| `dsh-fish`（person core） | 事件流与派生、两层记忆、人格、身份文档、记忆工具（`growth_commit` / `her_recall` / `her_leave` / `her_tools`）、面注册表、guard、台账、调度节拍、聚合状态页 | B 站网络与动作、B 站调度、B 站 UI |
| `dsh-bili` | `bili.js` 客户端、刷站/选材、`bili_look` / `bili_watch` / `bili_speak`、评论与回复扫描、风控、封面、足迹、voices、出门会话、B 站面提示段、B 站设置/足迹/出门/证据 UI | 人格、记忆格式、其他面的工具、宿主补丁 |
| `dsh-wx` | 微信客户端观察、提及、任务、发送限制 | 人格、B 站、宿主补丁 |

### 4.2 依赖方向

```
                 ┌──────────────────────────────────────┐
                 │               宿主 DSH                │
                 │ tools / systemPrompt / webServer     │
                 │ sessionController / workspaceRegistry │
                 │ ctx.slots（settings.section）         │
                 └───────┬──────────────────┬───────────┘
                         │                  │
        ┌────────────────▼──┐            ┌──▼─────────────────┐
        │     dsh-fish       │            │      dsh-bili      │
        │ events / memory    │◄───────────┤  bili_* / browse   │
        │ persona / guard    │  fishCore  │  outing / risk     │
        │ policy / ledger    │  窄接口     │  UI section        │
        │ schedule / prompt  │            │  /dsh-bili/*       │
        └────────┬───────────┘            └──┬─────────────────┘
                 │ provide('fishCore')       │ provide('bili')
                 └──────────────┬────────────┘
                                ▼
                     core 的「现在」页聚合状态
```

两条边：

- **core → 插件**：`ctx.get('bili')` 取聚合状态；插件缺席返回 `undefined`，页面降级。
- **插件 → core**：`ctx.get('fishCore')` 用窄接口写记忆、贡献工具、挂节拍、读写处境段与配置。

加载顺序不保证（profile 可能先加载 wx/bili 再加载 fish），所有跨插件取用必须**懒取**，不能在 `apply` 顶部假设服务已存在。

### 4.3 包结构

```
src/dsh-fish/
├── lib/
│   ├── cookie.js             # A0 新增：normalizeCookie / COOKIE_NAMES
│   ├── similarity.js         # A0 新增：similarity / findEcho / VOICE_FRESH_DAYS
│   ├── core-service.js       # A1：memory / toolPolicy / schedule / prompt / config / owner / sessions / toolLedger
│   ├── schema.js             # A1：v3、surface、bili_reply、reply
│   ├── store.js              # A1：读路径 surface 推断
│   ├── events.js             # A1：登记 bili_reply
│   ├── derive.js             # A1：biliSaid / biliReplies / originChannel / 去引用化
│   ├── recall.js             # A1：原始层 channel 过滤（保持）
│   ├── guard.js              # A1：crossChannel / dequote
│   ├── tool-policy.js        # A1：内置表 + 贡献表
│   ├── restrict.js           # A1：动态 ownTools，不再写死
│   ├── scheduler.js          # A1：onTick + onWake，删除 B 站直接调用
│   ├── identity.js           # A1：prompt.section / withWake / watchTurnEnd
│   ├── selfdoc.js / persona.js # A2：删除 B 站三段与 bili_watch 说明
│   ├── client.js             # A3：保留非 B 页面 + 兼容入口
│   └── observe.js            # A3：保留非 B 路由 + /dsh-fish 代理
├── test/
└── package.json              # 0.8.0（A1 起）

src/dsh-bili/
├── package.json              # name dsh-bili，零依赖，dsh.bundle.patch + dsh.client
├── cordis.patch.yml          # insert: [{ id: dsh-bili, name: dsh-bili }]
├── AGENTS.md                 # 继承 dsh-fish 硬约束 + 本包边界
├── README.md
└── lib/
    ├── index.js              # apply：工具 → 贡献 → 钩子 → 会话 → 路由 → provide
    ├── bili.js               # API 客户端、wbi 签名、cookie、风控冷却
    ├── browse.js             # 候选/黑名单/去重/深读/素材
    ├── browsejob.js          # 槽位、配额预留、后台刷站
    ├── look.js               # bili_look
    ├── watch.js              # bili_watch（A1 起写 saw）
    ├── speak.js              # bili_speak
    ├── comment.js            # 发评论/回楼/扫回复/去重
    ├── video.js              # ffmpeg 抽帧
    ├── ocr.js                # tesseract 识别
    ├── cover.js
    ├── history.js
    ├── footprint.js
    ├── voices.js
    ├── risk.js
    ├── outing.js             # 出门会话 + 投递
    ├── prompts.js            # 新增：B 站提示段（原 BSITE_BRIEF / LOOK_BRIEF / WATCH_RULE / SPEAK_BRIEF）
    ├── client.js             # 新增：工作台 section（设置 / 足迹 / 出门 / 证据）
    └── observe.js            # 新增：/dsh-bili/* 路由
```

`package.json` 必须完整声明客户端：

```json
{
  "name": "dsh-bili",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  },
  "scripts": { "test": "node --test" },
  "dependencies": {},
  "peerDependencies": {},
  "devDependencies": {}
}
```

缺 `exports["./client"]` 或 `dsh.client.platform`，宿主不会加载 `client.js`，A3 的独立 section 不成立。

### 4.4 生命周期

1. 宿主加载 profile，按 `dsh.profile.bundles` 插入插件；加载顺序不保证。
2. `dsh-fish.apply`：挂 `fishCore` / `fishGuard`，注册记忆工具，启动 scheduler。
3. `dsh-bili.apply`：
   - `ctx.get('fishCore')` 懒取；若未就绪，注册 `agent/created` 前的重试或等待宿主后续通知，**不抛**。
   - 注册 3 个工具（必须早于首个 bili agent 创建）。
   - `fishCore.toolPolicy.contribute({ id:'bili', tools:[...] })`。
   - `fishCore.schedule.onTick` / `onWake`。
   - `fishCore.sessions.find/create` 出门会话；`surface.reserve` 由 `sessions.create` 内部完成。
   - `fishCore.prompt.section({ id:'fish:bili', surface:'bili', ... })`。
   - 注册 `/dsh-bili/*` 路由。
   - `ctx.provide('bili', service)`。
4. 卸载：撤销钩子、路由、section、工具贡献；出门会话保留（不删数据）；已建 agent 的 restrict 不回滚，下一次会话重建生效。

---

## 5. 记忆模型 v3（两层）

### 5.1 两层定义

| 层 | 内容 | 作用 | 召回 | 跨面 |
| --- | --- | --- | --- | --- |
| **原始经历层** | `seed`?、`saw`、`voice`、`utterance`、`bili_reply`、`answer`、`test`、`diary`、`meta` | 她经历过/读到过/说过的原文 | `her_recall` 只翻 `channel==='core' || channel===当前通道` | 不跨面搬运原文 |
| **学习层** | `revise`、`narration`、`refusal`、`reunion`，以及 `deriveSelf` 从 `utterance`/`revise` 派生的 beliefs | 她自己的判断、改口、自述 | 身份文档与 `derive.facts.sharedBeliefs` 跨面可见 | 可见，但跨面渲染必须去引用化 |

`seed` 是起点，`channel='core'`、`surface='core'`，属于共同层。

### 5.2 channel / surface 语义

| 字段 | 取值 | 作用 | 写入规则 |
| --- | --- | --- | --- |
| `channel` | `core` / `wx` / `qq` / `web` | **隐私与召回边界** | 面插件按 agent 推断；B 站公开事实一律 `core` |
| `surface` | `core` / `web` / `wx` / `qq` / `bili` | **来源与展示位置** | 写入时必填；旧事件读路径推断 |

- 微信群聊/私聊事件：`channel='wx'`、`surface='wx'`；B 站上下文不可召回原文。
- B 站公开事件（`saw`、`bili_reply`、她发的 `utterance`）：`channel='core'`、`surface='bili'`；可在任何面召回（公开内容）。
- 网页屋子对话：`channel='web'`、`surface='web'`；B 站不可召回原文。
- QQ：`channel='qq'`、`surface='qq'`；B 站不可召回原文。

**为什么 B 站事实写 `channel='core'`**：B 站视频/评论是公开内容，不是私聊；写 core 让「我今天看见过什么」在屋子里也能被想起。隐私边界保护的是微信/QQ/屋子的对话原文，不是公开网页。

### 5.3 事件 v3 schema

`lib/schema.js`：

1. `EVENT_SCHEMA_VERSION` 2 → 3。
2. 新增 `surface` 字段，白名单 `core | web | wx | qq | bili`。
   - 写：`raw.surface` 合法才采用；未知值拒绝 `BAD_SURFACE`（不静默落 core）。
   - 读：没有该字段的 v1/v2 事件按 §5.4 推断，不回写。
3. `ALL_TYPES` 新增 `bili_reply`（系统侧，不在 `HER_TYPES`）。
4. `bili_reply` 带 `reply` 子对象：

```js
{
  type: 'bili_reply',
  source: 'system',
  surface: 'bili',
  channel: 'core',
  text: '对方回复的正文（已过 sanitizeForeign，≤2000；空回复写占位句）',
  refs: ['BV1xxxxxxxxx'],
  reply: {
    bvid: 'BV1xxxxxxxxx',   // 必填，≤32
    rpid: '1234567890',     // 必填，去重键，≤64
    root: '1234567890',     // 根评论 rpid，≤64，可空串
    parent: '1234567890',   // 父评论 rpid，≤64，可空串
    user: '显示名',          // 已 sanitize，≤64
    mid: '12345',           // 对方 uid，≤64，可空串
  },
}
```

校验规则：

- `reply` 必须是对象；`bvid`、`rpid` 非空；其他字段转字符串并截断到 64。
- `text` 为空时写 `（对方发了一条空回复）`，不新增 flag。
- `bili_reply` 不进 beliefs；只进 `derive.facts.biliReplies`。
- `events.js` 必须登记 `bili_reply`（`AGENTS.md` 第 5 条）。
- `CHANGELOG.md` 写迁移与回退说明。

### 5.4 旧事件 surface 推断

读路径 `store.readEvents` / `derive` 统一调用 `inferSurface(ev)`，**不回写**：

| 条件 | 推断 |
| --- | --- |
| `channel === 'wx'` | `wx` |
| `channel === 'qq'` | `qq` |
| `channel === 'web'` | `web` |
| `channel === 'core'` 且 `type === 'saw'`/`voice` 且 refs 含 `BV` 或 text 匹配 B 站素材 | `bili` |
| `channel === 'core'` 且 `text` 以 `browse:`、`looked:`、`watched:`、`comment:`、`creply:`、`cbody:`、`cseen:`、`my:`、`biliout:` 开头 | `bili` |
| `channel === 'core'` 且 `text` 以 `fired:`、`sched:`、`seen:`、`quiet:`、`absence:` 开头 | `core` |
| 其他 | `core` |

B 站前缀表集中放在 `lib/schema.js` 的 `BILI_META_PREFIXES`，测试与工作台共用，避免两处漂移。

### 5.5 写接口 `fishCore.memory`

```js
fishCore.memory = {
  /**
   * 系统侧唯一写入口。内部 validate → appendEvent；不抛。
   * @param {object} raw  { type, text, refs?, reply?, ... }
   * @param {{
   *   source?: 'system'|'timer'|'ui',
   *   channel?: 'core'|'wx'|'qq'|'web',
   *   surface?: 'core'|'web'|'wx'|'qq'|'bili',
   *   agent?: object, day?: number, stage?: number
   * }} opts
   * @returns {Promise<{ok:boolean, event?:object, why?:string}>}
   */
  append(raw, opts = {}),

  /** 她自己的写入：type 必须是 HER_TYPES，source 固定 'tool'。 */
  commit(text, { type='utterance', refs=[], verdict, confidence, agent } = {}),

  /** 系统事实快捷方式：type 必须是系统侧类型。 */
  appendSystem(type, text, opts = {}),

  /** 写前自检，不落盘。 */
  validate(raw, opts = {}),

  /** 只读。includeMeta 默认 false；limit 默认 200，最大 2000。 */
  read({ since, until, types, channel, surface, limit=200, includeMeta=false } = {}),

  /** 派生快照；viewSurface 决定学习层去引用化的目标面。 */
  derive({ now, growthDays, viewSurface } = {}),

  /** 写完 saw / voice / bili_reply / utterance 后刷新身份文档；失败返回 why，不抛。 */
  refreshSelfDoc(),

  /** 纯函数：0–1 相似度，供 voices 选择。 */
  similarity(a, b),

  /** 近 N 天里与 text 最像的 voice/utterance；找不到返回 null。 */
  findEcho(text, { days=7, now } = {}),

  /** 按 id 取事件；不存在返回 null。 */
  eventById(id),
}
```

写入规则：

- `append` 的 `source` 默认 `'system'`；插件不能以 `source:'tool'` 写非 `HER_TYPES`。
- `channel` 优先级：`opts.channel` > `opts.agent` 推断 > `'core'`。
- `surface` 优先级：`opts.surface` > `opts.agent` 推断 > `'core'`。
- `commit` 的 `channel`/`surface` 从 `agent` 推断；B 站 `bili_speak` 传入 `agent`，得到 `channel:'core'`、`surface:'bili'`（B 站 cwd 由面判定）。
- `append` 成功后按类型决定是否 `refreshSelfDoc()`：`seed`、`saw`、`voice`、`bili_reply`、`utterance`、`revise`、`narration` 触发；`meta` 不触发。
- 写失败返回 `{ok:false, why}`，不抛；调用方决定是否降级。

### 5.6 召回与跨面渲染

**`her_recall`**：保持今天的 channel 过滤，不按 `surface` 过滤。

```js
const mine = events.filter((e) => {
  const c = e.channel ?? 'core'
  return c === 'core' || c === channel
})
```

- web 面：`core + web`（含 B 站公开事实）。
- wx 面：`core + wx`（看不到 web/qq/bili 的私聊原文）。
- qq 面：`core + qq`。
- bili 面：`core + bili`（B 站事实是 core，所以看得到；看不到 wx/qq/web 私聊原文）。

**学习层跨面**：`deriveSelf` 继续读全量事件，beliefs 带 `originChannel`。身份文档与面提示段渲染时：

```js
guard.crossChannel(text, { from: originChannel, to: viewSurface, rawTexts })
// → { text, redacted, why }
```

规则：

1. `from === 'core'` 或 `from === to`：原样返回。
2. 去掉引号包裹的原文：`「…」`、`『…』`、`“…”`、`"…"`。
3. 去掉 `@名字`、URL、邮箱、手机号、QQ 号、微信号等可识别信息。
4. 与 `from` 通道最近原始事件做逐字重合检查：连续 ≥12 字重合的句子整句去掉。
5. 剩余文本少于 8 字，或删减超过 60%：整条信念不渲染（返回空串），并计数 `privacy_redacted`。
6. 永不抛；失败返回 `{ text:'', redacted:true, why:'guard-failed' }`。

**展示位置**：

- 身份文档：所有面共用，渲染非 core 来源的信念时走 `crossChannel`（目标面记为 `identity`，等价于全局）。
- B 站面提示段：只展示 `biliSaid` / `biliReplies` / `recentSaw` / `sharedBeliefs`（已去引用化）。
- web 面：不展示 `biliSaid` / `biliReplies` / `recentSaw`，但可展示 `sharedBeliefs`。
- 工作台足迹页：按 `surface` 标注来源，不另存一份 B 站数据。

### 5.7 派生事实

`deriveSelf` 新增只读事实（不改成长门）：

| 事实 | 定义 | 用途 |
| --- | --- | --- |
| `facts.biliSaid` | 最近 7 天 `utterance(surface='bili')`，最多 5 条 | B 站面提示、工作台 |
| `facts.biliReplies` | 最近 7 天 `bili_reply`，最多 5 条 | B 站面提示、待回复 |
| `facts.biliThreads` | 按 `bvid`/`rpid` 聚合的她发的评论与对方回复 | 工作台、去重 |
| `facts.recentSaw` | 逻辑不变，多一个 `surface` 供展示过滤 | 身份文档 |
| `facts.freshVoice` | 逻辑不变，多一个 `surface` | 身份文档 |
| `facts.sharedBeliefs` | beliefs 带 `originChannel`；按 `viewSurface` 去引用化 | 跨面想法透传 |

`biliSaid`/`biliReplies` 不参与成长门（`beliefCount`）；与 `voice` 一致。

### 5.8 迁移与回滚

- 迁移是**读路径**：v2 事件按 §5.4 推断 `surface`；不新增、不改写任何历史行。
- 备份文件头版本升到 3；恢复 v2 备份是升级，允许。
- 回退：v2 代码读 v3 会跳过并计数（`store.readEvents` 既有行为），等于看不到新事件。**回退前必须先备份**；dev 用独立 fish-home 验证。
- 旧 `cseen`（v2）按「已回」读；新 `cseen`（v3）按「已呈现」读。规则见 §6.2。
- `CHANGELOG.md` 必须写迁移说明。

---

## 6. 数据闭环：评论、回复、看视频

### 6.1 她发评论（`bili_speak`）

动作成功后：

1. 写 `utterance`：`{ text: 实际发出的原话, surface:'bili', channel:'core', source:'tool', refs:[bvid] }`。
   - 进 beliefs / 可召回 / 其他面看得到（公开内容）。
2. 保留现有 meta 记账：`comment:<dk> <bvid> <rpid>`、`creply:<dk> ...`、`cbody:<rpid> ...`（配额、工作台正文、旧数据兼容）。
3. 写 `my:<rpid>` meta 作为去重键；同一 rpid 不重复写 utterance。
4. 动作失败或不确定：不写 utterance；`bili_speak` 返回 `{ ok, action:'confirmed'|'unconfirmed'|'failed', code? }`，投影按 return-contract §5.2。
5. 平台回执成功但事件写失败：返回 `action:'confirmed'` + `warning:'memory-write-failed'`；下次扫描用 `my:` 补偿写入（如果 rpid 已知）。

### 6.2 别人回复她（`scanReplies`）

三态状态机：

| 状态 | 标记 | 含义 | 写入点 |
| --- | --- | --- | --- |
| 已观察 | `bili_reply` 事件 | 扫描到一条新回复 | 扫描时；按 `reply.rpid` 去重 |
| 已呈现 | `cseen:<rpid>` meta（v3） | 已投进出门会话/提示段 | 投递成功时 |
| 已回复 | `creply:<rpid>` meta | 她真的回了 | `postReply` 成功时 |

规则：

1. 扫描先取已有 `bili_reply.reply.rpid` 集合，并上旧 `cseen:`；命中就跳过。
2. 新回复：写 `bili_reply`（`surface:'bili'`、`channel:'core'`、`text` 已 sanitize）。
3. 投递成功：写 `cseen:<rpid>`；投递失败不写，下次重试。
4. `postReply` 成功：写 `creply:<rpid>`；如果之前没有 `cseen`，补写一条。
5. 旧数据：v2 的 `cseen:` 按「已回复」读；不计入待回复列表。v3 的 `cseen:` 按「已呈现」读。
6. 待回复列表 = 有 `bili_reply`、无 `creply` 的项；工作台展示正文与时间，只读。
7. `bili_reply` 可被 `her_recall` 翻到；不进 beliefs。

### 6.3 看视频（`bili_watch`）

`bili_watch` 在抽帧/OCR 成功后写：

```js
{
  type: 'saw',
  source: 'system',
  surface: 'bili',
  channel: 'core',
  text: `${title}\n${ocrText}`,
  refs: [bvid],
}
```

- 与 `browse.recordSaw` 的去重共用 `seenBvids`；同一天同一条视频不重复写。
- OCR 文本过 `sanitizeForeign`，截断到 2000。
- `watched:<bvid>` meta 继续保留，用于配额与旧 UI。
- 失败/抽帧失败：不写 `saw`，只写 `watched:` 失败标记（如有）。

### 6.4 出门

- `biliout:<dk> browse|replies` 继续只做记账（meta），不改。
- 出门素材里的 `saw` / `voice` 由插件写，带 `surface:'bili'`。
- 出门会话的正文只进 `fish:wake` 段；对话里只留「（出门看看）」。
- 投递成功后才写 `cseen:`；失败保留 `bili_reply`，下轮重试。

---

## 7. 接口契约

### 7.1 `fishCore.memory`

见 §5.5。

### 7.2 `fishCore.toolPolicy.contribute`

```js
const off = fishCore.toolPolicy.contribute({
  id: 'bili',
  tools: [
    { name:'bili_look',  summary:'看 B 站列表',     tier:'always', kind:'read' },
    { name:'bili_watch', summary:'看一条视频的画面', tier:'always', kind:'read' },
    { name:'bili_speak', summary:'在评论区说话',     tier:'always', kind:'send', safety:'send' },
  ],
  groups: [], // 第一版 bili 无 deferred 组
})
```

行为：

- `tool-policy.js` 从冻结常量改为「内置表 + 贡献表」的合并视图；`resolveAllow` / `catalog` / `loadTargets` / `groupsFor` / `entriesFor` 读同一个视图。
- `restrict.js` 的 `FISH_TOOLS` 改为 `toolPolicy.ownTools()` + 贡献名；禁止再写死。
- 校验：`name` 必须在宿主 `ctx.tools` 已注册；`surface` 不存在、重复名字、跨面名字一律整次拒绝并返回 `why`。
- 贡献变更后，`restrict` 的 allow 集合与 `her_tools` 的 catalog 在**下一步**重算；当前步不抖动。
- **必须在首个 bili agent 创建之前完成**。晚加载时返回 `{ ok:false, why:'LATE_CONTRIBUTION', pending:true }`，不假装已生效；已建会话需要重建。
- 插件缺席时：bili 面只剩 `coreEntries('bili')` 的 5 个工具，与今天 web 面同构。
- `surface.contribute` 保留为兼容别名，内部转调 `toolPolicy.contribute`；新代码只用 `toolPolicy.contribute`。

### 7.3 `fishCore.schedule`

```js
const offTick = fishCore.schedule.onTick({
  id: 'bili-browse',
  everyMs: 60_000,
  order: 20,
  async fn({ now, root, events, config, dk }) {
    // 刷站、回复扫描、出门投递
    return { changed: true }
  },
})

const offWake = fishCore.schedule.onWake({
  id: 'bili-material',
  order: 20,
  async fn({ now, root, events, config, dk }) {
    // 现场取材，等价于 lookBeforeWake
    return { text, intro, picks, riskNote }
  },
})
```

保证：

- 两个钩子都跑在 `scheduler.js` 现有串行 tick 内（`running` 闸之后），**不新建定时器**。
- 执行顺序：`detectAbsence → onTick（按 order）→ ensureSchedule → inWindow → plan → onWake（按 order）→ wake`。
- `onWake` 只在本次真的要唤醒时跑一次；返回的 `text/intro/picks/riskNote` 由 core 合并进唤醒消息，core 不再 import B 站。
- 同一钩子不会并发；抛错只记日志，不打断 tick，也不影响其他钩子。
- `everyMs` 是「至少间隔」：tick 更密时按时间戳跳过。
- core 在 `changed:true` 后重读事件流，供后续步骤看到新事件。
- 插件卸载时调用 disposer；已投递的出门会话保留。

### 7.4 `fishCore.prompt`

```js
fishCore.prompt = {
  setWake(sessionId, text),        // 写这条会话的 fish:wake 段
  clearWake(sessionId),            // 清这条会话的段
  getWake(sessionId),              // 读
  wakeSectionFor(agent),           // 某条 agent 这一轮该看到的处境
  withWake(fn),                    // 标记「这一轮是定时唤醒」，区分人类接触
  watchTurnEnd(sessionId, fn),     // 返回 { off }
  section({ id, order=8600, surface, render }), // 按面挂 section，返回 disposer
}
```

- `section` 内部监听 `agent/created`，只有 `surface.current(agent) === surface` 才挂；`id` 必须以 `fish:` 开头（插件用 `fish:bili`）。
- `render(agent)` 返回字符串；抛错只记日志，不挂空段。
- `setWake`/`clearWake` 参数顺序固定为 `(sessionId, text)`；旧 `identity.setWakeSection(text, sessionId)` 保留为内部实现，不再对外。
- `watchTurnEnd` 封装 `turnend.watchTurnEnd`；回调只跑一次。

### 7.5 `fishCore.config`

```js
fishCore.config = {
  get(),                    // 完整配置
  getView('bili'),          // { browse, video, comment, avoid } 命名空间视图
  patch(partial),           // 顶层键或 { bili:{...} }；返回 { ok, config, why? }
  onChange(fn),             // 返回 off；变更后调用 { config, changedKeys }
}
```

- 存储仍是 `config.json` 的顶层键：`browse.* / video.* / comment.* / avoid.* / ui.*`；**不做文件迁移**。
- `getView('bili')` 把顶层键映射成 `bili.browse` 等；`patch({bili:{...}})` 反向映射。双读测试保证两条路径一致。
- `patch` 走 `normalizeConfig` + `/config` 白名单 + 原子写；`persona` 永不在白名单。
- 写入后调用 `onChange` 监听器；如果宿主支持 `ctx.emit('config/changed')`，同时发一份，但 core 不依赖它。
- 补齐 `LIMITS`：`browse.rankingTids` `[0,4]`；`video.enabled` / `video.ocr` 布尔归一；`browse.keywords` 字符串数组；`comment.lastScanAt` 标记为内部字段（不进 UI、不迁移）。

### 7.6 `fishCore.owner`

```js
fishCore.owner = {
  read(),                    // publicOwner: mid/name/account/hasCookie/hasCsrf/savedAt
  credentials(),             // 进程内 CredentialHandle；toJSON/toString 脱敏
  write({ mid, nickname, cookie }), // 0600 原子写；cookie 走 normalizeCookie
  mentionPrefix(),           // @ 前缀；无昵称返回空串
}
```

`CredentialHandle`：

```js
class CredentialHandle {
  get cookie() { return this.#cookie }
  get csrf() { return this.#csrf }
  toJSON() { return '[redacted]' }
  toString() { return '[redacted]' }
}
```

- `credentials()` 只给受信任的进程内插件；core 在调用点写一条审计日志（不含值）。
- 插件禁止把 handle 存进模块级状态超过一次请求；禁止写日志/台账/事件/模型。
- `read()` 永不返回 cookie 原文；工作台登录卡只用 `hasCookie`/`hasCsrf`。
- `write()` 保留现有 `/owner` 行为；`cookie` 为空表示清除。

### 7.7 `fishCore.tools` / `fishCore.toolLedger`

```js
fishCore.tools = {
  wrap(def, opts),        // 完整结果 + 投影 + 台账
  wrapRender(def, opts),  // 旧 render 工具
  reveal(agent, names),   // her_tools load
  state(agent),           // 当前面工具状态
}

fishCore.toolLedger = {
  status(),                                   // { ok, written, why? }
  read({ date, session, tool, limit=100 }),   // 脱敏后的只读行
  artifact(path),                             // 只读大结果，路径必须在前缀内
}
```

- B 站三个工具在 A2 全部改用 `fishCore.tools.wrap` + `project`；不再用旧 `output.render`。
- `bili_look` / `bili_watch` 返回结构化结果；`bili_speak` 返回 `{ ok, action, code? }`。
- 台账由 core 监听 `tools/result` 自动写；插件只读查询，不自己写台账。
- `artifact` 只允许 `tool-ledger/artifacts/` 下的路径，防目录穿越。

### 7.8 `fishCore.sessions`

```js
fishCore.sessions = {
  create({ title, cwd, preset, surface, agentId }), // 内部 surface.reserve
  find({ title, surface }),                          // 按标题/面找
  prompt(sessionId, text, { signal }),               // 投递
  rename(sessionId, title),
  list({ surface }),
}
```

- `create` 预分配 id → `surface.reserve(id, surface)` → `sessionController.create`；失败返回 `{ok:false, why}`。
- `find` 先查 `bili-session.json`/宿主列表，再按标题匹配；不重复建会话。
- `prompt` 只投递文本；正文进 `fish:wake` 段由调用方先 `setWake`。
- `sessionController` 缺席时返回 `{ok:false, why:'NO_SESSION_CONTROLLER'}`，下轮重试。

### 7.9 `fishCore.self`

```js
fishCore.self = {
  identity({ surface } = {}), // 只读身份文本；按面去引用化
  refresh(),                  // = memory.refreshSelfDoc()
}
```

### 7.10 反向服务 `ctx.provide('bili')`

```js
ctx.provide('bili', {
  version: '0.1.0',
  status(),      // { installed:true, browsedToday, outingsToday, waiting, riskUntil, lastOutingAt, sessionId, sessionReused }
  history({ days }),
  footprint(),
  commentBody({ bvid, rpid }),
  waiting({ limit }),
  risk(),        // { until, code, strikes }
  ledger({ date, session, tool }),
  wake({ focus }), // 仅开发模式
  config(),      // bili 命名空间视图
})
```

- core 的 `/status`、`/memory`、`/away` 通过 `ctx.get('bili')` 取插件数据；`undefined` 时显示「B 站插件没装上」，不抛。
- `status()` 不联网、不读大文件；最多读当天的 meta 与 `risk.json`。
- `wake()` 只在 `config.devmode` 或环境变量允许时可用；生产返回 `{ok:false, why:'DEV_ONLY'}`。

### 7.11 B 站面提示段

- `dsh-bili` 用 `fishCore.prompt.section({ id:'fish:bili', order:8600, surface:'bili', render })` 挂段。
- 内容来自 `lib/prompts.js`（原 `BSITE_BRIEF` / `LOOK_BRIEF` / `WATCH_RULE` / `SPEAK_BRIEF`）。
- core 的 `selfdoc.js` 删掉 `## 上网`、`## 在网上说话`、`## 在 B 站怎么整活` 三段；`persona.js` 删掉 `bili_watch` 的说明文字。
- 提示段只读 `fishCore.memory.derive({ viewSurface:'bili' })` 的 `recentSaw` / `freshVoice` / `biliSaid` / `biliReplies` / `sharedBeliefs`，不自己解析事件流。
- 提示段不写「你应该说什么」；只写面策略与工具用法。

---

## 8. 调度与会话

### 8.1 唯一节拍

core 保持每 60 秒一次 `tick`，顺序：

```
detectAbsence
  → onTick 钩子（按 order；bili-browse / bili-replies / bili-outing）
  → ensureSchedule
  → inWindow
  → todayCounts / plan
  → onWake 钩子（按 order；bili-material）
  → wake
```

- B 站的 `browsejob` / 回复扫描 / 出门投递挂 `onTick`；唤醒素材挂 `onWake`。
- core 删除对 `backgroundBrowse` / `maybeOuting` / `lookBeforeWake` 的直接 import 与调用（A2）。
- 钩子内部自己判：刷站槽位（20 分钟最小间隔）、每日配额、时间段、风控冷却、回复扫描节流（`comment.scanEveryMin`）。
- `running` 闸覆盖 `onTick` 与 `onWake`；一次 tick 内不会并发。
- 日志中出现同分钟两次 `background browse` 视为失败。

### 8.2 出门会话

- 归属迁到 `dsh-bili`，逻辑不变：
  1. `fishCore.sessions.find({title:'去 B 站', surface:'bili'})`。
  2. 不存在则 `fishCore.sessions.create({ title:'去 B 站', cwd:<root>/home/bili, surface:'bili' })`。
  3. 状态写 `bili-session.json`（wsId/sessionId/title/dir/preset/createdAt）。
  4. 素材正文先 `fishCore.prompt.setWake(sessionId, text)`，再 `sessions.prompt(sessionId, '（出门看看）')`。
  5. `watchTurnEnd` 清同一段；90 秒兜底只清自己写的那段。
- 身份段仍由 core 挂（`isHerAgent` 认屋子子目录），插件不重复挂。
- 会话归档/删除后才重建；正常 tick 复用，不新建。

### 8.3 失败恢复

| 失败 | 行为 |
| --- | --- |
| `sessionController` 未就绪 | `sessions.create/find` 返回 `{ok:false, why}`；下轮重试，不抛 |
| 出门会话创建失败 | 本轮不投递；`bili_reply` 保留，下轮重试；不写 `cseen` |
| 投递成功、`cseen` 写失败 | 记 warning；下轮可能重复投递一次，工作台显示重复；不静默丢 |
| `onTick` 抛错 | 只记日志，不影响其他钩子与唤醒 |
| `onWake` 抛错 | core 继续唤醒，只是没有素材；日志记 `BILI_HOOK_FAILED` |
| 风控冷却 | 跳过 B 站网络调用；唤醒仍可发生，提示段带 `riskNote` |

---

## 9. 安全与权限

### 9.1 威胁模型

| 威胁 | 入口 | 缓解 |
| --- | --- | --- |
| 微信群聊/私聊原话透传到 B 站评论 | `her_recall` / 身份文档 / 面提示 | 原始层 channel 隔离；学习层 `guard.crossChannel` 去引用化；B 站提示段只读 `derive(viewSurface:'bili')` |
| cookie 泄漏到日志/台账/模型 | `owner.credentials()`、bili client、错误消息 | `CredentialHandle` 脱敏；`guard.looksLikeSecret` 日志闸；投影只用人话错误码；台账脱敏 |
| 外来文本注入 | 标题/简介/评论/回复/OCR | 一律 `guard.sanitizeForeign`；`bili_speak` 前 `guard.screenOutgoing` |
| 插件贡献工具越权 | `toolPolicy.contribute` | 只允许宿主已注册工具；不改发送闸/配额；跨面名字拒绝 |
| 工作台路由被外部访问 | `/dsh-bili/*` | 与 `/dsh-fish` 相同的 `connection.requestRejection` 信任栅栏 |
| 目录穿越读台账/抽帧 | `/dsh-bili/ledger`、`/sheet` | 只允许固定前缀；`path.resolve` 后校验前缀；404 不泄露路径 |
| 配置写入人格 | `config.patch` | `persona` 永不在白名单；`normalizeConfig` 拒绝未知键 |

### 9.2 发送闸不放松

`bili_speak` 的开关、配额、时段、@ 规则、`guard.screenOutgoing` 全部保留；插件化不放松任何一条。

### 9.3 文案守门词

- 不出现男字旁的「他」，统一写「你」；例外只有「其他/其它」。
- 不出现「三道门 / 四道门」；统一「四个阶段 / 三道瓶颈」。
- 新增 UI 文案必须过 `test/p5.test.mjs` 与 `test/principle-zoom.test.mjs` 的同类扫描；`dsh-bili` 自己的测试也要加一份。

---

## 10. 工作台集成（A3 全量迁移）

### 10.1 UI 归属

| 页面 | 归属 | 说明 |
| --- | --- | --- |
| 「现在」状态条 / 时间线 | core | 通过 `ctx.get('bili')` 聚合；插件缺席时只显示 core 部分 |
| 「成长」「记忆」「住所」「插件」「原理」「数据」 | core | 不变 |
| 「上网」设置页 | **dsh-bili** | 全部 B 站配置迁到插件 section |
| 「B站」足迹页 | **dsh-bili** | 视频足迹、评论足迹、正文按需读取 |
| 「出门」新页 | **dsh-bili** | 见 10.2 |
| 登录卡 / 风控提示 | **dsh-bili** | 数据来自插件自己的服务 |

注册方式：

```js
// dsh-bili/lib/client.js
window.__ModuleLoader__.load({
  id: 'dsh-bili',
  factory: (ctx) => {
    ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-bili',
      order: 8,
      title: 'B 站',
      render: () => <BiliSection />,
    })
  },
})
```

- `package.json` 必须有 `exports["./client"]` 与 `dsh.client.platform='web'`。
- `id` 用 `dsh-bili`，不与 core 的 `fish` 冲突。
- 宿主 0.2.1-rc.5 已支持多 section；旧版宿主才走「core 壳 + `/dsh-bili/*` 代理」，加版本门控，不双实现。

### 10.2 新增「出门」页

- **今天**：出门次数 / 配额、最近一次出门时间、这次带了素材还是只带回复。
- **投递记录**：`biliout:` 记账 + 当次素材摘要（标题列表、回复条数），只读。
- **会话入口**：显示「去 B 站」会话 id、工作区路径、最近一轮时间；提供「现在去一趟」（调用 `bili.wake({focus:'browse'})`，仅开发模式）。
- **待回复**：`bili_reply` 列表，展示正文、时间、bvid；只读。
- **不做**：不提供「替她发评论」按钮。

### 10.3 证据面

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 抽帧拼图 | `GET /dsh-bili/sheet/<bvid>` | 读 `media/sheet-*.png`，只允许 `sheet-` 前缀；找不到 404 |
| 台账单条 | `GET /dsh-bili/ledger?date=&session=&tool=` | 只读，脱敏字段照旧；不提供删除 |
| 待回复正文 | `GET /dsh-bili/comment?waiting=1` | 返回正文与时间，只读 |
| 风控解冻 | `POST /dsh-bili/risk {clear:true}` | UI 二次确认；写审计日志（不含 cookie） |

### 10.4 兼容期

1. **A2 期间**：插件先挂 `/dsh-bili/*`；core 的 `/browse`、`/history`、`/footprint`、`/comment-body`、`/risk`、`/cover` 保留，内部改为 `ctx.get('bili')` 代理；插件缺席时返回 404 + `{ ok:false, code:'BILI_PLUGIN_ABSENT', message:'B 站插件没装上' }`。
2. **A3 期间**：B 站 section 上线；core 的「上网」页签隐藏（不是删除）；保留一个版本周期的路由代理。
3. **A3 之后**：删除 core 里的 B 站路由与 UI 代码；core 的 `/config` 仍接受 B 站键（共用 `config.json`），但设置入口只在插件。

### 10.5 插件缺席 / 停用

- 停用插件后 core 的 `/status`、`/memory`、`/away` 不抛；B 站页面显示「B 站插件没装上」。
- 出门会话仍在（不删数据），但不再被投递；工作台显示「插件停用，投递暂停」。
- bili 面工具回到 5 个 core 工具；已建会话的 restrict 不回滚，需要重建会话。

---

## 11. 实施分段

### A0：解依赖与基线（不改行为）

**目标**：让 A1/A2 有干净的依赖图。

1. 新增 `lib/cookie.js`：搬 `normalizeCookie` / `COOKIE_NAMES`；`owner.js` 改 import；`bili.js` 改 import。
2. 新增 `lib/similarity.js`：搬 `similarity` / `findEcho` / `VOICE_FRESH_DAYS`；`derive.js` 改 import；`voices.js` 改 import；`derive.js` 继续 re-export `similarity`，保持旧测试通过。
3. 梳理 `selfdoc.js` / `persona.js` 对 `browse.js` 的 import；A0 先加注释与测试，A2 再删。
4. 更新根 README 的陈旧表述（出门会话已落地；拆包/v3 未做）。
5. 对齐交付基线：推送 `f53bd0c`；启动 8720 dev 实例；决定 `src/dsh-wx/lib/sticker-panel.mjs` 的去留（不混入本次改动）。
6. 验收：`node --test` 813 pass；无行为变化；`git diff` 只含 import/文件移动。

**回滚**：git revert；没有数据变化。

### A1：接口与事件 v3（core 内，行为变化限制在记忆层）

1. 实现 `memory` / `toolPolicy.contribute` / `schedule.onTick+onWake` / `prompt` / `config` / `owner` / `sessions` / `toolLedger` / `self`。
2. 事件 v3：`surface`、`bili_reply`、`reply`、读路径推断、`events.js` 登记、`CHANGELOG`。
3. `derive` 增加 `biliSaid` / `biliReplies` / `biliThreads` / `originChannel` / `sharedBeliefs`。
4. `guard.crossChannel` + `selfdoc` 去引用化。
5. B 站代码仍在 core，但改成走新接口：
   - `recordSaw` → `memory.appendSystem('saw', ...)`
   - `recordVoice` → `memory.appendSystem('voice', ...)`
   - 出门 → `prompt.setWake` / `sessions`
   - `bili_speak` → `memory.commit` + `my:`
   - `scanReplies` → `memory.appendSystem('bili_reply', ...)` + `cseen`/`creply` 状态机
   - `bili_watch` → `memory.appendSystem('saw', ...)`
6. 调度改成钩子：core 自己注册 `bili-browse` / `bili-replies` / `bili-outing` / `bili-material`，**行为不变**；A2 再把注册搬给插件。
7. 验收：
   - `node --test` 全绿；新增契约测试。
   - 同一 fixture 下，旧 meta 序列与 A1 前一致；新事件与旧记录一一对应（一条 `comment:` ↔ 一条 `utterance`；一条新回复 ↔ 一条 `bili_reply`）。
   - 微信原话不出现在 B 站 view 的 `sharedBeliefs`；纯想法保留。
   - v2 读者读 v3 跳过并计数；备份恢复拒绝新于自己的版本。
8. 回滚：git revert；v3 数据保留，回退前备份。

### A2：搬文件（新包）

1. 建 `src/dsh-bili`：15 个模块 + `prompts.js` + `index.js` + `package.json` + `cordis.patch.yml` + `AGENTS.md` + `README.md`。
2. core 删除对应文件与 import；`scheduler.js` 删除 B 站直接调用；`observe.js` 只留代理；`client.js` 拆出 B 页面。
3. 插件 `apply`：注册 3 工具 → `toolPolicy.contribute` → 挂 `onTick`/`onWake` → `sessions` 建/复用出门会话 → `prompt.section` → 注册 `/dsh-bili/*` → `provide('bili')`。
4. 测试迁移：7 个专项文件 85 例整搬；`p7.test.mjs` 的 7 个 B 用例拆到对应模块；新增 `bili.js` 纯函数直测（`mixinKey`、`signQuery`、`normalizeCookie`、`inCooldown`、`RISK_CODES` 映射）。
5. 验收：
   - `src/dsh-fish` 与 `src/dsh-bili` 各自 `node --test` 全绿；合计 ≥ A1 的用例数。
   - 独立 fish-home 上跑一天，事件流逐类对齐（`saw`/`voice`/`comment`/`creply`/`cbody`/`biliout`/`bili_reply` 条数与内容一致）。
   - 8710 上出门会话可复用；日志无同分钟双刷。
   - 插件停用后 core 不报错，bili 面 5 个工具。
6. 回滚：redeploy A1 提交；卸载插件；保数据。

### A3：工作台

1. B 站 section（上网 / B站 / 出门）迁到插件；core 保留聚合与兼容代理。
2. 新增证据面（抽帧图、台账、待回复、风控解冻）；补三个配置键。
3. core 的「上网」页签隐藏；`/dsh-fish` 的 B 路由改为代理。
4. 验收：
   - 8710 上所有 B 站页面可用；`/dsh-bili/*` 经信任栅栏。
   - 停用插件后 core 页面不报错、出门会话仍在但不再被投递。
   - 文案守门词测试通过；新增页面无「他 / 三道门 / 四道门」。
5. 回滚：隐藏插件 section，恢复 core「上网」页签；代理保留一个版本。

---

## 12. 测试与验收

### 12.1 基线

| 套件 | 当前 | A1 目标 | A2 目标 | A3 目标 |
| --- | --- | --- | --- | --- |
| `src/dsh-fish` | 813 | ≥ 813 + 契约/迁移用例 | 删除 85 个 B 专项后仍 ≥ 728 + 新用例 | 同 A2 |
| `src/dsh-bili` | 不存在 | 不存在 | ≥ 85 + 新增直测/契约 | ≥ 85 + UI 路由用例 |
| `src/dsh-wx` | 67 | 67 | 67 | 67 |
| 合计 | 880 | ≥ 880 + 新用例 | ≥ 880 + 新用例 | ≥ 880 + 新用例 |

「92」只在「85 专项 + p7 的 7 个」口径下成立；文档与验收统一写「85 + p7 拆分」，不再用单一 92。

### 12.2 单元（core）

- `memory.append`：合法/非法类型、`source:'tool'` 非 HER_TYPES 拒绝、`surface` 白名单、`channel` 推断、写失败返回 `why` 不抛。
- `memory.commit` / `appendSystem`：类型限制、source 固定、`bili_reply` 校验。
- `memory.read`：channel/surface/types/limit/includeMeta。
- `derive`：`biliSaid` / `biliReplies` / `biliThreads` / `originChannel` / `sharedBeliefs`。
- `guard.crossChannel`：引号、@、URL、长段重合、短文本丢弃、失败不抛。
- `toolPolicy.contribute`：注册/撤销、未注册名字拒绝、跨面名字拒绝、策略表重算、插件缺席 5 个、晚加载 pending。
- `schedule.onTick/onWake`：串行、异常隔离、`everyMs` 节流、`changed` 重读、`onWake` 只跑一次。
- `prompt`：按 session 隔离、turn/end 清理、90 秒兜底只清自己那段、section 按面挂载。
- `config.patch`：白名单、`persona` 拒绝、原子写、坏值归一、`bili.*` 视图双读、`onChange`。
- `owner`：`read()` 无 cookie、`credentials()` 脱敏、`write()` 0600、日志无值。
- `sessions`：create/find/prompt/rename、`surface.reserve`、sc 缺席降级。
- schema v3：v2 读成推断 surface、v3 写读往返、v2 读者跳过 v3、备份版本拒绝、未知 surface 拒绝。

### 12.3 单元（dsh-bili）

- 85 个 B 专项用例迁移后全绿。
- 新增 `bili_reply` 去重、`cseen`/`creply` 状态机、旧 `cseen` 迁移。
- `bili_speak` 成功写 utterance + `my:`；失败不写；不确定投影。
- `bili_watch` 成功写 `saw`；失败不写。
- `bili.js` 纯函数直测：`mixinKey`、`signQuery`、`normalizeCookie`、`inCooldown`、`RISK_CODES` 映射。
- 出门投递只写自己的处境段；90 秒兜底不误清别的会话。
- `prompts.js` 文案守门词扫描。

### 12.4 集成

- 事件对齐：同一 fixture 分别走 core 旧路径（A1 前快照）与插件新路径，比较事件类型序列与关键字段。
- 面与工具：bili 面 8 个、web 面 5 个、`her_tools` 不跨面、插件缺席 bili 面 5 个。
- 记忆：B 站评论在 web 的 `her_recall` 可查；`bili_reply` 不出现在 beliefs；微信原话不出现在 B 站 view。
- 隐私：构造一条 wx utterance 引用群聊原文 → `sharedBeliefs` 不含该原文；纯想法保留。
- 兼容：插件停用后 core 的 `/status`、`/memory`、`/away` 不抛；`/dsh-fish/browse` 返回 `BILI_PLUGIN_ABSENT`。
- 晚加载：先建 bili agent 再加载插件 → `contribute` 返回 pending，不假装生效。

### 12.5 真机

- 8710：重启后日志出现「出门会话（复用）」；出门一轮里 `bili_look` / `bili_watch` 落台账；工作台「出门」页数据与日志一致。
- 8720（dev）：独立 fish-home，事件 v3 写入后不回退；确认新事件不被旧代码误读。
- Windows/WSL：WSL `main` 推送后，Windows 仓先对齐再改；不直接在落后 107 个提交的仓上开新分支。
- 明确边界：当天刷站配额用尽时，不把「UI 能打开」当成「调度投递已验证」；微信登录页未过时不把「消息收发」写进验收。

### 12.6 性能

- 核心测试基线 45s；A1 新增契约测试后不超过 60s。
- `dsh-bili` 测试目标 < 10s（不含 ffmpeg/tesseract 的环境测试）。
- `memory.read` 默认 200 条；工作台查询分页；`status()` 不扫全量事件。

### 12.7 不算通过

- 为了拆包改事件语义、删旧字段，或让她主动写的内容在某个面不可召回。
- `contribute` 变成授权：没注册的工具被放行、发送闸跟着放松。
- 双定时器或双调度路径（日志里同分钟两次 `background browse`）。
- 插件缺席时 core 报错或页面空白。
- 把 B 站数据另存一份「插件记忆」，与 `events.jsonl` 并行。
- 微信原话进入 B 站 view 或 B 站评论上下文。
- `owner.read()` 返回 cookie 原文，或 `credentials()` 可被 `JSON.stringify` 原样序列化。

---

## 13. 可观测性与故障分类

### 13.1 启动自检

`/dsh-fish/selfcheck` 增加：

| 项 | 期望 |
| --- | --- |
| `biliPlugin` | `installed:true/false`、版本、`provided:true/false` |
| `contributions` | 贡献 id、工具数、`pending` |
| `restrict` | `ok`、`applied`、`allow`（含 3 个 B 工具） |
| `sessions` | 出门会话 id、`reused:true/false` |
| `ledger` | `ok`、当天文件、条数 |
| `eventSchema` | 最高版本、v1/v2/v3 计数 |

### 13.2 运行日志

统一前缀 `[dsh-bili]`，只写结构化短句：

- `apply ok` / `apply pending fishCore` / `apply failed`
- `contribute ok id=bili tools=3` / `contribute pending`
- `tick browse ok picks=N` / `tick browse skip why=quota|window|risk`
- `out wake session=<id> reused=true/false`
- `reply observed n=N new=N` / `reply presented rpid=...` / `reply skipped rpid=...`
- `risk cooldown remainMin=N`
- `memory write failed type=... why=...`

所有日志过 `guard.looksLikeSecret`；不打印 cookie、正文、完整 URL 查询串。

### 13.3 故障分类

| code | 含义 | 处理 |
| --- | --- | --- |
| `BILI_PLUGIN_ABSENT` | core 找不到 `bili` 服务 | 页面提示；不报错 |
| `BILI_CONTRIBUTION_PENDING` | 插件晚于 agent 创建 | 提示重建会话 |
| `BILI_SESSION_MISSING` | 出门会话不存在且创建失败 | 下轮重试 |
| `BILI_HOOK_FAILED` | onTick/onWake 抛错 | 记日志；不影响唤醒 |
| `BILI_RISK_COOLDOWN` | 风控冷却 | 跳过网络调用 |
| `BILI_MEMORY_WRITE_FAILED` | 事件写失败 | 返回 warning；下轮补偿 |

---

## 14. 风险与决策

### 14.1 风险

| 风险 | 缓解 |
| --- | --- |
| 接口定错，两包一起改 | A1 先只做接口与迁移，B 站行为不变；接口加契约测试，A2 前冻结 |
| 事件 v3 不可降级 | 独立 fish-home 验证；发布前备份；CHANGELOG 写清回退方式 |
| UI 迁移期两套入口 | 兼容期只保留代理，不双写；A3 后删旧代码 |
| 双调度 | 只允许 `schedule.onTick/onWake`；A2 同时删除 core 的 B 站调用 |
| cookie 暴露面变大 | `CredentialHandle` 脱敏；不落日志/台账/模型；台账脱敏测试 |
| 反向依赖漏解 | A0 清单逐项验收；`grep` 检查 core 无 B 站 import |
| 晚加载贡献不生效 | 贡献窗口前移；pending 明确报错；会话重建 |
| 封面缓存只写不删 | A2 补 7 天 TTL，与 `media/` 清理策略对齐 |
| `bili.js` 无直测 | A2 补纯函数直测；先测不依赖网络的函数 |
| Windows 仓落后 | WSL main 为交付主线；Windows 先对齐再改 |
| 8720 未运行 | A1 前启动独立 dev 实例；不拿 8710 做 v3 试验 |

### 14.2 决策记录

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 原始层按 `channel` 隔离，学习层跨面共享并去引用化 | 用户明确不希望微信原话透传到 B 站；想法可以透传 |
| D2 | `cseen` = 已呈现，`creply` = 已回，`bili_reply` = 已观察 | 失败可重试、不重复投递；旧 `cseen` 按已回读 |
| D3 | A3 全量迁移，core 留一个版本代理 | 用户要求完整拆包；代理保证回滚 |
| D4 | 旧事件按 §5.4 推断 surface，不回写 | 保留历史来源；符合「事件只追加」 |
| D5 | `toolPolicy.contribute` 为正式接口，`surface.contribute` 为别名 | 遵守单一策略表；避免 surface 越界 |
| D6 | `config` 顶层存储 + `bili.*` 视图，不迁移文件 | 兼容现有配置；满足插件命名空间 |
| D7 | `owner.read()` 不返回 cookie；`credentials()` 脱敏包装 | 安全评审要求；插件仍能发评论 |
| D8 | `bili_reply` 保留 `reply` 子对象 | 去重键需要结构化 rpid；补校验与迁移测试 |
| D9 | 调度用 `onTick` + `onWake` | 覆盖 `lookBeforeWake`；避免双刷 |
| D10 | 宿主多 section 已支持，不做双实现 | 0.2.1-rc.5 已支持；旧版加版本门控 |

### 14.3 剩余待确认（不阻塞 A1）

1. 封面缓存 TTL 7 天还是 3 天：A2 按 7 天实现，与 `media/` 对齐；如果用户要求更短，改配置。
2. 出门页是否展示最近一轮摘要：A3 先只给「最近一轮时间 + 跳转会话」，不复制转录。
3. `bili_reply` 是否参与成长门：不参与，与 `voice` 一致。
4. 旧 `cbody` 何时停写：A3 起 UI 读 utterance；A2 保留双写，A3 后标 deprecated，不删历史。
5. Windows 仓何时对齐：A0 先只读核对；是否在 Windows 重建克隆由用户决定，不在本设计内自动执行。

---

## 15. 关键文件与变更清单

| 文件 | 角色 | 阶段 |
| --- | --- | --- |
| `src/dsh-fish/lib/core-service.js` | `memory` / `toolPolicy` / `schedule` / `prompt` / `config` / `owner` / `sessions` / `toolLedger` | A1 |
| `src/dsh-fish/lib/schema.js` | v3：`surface`、`bili_reply`、`reply`、推断表 | A1 |
| `src/dsh-fish/lib/store.js` | 读路径推断；append 不变 | A1 |
| `src/dsh-fish/lib/events.js` | 登记 `bili_reply` | A1 |
| `src/dsh-fish/lib/derive.js` | `biliSaid` / `biliReplies` / `biliThreads` / `originChannel` | A1 |
| `src/dsh-fish/lib/guard.js` | `crossChannel` / 去引用化 | A1 |
| `src/dsh-fish/lib/tool-policy.js` | 内置表 + 贡献表 | A1 |
| `src/dsh-fish/lib/restrict.js` | 动态 ownTools | A1 |
| `src/dsh-fish/lib/scheduler.js` | `onTick` / `onWake`；删除 B 调用 | A1/A2 |
| `src/dsh-fish/lib/identity.js` | `prompt` 原语 | A1 |
| `src/dsh-fish/lib/selfdoc.js` / `persona.js` | 删 B 站三段与 `bili_watch` 说明 | A2 |
| `src/dsh-fish/lib/client.js` | 拆出 B 页面；保留非 B | A3 |
| `src/dsh-fish/lib/observe.js` | 保留非 B 路由 + 代理 | A2/A3 |
| `src/dsh-fish/lib/cookie.js` | A0 新增 | A0 |
| `src/dsh-fish/lib/similarity.js` | A0 新增 | A0 |
| `src/dsh-bili/**` | 15 个模块 + 3 工具 + prompts/client/observe + 测试 | A2/A3 |
| `src/dsh-fish/test/schema.test.mjs` | v3 迁移与拒读 | A1 |
| `src/dsh-fish/test/core-service.test.mjs` | 新接口契约 | A1 |
| `src/dsh-bili/test/**` | 85 个迁移用例 + 新增直测 | A2 |
| `CHANGELOG.md` | v3 迁移与回退说明 | A1 |
| `README.md` | 更新陈旧表述、加架构链接 | A0 |

---

## 16. 完成定义（DoD）

- [ ] A0：core 无 B 站反向 import；813 测试全绿；README 更新；`f53bd0c` 已推送；8720 可启动。
- [ ] A1：六组接口契约测试全绿；事件 v3 写读往返；旧事件推断；两层记忆隐私测试；旧 meta 对齐。
- [ ] A2：`src/dsh-bili` 零依赖、3 工具、`onTick/onWake`、出门复用、路由、`provide('bili')`；两包测试全绿；插件缺席降级。
- [ ] A3：B 站 section 独立加载；设置/足迹/出门/证据页可用；core 代理与 404 文案；文案守门词通过。
- [ ] 隐私：微信原话不进 B 站 view/评论；cookie 不进日志/台账/模型；台账脱敏。
- [ ] 运维：自检显示插件/贡献/会话/台账状态；故障分类可查。
- [ ] 交付：提交 SHA、推送、WSL 拉取、8710/8720 验证、Windows 同步状态分别报告；不把「UI 能打开」写成「消息收发已验收」。

---

## 17. 下一步

1. 本 spec 评审通过后，用 `writing-plans` 产出 A0 + A1 的实施计划（解依赖 + 接口 + 事件 v3）。
2. A0/A1 合并并验证后，再为 A2 / A3 各出一份计划——不在同一份计划里跨三个包。
3. A2 前冻结接口契约；A3 前确认宿主 `settings.section` 版本门控。
