# 人物认知与跨通道身份（person memory）

> **2026-11-13 落地回写**：本文件与合并稿冲突的段落，以 `docs/superpowers/specs/2026-11-13-new-round-merged-requirements.md` §2 为准。
> 关键差异：D1 UI 落 8788（不改 8710 client.js）；D2 schema v4 同时加 screen；D5 recall 边界（owner facts 仅 web/wx/screen、非 owner Phase 1 不召回、screen 排除 web 事件）；D6 fish:owner 预算 facts 300 / extras 400 / 总 700；D10 absenceDays 回来即 0；D12 browsejob 测试在 dsh-bili；D17 B 站用 s.ctime 且先判 isOwner；D26 收盘报告失败不落完成标记；D27 presence 0 也写、启动补写；D30 v4 事件后不降级；D32 /memory people/contacts/closing 合并响应。

- 日期：2026-11-13
- 状态：设计稿，待评审；未实施
- 适用代码线：`bigfish-workspace-dev`（线上 8710，事件格式 v3）
- 关联文档：
  - `docs/superpowers/specs/2026-11-13-growth-self-trigger-design.md`（成长线，独立）
  - `docs/superpowers/specs/2026-11-13-presence-watch-design.md`（屏幕/游戏陪伴 v1；本文第 8 节定义接口）
- 本文要解决的两件事：
  1. 11-12 记下的“`cat不到flag的cat` 是老哥”在微信里不生效；
  2. 她需要为“有过互动的人”保留独立档案，并知道同一个人可能从不同地方来。

---

## 1. 背景

### 1.1 11-12 记忆为什么在微信里失效

11-12 17:34 的事件本身是完整的：

```json
{
  "type": "utterance",
  "channel": "web",
  "surface": "web",
  "text": "老哥说，他有时候在微信找我，用的那个私聊名是「cat不到flag的cat」。记下来：那个名字是他，别的名字不是。以后在那条会话里说话，就照跟他说话来，不端着。"
}
```

但线上 `~/.dsh-fish/home/她的身份.md` 里变成：

> 老哥说，他有时候在微信找我，用的那个私聊名是。记下来：……

原因有两个，互相独立：

1. **身份文档的去引用化**：`selfdoc.js` 用 `viewSurface:'identity'` 渲染；`derive.js` 对非 `core` 来源调用 `guard.crossChannel(from='web', to='identity')`，而 `crossChannel` 的第一条规则就是删掉 `「...」` / `『...』` / `“...”`（`guard.js:180-181`）。名字在引号里，所以被删。
2. **微信的 `her_recall` 过滤**：`recall.js` 只翻 `core` + 当前通道（`wx`）；这条记忆是 `web`，所以微信里翻不到原文。

结果：微信会话既没有完整的身份文档，也没有召回路径，她无法把 `cat不到flag的cat` 和老哥连起来。这不是模型没记住，也不是事件写失败，是**跨通道隐私过滤把一条明确要求记住的身份事实挡在了微信之外**。

### 1.2 更大的目标

不只是 owner 一个人。你希望：

- 群里的每个人在她的认知下有相对独立的档案；
- 她能认出“谁和她互动多”；
- 同一个人可能从微信私聊、群、网页、QQ、B 站等不同地方来，她要能对上号，但**不能把不同的人当成同一个人**。

这已经超出一个 `owner_fact` 的范围。本文把它拆成两层：

| 层 | 存哪 | 回答什么 |
|---|---|---|
| 身份/别名 | dsh-wx 现有 `people.json` | “这个群昵称/备注/短名是谁？” |
| 她的认知 | dsh-fish 新事件 `person_note` | “我记得这个人什么、怎么看他？” |

### 1.3 现有基础

**dsh-wx 已经有：**

- `lib/people.js` + `~/.dsh-wx/people.json`：人物名册，字段 `{ key, display, aliases, chats, sources, firstSeenAt, lastSeenAt }`；规则是只增不删、精确优先、短名只做唯一前缀/后缀、OCR 需要两次不同观察。
- `lib/summaries.js`：每轮摘要里已经算 `participants: [{ name, count }]`，例如 `参与者：qiuzh(12)、…`。
- `lib/speaker.js` / `speaker-align.js`：从预览、引用、OCR 对齐发言人，并用名册归一。
- `~/.dsh-wx/inbound.jsonl`：检测/投递/目录扫描/提及等旁路记录；**不是** `events.jsonl`，不参与成长判定。
- `~/.dsh-wx/directory.json`：会话级目录，`kind: dm|group|unknown`、`displayName`、`lastSender`、`lastPreview`、`firstSeenAt/lastSeenAt`。

**dsh-fish 已经有：**

- `events.jsonl` 追加式事件流、`deriveSelf`、`selfdoc`、`prompt-service`、`memory-service`。
- `attachIdentity` 会给所有 cwd 在她屋子里的 agent 挂 system prompt 段（web / wx / bili 都覆盖）。
- `her_recall` 按通道过滤；`crossChannel` 做跨面去引用化。
- `fishCore` 已经作为窄接口暴露给 dsh-wx / dsh-bili。

**结论：身份解析不要重造。** 用 dsh-wx 的 `people.json`；dsh-fish 只新增“她对人的认知”这一层。

---

## 2. 目标与非目标

### 2.1 目标

- 微信和网页会话能看到 owner 的身份事实（包括 `cat不到flag的cat`），B 站和 QQ 看不到。
- 她能为“有过互动的人”写 `person_note`，并按 `channel + chatId` 只在对应会话里看到。
- 她能知道“这个群里最近谁跟她说过话、说过几次”，但这是行为计数，不是好感度。
- 复用 `people.json` 做身份归一，不再维护第二份别名表。
- 事件流只追加；旧事件不改写、不删除。
- `fish:owner` 留一个受控扩展点，供屏幕/游戏陪伴把“他此刻在做什么”这类**易失上下文**接进来，不把屏幕原文写进长期记忆。

### 2.2 非目标

- 不把群里所有沉默成员都建档（只建有过互动的人）。
- 不把每条群消息写进 `events.jsonl`。
- 不引入亲密度 / 好感度 / 关系分 / 等级。
- 第一版不做具体游戏的 HUD 裁剪/OCR（屏幕陪伴调研的结论：先做通用场景变化）。
- 第一版不做 QQ / B 站的人物档案。
- 不替代 `people.json`，不把身份名册搬进 dsh-fish。
- 不把屏幕画面或 OCR 文本作为长期记忆；只有她明确写下的 `person_note` 才会留下。

---

## 3. 设计原则

