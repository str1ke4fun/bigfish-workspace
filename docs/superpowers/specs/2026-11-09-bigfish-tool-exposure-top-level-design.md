# 大肥鱼工具暴露顶层设计

日期：2026-11-09
状态：顶层设计，待评审；未实施
关系：
- 本文是工具暴露架构的顶层视图，合并并收敛两份子设计：
  - [大肥鱼个人核心与分面工具架构](2026-11-09-bigfish-person-core-surfaces-design.md)
  - [工具返回契约：完整记账与选择性透传](2026-11-09-bigfish-tool-return-contract-design.md)
- 冲突时，本文负责“工具如何分类、在哪个面暴露、按什么规则按需打开、权限边界在哪”；子设计负责接口、字段和逐工具投影细节。
- 本文不改变四条黑名单、发送闸、事件流只追加、零依赖和“不新增人格设置界面”的既有约束。

## 1. 问题

当前工具暴露是“一张全局 allow 名单 + 每个会话尽量多给工具”：

- Web 会话能看到微信和 B 站工具；微信能看到 B 站工具；QQ 反而可能看不到自己的工具。
- 常驻 schema 和重复教程占上下文，模型更像在照工具手册操作。
- 低频工具（界面原语、表情维护、QQ API）和常用工具混在一起，没有“先不给、需要再打开”的层级。
- 工具返回把 JSON、坐标、内部 id、置信度直接塞进模型上下文；台账、观测、记忆和模型投影挤在同一个字符串里。
- 工具归属和提示词归属没有单一来源：`surface`、`config.tools.allow`、各插件的 cwd 判断各管一段。

目标不是简单减少工具数量，而是建立一条可解释的暴露管线：**谁拥有工具、当前面能看见什么、什么需要按需打开、打开后权限是否变化、返回什么给模型、什么只进台账。**

## 2. 设计原则

1. **一个注册表，一张策略表。** 工具由插件注册；可见性只由 `tool-policy` 决定。`surface.register` 不声明工具，避免两套来源。
2. **面是作用域，不是记忆墙。** `surface` 决定“在哪个会话、挂哪些提示词、看见哪些工具”；不决定她能不能写记忆，也不在召回层过滤她主动写入的事件。
3. **分类不是授权。** always / deferred / hidden 只决定“现在看不看得见”，不改变发送闸、频率、permit、黑名单、guard 和配额。
4. **常用直达，低频按需。** 常见对话动作常驻；界面原语、维护工具、机器 API 放进 deferred 组，需要时再打开。
5. **读说明和装工具分开。** 她可以先读目录/说明而不改变可见工具集合；只有 `load` 才把 schema 装进下一步请求。
6. **摘要先行，细节按需。** 大结果先给闭环必需信息；完整文本用后续读工具或台账取，不把整棵 UI 树、整段 OCR、整份 QQ 响应塞进上下文。
7. **台账完整，投影最小。** 工具返回的完整值进台账；模型只看状态、素材、归属、必要 handle 和不确定性。
8. **工具策略不是人设。** 工具教程、面规矩、按需策略属于提示词资产，不写进 `events.jsonl`、不被 `her_recall` 翻到，也不改变她主动写入的内容。
9. **不改宿主。** 利用宿主已有的 `ctx.tools.register`、`ctx.tools.restrict`、每一步 `agent/pre-step` 重组、`output.schema`/`output.render`、`tools/post-execute`；不为逐轮工具协议打宿主补丁。
10. **零依赖。** 核心插件和面插件只用内置模块与 `node:test`。

## 3. 总体架构

