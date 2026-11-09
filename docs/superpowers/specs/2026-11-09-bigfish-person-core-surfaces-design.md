# 大肥鱼个人核心与分面工具架构

日期：2026-11-09
状态：设计待评审；未实施
子设计：[工具返回契约：完整记账与选择性透传](2026-11-09-bigfish-tool-return-contract-design.md)

## 1. 背景与已确认的决策

大肥鱼现在同时长在 Web/home、微信（`dsh-wx`）、QQ（`onebot-*`）和 B 站活动上，但四块的工具、提示词和记忆边界是混在一起的：

- 工具面靠一份全局 allow 名单收窄，Web 会话能看到微信工具，微信能看到 B 站工具，QQ 反而可能看不到 `qq_*`。
- 身份文档是一份，所有会话共用；B 站说明、微信群规矩、唤醒续接会出现在不属于它的面上。
- B 站评论只写 `meta`，`her_recall` 跳过 `meta`；别人回她的评论只进唤醒提示词，不进事件流。她说过什么、别人回了什么，对她自己基本不可见。

2026-11-09 用户确认了四条方向：

1. **core 共享**：在这个环境里的所有对话都走大肥鱼；记忆是一份，不按通道切成互不相通的几份。
2. **B 站评论出自她的判断**：评论和她对评论的回复都是她自己的话，应进入判断，而不是只当素材。
3. **B 站相关回复进入日志并继续沉淀**：别人回她的话要成为一等事件；她回完之后形成可召回、可观测的完整线索。
4. **B 站独立出门会话**：B 站不再是 Web 会话里的一个工具组，而是独立 workspace/session，按面拆工具。

本设计把“人”和“面”分开：**person core 只有一份记忆、一套人设、一组记忆工具；每个面只拥有自己的对话工具和提示词。** 拆工具是为了隔离上下文，不是为了隔离记忆。

## 2. 目标与非目标

### 目标

- 一份 `events.jsonl` 作为唯一事实源，Web / WX / QQ / B 站都写进同一份记忆；`surface` 只记来源，不再当隐私墙。
- B 站评论和回复成为 `utterance`，进入 `deriveSelf` 的 `beliefs`；别人的回复成为一等 `bili_reply` 事件；三者按 `root:<rpid>` 串成线程。
- B 站拥有独立的出门 workspace/session，有自己的调度、提示词和工具面；出门会话的历史不占 Web/home 的上下文。
- 工具分两类：记忆沉淀原子能力（所有面常驻）与对话原子能力（按面拆分，必要时渐进披露）。
- 把“可揭示集合”从“全局注册表减已可见”改成显式策略表；`her_tools` 只揭示当前面策略允许、且宿主真的注册了的工具。
- Web/home、WX、QQ、B 站四面的提示词段按面挂载；修掉当前按 cwd 挂微信段、`wakeText` 全局、carry 全局等串扰。
- 工具返回拆成“完整台账 + 选择性模型投影”：台账记全，模型只看闭环必需信息和必要 handle，不把 JSON、坐标、置信度、内部 id 塞进上下文。
- 拆出 `dsh-bili`，让 B 站插件只通过 `fishCore` 服务读写记忆，不再直接依赖 `dsh-fish` 内部文件。

### 考虑过但不采用

- **保留一个 Web 会话，只把 B 站工具折叠起来**：上下文仍然混在一起，B 站活动没有自己的节奏，也解释不了“她为什么现在去刷站”。
- **按通道各存一份记忆**：实现简单，但违背“core 共享”；她在微信里学到的东西到了 Web 就不算数，人设会分裂。
- **所有工具收进一个通用 dispatcher**：上下文最省，但参数校验退到运行时，常见动作多一轮目录查询；已有调研也不推荐先做通用 dispatcher。
- **把 B 站包成一个 agent-as-tool**：B 站不是一次可委托的子任务，而是持续活动的面；包成工具会丢掉它自己的会话、调度和观察窗口。

### 非目标

- 不改四条黑名单、`guard.js` 的输入过滤语义，也不改 `growth_commit` 作为唯一通用判断写入口的定位。
- 不删除、改写、重排任何历史事件；不把 `events.jsonl` 迁移成另一种存储。
- 不新增人格设置界面、好感度、亲密度或任何可直接指定性格的入口。
- 不为“逐轮增量工具协议”改 DSH 宿主；当前 `openai-completions` 路由仍整表重发 schema，可见集合变化会影响一次缓存，但不需要宿主补丁。
- 不在本轮把设置页和观测台的所有 B 站 UI 搬进 `dsh-bili`；第一版允许 UI 暂留 core，只把数据所有权和工具面拆干净。
- 不把微信/QQ 的原始会话历史搬进事件流；共享的是她沉淀下来的记忆和判断，不是每一轮原始消息。

## 3. 现状事实与诊断

### 3.1 当前工具面

以当前 dev 分支为例：微信插件注册 18 个 `wx_*` 入口，当前 `config.tools.allow` 实际放行 10 个；其余面共享同一份收窄逻辑。

