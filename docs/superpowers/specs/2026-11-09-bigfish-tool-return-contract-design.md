# 大肥鱼工具返回契约：完整记账与选择性透传

日期：2026-11-09
状态：设计待评审；未实施
父设计：[大肥鱼个人核心与分面工具架构](2026-11-09-bigfish-person-core-surfaces-design.md)

## 1. 结论

工具返回现在同时承担四件事：给模型看、给观测台看、给审计看、给记忆沉淀看。四件事挤在同一个字符串里，结果是：

- 该给模型看的被埋住：`wx_peek` 返回整棵树的原始文本（含坐标、角色、属性），`wx_ocr` 返回 24k JSON，`wx_context` 每条都带“匹配原因 / 来源 / 置信度”。
- 不该给模型看的被放大：坐标、`message_id`、`task_id`、`confidence`、`msgId`、文件路径、内部错误码。
- 该给模型看的反而丢了：`qq_group_history` 只返回“20 条历史消息”，正文一条没有。
- 回执写成她会复述的句子：她已经会把工具返回的话当自己的话接着说，`growth_commit` 的注释里记过这个坑。

本设计把返回拆成四层：

| 层 | 给谁 | 内容 | 是否完整 |
| --- | --- | --- | --- |
| 工具台账 `tool-ledger` | 审计、观测台、排查 | 参数、完整结构化结果、耗时、错误、引用 id | **完整** |
| 模型投影 `model` | 大肥鱼 | 只保留闭环必需信息和必要 handle，写成中性的舞台提示 | **选择性** |
| UI 投影 `ui` | 侧栏 / 观测台 | 状态、时间、可展开详情 | 结构化 |
| 记忆事件 `events.jsonl` | `deriveSelf` / `her_recall` | 她的判断、看到的东西、B 站回复 | 语义化，不是工具流水 |

UI 投影第一版可以只保留结构，不接观测台；台账和模型投影是必须的，UI 不阻塞验收。

核心原则：

1. **台账完整，投影最小。** 工具返回的每个字段都进台账；模型只拿“下一步做决定需要的东西”。
2. **投影是舞台提示，不是她的台词。** 状态用方括号，素材用引用块；不写“你看到了……”，避免她把回执原样说出来。
3. **结构留在台账，人话进上下文。** 不把 JSON、字段名、坐标、置信度、内部 id 塞进模型上下文。
4. **prompt 只补一小段“怎么看结果”，不重写人设。** 先改投影，再改 prompt；不用事后润色器伪装人性。

## 2. 调研一：闭环必须信息 vs 上下文噪声

### 2.1 闭环的六个环节

每个工具都服务于一条闭环：**触发 → 感知 → 判断 → 行动 → 确认 → 沉淀**。模型在下一步真正需要的信息，只从这条闭环里来。

| 环节 | 模型需要知道 | 例子 |
| --- | --- | --- |
| 触发 | 为什么现在做这件事 | 有人 @ 她、到点提醒、出门槽位到了 |
| 感知 | 看到了什么 | 群里的原话、视频标题/OCR、屏幕上的会话名 |
| 判断 | 这些信息够不够、可不可信 | “只看到预览，没看到正文”“OCR 可能认错字” |
| 行动 | 能做什么、边界在哪 | “这个会话不在允许名单”“今天不能再说” |
| 确认 | 动作到底成没成 | “消息在末尾”“回执没确认，别假装发过” |
| 沉淀 | 要不要记、怎么记 | B 站评论进 `utterance`，看到视频进 `saw` |

### 2.2 必须透传的五类信息

| 类别 | 说明 | 例子 |
| --- | --- | --- |
| 结果 | 动作成功/失败/不确定 | `[已发]`、`[没发：这个会话不在能说话的名单里]`、`[发出去了，但列表末尾没看到，可能还没刷新]` |
| 内容 | 她这次真正要读的东西 | 群消息正文、`wx_context` 的发言、视频标题/简介、OCR 文本、B 站回复原话 |
| 归属 | 谁说的、在哪个会话、哪条视频 | `「群名」`、`阿明：…`、`《标题》` |
| Handle | 下一步调用必须原样带上的 id | `her_recall` 的 `ev_…`、`wx_task_done` 的 task id、`wx_sticker_tag` 的 sticker id、`her_remind_cancel` 的提醒 id |
| 约束 | 为什么做不了，且她能理解 | `这个会话不在允许名单`、`今天说得够多了`、`缺登录`、`屏幕可能慢半拍` |

### 2.3 不需要且会干扰的五类信息

| 类别 | 为什么有害 | 现在的例子 |
| --- | --- | --- |
| 传输信封 | `code`/`data`/`status`/`retcode` 是给程序看的，模型会开始解释字段 | `qq_napcat_api` 原样返回 JSON |
| 内部 id | 模型会把 id 当话题，或者把 id 念给用户 | `message_id=…`、`msgId`、`taskId`、`sessionId`、`wsId` |
| 坐标/布局 | 模型不需要知道 x/y、box，`wx_click` 已支持 label | `wx_peek` 的 box、`wx_click` 的 `(x,y)` |
| 置信度/匹配原因 | 会把聊天变成检索报告：“根据匹配度…” | `wx_context` 的 `匹配：…；来源：台账 msgId；置信度：…` |
| 配额/计数/路径 | 会让她算资源、念路径；路径只有后续工具能用时才是信息 | `wx_see` 的 PNG 路径、`bili_watch` 的帧数、`bili_speak` 的剩余次数 |

