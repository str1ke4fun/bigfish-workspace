# 跨会话工作状态与委派适配设计

- 日期：2026-11-23
- 状态：**设计待评审**；v1 按方案 A（父子委派 + 鱼侧状态存储）落笔，Agent Teams 作为 P3 扩展缝
- 范围：`work` 面的 Worker 状态模型、`her_worker` 委派适配层、工头状态查询、评审路径、向“工作头子 + Agent Teams”的扩展
- 关联：
  - `docs/superpowers/specs/2026-11-20-work-delegation-and-phone-intake-design.md`（工作委派与手机派活；本文补充其状态与适配层，前台/微信/手机路径仍以该文为准）
  - `docs/superpowers/specs/2026-11-09-bigfish-tool-exposure-top-level-design.md`
  - `src/dsh-fish/AGENTS.md`（零依赖、事件流只追加、完整测试）
  - 宿主包：`@deepseek-ai/dsh-subagent`、`@deepseek-ai/dsh-tool-subagent-control`、`@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-session-reference`、`@deepseek-ai/dsh-experimental-agent-team`

---

## 0. 摘要

DSH `0.2.1-rc.5` 已经有四类跨会话能力：父子委派链、会话查询、会话引用 `@`、Agent Teams。但它们都不是“任意 session 互通”的总线：父子链只允许直接父子；会话查询要求 cwd 完全相同；会话引用由用户触发且只给文本快照；Agent Teams 是实验性、同 cwd、且会替换经典 subagent 工具。现网 8710 只加载了父子委派链，大肥鱼的策略表又把宿主工具全部挡在外面。

本文把“工头怎么知道 worker 做完了、做得怎么样、怎么评审”从 11-20 的委派流程里单独抽出来，定义五件事：

1. **`WorkUnit` 状态模型**：不依赖具体委派后端，统一记录“派出去的活、当前状态、结构化结果”。
2. **`DelegationBackend` 适配层**：v1 用 `ctx.subagents`；P3 可以换成 Agent Teams / 工作头子，上层工具和数据不变。
3. **状态来源规则**：`activation.result` 是 v1 的主来源；完成通知用于模型叙事；`list_agents` 的 `inactive` 只是存活提示，**永不当作完成**。
4. **结构化报告**：v1 默认只给 `inspect` worker 请求 `outputSchema`；`build` worker 用 closing text，避免宿主把“忘了调结构化工具”强制成 `error`。评审结论由 inspect worker 交 `{summary, filesChanged, verification, blockers, done}`。
5. **扩展缝**：P3 的工作头子是**独立顶层会话 Lead**，登记为 `work` 面但 `bossKind='agent'`，不是 subagent，也不是她本人；`work_report` 是 dsh-fish 工具，只在 work 面 agent 分支放行，并按 lead 会话 id 二次校验。鱼只负责交接和读取 `work_report`，工作头子自己用 Agent Teams 分发。团队模式是部署级切换，不与经典 subagent 在同一 profile 内并存。

一句话：**v1 让鱼当工头、父子链当手；P3 让鱼把活交给一个工作头子，工作头子再当团队 Lead。两层之间用 `WorkUnit` / `WorkReport` 解耦，而不是用会话互相读。**

---

## 1. 目标与非目标

### 1.1 目标

1. 工头能可靠回答“这活是谁在做、做到哪、做完没有、结果是什么”，即使模型上下文轮换、宿主重启、通知被压缩掉。
2. 工头能评审：拿到结构化结果，能派只读 worker 复查；P2 可选看 worker 的工具级事件。
3. 所有状态都有**单一写入点**；事件流仍只追加；worker 原始日志不进她的记忆、不进微信。
4. 把“谁当工头”和“怎么分发”解耦：v1 她当工头；未来可以交给一个工作头子，由工作头子用 Agent Teams 分发。
5. 不改变 11-20 的前台（桌宠/微信）、目录校验、受信闸、权限模型和手机路径；本文只补状态与适配层。
6. worker 的 `read` / `glob` / `grep` / `write` / `bash` 受 `work-guard` 的路径与外发命令检查；命中返回人话并写 `guardHits`，不把“读/联网未硬隔离”留成验收空话。

### 1.2 非目标

- 不做任意 session 的互通总线。
- 不做跨 cwd 的会话读取。
- 不在 v1 启用 session-query 原生工具或 Agent Teams。
- 不做 worker 的实时流式进度；P3 只做工作头子的阶段性汇报。
- 不改 `events.jsonl` schema；不删除、不改写、不重排历史。
- 不把 worker 的完整 transcript、命令输出或文件内容暴露给桌宠/微信。
- 不在 v1 做多级团队；P3 的工作头子只做一层 Lead，teammate 不再派 teammate。
- v1 默认不给 `build` worker 请求 `outputSchema`；结构化报告是 `inspect` 的职责，避免把“忘了调结构化工具”误判成失败。
- v1 不冷恢复已结算 worker 续聊；跟进一律新建 WorkUnit（`followUpOf` 指向旧 unit）。

### 1.3 反目标

- 把 `list_agents` 的 `inactive` 当成完成。
- 模型上下文里没有完成通知、状态文件也没有结果时，假装 `done`。
- 把 session-query 原生工具直接开给 `screen` / `wx`；web/wx/qq 共用 `~/.dsh-fish/home`，会让私聊互相可读。
- 让 worker 伪装成工头汇报；worker 只写自己的 WorkUnit 结果，不写她的记忆或事件流。
- 在同一个 profile 里同时依赖经典 subagent 和 Agent Teams（宿主会禁用经典工具）。
- 团队模式跨 cwd、跨进程或嵌套团队。
- 用状态文件覆盖已结算的结果；每次结算只能写一次。
- 把“请求了 `outputSchema`、worker 没交结构化结果”当成 `done`。宿主会把这种情况的 `stopReason` 强制成 `error`；我们按 `failed` 记，并保留 closing text，不猜成功。
- 在没有 fish 面的 lead 会话上假装 fish 的 `restrict` 会生效。lead 的工具边界由 `fish-work-lead` preset 和 `work_report` 的会话 id 授权负责。
- 把 `work-guard` 当内核隔离。它是代码级 denylist，挡常见路径和命令，挡不住任意二进制、混淆或包管理器脚本；内核级读/网络隔离是 P4。

---

## 2. 现状与关键事实

### 2.1 DSH 的四类跨会话能力

| 机制 | 作用范围 | 读到/写到什么 | 现网 8710 | 大肥鱼可见 |
|---|---|---|---|---|
| 父子委派链（`subagent`、`subagent_fork`、`send_message`、`interrupt_agent`、`list_agents`） | 父 ↔ 直接子；祖 → 后代可 interrupt | 完成通知带 stopReason、最终回答、可选 structured result、diagnostic；`list_agents` 只有 `running` / `inactive` | 已加载 | 否（被策略表挡住） |
| 会话查询（`session_search`、`session_event_search`、`session_trace`、`session_event_trace`、`session_event_read`） | 调用方与目标 **cwd 严格相等** | 事件级搜索、追踪、完整事件 JSON | 未加载；FTS `openAt: never` | 否 |
| 会话引用 `@session` | 用户选择的任意会话 | 有界文本快照：用户/助手文本 + compaction 检查点；不含工具调用、工具结果、reasoning；不可信背景 | 已加载（Web UI） | 只能由用户注入 |
| Agent Teams（`spawn_teammate`、`send_message`、`list_agents`、`wait_agent`、`interrupt_agent`、`team_task_*`） | 同一 Team 的任意成员；所有成员共享同一 cwd | 成员状态、消息、共享任务板；任务有 owner/status/CAS | 未加载 | 否 |

### 2.2 现网装配

- `~/.dsh/profiles/web/cordis.patch.yml` 加载了 `tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`。
- `dsh-web-app` 默认 patch 加载 `dsh-session-reference`，Web UI 的 `@` 引用 source 可用；`session-query-sqlite` 是 `openAt: never`，`dsh-tool-session-query` 未挂载。
- `dsh-experimental-agent-team` / `dsh-experimental-tool-agent-team` 未加载。
- 大肥鱼每个面的策略表只含自己的工具；`~/.dsh-fish/config.json` 的 `tools.allow` 为空，`restrict` 打开；`restrict.js` 的 guard 用同一个 allow 集合兜底。宿主工具默认全部不可见。

### 2.3 完成通知的实际内容

宿主在子会话结算后，向父会话注入一条 user 消息，内容为：

1. 一句状态摘要：`completed` / `aborted` / `max-tokens` / `refusal` / `error`。
2. 子会话的 closing message（最终文本）。
3. 如果调用方请求了 `outputSchema` 并成功，附 `Structured result: {...}`。
4. 失败时的 diagnostic。

这是 **push**，不是 **pull**。宿主没有“查询子会话最终结果”的工具；`list_agents` 的 `inactive` 只表示当前没有轮次在执行，不表示任务完成。

### 2.4 关键限制