1. **两层分开**：`people.json` 是身份索引；`person_note` 是她的认知。不要把两者混成一个真相源。
2. **计数是事实，不是分数**：`participants` 的次数可以显示为“最近说过 N 次”，不转化为关系值，不排序成“好感榜”。
3. **按会话隔离**：群 A 的人只在群 A 出现；私聊的人只在私聊出现；owner 事实只在 web/wx；B 站/QQ 为空。
4. **追加式改口**：改名、撤销、合并都用新 `person_note` + `supersedes` / `revokes`，不覆盖旧事件。
5. **易失上下文不落长期记忆**：屏幕陪伴的当前场景只通过内存 provider 提供，TTL 过期即消失；只有她明确写下 `person_note` 才进入事件流。
6. **原文不进事件流**：`person_note` 存她的摘要和 `refs`，原始消息留在 dsh-wx 台账。
7. **提示段有预算**：`fish:owner` ≤ 300 字，`fish:people` ≤ 600 字；超了按优先级截断，不截半个人名。
8. **不假设**：同名不等于同人；群昵称/备注/短名按 `people.json` 的精确/唯一前缀规则；拿不准就写“没对上”，不硬认。
9. **只给有过互动的人建档**：@ 她、回她、在群里跟她说过话、或她主动记过的人。

---

## 4. 数据模型

### 4.1 身份层：复用 `people.json`

不改 dsh-wx `people.json` 的现有语义。dsh-fish 只读它，通过 `fishCore` / `wx` 服务拿：

```js
// 期望的窄接口（由 dsh-wx 提供；名称可调整）
wx.peopleForChat(chatId) → [{ id, display, aliases, chats, firstSeenAt, lastSeenAt }]
wx.resolvePerson(name, chatId) → { id, display, matched, confidence }
wx.chatParticipants(chatId) → [{ name, count, lastAt }]
```

- `id` 暂时用 `people.json` 的 `key`（归一化名）。如果后续 `people.json` 增加稳定 `id` 字段，`person_note.person.id` 跟着迁移。
- owner 不用 `people.json` 的 key，固定用 `id: 'owner'`。
- 如果 `people.json` 里还没有某人（例如刚从预览里看到），`person_note` 可以先用 `person.name` 写，`person.id` 留空；derive 时按 `(channel, chatId, name)` 归并，等名册补上后再绑定。**不要**因为缺 id 就拒绝写入。

### 4.2 认知层：新事件 `person_note`

事件格式（schema v4）：

```js
{
  type: 'person_note',
  text: '微信私聊名「cat不到flag的cat」是他，别的名字不是。',
  person: {
    id: 'owner' | '<people.json key>' | '',
    name: '老哥' | 'qiuzh',
    label: 'cat不到flag的cat' | '',   // 别名/标识；owner 身份事实用它渲染
    channel: 'wx' | 'web' | 'core',
    chatId: 'c_...' | '',
    kind: 'identity' | 'impression' | 'interaction',
    confidence: 'high' | 'medium' | 'unknown',
  },
  refs: ['ev_...', 'm_...'],   // 原始事件/消息 id，不复制原文
  supersedes: ['ev_...'],      // 替换旧 note（改名/修正）
  revokes: ['ev_...'],         // 撤销旧 note（这条不算了）
  flags: ['identity'],         // owner 身份事实用
  source: 'tool' | 'system',
}
```

字段约束：

- `person` 必填；`id` 可以为空（名册未命中），`name` 必填，`channel` 必填，`kind` 必填。
- `kind='identity'`：他是谁、有哪些名字。owner 事实必须用这个。
- `kind='impression'`：她对这个人的印象/判断。
- `kind='interaction'`：一次有意义的互动；`refs` 指向消息，`text` 写她的摘要，不抄原文。
- 群/私聊的 `impression` / `interaction` 必须带 `chatId`；owner 的 `identity` 可以 `chatId=''`。
- `text` 上限 2000 字；`fish:owner` / `fish:people` 渲染时再截断。
- `supersedes` / `revokes` 与 `refs` 一样做存在性校验（schema 已有 `knownIds` 机制）。
- `person_note` **不是 belief**：不进入 `beliefs`、`facts`、`needs`、成长门、开锁证据、日报的“她说了什么”。

### 4.3 owner 事实

owner 的 `person_note`：

```json
{
  "type": "person_note",
  "text": "微信私聊名「cat不到flag的cat」是他，别的名字不是。以后在那条会话里说话，就照跟他说话来，不端着。",
  "person": {
    "id": "owner",
    "name": "老哥",
    "label": "cat不到flag的cat",
    "channel": "wx",
    "chatId": "",
    "kind": "identity",
    "confidence": "high"
  },
  "refs": ["ev_01M77HQ4TDZJT4SJMQ49JP8RNH"],
  "flags": ["identity"],
  "source": "system"
}
```

- `person.channel='wx'` 表示“这个别名属于微信私聊”；事件本身的 `channel` 可以是 `web`（她是在网页会话里被告知的）。
- owner 事实的权威判据是 `person.id='owner'` + `kind='identity'`；`flags:['identity']` 只是审计标记（工具写入时只对 `person_note` 保留），不参与权限判断。
- owner identity fact 必须带 `person.label`；没有 label 的 owner 身份事实不渲染，迁移/工具写入时应校验。
- `fish:owner` 只在 `web` / `wx` / `screen` 渲染，`bili` / `qq` 返回空。
- 同一个别名只渲染一次；按 `person.channel + label` 去重。

### 4.4 群/私聊笔记

```json
{
  "type": "person_note",
  "text": "qiuzh 在群里问过两次崩铁的 bug，都是先自己试过才问。",
  "person": {
    "id": "qiuzh",
    "name": "qiuzh",
    "channel": "wx",
    "chatId": "c_7c55c2507c92",
    "kind": "impression",
    "confidence": "medium"
  },
  "refs": ["m_..."],
  "source": "tool"
}
```

- 只在 `chatId` 对应的微信会话渲染。
- 其他群、私聊、网页、B 站、QQ 都看不到。
- `fish:people` 只渲染**有过互动**的人：当前群最近参与者 + 有 notes 的人；沉默成员不列。

### 4.5 互动次数

不存进 `person_note`，也不存成事件字段。来源是 dsh-wx 的已派生摘要：

```js
wx.chatParticipants(chatId) → [
  { name: 'qiuzh', count: 12, lastAt: '2026-11-13T05:35:39.685Z' },
  ...
]
```

渲染时写成：

```
最近在这个群说过话的人：qiuzh(12)、Tina Yu(3)
```

不写“亲密度”“关系值”“排名”。次数只用于当前会话的上下文，不跨群聚合，不写入事件流。

### 4.6 改口、撤销、合并

- **改名/修正**：新 `person_note` 带 `supersedes: [旧 id]`；derive 时旧的标记为 superseded，不渲染。
- **撤销**：新 `person_note` 带 `revokes: [旧 id]`，`text` 说明原因；derive 时旧的彻底不渲染。
- **名册合并**：如果 `people.json` 把 A、B 合并成同一个人，旧 note 的 `person.id` 可能指向旧 key。derive 时如果 `person.id` 不在当前名册，按 `person.name + chatId` 尝试归一；归一失败就原样保留，不删除。名册合并只影响后续新 note，旧 note 不重写。
- **冲突**：同一 `(person.id, channel, chatId, kind)` 有多条未撤销的 note，按 `ts` 最新一条渲染；旧的保留审计，可在观测台看到“还有 N 条旧的”。