```text
┌──────────────────── 宿主工具注册表 ────────────────────┐
│ 插件 ctx.tools.register(def)                            │
│   def = { name, description, parameters, output, execute }│
└───────────────▲───────────────────────────▲─────────────┘
                │                           │
     ┌──────────┴──────────┐     ┌──────────┴──────────┐
     │ dsh-fish: person core│     │ 面插件               │
     │ fishCore             │     │ dsh-wx / dsh-bili    │
     │  memory/self/        │     │ QQ 适配层 / web 段   │
     │  surface/guard/      │     │ 注册工具 + 面策略    │
     │  config/sessions/    │     │ 通过 fishCore 写记忆 │
     │  tools/toolLedger    │     │                      │
     └──────────┬───────────┘     └──────────┬──────────┘
                │                            │
                └────────────┬───────────────┘
                             ▼
                  ┌─────────────────────┐
                  │ tool-policy         │
                  │ 一张显式策略表       │
                  │ always/deferred     │
                  │ group/requires/kind │
                  └──────────┬──────────┘
                             ▼
                  ┌─────────────────────┐
                  │ agent 会话           │
                  │ surface = web/wx/   │
                  │ qq/bili/null        │
                  │ allow = always ∪    │
                  │ revealed            │
                  └──────────┬──────────┘
                             ▼
        ctx.tools.restrict({ allow }) + guard 同源
                             ▼
        每一步 agent/pre-step：system prompt + 工具 schema 重组
                             ▼
        模型调用 → 宿主 execute → output.render → tools/post-execute
                             ├─ 模型投影（选择性）
                             ├─ 工具台账（完整、脱敏）
                             └─ 语义事件（她的话/看到的东西）
```

所有权边界：

| 层 | 拥有什么 | 不拥有什么 |
| --- | --- | --- |
| 宿主 | 工具注册、执行、审批、`restrict`、每步组装、`post-execute` | 大肥鱼的面、记忆、人设 |
| `dsh-fish` person core | 事件流、派生、人格核心、记忆工具、surface registry、策略表、guard、台账 | 各面的具体工具教程和发送实现 |
| 面插件 | 自己的工具、面策略、面处境、发送/浏览实现 | core 的人格、其他面的工具、跨面记忆过滤 |
| vendor（QQ） | 自己的工具注册和原始返回 | 大肥鱼的投影和台账；由 `post-execute` 适配 |

## 4. 工具分类模型

分类不是一套层级，而是四个正交维度。任何工具都可以同时有“所有权、暴露层级、动作语义、能力要求”。

### 4.1 按所有权

| 类别 | 例子 | 默认可见性 |
| --- | --- | --- |
| core 记忆工具 | `growth_commit`、`her_recall`、`her_leave`、`her_tools` | 所有面常驻 |
| 面对话工具 | `bili_look/watch/speak`、`wx_*`、`qq_*` | 只在该面；按 always/deferred 分 |
| 宿主工具 | `read_image`、shell、读写、子代理、技能、工作流 | 只有 `read_image` 按需给用图的面；其余永不进她的目录 |
| vendor 工具 | QQ `onebot-*` 注册的发送/API/历史 | 只在该面；由策略表引用名字，返回由 `post-execute` 适配 |

`her_tools` 是导航工具，不是记忆工具：它不写事件，只读策略表并改当前会话的可见集合。

### 4.2 按暴露层级

| 层级 | 含义 | 何时出现 |
| --- | --- | --- |
| `always` | 常驻当前面，模型每步都能直接选 | core 记忆工具 + 该面最高频的 3–6 个动作 |
| `deferred` | 不常驻；目录里可发现，`load` 后才出现 schema | 低频原语、维护工具、机器 API、历史查询 |
| `hidden` | 不在目录、不可 `load` | 宿主工具、别的面的工具、未注册的名字、内部工具 |

“hidden”不是删除工具，而是不让她看见；插件仍可注册，策略表只是不列出。

### 4.3 按动作语义