### 2.4 判断规则

一个字段要不要给模型，按顺序问四个问题：

1. **下一步动作需不需要它？** 不需要就不给。比如 `wx_context` 的 `msgId`，下一步不会再引用。
2. **它是不是下一步工具的参数？** 是就给，但只作为 handle，不写进叙述。比如 `her_recall` 的 `ev_…`。
3. **它会不会改变她对“成没成”的判断？** 会就必须给。比如“回执没确认”必须说，不能只说“已发送”。
4. **它会不会让她开始管理资源或解释系统？** 会就隐藏。比如剩余次数、置信度、匹配原因。

### 2.5 反例：两个方向的失败

- **过度结构化**：`wx_peek` 把整棵树的原始文本交给模型；`wx_ocr` 返回 24k JSON；`qq_napcat_api` 返回原始 API 响应。模型上下文被字段占满，回复容易变成“我查到了以下信息”。
- **过度压缩**：`qq_group_history` 只返回“20 条历史消息”，正文全丢。模型知道有历史，却没法据此回复，闭环断在“感知”环节。

选择性透传不是“越少越好”，而是**刚好够下一步用**。

长素材要截断时，保留开头和结尾，给模型一句“后面还有 N 条/行”；完整内容进台账。不要只给开头，也不要把整段 OCR/聊天历史塞进去。

## 3. 调研二：结构化与人设

### 3.1 结构化为什么会伤“人性”

- **语域切换**：模型看到 JSON、字段名、`id=`，会自然切换到“数据处理/汇报”语域，回复变成条目和总结。
- **回执回声**：模型会把工具返回的句子当自己的话接着说。`capture.js` 的注释记录过：她把 letter 工具的回执原文（“留好了……”）复述成“留好了。就一句。没说别的。”，用户评价“AI 味重”。
- **资源管理**：看到“还剩 2 条”“置信度 0.83”，她会开始算配额、解释置信度，而不是像人一样说话。
- **检索报告**：看到“匹配原因 / 来源 / 置信度”，她会说“我根据台账匹配到……”——这是检索器，不是大肥鱼。
- **上下文挤占**：JSON 和重复字段占掉本可以用来理解对方话里的意思的空间。

### 3.2 哪些结构不能丢

- **原话**：谁说了什么，必须逐字保留；概括会改变意思。
- **归属**：群名、发言人、视频标题、回复对象；否则她会把 A 的话算到 B 头上。
- **顺序**：谁先说、谁后说；时间可以只保留“刚才/昨天/几月几日”，不必 ISO 时间。
- **动作结果**：成/没成/不确定；不确定必须说出来。
- **Handle**：下一步工具真正需要的 id；只给必要的，且放在括号里。
- **边界**：为什么不能做；用她能理解的话，不用错误码。

### 3.3 五种投影风格

| 风格 | 用于 | 形状 | 例子 |
| --- | --- | --- | --- |
| `status` | 写操作、任务操作 | 方括号状态，不写成她的句子 | `[已发到「群名」，消息在末尾]` |
| `material` | 看视频、OCR、外来文本 | `[看到]` + 素材，标明是机器识别/别人写的 | `[看到] 《标题》…` |
| `transcript` | 聊天记录、群历史 | `谁：原话`，按时间顺序 | `阿明：晚上来吗` |
| `catalog` | 搜索、列表、工具发现 | 编号 + 短描述；必要时脚注 handle | `1. 猫无语 2. 牛收到（编号 1=st_…）` |
| `receipt` | 发送类 | 结果 + 回执可信度 | `[发出去了，但列表末尾没看到，可能还没刷新]` |

### 3.4 投影的写法

**要：**

- 用中性、短句、舞台提示的语气。
- 状态放方括号里，明确“这是系统状态，不是她的话”。
- 素材用 `[看到]` / `[翻到]` / `[待回]` 开头，和她的叙述分开。
- 原话用引号或 `谁：` 保留。
- 不确定就写不确定，不写成成功。
- Handle 放最后一行，标成“编号”，不塞进正文。

**不要：**

- 不要 JSON、字段名、`id=`、`confidence`、`score`、`box`、`x/y`。
- 不要写“你看到了……”“我帮你查到了……”这类她会复述的句子。
- 不要把工具名、参数名、内部流程念出来；`her_tools` 的目录返回除外，那里工具名就是内容。
- 不要给配额、剩余次数、匹配原因。
- 不要把路径给模型，除非下一步工具真的要用它。
- 不要把 UI 的完整卡片原样塞进模型上下文。

### 3.5 Handle 策略

