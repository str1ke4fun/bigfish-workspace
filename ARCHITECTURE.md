# 大肥鱼项目架构说明

- 版本：2026-11-10
- 状态：**目标架构**（A0–A3 完成后）；当前实况见 §14
- 对应设计：`docs/superpowers/specs/2026-11-10-bili-workbench-integration-design-v2.md`
- 评审：`docs/superpowers/reviews/2026-11-10-bili-workbench-design-review.md`

---

## 0. 这份文档怎么读

这份文档描述的是「B 站工作台设计做完之后」的大肥鱼：三个插件包、两层记忆、事件 v3、单一调度、独立工作台 section。

它不是现状说明书。当前仓库还没有 `src/dsh-bili`，事件还是 v1/v2，工作台 B 站页面仍归 core。两者的差距集中在 §14；实现分段、验收和回滚见设计 v2 的 §11–§12。

---

## 1. 项目定位与设计哲学

大肥鱼不是「角色扮演助手」，而是一条通过事件流长大的鱼。三条底层原则决定了整个架构：

1. **没有人格设置入口。** 人格只能通过事件长出来；设置页只放环境参数（几点醒、刷不刷 B 站、一天几条事件）。任何能让用户直接写「你是一个温柔的……」的入口都被禁止。
2. **事件流是唯一可信源。** `events.jsonl` 只追加，不删除、不改写、不重排。`state.json` 是派生品，随时可由事件流重算。想让她忘，不是删行，而是降低召回。
3. **记忆共享、展示分面。** 她自己的判断与学习跨面可见；原始经历按 `channel` 隔离，避免私聊原话透传到公开面。`surface` 只记来源与展示位置。

围绕这三条，系统分成「person core」和「面插件」：

- core 管她是谁、记得什么、什么时候醒、能看见哪些工具；
- 面插件管某一个面的网络、动作、素材和界面；
- 两个包不互相 import 源码，只通过宿主服务与 `fishCore` 窄接口通信。

---

## 2. 系统总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                          宿主 DSH                                   │
│  tools / systemPrompt / webServer / sessionController               │
│  workspaceRegistry / ctx.slots（settings.section） / connection     │
└───────────────┬──────────────────┬──────────────────┬───────────────┘
                │                  │                  │
      ┌─────────▼─────────┐ ┌──────▼───────┐ ┌────────▼─────────┐
      │     dsh-fish      │ │   dsh-bili   │ │     dsh-wx       │
      │   person core     │ │   B 站面     │ │    微信面        │
      │                   │ │              │ │                  │
      │ events / memory   │ │ bili_*       │ │ wx_* / 提及      │
      │ persona / selfdoc │ │ browse       │ │ 任务 / 表情      │
      │ surface / policy  │ │ outing       │ │ 发送限制         │
      │ guard / ledger    │ │ risk / cover │ │                  │
      │ scheduler / prompt│ │ client/observe│ │                  │
      └─────────┬─────────┘ └──────┬───────┘ └────────┬─────────┘
                │ fishCore         │ bili             │ wx
                └──────────────────┴──────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │        共享运行数据          │
                    │  ~/.dsh-fish/events.jsonl   │
                    │  state / config / owner     │
                    │  tool-ledger / media        │
                    │  bili-session / risk        │
                    └─────────────────────────────┘