- `send_message` 只允许父 → 直接子、驻留子 → 直接父；兄弟和无关会话不能互发。
- `interrupt_agent` 允许祖辈打断直接子或更深后代；不能打断兄弟。
- 子会话的完整工具日志不会进入父会话；只有 closing message / structured result / diagnostic。
- 会话查询按 cwd 授权；不同工作目录的会话互相不可见。
- 会话引用不按 cwd 授权，但必须由用户在消息里显式 mention；模型不能自己发起。
- Agent Teams 要求所有成员共享同一工作目录，不支持独立工作目录、跨进程协调；开启团队 profile 会禁用经典 `subagent` / `subagent_fork` 和全局 child control。

### 2.5 结构化输出与续聊的宿主行为

已核对 `0.2.1-rc.5` 的 `dsh-subagent`：

- 请求了 `outputSchema` 后，如果子会话以 `completed` 结束但没有提交结构化结果，`captureLocalResult` 会把它强制成 `stopReason:'error'`。仅凭 `stopReason` 无法区分“worker 忘了调 `structured_output`”和真实错误。
- 已提交结构化结果的子会话 `acceptsInput() === false`，此时 `send_message` 会抛 `INPUT_CLOSED`；正在提交或已提交的 worker 不再接受消息。
- 冷恢复的 `subagent/descriptor` 明确不保存 `outputSchema`（它属于一次 activation 的结果契约），所以对已结算 worker 的续聊不会恢复结构化工具。
- 结论：**只在 inspect 上请求 `outputSchema`**；build 用 closing text + 后续 inspect 评审；对已结算 unit 的跟进一律新建 WorkUnit，而不是 `message` 冷恢复。

---

## 3. 方案与取舍

### A. 父子委派链 + 鱼侧状态存储（v1 选定）

- 鱼在工作会话里当工头，用 `her_worker` 包装 `ctx.subagents.startActivation()` 派 worker。
- `her_worker` 持有 `activation.result`，结算时把状态、closing text 和（仅 inspect 的）结构化报告写进 `work-units.json`。
- `inspect` worker 请求 `outputSchema`，交结构化评审；`build` worker 不请求，用 closing text，避免宿主把“忘了调结构化工具”强制成 `error`。
- 工头用 `her_worker_control` 包装发消息、打断、列状态、读结算结果；不把宿主 `send_message` / `list_agents` 直接写进策略表。`message` 只对 `queued` / `running` unit 生效；已结算的跟进新建 WorkUnit。
- 评审靠只读 `inspect` worker；v1 不开放会话查询。

**收益**：没有新的宿主能力依赖；状态可持久化、可重启、可跨模型上下文轮换；工具面窄；符合 11-20 的工头/worker 模型；build 不会因为忘了结构化工具被误判失败。

**代价**：build 的“具体完成状态”是 stopReason + closing text，文件改动和验证结论来自后续 inspect worker；看不到 worker 的工具级执行记录。要更细的评审需 P2 的窄会话查询。

### B. A + 窄会话查询（P2 可选）

- 在 A 之上加 `her_worker_events`，内部调用 `ctx.sessionQuery` 的精确读取，只允许工头读**自己 WorkUnit 的 worker 后代**、且 cwd 与工头相同的会话。
- 不开放全局 `session_search` / `session_event_read` 工具；权限在 fish 工具里按 WorkUnit 记录收窄。
- **收益**：评审能看到 worker 跑了什么命令、改了哪些文件。
- **代价**：多一层读隔离和宿主 API 耦合；必须防住“顺手读到 web/wx 私聊”。建议 P2。

### C. 工作头子 + Agent Teams（P3 扩展）

- 鱼不再自己当工头，而是把目录和任务交给一个**独立的工作头子会话**（`bossKind: 'agent'`）。
- 工作头子是顶层 DSH 会话，登记为 `work` 面但 `bossKind='agent'`；它使用 `fish-work-lead` preset，作为 Team Lead 用 Agent Teams 创建 teammate、管任务板、汇总。
- 工作头子通过 dsh-fish 的 `work_report` 工具把阶段性/最终报告写进 `work-sessions.json` 的 boss 记录（含 teammate 摘要）；该工具只在 work 面 agent 分支放行。鱼只读 `her_work_status`，不进 teammate 会话，不读它们的 transcript。
- **P3 不使用 fish 侧的 `team` 适配器**：Team 工具由工作头子直接调用；`DelegationBackend` 只服务 v1 的 fish boss。Fish 侧与 P3 的契约是 `work_report` + boss 记录，不是 `ctx.subagents`。
- **为什么不是 v1**：Agent Teams 是实验性的、要求所有成员同 cwd、开启后会禁用经典 subagent 工具；v1 的“一个工头 + 两个 worker”用父子链更简单、更可测。
- **为什么不是“鱼直接当 Team Lead”**：Team 要求成员共享同一工作目录，而鱼的屋子 cwd 是 `~/.dsh-fish/home`，不是工作目录；把鱼的会话 cwd 换到工作目录会污染她的身份、记忆和屏幕陪伴。工作头子作为独立会话更干净。
- **为什么不是“把工作头子 spawn 成 subagent”**：团队 profile 禁用经典 `subagent`，而且 Team 成员不能再当另一个 Team 的 Lead；工作头子必须是独立顶层会话，才能自己当 Lead。

### 3.4 共同原则

1. **状态源唯一**：创建 WorkUnit 的工具是唯一写入者；完成通知只用于模型叙事，不作为状态源。
2. **适配层隔离**：`her_worker` / `her_worker_control` 只依赖 `DelegationBackend` 接口，不直接依赖 `ctx.subagents` 的细节。
3. **宿主工具默认不进策略表**：fish boss 分支用 `her_worker_control` 包装，不放原生 `send_message` / `list_agents`；P3 的 work 面 agent 分支是显式例外，按部署放行 Team 工具，并在自检里标明。
4. **只读评审**：评审用 inspect worker 或窄事件读取，不给工头 fs/bash，不给评审者写权限。
5. **失败如实**：没有结果就是 `unknown`，不把 `inactive`、超时、上下文丢失写成 `done`。
6. **guard 先行**：worker 的 fs/bash 调用先过 `work-guard`；guard 挂不上就不派 worker（fail closed）。命中写 `guardHits`，不吞掉。

---

## 4. 架构

### 4.1 分层

```text
桌宠 / 微信
   │ her_work
   ▼
工作会话（bossKind = fish | agent，cwd = 用户目录）
   │
   ├─ v1（fish boss）：her_worker ─→ DelegationBackend(subagent)
   │       ├─ worker inspect（只读）── work-guard
   │       └─ worker build（读写 + 命令）── work-guard
   │
   └─ P3（agent boss）：工作头子（Team Lead）─→ Agent Teams
           ├─ teammate A
           ├─ teammate B
           └─ 共享任务板
   │
   ▼ work_report / activation.result
work-units.json ←── her_work_status（screen / wx / work）
```

### 4.2 会话与面

| 会话 | 面 | cwd | preset | 谁当工头 | 谁可见 |
|---|---|---|---|---|---|
| 陪伴会话 | `screen` | `~/.dsh-fish/home/screen` | 宿主默认 | — | 桌宠 |
| 工作会话 v1 | `work` | 用户指定目录 | `fish-work-boss` | 鱼 | 桌宠气泡、微信、AA、工作台 |
| 工作会话 P3 | `work`（`bossKind='agent'`） | 用户指定目录 | `fish-work-lead` | 工作头子 | 用户在 UI/AA 可见；鱼只读状态 |
| worker v1 | 不登记（fish 不认） | 继承工头 cwd | `fish-work-inspect` / `fish-work-build` | — | 只在工头的 WorkUnit 记录里 |
| teammate P3 | 不登记（Team 成员） | 共享工作目录 | 工作头子决定 | — | 只在工作头子的任务板/报告里 |

- v1 的工作会话是**鱼本人**，挂身份段和 `fish:owner`；事件面仍写 `web`（见 11-20 §5.4）。
- P3 的工作头子**不是鱼**：虽然登记为 `work` 面，但 `bossKind='agent'`，不挂她的身份、不写 `events.jsonl`、不写她的记忆；它只通过 `work_report` 写运行状态。
- 工作目录必须由用户显式给出；同一目录复用一条工作会话。
- 工作会话必须先 `surface.reserve(sessionId, 'work')` 再创建；重启后靠 `work-sessions.json` 的 session id 重新 reserve。

### 4.3 `DelegationBackend` 接口

v1 只需要 `subagent` 适配器；P3 增加 `team` 适配器。上层工具和数据不随后端变化。