| 面 | 现在能看见的工具 | 问题 |
| --- | --- | --- |
| Web/home | 10 个 fish 工具 + `read_image` + `config.tools.allow` 里的微信工具 | 微信工具和 B 站说明漏进主机对话 |
| WX | 同一份 allow 名单 | B 站工具仍在名单里，B 站说明全局可见 |
| QQ | 同一份 allow 名单，通常没有 `qq_*` 补充 | 自己的工具反而可能看不见 |
| B 站 | 没有独立面，借用 Web/home | 活动上下文和 host 对话互相挤 |

源码事实：

- `src/dsh-fish/lib/restrict.js:48-66` 的 `FISH_TOOLS` / `HER_TOOLS` 是所有面共用的固定名单。
- `src/dsh-fish/lib/restrict.js:173` 的 guard 用创建时固定的 `allowSet = new Set(allow)`；放宽可见性后，新揭示的工具会被 guard 挡住，必须改成可变集合。
- `src/dsh-fish/lib/store.js:139-148` 的 `channelOfAgent` 用 `onebot-*`、`wx-` 和硬编码的 `/home/str1k3/.dsh-wx/session.json` 判断通道；微信主会话是 uuid 形状，只能靠这个文件。
- `src/dsh-fish/lib/identity.js:75` 的 `wakeText` 是模块级全局变量，不按 session 区分。
- `src/dsh-wx/lib/index.js` 用 `cwd === HER_DIR` 判断是否挂微信段；home 会话的 cwd 也可能指向同一目录，因此微信说明会漏进 Web。
- `src/dsh-fish/lib/talkmem.js` 的 `talk-recent.json` 是全局一份，carry 会随身份文件进入所有通道。

### 3.2 B 站记忆断点

| 链路 | 现在写什么 | 后果 |
| --- | --- | --- |
| `bili_speak` 发评论/回复 | `speak.js:54-60` 只把 `said` 返回给模型；下层 `postComment`/`postReply` 只写 quota meta | 她说过的话没有可召回的事件 |
| `postComment` | `comment.js:245-258` 写 `meta comment:` / `meta cbody:` | `her_recall` 跳过 `meta`，不可见 |
| `postReply` | `comment.js:301-327` 写 `meta creply:` / `meta cseen:` / `meta cbody:` | 同上；回复只在配额账里 |
| `scanReplies` | `comment.js:143-168` 返回数组；`scheduler.js:354-357` 渲染进唤醒提示词 | 别人的回复不进日志；没回就每轮重扫 |
| `bili_watch` | `watch.js:88-92` 写 `meta watched:<日期> <bvid>` | OCR 内容不落记忆，只剩配额标记 |
| `bili_look` / 后台刷站 | `browse.js:276-292` 写 `saw` | 方向正确，但 `derive.js:496-499` 只保留 7 天，身份文档只摆 3 条 |

事件流实际证据（`~/.dsh-fish/events.jsonl`，2026-11-09）：

- 263 条事件里 `saw` 55 条、`voice` 24 条，说明“看过”在记账；
- `meta` 里 `comment:` 只有 2 条，`cbody:` 为 0 条；
- 没有 `bili_reply` 之类的一等回复事件。

结论：**看视频有很浅的记忆；发评论和收到回复基本没有记忆。** 用户观察到的“她发评论、看了视频对她没有影响”与事件流一致。

### 3.3 当前 `utterance` 的副作用边界

`deriveSelf` 把每条 `utterance` 都当判断，同时顺带做四件只属于“和 host 对话”的事：

- 改她对他的称呼（`pickName`）；
- 触发“我一直在……”式 `narrative`；
- 置 `spokenSinceSeen`，参与冷落/沉默检测；
- 用 `CORRECTION_RE` 标记 `corrected`，参与“她改口了没有”的判断。

B 站评论进入 `beliefs` 之后，这四件事不能跟着发生；否则一句评论区玩梗会改称呼、改自我叙事、冒充“她对他开口了”，或者把评论区争论算成她改了立场。

## 4. 目标架构

### 4.1 person core + surfaces

```text
┌──────────────────── dsh-fish：person core ────────────────────┐
│ events.jsonl（唯一事实源，事件带 surface）                    │
│ deriveSelf / selfdoc / persona / identity                     │
│ growth_commit / her_recall / her_leave / her_tools            │
│ guard / settings / home / wake / observation                  │
└──────────▲──────────────▲──────────────▲──────────────▲───────┘
           │              │              │              │
     ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴──────┐
     │ web/home  │  │ wx        │  │ qq        │  │ bili       │
     │ 和host说话│  │ dsh-wx    │  │ onebot    │  │ 出门会话   │
     └───────────┘  └───────────┘  └───────────┘  └────────────┘
```

- **person core**：一份事件流、一份派生状态、一份核心人设、一组所有面都可用的记忆工具。
- **surface**：一个会话从哪里来、能看见哪些工具、挂哪几段提示词、短期上下文存哪。
- **B 站是活动面**，不是消息通道：只出站，按自己的节奏出门；它的经历写 core，所有面都记得。

### 4.2 一份事件池，`surface` 只记来源