```

三条边界：

- **core → 插件**：`ctx.get('bili')` 取聚合状态；插件缺席返回 `undefined`，页面降级。
- **插件 → core**：`ctx.get('fishCore')` 写记忆、贡献工具、挂调度、读写处境段与配置。
- **插件 ↔ 插件**：不直接 import；dsh-wx 通过 `fishGuard` 过滤外来文本，通过 `fishCore.surface` 预留会话。

加载顺序不保证，所有跨插件服务必须懒取；`apply` 顶部不能假设对方已经挂上。

---

## 3. 包与职责

| 包 | 版本（目标） | 职责 | 不拥有 |
| --- | --- | --- | --- |
| `src/dsh-fish` | 0.8.0 | 事件流与派生、两层记忆、人格、身份文档、记忆工具、面注册表、guard、台账、调度节拍、聚合状态页 | B 站网络与动作、B 站调度、B 站 UI |
| `src/dsh-bili` | 0.1.0 | B 站客户端、刷站/选材、3 个工具、评论与回复扫描、风控、封面、足迹、voices、出门会话、B 站提示段、B 站工作台 | 人格、记忆格式、其他面的工具、宿主补丁 |
| `src/dsh-wx` | 0.2.0 | 微信客户端观察、提及识别、任务、表情、发送限制 | 人格、B 站、宿主补丁 |
| `src/speech` | 共享模块（非插件包） | 交流频率与配额控制 | 面判定、记忆 |

`src/speech` 不是第四个插件包：目录里只有 `speech.mjs`，没有 `package.json` 或 `cordis.patch.yml`，由 dsh-wx 等按路径导入；它不参与 profile 的 `dependencies` / `bundles`。

### 3.1 依赖方向

```
dsh-bili ──只读/窄接口──► fishCore（dsh-fish）
dsh-wx   ──只读/窄接口──► fishCore / fishGuard
dsh-fish ──懒取──────────► ctx.get('wx') / ctx.get('bili')
```

- 禁止 `import '../../dsh-fish/lib/...'`。
- 禁止在模块顶层 `ctx.get` 并缓存；服务可能晚到。
- 禁止复制对方的 schema、常量、策略表。

### 3.2 插件装配

每个包都有：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

`cordis.patch.yml`：

```yaml
insert:
  - id: dsh-bili
    name: dsh-bili
```

宿主的 profile 同时列出 `dependencies` 与 `bundles`，两个包即可共存。包名必须与 `cordis.patch.yml` 的 `name` 一致；目录名不参与解析。

有工作台 UI 的包还必须声明：

```json
{
  "exports": { "./client": "./lib/client.js" },
  "dsh": { "client": { "platform": "web", "inject": [] } }
}
```

缺一项，宿主 client-modules 就不会加载 `client.js`。

---

## 4. 运行时拓扑

### 4.1 实例

| 实例 | 端口 | fish home | 用途 | 当前状态 |
| --- | --- | --- | --- | --- |
| 测试 | 8710 | `~/.dsh-fish` | 日常运行、验收 | 在跑 |
| 开发 | 8720 | `~/.dsh-fish-dev` | v3/拆包试验，独立数据 | 当前已退出，A1 前需启动 |
| 工作台 | 8788 | — | 独立 `workbench/server.mjs` | 在跑 |

原则：

- 8710 不拿来做 v3 试验；v3 不可降级，先在 8720 验证。
- 8720 与 8710 使用不同 fish home，事件流不共享。
- 工作台 8788 只读为主，不替代宿主 web 服务。

### 4.2 部署接线

```
~/dsh-plugins/dsh-wx -> <repo>/src/dsh-wx
~/.dsh/profiles/web/node_modules/dsh-fish -> <repo>/src/dsh-fish
~/.dsh/profiles/web/node_modules/dsh-wx   -> <repo>/src/dsh-wx
~/.dsh/profiles/web/node_modules/dsh-bili -> <repo>/src/dsh-bili   # A2 后新增
```

- 主仓：WSL `/home/str1k3/src/bigfish-workspace`（当前交付主线）。
- dev worktree：`/home/str1k3/src/bigfish-workspace-dev`（dev profile 指向它）。
- Windows 仓：`D:\fish-handoff` / `/mnt/d/fish-handoff`；当前落后 107 个提交。继续在旧仓改会制造冲突，先对齐再使用。
- 运行数据（`~/.dsh-fish`、cookie、会话、日志）不进源码仓库。

### 4.3 源码到运行的路径

```
编辑源码（WSL main 或 Windows 仓）
  → node --test（所在系统原生进程）
  → git commit
  → git push
  → WSL git fetch + pull --ff-only
  → 重启 8710（或 8720）
  → 日志/工作台/事件流验收