```ts
type UnitMode = 'inspect' | 'build'
type BossKind = 'fish' | 'agent'

interface DelegationBackend {
  readonly name: 'subagent'   // v1 fish boss 唯一实现；P3 的工作头子不走这个接口

  capabilities(): {
    structuredOutput: boolean   // 是否能请求 outputSchema
    peerMessaging: boolean      // 是否能成员间互发
    taskBoard: boolean          // 是否有共享任务板
    maxConcurrent: number       // 建议并行上限
  }

  spawn(input: {
    unitId: string
    dir: string                 // 必须等于 boss cwd
    mode: UnitMode
    label: string
    task: string
    preset?: string
    outputSchema?: object
    signal?: AbortSignal
  }): Promise<{ ref: unknown }>

  message(ref: unknown, text: string): Promise<{ messageId: string }>
  interrupt(ref: unknown): Promise<{ accepted: boolean }>
  list(scope: 'children' | 'descendants'): Promise<Array<{
    ref: unknown
    status: 'running' | 'inactive' | 'unknown'
    label?: string
  }>>

  /** 后端结算时回调；返回取消订阅函数。v1 内部持有 activation.result。 */
  onSettle(ref: unknown, cb: (result: SettleResult) => void): () => void
}

interface SettleResult {
  stopReason: 'completed' | 'aborted' | 'max-tokens' | 'refusal' | 'error' | 'unknown'
  closingText: string
  structured?: unknown
  diagnostic?: string
}
```

- **v1 `subagent` 适配器**：`spawn` 调 `ctx.subagents.startActivation({ provider:'spawn', request:{ parent, cwd, agentPreset, prompt, maxDepth:1, outputSchema }, delivery:'parent' })`；`message` 调 `ctx.subagents.sendMessage()`（仅运行中的 unit）；`interrupt` 调 `ctx.subagents.interrupt()`；`list` 调 subagent catalog；`onSettle` 监听 `activation.result`。
- **P3 不走这个适配器**：工作头子自己调用 Agent Teams 工具；fish 只通过 `work_report` 读取 boss 记录。Fish 侧不需要、也不应该实现 `team` 适配器。
- **能力检测**：`ctx.subagents` 不存在或 provider 不可用 → `her_worker` 返回“这台机器不支持派活”；`bossKind:'agent'` 但 Team profile/`fish-work-lead` preset 不可用 → `her_work` fail closed，不静默切换到 fish boss。
- **不混用**：`bossKind:'agent'` 的部署启用 Team profile 后，经典 `subagent` 工具在宿主层已被禁用；fish 不尝试调用它。`bossKind:'fish'` 的部署不加载 Team profile。

### 4.4 工头模式

#### `bossKind = 'fish'`（v1）

- 工头是鱼，在 `work` 面。
- 工具：`her_worker`、`her_worker_control`、`her_ask_user`、`her_recall`、`growth_commit`。
- **不挂**：bash、fs、fs-search、subagent、skill、plugin-manager、web、goal、plan-mode；也不挂原生 `send_message` / `list_agents`。
- 工头的派生状态写 `work-units.json`；它的记忆写入仍走 `growth_commit`，不写 worker 事件。

#### `bossKind = 'agent'`（P3）

- 工头是一个独立的工作头子会话，preset `fish-work-lead`：人格是执行者，不是鱼；挂 Agent Teams 工具、任务板、`work_report`。
- 工作头子**登记为 `work` 面**（`surface.reserve(leadSessionId, 'work')`），但 `bossKind='agent'`：`identity.js` 不挂她的身份，`capture.js` 不写事件流，`pet-view` 不把它当她。它仍然受 fish 的 `restrict` 保护，工具面由 work 面策略按 `bossKind` 分支决定。
- `work_report` 是 dsh-fish 注册的 fish 工具，在 work 面策略里只对 `bossKind='agent'` 放行；执行时再用 `exec.agent.session.header.id` 匹配 boss 记录做二次校验。Team 工具是宿主全局工具，也在 work 面的 agent 分支放行；不靠 preset 注入 fish 工具。
- `fish-work-lead` preset 只提供执行者人格、时间上下文、compaction 等非工具/低频插件；工具由 fish 的 work 面策略给，避免 preset 注入不了 fish 工具的问题。
- `tool-policy.js` 的 work 面按 `caps.workBoss = 'fish' | 'agent'` 分支：fish 分支给 `her_worker` / `her_worker_control` / `her_ask_user` / 记忆；agent 分支给 `work_report` / Team 工具 / todo / 时间。`restrict.js` 从 `work-sessions.json` 读 `bossKind` 作为这个 cap，不能只凭 surface 是 `work` 就放行两边的工具。
- Team 工具是 team 插件在成员 Agent 的 **own 层**注册的；`restrict` 掩不住 own 层（`restrict.js` 已有这条注释），所以 lead 的 Team 工具由 **guard 的 allowSet** 决定：agent 分支把 Team 工具名显式放进 allowSet，不依赖 `restrictableNames` 求交集；不在 allowSet 的调用仍被 guard 拒绝。
- 鱼通过 `her_work` 向该会话注入任务（与 `say.js` 同一套 `sessionController` 注入）；不要求父子关系。
- 工作头子用 Team 创建 teammate；teammate 共享工作目录，不能再派 teammate。
- 工作头子通过 `work_report` 上报：顶层状态 + 可选 teammate 摘要；不把 teammate 原始日志写给鱼。
- 鱼只读 `her_work_status`；不读工作头子的 transcript，不进 teammate 会话。
- **部署级切换**：`work.delegation.bossKind = 'fish' | 'agent'`。`fish` 要求 `ctx.subagents`；`agent` 要求启用 `dsh-experimental-agent-team-profile` + `fish-work-lead` preset，该 profile 会禁用经典 subagent 工具。两种模式不在同一 profile 内热切换。

### 4.5 工具

| 工具 | 面 | 作用 | 关键限制 |
|---|---|---|---|
| `her_work` | `screen` / `wx` | 创建/复用工作会话，投任务 | 目录显式给出；受信闸；不猜目录 |
| `her_work_status` | `screen` / `wx` | 返回目录、工头种类、boss 状态、活跃 WorkUnit 数、最近汇总、是否等用户 | 不返回 worker 日志、命令输出、文件内容 |
| `her_worker` | `work`（fish boss） | 派 worker；返回 `unitId` + `childId` | 无 `cwd` 参数；cwd 固定工头 cwd；`workspace-write` 校验；并行上限 2，build 1；inspect 请求 `outputSchema`，build 不请求 |
| `her_worker_control` | `work`（fish boss） | `message` / `interrupt` / `list` / `get` | `message` 只对 `queued`/`running`；`list` 可带 `scope:'current'|'dir'` 并返回 `childId`；`get` 返回本工头 unit 的 summary/report；不返回原始日志 |
| `her_ask_user` | `work`（fish boss） | 记录 boss `waiting` 并结束本轮 | 不依赖结构化审批 UI |
| `work_report` | `fish-work-lead`（P3） | 工作头子写 boss 记录（状态/汇总/teammate 摘要） | 按 lead 会话 id + 目录授权；有界；过 guard；不写 WorkUnit 原始日志 |
| `her_worker_events` | `work`（P2 可选） | 读本工头 worker 的事件级记录 | 仅同 cwd、仅本工头 WorkUnit 的后代；不开放全局工具 |

**`her_worker` 参数**：

```jsonc
{
  "mode": "inspect" | "build",   // 缺省 inspect
  "task": "把 foo 模块的测试补上",
  "label": "补测试",             // 可选
  "reviewOf": "wu_...",         // 可选；评审型 worker 指向被评审的 WorkUnit
  "followUpOf": "wu_..."        // 可选；跟进/重试新建的 unit 指向旧 unit
}
```

返回 `{ ok: true, unitId, childId, mode, note: 'worker 派出去了' }`。`childId` 用于把宿主的完成通知（以 child session id 为主语）映射回 unit。启动失败分两种：参数/权限/面校验失败不建 unit；校验通过但后端 `startActivation` 失败，建一个 `failed` unit 并返回 `{ ok:false, unitId, why }`，不假装成功。

**`her_worker_control` 参数**：

```jsonc
{
  "action": "message" | "interrupt" | "list" | "get",
  "unitId": "wu_...",     // message / interrupt / get 必填
  "text": "...",          // message 必填
  "scope": "current" | "dir"  // list 可选，缺省 current
}
```

- `message` 只对 `queued` / `running` unit 生效；返回 `{ ok, messageId }`，不返回 worker 回复。对 `done` / `failed` / `aborted` 返回 `{ ok:false, why:'unit-settled', note:'要跟进就新建一个 worker' }`，不做冷恢复。后端返回 `INPUT_CLOSED`（worker 已提交结构化结果）时返回 `{ ok:false, why:'input-closed', note:'等它结算，或新建一个 worker' }`，不重试。
- `interrupt` 返回 `{ ok, accepted }`；不等待 worker 完全停稳；对已结算 unit 是空操作。
- `list` 返回本工头 WorkUnit 的 `{ unitId, childId, label, mode, status, updatedAt }`；`scope:'dir'` 返回该目录所有工头（含旧会话）的只读列表；不返回结果正文。
- `get` 返回本工头 unit 的 `{ unitId, childId, status, stopReason, failureKind, summary, report, updatedAt }`；`report` 只对 inspect/结构化结果存在；不含原始日志。

### 4.6 状态写入点