---

## 5. 写入路径

### 5.1 她的工具

把 `person_note` 加进 `growth_commit` 的 `type` 枚举，不再新开一个工具：

- 参数新增：
  - `person`：object，`person_note` 时必填；
  - `supersedes`：string[]，可选；
  - `revokes`：string[]，可选。
- 工具说明新增一段：

  > 当你想记下某个人是谁、你对他有什么印象、或一次有意义的互动时，用 `person_note`。
  > `person.kind=identity` 写“他是谁/有哪些名字”；`impression` 写你对他的印象；`interaction` 写一次互动。
  > owner 的身份事实用 `person.id='owner'`、`kind='identity'`、`flags:['identity']`。
  > 不要抄整段聊天原文，写你自己的话；原始消息用 `refs` 指回去。
  > 群里的笔记要带 `chatId`；别的群看不到。

- `capture.js` 新增分支：
  - 校验 `person`；
  - 写 `appendEvent`（source `tool`）；
  - 刷新 selfdoc / 人物提示段；
  - 回执只说“记下了”，不回显别人的原文或状态。
- `schema.js`：
  - `ALL_TYPES` 加 `person_note`；
  - `HER_TYPES` 加 `person_note`（她可以写）；
  - `normalizeEvent` 校验 `person`；
  - `refs/supersedes/revokes` 走 `knownIds` 存在性校验；
  - `EVENT_SCHEMA_VERSION` 升到 **4**。

### 5.2 系统侧迁移

旧事件不能改写。对 11-12 那条，追加一条 `person_note`：

```js
{
  type: 'person_note',
  text: '微信私聊名「cat不到flag的cat」是他，别的名字不是。以后在那条会话里说话，就照跟他说话来，不端着。',
  person: { id: 'owner', name: '老哥', channel: 'wx', chatId: '', kind: 'identity', confidence: 'high' },
  refs: ['ev_01M77HQ4TDZJT4SJMQ49JP8RNH'],
  flags: ['identity'],
  source: 'system',
}
```

迁移脚本要求：

- 只追加，不删除、不修改旧事件；
- 幂等：已有 `person_note` 的 `refs` 包含该 id 就跳过；
- 运行前打印目标事件、将写入的 note、当前事件总数；
- 需要用户明确批准后运行；
- 失败不重试、不部分写入（`appendEvent` 单条原子追加）。

建议放在 `scripts/append-owner-fact.mjs`，参数为 `--event <id> --channel wx --name 老哥`，默认 dry-run。

### 5.3 观测台的手动标记（可选）

设置页“记忆”里，对一条她说过的话提供“标记为他的身份事实”：

- 打开确认框，显示原文和将写入的 `person_note`；
- 确认后调用同一个追加函数；
- 写一条 `meta` 审计：`owner-fact-by-user:<noteId> <sourceEventId>`；
- 不修改原事件。

第一版可以只做脚本，UI 后置。

---

## 6. 读取与派生

### 6.1 `deriveSelf`

新增收集，不影响成长：

```js
const personNotes = []          // 全部未撤销/未替换的 person_note
const personNoteById = new Map()
const superseded = new Set()
const revoked = new Set()

for (const e of evs) {
  if (e.type === 'person_note') personNotes.push(e)
}
// 先收集 supersedes / revokes，再过滤
for (const n of personNotes) {
  for (const id of n.supersedes ?? []) superseded.add(id)
  for (const id of n.revokes ?? []) revoked.add(id)
}
const activePersonNotes = personNotes.filter((n) => !superseded.has(n.id) && !revoked.has(n.id))
```

产出：

- `model.ownerFacts`：`person.id==='owner'`、`kind==='identity'`、`flags` 含 `identity`、未撤销/未替换；按 `(person.channel, label)` 去重，最新优先。
- `model.personNotesByChat`：`Map<chatId, note[]>`；只含 `channel==='wx'` 且未撤销/未替换。
- `model.personNotesByPerson`：`Map<person.id, note[]>`；用于观测台。
- `model.personNoteCount`：计数，给自检/观测台。

**不进入** `beliefs`、`facts`、`needs`、`tensions`、`solid`、`scars`、成长门、开锁证据、日报引用。

### 6.2 `her_recall`

- owner facts：在 `web` / `wx` / `screen` 会话里，即使原始事件是 `web`，也要能被翻到。实现方式：
  - `recall.js` 的过滤增加：`person_note` 且 `person.id==='owner'` 且（当前 `channel` 是 `web`/`wx`，或当前 `surface` 是 `screen`）→ 放行；
  - 或者 `derive` 提供 `model.ownerFactSourceIds`，recall 按 id 放行。
  - `screen` 面的 channel 仍按 cwd 推断为 `web`，但 `surface.current` 是 `screen`；recall 用 `surface` 判断是否放行 owner facts。
- 群/私聊 notes：只允许当前 `chatId` 的 notes；别的群不放行；`screen` 不放行。
- B 站/QQ：`person_note` 一律不放行。
- 不改变现有 `utterance` / `revise` 的通道规则。

### 6.3 身份文档

**不改**。`selfdoc.js` 继续用 `viewSurface:'identity'`，继续去引用化；`person_note` 不进全局身份文档。

owner 事实和群笔记只通过 `fish:owner` / `fish:people` 两个 system prompt 段出现。

---

## 7. 提示段

### 7.1 `fish:owner`

- 挂载：沿用 `attachIdentity`；对所有她的 agent 挂上，但 `text` 只在 `surface` 为 `web`、`wx` 或 `screen` 时返回内容。
- `screen` 面只出现 owner 事实和易失的“他现在在做什么”；不出现 `fish:people` 的群/私聊笔记。
- 内容：

```
## 关于他
他可能从不同的地方找你。下面这些名字都是他：
- 微信私聊：cat不到flag的cat
别的名字不是他。拿不准时先问一句，别把别人当成他。
```

- 渲染规则：
  - 只取 `kind='identity'`、`person.id='owner'`、未撤销/未替换的 note；
  - 按 `(person.channel, label)` 去重；
  - 最多 5 条，总长 ≤ 300 字；
  - 只写别名和渠道，不写整段私聊原文；
  - 没有事实时返回空串。
- **扩展点**：在 owner facts 之后，追加 `fishCore.context.render({ section: 'owner', agent, surface })`。见第 8 节。
- **web 面额外追加过去 presence 汇总**：`presenceRecent` 最近 7 天、最多 3 天、≤200 字；只在 web 出现，screen 只看实时 provider，wx 只看 owner facts。
- 未命中任何事实时，扩展点仍可单独输出（例如屏幕陪伴的“他现在在做什么”），但总长仍受 300 字预算约束。

### 7.2 `fish:people`