- 事件流只有一份。Web / WX / QQ / B 站的写入都进同一份 `events.jsonl`。
- `channel` 保留为旧字段和来源标记；新的可见性规则不再按通道过滤。`her_recall` 翻的是整份事件流，`channel`/`surface` 只影响展示和提示词。
- 新增 `surface` 字段：`web | wx | qq | bili`。旧事件没有这个字段时按顺序推断：`saw`/`voice` 和带 B 站前缀的 `meta`（`looked:/browse:/watched:/comment:/creply:/cseen:/cbody:`）→ `bili`；`channel: wx` → `wx`；`channel: qq` → `qq`；其余（含 `core`）→ `web`。
- 原始会话历史仍按面隔离：WX 群、QQ 群、Web 会话、B 站出门会话各自独立；共享的是她沉淀下来的事件，不是每一轮原始对话。
- `web` 面默认是她的 home 会话，不是所有 DSH 工作区；普通编码/项目会话不注册为 surface，不会被当成她。

### 4.3 `fishCore` 服务

`dsh-fish` 通过 `ctx.provide('fishCore', ...)` 暴露核心能力。面插件不直接 import core 内部文件：

```text
fishCore = {
  memory:  { commit(raw, opts), appendSystem(raw, opts), read(), recall(query) },
  self:    { derive(events?), doc(surface), sections(surface) },
  surface: { register({ id, match, sections, tools }), current(agent), list() },
  guard:   { sanitizeForeign, screenOutgoing, looksLikeSecret },
  config:  { get() },
  sessions:{ ensure({ id, title, dir, preset }), prompt(id, text, signal?) },
  toolLedger: { write(entry), artifact(bytes), read(query) },
}
```

- `surface.register` 是声明，不是工具注册本身；工具仍由各插件用 `ctx.tools.register` 注册。
- `surface.current(agent)` 返回 `web | wx | qq | bili | null`；判定顺序由注册的 matcher 决定，不再用 cwd 猜。注册是白名单：没有 matcher 命中的普通 DSH 会话返回 `null`，不挂身份、不做她的工具收窄。
- `memory.commit` 用于她署名的写入（评论、回复、留言、判断），`memory.appendSystem` 用于系统侧写入（`saw`、`bili_reply`、quota meta）。两者都做校验、补 `surface`、写盘；面插件不直接 `fs.appendFile`。未显式给 `surface` 时，从 `opts.agent` 推断并补上，保证 `growth_commit` 在 B 站出门会话里写的判断也带 `surface: bili`。
- `growth_commit` 仍是唯一的**通用判断写入口**。`bili_speak` / `postReply` 是通道动作，成功后由 core 用同一校验路径追加 `utterance`；不新增一个模型可写的通用判断入口。
- `self.doc(surface)` 给 `identity.js` 组装提示词用；core 段所有面共享，surface 段只给匹配的面。
- `toolLedger` 记录每次工具调用的完整参数、完整结果、耗时、错误、引用 id 和实际模型投影；它是审计与观测台账，不是她的记忆。写记忆的工具仍要另写 `events.jsonl`，两者不互相替代。详见子设计。

## 5. 事件模型 v3

### 5.1 字段与类型

`EVENT_SCHEMA_VERSION` 从 2 升到 3。v3 只做新增，不改旧字段语义：

- 新增 `surface: 'web' | 'wx' | 'qq' | 'bili'`；旧事件读取时按 4.2 的规则推断（B 站 `saw`/`voice`/前缀 `meta` 优先归 `bili`，其余按 `channel`）。
- 新增事件类型 `bili_reply`（系统侧写，不在 `HER_TYPES` 里）。
- `channel` 保留；新写入默认 `core`，但 `surface` 才是面的来源。
- `ALL_TYPES` 加入 `bili_reply`；`validateEvent` 保留并校验 `surface`，未知值按 `web` 处理并记一条日志。
- 备份/恢复沿用现有版本规则：恢复比当前版本新的档必须拒绝；v2 档继续可读。

实现时注意：事件类型注册点在 `lib/schema.js` 的 `ALL_TYPES`（`lib/events.js` 目前是唤醒模板的 `CATALOG`，不是事件类型表）。新增类型时同步更新 `EVENT_SCHEMA_VERSION`、CHANGELOG 和相关校验，避免只在文档里“注册”了。

### 5.2 B 站评论与她自己的回复

`bili_speak` 成功发评论或回复后，除原有 `meta` 配额记账外，写：

```text
type: 'utterance'
source: 'tool'
surface: 'bili'
channel: 'core'
text: 真正发出去的那句话
refs: [bvid, 'root:<rootRpid>', 'reply:<parentRpid>', 'my:<newRpid>']
```

规则：