| kind | 含义 | 默认层级 | 例子 |
| --- | --- | --- | --- |
| `read` | 读取当前面的事实 | always 或 deferred | `wx_peek`、`wx_context`、`bili_look`、`qq_group_history` |
| `write` | 写她的判断/留话/任务状态 | always | `growth_commit`、`her_leave`、`wx_task_done` |
| `send` | 对外发送，必须走原有发送闸 | always 或 deferred | `wx_send`、`wx_sticker_send`、`qq_send_*`、`bili_speak` |
| `navigate` | 操作界面原语 | deferred | `wx_see/click/type/key` |
| `maintain` | 维护本地索引或机器配置 | deferred | `wx_sticker_scan/tag/collect`、`qq_napcat_api` |
| `discover` | 发现和打开其他工具 | always | `her_tools` |

`kind` 只用于默认层级和测试分类，不替代代码里的权限检查。`send` 无论 always 还是 deferred，都必须继续走会话、频率、permit、@ 条件、黑名单和 guard。

### 4.4 面矩阵

core 记忆工具（`growth_commit`、`her_recall`、`her_leave`、`her_tools`）在四面都常驻，下表不再重复。

| 面 | always | deferred 组 | hidden |
| --- | --- | --- | --- |
| web/home | `read_image` | 无 | 所有 `wx_*`、`qq_*`、`bili_*` |
| bili | `bili_look`、`bili_watch`、`bili_speak`、`read_image` | 无（只有 3 个 B 站工具，第一版全常驻） | `wx_*`、`qq_*`、宿主 shell/读写/子代理/技能/工作流 |
| wx | `wx_peek`、`wx_send`、`wx_context`、`wx_task_done`、`wx_task_snooze`、`her_inbox`、`her_remind`、`her_reminders`、`her_remind_cancel`、`read_image` | `wx.ui`（`wx_see/click/type/key/ocr`）、`wx.stickers`（7 个表情工具）、`wx.history`（`wx_history`） | `bili_*`、`qq_*`、宿主高危工具 |
| qq | `read_image` | `qq.media`（5 个发送工具）、`qq.api`（`qq_napcat_api`）、`qq.history`（`qq_group_history`） | `wx_*`、`bili_*`、宿主高危工具 |

说明：

- `her_inbox`/`her_remind*` 是 fish 侧的时间与任务工具，归 WX 面常驻，不占 `wx_*` 的名额。
- `read_image` 是宿主能力，不是她的记忆工具；只有用图的面常驻，其他面不给。
- B 站只有 3 个对话工具，第一版全部常驻，不设 deferred；`her_tools` 仍保留，供未来扩展。
- QQ 的 vendor 工具由 vendor 注册，策略表只引用名字；适配层负责投影和台账，不改 vendor 的注册和 render。

## 5. 面判定

工具暴露的第一步是知道“现在是哪个面”。判定不能继续靠 cwd：

- **输入**：`{ id, cwd, serviceState }`。`id` 是 session id；`cwd` 只作兜底；`serviceState` 给需要宿主服务的面。
- **顺序**：`bili → wx → qq → web`。B 站有专属 workspace 目录；WX/QQ 按 session id 或 `onebot-*` 前缀；最后才是 web。
- **预分配 id**：WX、home、B 站的 session id 在 `sc.create()` 之后才落盘。创建前先 `surface.reserve(sessionId)`，再 `sc.create({ sessionId })`；否则 `agent/created` 先到，身份段和工具收窄整条会话漏挂。
- **未知面返回 `null`**：普通 DSH 工作区不挂身份、不做她的工具收窄，并记一条诊断。不要默认归 web。
- **共享 cwd 的面必须预分配**：WX 和 home 共用 her home 目录时，单靠 cwd 会把 WX 认成 web；新会话一律预分配，旧会话 Phase 1 保留 cwd 兜底。

## 6. 暴露管线

### 6.1 注册

插件仍然用宿主接口注册工具，但返回契约统一由 `fishCore.tools.wrap` 包装：

```text
def = {
  name, description, parameters, outputSchema,
  execute,        // 返回统一信封
  project,        // 模型投影，execute 时算一次
  ledger = true,
}
```