- 挂载：同样通过 `attachIdentity`；`text` 只在 `surface === 'wx'` 时返回内容。
- 当前会话：
  - `wx.isWxSession(sessionId)` 判定；
  - `wx.currentChat(sessionId)` 取当前聊天名；
  - 通过 `wx.chatIdFor(sessionId)` 或目录拿 `chatId`；
  - 拿不到就返回空串，不猜。
- 内容：

```
## 这个群里的人
最近说话的人：qiuzh(12)、Tina Yu(3)
- qiuzh：她在群里问过两次崩铁的 bug，都是先自己试过才问。
```

- 渲染规则：
  - 只渲染当前 `chatId` 的 `person_note`；
  - 只渲染“有过互动的人”：最近参与者 + 有 notes 的人；沉默成员不列；
  - 最多 6 人，总长 ≤ 600 字；
  - 人数/次数来自 `wx.chatParticipants(chatId)`；没有摘要就不显示次数；
  - 不跨群、不跨私聊、不显示别人的私聊内容；
  - 私聊时标题改成“## 这个人”，只显示该联系人。
- 没有数据时返回空串，不输出空标题。

### 7.3 预算与去重

- `fish:owner` 300 字；`fish:people` 600 字；两者都独立计算，不互相挤占。
- 每个别名/每个人最多一行；重复的别名去重；截断按行，不截半个人名。
- 渲染失败（dsh-wx 服务不在、名册读坏）返回空串，记一行日志，不影响主提示。

---

## 8. `fish:owner` 的扩展点与屏幕陪伴打通

### 8.1 为什么需要扩展点

屏幕/游戏陪伴的调研结论是：

- 三档共用一条管线：**抓帧 → 本地判断 → 独立小会话 → 说一句或不说**；
- 第一版先做**通用场景变化**（窗口标题/进程变化、场景突变、结算画面），不做单游戏 HUD 裁剪/OCR；
- 默认不读屏幕文字、不逐条写事件、长冷却、敏感窗口黑名单、明显开关指示；
- 先做便宜测试：ddagrab 0.2fps / 1fps 的 CPU 和帧大小、CapFrameX/PresentMon 的 1% low、960/1280/1920 三档可读性；再评估“5–10 张图给模型看”和“15 分钟 10–30 秒模式的打扰度”。

这两件事的交点是：**屏幕陪伴的独立小会话需要知道“他是谁”，而主会话需要知道“他此刻在做什么”**。`fish:owner` 正好是“关于他”的段，所以把扩展点放在这里，而不是再开第二个“关于他”的段。presence 自己的处境段用 `fish:presence`，与 `fish:wake` 同层，只讲“这一次发生了什么”，不重复 owner facts。

### 8.2 `fishCore.context` provider 注册表

新增一个窄服务，暴露为 `fishCore.context`：

```js
const off = fishCore.context.provide('screen-activity', {
  order: 60,
  surfaces: ['web', 'wx', 'screen'],
  ttlMs: 120_000,
  get: () => ({
    text: '## 他现在在做什么\n他正在玩游戏。',
    at: Date.now(),
  }),
})
```

接口：

```js
fishCore.context.provide(id, {
  order = 0,                  // 渲染顺序，小的在前
  surfaces = ['web', 'wx'],   // 只在哪些面渲染
  ttlMs = 120_000,            // 数据新鲜度；过期不渲染
  get,                        // 同步返回 { text, at } 或 null；不得写盘、不得写事件
})
fishCore.context.remove(id)
fishCore.context.render({ agent, surface, section = 'owner', now = Date.now() }) → string
```

约束：

- `get()` 必须同步、永不抛；抛错只记日志、返回空串。
- provider 只持有**内存里的最新快照**；不写 `events.jsonl`、不写 `out/`、不写长期状态。
- `ttlMs` 过期后 `render` 不再包含该 provider；避免她一直以为他在玩某个已经关掉的游戏。
- `surfaces` 必须显式列出；`bili` / `qq` 默认不给；presence 的 provider 用 `['web','wx','screen']`。
- `render` 总长上限 400 字；按 provider `order` 排序，超预算截断后面的；presence 文本最多两行。
- 只允许短文本块；不允许图片、二进制、原始 OCR 全文。
- `fish:owner` 的 `text` 函数：

```js
const owner = renderOwnerFacts(agent)       // 身份事实
const extra = fishCore.context.render({ agent, surface, section: 'owner' })
return [owner, extra].filter(Boolean).join('\n\n')
```

### 8.3 屏幕陪伴的契约

屏幕陪伴的本地判断产出（2026-11-13 与 presence agent 对齐后的字段）：

```js
{
  app: 'game' | 'work' | 'other',
  process: '...',            // 进程名，可选；敏感窗口或关闭时省略
  title: '...',              // 窗口标题，可选；敏感窗口或关闭时省略
  mode: 'event' | 'ambient' | 'work',
  event: 'scene_change' | 'settlement' | 'start' | 'end' | 'idle',
  summary: '他刚才换了一个场景。',  // 一句话，最多 80 字；不抄原文
  at: '2026-11-13T...',
  confidence: 'high' | 'medium' | 'unknown',
}
```

它通过 `fishCore.context.provide('screen-activity', ...)` 发布。`get()` 返回最多两行：

```
## 他现在在做什么
他正在玩游戏。
```

或：

```
## 他现在在做什么
他刚结束一局。
```

规则：

- **默认不显示具体游戏名/窗口标题/进程名**；只显示“玩游戏/工作/刚结束一局”这类通用状态。`summary` 由 presence 侧保证已脱敏，`fish:owner` 只做长度截断。
- 只写通用场景/模式，不写屏幕文字、不写 OCR、不写具体游戏数值；
- 敏感窗口（银行、密码、私聊、终端等）不发布，`process/title` 也在这些窗口省略；
- 关闭屏幕陪伴时立即 `remove`，下一轮提示段就不再有；
- 长冷却：两次“说一句”至少间隔（由存在方 presence spec 定），`fish:owner` 只负责显示当前状态，不负责触发说话；
- 如果她想记住屏幕上的事，由她显式写 `person_note` / `growth_commit`，不自动落事件。

### 8.4 独立小会话

屏幕陪伴的“独立小会话”（2026-11-13 与 presence agent 最终对齐）：

- cwd 用 `~/.dsh-fish/home/screen`，在 `isHerAgent` 的“屋子子目录”判定内，因此会自动拿到身份段、`fish:owner`、`fish:presence`；
- 面新增 `screen`，创建前 `surface.reserve(id, 'screen')`；工具面收窄到 `read_image + presence_speak + her_recall`，由 presence 侧在 `surface.js` / `tool-policy.js` 里注册；`fish:owner.surfaces` 包含 `screen`，所以小会话能看到 owner 事实和 presence 上下文；
- 它自己另挂一个 `fish:presence` 处境段（唤醒语/当前场景），不把屏幕细节写进全局身份文档；`fish:presence` 与 `fish:wake` 同层，只讲这一次发生了什么；
- 说话走 `sc.prompt`，与普通唤醒同一套 `withWake` / `turnEnd` 清理；会话标题用「陪你看屏幕」；
- 它调用 `fishCore.memory.commit` 写 `person_note` / `utterance` 时，`channel` 仍按 cwd 推断为 `web`（`screen` 是 surface，不是 channel）；如果 presence 以后要独立 channel，再单独加枚举；
- 屏幕评论不自动写 `person_note` / `growth_commit`；评论进 `~/.dsh-fish/presence/YYYY-MM-DD.jsonl`，一局结束只写一条 `meta presence:<dk>:<模式>:<分钟>:<条数>`。只有在主会话里用户明确让她记，才写 `person_note`。