有些 id 是闭环必需的，不能一刀切隐藏。做法是：

1. **能不用 id 就不用。** `wx_click` 用 label，不用坐标；`wx_send` 用会话名，不用 chatId。
2. **必须用 id 时，只给必要的。** `her_recall` 给 `ev_…`（revise/narration 要指回去）；`her_reminders` 给提醒 id（取消要用）；`wx_sticker_list/find` 给 sticker id（tag/send 要用）。
3. **Handle 和正文分开。** 列表/素材类结果的正文里不出现 id；最后一行写 `（编号：1=ev_…，2=ev_…）`。单条写操作（`growth_commit`、`her_leave`）的回执可以带一个 id，因为下一步 revise 要用它。
4. **优先让写工具接受人话参数。** 如果 `wx_sticker_send` 能接受“第 1 个 / 猫无语”，就不必把 id 交给模型。第一版可以先保留 id handle，后续再改参数。

### 3.6 改前 / 改后

**`wx_peek`**

现在：

```json
{"chats":[["群名",3,1,0,0,"12:30","…"]],"current":"群名","msgs":["…"]}
```

改成：

```text
[微信] 现在停在「群名」。侧栏有 3 个会话：
- 「群名」3 条未读，最后一句：晚上来吗
- 「阿明」无未读，最后一句：文件发你了
当前对话最后几条：
阿明：晚上来吗
你：看情况
```

坐标、box、置信度、树健康只在台账里；树落后时加一句 `[屏幕可能慢半拍]`。

**`wx_context`**

现在：

```text
[上下文 1/3] 群名｜阿明｜2026-11-09 12:30
「晚上来吗」
匹配：关键词 + 同线程；来源：台账 msg_…；置信度：high
```

改成：

```text
[翻到] 「群名」里相关的 3 条：
阿明（今天 12:30）：晚上来吗
你（今天 12:31）：看情况
阿明（今天 12:32）：那明天？
```

匹配原因、来源、置信度、msgId 只在台账。

**`qq_group_history`**

现在：

```text
20 条历史消息
```

改成：

```text
[群历史] 最近 20 条：
阿明：晚上来吗
小李：来
阿明：老地方
…
```

**`growth_commit`**

现在已经是：

```text
[已记下 ev_…]
```

保持方括号，但把 id 明确成 handle：`[已记下 · ev_…]`。不要写成“记好了，我记住了”。

**`bili_speak`**

现在：

```text
说出去了：「…」
```

改成：

```text
[已发 · 「…」]
```

保留实际发出去的原话（可能带了 @ 前缀），但不写成她的语气。

## 4. 返回契约与实现

### 4.1 内部结果形状

工具 handler 返回完整结构，不再直接返回给模型看的字符串：

```js
{
  ok: true,
  code: 'OK',                  // 机器可读，只进台账
  data: { ... },               // 完整结构化结果
  refs: {                      // 需要长期引用的 id
    eventIds: [], msgIds: [], taskIds: [], bvids: [], rpids: []
  },
  ui: { ... }                  // 可选，观测台卡片
}
```

`project(result, args, ctx)` 是唯一的模型投影来源，纯函数，返回：

```js
{ text: string, handles?: Record<string,string>, blocks?: ContentBlock[] }
```

- `text` 只给模型；不写她的台词。
- `handles` 只放下一步必需的 id；由包装器统一渲染成末尾一行 `（编号：1=…，2=…）`，`text` 里不重复写 id。
- `blocks` 用于图片等非文本内容；有图片时先放图片块，再放文本；没有就省略。
- 不在 handler 里预生成模型文本；这样同一份结果可以分别投影给模型、UI 和测试，不会出现两套文案。

### 4.2 注册包装器

`dsh-fish` 提供 `registerTool` / `wrapTool`：

```js
registerTool(ctx, {
  name, description, parameters, outputSchema,
  execute,        // 返回完整结果
  project,        // 返回模型投影
  ledger = true,
})
```

`registerTool` 内部把 `outputSchema` 映射到宿主的 `output.schema`，并把 `project` 包进 `output.render`；业务代码不再手写 `render`。`outputSchema` 描述**完整结果**，不是投影文本；投影只改变 `render` 的文本，不改变返回值结构。

`execute` 返回 `{ ok: false }` 不算异常：台账记 `ok: false` + `code`，投影仍走 `project`，模型看到的是 `[没…：原因]`。只有真正抛错（网络、权限、宿主异常）才走 `ToolError` 路径；两条路径都要留台账。

包装器做四件事：

1. 记录开始时间、surface、session、tool、参数（脱敏）。
2. 调 `execute`；成功/失败都写一条 `tool-ledger`。
3. 成功时把 `project(result)` 的文本交给 `output.render`。
4. 失败时把完整错误写台账，只把 `ToolError.modelText` 抛给宿主。