| 事件 | 写入者 | 写入内容 |
|---|---|---|
| `her_work` 创建/复用 boss | `her_work` | 写 `work-sessions.json` 的 boss 记录（`state='running'`、`lastUsedAt`） |
| `her_worker` 启动成功 | `her_worker` | 新建 WorkUnit，`status='queued'`，记录 `backendRef.childId` |
| `her_worker` 校验通过但启动失败 | `her_worker` | 新建 `failed` WorkUnit，`failureKind='start'`，`summary` 为失败原因 |
| 后端结算 | `DelegationBackend.onSettle` | 写 `status` / `stopReason` / `failureKind` / `summary` / `report` / `settledAt`；只写一次；同时更新 boss 的 `lastSummary` |
| `her_worker_control.message` | `her_worker_control` | 只更新 `lastEventAt`；不改结果 |
| `her_ask_user` | `her_ask_user` | 写 boss 记录 `state='waiting'`、`waitingQuestion` |
| 工头 `turn/end` | `work.js` 的事件监听 | 没有 `waiting` 且没有活跃 unit → `state='idle'`；否则保持 `running` |
| `her_work` 收到用户回复 | `her_work` | 清 `waitingQuestion`、`state='running'` |
| `work_report`（P3） | 工作头子 | 更新 `work-sessions.json` 的 boss 记录 `state` / `lastSummary` / `lastReport`；不写 WorkUnit 正文 |
| `her_work_status` | 只读 | 不改状态 |
| 宿主启动 | `work.js` 对账 | `running` 但后端不可见 → `unknown`；不改成 `done` |

**完成通知不是状态源**：它进入模型上下文，让工头知道该汇总了；真正的状态以 WorkUnit / boss 记录为准。工头用 `her_worker_control.get` 或 `her_work_status` 读取持久化结果，即使通知被上下文压缩掉也能回答。

### 4.7 评审

1. **v1**：`build` worker 不请求 `outputSchema`，结束时交 closing text；工头在它结算后派一个 `mode:'inspect'`、`reviewOf` 指向该 WorkUnit 的只读 worker。inspect worker 请求 `outputSchema`，用 fs/fs-search 检查文件、跑只读命令，交结构化评审；如果它没交结构化结果，宿主会把 `stopReason` 记成 `error`，本设计把它记为 `failed`（评审失败），由工头重派。工头汇总 build 的 closing text 和 inspect 的结构化报告。
2. **P2**：`her_worker_events` 读取 build worker 的事件级记录，核对命令、文件改动、失败重试；只对同 cwd、本工头 WorkUnit 的后代生效。
3. **P3**：工作头子用任务板的 owner/status 和 teammate 报告做评审；鱼只读顶层汇总。
4. **永远不把 worker 的自述当唯一证据**：结构化报告里要求 `verification`（跑了什么、结果如何），inspect worker 负责抽查。

### 4.8 与 11-20 的差异

| 11-20 设计 | 本文修订 | 原因 |
|---|---|---|
| 工头 preset 挂原生 `send_message` / `interrupt_agent` / `list_agents` | 改为 `her_worker_control` 包装 | 保持“宿主工具不进策略表”；为按 `bossKind` 分支的工具面留缝 |
| `her_work_status` 返回 `lastSummary`，未定义来源 | 由 `activation.result` / `work_report` 写入 `work-sessions.json` 的 boss 记录 | 通知是 push，不能作为唯一状态源；boss 状态和 worker unit 分开存 |
| worker 完成只靠完成通知 | `activation.result` 持久化结算结果；inspect 请求 `outputSchema`，build 用 closing text | 宿主会把“请求了 outputSchema 但没交”强制成 error；build 不该被这个规则误伤 |
| 没有跟进/续聊规则 | `message` 只对 `queued`/`running`；已结算的跟进新建 WorkUnit（`followUpOf`） | 结构化结果提交后 `INPUT_CLOSED`，冷恢复不恢复 outputSchema |
| 没有评审路径 | v1 inspect worker；P2 窄事件读取 | 工头需要能验证“真的做完了” |
| 只有 fish boss | 预留 `bossKind:'agent'` + `work_report`；不实现 fish 侧 `team` 适配器 | P3 的工作头子是独立顶层会话、自己调 Team 工具；fish 只读 boss 记录 |
| 没写清 Agent Teams 的冲突 | 明确团队模式是部署级切换、禁用经典 subagent、同 cwd、不嵌套 | 避免实现时同时依赖两套委派 |

11-20 的桌宠/微信接线、目录校验、受信闸、手机路径仍按原文执行；读隔离已定 G，按本文 §4.9 与 11-20 §5.5 的 G 规则执行。本文只覆盖 §4.2 的工头工具、§5.1 的状态、§5.3 的 `her_work_status` 和新增的适配层。

### 4.9 `work-guard`（G 已选）

- 注册在 dsh-fish 的全局 `tools/pre-execute`；只对 worker 会话生效。
- 识别 worker：`exec.agent.session.header.id` 在 `work-units.json` 的 `backendRef.childId` 里，或 `header.parentSession` 指向一个 `bossKind='fish'` 的 work 会话且 preset 是 `fish-work-inspect` / `fish-work-build`。两者任一命中；都不可判定时，worker 的 fs/bash 调用一律拒绝（fail closed）。
- 检查：
  - `read` / `glob` / `grep` / `write` / `edit`：路径 realpath 必须在工头 cwd 内；受保护路径（`~/.ssh`、`~/.aws`、`~/.dsh`、`~/.dsh-fish`、`/etc/shadow` 等）一律拒绝。
  - `bash`：命令字符串命中秘密路径或常见外发命令（`curl`、`wget`、`nc`、`ssh`、`scp`、`rsync`、`git push` 等）时拒绝；包管理器（`npm` / `pnpm` / `pip`）允许，但 cache 指到工作目录或 `/tmp`，裸外发仍拦。
- 命中：工具调用返回人话“这件事得先问过用户，不能直接做”；不执行。命中先按 childId 记在内存队列，`her_worker` 结算时 flush 到对应 WorkUnit 的 `guardHits`（≤200 字，脱敏，最多 10 条）；找不到 unit 时仍拒绝并记日志，不吞。
- 写 `guardHits` 与结算写状态共用 `work-state.js` 的串行队列，避免并发覆盖；终态只写一次，guard 命中可以在终态前追加；宿主重启丢失未 flush 的 `guardHits` 只影响审计，不放松拒绝。
- guard 挂不上（插件初始化失败、无法判定 worker）时，`her_worker` 不派 worker，返回失败；不出现“没 guard 的 worker”。
- 这是代码级 denylist，不是内核隔离；P4 才做 bwrap/容器。

---

## 5. 契约与数据

### 5.1 `work-sessions.json`

位置：`~/.dsh-fish/work-sessions.json`（运行数据，不进 Git；原子写，权限 0600）。

```jsonc
{
  "/home/str1k3/src/some-project": {
    "sessionId": "…",
    "bossKind": "fish",              // fish | agent
    "title": "干活 · some-project",
    "preset": "fish-work-boss",      // agent boss 时为 fish-work-lead
    "backend": "subagent",           // fish boss = subagent；agent boss = team
    "state": "idle",                 // idle | running | waiting | unknown
    "waitingQuestion": null,         // state=waiting 时的问题
    "lastSummary": "",               // 最近一次结算/汇报的摘要，≤2000 字
    "lastReport": null,              // P3 顶层 report；有界
    "createdAt": "2026-11-23T…",
    "lastUsedAt": "2026-11-23T…",
    "lastOrigin": { "surface": "wx", "chat": "文件传输助手" }
  }
}
```

- 只保留最近 20 个目录；不自动删除已有会话。
- 文件读坏按空处理；下一次 `her_work` 重建映射，不抛到工具调用。
- `backend` 与 profile 的实际能力不一致时，`her_work` 拒绝并说明，不静默改后端。
- `state` 是 **boss 状态**，不是 worker 状态：`her_work` 置 `running`，`her_ask_user` 置 `waiting`，结算/`work_report` 回到 `idle`（P3 由工作头子决定）；宿主重启或 P3 lead 崩溃无法确认时置 `unknown`。
- `lastSummary` 是 `her_work_status` 的直接来源；由结算回调或 `work_report` 写，不由 `her_work_status` 自己推断。

### 5.2 `work-units.json`

位置：`~/.dsh-fish/work-units.json`（运行数据，不进 Git；原子写，权限 0600）。

```jsonc
{
  "version": 1,
  "units": [
    {
      "id": "wu_01J…",
      "dir": "/home/str1k3/src/some-project",
      "bossSessionId": "…",
      "bossKind": "fish",            // fish | agent
      "backend": "subagent",         // fish boss = subagent；agent boss = team
      "kind": "worker",              // worker | teammate（没有 work-boss unit）
      "mode": "build",               // inspect | build；teammate 为 null
      "label": "补测试",
      "reviewOf": null,              // 可选，评审型 worker 指向被评审 unit
      "followUpOf": null,            // 可选，跟进/重试指向旧 unit
      "status": "running",           // queued | running | done | blocked | failed | aborted | unknown
      "stopReason": null,            // completed | aborted | max-tokens | refusal | error | null
      "failureKind": null,           // start | timeout | structured-missing-or-error | sandbox | null
      "summary": "",
      "report": null,                // inspect/teammate 的结构化结果；build 为 null
      "guardHits": [],               // G 已选；每条 ≤200 字，最多 10 条
      "backendRef": { "childId": "…" },
      "createdAt": "2026-11-23T…",
      "updatedAt": "2026-11-23T…",
      "settledAt": null
    }
  ]
}
```