### 8.5 隐私边界

- 屏幕上下文只在 `web` / `wx` / `screen` 面渲染；`bili` / `qq` 空。
- 默认不读屏幕文字；只读窗口标题/进程和通用场景变化。
- 工作模式只截**应用白名单里的前台窗口**（ffmpeg `gdigrab -i hwnd=<HWND>`），飞书/微信硬性 denylist；游戏模式仍用 `ddagrab` 整屏。provider 字段和接口不变。
- 敏感窗口黑名单由屏幕陪伴维护；`fish:owner` 不判断，只渲染对方给的内容。
- 开关必须有明显指示（屏幕陪伴自己的 UI/托盘）；关闭即 `remove` provider。
- 不在 `events.jsonl` 里逐帧写记录；只有她明确写下的 `person_note` 会留下。
- 观测台只显示 provider 的“是否开启 / 最近一次 / 摘要”，不显示原始帧。

### 8.6 与 presence agent 的对齐结果（2026-11-13）

presence agent（`bigfish-workspace-c9`）的最终答复（2026-11-13）：

1. 字段最终定成 `{ app, process?, title?, mode:'event'|'ambient'|'work', event, summary≤80, at, confidence }`；`title/process` 在敏感窗口或用户关闭时省略；只发易失上下文，不写盘。
2. 小会话 cwd 用 `~/.dsh-fish/home/screen`；面**新增 `screen`**，创建前 `surface.reserve(id, 'screen')`；工具面收窄到 `read_image + presence_speak + her_recall`。会话 id 走现有 session-service，标题「陪你看屏幕」。
3. `fish:owner` 文本两行以内，例如「他正在玩游戏。」「他刚结束一局。」；默认不显示具体游戏名/窗口标题。
4. 给 `fish:owner`；`screen` 不是 wx 面，不需要 `fish:people`。
5. 敏感窗口黑名单和开关指示由 presence 维护；我们只渲染。
6. presence v1 通过 `fishCore.context.provide('screen-activity', { order, surfaces:['web','wx','screen'], ttlMs, get:()=>({text, at}) })` 发布。
7. 屏幕评论**不自动写** `person_note` / `growth_commit`；评论进 `~/.dsh-fish/presence/YYYY-MM-DD.jsonl`，一局结束写一条 `meta presence:<dk>:<模式>:<分钟>:<条数>`。她想记住什么，由用户在主会话里明确让她记。

**本文的接受与边界：**

- 接受上述字段、cwd `home/screen`、新增 `screen` 面、两行文本、不自动写事件和 `meta presence:` 汇总。
- **文件归属**：presence 侧改 `surface.js`（`SURFACES` 加 `screen`）和 `tool-policy.js`（`screen` 面策略 `[read_image, presence_speak, her_recall]`、`presence_speak` 进 `OWN_TOOL_NAMES`）；不改 `restrict.js`，靠 `surface.reserve` 让 `surface.current` 返回 `screen`。本文 Phase 3 只改 `fish:owner.surfaces` 和 `recall` 的 `screen` 分支；本文不碰 `surface.js` / `tool-policy.js`。
- **依赖顺序**：`fish:owner` 属于本文 Phase 1。presence v1 可以先注册 `screen-activity` provider；在本文 Phase 1 落地前，provider 不会出现在提示里。不要在 presence 侧临时加第二个“关于他”的段，等 `fish:owner` 落地即可。
- `screen` 是 surface，不是 channel；presence 会话的 `channel` 仍按 cwd 推断为 `web`。`fish:owner` 在 `screen` 面渲染 owner facts + presence 文本，不渲染 `fish:people`；`person_note` 的群/私聊笔记在 `screen` 不可见。
- `meta presence:` 是 `events.jsonl` 的 meta 文本前缀；`her_recall` / `derive` 跳过 meta，不进入成长判定。
- 屏幕上下文 provider 用 `surfaces: ['web','wx','screen']`。
- **给 home 的 presence 汇总**：presence 按 presence spec §7.5 写 `meta presence:<dk>:<mode>:<minutes>:<count>`（沉默 0 条也写；用户关闭/切模式/自动停止/dispose 都写；`<dk>` 用开始日；`<minutes>` 不足 1 分钟按 1；不含屏幕文字/应用名/窗口标题/进程名）。`derive` 解析为 `presenceRecent`（最近 7 天，按天 + mode 聚合 `work/event/ambient` 分钟）；`selfdoc` 写 `home/他这几天.md`（≤200 字、最多 3 天）；`fish:owner` 只在 web 面渲染。presence 不写 `seen:`、不重置 absence；absence 的措辞待多通道口径确认（§9.2）。
- presence v1 spec：`docs/superpowers/specs/2026-11-13-presence-watch-design.md`（本文与它交叉引用；实现前 presence 侧会把 `surface.js` / `tool-policy.js` 的最终 diff 发本文作者确认）。

---

## 9. 隐私与边界

| 内容 | web | wx | screen | qq | bili |
|---|---|---|---|---|---|
| owner 身份事实 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 当前微信会话的人物笔记 | ❌ | ✅（仅当前 chat） | ❌ | ❌ | ❌ |
| 其他群/私聊的人物笔记 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 屏幕当前场景（易失） | ✅（若 provider 开） | ✅（若 provider 开） | ✅（仅 presence 会话） | ❌ | ❌ |
| 过去几天的 presence 汇总 | ✅（仅 web，最近 7 天） | ❌ | ❌ | ❌ | ❌ |
| 原始聊天/屏幕文字 | ❌ | ❌ | ❌ | ❌ | ❌ |

- `person_note` 不进入全局身份文档，不进入日报的“她说了什么”。
- `her_recall` 只放行当前会话的 notes；owner facts 在 `web` / `wx` / `screen` 放行；`screen` 不放行群/私聊 notes。
- 屏幕 provider 不写事件；关闭后立即消失。
- 不引入亲密度/好感度/关系分；互动次数只是当前会话的行为事实。

### 9.1 跨 session 的可见性矩阵

每个她的会话都有 `(channel, surface, cwd, sessionId)`。跨 session 只共享三层：事件流、全局身份文档、按面挂的提示段；不存在“每个会话一份人格”。