```js
// handler 是业务 execute；包装器自己的 execute 只负责记账和投影
execute: async (args, exec) => {
  const call = toolLedger.begin({ tool, args, exec })
  try {
    const result = await handler(args, exec)
    await toolLedger.finish(call, result)
    return result
  } catch (err) {
    await toolLedger.fail(call, err)
    throw new ToolError(err.code ?? 'TOOL_FAILED', projectError(err))
  }
}
```

`output.render` 只做投影，不再包含业务逻辑：

```js
output: {
  schema: outputSchema,
  render: (args, result) => {
    const p = project(result, args)
    const footer = p.handles && Object.keys(p.handles).length
      ? `\n（编号：${Object.entries(p.handles).map(([k, v]) => `${k}=${v}`).join('，')}）`
      : ''
    const blocks = p.blocks ?? []
    return [...blocks, { type: 'text', text: p.text + footer }]
  },
}
```

### 4.3 工具台账

位置：`<fishCore 数据根>/tool-ledger/YYYY-MM-DD.jsonl`，默认 `~/.dsh-fish/tool-ledger/`，由 `fishCore` 解析，不写死在插件里；WX/QQ/B 站共用同一根目录。按日追加，权限 `0600`。不进 `events.jsonl`，不参与 `deriveSelf` / `her_recall`。

不要和 `dsh-wx` 现有的消息台账（`ledger.js`）混淆：消息台账存聊天消息，工具台账存工具调用；两者用 `refs.msgIds` 关联，不互相替代。

一条记录：

```json
{
  "v": 1,
  "id": "tc_01J...",
  "ts": "2026-11-09T12:30:00.000Z",
  "surface": "wx",
  "sessionId": "…",
  "tool": "wx_context",
  "args": { "task_id": "7f3a", "query": "晚上" },
  "argsHash": "sha256:…",
  "redacted": false,
  "ok": true,
  "code": "OK",
  "durationMs": 42,
  "result": { "…": "完整结构化结果" },
  "modelText": "[翻到] 「群名」里相关的 3 条：…",
  "handles": {},
  "refs": { "msgIds": ["msg_…"], "taskIds": ["7f3a"] },
  "error": null,
  "projectionVersion": 1
}
```

规则：

- `result` 是 handler 的完整返回，不是投影文本。
- `modelText` 由同一个 `project(result, args, ctx)` 计算；`output.render` 再调用一次，纯函数应得到同一结果。
- 大字段（`wx_peek` 原始树、`wx_ocr` 原始 JSON、`qq_napcat_api` 原始响应）超过 32KB 时，写入 `tool-ledger/artifacts/<id>.json`，记录里留 `artifact`、`bytes`、`sha256`。
- `args` 过 `guard.looksLikeSecret`；命中就替换成 `[redacted]` 并置 `redacted: true`。cookie/token/密码不落台账。
- WX/QQ 的正文可以用 `refs.msgIds` 指向已有的消息台账，避免复制两份；台账仍记 `chars`、`sha256`，需要时能定位。
- 台账只追加，不自动删除。保留期和清理是运维动作，必须另行批准，不能顺手 `rm`。
- 崩溃追溯：第一版在完成/失败时写一条完整记录；进程在调用中崩溃时，这次调用可能没有台账。若需要严格追溯，再加一条 `status: 'started'` 的预写行，按 `id` 合并；默认不做，避免双倍写入。
- 观测台只读台账；她的记忆只读事件流。两者不互相冒充。

### 4.4 台账与事件流的分工

台账完整不等于把一切写进记忆。两者职责不同：

| 内容 | 工具台账 | 事件流 `events.jsonl` | 说明 |
| --- | --- | --- | --- |
| 调用参数、耗时、错误、原始 JSON | 写 | 不写 | 审计用，不参与她的判断 |
| 实际模型投影文本 | 写 | 不写 | 用来测回声、复盘 |
| `growth_commit` 的判断 | 写调用记录 | 写 `utterance` / `revise` / `reunion` / `narration` / `refusal`；日记另写文件和 `meta` | 台账记“调了什么”，事件流记“她判断了什么” |
| `bili_speak` 的评论 | 写调用记录 | 写 `utterance(surface='bili')` | 评论是她的话，必须可召回 |
| `bili_watch` 的观看 | 写调用记录 | 写 `saw` | 看过的内容要影响她 |
| `bili_reply` | 写调用记录（如果由工具触发） | 写 `bili_reply` | 别人的回复是一等事件 |
| 普通读工具（`wx_peek`、`wx_context`、`qq_group_history`） | 写 | 不写 | 读操作不自动沉淀；她若判断，另走 `growth_commit` |

规则：

- 有对外动作的工具（评论、发消息、看视频）必须**先完成动作，再写语义事件**；动作失败不写“她说过/看过”的事件。`growth_commit` 本身就是写事件，写失败就不算记下。
- 事件写失败不回滚已完成的动作，但要在台账里记 `eventWriteError`，并在投影里保留“动作成了、记忆没跟上”的不确定性；不能假装两件事都成了。
- `her_recall` 只读事件流，不读工具台账；观测台只读台账。两条路不互相冒充。

### 4.5 错误契约

`ToolError` 分两层：