- 只保留最近 200 个 WorkUnit；已完成超过保留量的最旧记录删除。
- `summary` 压平换行，最多 2000 字；`report` 每个数组最多 20 条、每条最多 500 字；`teammates` 最多 16 条。
- `report` 只在 `inspect` / `teammate` 上出现；`build` 的 `report=null`，结论看 `summary` + 后续 inspect。
- `failureKind` 只用于分类，不替代 `stopReason`：`start`（启动失败）、`timeout`（fish 定时器打断）、`structured-missing-or-error`（请求了 `outputSchema` 但没拿到，宿主记 error）、`sandbox`（只在 G 的 `work-guard` 明确拒绝时写；其他 sandbox 拒绝按 `blocked`/`failed` 和 stopReason 处理）。
- `guardHits` 由 `work-guard` 写入；每条脱敏，最多 10 条；与结算共用 `work-state.js` 串行队列，终态前可追加，终态后不再写。
- 不含原始命令、完整文件内容、凭据、路径清单；过 `guard.looksLikeSecret`，命中则只留“详情在电脑上”。
- 文件读坏按空处理；下一次写入重建。读取时忽略未知字段，便于 P3 扩展。
- **活跃计数谓词**：`status ∈ {queued, running}` 且 `backendRef` 存在。`blocked` / `done` / `failed` / `aborted` / `unknown` 不计入 `maxActive` / `maxBuild`；`unknown` 只展示、不阻塞新派活。
- 启动失败（`failureKind='start'`）的 unit `backendRef=null`、`childId` 不出现；`list`/`get` 仍能看到它，工头不会把它当成在跑。

### 5.3 状态枚举与映射

| 状态 | 含义 |
|---|---|
| `queued` | 已创建，尚未确认启动 |
| `running` | 后端已接受，正在执行 |
| `done` | `stopReason='completed'`，且没有 blocker / `report.done !== false` |
| `blocked` | `stopReason='completed'`，但 `report.done=false` 或 `blockers` 非空；工人做完了本轮，但需要工头/用户决定 |
| `failed` | `max-tokens` / `refusal` / `error` / 启动失败；inspect 请求了 `outputSchema` 却没交也算失败 |
| `aborted` | 被 `interrupt` / 超时 / 宿主取消 |
| `unknown` | 重启/结果丢失/后端不可见；**不是完成** |

`waiting` 不是 worker 状态，放在 `work-sessions.json` 的 boss 记录里。

映射：

- `completed` 且无 blocker / `report.done !== false` → `done`
- `completed` 且有 blocker / `report.done === false` → `blocked`
- `aborted` → `aborted`
- `max-tokens` / `refusal` / `error` → `failed`（`stopReason` 保留细分；`failureKind` 标 `structured-missing-or-error` / `sandbox` / `timeout` 等）
- 请求了 `outputSchema` 但没有结构化结果 → 宿主强制 `error` → `failed`；对 inspect 来说这是评审失败，重派 inspect；对 build 不请求 `outputSchema`，不会走到这条
- 没有结算结果、或启动后宿主重启且后端 list 不可见 → `unknown`
- `list_agents` 的 `running` → 仅把 `unknown` 修正为 `running`；`inactive` **不**把任何状态改成 `done` 或 `blocked`

### 5.4 结构化报告 schema（v1）

v1 默认**只给 `inspect` worker** 请求 `outputSchema`；`build` worker 不请求，用 closing text。`work.delegation.structuredOutput = 'inspect-only' | 'all' | 'none'`，默认 `inspect-only`。

```jsonc
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "done"],
  "properties": {
    "summary": { "type": "string" },
    "filesChanged": { "type": "array", "items": { "type": "string" } },
    "verification": { "type": "array", "items": { "type": "string" } },
    "blockers": { "type": "array", "items": { "type": "string" } },
    "done": { "type": "boolean" }
  }
}
```

- 宿主只接受它支持的 JSON-schema 子集；`maxLength` / `maxItems` 不放进去，长度和条数在 `work-units.json` 持久化时截断（§5.2）。
- inspect worker prompt 明确：完成前必须调用 `structured_output`；不要用纯文本结束。没交结构化结果时宿主把 `stopReason` 强制成 `error`，本设计记 `failed` + `failureKind='structured-missing-or-error'`，工头重派 inspect；不降级成 `done`。
- 后端 `capabilities().structuredOutput === false` 时，inspect 退化为 prose：`report=null`，`summary` 取 closing text，状态按 `stopReason`；这是明确的降级，验收里不能写成“结构化评审通过”。
- `done=false` 但 `stopReason='completed'`：状态记 `blocked`，`report.blockers` 保留；这是“做完了但有未完成项”，由工头决定是否再派。
- `structuredOutput='all'` 时 build 也请求；一旦 build 没交结构化结果，同样记 `failed`。这是可选配置，默认不开，避免把正常 build 误判失败。

### 5.5 适配器选择与能力检测

配置（部署或运行配置，不进 Git）：

```jsonc
{
  "work": {
    "delegation": {
      "bossKind": "fish",            // fish | agent（P3）
      "backend": "subagent",         // fish = subagent；agent = team
      "structuredOutput": "inspect-only", // inspect-only | all | none
      "maxActive": 2,
      "maxBuild": 1,
      "runTimeoutMs": 1800000
    }
  }
}
```

- `bossKind='fish'` + `backend='subagent'`：要求 `ctx.subagents` 有 `spawn` provider；否则 `her_worker` fail closed。
- `bossKind='agent'` + `backend='team'`：要求 Team profile 已加载、`fish-work-lead` preset 可用；否则 `her_work` 拒绝创建 agent boss。Fish 不实现 `team` 适配器，只读 `work_report`。
- 不自动从 `subagent` 回落到 `team`，也不反向回落；日志和自检显示实际 bossKind/backend。
- `work.delegation.backend` 与 `work-sessions.json` 中记录的 `backend` 不一致时，`her_work` 提示“这个目录的工作会话属于另一种后端”，让用户决定复用还是新建。
- `runTimeoutMs` 由 fish 侧定时器执行：超时调 `interrupt`，状态记 `aborted` + `failureKind='timeout'`；宿主重启后定时器丢失，启动对账把 `running` 记 `unknown`，不自动重派。
- `maxActive` / `maxBuild` 只数 `queued` + `running`（§5.2）；`unknown` 不占名额。
- `work-guard` 是 P1 必需，不提供“关闭 guard、只靠 prompt”的配置；guard 初始化失败或无法判定 worker 时，`her_worker` fail closed。

### 5.6 P3 `work_report` 契约

工作头子调用：

```jsonc
{
  "status": "running" | "waiting" | "done" | "failed" | "aborted",
  "summary": "…",
  "report": {
    "filesChanged": ["…"],
    "verification": ["…"],
    "blockers": ["…"],
    "done": true,
    "teammates": [
      { "name": "reviewer", "status": "done", "summary": "…" }
    ]
  }
}
```

- 只更新 `work-sessions.json` 里 `bossKind:'agent'` 且 `sessionId` 等于调用方会话 id 的 boss 记录；不能改别的目录、别的工头。
- `running` / `waiting` 更新 boss `state`；`done` / `failed` / `aborted` 把 boss `state` 置 `idle`，结果进 `lastReport`。
- `teammates` 最多 16 条；每条摘要最多 500 字；不写原始日志。
- 写入前过 `guard.looksLikeSecret`；命中则拒绝并返回人话。
- 同一 boss 的 `work_report` 是幂等覆盖（不是追加）；进入 `done` / `failed` / `aborted` 后只允许再写一次最终汇总，之后的写拒绝。
- `work_report` 不创建 WorkUnit，也不写 `work-units.json`；P3 的 teammate 明细只作为 `lastReport.teammates` 的有界摘要存在。

---

## 6. 状态机与失败/降级

### 6.1 状态机

```text
queued ──启动成功──→ running ──completed + 无 blocker──→ done
  │                    │
  │                    ├──completed + blocker/done=false──→ blocked
  │                    ├──aborted/中断/超时──→ aborted
  │                    ├──max-tokens/refusal/error──→ failed
  │                    └──重启/结果丢失──→ unknown
  │
  └──启动失败──→ failed
```

- `waiting` 是**工头**的状态，不是 worker 状态；`her_ask_user` 写 `work-sessions.json` 的 boss `state='waiting'`，用户回复后清掉。
- `unknown` 可以由后续 `list_agents` 的 `running` 修正回 `running`；不能由 `inactive` 修正为 `done` 或 `blocked`。
- `blocked` 不是终态：工头可以看 `blockers`/`guardHits`，决定新建 `followUpOf` worker、问用户或接受现状。

### 6.2 失败与降级