- `output.schema` 描述**完整返回信封**，不是投影文本；失败分支也必须满足 schema。
- `project` 在 `execute` 里冻结 surface/session/时间/图片路由，算一次并挂在结果上；`output.render` 只读这一份。
- 业务代码不手写 `render`；包装器统一处理投影、handles、图片块和兜底。
- `dsh-wx`/`dsh-bili` 通过 `fishCore.tools.wrap` 使用同一套包装，不 import core 内部文件。

### 6.2 策略表

`tool-policy` 是唯一可见性来源。每条：

```text
{
  name,                 // 宿主注册名
  surface,              // web | wx | qq | bili
  tier: 'always' | 'deferred',
  group,                // deferred 必填，例如 wx.ui
  summary,              // 一句话，进目录
  kind,                 // read | write | send | navigate | maintain | discover
  requires: [],         // 能力谓词，例如 hasGui / hasOcr / hasImageRoute
  safety,               // 可选：send | external | local，用于测试分类
}
```

规则：

- 一个工具只有一个 surface；不写“所有面”。
- `hidden` 不是 tier，而是“策略表里没有这个名字”，或者名字属于宿主/别的面。
- `requires` 是能力谓词，不是面 id；catalog 只列宿主真的注册、且能力满足的工具。
- 策略表不写提示词正文；提示词归属见 §10。

### 6.3 解析可见集合

```text
allow(surface, caps, revealed) =
  entries
    .filter(e => e.surface === surface)
    .filter(e => e.tier === 'always' || revealed.has(e.name) || revealed.has(e.group))
    .filter(e => e.requires.every(c => caps[c]))
    .filter(e => hostToolNames.has(e.name))
```

- `always` 不依赖 `revealed`。
- `revealed` 是当前 agent 的可变集合，存名字或组名。
- 宿主没注册的名字不显示，避免“策略里有、调用时找不到”。
- 别的面的工具、宿主高危工具永远不在候选集里。

### 6.4 收窄与 guard

- 每个 agent 创建时按 `allow` 调 `ctx.tools.restrict({ allow })`，保存返回的 disposer。
- 放宽时先调用 disposer 撤销旧限制，再用新集合重新 `restrict`；宿主没有 `ctx.tools.dispose`，不要按不存在的 API 写。
- `guard` 读同一个可变 `allow` 集合，不能再用创建时的闭包快照；否则 `load` 后新工具会被 guard 挡住。
- 新限制在下一步 `agent/pre-step` 生效；不要在同一个工具调用里假设 schema 已经变了。

### 6.5 每步组装

宿主在每一步 `agent/pre-step` 重新组装 system prompt 和工具 schema（已核对 0.2.1-rc.5 的 `systemPrompt.assemble` 与 `assembly.tools`）。因此：

- `load` 后下一步模型就能看到完整 schema。
- 不需要改宿主，也不需要在插件里自己拼工具表。
- 可见集合变化会影响一次 prompt 缓存；这是按需暴露的固有成本，见 §7.5。

### 6.6 执行与返回

一次工具调用的完整链路：

```text
模型选工具
  → 宿主审批/权限
  → handler execute（业务）
  → output.schema 校验完整信封
  → output.render（读预计算投影）
  → tools/post-execute（写台账、可重写 content）
  → 模型看到投影
  → 语义事件另写 events.jsonl（如果有）
```

- `tools/post-execute` 能拿到 `exec`、`result.content`（模型实际所见）和 `result.value`（完整信封），一次覆盖包装工具和 vendor 工具。
- 台账监听器必须自己 try/catch；宿主把监听器抛错当成工具失败，台账写失败不能把成功调用变成 `isError`。
- `render` 也必须自己兜底；投影代码抛错不能变成 `Error: output.render failed: …` 进入她的上下文。

## 7. 按需暴露策略

### 7.1 三个动作

`her_tools` 始终常驻，提供三个动作：