```js
class ToolError extends Error {
  constructor(code, modelText, { cause } = {}) { ... }
}
```

- `code` 给台账和观测台：`WX_NOT_ALLOWED`、`WX_UNCONFIRMED`、`BILI_COOLDOWN`、`REMIND_EXPIRED`。
- `modelText` 给她：一句能理解的话，例如 `这个会话不在能说话的名单里`、`今天说得够多了`、`网断了，等会儿再试`。
- `projectError(err)` 是错误码到人话的映射；没有专用映射时用 `没做成，再试一次`，不得把堆栈、路径或原始错误消息带出来。
- 原始错误、堆栈只进台账；模型永远看不到 `ECONNREFUSED`、`TypeError`、文件路径。
- 不确定的结果不算失败：`[发出去了，但列表末尾没看到，可能还没刷新]` 比“发送失败”更准确。

### 4.6 各插件的接入

- `dsh-fish`：核心工具直接用 `registerTool` / `wrapTool`；`growth_commit`、`her_recall`、`her_leave`、`her_remind*`、`her_inbox` 先改。
- `dsh-wx`：把 `reg()` 换成带包装的注册；`wx_peek`、`wx_ocr`、`wx_context` 是重点。
- `dsh-bili`：`bili_look`、`bili_watch`、`bili_speak` 用同一套 `project`。
- QQ：vendor 插件不改的前提下，适配层在注册时包一层 `execute`/`render`；如果宿主不允许替换已注册工具，则先对 `qq_napcat_api` 和 `qq_group_history` 做上游补丁或薄 fork。这是实施风险，不是设计假设。
- `read_image` 是宿主工具，不包装；台账记录路径、mime、大小，模型直接看图。

## 5. 逐工具返回设计

说明：

- “台账”列只列关键字段，实际记录是完整结果。
- “透传”是模型看到的文本形状；方括号是舞台提示，不是她的台词。
- “隐藏”列是明确不进入模型上下文的内容。
- 当前 main 的 WX 注册入口是 14 个；dev 的 18 个（含历史/表情发送等）实施前以注册表重新盘点，不把数量写死。

### 5.1 核心工具

| 工具 | 台账（完整） | 透传（模型） | 隐藏 |
| --- | --- | --- | --- |
| `growth_commit` | type、text、refs、verdict、confidence、事件 id、flags、日记日期/路径、seen meta | `[已记下 · ev_…]` 或 `[没记下：原因]` | 事件类型表、flags、路径、配额、内部状态 |
| `her_recall` | 命中 id、date、type、text、score | `[翻到] 日期｜原话` + `（编号 1=ev_…）` | type、score、匹配原因 |
| `her_leave` | ok、事件 id、letter mark、text | `[已留]` / `[没留：原因]` | id、mark |
| `her_inbox` | 任务 id、会话、最后一句、状态、排序分 | `[待回] 「会话」：最后一句…`；需要后续操作时脚注任务 handle | 排序分、内部状态、总数 |
| `her_remind` | scheduleId、chat、dueAt、text、permit | `[已定：明天 09:00 发到「X」]` | id、permit、检查细节 |
| `her_reminders` | 行 id、chat、dueAt、text | `[提醒] 明天 09:00「X」` + `（编号 1=提醒 id）`；取消时原样带回 | permit、内部状态 |
| `her_remind_cancel` | ok、id、错误 | `[已取消]` / `[没取消：原因]` | id |
| `her_tools` | query/group、命中项、策略允许集、已揭示集合、完整 schema 引用 | `[工具] 1. 名字 — 一句话`；最多 5 条；需要时再 `[已打开]` | 完整参数 schema、内部策略表、allow/deny 名单 |

`her_tools` 的 `load` 不是把 schema 正文塞进返回；它改的是下一轮可见工具集合，返回只说 `[已打开]`。如果宿主不支持下一轮装载，就报告“这条路上打不开”，不能假装已经打开。

### 5.2 B 站工具

| 工具 | 台账（完整） | 透传（模型） | 隐藏 |
| --- | --- | --- | --- |
| `bili_look` | 每条 bvid、title、up、tags、desc、stats、comments、voice、错误码 | `[看到] 4 条：标题 / UP / 一句介绍；评论区原话最多引一句` | bvid、URL、播放量、内部错误码、完整评论树 |
| `bili_watch` | bvid、title、path、frames、OCR 原文、截断数、时长；另写 `saw` 事件 | `[画面] OCR 文本`；没认出字就 `[只看到画面，没读出字]`；能返回图片时直接给图片块 | path、帧数、截断数、错误码 |
| `bili_speak` | ok、said、rpid、bvid、root、配额、错误；另写 `utterance(surface='bili')` | `[已发 · 「实际原话」]` / `[没说：原因]` | rpid、root、配额、线程 id |

`bili_watch` 的 `path` 是“条件必需”：只有后续 `read_image` 真能用时才给；如果当前路由不支持图片，路径就是噪声，改成一句“看不了画面”。

### 5.3 微信工具