- 进 `beliefs`，参与判断、改口、矛盾检测和 `her_recall`。这是用户确认的“评论出自她的判断”。
- `surface === 'bili'` 的 utterance **不执行** `pickName`、`narrative`、`spokenSinceSeen`、`corrected` 这四项 host 对话副作用；只 push 进 `beliefs`。
- `refs` 里的 `root:` / `reply:` / `my:` 是线程键。顶层评论的 `root` 和 `my` 都是新 `rpid`，不带 `reply:`；楼中楼才带 `reply:<parentRpid>`。`utterance` 不属于 `revise`/`narration`，本来就不触发“refs 必须指向已有事件”的校验；以后若要在别的类型上支持线程键，再按 `ev_` 前缀区分。
- 写入前按 `my:<rpid>` 去重，避免工具重试写出两条；先发后写，事件写失败不回滚已发评论，但要记诊断，下一次扫描可按 `rpid` 补写。
- 原有 `comment:` / `creply:` / `cseen:` 记账保留，配额和“已处理”判断继续用它们；`cbody:` 新写入可以停止，观测台改读 `utterance`；旧 `cbody:` 继续可读。
- 历史评论不重写成 `utterance`：旧记录只有 quota meta，没有足够信息还原成判断；v3 起新发的评论和回复才进 `beliefs`。

### 5.3 别人回她：`bili_reply`

`scanReplies` 发现新回复时，按 `reply:<rpid>` 去重，写：

```text
type: 'bili_reply'
source: 'system'
surface: 'bili'
channel: 'core'
text: '「谁」：回复原话'
refs: [bvid, 'root:<rootRpid>', 'reply:<rpid>']
```

- 文本先过 `guard.sanitizeForeign`，作为外来素材落盘，不是指令。
- 不进 `beliefs`：别人的话不是她的判断。但它是一等记忆，`her_recall` 翻得到。
- `scanReplies` 的返回改为“从事件流取未呈现列表”：
  1. 网络扫新回复，写 `bili_reply`；
  2. 写完重新读一次事件流（不要复用扫描前的快照），找最近窗口内、还没有对应 `cseen` 的 `bili_reply`，渲染给出门会话；
  3. 触发成功送达后再写 `cseen:<dk> <rpid>`（沿用现有格式），表示“这条已经递给她看过了”，避免每轮重复提示；送达失败不写，下一轮还能再递。
- `creply:` 仍只在她真正回复后写，用来标记“已回”；`cseen:` 标记“已呈现”。两者分开，她看过不回也不会被反复追问，日志里仍保留完整线程。
- 她回了之后，`postReply` 照旧写 `creply:`；`cseen:` 已存在则不重复写。
- `deriveSelf` 暴露 `biliReplies`；`findEcho` 可以继续工作在 `bili_reply` 上，判断她后来是否说过意思相近的话。

### 5.4 看视频

`bili_watch` 成功后，除 `watched:` 配额记账外，写：

```text
type: 'saw'
source: 'system'
surface: 'bili'
channel: 'core'
refs: [bvid]
text: 标题 + OCR 文本（sanitizeForeign 后，沿用现有 `renderSaw` 的文本形状并截断）
```

- 现有 `saw` 已经带 `text`（标题/UP/标签/简介，`browse.js:276-292`），`bili_watch` 沿用同一形状，不另造字段。
- `bili_look` 和后台刷站继续走 `browse.recordSaw`；三条路径（刷到、主动看、抽帧读画面）都进同一类 `saw`。
- `deriveSelf.recentSaw` 保持“最近 7 天、身份文档最多 3 条”的节奏，不把整份浏览历史塞进每轮提示词；细节交给 `her_recall`。
- `saw` 不是判断，不进 `beliefs`。

### 5.5 derive / selfdoc / recall

`deriveSelf` 新增：

- `biliSaid`：最近在 B 站说过的话（`utterance.surface === 'bili'`），带 `refs` 和时间；
- `biliReplies`：最近的 `bili_reply`，带“是否已回”；
- `biliThreads`：按 `root:<rpid>` 把“她的评论 → 别人的回复 → 她的回复”串起来；
- `recentSaw`：现有逻辑，内容更完整。

`selfdoc` 分层：

- **core 段**（所有面）：她是谁、风格、判断、记忆工具、`her_recall`、`her_leave`、日记、最近的 B 站生活摘要（`recentSaw` + `biliSaid` 各少量）。
- **surface 段**：B 站说明只挂 `bili` 面；微信说明只挂 `wx` 面；QQ 说明只挂 `qq` 面；Web/home 不再挂 B 站工具说明。
- `wakeText` 改成按 session id 存；出门会话、home、WX 各自只读自己的处境段。
- carry 只在 Web/home 使用；WX/QQ/B 站不继承 Web 的“上次说到这”。

`her_recall` 去掉 `core || 当前 channel` 过滤，改为整份事件流搜索；返回结果带 `surface` 标签，便于她区分“这是在网上说的”还是“这是和 host 说的”。

## 6. B 站出门会话

### 6.1 会话与工作区

- `dsh-bili` 自己维护 `bili-session.json`（`wsId` / `sessionId` / `title` / `createdAt`），沿用 `home.js` 的幂等模式：先验会话还活着，失效就重建。
- 工作区标题：`大肥鱼出门`；会话标题：`去 B 站`。
- 工作区目录建议 `~/.dsh-fish/home/bili`（可配置）。cwd 不再作为“是不是她”的唯一判据；surface registry 用 session id 判定。
- 启动时创建/复用会话；不自动叫醒，等第一次出门调度或用户手动打开。
- `sessionController` 只在宿主服务可用时出现（`home.js` 也是 `ctx.get('sessionController')`）。每次出门前先 `ensure`：服务不可用就跳过本轮并记一条诊断，不能空转重试。
- 必须先注册 `bili` surface matcher，再创建出门会话；否则 `agent/created` 先到，core 认不出这是她，身份段不会挂上。
- 会话在侧栏可见，用户能直接看她在 B 站做了什么；它的历史不占 Web/home 的对话。