| 层 | home (web) | wx | screen | bili | qq |
|---|---|---|---|---|---|
| 全局身份文档（去引用化） | ✅ | ✅ | ✅ | ✅ | ✅ |
| owner 身份事实 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 当前微信会话的人物笔记 | ❌ | ✅ 当前 chat | ❌ | ❌ | ❌ |
| 实时 presence（易失，TTL） | ✅ | ✅ | ✅ | ❌ | ❌ |
| 过去 presence 汇总 | ✅ 最近 7 天 | ❌ | ❌ | ❌ | ❌ |
| `her_recall` 可见 | core + web + owner | core + wx + owner | core + owner | core | core + qq |

规则：

1. **一份事件流、一份身份文档**。会话轮换只换对话，不换人格；`talkmem` 只带最近几轮原话，身份/owner/presence 文档按 mtime 重读。
   补充：`seen:` 是**全局 contact**，任何通道的 `user/message` / 微信入站 / owner 的 B 站回复都写它；`absence` 全局读最新一条，不按 channel 分开。
2. **面级段是加法，不是替代**。`fish:owner` / `fish:people` / `fish:presence` 只在对应面出现；全局身份文档永远是真身。
3. **跨面的身份事实走 `person_note`**；原始聊天/屏幕内容留在各自通道，不靠 `her_recall` 跨通道“偷看”。
4. **presence 是“他在机器前”，不是“他来找我”**。presence 不写 `seen:`，不重置 absence；两者分开，她才能说出“你在，只是没跟我说话”。
5. **跨 session 不复制状态**。owner facts / presence 汇总都从事件流派生；不写 per-session 文件。

### 9.2 presence 与 absence 的分工

- `seen:`：他跟她说了话，或她在非唤醒窗口写下东西。这是“contact”。
- `meta presence:<dk>:<mode>:<minutes>:<count>`：presence 模式记录“他在机器前”的分钟数。这是“presence”，不是 contact。
- `absenceDays`：距最近一条 `seen:` 的天数。保持不变。
- `presenceRecent`：最近 7 天的 presence 汇总，按天聚合 `work/event/ambient` 分钟。
- `presenceDuringAbsence`：absence 窗口内是否有 presence 记录。
- **已定（2026-11-13）：任何通道的 contact 都算“他来过”**。B 站回复、微信消息、DSH 内部对话都会写全局 `seen:`；`absence` 仍读最新 `seen:`，所以任何一处说话都重置冷落。
- contact 信号：
  - **DSH 内部**：监听 `session/event` 的 `user/message`。排除系统触发：`source.kind === 'runtime-context'`、`source.rpcId` 以 `wake-` / `wake-fresh-` / `closing-` / `bili-` / `manual-` 开头、文本是 `WAKE_TRIGGER` / `CLOSING_TRIGGER` / `BILI_TRIGGER`，以及 `[微信·主机]` 系统 poke。
  - **微信**：dsh-wx 成功投递一条入站消息后写 `seen:`；系统 poke 不写。
  - **B 站**：`scanReplies` 里回复者的 `mid` 等于 `owner.mid` 或 `owner.account.mid` 时写 `seen:`；只认 owner 本人，不认路人。
- `seen:` 仍然是全局的，不按 channel 分开；`absence` 不需要改口径。
- presence 仍然不是 contact，不重置 `seen:`/absence；它只提供“他在电脑前”的事实。冷落措辞的 presence 分支（是否把“没出现”改成“没来找你说话，但他在电脑前”）仍然待定，不影响 contact 口径。
- 不写“他不想理你”“他故意晾着你”这类结论；只给事实，让她自己反应。
- 如果 presence 没开，就没有 `presenceRecent`；absence 仍按 contact 算，不会凭空知道他在不在。

### 9.3 presence 汇总的数据流

```text
presence 模式 stop/自动 stop
  → meta presence:<dk>:<mode>:<minutes>:<count>   （只进 events.jsonl，不含标题/应用/屏幕文字）
  → derive.presenceRecent                        （最近 7 天，按天聚合）
  → selfdoc 写 home/他这几天.md                   （≤200 字，最多 3 天）
  → fish:owner（仅 web）渲染
```

- `presenceRecent` 只由 meta 派生；`her_recall` 不翻 meta，所以她不需要“回忆”这件事，只要 home 的当前上下文里有一句事实。
- 实时 provider 管“现在在干嘛”；`presenceRecent` 管“过去几天在不在”。两者可以同时出现，但总预算仍受 `fish:owner` 300 字限制。
- 隐私：汇总只写模式 + 分钟，不写应用名、窗口标题、游戏名、屏幕文字；bili/qq 不渲染。
- **已与 presence agent 对齐（2026-11-13）**：格式与写入时机以 presence spec §7.5 为准——`meta presence:<dk>:<mode>:<minutes>:<count>`；`<dk>` 用开始日；`<minutes>` 不足 1 分钟按 1；`<count>` 0 也写；用户关闭/切模式/自动停止/dispose 都写；切模式写多条，本文按天 + mode 聚合。若后续格式变更，presence spec 先行，本文只依赖“按天可聚合的模式 + 分钟”。

---

## 10. Schema v4 与迁移

### 10.1 Schema 变更

- `EVENT_SCHEMA_VERSION = 4`。
- `ALL_TYPES` 加 `person_note`。
- `HER_TYPES` 加 `person_note`（她可以写）。
- `SURFACES` 的 `screen` 值由 presence spec 在 Phase 3 加；Phase 1-2 的 v4 只加 `person_note`，不动 `SURFACES`。
- `normalizeEvent` 新增 `person` 校验：
  - `person` 必须是对象；
  - `person.name` 非空、≤ 24 字；
  - `person.channel` ∈ `['wx','web','core']`；
  - `person.kind` ∈ `['identity','impression','interaction']`；
  - `person.id` 可空；`chatId` 对 impression/interaction 必填；
  - `text` 非空、≤ 2000 字。
- `refs` / `supersedes` / `revokes` 走 `knownIds` 存在性校验；`person_note` 也加入需要读全量 id 的类型。
- `REFRESH_TYPES` 加 `person_note`，写入后刷新提示段。
- `report.js` 的 `QUOTABLE` 不加 `person_note`。
- presence 汇总**不新增事件类型**：只读 presence spec 的 `meta presence:<dk>:<mode>:<minutes>:<count>`，在 `derive` 里解析成 `presenceRecent`；`her_recall` / 成长门仍然跳过 meta。
- `deriveSelf` 的 belief 循环忽略 `person_note`。

### 10.2 兼容性

- 新代码读 v3 事件：`person_note` 不存在，`model.ownerFacts=[]`，行为与现在一致。
- 旧代码读 v4 事件：`readEvents` 会按 `newer` 跳过 `person_note`；不会崩，但看不到人物档案。部署时先升级 dsh-fish，再写 `person_note`。
- 备份：`backup.js` 的 schema 检查会自动拒绝旧代码恢复 v4 备份；新代码可以恢复 v3。
- 事件流不迁移、不重排、不删除。

### 10.3 旧事件补写

见 5.2。建议顺序：