| 动作 | 作用 | 是否改变可见工具 |
| --- | --- | --- |
| `search { query?, group? }` | 返回最多 5 条：名字、一句话用途、组；不返回完整参数 schema | 否 |
| `describe { names }` | 返回指定工具的完整说明、参数、限制和适用条件 | 否 |
| `load { group? , names? }` | 把当前面策略允许、宿主真的注册的工具加入 `revealed`，重新 `restrict` | 是，下一步生效 |

这三个动作对应三种“可读可不读”：

- 她可以只 `search`，不读详情；可以 `describe`，但不装工具。
- 她可以只 `load` 一个组，不逐个读说明；也可以完全不打开。
- 常用动作在 `always` 里，不强迫她为了普通对话先查目录。

### 7.2 读说明与装 schema 分开

这是本设计最关键的一条：

- `search`/`describe` 只返回文本，不改变工具集合，也不改变 guard。
- `load` 才改变可见集合，并影响下一次请求的 schema 和缓存。
- 这样“可读可不读”不会变成“每次对话都要先做一次工具发现”。
- 完整参数只在 `describe` 里出现；`search` 只给名字和一句话，避免目录本身又变成一大段 schema。

### 7.3 组优先，单工具为辅

- 第一版 `load` 以组为单位：`wx.ui`、`wx.stickers`、`wx.history`、`qq.media`、`qq.api`、`qq.history`。
- 组是一次场景切换的最小单位，比逐工具 `load` 少往返，也更容易做缓存和测试。
- 单工具 `load` 可以保留给“只差一个工具”的兜底，但第一版不作为主路径。
- `load` 只接受当前面 catalog 里的组/名字；别的面、宿主工具、未注册名字一律拒绝，返回“这条路上打不开”，不假装成功。

### 7.4 “可读可不读”的边界

| 对象 | 是否可选 | 说明 |
| --- | --- | --- |
| 工具目录、完整说明 | 可选 | `search`/`describe` 不调用也能用 always 工具 |
| 低频工具的 schema | 可选 | `load` 才装；不装就看不见 |
| 大结果的完整正文 | 可选 | 先给摘要；细节用后续读工具或台账取 |
| 发送结果、失败原因、不确定性 | **不可选** | 必须进投影，不能因为“她没读”就隐藏 |
| 安全边界、配额拒绝、permit 失效 | **不可选** | 代码强制，且要在结果里说清 |
| 记忆写入 | **不可选、与读无关** | `utterance`/`saw`/`bili_reply` 由动作成功与否决定，不取决于她是否读了说明或结果 |

“可读可不读”只适用于**展示和发现**，不适用于**状态和安全**。不能把“她可以选择不读”做成“系统可以不告诉她发没发出去”。

### 7.5 预算与缓存

- always 预算：core 记忆工具 + 该面 3–6 个常用动作；超过这个数就说明分类有问题。
- 目录预算：`search` 最多 5 条；`describe` 一次最多 1–2 个工具，避免目录变成第二套 schema。
- 加载预算：一次 `load` 一个组；同一会话不要每轮反复 `load`/卸载。
- 缓存：可见集合变化会让下一次请求的 prompt 缓存失效一次；把同场景的工具放在同一组，减少抖动。
- 持久化：可选按 session id 持久化 `revealed`，重启后恢复；第一版可以先只在内存里，重启后重新发现。

### 7.6 失败与降级

- 宿主没注册：catalog 不列，`load` 返回“这条路上没有这个工具”。
- 能力不满足（没有 GUI/OCR/图片路由）：catalog 不列，或 `describe` 明确说“这个环境里用不了”。
- `load` 失败：返回 `[没打开：原因]`，不要假装下一步能调用。
- vendor 工具没有 `post-execute` 覆盖：自检逐工具报告 `wrapped`/`legacy`，`legacy` 必须可见。
- 图片路由不支持：降级文本，不塞本地路径冒充图片。

## 8. 工具返回与上下文

完整契约见子设计，这里只固定顶层规则：