### 6.2 工具面

出门会话只挂：

- 记忆沉淀：`growth_commit`、`her_recall`、`her_leave`、`her_tools`；
- B 站对话工具：`bili_look`、`bili_watch`、`bili_speak`；
- 需要看图时：`read_image`。

不挂：`wx_*`、`qq_*`、宿主 shell/读写/子代理/技能/工作流。B 站只有 3 个工具，第一版全部常驻，不设 deferred；`her_tools` 仍保留，供未来扩展。

### 6.3 出门节奏

`dsh-bili` 自己调度，不依赖 Web/home 的唤醒：

1. 按 `bili.browse.window` / `bili.browse.perDay` 选槽位；
2. 槽位到点先跑 `backgroundBrowse`，把看到的东西写成 `saw`；
3. 扫描回复：新回复写 `bili_reply`；
4. 给出门会话发一条短触发（例如 `（出门看看）`），把本次素材和未回回复放进 `fish:bili` system 段；
5. 她在出门会话里自己决定：继续 `bili_look`、`bili_watch`、`bili_speak`，或者只看看就回来；
6. 回合结束后清掉本次处境段，不留下一次出门的残留。

素材和回复都只放 system 段，不把整段系统通知塞进对话；对话里只留一句短触发，避免用户打开会话时看到一屏“系统说的话”。

### 6.4 配置

沿用 `~/.dsh-fish/config.json`，新增 `bili` 命名空间；旧的顶层 `browse` / `comment` / `video` 继续兼容读取：

```text
bili: {
  enabled, browse: { enabled, perDay, topN, window, voices },
  comment: { enabled, perDay, replyPerDay, replyToReplies, window },
  video: { enabled, perDay, frames, ocr },
  session: { title, dir }
}
```

字段沿用现有顶层配置（含 `deepRead`、`danmaku`、`scanEveryMin`、`atOwner` 等），上面只列常用项。迁移规则：读取时 `bili.x ?? 顶层 x ?? 默认值`；写入时只写 `bili` 命名空间。旧配置不改写，避免跨版本回退时丢设置。

### 6.5 观测

- 出门会话在侧栏可见。
- 观测台增加 B 站足迹：最近 `saw`、`biliSaid`、`biliReplies`、未回线程、进入 `beliefs` 的 B 站判断。
- 工作台可以继续显示旧的 `comment:` / `cbody:` 记录；新记录优先读 `utterance`，避免两份文本不一致。
- 自检增加三项：出门会话是否存在、B 站工具面是否正确、`bili_reply` 是否在持续写入。

## 7. 工具面矩阵与渐进披露

### 7.1 两类工具

**记忆沉淀原子能力**：所有面常驻，不按通道拆。

| 工具 | 作用 |
| --- | --- |
| `growth_commit` | 写判断、改口、拒绝、叙事、日记 |
| `her_recall` | 翻自己的过去 |
| `her_leave` | 给那个人留一句话 |
| `her_tools` | 发现当前面还没露出的工具；是导航，不是记忆 |

**对话原子能力**：按面拆分。

| 面 | 常驻 | 可揭示（deferred） |
| --- | --- | --- |
| web/home | `read_image` | 无（B 站工具不在这里） |
| bili | `bili_look`、`bili_watch`、`bili_speak`、`read_image` | 无（工具少，全部常驻） |
| wx | `wx_peek`、`wx_send`、`wx_context`、`wx_task_done`、`wx_task_snooze`、`her_inbox`、`her_remind`、`her_reminders`、`her_remind_cancel`、`read_image` | `wx.ui`（`wx_see`/`wx_click`/`wx_type`/`wx_key`/`wx_ocr`）、`wx.stickers`（7 个表情工具）、`wx.history`（`wx_history`） |
| qq | `read_image` | `qq.media`（5 个发送工具）、`qq.api`（`qq_napcat_api`）、`qq.history`（`qq_group_history`） |

WX 的 18 个 `wx_*` 注册入口拆成：5 个常驻（`wx_peek`/`wx_send`/`wx_context`/`wx_task_done`/`wx_task_snooze`）+ 5 个 UI 原语 + 1 个历史 + 7 个表情。`her_inbox`/`her_remind*` 是 fish 侧的时间与任务工具，`read_image` 是宿主工具，三者跟着 WX 面走，不占 `wx_*` 的 18 个名额。

`her_remind*` / `her_inbox` 是微信的时间和任务能力，不是记忆沉淀，归 WX 面。`read_image` 是宿主能力，跟着用图的面走。

### 7.2 可揭示集合

不是“全局注册表减已可见”，而是一张显式策略表：

```text
entry = { name, surface, tier: 'always'|'deferred', group, summary, requires }

catalog(surface) = entries
  .filter(e => e.surface === surface)
  .filter(e => e.tier === 'deferred')
  .filter(e => e.requires 满足)
  .filter(e => 宿主里真的注册了这个名字)
```