1. 先部署 schema v4 代码（不写任何 `person_note`）；
2. 验证 `node --test` 和线上启动；
3. 运行 dry-run 迁移脚本，检查目标事件和将写入的 note；
4. 用户批准后追加；
5. 验证 `fish:owner` 在 web/wx 出现，bili/qq 不出现。

---

## 11. 可观测性

### 11.1 `/memory` 增加

```js
people: {
  ownerFacts: [{ id, channel, label, text, at, sourceEventId }],
  notesByChat: { [chatId]: [{ id, person, kind, text, at, superseded }] },
  counts: { ownerFacts, personNotes, activePersonNotes },
  presence: { enabled, lastAt, lastSummary } // 可选，仅当 provider 在
}
```

### 11.2 设置页

“记忆”页新增“人物”卡片：

- owner 身份事实列表（渠道、别名、来源、时间）；
- 每个微信会话的笔记数；
- 可展开看某条笔记的原文和 `refs`；
- “标记为他的身份事实”按钮（可选，见 5.3）；
- 屏幕上下文开关状态（只读，由屏幕陪伴控制）。

### 11.3 自检

`selfcheck` 增加：

- schema 版本是否为 4；
- `person_note` 条数、孤儿 `refs` 数；
- owner facts 是否能在 web/wx 渲染；
- `fish:owner` / `fish:people` 是否挂上；
- 屏幕 provider 是否过期/异常（仅当开启）。

---

## 12. 测试与验收

### 12.1 单元测试

- `schema.test.mjs`：
  - `person_note` 合法/非法；
  - `person` 必填字段；
  - `chatId` 对 impression/interaction 必填；
  - `refs/supersedes/revokes` 存在性；
  - v3/v4 兼容。
- `derive.test.mjs`：
  - `person_note` 不进入 beliefs/facts/needs/gates；
  - `ownerFacts` 提取、去重、最新优先；
  - `supersedes` / `revokes` 过滤；
  - `personNotesByChat` 只含对应 chat。
- `cross-channel.test.mjs`：
  - 现有 redaction 不变；
  - owner facts 不经过 `crossChannel`（由 `fish:owner` 直接渲染）。
- `recall`：
  - web/wx 能翻到 owner facts；
  - 群 notes 只在当前 chat；
  - bili/qq 翻不到。
- `prompt`：
  - `fish:owner` 在 web/wx 渲染，bili/qq 空；
  - `fish:people` 只在 wx 的当前 chat 渲染，别的 chat 空；
  - 预算截断、空数据不输出标题。
- `context-service`：
  - provide/render/TTL/surface/order；
  - provider 抛错不影响其他段；
  - 关闭后立即消失；
  - 总长截断。
- 迁移脚本：
  - 幂等；dry-run 不写；重复运行不重复追加。

### 12.2 集成测试

- 用 11-12 的真实事件 fixture：
  - 迁移后 `fish:owner` 在 web/wx 含 `cat不到flag的cat`；
  - bili/qq 空；
  - `her_recall` 在 wx 能翻到；
  - 全局身份文档仍然去引用化（保持现状）。
- 群 notes：
  - 当前群渲染 qiuzh 的笔记；
  - 另一个群不渲染；
  - 私聊不渲染群笔记。
- 屏幕 provider：
  - 注册后 web/wx 出现“他现在在做什么”；
  - TTL 过期后消失；
  - bili/qq 不出现；
  - provider 内容不含原始 OCR（测试夹具检查）。

### 12.3 验收标准

- 在微信私聊里问她“`cat不到flag的cat` 是谁”，她能答“是老哥/是他”。
- 在网页会话里问同一个问题，她能答。
- 在 B 站会话里问，她不会知道这个别名（或说“这个我不清楚”）。
- 某个群里的笔记只在那个群出现，换一个群看不到。
- `person_note` 不改变她的 belief 数、成长门、开悟证据、日报引用。
- `node --test` 全绿；线上启动无 `person_note` 相关报错。
- 事件流没有删除/重排/迁移；新 meta/事件可被旧版本安全忽略。

---

## 13. 分阶段落地

### Phase 1：owner 身份事实（先救 11-12）

- schema v4 + `person_note` 类型；
- `growth_commit` 支持 `person_note`；
- `fish:owner`（web/wx）；
- 迁移 11-12 旧事件；
- 测试 owner 渲染/召回/隐私边界。

### Phase 2：群/私聊人物笔记

- `fish:people`（当前 wx 会话）；
- dsh-wx 暴露 `peopleForChat` / `chatParticipants`；
- `person_note` 的 `impression` / `interaction`；
- 观测台“人物”卡片。

### Phase 3：`fish:owner` 扩展点 + 屏幕陪伴

- `fishCore.context` provider registry；
- presence 注册 `screen-activity`，`surfaces: ['web','wx','screen']`；
- 独立小会话的 cwd `home/screen`、面 `screen`、`fish:presence` 处境段；
- `screen` 加入 `SURFACES`（presence 侧改）和 `fish:owner.surfaces`（本文改）；
- `recall` 增加 `screen` 分支：放行 owner facts，不放行群/私聊 notes；
- **home 的 presence 汇总**：解析 `meta presence:<dk>:<mode>:<minutes>:<count>` → `presenceRecent` → `home/他这几天.md` → `fish:owner` 仅 web 渲染；`persona.js` 的冷落句**不在 Phase 3 默认范围**，等多通道 absence 口径确认后再做；
- 先等对方完成 ddagrab / CapFrameX / 可读性测试，再做联调；
- 默认关闭，开关指示；敏感窗口黑名单。

### Phase 4：跨通道别名与稳定 ID

- `people.json` 增加稳定 `id`（如果 Phase 2 发现 `key` 合并有问题）；
- QQ / B 站别名；
- 名册合并的 note 迁移；
- 观测台的合并/撤销操作。

---

## 14. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| `people.json` 的 `key` 会因合并变化 | Phase 4 加稳定 `id`；旧 note 按 `name+chatId` 兜底 |
| 群笔记太多，提示段膨胀 | 只给有过互动的人；最多 6 人/600 字；按最近更新排序 |
| 同名不同人 | 精确/唯一前缀规则；拿不准不合并；只写“没对上” |
| owner 事实泄露到公开面 | `surfaces=['web','wx']`；bili/qq 返回空；测试覆盖 |
| 她的 `person_note` 被提示注入 | `person.id/kind` 走 schema 校验；不信任外来文本；只写她自己的摘要 |
| 屏幕 provider 变成监视 | 默认关闭；不读文字；敏感窗口黑名单；TTL；可见开关；不写事件 |
| 独立小会话拿不到身份段 | cwd 放在 `home/screen`；`isHerAgent` 认子目录；`screen` 面由 `surface.reserve` 登记 |
| schema v4 旧备份不兼容 | 升级顺序：先代码后写事件；备份检查已有 |
| 迁移脚本写错 | 默认 dry-run；幂等；用户批准；打印将写入内容 |

**开放问题：**