- **四层分工**：工具台账（完整、审计）、模型投影（选择性）、UI 投影（可选）、语义事件（她的记忆）。
- **先摘要后细节**：`wx_peek` 给会话和最后几条；正文用 `wx_context`/`wx_history`；`bili_watch` 给 OCR 摘要；`qq_group_history` 保留最近 N 条正文，不只回条数。
- **投影是舞台提示**：方括号是状态，素材保留原话和归属；不写“你看到了……”，避免她复述。
- **handles 最小化**：数组 `[{label,value}]`，footer 只渲染 `label=value`；单条写操作可以内联一个 id。
- **effects 三态**：`action: confirmed|unconfirmed|failed`，`event: ok|failed|skipped`；动作成了但事件没写、动作不确定，都要在投影里说清。
- **预期失败走信封**：`{ ok:false, code, message }`，不要依赖 throw 的 `Error:` 前缀做舞台提示；`ToolError` 只留意外。
- **台账不参与召回**：`her_recall` 只读事件流；观测台只读台账；两条路不互相冒充。

## 9. 权限与安全

- **发现不等于授权。** `her_tools` 只决定“看不看得见”，不改变 `wx_send`、`qq_send_*`、`bili_speak` 的会话、频率、permit、@ 条件、黑名单和 guard 检查。
- **策略只能收窄。** `tool-policy` 不能写“允许绕过发送检查”“在 B 站可以多发”；权限由代码和配置决定。
- **不能跨面揭示。** Web 不能 `load` 微信/QQ/B 站工具；B 站不能 `load` `wx_*`；QQ 不能 `load` `wx_*`。
- **宿主工具永不可揭示。** shell、读写、子代理、技能、工作流不在任何面的策略表里；`read_image` 是唯一例外，且只给用图的面。
- **密钥不落台账。** `args`、`value`、`content`、`modelText` 都过 `guard.looksLikeSecret`；cookie/token/密码不进模型、投影、台账或日志。
- **owner 认证最小暴露。** `owner.read()` 只在 core 内部和受信插件使用；是否暴露给 `dsh-bili` 需要安全评审。
- **vendor 返回也要过投影。** QQ 适配层用 `tools/post-execute` 重写 `content`；不能因为 vendor 自己渲染就把原始 JSON 漏进模型。

## 10. 人设与记忆边界

- **工具策略是 L2 面策略。** B 站整活/蜜罐/评论规矩、微信屏幕与发送规矩、QQ 群规矩、Web/home 不汇报，都属于面策略；不写进事件流、不被 `her_recall` 翻到、不跨面挂载。
- **工具教程不是人格。** `bili_watch` 怎么读、`wx_peek` 怎么用属于工具 schema 和面提示，不写进“你怎么说话”。
- **core 只放与面无关的人格和记忆工具。** `TOOL_BRIEF` 拆成 core 记忆工具说明和面工具教程；`bili_watch` 迁 bili；`BSITE_BRIEF` 迁 `dsh-bili`。
- **关系层有作用域。** 称呼「他/哥」、absence、疤、接话方式只在 host 面挂；B 站评论和陌生群不继承。
- **她主动写入的内容不受工具可见性影响。** `growth_commit`、`utterance`、`diary`、`her_leave` 写的是同一份记忆；工具没打开、策略没暴露，不改变写入路径。
- **记忆共享，展示分面。** `her_recall` 翻整份事件流；`recentSaw`/`biliSaid`/`biliReplies`/`freshVoice` 只在对应面展示，其他面需要时用 `her_recall` 取。