规则：

- 宿主工具（shell、读写、子代理、技能、工作流）、别的面的工具、不在策略表里的名字，永远不进目录。
- `her_tools.search { query?, group? }` 只返回最多 5 条：工具名 + 一句话用途 + 所属组，不返回完整参数 schema。
- `her_tools.load { names }` 只接受当前面 catalog 里的名字；通过后把名字加入该 agent 的可见集，下一步模型请求带完整 schema。
- 每个 agent 维护可变允许集合 `always ∪ revealed`；guard 读同一个 Set，不能再用创建时的闭包快照。
- 宿主在每一步 `agent/preStep` 重新组装 system prompt 和工具 schema，所以 `load` 后下一步就能看到新工具；不需要改宿主。
- 放宽时通过 `exec.agent.ctx.tools` dispose 旧的 `restrict`，用新集合重新下；失败沿用“从报错里捡回真名单”的兜底。
- `agent/disposed` 清理；可选按 session id 持久化已揭示名单，重启后恢复，避免同一会话前后能力漂移。
- 发现不等于授权：`wx_send`、`qq_send_*`、`bili_speak` 仍走原 handler 的会话、频率、permit、@ 条件、黑名单和 `guard` 检查。

## 8. 拆包边界

### 8.1 `dsh-fish`：person core

保留：

- `store.js`、`schema.js`、`derive.js`、`selfdoc.js`、`persona.js`、`identity.js`；
- `capture.js`、`recall.js`、`letter.js`、`guard.js`、`settings.js`；
- `home.js`、`scheduler.js`（home 唤醒）、`wakewin.js`、`wakeconst.js`；
- `observe.js`、`client.js`（第一版保留 B 站设置/观测 UI，后续可拆）；
- `restrict.js` 改成基于 surface 策略的通用收窄器。

新增：

- `core-service.js`：`fishCore` 的 provide/consume、surface registry、memory 写入封装；
- `tool-result.js`：`registerTool`/`wrapTool`、`project*` 投影风格、`ToolError`；
- `tool-ledger.js`：工具台账追加、脱敏、大字段 artifact、只读查询；
- `tool-policy.js`：策略表、catalog、已揭示集合、guard 同步；
- `tools.js`：`her_tools` 注册。

### 8.2 `dsh-bili`：B 站面

拿走：

- `bili.js`、`browse.js`、`browsejob.js`、`look.js`、`watch.js`、`speak.js`、`comment.js`、`video.js`、`ocr.js`、`voices.js`、`footprint.js`、`risk.js`；
- `src/dsh-fish/lib/index.js` 里 `bili_look`/`bili_watch`/`bili_speak` 的注册与启动调度；
- B 站出门会话（`session.js`）、调度（`schedule.js`）、提示词段（`prompt.js`）；
- B 站相关测试。

约束：

- `package.json` 三个依赖字段仍是 `{}`；只用内置 `fetch`/`crypto`/`zlib`/`child_process` 和 `node:test`。
- 有状态模块（`store.js`、`schema.js`、`derive.js`、`guard.js`、`settings.js`）不直接 import；通过 `ctx.get('fishCore')` 使用 memory/self/surface/guard/config/sessions。
- 纯函数 helper（`tool.js`、`toolschema.js`、`posix.js`）允许复制进 `dsh-bili`，或抽成仓库内共享模块；第一版优先复制，保持插件可独立安装。`media.js` 的 ffmpeg 探测、`comment.js` 的 owner mention 也按这个原则处理。
- `browse.js` 的 `debrief` / `recordVoice` 改成本地薄封装：外部文本走 `fishCore.guard.sanitizeForeign`，`voice` 事件走 `fishCore.memory.appendSystem`。
- 测试可注入 fake `fishCore`，不依赖宿主。
- B 站设置 UI 第一版可以暂留 core，但 `dsh-bili` 必须能独立读写 `bili` 配置命名空间。

### 8.3 `dsh-wx` 与 QQ

- `dsh-wx`：保留微信耳朵、GUI 锁、任务板、WX 工具；删除按 cwd 挂载的通道段，改为 `fishCore.surface.register({ id: 'wx', match: wx.isWxSession, ... })`；记忆写入改走 `fishCore.memory`。
- QQ：vendor 插件不动；新增一个薄适配层注册 `qq` surface matcher（`onebot-*`）和 QQ 提示词段；QQ 工具仍由 vendor 注册，策略表只引用名字。
- 两面都不再维护自己的身份文档副本；身份由 core 提供。

## 9. 实施阶段

### Phase 0：基线

- 记录 main/dev 每个面实际送入请求的工具名、schema/token、提示词长度。
- 从事件流统计 `wx_*`、`bili_*`、`qq_*` 的真实调用频率，校准 always/deferred。
- 固定验收样本：Web 闲聊、WX 普通回复、WX 界面排障、WX 表情、QQ 媒体、B 站看视频、B 站评论、B 站回复线程。

### Phase 1：core 服务与 surface 判定