| 工具 | 台账（完整） | 透传（模型） | 隐藏 |
| --- | --- | --- | --- |
| `wx_see` | path、宽高、时间、截图状态 | `[截了图，但这条路上看不了图]`；支持图片时给图片块 | path、宽高 |
| `wx_peek` | 原始树文本、parsed、digest、source、tree health、mood | `[微信] 当前会话；侧栏会话名/未读/@；最后几条消息；可点按钮名` | 坐标、box、置信度、原始文本、字段名；树落后只留一句提示 |
| `wx_click` | x/y、target、before/after、current | `[点到了「X」，现在在「Y」]`；不一致就说不一致 | 坐标、控件类型 |
| `wx_type` | text、enter、chat、receipt、outMsgId | `[打好了，还没发]` / `[发出去了，消息在末尾]` / `[发出去了，但列表里没看到，可能还没刷新]` / `[没发出去：原因]` | 字数、outMsgId、context capture 细节 |
| `wx_send` | chat、text、receipt、outMsgId、taskId、permit、检查结果 | `[已发到「X」，消息在末尾]`；任务只写 `[任务已记为回了一半]` | message id、permit、allowlist、频率检查细节 |
| `wx_context` | 卡片 msgId、chatId、sender、at、text、reasons、source、confidence、semantic | `[翻到] 「会话」里相关的 N 条：谁（时间）：原话` | 匹配原因、来源、置信度、msgId、semantic 标志 |
| `wx_task_snooze` | taskId、minutes、dueAt | `[推迟了 15 分钟]` | taskId、dueAt 精度 |
| `wx_task_done` | taskId、note、status | `[完成了]` | taskId、内部状态 |
| `wx_ocr` | 原始 OCR JSON、侧栏行、消息、box、confidence | `[屏幕上看到] 可读文字`；认不全就 `[屏幕上的字没认全]` | JSON、box、confidence、坐标 |
| `wx_key` | keys、chat、gate | `[按了 X]` + 当前会话（Return 时） | gate 细节 |
| `wx_sticker_scan` | total/added/matched/stale、warnings、closed、耗时 | `[扫完了：新增 2，认回 3，没看到 1；面板已关]` + 警告 | id、路径、耗时 |
| `wx_sticker_list` | 条目 id、text、desc、tags、conf、box、lastSeen | `[收藏] 1. … 2. …` + `（编号 1=st_…）` | conf、box、lastSeen 精度 |
| `wx_sticker_find` | 命中 id、score、reasons、entry | `[找到] 1. … 2. …` + 编号 handle | score、reasons、conf |
| `wx_sticker_tag` | id、patch、entry、index version | `[改好了：标签…]` | id、index version |

dev 多出来的四个入口按同一规则处理：

| 工具 | 台账（完整） | 透传（模型） | 隐藏 |
| --- | --- | --- | --- |
| `wx_history` | 完整消息、msgId、时间、会话 | `[之前] 谁：原话`，按时间顺序 | msgId、原始时间戳、内部游标 |
| `wx_sticker_send` | sticker id、chat、receipt、outMsgId | `[发出去了]` / `[没发出去：原因]` | id、outMsgId |
| `wx_sticker_collect` | sticker id、entry、结果 | `[收好了]` / `[没收好：原因]` | id、索引版本 |
| `wx_sticker_search` | query、命中 id、score、entry | `[找到] 1. … 2. …` + 编号 handle | score、原始索引 |

如果实施时 dev 的入口与上表不一致，以注册表为准；这份表只固定投影原则，不把分支数量写死。

### 5.4 QQ 工具

| 工具 | 台账（完整） | 透传（模型） | 隐藏 |
| --- | --- | --- | --- |
| `qq_send_image` | sent、messageId、chatId、sources、caption、大小 | `[发出去了]` / `[没发出去：原因]` | messageId、chatId、路径/URL、大小 |
| `qq_send_voice` | sent、messageId、chatId、path、大小 | `[发出去了]` / `[没发出去：原因]` | messageId、path |
| `qq_send_video` | sent、messageId、chatId、path、大小 | `[发出去了]` / `[没发出去：原因]` | messageId、path |
| `qq_send_file` | sent、messageId、chatId、path、name、大小 | `[发出去了]` / `[没发出去：原因]` | messageId、path |
| `qq_send_forward` | sent、messageId、chatId、nodes | `[发出去了]` / `[没发出去：原因]` | messageId、节点 id |
| `qq_napcat_api` | action、params、原始响应、错误 | 按 action 投影：群成员 → 名字/角色列表；OCR → 文字；AI 语音 → `[好了]`；未知 action → `[拿到了]` + 一句摘要 | 原始 JSON、retcode、内部 id |
| `qq_group_history` | message_id、time、user_id、nickname、text、segments、raw | `[群历史] 最近 N 条：昵称：原话` | message_id、user_id、时间戳格式、segments、raw |

`qq_napcat_api` 是机器工具，不是聊天工具。它应该放在 deferred 组里；如果某个 action 没有专用投影，就不把原始响应当成聊天内容，宁可返回一句“拿到了，但这条路上看不出内容”，再让专用工具去取。