## 11. 实施阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| 0 | 记录各面实际工具 schema、prompt token、调用频率 | 基线数字和样本 |
| 1 | `fishCore`、surface registry、`surface.reserve`、身份段按面挂载 | 面判定、首次创建挂载、wake/carry 不串 |
| 1.5 | `tool-result`/`tool-ledger`，先接核心工具和 B 站三工具 | 每次调用一条台账、投影无 JSON/坐标/id |
| 2 | 事件 v3、`bili_reply`、B 站评论/回复记忆闭环 | 评论进 beliefs、回复去重、跨面可召回 |
| 3 | B 站出门会话和调度 | 会话幂等、只有一条调度路径、面段不泄漏 |
| 4 | 物理拆包（4a 依赖解耦、4b 调度/UI 切换） | 两个插件各自 `node --test` 全绿 |
| 5 | `tool-policy` + `her_tools` + 分组按需暴露 | 只揭示当前面、guard 同步、下一步 schema 出现 |
| 6 | dev 验收与合并 | token、轮数、成功率、自然度盲评；报告降级路径 |

顺序说明：Phase 5 依赖 Phase 1 的 surface registry；可以先在 Web/WX 落地，再扩到 QQ/B 站。Phase 1.5 可以与 Phase 1–2 合并实施。

## 12. 测试与验收

### 12.1 单元

- 策略解析：always/deferred/hidden、surface 过滤、`requires`、宿主注册过滤。
- catalog：只列当前面；最多 5 条；别的面和宿主工具永不出现。
- `load`：只接受当前面组/名字；成功后可见集合和 guard 同步；失败不改变集合。
- `restrict`：disposer 撤销旧限制；新集合下一步生效。
- surface：共享 cwd 的 WX/home 靠预分配 id 区分；未知会话返回 `null`。
- 返回契约：完整台账、脱敏、投影无 JSON/坐标/置信度/内部 id、`effects` 三态。
- 配置：core UI 写 `bili.*` 后 `dsh-bili` 读到。
- 版本：v3 读 v2 正常；v2 读 v3 跳过、v3 备份被拒。

### 12.2 运行

- Web：只有 core 记忆 + `read_image`；看不到 `wx_*`/`qq_*`/`bili_*`；`her_recall` 能翻到 B 站记忆。
- WX：常驻 10 个左右；`load(['wx.ui'])` 后下一步 `wx_see`/`wx_click` 可用；发送检查不变。
- QQ：`load(['qq.media'])` 后能发；`qq_group_history` 返回正文；`qq_napcat_api` 未知 action 不返回原始 JSON。
- B 站：独立会话；只有 3 个 B 站工具 + core 记忆 + `read_image`；评论进 `utterance`，回复进 `bili_reply`；提示词不含 host 关系层。
- 单调度：B 站只有一条刷站/扫回复路径。
- 首次创建：三个面的第一次会话就挂身份段和工具面。

### 12.3 不算通过

- 工具数量变少，但常见交流多了一轮目录查询。
- Web 仍能看到微信/B 站工具，或 WX 仍收到 B 站说明。
- `her_tools` 能揭示宿主工具、别的面的工具或未注册工具。
- `load` 只改了展示，guard 仍用旧集合，或下一步 schema 没变。
- 为了“可读可不读”隐藏了发送结果、失败原因、不确定性和安全边界。
- 为了分面改了事件流、删了旧字段，或让她主动写的内容在某个面不可召回。
- 把面策略写成人格改写或权限授予。

## 13. 风险与待决

### 风险

- **分类过碎**：组太多、每次对话先查目录，反而更机械。常用动作必须常驻；组按场景而不是按函数拆。
- **缓存抖动**：频繁 `load`/卸载会让 prompt 缓存反复失效。一次加载一个场景组，不在每轮切换。
- **两套来源**：`surface.register` 又声明工具、`config.tools.allow` 又留一份，会导致策略漂移。工具可见性只认 `tool-policy`。
- **发现变授权**：`her_tools` 只改可见性；发送闸和 guard 不能跟着放宽。
- **说明不足**：deferred 工具的 `summary` 太短，模型无法判断该不该打开；`describe` 必须能补足关键限制。
- **首次创建漏挂**：session id 在 create 后才落盘；必须预分配 `sessionId` 并 `reserve`。
- **双调度**：B 站 core 调度和 `dsh-bili` 调度并存会双刷站、双写事件；必须同批停用。
- **vendor 未覆盖**：QQ 没有 `post-execute` 或不能改写 content 时，原始 JSON 会漏；自检必须显示 `legacy`。
- **v3 不可降级**：同一 `events.jsonl` 不能原地回退；dev 必须独立 fish home。
- **指标被 Goodhart**：只压短投影、只减少工具数，会让“假成功”和“接不上话”被掩盖；同时看 `falseSuccessRate`、`closureRate`、`taskSuccess`。