```

调试期允许直接同步候选文件到 WSL 或共享挂载，但最终源码必须收敛回开发仓库再提交。提交不等于部署，部署不等于验收；报告要分开写。

---

## 5. 数据模型

### 5.1 事件 v3

一行一条 JSON，字段：

```js
{
  id: 'ev_01J...',          // ULID 形状
  v: 3,                     // schema 版本
  ts: '2026-11-10T...',     // ISO 时间
  day: 12,                  // 成长日
  stage: 2,                 // 阶段
  type: 'saw',              // 事件类型
  source: 'system',         // tool | system | timer | ui
  channel: 'core',          // core | wx | qq | web（隐私边界）
  surface: 'bili',          // core | web | wx | qq | bili（来源/展示）
  text: '...',              // 正文，≤2000
  refs: ['BV1...'],         // 引用
  verdict: null,            // confirmed | refuted | refined
  confidence: 0.5,          // 0–1
  flags: [],                // selfmod | unrecorded | weak | truncated
  // 可选子对象
  grant: { ... },           // grant_offer / grant
  refuse: { ... },          // refusal
  days: 2,                  // absence
  reply: { ... },           // bili_reply
}
```

### 5.2 事件类型

| 类型 | 侧 | 层 | 说明 |
| --- | --- | --- | --- |
| `seed` | 系统 | 共同 | 起点，只写一次 |
| `utterance` | 她 | 原始（派生为学习） | 她自己说的话；B 站评论也走这里 |
| `revise` | 她 | 学习 | 改口；必须 refs |
| `narration` | 她 | 学习 | 对自己的说法；必须 refs 或「没想清楚」 |
| `refusal` | 她 | 学习 | 拒绝 |
| `reunion` | 她 | 学习 | 重聚 |
| `answer` / `test` | 系统/她 | 原始 | 对判断的检验 |
| `absence` | 系统 | 原始 | 冷落 |
| `diary` | 系统 | 原始 | 日记 |
| `meta` | 系统 | 原始 | 记账，不进身份文档 |
| `voice` | 系统 | 原始 | 别人的话（评论区） |
| `saw` | 系统 | 原始 | 她看过的视频/画面 |
| `grant_offer` / `grant` | 系统 | 原始 | 规则申请与裁决 |
| `bili_reply` | 系统 | 原始 | 别人回她；不进 beliefs |

`HER_TYPES = ['utterance','revise','reunion','narration','refusal']`。`bili_reply` 不在其中，她编不出来。

### 5.3 两层记忆

| 层 | 事件 | 召回 | 跨面 |
| --- | --- | --- | --- |
| 原始经历层 | `saw` / `voice` / `utterance` / `bili_reply` / `answer` / `test` / `diary` / `meta` | `her_recall` 只翻 `core + 当前 channel` | 不搬运原文 |
| 学习层 | `revise` / `narration` / `refusal` / `reunion` + 派生 beliefs | 身份文档、`derive.facts.sharedBeliefs` | 可见，但跨面去引用化 |

`channel` 是隐私边界，`surface` 是展示来源。B 站公开事实写 `channel='core'`、`surface='bili'`；微信/QQ/屋子的对话写各自 channel。

跨面渲染规则：

- 去掉引号原文、@、URL、邮箱、手机号、QQ/微信号；
- 与来源通道原始事件连续 ≥12 字重合的句子去掉；
- 剩余不足 8 字或删减 >60% 的信念不渲染；
- 永不抛，失败按空串处理。

### 5.4 派生快照

`deriveSelf(events)` 产出：

| 字段 | 含义 |
| --- | --- |
| `day` / `growthDay` / `stage` / `stageName` | 成长日与阶段 |
| `beliefs` / `beliefCount` | 判断（按显著性排序） |
| `scars` | 未想通的拒绝 |
| `narrative` | 对自己的说法 |
| `freshVoice` | 最近读到的别人的话 |
| `recentSaw` | 最近看见的视频 |
| `facts.biliSaid` | 最近 7 天她在 B 站说的话 |
| `facts.biliReplies` | 最近 7 天别人回她的话 |
| `facts.biliThreads` | 按 bvid/rpid 聚合的线程 |
| `facts.sharedBeliefs` | 跨面可见、已去引用化的信念 |

`state.json` 是派生快照，可由 `rebuild()` 重算；不是真相源。

### 5.5 其他数据

| 文件/目录 | 内容 | 规则 |
| --- | --- | --- |
| `~/.dsh-fish/events.jsonl` | 事件流 | 只追加；唯一可信源 |
| `~/.dsh-fish/state.json` | 派生快照 | 可重算 |
| `~/.dsh-fish/config.json` | 环境参数 | 原子写；`persona` 不在白名单 |
| `~/.dsh-fish/owner.json` | mid/nickname/account/cookie | 0600；cookie 不对外 |
| `~/.dsh-fish/tool-ledger/YYYY-MM-DD.jsonl` | 工具台账 | 只读观察；不进事件流；不自动删除 |
| `~/.dsh-fish/tool-ledger/artifacts/` | 大结果 | 脱敏；路径前缀校验 |
| `~/.dsh-fish/media/` | 抽帧拼图 | 3 天清理 |
| `~/.dsh-fish/out/covers/` | 封面缓存 | 7 天 TTL（A2 起） |
| `~/.dsh-fish/bili-session.json` | 出门会话状态 | wsId/sessionId/title/dir/preset/createdAt |
| `~/.dsh-fish/risk.json` | 风控冷却 | until/code/strikes |
| `~/.dsh-fish/home/bili/` | 出门工作区 | 她的 B 站 cwd |
| `~/.dsh-fish/logs/dsh-fish.log` | 插件日志 | 滚动；不含凭据 |

---

## 6. 端到端流程

### 6.1 网页屋子对话

```
用户打开屋子
  → 宿主创建 agent（cwd = ~/.dsh-fish/home）
  → fishCore.surface.current(agent) = 'web'
  → restrict 只给 web 面 5 个常驻工具（含 `read_image`）
  → systemPrompt 挂身份段（selfdoc）
  → 用户说话
  → 她回话 → utterance(channel='web', surface='web')
  → derive 更新 beliefs；identity 刷新
  → her_recall 只翻 core+web