| 情况 | 行为 |
|---|---|
| 宿主没有 `subagents` / spawn provider | `her_worker` 返回“这台机器不支持派活”；这是校验失败，不创建 WorkUnit；不假装 running |
| `startActivation` 在参数校验后失败 | 建一个 `failed` WorkUnit（`failureKind='start'`），返回 `{ok:false, unitId, why}`；不假装 running |
| `fish-work-*` preset 缺失/拼错 | 创建失败；日志与自检标明；不回落到全工具 preset |
| `outputSchema` 不支持 | inspect 退化为 prose：`report=null`，`summary` 取 closing text，状态按 stopReason；验收不能写成“结构化评审通过” |
| inspect 请求了 `outputSchema` 但没交 | 宿主强制 `stopReason='error'`；记 `failed` + `failureKind='structured-missing-or-error'`；保留 closing text；重派 inspect，不降级成 `done` |
| 对已结算 unit 调 `message` | 拒绝 `{ok:false, why:'unit-settled'}`；工头新建 `followUpOf` worker；不冷恢复 |
| `activation.result` 丢失/宿主重启 | `running` → `unknown`；`list_agents` 可见则修正为 `running`；不可见保持 `unknown` |
| `runTimeoutMs` 到点 | fish 侧 `interrupt`；`status='aborted'` + `failureKind='timeout'`；后续迟到的结算不覆盖终态 |
| `her_work` 创建的会话没有被认成 `work` 面 | 返回失败，提示重试；不用 cwd 猜（见 §12） |
| 完成通知到达但状态写入失败 | 记日志；下一次启动对账；不把通知文本当状态 |
| worker 被 sandbox 拒绝 | 完成通知带限制说明；`status='failed'`；`summary` 保留“越界/被拒” |
| `work-guard` 初始化失败 / 无法判定 worker | `her_worker` 不派 worker，返回“guard 没挂上，不能派活”；不创建 running unit；fail closed |
| worker 的 fs/bash 调用被 `work-guard` 拒绝 | 工具返回“这件事得先问过用户，不能直接做”；写 `guardHits`；worker 继续或报告 blocker，最终 `blocked`/`failed`，不执行该调用 |
| `guardHits` 与结算并发写 | 共用 `work-state.js` 串行队列；终态只写一次，guard 命中只在终态前追加；不覆盖已结算结果 |
| worker 超时 | 工头或宿主 interrupt；`status='aborted'`；`summary` 说明超时 |
| 工头会话归档/删除 | 下次 `her_work` 新建；旧 WorkUnit 保留，`bossSessionId` 指向旧会话 |
| `work-units.json` 读坏 | 按空处理；不删除旧文件（可另存 `.corrupt-<ts>`）；不阻塞派活 |
| `work-units.json` 写失败 | 工具返回失败；内存中的状态不假装已持久化；日志告警 |
| P3 Team profile 未启用 | `her_work` 拒绝 agent boss；提示切换后端或启用 profile |
| P3 工作头子崩溃 | boss 记录 `state` 置 `unknown`（不是 worker unit）；`her_work_status` 显示未知；鱼可 `her_work continue` 重启同一会话或新建；不把 teammate 的部分成果当完成 |
| P3 `work_report` 越权 | 拒绝并记录；不改任何 WorkUnit |
| 桌宠/微信离线 | 状态仍在文件里；下次上线 `her_work_status` 可查；不补发全部历史 |

---

## 7. 安全与隐私

| 威胁 | 入口 | 缓解 |
|---|---|---|
| 工头读别的会话 | `her_worker_events`（P2） | 只允许同 cwd、本工头 WorkUnit 的后代；校验 `dir` + `bossSessionId`；不开放原生 `session_search` |
| web/wx 私聊互相可读 | 共享 `~/.dsh-fish/home` | v1 不启用 session-query；P2 也只在 `work` 面、按 WorkUnit 授权 |
| worker 原始日志泄到微信 | `her_work_status` / `notifyOwner` | 只返回 summary/report；压平、截断、过 `looksLikeSecret` |
| 状态文件被 worker 改写 | `work-units.json` / `work-sessions.json` | 只有 fish 进程写；`work_report`（P3）只能写 `sessionId` 匹配的 boss 记录；worker 没有写状态文件的工具 |
| `work_report` 被非 lead 调用 | fish 工具（work 面 agent 分支） | 执行时校验 `exec.agent.session.header.id` 等于 `work-sessions.json` 里 `bossKind:'agent'` 的 session id；不匹配整次拒绝 |
| worker 伪装工头 | preset / 工具 | worker 不挂 `her_worker_control` / `her_ask_user` / `work_report`；不能写她的记忆或事件流 |
| 工作头子写她的身份/记忆 | work 面策略 + `identity.js` | lead 登记为 `work` 面但 `bossKind='agent'`：不挂身份段、不挂 `growth_commit` / `her_recall` / `her_leave`；work 面 agent 分支只放 `work_report`、Team 工具、todo/时间 |
| 工作头子拿到 fish 的私聊工具 | work 面策略 | agent 分支不含 `her_work` / `her_work_status` / `her_worker` / `her_worker_control`；`restrict.js` 的 allowSet 按 `bossKind` 计算 |
| Agent Teams 消息注入 | teammate 输出 | 把 teammate 文本当不可信数据；工头/工作头子负责摘要；不直接进微信 |
| guard 命中被吞掉 | `work-guard`（G 已选） | 命中时写 `guardHits`（有界、脱敏）并返回人话；工头能在 `get` 里看到；guard 初始化失败时 `her_worker` fail closed，不出现无 guard 的 worker |
| 状态文件含秘密 | summary/report | `guard.looksLikeSecret`；命中只留“详情在电脑上”；文件权限 0600 |
| 跨目录读取 | `her_worker_events` / `her_work_status` | `dir` 必须等于工头 cwd；不同目录的 WorkUnit 不返回正文 |
| 删除/强推等危险操作 | worker | 11-20 §5.5 的 G 读隔离与危险操作规则不变；本文不放松 |

---

## 8. 测试与验收

### 8.1 `src/dsh-fish` 单元/集成

**WorkUnit 存储**

- 原子写；权限 0600；目录不存在时创建。
- 保留 200 条；最旧的已完成记录被淘汰；运行中的记录不被淘汰。
- 读坏文件按空处理，不抛到工具调用；旧文件另存 `.corrupt-<ts>`。
- summary/report 截断、去换行、过 `looksLikeSecret`。
- 同一 unit 的结算只写一次；重复结算被忽略并记日志。

**状态映射**

- `completed` + 无 blocker → `done`；`completed` + `report.done=false`/blockers → `blocked`。
- `aborted` → `aborted`；`max-tokens`/`refusal`/`error` → `failed`。
- 没有结算结果 → `unknown`；`list_agents` 的 `running` 可修正 `unknown`；`inactive` 不改成 `done`/`blocked`。
- inspect 请求了 `outputSchema` 但没交 → `failed` + `failureKind='structured-missing-or-error'`；build 不请求 `outputSchema`，不会走这条。
- 校验通过但 `startActivation` 失败 → `failed` + `failureKind='start'`；校验失败不建 unit。
- 对已结算 unit 调 `message` → 拒绝，不冷恢复；`followUpOf` 新建 unit 正常。

**适配器**

- fake backend：spawn/message/interrupt/list/onSettle 的调用次数与参数。
- `her_worker` 无 `cwd` 参数；cwd = 工头 cwd；非 work 面/非工头拒绝。
- `her_worker` 返回 `unitId` + `childId`；完成通知的 childId 能通过 `list` 映射回 unit。
- 活跃计数只数 `queued` + `running`；`unknown` 不占名额；build 同时 ≤1。
- `her_worker_control.message` 只对 `queued`/`running`；对 `done`/`failed`/`aborted` 返回 `unit-settled`。
- `her_worker_control.list` 返回 `childId`；`scope:'dir'` 含旧工头只读记录；`get` 返回 summary/report，不含原始日志。
- 宿主没有 `subagents` 时 `her_worker` 返回失败且不创建 WorkUnit；参数校验通过但启动失败时创建 `failed` unit。
- `outputSchema` 只对 inspect 请求；inspect 没交结构化结果记 `failed`；后端不支持时 inspect 退化为 prose，`report=null`。
- boss 记录：`her_work` 置 `running`，`her_ask_user` 置 `waiting`，结算回到 `idle` 并写 `lastSummary`。

**work-guard（G 已选，P1 必需）**

- `read` / `glob` / `grep` / `write` / `edit` 指向工头 cwd 内放行；指向 cwd 外、`~/.ssh`、`~/.aws`、`~/.dsh`、`~/.dsh-fish`、`/etc/shadow` 拒绝。
- 符号链接按 realpath 判断；`../` 逃逸拒绝；工作目录内的子目录放行。
- `bash` 命中 `~/.ssh` 等秘密路径、`curl`/`wget`/`nc`/`ssh`/`scp`/`rsync`/`git push` 等外发命令时拒绝；`npm`/`pnpm`/`pip` 带工作目录或 `/tmp` cache 时放行；裸外发仍拦。
- 非 worker 会话（陪伴、微信、web、工头自己）不受影响；worker 识别用 childId 或 parentSession+preset，无法判定时 fs/bash 一律拒绝。
- 命中返回人话，不执行；`guardHits` 追加、脱敏、最多 10 条；与结算并发时串行写，终态后不再追加。
- `work-guard` 初始化失败或无法判定 worker 时，`her_worker` 不派 worker；不出现无 guard 的 worker。
- 明确测试“不是内核隔离”：任意二进制/混淆命令不在保证范围，验收只按 denylist 的用例判定。