### 待决

- `wx.ui`/`wx.stickers`/`qq.media` 等组的最终边界，按 Phase 0 的真实调用频率校准。
- 第一版 `load` 是否只支持组，还是同时保留单工具兜底。
- `revealed` 是否按 session 持久化，还是重启后重新发现。
- Web 是否保留一个极薄的 `bili_go`（只开一次出门，不给浏览/评论权限）。
- B 站评论是否参与 host 侧成长模板的 `beliefCount` 门控（当前建议不参与）。
- QQ 返回投影是否优先 `tools/post-execute`，还是允许明确列出的薄 fork（当前建议优先 post-execute）。
- `fishCore.owner.read()` 是否暴露给 `dsh-bili`（当前建议先留在 core，安全评审后再开）。
- 预分配 `sessionId` 后 `sc.create({ sessionId })` 在目标宿主是否稳定复用（需真机验证）。
- 图片路由是否支持 image block；不支持时哪些工具降级为文本。

## 14. 关键文件

| 文件 | 现状 | 本设计中的角色 |
| --- | --- | --- |
| `src/dsh-fish/lib/restrict.js` | 固定 `FISH_TOOLS`/`HER_TOOLS`、固定 `allowSet`、`isHerAgent` 只认 `HER_DIR` | 改成基于 `tool-policy` 的可变收窄器 |
| `src/dsh-fish/lib/store.js` | `channelOfAgent` 按 cwd/硬编码路径 | 保留兼容；新代码用 surface registry |
| `src/dsh-fish/lib/schema.js` | `EVENT_SCHEMA_VERSION=2`、`ALL_TYPES` | 加 `surface`、`bili_reply`、v3 |
| `src/dsh-fish/lib/persona.js` | `TOOL_BRIEF` 夹带 `bili_watch`、`BSITE_BRIEF` 在 core | 拆 core 记忆工具说明与面工具教程 |
| `src/dsh-fish/lib/selfdoc.js` | 一份身份文档所有面共用 | core 段 + 面段，缓存按 `(root, surface)` |
| `src/dsh-fish/lib/identity.js` | `wakeText` 全局 | 按 session 存 |
| `src/dsh-fish/lib/index.js` | B 站工具注册和调度 | 迁 `dsh-bili`；core 只留记忆工具 |
| `src/dsh-fish/lib/scheduler.js` | 唤醒时 `scanReplies` 渲染 B 站回复 | B 站调度移交 `dsh-bili` |
| `src/dsh-wx/lib/index.js` | 按 cwd 挂微信段、18 个工具 | 改 surface 注册；重点改 `wx_peek`/`wx_ocr`/`wx_context` |
| 宿主 `dsh-tools` | `ctx.tools.register`、`restrict`、`output.schema/render`、`tools/post-execute` | 不改宿主；用现有接口 |
| 宿主 `dsh-agent-loop` | 每步 `agent/pre-step` 重组 prompt 和工具 | 依赖它实现“下一步可见” |
| `docs/superpowers/specs/2026-11-09-bigfish-person-core-surfaces-design.md` | 分面与记忆设计 | 本文的子设计，负责面/事件细节 |
| `docs/superpowers/specs/2026-11-09-bigfish-tool-return-contract-design.md` | 返回契约子设计 | 本文的子设计，负责台账/投影/逐工具细节 |