```

### 6.2 定时唤醒

```
scheduler.tick（60s，running 闸）
  → detectAbsence
  → onTick 钩子（bili-browse / bili-replies / bili-outing）
  → ensureSchedule（当天落点）
  → inWindow
  → todayCounts / plan（选卡片）
  → onWake 钩子（bili-material：现场取材）
  → wake
      → prompt.setWake(sessionId, material)
      → 组装唤醒消息（卡片 prompt + 素材 + 链接/封面）
      → sessionController.prompt
  → turn/end → prompt.clearWake
```

关键点：

- `onWake` 是 B 站素材的唯一入口；core 不再 import `lookBeforeWake`。
- 唤醒失败或超时，90 秒兜底只清自己写的那段处境。
- 她醒着但不在上网时段 → 不取材，只说话。

### 6.3 后台刷站

```
onTick('bili-browse')
  → 检查 browse.enabled / perDay / window / risk
  → browsePlan（风控后减半）
  → gather（首页/搜索/相关）
  → candidates / absorb / rankVideos
  → 写 saw（surface='bili', channel='core'）
  → 写 voice（评论区，sanitizeForeign）
  → 写 browse: meta（配额）
  → memory.refreshSelfDoc()
  → return { changed:true }
```

### 6.4 出门会话

```
onTick('bili-replies')
  → scanReplies
      → 新回复：写 bili_reply（reply.rpid 去重）
  → 计算 waiting（有 bili_reply、无 creply）
  → 如果有素材或待回复：
      → sessions.find({title:'去 B 站', surface:'bili'})
      → 不存在则 sessions.create(...)；surface.reserve 内部完成
      → prompt.setWake(sessionId, material)
      → sessions.prompt(sessionId, '（出门看看）')
      → 投递成功：写 cseen:<rpid>
      → 写 biliout:<dk> browse|replies
  → turn/end → prompt.clearWake
```

### 6.5 她在 B 站说话

```
bili_speak
  → 检查 comment.enabled / perDay / window / @ 规则
  → guard.screenOutgoing(text)
  → postComment / postReply
  → 成功：
      → memory.commit(text, {agent}) → utterance(surface='bili', channel='core')
      → 写 my:<rpid>、comment:<dk>、cbody:<rpid>
  → 失败/不确定：不写 utterance；返回 action
```

### 6.6 看视频画面

```
bili_watch
  → 检查 video.enabled / perDay
  → grabFrames（ffmpeg）
  → ocrFrames（tesseract，可选）
  → 写 saw（title + OCR，surface='bili'）
  → 写 watched:<bvid> meta
  → 返回图片路径 + 文本
```

### 6.7 回忆

```
her_recall(query)
  → readEvents
  → channel = channelOfAgent(agent)
  → 只留 channel==='core' || channel===当前通道
  → 搜索/打分/截断（最多 5 条，每条 200 字）
  → 渲染（带事件 id，供 revise/narration 的 refs）
```

学习层的「想法」不靠 `her_recall` 搬运，而靠身份文档里的 beliefs / `sharedBeliefs`，并在跨面时去引用化。

### 6.8 工作台

```
core 现在页
  → /dsh-fish/status
      → core 数据 + ctx.get('bili')?.status()
  → 插件缺席：只显示 core 部分