**工具可见性**

- `screen` / `wx` 可见 `her_work` / `her_work_status`；不可见 fs/bash。
- `work`（fish boss）可见 `her_worker` / `her_worker_control` / `her_ask_user` / 记忆工具；不可见原生 `send_message` / `list_agents` / subagent / fs/bash。
- `fish-work-lead`（P3）可见 Team 工具 + `work_report`；不可见 `her_worker` / 她的记忆工具。
- `restrict.js` 的 `OWN_TOOL_NAMES` / host 校验包含新工具；guard 同步 allow 集合。

**P2 事件读取**

- 只允许同 cwd、本工头 WorkUnit 的后代。
- 其他目录、sibling 工头、非 WorkUnit 会话 → 拒绝。
- 不暴露 `session_search` / `session_event_read` 原生工具名。

**P3 契约**

- fake team backend 的 `work_report` 写入、幂等、越权拒绝、`teammates` 上限。
- `backend='team'` 但 Team profile 未加载 → `her_work` 拒绝。
- 工作头子会话不写 `events.jsonl`、不挂身份。

### 8.2 真机验收

1. 桌宠说“去 `/tmp/fish-work-test` 建一个 hello.txt”，工头会话出现，worker 在目录内写文件；`her_work_status` 能返回 `done` + summary + `filesChanged`；桌宠气泡汇总。
2. worker 尝试写 `/home/str1k3/outside.txt`，被 sandbox 拒绝；WorkUnit 记 `blocked`（如果它本轮 completed 并报告 blocker）或 `failed`（如果 stopReason 是 error），summary 说明越界；桌宠不显示“做完了”。
3. 重启 8710 后，同一个目录 `her_work` 复用旧工头会话；重启前 `running` 的 WorkUnit 变成 `unknown`（如果后端不可见），不变成 `done`；`her_work_status` 能回答。
4. worker 跑了 10 分钟，模型上下文里没有完成通知；`her_worker` 的 `activation.result` 仍把结果写进 `work-units.json`；`her_work_status` 能读到 `done` + report。
5. build worker（不请求 `outputSchema`）只有一段 closing text；`her_work_status` 返回 `done` + `report=null` + summary 截断。inspect worker 请求了 `outputSchema` 却没交：返回 `failed` + `failureKind='structured-missing-or-error'`，工头重派 inspect，不报“评审通过”。
6. 工头派一个 inspect worker 复查 build worker 的改动；inspect 的 WorkUnit 带 `reviewOf`；工头汇总两份报告。
7. 把工头会话切到 `danger-full-access`，再派 worker，`her_worker` 拒绝并提示切回 `workspace-write`。
8. 宿主没有 subagent 服务（模拟）时，`her_worker` 返回“不支持派活”；不显示“已派 worker”。
9. P2：`her_worker_events` 能读本工头 worker 的命令事件；读其他目录或 sibling 会话被拒绝。
10. P3（在独立 profile 上）：鱼把任务交给工作头子；工作头子用 Agent Teams 派 2 个 teammate；`work_report` 写入顶层 summary + teammate 摘要；鱼只读 `her_work_status`，不出现 teammate 会话内容。
11. 两个 build worker 同时跑；完成通知里的 childId 能通过 `her_worker_control.list` 映射到正确 unit；`get` 能读回各自的 summary/report，不串。
12. 对已 `done` 的 unit 调 `message` 被拒绝；用 `followUpOf` 新建 worker，旧 unit 结果不变，新 unit 单独结算。
13. 重启后两个 `running` unit 变 `unknown`；不占 `maxActive`，同目录还能派新 worker；`list_agents` 不可见时保持 `unknown`，不变成 `done`。
14. 归档旧工头后同目录 `her_work` 新建会话；`her_work_status` 仍显示该目录最近的 unit 汇总；新工头 `list scope:'dir'` 能看到旧 unit 的只读记录，但不能 `message`/`interrupt` 旧 unit。
15. P3 里让一个非 lead 会话调 `work_report`，被拒绝；lead 的工具表里没有 `her_work` / `her_worker` / `growth_commit`。
16. worker 尝试 `cat ~/.ssh/id_rsa` 和 `curl https://example.com`，都被 `work-guard` 拒绝；`get` 能看到 `guardHits`；状态是 `blocked` 或 `failed`，不是 `done`；工具的返回是人话。
17. 模拟 `work-guard` 初始化失败，`her_worker` 拒绝派活；不出现没有 guard 的 worker。

### 8.3 不算通过

- `list_agents` 显示 `inactive` 就被当成 `done`。
- inspect 请求了 `outputSchema` 却没交，被写成 `done` 或“评审通过”。
- 对已结算 unit 调 `message` 冷恢复，状态文件仍写 `done` 而 follow-up 在跑。
- 宿主重启后 `running` 的 WorkUnit 被写成 `done`。
- `unknown` 永久占着 `maxActive`，同目录再也派不出 worker。
- 非 lead 会话成功调用 `work_report`。
- `work-guard` 初始化失败仍然派出了 worker。
- worker 能 `cat ~/.ssh/id_rsa`、裸 `curl` 外发，或 guard 命中没有写 `guardHits`。
- `guardHits` 把完整命令/路径/秘密写进状态文件或微信。
- `her_work_status` 返回 worker 的原始命令、完整文件内容或路径清单。
- 微信收到整段代码、完整路径清单或秘密。
- `screen` / `wx` 会话出现 fs/bash/session-query 原生工具。
- P2 能读到其他 cwd 或非本工头 WorkUnit 的会话。
- 同一个 profile 内同时启用经典 subagent 和 Agent Teams，并假装两者都可用。
- 工作头子写 `events.jsonl` 或她的记忆。
- 为工作改 `events.jsonl` schema 或删除/重排历史。

---

## 9. 分期

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** | `work` 面、`work-sessions.json`（含 boss 记录）、`work-units.json`、`WorkUnit` 状态机、`her_worker`（subagent 适配器；inspect-only `outputSchema`）、`her_worker_control`（message/interrupt/list/get）、`her_work_status`、`work-guard`（G：路径 + 外发命令 + `guardHits`）、inspect 评审、工头/worker preset、对账 | 桌宠派活、inspect 结构化评审、build closing text、重启后 `unknown` 不假装完成、inspect 复查、越界/秘密路径/裸外发被 guard 拒绝并记 `guardHits`、已结算 unit 不能 `message` |
| **P2** | `her_worker_events` 窄会话查询（同 cwd、本 WorkUnit 后代） | 能看 worker 命令/文件事件；其他目录和私聊不可读 |
| **P3** | `bossKind:'agent'`、`fish-work-lead` preset、`work_report`（fish 工具，work 面 agent 分支放行 + lead session id 二次校验）、部署级 bossKind 切换 | 鱼交给工作头子；工作头子用 Agent Teams 分发；鱼只读 boss 记录；非 lead 不能 `work_report` |
| **P4** | 11-20 的内核级读/网络隔离、完整危险命令守卫、审计、工作台工作页 | 守卫拦截危险命令并转工头；审计能回答“谁在哪个目录做了什么” |

P1 不依赖 P2/P3；P2 不依赖 P3。P3 是部署级切换，不能和 P1 的 subagent 模式在同一 profile 内热切换。

---

## 10. 与 11-20 的关系与需要拍板

### 10.1 关系

- **11-20 仍是前台与手机派活的主设计**：桌宠/微信入口、受信闸、目录校验、权限、Agents Anywhere 路径不变；读隔离按已定的 G 执行。
- **本文补充**：工头工具面（用包装替代原生控制工具）、WorkUnit 状态、结构化报告、评审路径、适配层、P3 工作头子/Agent Teams 扩展。
- **冲突时**：本文明示的 §4.8 差异以本文为准；其余以 11-20 为准。

### 10.2 需要拍板

1. **P2 是否要做**：`her_worker_events` 能看到 worker 的命令级记录，但多一层读隔离和宿主 API 耦合。推荐先做 P1，真实评审不够时再加。
2. **P3 什么时候上**：工作头子 + Agent Teams 是部署级切换，需要独立 profile/主机；不阻塞 P1。等 P1 的真实工作量和评审痛点稳定后再决定。
3. **11-20 的受信微信私聊**：P2 微信派活才需要；不影响本文 P1。

**读/联网隔离已定 G（2026-11-23）**：`work-guard` 和 `guardHits` 进 P1；11-20 §10.2 的 G/P 项以此为准，不再保留 P 方案。

### 10.3 实现者可以自己定的

- `work-units.json` 的具体原子写实现（复用 `atomic-write` 或现有 `store.js` 风格）。
- summary 的截断方式、report 的渲染格式。
- `her_worker` 的 prompt 文案；`outputSchema` 的字段顺序。
- 适配器内部的日志与自检字段。
- P3 `work_report` 的幂等细节（只要“终态后只允许一次最终覆盖”不变）。
- 状态文件损坏时的备份命名。