- 引入 `fishCore` 与 surface registry；`surface.current(agent)` 取代 cwd/硬编码路径判定。
- `channelOfAgent` 保持兼容，但新代码只用 surface。
- `isHerAgent` 改为 surface registry 判定（`web`/`wx`/`qq`/`bili` 都算她），不再只认 `HER_DIR`；否则 B 站工作区的 `agent/created` 挂不上身份段。
- `wakeText` 改为按 session 存；carry 只在 Web/home。
- 身份段改为“core 段 + surface 段”，先让行为与现在等价。
- 测试：surface 判定、B 站工作区被认作她、WX 段不再挂到 home、wake/carry 不串面。

### Phase 1.5：工具返回契约

- 引入 `tool-result.js` / `tool-ledger.js`，先接核心工具和 B 站三个工具。
- 工具返回改成“完整结果 + `project()` 模型投影”；状态用方括号舞台提示，素材保留原话和归属。
- 测试：每次调用一条台账、完整结果、秘密脱敏、投影无 JSON/坐标/置信度/内部 id。

### Phase 2：事件模型 v3 与 B 站记忆闭环

- 加 `surface`、`bili_reply`，升 `EVENT_SCHEMA_VERSION=3`。
- `bili_speak` 写 `utterance(surface=bili)`；`bili_watch` 写 `saw`；`scanReplies` 写 `bili_reply` 并从事件流取未回列表。
- `deriveSelf` 加 `biliSaid` / `biliReplies` / `biliThreads`；`selfdoc` 加 core B 站生活摘要；`her_recall` 去掉通道过滤。
- 测试：评论进 beliefs、B 站 utterance 不改称呼/叙事/`spokenSinceSeen`、回复去重、未回列表、线程串联、`saw` 内容、recall 跨面可见。

### Phase 3：B 站出门会话

- `dsh-bili` 建 workspace/session，按槽位调度；`fish:bili` 段放素材和未回回复。
- 出门会话的工具面只留 core 记忆 + `bili_*` + `read_image`。
- 观测台加 B 站足迹；自检加三项。
- 测试：会话幂等、调度不重复、出门段不泄漏到 home/WX、工具面正确。

### Phase 4：物理拆包

- `git mv` B 站文件与测试到 `src/dsh-bili`，建立独立 `package.json`（零依赖）。
- 删掉 `dsh-fish` 里残留的 B 站 import 和调度；B 站能力只由 `dsh-bili` 提供。
- 更新 profile bundles、README、AGENTS.md/CHANGELOG。
- 测试：`src/dsh-bili` 独立 `node --test`；`src/dsh-fish` 仍全绿。

### Phase 5：工具策略与渐进披露

- `tool-policy.js` + `her_tools`；WX/QQ 的 deferred 组按矩阵落地。
- guard 改可变允许集合；`restrict` 放宽时 dispose/重下。
- 测试：只揭示当前面、别的面不可揭示、宿主工具永不可揭示、guard 与可见集同步、揭示后下一步 schema 出现。

### Phase 6：dev 验收与合并

- 在 dev 宿主跑完整样本，记录 token、工具轮数、成功率、自然度盲评。
- 通过后 dev → main；分开报告本地测试、提交、推送、WSL 拉取、运行验证状态和 SHA。

本设计是程序级设计，不建议塞进一份实现计划。建议拆成三份计划、每份独立验收：Phase 1-2（core 与记忆闭环）、Phase 3-4（出门会话与拆包）、Phase 5（工具策略与渐进披露）。

## 10. 测试与验收

### 10.1 单元测试

- `schema`：v3 字段、`bili_reply` 类型、旧事件 `surface` 推断、未知 `surface` 处理、备份版本拒收。
- `capture`：`utterance(surface=bili)` 写入、refs 线程键不被误判为事件 id。
- `derive`：B 站评论进 beliefs；B 站 utterance 不触发称呼/叙事/`spokenSinceSeen`/`corrected`；`biliReplies`/`biliThreads` 正确；`recentSaw` 仍只保留 7 天。
- `recall`：跨面可见；返回带 surface 标签；`meta` 仍跳过。
- `comment`：`scanReplies` 去重、写 `bili_reply`、未回列表、`postReply` 写 utterance + `creply`/`cseen`。
- `watch`：`bili_watch` 写 `saw`，内容过 `sanitizeForeign`。
- `surface`：Web/WX/QQ/B 站判定；WX 段只挂 WX；出门段只挂 B 站；wake/carry 不串。
- `restrict`/`tool-policy`：可变允许集合、catalog 过滤、guard 同步、`her_tools` 只揭示当前面。
- `dsh-bili`：出门会话幂等、调度槽位、配置命名空间兼容。

### 10.2 运行验收

- Web 闲聊：她能正常回复；看不到 `wx_*`/`bili_*`/`qq_*`。
- WX 普通回复：工具面只含 WX 常驻；`wx_send` 的会话/频率/permit 检查不变。
- WX 界面排障：`her_tools.load(['wx_see','wx_click'])` 后下一步能调用。
- WX 表情：`wx.stickers` 揭示后能查/发；发送边界不变。
- QQ 媒体：`qq.media` 揭示后能发；`onebot-*` 仍被 WX 工具拒绝。
- B 站出门：会话独立出现；看视频写 `saw`；评论写 `utterance(surface=bili)` 并进 beliefs；别人回复写 `bili_reply`；她回复后线程完整；`her_recall` 在 Web/WX/QQ 都能翻到。
- 观测：B 站足迹能看到最近看/说/回；自检三项通过。