dsh-bili section
  → /dsh-bili/status|history|footprint|comment|ledger|risk|sheet
  → connection.requestRejection 信任栅栏
```

---

## 7. 接口与扩展点

### 7.1 `fishCore`（core 提供给插件）

| 组 | 关键方法 | 用途 |
| --- | --- | --- |
| `memory` | `append` / `commit` / `appendSystem` / `validate` / `read` / `derive` / `refreshSelfDoc` / `similarity` / `findEcho` / `eventById` | 唯一写入口、只读派生、跨面视图 |
| `toolPolicy` | `contribute` / `uncontribute` / `view` / `ownTools` / `status` | 工具策略贡献 |
| `schedule` | `onTick` / `onWake` / `status` | 单节拍钩子 |
| `prompt` | `setWake` / `clearWake` / `getWake` / `wakeSectionFor` / `withWake` / `watchTurnEnd` / `section` | 处境段与面提示段 |
| `config` | `get` / `getView('bili')` / `patch` / `onChange` | 环境参数读写 |
| `owner` | `read` / `credentials` / `write` / `mentionPrefix` | 主人身份与凭据 |
| `tools` | `wrap` / `wrapRender` / `reveal` / `state` | 返回契约、投影、按需工具 |
| `toolLedger` | `status` / `read` / `artifact` | 台账只读查询 |
| `sessions` | `create` / `find` / `prompt` / `rename` / `list` | 出门会话 |
| `self` | `identity` / `refresh` | 身份文本 |
| `surface` | `register` / `reserve` / `current` / `contribute`（别名） | 面判定与预留 |
| `guard` | `sanitizeForeign` / `looksLikeSecret` / `screenOutgoing` / `crossChannel` | 输入/输出/跨面闸 |

契约细节见设计 v2 §7。

### 7.2 `bili` 服务（插件提供给 core）

```js
ctx.provide('bili', {
  version,
  status(),      // { installed, browsedToday, outingsToday, waiting, riskUntil, lastOutingAt, sessionId, sessionReused }
  history({ days }),
  footprint(),
  commentBody({ bvid, rpid }),
  waiting({ limit }),
  risk(),
  ledger({ date, session, tool }),
  wake({ focus }), // 仅开发模式
  config(),
})
```

core 判空要接受 `undefined`，不要只判 `null`。

### 7.3 宿主扩展点

| 扩展点 | 用途 | 注意 |
| --- | --- | --- |
| `ctx.tools.register` | 注册工具 | 必须早于 agent 创建 |
| `ctx.tools.restrict` | 按 agent 收窄工具 | 只能减不能加；名字必须存在 |
| `agent.ctx.systemPrompt.section` | 挂身份/面提示 | system 角色，不进对话历史 |
| `webServer.register` | 注册路由 | 用 `connection.requestRejection` 守卫 |
| `sessionController` | 建/改/投递会话 | 懒取；缺席时降级 |
| `workspaceRegistry` | 工作区 | 懒取；屋子就绪前会 warn |
| `ctx.slots.register` | 工作台 section | 需要 `exports["./client"]` + `dsh.client` |
| `ctx.provide` / `ctx.get` | 跨插件服务 | 懒取；加载顺序不保证 |

---

## 8. 面与工具策略

### 8.1 面

| 面 | 判定 | 默认优先级 |
| --- | --- | --- |
| `bili` | cwd = `<root>/home/bili` | 最高 |
| `wx` | `wx.isWxSession(id)` 或预留 id | 次之 |
| `qq` | 会话 id 以 `onebot-` 开头 | 次之 |
| `web` | cwd = 她的屋子 | 最低 |

`surface.reserve(id, surface)` 的预分配优先于 matcher；B 站出门会话在创建前就预留 id。

### 8.2 工具表（目标）

| 面 | 常驻 | 按需 | 合计 |
| --- | --- | --- | --- |
| web | 5 个 core（含 `read_image`） | 0 | 5 |
| wx | 5 个 core + 9 个 wx | 13 个 wx deferred | 27 |
| qq | 5 个 core | 7 个 qq deferred | 12 |
| bili | 5 个 core + 3 个 bili | 0 | 8 |

口径说明：`coreEntries()` 的 5 条已经包含 `read_image`，不要再单列一次。设计 v1 的「web 5 / wx 14+13 / qq 5+7 / bili 8」与上表一致：wx 的 14 个常驻 = 5 个 core + 9 个 wx。

### 8.3 可见性规则

- 一个工具只有一个 `surface`；deferred 一定有 `group`。
- `resolveAllow` 按面 → always/revealed → requires → hostNames 过滤。
- `catalog` 只列当前面未打开的 deferred 工具。
- `loadTargets` group 优先；names 必须全在 catalog，否则整次拒绝。
- `her_tools` 只做 `search` / `describe` / `load`，不给 JSON schema。
- `config.tools.allow` 只在 web 面追加，且必须宿主已注册。

### 8.4 贡献限制

- 插件只能在首个对应面 agent 创建前贡献工具；晚加载返回 `pending`，要求重建会话。
- 贡献不能放宽发送闸、配额、guard。
- 贡献只能在宿主已注册的工具名上登记。
- 插件卸载不能回收已生效的 restrict；下一次会话重建生效。

---

## 9. 安全边界

### 9.1 威胁模型

| 威胁 | 入口 | 缓解 |
| --- | --- | --- |
| 微信私聊原话进入 B 站评论 | 召回、身份文档、面提示 | 原始层 channel 隔离；学习层去引用化；B 站提示只读 `viewSurface:'bili'` |
| cookie 泄漏 | owner、bili client、错误日志 | `CredentialHandle` 脱敏；日志闸；投影只用人话错误码 |
| 外来文本注入 | 标题、简介、评论、回复、OCR | `sanitizeForeign`；发评论前 `screenOutgoing` |
| 工具越权 | `toolPolicy.contribute` | 只登记已注册工具；不改发送闸/配额 |
| 路由被外部访问 | `/dsh-bili/*` | `connection.requestRejection` |
| 目录穿越 | `/sheet`、`/ledger`、`/artifact` | 固定前缀 + `path.resolve` 校验 |
| 人格被配置写入 | `config.patch` | `persona` 永不在白名单 |
| 台账泄漏正文 | `toolLedger.read` | 脱敏字段照旧；大结果只读 artifacts |

### 9.2 秘密处理

- `owner.json` 以 `0600` 写盘；`read()` 永不返回 cookie 原文。
- `credentials()` 只在进程内使用；`toJSON` / `toString` 返回 `[redacted]`。
- cookie/token 不进模型、投影、台账、日志、事件流。
- 错误消息只按 `code` 查表，不拼底层 `err.message`。

### 9.3 文案守门词

- 不出现男字旁的「他」，统一写「你」；例外只有「其他/其它」。
- 不出现「三道门 / 四道门」；统一「四个阶段 / 三道瓶颈」。
- 「立场」是独立区块，不是第五关。
- 新增 UI 文案必须过对应测试。

---

## 10. 工作台信息架构

### 10.1 core 页面

| 页面 | 内容 | 插件缺席 |
| --- | --- | --- |
| 现在 | 状态条、时间线、B 站聚合状态 | 只显示 core 部分 |
| 成长 | 阶段、判断、疤、叙事 | 不变 |
| 记忆 | 事件检索、日记、召回 | 不变 |
| 住所 | 屋子会话、工作区 | 不变 |
| 插件 | 插件状态、自检 | 显示 B 站未安装 |
| 原理 | 四个阶段、三道瓶颈 | 不变 |
| 数据 | 备份、恢复、导出 | 不变 |

### 10.2 dsh-bili section

| 子页 | 内容 | 数据 |
| --- | --- | --- |
| 上网 | 刷站开关/次数/时段/分区/关键词/深读/弹幕/voices；看画面开关/条数/帧数/OCR；评论开关/配额/时段/@；避让词/UP/最短时长 | `fishCore.config.getView('bili')` |
| B站 | 视频足迹、评论足迹、正文按需读取、来源标注 | `/dsh-bili/footprint`、`/comment-body` |
| 出门 | 今日次数/配额、最近出门、投递记录、会话入口、待回复 | `/dsh-bili/status`、`/comment?waiting=1`、`/ledger` |
| 证据 | 抽帧图、台账单条、风控解冻 | `/sheet`、`/ledger`、`/risk` |

### 10.3 兼容期

- A2：core 的 B 路由改成代理；插件缺席返回 404 + `BILI_PLUGIN_ABSENT`。
- A3：B 站 section 上线；core「上网」页签隐藏；代理保留一个版本。
- A3 后：删除 core B 路由与 UI；`/config` 仍接受 B 站键。

---

## 11. 部署、升级与回滚

### 11.1 部署

1. 在 `src/dsh-fish` / `src/dsh-bili` 分别跑 `node --test`。
2. 提交并推送；WSL `git pull --ff-only`。
3. 把 `dsh-bili` 加入 profile 的 `dependencies` 与 `bundles`。
4. 建 symlink：`~/.dsh/profiles/web/node_modules/dsh-bili -> <repo>/src/dsh-bili`。
5. 重启 8710（或 8720）。
6. 验收：日志 `apply ok`、`contribute ok`、出门会话复用、工作台页面、事件流。

### 11.2 升级顺序

```
A0（解依赖）
  → A1（接口 + v3，B 站仍在 core）
  → A2（搬包）
  → A3（工作台）
```

每段独立提交、独立验收、独立回滚。不要把 A1/A2/A3 塞进一个 PR。

### 11.3 回滚

| 场景 | 做法 | 数据影响 |
| --- | --- | --- |
| A0 回滚 | git revert | 无 |
| A1 回滚 | 先备份 `events.jsonl`，再 revert；v3 事件会被 v2 读跳过 | 新事件不可见，不丢 |
| A2 回滚 | redeploy A1 提交；卸载插件 | 事件保留；出门会话保留 |
| A3 回滚 | 隐藏插件 section，恢复 core「上网」页签 | 无 |
| 插件停用 | core 代理返回 404；出门会话保留但不再投递 | 无 |

**v3 不可降级**：v2 代码读 v3 会跳过并计数；回退前必须备份，并在独立 fish-home 验证。

---

## 12. 测试与验收

### 12.1 基线

| 套件 | 当前 | 目标 |
| --- | --- | --- |
| `src/dsh-fish` | 813 pass（约 17–18 秒） | A1 ≥ 813 + 新用例；A2 去掉 85 个 B 专项后仍全绿 |
| `src/dsh-wx` | 67 pass / 0.25s | 67 |
| `src/dsh-bili` | 不存在 | ≥ 85 + 新增直测/契约/路由 |

### 12.2 测试层次

| 层 | 内容 |
| --- | --- |
| 单元 | 事件校验、记忆写读、derive、guard、策略、调度、prompt、config、owner、sessions |
| 契约 | `fishCore` 12 组接口（A1 新增 8 组）；`bili` 服务；工具返回契约 |
| 集成 | 事件对齐、面与工具、两层记忆隐私、插件缺席、晚加载 |
| 迁移 | v1/v2/v3 混合、旧 `cseen`、备份恢复、v2 读者跳过 v3 |
| 真机 | 8710 出门复用/台账/工作台；8720 v3 不回退；Windows 同步 |
| 性能 | 核心测试 <60s；dsh-bili <10s；`status()` 不扫全量 |

### 12.3 不算通过

- 为拆包改事件语义、删旧字段，或让她的内容在某个面不可召回。
- `contribute` 变成授权。
- 双调度（日志同分钟两次刷站）。
- 插件缺席时 core 报错或页面空白。
- B 站数据另存一份，与 `events.jsonl` 并行。
- 微信原话进入 B 站 view 或评论上下文。
- `owner.read()` 返回 cookie 原文。

---

## 13. 运维与排障

### 13.1 启动自检

`/dsh-fish/selfcheck` 应显示：

- 插件：`installed`、`version`、`provided`
- 贡献：`id`、工具数、`pending`
- 收窄：`ok`、`applied`、`allow`
- 会话：出门会话 id、`reused`
- 台账：`ok`、当天文件、条数
- 事件：最高版本、v1/v2/v3 计数

### 13.2 日志

统一前缀 `[dsh-bili]`：

```
apply ok
contribute ok id=bili tools=3
tick browse ok picks=4
tick browse skip why=quota
out wake session=<id> reused=true
reply observed n=2 new=1
reply presented rpid=...
risk cooldown remainMin=12
memory write failed type=bili_reply why=...
```

不打印 cookie、正文、完整查询串。日志过 `guard.looksLikeSecret`。

### 13.3 常见故障

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| B 站工具不见了 | 插件没装/没 provide/贡献 pending | 看 selfcheck；重建会话 |
| 出门会话不投递 | `sessionController` 未就绪/会话归档 | 看 `BILI_SESSION_MISSING`；下轮重试 |
| 同分钟两次刷站 | core 旧调用没删 | 检查 `scheduler.js` 是否还 import B 站 |
| 页面 404 | 插件停用/core 代理未注册 | 看 `/dsh-bili/status` 与 `BILI_PLUGIN_ABSENT` |
| 微信原话出现在 B 站 | `crossChannel` 没生效/绕过 derive | 检查 `viewSurface` 与 selfdoc 渲染 |
| v3 后旧版看不到新事件 | v2 读者跳过 v3 | 预期行为；回退前备份 |
| cookie 出现在日志 | 用了 `err.message` 或打印 credentials | 改用 code 查表；检查日志闸 |

---

## 14. 当前实现与目标架构的差距

| 能力 | 当前（2026-11-10） | 目标（A3 后） | 阶段 |
| --- | --- | --- | --- |
| `dsh-bili` 包 | 不存在 | 零依赖包，15 模块 + UI | A2 |
| 事件 schema | v2；无 surface/bili_reply | v3；两层记忆 | A1 |
| `fishCore` 接口 | 4 组；config.patch 空桩 | 12 组窄接口（A1 新增 8 组） | A1 |
| 工具策略 | 冻结 POLICY；restrict 写死 | 内置 + 贡献；动态 ownTools | A1 |
| 调度 | core 直接 import B 站 | onTick + onWake；core 不 import | A1/A2 |
| 出门会话 | 已落地，归 core | 归 dsh-bili；复用逻辑不变 | A2 |
| B 站工具 | 3 个，旧 output.render | 3 个，统一 wrap/project/ledger | A2 |
| 工作台 B 页面 | 归 core | 独立 `settings.section` | A3 |
| 配置 UI | 缺 3 个键 | 补齐 | A3 |
| 测试 | 813 + 67；B 专项 85 | 合计 ≥ 880 + 新用例 | A1–A3 |
| 8720 dev | 已退出 | A1 前启动，独立 fish-home | A0 |
| Windows 仓 | 落后 107 个提交 | 先对齐再使用 | A0 |
| README | 有陈旧表述 | 更新 + 链接本文 | A0 |

---

## 15. 术语表

| 术语 | 含义 |
| --- | --- |
| 面 / surface | 她当前所在的交互面：web/wx/qq/bili；决定工具可见性与提示段 |
| 通道 / channel | 记忆的隐私与召回边界：core/wx/qq/web |
| 原始经历层 | 按 channel 隔离的原文事件 |
| 学习层 | 她的判断、改口、自述；跨面可见但去引用化 |
| beliefs | 从 utterance/revise 派生的判断 |
| 疤 / scars | 未想通的拒绝，永不折叠 |
| 处境段 / wake section | 唤醒时临时挂到 system prompt 的一段「此刻遇到什么」 |
| 出门会话 | 「去 B 站」工作区会话，cwd=`home/bili`，只带 bili 面工具 |
| 工具台账 | 工具调用的只读观察记录，不进事件流 |
| 常驻 / 按需工具 | always / deferred；按需经 `her_tools` 打开 |
| 贡献 | 插件向 `toolPolicy` 登记自己的工具 |
| 双读 | 同一配置的顶层键与 `bili.*` 视图读写一致 |
| 去引用化 | 跨面渲染学习层时去掉引号原文、@、链接、长段逐字重合 |

---

## 16. 相关文档

- 设计 v2：`docs/superpowers/specs/2026-11-10-bili-workbench-integration-design-v2.md`
- 独立评审：`docs/superpowers/reviews/2026-11-10-bili-workbench-design-review.md`
- 原设计：`docs/superpowers/specs/2026-11-10-bili-workbench-integration-design.md`
- 工具披露上层设计：`docs/superpowers/specs/2026-11-09-bigfish-tool-exposure-top-level-design.md`
- Person core 面设计：`docs/superpowers/specs/2026-11-09-bigfish-person-core-surfaces-design.md`
- 工具返回契约：`docs/superpowers/specs/2026-11-09-bigfish-tool-return-contract-design.md`
- 出门会话计划：`docs/superpowers/plans/2026-11-10-bili-outing-session.md`
- 模块硬约束：`src/dsh-fish/AGENTS.md`