### 5.5 宿主工具

| 工具 | 台账 | 透传 | 说明 |
| --- | --- | --- | --- |
| `read_image` | path、mime、bytes、耗时 | 图片块 | 宿主直接给图，不需要文本投影；台账只记元数据 |

## 6. Prompt 重编译

### 6.1 结论

**需要，但不是重写人设。** 需要重编译的是“工具结果怎么被理解”的那一小段，以及去掉和工具说明重复的教程；不需要加一个“请像人一样说话”的指令，也不需要在回复后跑一个润色器。

理由：

- 投影已经把 JSON 和 id 拿掉了；剩下的问题是模型可能把方括号状态当成自己的话复述。
- 现有 `growth_commit` 已经用方括号解决了这个问题，说明“舞台提示”方向有效。
- 加“要有人性”容易让模型表演“人性”（多余的俏皮、口头禅），反而更假。
- 事后润色会多一次模型调用，抹平她自己的语气，也会让工具结果和最终回复更难对齐。

决策顺序：**先改投影，再加 `RESULT_BRIEF`，最后检查 persona 段是否被工具教程挤占**；三步都不做“回复后润色”。

### 6.2 建议加入的段落

放在身份文档的 core 段，所有面共享，控制在 4–6 行：

```text
## 看到结果之后
工具回来的是刚发生的事，不是让你复述的报告。
方括号里是状态，不是你的话；别把编号、路径、字段名、置信度念出来。
看到什么，用你自己的话说；没看清就说没看清；没发出去就说没发出去。
对方问的是人话，你答的也是人话。
```

这段只讲“怎么对待结果”，不讲“你是什么性格”。人设仍由现有 persona 段负责。

### 6.3 各面的附加一句

- Web/home：`这里没有别人，不用汇报工具做了什么。`
- WX：`屏幕可能慢半拍；没看到回执就别说发出去了。`
- QQ：`群里说话短一点；历史只是背景，不是让你逐条复述。`
- B 站：`评论是给陌生人看的；工具只告诉你发没发出去。`

这四句只补该面的现实约束，不重复工具用法。

### 6.4 该删的重复

- `TOOL_BRIEF` 里对 `growth_commit` 的“只能新增/revise 用 id”已经在工具 description 和 schema 里；保留一句“想改就 revise”即可，不重复整段。
- `RECALL_BRIEF` 里“小括号是 id”可以保留，因为它是 handle 的使用说明；但不要在每个工具返回里再写一遍。
- `BSITE_BRIEF` 是策略和人设，不是工具教程，保留；但把“发评论的规矩”里已经由工具 schema 强制的长度/格式说明压缩。
- `wx_context` 返回末尾的“只查这个任务自己的会话；查询不写进记忆”是工具 description 的内容，不要每次返回都重复。

### 6.5 验证

分三组 A/B：

1. **baseline**：当前返回。
2. **projection**：只改投影，不改 prompt。
3. **projection + prompt**：再加 `RESULT_BRIEF`。

指标：

- `toolEchoRate`：工具投影文本与回复的最长公共子串 ≥ 12 字，或 4-gram 重叠 > 0.3。目标下降。
- `structuredLeakRate`：回复里出现 `{`、`}`、`"`、`id=`、`message_id`、`confidence`、`ev_` 的比例。目标接近 0。
- `metaTalkRate`：回复里出现“工具/返回/调用/系统/参数”的比例。目标下降。
- `reportRate`：闲聊里出现项目符号、“已完成”“以下是”的比例。目标下降。
- `taskSuccess`：发消息、查上下文、发提醒、B 站评论、QQ 发图是否仍成功。不能下降。
- 自然度盲评：同一组对话，用户不知道版本，按 1–5 打分；目标不低于 baseline。

验收顺序：先看 `taskSuccess` 不降，再看 `structuredLeakRate` 和 `toolEchoRate`；如果投影已经解决回声，就不加 prompt，避免过度指令。

## 7. 实施阶段

实施先在 dev 工作树进行，投影和 prompt 的 A/B 也在 dev 跑；验收通过后再合回 main，不直接在已部署的 main 上改。

### Phase A：台账与包装器

- 新增 `tool-result.js` / `tool-ledger.js`，实现 `registerTool`、`project*`、`ToolError`、台账写入。
- 先接 `growth_commit`、`her_recall`、`her_leave`、`her_remind*`、`her_inbox`。
- 测试：每个工具一条台账、完整结果、脱敏、投影无 JSON。

### Phase B：B 站

- `bili_look`、`bili_watch`、`bili_speak` 改成结构化结果 + `project`。
- `bili_watch` 的 path 改成条件透传；支持图片时给图片块。
- 测试：素材保留、路径不泄漏、评论原话保留、错误码不进模型。

### Phase C：微信