### 10.4 本文已经替你定的实现调用

以下不是用户拍板，而是写这份设计时做的技术判断；评审时可以直接改：

1. v1 `bossKind:'fish'`，P3 才引入工作头子；不在 v1 做多级团队。
2. 默认 `structuredOutput='inspect-only'`：inspect 请求 `outputSchema`，build 用 closing text；`all` 是可选，代价是 build 漏交时会被记 `failed`。
3. `message` 只对 `queued`/`running`；已结算的跟进新建 `followUpOf` unit，不冷恢复。
4. boss 状态放 `work-sessions.json`，不建 `work-boss` WorkUnit；`work-units.json` 只放 worker/teammate。
5. 活跃计数只数 `queued` + `running`；`unknown` 不占名额。
6. P3 的工作头子登记为 `work` 面（`bossKind='agent'`），受 fish `restrict` 保护；`work_report` 是 fish 工具，在 work 面 agent 分支放行并按 lead session id 二次校验；fish 不实现 `team` 适配器。
7. 校验失败不建 WorkUnit；校验通过但 `startActivation` 失败建 `failed` unit。
8. `runTimeoutMs` 由 fish 侧定时器执行；宿主重启丢定时器，`running` 变 `unknown`。
9. 保留 200 个 unit、summary 2000 字、report 每数组 20 条、teammates 16 条。
10. `work` 面不用 cwd 兜底；`her_work` 创建的会话没被认成 `work` 面就失败重试，不猜。
11. 结构化 schema 不放 `maxLength`/`maxItems`（宿主子集不接受）；长度在持久化时截断。

---

## 11. 改动文件（预估）

| 文件 | 改动 |
|---|---|
| `src/dsh-fish/lib/surface.js` | `work` 面、按 session id 的 matcher；P3 不把 agent-boss 登记为 fish 面 |
| `src/dsh-fish/lib/core-service.js` | 注册 work matcher / reserve 兼容 |
| `src/dsh-fish/lib/tool-policy.js` | `work` 面按 `caps.workBoss` 分支：fish 分支放 `her_worker` / `her_worker_control` / `her_ask_user` / 记忆，不放原生宿主工具；agent 分支放 `work_report` / Team 工具 / todo / 时间，不放她的记忆工具 |
| `src/dsh-fish/lib/restrict.js` | `OWN_TOOL_NAMES` / `FISH_TOOLS` 增加新工具；host 校验；guard 同步 |
| `src/dsh-fish/lib/work.js`（新） | 工作会话、目录校验、受信闸、映射、`her_work` / `her_worker` / `her_worker_control` / `her_ask_user` / `her_work_status`、`work_report`（P3 fish 工具，agent 分支）、活跃计数、对账 |
| `src/dsh-fish/lib/work-state.js`（新） | `WorkUnit` 模型、boss 记录、原子读写、保留策略、状态映射、summary 截断 |
| `src/dsh-fish/lib/work-backend.js`（新） | `DelegationBackend` 接口、subagent 适配器、能力检测；不实现 P3 team 适配器 |
| `src/dsh-fish/lib/work-guard.js`（新，G 已选，P1 必需） | 全局 `tools/pre-execute`：worker 识别、真实路径检查、秘密路径、外发命令、`guardHits` 串行写入、fail closed |
| `src/dsh-fish/test/work-guard.test.mjs`（新） | 路径/符号链接/受保护路径、bash 外发、包管理器放行、非 worker 不受影响、失败关闭 |
| `src/dsh-fish/lib/index.js` | 注册工具、接线 work 服务、自检、pet 事件源 |
| `src/dsh-fish/lib/pet-view.js` | `PET_SURFACES` 增加 `work`；worker 启动/结束活动 |
| `src/dsh-fish/lib/identity.js` | `work` 面挂身份与 `fish:owner`；agent-boss 不挂 |
| `src/dsh-fish/lib/capture.js` | 会话面 `work` → 事件面 `web`；agent-boss/worker 不写事件流 |
| `src/dsh-fish/lib/selfcheck.js` | 后端、preset、WorkUnit 总数、未知状态计数 |
| `src/dsh-fish/test/work-state.test.mjs`（新） | 状态模型、持久化、保留、损坏、截断 |
| `src/dsh-fish/test/work-backend.test.mjs`（新） | fake subagent 适配器、能力检测、结算；P3 `work_report` 契约 |
| `src/dsh-fish/test/work.test.mjs`（新） | 工具、权限、计数、评审、对账 |
| `~/.dsh/profiles/web/cordis.patch.yml`（部署） | `fish-work-boss` / `fish-work-inspect` / `fish-work-build`；P3 `fish-work-lead` |
| `docs/` | 本设计、部署说明、真机验收记录 |

---

## 12. 留给实现者的决定

- `WorkUnit` 的 id 生成方式（ULID / 时间戳 + 随机）和排序键。
- `work-units.json` 是单文件还是按目录分片；只要保持原子写和 200 条上限。
- `activation.result` 的文本提取：取所有 assistant 文本块还是仅 closing block；默认取最后一条 assistant 文本。
- `outputSchema` 未支持时的降级日志级别。
- `her_worker_control.list` 是否返回 `stopReason`（默认返回，不返回正文）。
- P3 `work_report` 的 `teammates` 是否允许空数组；默认允许。
- 对账频率：启动时一次 + 每次 `her_work_status` 前轻量检查；不做后台轮询。
- 状态文件损坏时另存的名字与日志格式。
- `work` 面实际 session id 的核验方式：`her_work` 创建后检查实际 id、立即 reserve；不一致时更新映射并重试一次，再失败就返回“工头没拿到工作工具”，不用 cwd 猜。
- `followUpOf` 的默认 label/prompt：沿用旧 unit 的 mode 和 label，prompt 里加一句“这是对 wu_… 的跟进”。
- `guardHits` 的脱敏规则：只留命令名/路径 basename，不留完整参数。
- `work-guard` 的 worker 识别顺序：先查 `backendRef.childId` 注册表，再用 `header.parentSession` + preset 兜底；都不命中时对该会话的 fs/bash fail closed。
- `work-guard` 的 bash 检查只做字符串 denylist，不承诺解析 shell 语法/变量展开/编码；这是 G 的边界，P4 用内核隔离补。
- P3 lead 会话创建后的核验：preset 必须是 `fish-work-lead`，会话 id 写入 boss 记录后才注入任务；创建失败不回落到 fish boss。

---

## 13. 证据与验证边界

- **版本**：现网 8710 运行 `dsh 0.2.1-rc.5`；`/usr/local/bin/dsh` 指向 `/opt/dsh-x64/node_modules/@deepseek-ai/dsh/lib/bin.js`。
- **现网配置**：`~/.dsh/profiles/web/cordis.patch.yml` 加载 `tool-subagent-control` / `list-agents` / `subagent` / `subagent_fork`；`dsh-web-app` 默认 patch 加载 `dsh-session-reference`；`session-query-sqlite` 为 `openAt: never`；Agent Teams 未加载。
- **宿主实现**：`dsh-subagent` 的 `createSettlementMessage`；`dsh-tool-subagent-control` 的 `send_message` / `interrupt_agent` / `list_agents`；`dsh-tool-session-query` 的 cwd 授权；`dsh-session-reference` 的 pre-step 快照；`dsh-experimental-agent-team` 的任务板/消息。
- **鱼侧**：`src/dsh-fish/lib/tool-policy.js` 的面与策略；`src/dsh-fish/lib/restrict.js` 的 allowSet + guard；`~/.dsh-fish/config.json` 的 `tools.allow: []`。
- **宿主结构化输出行为**：已核对 `dsh-subagent` 的 `captureLocalResult`（请求 `outputSchema` 但没交 → `stopReason:'error'`）、`deliver` 的 `INPUT_CLOSED`（已提交结构化结果的子会话拒绝消息）、`subagent/descriptor` 不保存 `outputSchema`（冷恢复不恢复结构化工具）。这些行为直接决定了 §2.5 和 §5.4 的 inspect-only 设计。
- **独立评审**：2026-11-23 由 builder-check 子代理通读本文并核对宿主源码；本文已按反馈补上状态映射、boss 记录、message 语义、相关系数、活跃计数、work_report 授权和 P3 lead 的工具路径。
- **读/联网隔离**：2026-11-23 用户选定 G。`work-guard`、`guardHits` 和相应测试进 P1；11-20 §10.2 的 G/P 项关闭，不再保留 P 方案。
- **未做真机调用**：session-query 和 Agent Teams 现网未挂载，没有实际调用；session-reference 已加载但没有发测试 mention；`outputSchema` 只在宿主能力声明和源码中核对，未在真实 worker 上验证。以上是设计与代码层面的判断，不是“消息收发已验收”。
- **不在本文范围**：桌宠/微信 UI 改动、手机 Agents Anywhere 安装、11-20 的目录校验/受信闸/读隔离细节。