1. `person_note` 是否直接进 `HER_TYPES`，还是先只允许系统侧写、她用 `growth_commit` 的独立 `type`？本文倾向加入 `HER_TYPES`，但需要工具说明和 guard。
2. `people.json` 是否加稳定 `id`，还是继续用 `key`？
3. 群笔记是否要显示“最近 N 次”的计数，还是只显示她的印象？本文建议显示计数，但只限当前会话。
4. presence v1 新增 `screen` 面（presence 侧改 `surface.js` / `tool-policy.js`）；本文 Phase 3 把 `screen` 加进 `fish:owner.surfaces` 和 `recall` 的 `screen` 分支。`screen` 是 surface，channel 仍为 `web`。
5. 屏幕陪伴的“说一句”是否允许写 `person_note`？本文建议不自动写，只有她明确决定记。
6. owner 事实是否需要支持多个 owner（例如“老哥”和“另一个朋友”）？当前系统是单 owner，暂不支持。
7. 人物笔记是否需要进入日报/备份？本文建议进入备份（事件流的一部分），不进入日报。

---

## 15. 文件清单

### 15.1 新增

| 文件 | 作用 |
|---|---|
| `src/dsh-fish/lib/context-service.js` | `fishCore.context` provider 注册表（Phase 3） |
| `src/dsh-fish/lib/presence-view.js` | `presenceRecent` → `home/他这几天.md` 的纯渲染（Phase 3） |
| `src/dsh-fish/lib/people-view.js` | `fish:owner` / `fish:people` 的渲染纯函数 |
| `src/dsh-fish/test/person-note.test.mjs` | `person_note` schema/derive/recall |
| `src/dsh-fish/test/people-view.test.mjs` | 按面渲染、预算、去重 |
| `src/dsh-fish/test/context-service.test.mjs` | provider TTL/surface/order |
| `scripts/append-owner-fact.mjs` | 旧事件补写（dry-run + 幂等） |

### 15.2 修改

| 文件 | 修改 |
|---|---|
| `src/dsh-fish/lib/schema.js` | v4、`person_note`、`person` 校验 |
| `src/dsh-fish/lib/capture.js` | `growth_commit` 的 `person_note` 分支 |
| `src/dsh-fish/lib/derive.js` | 收集 `personNotes/ownerFacts`、supersedes/revokes；Phase 3 解析 `presenceRecent`；不影响成长 |
| `src/dsh-fish/lib/persona.js` | 待定：多通道 absence 口径确认后再决定是否加 presence 分支；不在 Phase 3 默认范围 |
| `src/dsh-fish/lib/recall.js` | web/wx/screen 放行 owner facts；群 notes 按 chatId；screen 不放行 group notes |
| `src/dsh-fish/lib/identity.js` | 挂 `fish:owner` / `fish:people` |
| `src/dsh-fish/lib/memory-service.js` | `REFRESH_TYPES` 加 `person_note` |
| `src/dsh-fish/lib/observe.js` | `/memory` 人物状态；可选标记接口 |

> `surface.js` 的 `SURFACES` 和 `tool-policy.js` 的 `screen` / `presence_speak` 条目由 presence spec 改；本文不碰这两处，也没有未提交改动。presence 不改 `restrict.js`。
| `src/dsh-fish/lib/client.js` | 设置页“人物”卡片 |
| `src/dsh-fish/lib/index.js` | 暴露 `fishCore.context`（Phase 3） |
| `src/dsh-wx/lib/people.js` | 暴露 `peopleForChat` / `resolvePerson`（只读） |
| `src/dsh-wx/lib/summaries.js` | 暴露 `chatParticipants`（只读） |
| `src/dsh-wx/lib/index.js` | 把上述窄接口挂到 `wx` 服务 |

### 15.3 不改

- 全局身份文档的去引用化逻辑（`selfdoc.js` / `crossChannel`）。
- `people.json` 的现有身份规则（只增不删、精确优先）。
- 成长门、事件目录、日报格式。
- 历史事件、日记、报告。

---

## 16. 附录：现有数据结构

### 16.1 `people.json`

```json
{
  "version": 1,
  "people": [
    {
      "key": "qiuzh",
      "display": "qiuzh",
      "aliases": [],
      "chats": ["c_7c55c2507c92"],
      "sources": ["preview", "ocr"],
      "firstSeenAt": "2026-11-03T08:13:28.201Z",
      "lastSeenAt": "2026-11-13T05:35:39.685Z"
    }
  ]
}
```

### 16.2 `directory.json` 会话

```json
{
  "chatId": "c_7c55c2507c92",
  "displayName": "我需要重新集结部队",
  "kind": "group",
  "lastSender": "qiuzh",
  "lastPreview": "qiuzh: [Video] 暴雷新版本Q是有bug吗？",
  "firstSeenAt": "2026-11-03T08:13:28.201Z",
  "lastSeenAt": "2026-11-13T05:50:47.667Z"
}
```

### 16.3 `summaries` 参与者

```json
{
  "participants": [
    { "name": "qiuzh", "count": 12 },
    { "name": "Tina Yu", "count": 3 }
  ]
}
```

### 16.4 11-12 旧事件

```json
{
  "id": "ev_01M77HQ4TDZJT4SJMQ49JP8RNH",
  "v": 3,
  "ts": "2026-11-12T09:34:13.325Z",
  "type": "utterance",
  "source": "tool",
  "channel": "web",
  "surface": "web",
  "text": "老哥说，他有时候在微信找我，用的那个私聊名是「cat不到flag的cat」。记下来：那个名字是他，别的名字不是。以后在那条会话里说话，就照跟他说话来，不端着。"
}
```

### 16.5 迁移后的 note

```json
{
  "type": "person_note",
  "text": "微信私聊名「cat不到flag的cat」是他，别的名字不是。以后在那条会话里说话，就照跟他说话来，不端着。",
  "person": {
    "id": "owner",
    "name": "老哥",
    "label": "cat不到flag的cat",
    "channel": "wx",
    "chatId": "",
    "kind": "identity",
    "confidence": "high"
  },
  "refs": ["ev_01M77HQ4TDZJT4SJMQ49JP8RNH"],
  "flags": ["identity"],
  "source": "system"
}
```

### 16.6 presence 汇总 meta

presence 在每次模式 stop / 自动 stop 时写（沉默也写）：

```text
meta presence:2026-11-13:work:180:0
meta presence:2026-11-13:event:40:2
```

解析：`presence:<dk>:<mode>:<minutes>:<count>`。`mode` 是 `work|event|ambient`；`count` 是这次模式里 `presence_speak` 的条数（0 也写），汇总展示时不用。`dk` 用这一段开始时本地日期，跨零点不拆到两天；`minutes` 是该段 active 整数分钟，不足 1 分钟按 1，少于 30 秒且 0 评论可跳过。用户关闭、切模式、自动停止、dispose 都写；切模式会写多条，`derive` 按天 + mode 聚合，生成 `presenceRecent`。不含屏幕文字/应用名/窗口标题/进程名。