- `wx_peek`、`wx_ocr`、`wx_context` 三个重点先改；再改 `wx_send`、`wx_type`、`wx_click`、`wx_key`、任务和表情。
- 保留发送闸、permit、频率检查、GUI 锁；投影只改“返回什么”，不改“能不能做”。
- 测试：会话/频率/permit 回归、回执不确定性、无坐标/无 msgId 泄漏。

### Phase D：QQ

- 五个发送工具用 `status`；`qq_group_history` 用 `transcript`；`qq_napcat_api` 按 action 投影。
- 如果适配层无法包装 vendor 的 `render`，先对这两个工具做薄 fork/上游补丁，并在报告里说明。
- 测试：发送成功/失败、群历史正文、napcat 未知 action 不返回原始 JSON。

### Phase E：Prompt 与 A/B

- 加入 `RESULT_BRIEF`，按面加一句；删掉重复教程。
- 跑三组 A/B，记录指标；通过后再合回 main。
- 不在本阶段做“回复润色器”。

## 8. 风险与待决

### 风险

- **投影过度压缩**：像 `qq_group_history` 现在这样只剩计数，闭环会断。每个读工具必须保留“她要读的内容”，不是只留状态。
- **投影回声**：如果投影写成完整句子，她可能复述。坚持方括号和舞台提示；用 `toolEchoRate` 守住。
- **台账膨胀**：`wx_peek`、`wx_ocr`、`qq_napcat_api` 可能很大。用 artifact 分文件，按日切分，不自动删除。
- **隐私**：台账是本地 `0600`，但仍可能包含聊天正文。优先用 `refs.msgIds` 指向已有消息台账；不复制 cookie/token。
- **vendor 包装**：QQ 插件不一定允许替换已注册工具的 `render`。如果不能，必须明确哪些工具暂时保留原样，不能假装已经统一。
- **prompt 过度指令**：加太多“要像人”会让她更假。先改投影，再小步加 prompt；用盲评决定是否保留。

### 待决

- 台账保留期：先不自动清理；是否按 30/90 天归档，需要用户定。
- `wx_see` / `bili_watch` 是否改成直接返回图片块；取决于当前模型路由是否支持图片输入。不支持时路径是噪声，应隐藏。
- `wx_sticker_send` / `wx_history` 等 dev 入口的最终形状，以实施时的注册表为准。
- `qq_napcat_api` 是否继续对模型开放；如果只是维护工具，可以留在 deferred 组，并只给专用投影。
- 是否把 `wx_sticker_send` 改成接受“编号/描述”而不是 id；如果改，能进一步减少 handle 泄漏。

## 9. 关键证据与文件

| 文件 | 现状 | 本设计中的问题 |
| --- | --- | --- |
| `src/dsh-wx/lib/index.js:1561-1578` | `wx_peek` 返回原始树文本 / OCR JSON | 过度结构化 |
| `src/dsh-wx/lib/index.js:1846` | `wx_ocr` 返回 24k JSON | 过度结构化、上下文挤占 |
| `src/dsh-wx/lib/retrieval.js:274-330` | 上下文卡片带匹配、来源、置信度、msgId | 检索报告语域 |
| `src/dsh-fish/lib/capture.js:110-130` | 方括号回执，注释记录 letter 回执被复述的“AI 味”教训 | 回执回声 |
| `src/dsh-fish/lib/recall.js:100-111` | `her_recall` 把 id 放小括号 | handle 的正面例子 |
| `src/dsh-fish/lib/watch.js:100-120` | `bili_watch` 返回帧数、免责声明、路径 | 条件必需/噪声混杂 |
| `src/dsh-fish/lib/speak.js:115` | `bili_speak` 返回“说出去了：「…」” | 可改成方括号状态 |
| `/opt/.../dsh-onebot-qq/lib/tools.js:30-37` | QQ 发送返回 `message_id=…` | 内部 id 泄漏 |
| `/opt/.../dsh-onebot-qq/lib/tools.js:242-266` | `qq_napcat_api` 返回原始 JSON | 过度结构化 |
| `/opt/.../dsh-onebot-qq/lib/tools.js:268-303` | `qq_group_history` 只渲染“N 条历史消息” | 过度压缩，闭环断裂 |
| `src/dsh-fish/lib/persona.js:346-399` | `TOOL_BRIEF` / `RECALL_BRIEF` 与工具 description 有重复 | prompt 可压缩 |
| `src/dsh-fish/lib/selfdoc.js:234-287` | 身份文档拼接工具说明 | 加入 `RESULT_BRIEF` 的位置 |

## 10. 与父设计的关系

- 父设计定义“谁拥有工具、哪个面看见哪些工具”；本设计定义“工具回来什么、模型看见什么”。
- `fishCore` 增加 `toolLedger` 服务；`dsh-bili` / `dsh-wx` 通过它写台账，投影函数留在各自插件里。
- 本设计的 Phase A/B 可以和父设计的 Phase 1-2 合并；Phase C/D 跟在工具面拆分之后；Phase E 放在验收前。
- 本设计不改变父设计的工具矩阵、发送边界和事件模型；只改变返回的记账与透传方式。