### 10.3 不算通过的情况

- 只是工具数量变少，但常见交流多了一轮搜索，或她说话更像工具说明书。
- B 站评论写进了事件，但没有进 beliefs，或进了 beliefs 却改了称呼/叙事。
- 回复只是渲染在提示词里，没有事件；或者每次出门都重复扫同一条回复。
- Web 会话仍能看到 WX/B 站工具，或 WX 仍收到 B 站说明。
- 为了拆包改了历史事件、删了旧字段、或让 v2 档读不出来。

## 11. 风险与待决

### 风险

- **共享记忆会取消原来的通道隐私边界**：去掉 `her_recall` 的通道过滤后，她在 WX/QQ 里沉淀的判断会对 Web/B 站可见；这是“core 共享”的直接后果。如果以后某些通道需要保持私密，应新增 `private` 标记并在召回层处理，而不是恢复“按通道过滤”的旧逻辑。
- **B 站评论进 beliefs 会稀释判断列表**：评论短、数量可能多。用 `surface` 标记区分展示；显著性排序仍按现有规则，必要时在身份文档里把 B 站判断单独成段，不改变“它们算判断”的语义。
- **`bili_reply` 文本带用户名**：用 `「谁」：原话` 形式落盘，避免新增字段；如果以后需要结构化 actor，再升 schema。
- **出门会话的上下文增长**：B 站会话会累积历史；第一版不自动轮换，后续可按 turn 数或天数轮换，轮换时只搬最近素材，不搬整段历史。
- **UI 暂留 core**：B 站设置/观测 UI 第一版不搬，可能出现“插件拆了但设置页还在 core”的过渡态；在 README/CHANGELOG 里写清。
- **配置双读**：`bili.x ?? 顶层 x` 的兼容期要写测试，避免新旧配置互相覆盖。

### 待决

- Web 面要不要保留一个极薄的 `bili_go`（只负责开一次出门，不给浏览/评论权限）。当前设计不保留；如果用户希望“在聊天里喊她去看看”，再加。
- B 站出门会话是否需要在侧栏常驻，还是只在有活动时显示。当前设计常驻，便于观察。
- 已揭示工具是否按 session 持久化。当前设计建议持久化，但第一版可以先只在内存里，重启后重新揭示。

## 12. 关键文件索引

| 文件 | 现状 | 本设计中的角色 |
| --- | --- | --- |
| `src/dsh-fish/lib/schema.js` | `ALL_TYPES`、`EVENT_SCHEMA_VERSION=2` | 加 `surface`、`bili_reply`、v3 |
| `src/dsh-fish/lib/store.js` | `channelOfAgent`、`appendEvent` | 保留兼容；新代码走 `fishCore.memory` |
| `src/dsh-fish/lib/derive.js` | `saw`、`voices`、`beliefs` | 加 `biliSaid`/`biliReplies`/`biliThreads`，区分 B 站 utterance 副作用 |
| `src/dsh-fish/lib/recall.js` | `SKIP_TYPES = meta`，通道过滤 | 去掉通道过滤，保留 `meta` 跳过 |
| `src/dsh-fish/lib/comment.js` | 评论/回复只写 meta | 写 `utterance`/`bili_reply`，保留配额 meta |
| `src/dsh-fish/lib/speak.js` | 只返回 `said` | 写 `utterance(surface=bili)` |
| `src/dsh-fish/lib/watch.js` | 只写 `watched:` meta | 加写 `saw` |
| `src/dsh-fish/lib/scheduler.js` | 唤醒时 `scanReplies` 渲染 | 回复扫描/出门调度移交 `dsh-bili` |
| `src/dsh-fish/lib/identity.js` | `wakeText` 全局、cwd 判据 | 按 session 存、按 surface 挂段 |
| `src/dsh-fish/lib/restrict.js` | 固定 `allowSet`、全局名单、`isHerAgent` 只认 `HER_DIR` | 改成 surface 策略 + 可变允许集合；`isHerAgent` 改认 surface |
| `src/dsh-wx/lib/index.js` | cwd 判据挂微信段 | 改 `surface=wx` |
| `src/dsh-fish/lib/selfdoc.js` | 一份文档所有面共用 | core 段 + surface 段 |
| `src/dsh-fish/lib/browsejob.js` | 后台刷站写 `saw` | 保留；由 `dsh-bili` 调度 |
| `docs/superpowers/specs/2026-11-09-bigfish-tool-return-contract-design.md` | 工具返回契约子设计 | 台账、投影、逐工具返回、prompt 重编译 |
| `src/dsh-fish/lib/tool-result.js`（新增） | 无 | `registerTool`/`wrapTool`、`project*`、`ToolError` |
| `src/dsh-fish/lib/tool-ledger.js`（新增） | 无 | 完整工具台账、脱敏、artifact |
