# 大肥鱼 B 站功能集成工作台——设计

- 日期：2026-11-10
- 状态：待评审
- 范围：全量（拆包 + 记忆闭环 + 工作台可视化）
- 路径：方案 A「接口先行 + 完整面插件」，分 A1 / A2 / A3 三段交付
- 上游设计：`2026-11-09-bigfish-tool-exposure-top-level-design.md`（Phase 2 / Phase 4）、`2026-11-09-bigfish-person-core-surfaces-design.md`、`2026-11-09-bigfish-tool-return-contract-design.md`

---

## 0. 摘要

B 站能力今天整包长在 `src/dsh-fish` 里：从没独立成包，`dsh-bili` 只是设计文档里的未来包。它已经按「面」拆开了判定、工具策略、台账与出门会话，但**记忆层没有对外写入口**、**工具面不能由外部插件贡献**、**调度只能有一个节拍**。这三条决定了：直接搬文件，她会「出门看东西但不记得」。

本设计先让 core 长出窄接口（`memory` / `surface.contribute` / `schedule.onTick` / `prompt` / `config.patch` / `owner`），再把十四块 B 站代码搬进新的 `src/dsh-bili`，同时把事件升到 v3（`surface` 字段 + `bili_reply`），完成「她发的评论、别人回的话、出门几次」进记忆的闭环，最后把 B 站设置页、足迹页、出门会话视图迁到插件自己的 section。

交付分三段，每段独立验收、独立回滚；A1 期间 B 站代码仍在 core，行为不变。

---

## 1. 背景与问题

### 1.1 今天的事实

- `lib/bili.js` 从首次提交 `11cfca7` 就在 `dsh-fish` 里，与 `dsh-fish-0.6.0` 的同一份文件哈希一致；`/home/str1k3/dsh-plugins` 下没有 `dsh-bili`。
- `bili` 面已经存在：`lib/surface.js`（优先级 `bili→wx→qq→web`）、`lib/core-service.js:43-48`（cwd `<root>/home/bili`）、`lib/tool-policy.js:111-137`（3 个 B 站工具 + 5 个 core 工具）。
- 出门会话已落地（`f36d6e8`）：`lib/outing.js` 幂等建/复用「大肥鱼出门 / 去 B 站」，调度器投递素材与回复。
- 工作台已有 B 站足迹页（`9793fe3`），只读。

### 1.2 三个硬约束

1. **记忆层没有对外写入口。** `fishCore` 只有 `surface` / `guard` / `config` / `tools`（`lib/core-service.js:88-98`），没有 `memory.append/read/derive/refreshSelfDoc`。拆包后 `saw`/`voice` 写不进事件流。
2. **面与策略表是 core 私有的。** `POLICY` 是冻结常量（`lib/tool-policy.js:125-137`），外部插件新增的工具进不了 `resolveAllow` / `catalog` / `her_tools`，也没有「插件贡献面策略」的接口。
3. **调度必须唯一。** 双定时器会双刷站、双写事件。`scheduler.js` 的 `running` 闸串行化了 tick；B 站必须借这个节拍，不能自起 `setInterval`。

### 1.3 今天拆到哪一步

| 层 | 已拆开的边界 | 证据 |
| --- | --- | --- |
| 面判定 | 四面 + 优先级 + 预分配 reserve | `lib/surface.js:9-80`、`lib/core-service.js:43-76` |
| 工具面 | 策略表 web 5 / wx 14+13 / qq 5+7 / bili 8 | `lib/tool-policy.js:46-137` |
| 服务边界 | `fishCore` 四组能力 | `lib/core-service.js:88-98` |
| 台账 | append-only，不进事件流 | `lib/tool-ledger.js:224-269` |
| B 站本体 | API / 选材 / 三工具 / 出门 / 风控 / 封面 / 足迹 / voices | `lib/bili.js`、`browse.js`、`browsejob.js`、`look.js`、`watch.js`、`speak.js`、`comment.js`、`outing.js`、`risk.js` 等 |
| 打包先例 | `src/dsh-wx` 的 `dsh.bundle.patch` + `cordis.patch.yml` + `ctx.provide('wx')` | `src/dsh-wx/package.json:6-18`、`lib/index.js:61-64`、`lib/reminder.js:230-240` |

**没拆开的**：`src/dsh-bili` 不存在；B 站 UI、路由、配置表单仍归 core；事件仍是 v2。

---

## 2. 目标与非目标

### 2.1 目标

1. 新增零依赖包 `src/dsh-bili`，拥有 B 站的网络、动作、素材、调度、面提示与工作台 UI。
2. `dsh-fish` 只保留人格、记忆、面判定、guard、台账与聚合状态。
3. 事件升到 v3：`surface` 字段 + `bili_reply` 一等事件；她发的评论成为 `utterance(surface='bili')`，别人的回复能被召回。
4. 工作台补齐：出门会话视图、抽帧图、台账单条、待回复正文、风控解冻，以及三个没有入口的配置键。
5. 两包各自 `node --test` 全绿；插件缺席时 core 优雅降级。

### 2.2 非目标

- 不新增人格设置入口；B 站配置仍是环境参数（`AGENTS.md` 第 2 条）。
- 不做 QQ 的调度迁移；QQ 仍按旧调度。
- 不改宿主（DSH）代码；只用现有 `ctx.tools` / `systemPrompt.section` / `webServer` / `sessionController` / `workspaceRegistry`。
- 不把 `dsh-mem` 引进来。当前「记忆层」就是 core（person core）；`dsh-wx` 里残留的可选调用已于 2026-11-12 移除。
- 不删除或重写任何历史事件；v3 只新增字段与类型。

---

## 3. 不变量（不可协商）

1. **零依赖**：两个包的 `dependencies` / `peerDependencies` / `devDependencies` 永远是 `{}`；测试只用 `node:test`。
2. **事件只追加**：`events.jsonl` 不删、不改、不重排；v3 迁移只在读路径补默认值，不回写。
3. **记忆共享、展示分面**：`channel` 决定召回范围，`surface` 只记来源与展示位置；她主动写入的内容在所有面可召回。
4. **工具可见性只由 `tool-policy` 决定**；`config.tools.allow` 仅 web 面兼容。
5. **策略只能收窄**：`contribute` 登记的工具必须在宿主已注册；不改变任何发送闸、配额与 guard。
6. **秘密不外发**：cookie/token 不进模型、投影、台账、日志；所有外来文本过 `guard.sanitizeForeign`，发评论前过 `guard.screenOutgoing`。
7. **两个包互不 import 源码**：dsh-bili 只通过 `fishCore` / `ctx.get('bili')` 与宿主服务通信。
8. **UI 文案守门词**：不出现男字旁的「他」、不出现「三道门/四道门」。

---

## 4. 目标架构

### 4.1 职责划分

| 包 | 拥有 | 不拥有 |
| --- | --- | --- |
| `dsh-fish`（person core） | 事件流与派生、人格、身份文档、记忆工具（`growth_commit` / `her_recall` / `her_leave` / `her_tools`）、面注册表、guard、台账、调度节拍、聚合状态页 | B 站网络与动作、B 站调度、B 站 UI |
| `dsh-bili` | `bili.js` 客户端、刷站/选材、`bili_look` / `bili_watch` / `bili_speak`、评论与回复扫描、风控、封面、足迹、voices、出门会话、B 站面提示段、B 站设置/足迹/出门 UI | 人格、记忆格式、其他面的工具、宿主补丁 |

### 4.2 依赖方向

```
                 ┌────────────────────────────┐
                 │           宿主 DSH           │
                 │ tools / systemPrompt / web  │
                 │ sessionController / wsReg   │
                 └───────┬────────────┬───────┘
                         │            │
        ┌────────────────▼──┐      ┌──▼─────────────────┐
        │     dsh-fish       │      │      dsh-bili      │
        │  events / derive   │◄─────┤  bili_* / browse   │
        │  persona / guard   │ 只读  │  outing / risk     │
        │  policy / ledger   │ 接口  │  UI section        │
        └────────┬───────────┘      └──┬─────────────────┘
                 │  provide('fishCore') │  provide('bili')
                 └──────────┬───────────┘
                            ▼
                 core 的「现在」页聚合状态
```

两条边：

- **core → 插件**：`ctx.get('bili')` 取聚合状态（今天刷了几条、出门几次、待回复数、风控冷却）。插件缺席返回 `null`，页面降级。
- **插件 → core**：`ctx.get('fishCore')` 用窄接口写记忆、贡献工具、挂节拍、读写处境段与配置。

### 4.3 包结构

```
src/dsh-bili/
├── package.json            # name dsh-bili，零依赖，dsh.bundle.patch
├── cordis.patch.yml        # insert: [{ id: dsh-bili, name: dsh-bili }]
├── AGENTS.md               # 继承 dsh-fish 的硬约束 + 本包边界
├── README.md
└── lib/
    ├── index.js            # apply：注册工具、路由、section、调度钩子、bili 服务
    ├── bili.js             # API 客户端、wbi 签名、cookie、风控冷却
    ├── browse.js           # 候选/黑名单/去重/深读/素材
    ├── browsejob.js        # 槽位、配额预留、后台刷站
    ├── look.js             # bili_look
    ├── watch.js            # bili_watch
    ├── speak.js            # bili_speak
    ├── comment.js          # 发评论/回楼/扫回复/去重
    ├── video.js            # ffmpeg 抽帧
    ├── ocr.js              # tesseract 识别
    ├── cover.js
    ├── history.js
    ├── footprint.js
    ├── voices.js
    ├── risk.js
    ├── outing.js           # 出门会话 + 投递
    ├── prompts.js          # B 站提示段（原 BSITE_BRIEF / LOOK_BRIEF / WATCH_RULE / SPEAK_BRIEF）
    ├── client.js           # 工作台 section（设置 / 足迹 / 出门 / 证据）
    └── observe.js          # /dsh-bili/* 路由
```

---

## 5. 接口契约

### 5.1 `fishCore.memory`（新增）

```js
fishCore.memory = {
  /**
   * 唯一写入口。内部：validateEvent → appendEvent；不抛。
   * @param {object} raw  { type, text, refs?, surface?, ... }
   * @param {{ source?, surface?, day?, stage?, channel? }} opts
   * @returns {Promise<{ ok: boolean, event?: object, why?: string }>}
   */
  append(raw, opts),

  /** 只读。includeMeta 默认 false；召回过滤仍在 core 的 her_recall。 */
  read({ since, until, types, limit = 200, includeMeta = false }),

  /** 派生模型只读快照：day/stage/beliefCount/scars/recentSaw/freshVoice/biliSaid/biliReplies。 */
  derive({ now } = {}),

  /** 写完 saw / voice / bili_reply 后刷新身份文档；失败返回 why，不抛。 */
  refreshSelfDoc(),

  /** 写前自检（面插件不复制 schema）：返回 { ok, why? }，不落盘。 */
  validate(raw, opts),
}
```

约束：

- `source` 默认 `'system'`；面插件不能以 `source:'tool'`（她自己的工具）身份写非 `HER_TYPES`。
- `surface` 只允许 `core | web | wx | qq | bili`，默认 `core`。
- `channel` 语义不变（`core | qq | wx | web`）：**共享事实一律写 `core`**，`surface` 只记来源。这样 web 的 `her_recall` 仍能翻到 B 站看到的事，符合「记忆共享、展示分面」。
- `append` 成功后按类型决定是否 `refreshSelfDoc()`：`saw` / `voice` / `bili_reply` 触发；`meta` 不触发。

### 5.2 `fishCore.surface.contribute`（扩展）

```js
fishCore.surface.contribute({
  id: 'bili',
  tools: [
    { name: 'bili_look',  summary: '看 B 站列表',     always: true, action: 'read' },
    { name: 'bili_watch', summary: '看一条视频的画面', always: true, action: 'read' },
    { name: 'bili_speak', summary: '在评论区说话',     always: true, action: 'send', gate: 'send' },
  ],
  groups: [],          // 第一版 bili 无 deferred 组
})
// → disposer；卸载时等价于 uncontribute('bili')
```

行为：

- `tool-policy.js` 的 `POLICY` 从冻结常量改为「内置表 + 贡献表」的合并视图；`resolveAllow` / `catalog` / `loadTargets` / `groupsFor` 读同一个视图。
- 贡献变更后，`restrict` 的 allow 集合、`her_tools` 的 catalog 在**下一步**重算；当前步不抖动。
- 校验：`name` 必须在宿主 `ctx.tools` 已注册，否则整次拒绝并返回 `why`；`surface` 不存在、重复名字、跨面名字一律拒绝。
- **插件缺席时**：bili 面只剩 `coreEntries('bili')` 的 5 个工具，与今天 web 面同构；不报错。

### 5.3 `fishCore.schedule.onTick`（新增）

```js
const off = fishCore.schedule.onTick({
  id: 'bili-browse',
  everyMs: 60_000,
  order: 20,                       // 默认 100，小的先跑
  fn: async ({ now, root, events }) => {},   // 返回 { changed?: boolean }
})
```

保证：

- 钩子跑在 `scheduler.js` 现有串行 tick 内（`running` 闸之后），**不新建定时器**。
- 同一钩子不会并发；抛错只记日志，不打断 tick，也不影响其他钩子。
- `everyMs` 是"至少间隔"：tick 更密时按时间戳跳过。
- core 在每次钩子后按需重读事件流（`changed: true`），供后续步骤看到新事件。

### 5.4 `fishCore.prompt`（新增，处境段原语）

```js
fishCore.prompt = {
  setWake(sessionId, text),        // 写这条会话的 fish:wake 段
  clearWake(sessionId),
  getWake(sessionId),
  withWake(fn),                    // 标记"这一轮是定时唤醒"，区分人类接触
  watchTurnEnd(sessionId, fn),     // 返回 { off }
}
```

这组是 `identity.js` / `wakewin.js` / `turnend.js` 的窄封装；B 站插件不再 import core 内部文件，也不再自己拼 section id。

### 5.5 `fishCore.config.patch`（补实现）

```js
fishCore.config.patch(partial)
// → Promise<{ ok, config, why? }>
```

- 走 `normalizeConfig` + `/config` 白名单 + 原子写；`persona` 永不在白名单。
- 键名沿用 `browse.* / video.* / comment.* / avoid.* / ui.*`，**不做重命名迁移**。
- 写入后广播 `config/changed`（宿主事件），两个包都按新值工作。

### 5.6 `fishCore.owner`（新增，最小暴露）

```js
fishCore.owner.read()   // → { mid, nickname, hasCookie, cookie }（cookie 只在进程内，永不进日志/台账）
fishCore.owner.write({ mid, nickname, cookie })  // 兼容 /owner 的现有行为
```

`dsh-bili` 发评论、回楼、看登录态都走这里；`owner.json` 仍由 core 以 `0600` 写盘，B 站插件不直接碰文件。`read()` 是否返回 cookie 原文见 §11 待决 1；若不返回原文，则由 core 提供 `fishCore.owner.client()` 的代发能力。

### 5.7 反向服务 `ctx.provide('bili')`

```js
ctx.provide('bili', {
  status(),                     // { browsedToday, outingsToday, waiting, riskUntil, lastOutingAt }
  history({ days }),
  footprint(),
  commentBody({ bvid, rpid }),
  risk(),                       // { until, code, strikes }
  wake({ focus }),              // 手动叫醒一次（开发模式复用）
})
```

core 的 `/status`、`/memory`、`/away` 通过 `ctx.get('bili')` 取插件数据；`null` 时显示「B 站插件没装上」，不抛。

### 5.8 B 站面提示段

- `dsh-bili` 用宿主现有的 `systemPrompt.section` 自己挂 `fish:bili`（order 8600），条件为 `fishCore.surface.current(agent) === 'bili'`；内容来自 `lib/prompts.js`（原 `BSITE_BRIEF` / `LOOK_BRIEF` / `WATCH_RULE` / `SPEAK_BRIEF`）。
- core 的 `selfdoc.js` 删掉 `## 上网`、`## 在网上说话`、`## 在 B 站怎么整活` 三段；`persona.js` 删掉 `bili_watch` 的说明文字。
- 理由：这些是**面策略与工具教程，不是人格**（上游设计 §10）。留在 core 会让 web 的身份文档继续背着 1700 字的 B 站教程，也让「面提示只挂当前面」失效。
- 提示段只读 `fishCore.memory.derive()` 的 `recentSaw` / `freshVoice` / `biliSaid` / `biliReplies`，不自己解析事件流。

---

## 6. 数据与事件 v3

### 6.1 schema 变更

`lib/schema.js`：

1. `EVENT_SCHEMA_VERSION` 2 → 3。
2. 新增 `surface` 字段：`'core' | 'web' | 'wx' | 'qq' | 'bili'`，默认 `'core'`。
   - 写：`raw.surface` 合法才采用。
   - 读：没有该字段的 v1/v2 事件按 `'core'` 读，不回写。
3. `ALL_TYPES` 新增 `bili_reply`（**系统侧**，不在 `HER_TYPES`，她编不出来）。
4. `bili_reply` 带一个 `reply` 子对象（与 `grant` / `refuse` 同构）：

```js
{
  type: 'bili_reply',
  source: 'system',
  surface: 'bili',
  channel: 'core',
  text: '对方回复的正文（已过 sanitizeForeign，≤2000）',
  refs: ['BV1xxxxxxxxx'],
  reply: { bvid, rpid, root, parent, user }   // 都是字符串，截断到 64
}
```

5. `channel` 白名单不变（`core | qq | wx | web`）。B 站行为一律 `channel: 'core'`，`surface: 'bili'`。

### 6.2 评论与回复的闭环

**她发评论**（`bili_speak` / `postComment` / `postReply`）：

1. 动作成功后写 `utterance`：`{ text: 实际发出的原话, surface: 'bili', channel: 'core', source: 'tool' }`（她自己的话；`bili_reply` 才是 `source:'system'`）。
   - 进 beliefs / 可召回 / 其他面看得到。
2. 保留现有 meta 记账：`comment:<dk> <bvid> <rpid>`、`creply:<dk> ...`、`cbody:<rpid> ...`（供配额、工作台正文与旧数据兼容）。
3. 动作失败或不确定：不写 `utterance`；`bili_speak` 返回 `action: confirmed | unconfirmed | failed`，投影按返回契约 §6 表达。

**别人回复她**（`scanReplies`）：

1. 每条新回复写 `bili_reply`（系统侧），`surface: 'bili'`，`reply.rpid` 是去重键。
2. 去重：扫描时先取已有 `bili_reply` 的 `reply.rpid` 集合，再并上旧数据里的 `cseen:` meta；命中就跳过。
3. `cseen:` 仍只在 `replyReply`（她真的回了）时写，保持今天的语义：**看到 ≠ 回过**。
4. `bili_reply` 可被 `her_recall` 翻到；不进 beliefs（别人的话不是她的判断），但进 `derive.facts.biliReplies` 供 B 站面展示。

**出门**：

- `biliout:<dk> browse|replies` 继续只做记账（meta），不改。
- 出门素材里的 `saw` / `voice` 由插件写，带 `surface: 'bili'`。

### 6.3 derive 与展示

`deriveSelf` 新增只读事实（不改成长门）：

- `facts.biliSaid`：最近 7 天她自己的 `utterance(surface='bili')`，最多 5 条。
- `facts.biliReplies`：最近 7 天 `bili_reply`，最多 5 条。
- `facts.recentSaw` / `freshVoice` 逻辑不变，只多一个 `surface` 供展示过滤。

展示规则：

- `her_recall` 不过滤 `surface`（一份记忆）。
- B 站面的提示段只展示 `biliSaid` / `biliReplies` / `recentSaw`；web 面不展示这三组。
- 工作台足迹页按 `surface` 标注来源，而不是把 B 站数据另存一份。

### 6.4 迁移与不可降级

- 迁移是**读路径**：v2 事件补 `surface:'core'`；不新增、不改写任何历史行。
- 备份文件头版本升到 3；恢复 v2 备份是升级，允许。
- 回退：v2 代码读 v3 会跳过并计数（`store.readEvents` 既有行为），等于看不到新事件。**回退前必须先备份**；dev 用独立 fish-home 验证。
- `CHANGELOG.md` 必须写迁移说明（`AGENTS.md` 第 5 条）。

---

## 7. 调度与会话

### 7.1 唯一节拍

- core 保持每 60 秒一次 `tick`，顺序：`detectAbsence → 钩子（按 order）→ ensureSchedule → 时间窗 → wake`。
- B 站的 `browsejob` / 出门 / 回复扫描全部挂在 `schedule.onTick` 上，**删掉 core 里对 B 站的直接调用**（`scheduler.js` 的 `backgroundBrowse` / `maybeOuting` 与相关 import）。
- 钩子内部自己判：刷站槽位（20 分钟最小间隔）、每日配额、时间段、风控冷却、回复扫描节流（`comment.scanEveryMin`）。

### 7.2 出门会话

- 归属迁到 `dsh-bili`，逻辑不变：预分配 id → `surface.reserve(id,'bili')` → `sc.create`；状态 `bili-session.json`；工作区 `<root>/home/bili`。
- 处境段通过 `fishCore.prompt.setWake(sessionId, text)` 写；`watchTurnEnd` 清同一段；90 秒兜底只清自己写的那段。
- 身份段仍由 core 挂（`isHerAgent` 认屋子子目录），插件不重复挂。

### 7.3 权限与安全

- `bili_speak` 的开关、配额、时段、`@` 规则、`guard.screenOutgoing` 全部保留；插件化不放松任何一条。
- cookie 只经 `fishCore.owner` 取，不落日志、不落台账、不进模型。
- 外来文本（标题、简介、评论、回复）一律过 `fishCore.guard.sanitizeForeign` 再进上下文或事件。

---

## 8. 工作台集成

### 8.1 UI 归属

| 页面 | 归属 | 说明 |
| --- | --- | --- |
| 「现在」状态条 / 时间线 | core | 通过 `ctx.get('bili')` 聚合；插件缺席时只显示 core 部分 |
| 「成长」「记忆」「住所」「插件」「原理」「数据」 | core | 不变 |
| 「上网」设置页 | **dsh-bili** | 全部 B 站配置迁到插件 section |
| 「B站」足迹页 | **dsh-bili** | 视频足迹、评论足迹、正文按需读取 |
| 「出门」新页 | **dsh-bili** | 见 8.2 |
| 登录卡 / 风控提示 | **dsh-bili** | 数据来自插件自己的服务 |

注册方式沿用 `lib/client.js:2418-2429` 的 `settings.section`；若宿主不提供独立 section，则退化为 core 内嵌一个只读壳，数据走 `/dsh-bili/*`（见 8.4 兼容期）。

### 8.2 新增「出门」页

- **今天**：出门次数 / 配额、最近一次出门时间、这次带了素材还是只带回复。
- **投递记录**：`biliout:` 记账 + 当次素材摘要（标题列表、回复条数），只读。
- **会话入口**：显示「去 B 站」会话 id、工作区路径、最近一轮时间；提供「现在去一趟」（调用 `bili.wake({focus:'browse'})`，仅开发模式）。
- **不做**：不提供"替她发评论"按钮（沿用 `observe.js:902-904` 的设计）。

### 8.3 证据面

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 抽帧拼图 | `GET /dsh-bili/sheet/<bvid>` | 读 `media/sheet-*.png`，只允许 `sheet-` 前缀；找不到 404 |
| 台账单条 | `GET /dsh-bili/ledger?date=&session=&tool=` | 只读，脱敏字段照旧；不提供删除 |
| 待回复正文 | `/dsh-bili/comment` 返回的 `waiting` 列表 | UI 展示正文与时间，只读 |
| 风控解冻 | `POST /dsh-bili/risk {clear:true}` | UI 加按钮，二次确认 |

### 8.4 兼容期

1. **A2 期间**：插件先挂 `/dsh-bili/*`；core 的 `/browse`、`/history`、`/footprint`、`/comment-body`、`/risk`、`/cover` 保留，内部改为 `ctx.get('bili')` 代理；插件缺席时返回 404 + 明确文案。
2. **A3 期间**：B 站 section 上线，core 的「上网」页签隐藏（不是删除）；保留一个版本周期的路由代理。
3. **A3 之后**：删除 core 里的 B 站路由与 UI 代码；core 的 `/config` 仍接受 B 站键（共用 `config.json`），但设置入口只在插件。

### 8.5 配置补全

给三个今天没有 UI 的键补控件：

- `browse.rankingTids`：0–4，说明"每次轮换几个分区榜"。
- `browse.keywords`：词条列表，说明"她额外会搜什么"。
- `video.ocr`：开关，说明"要不要认画面上的字"。

补齐 `LIMITS`：`browse.rankingTids` 加 `[0,4]`；`video.enabled` / `video.ocr` 加布尔归一化；`comment.lastScanAt` 明确为内部字段（不进 UI、不迁移）。

---

## 9. 实施分段

### A1：接口与事件（core 内，行为不变）

- 实现 `fishCore.memory`、`surface.contribute`、`schedule.onTick`、`prompt`、`config.patch`、`owner`。
- 事件 v3：`surface` + `bili_reply` + 读路径默认值；`derive` 增加 `biliSaid` / `biliReplies`。
- B 站代码仍留在 core，但改成走新接口（例如 `recordSaw` 改调 `fishCore.memory.append`，出门改调 `fishCore.prompt`）。
- 行为变化只在记忆层：评论多写一条 `utterance(surface='bili')`，别人的回复多写 `bili_reply`；**旧 meta 一条不少**。
- 验收：`node --test` 全绿；同一份 fixture 下，旧 meta 序列与 A1 前一致，新事件与旧记录一一对应（一条 `comment:` 对应一条 `utterance`，一条新回复对应一条 `bili_reply`）。

### A2：搬文件

- 建 `src/dsh-bili`，搬十四块代码与 92 个专项测试；core 删除对应文件与 import。
- 插件 `apply`：注册 3 个工具 → `surface.contribute` → 挂 `schedule.onTick` → 建/复用出门会话 → 注册 `/dsh-bili/*` → `ctx.provide('bili')`。
- 验收：两个包各自 `node --test` 全绿；独立 fish-home 上跑一天，事件流逐类对齐（`saw`/`voice`/`comment`/`creply`/`biliout`/`bili_reply` 条数与内容一致）；8710 上出门会话可复用。

### A3：工作台

- B 站 section（上网 / B站 / 出门）迁到插件；core 保留聚合与兼容代理。
- 新增证据面（抽帧图、台账、待回复、风控解冻）；补三个配置键。
- 验收：8710 上所有 B 站页面可用；停用插件后 core 页面不报错、出门会话仍在但不再被投递。

---

## 10. 测试与验收

### 10.1 单元（core）

- `memory.append`：合法/非法类型、`source:'tool'` 非 `HER_TYPES` 拒绝、`surface` 默认、`channel` 不变、写失败返回 `why` 不抛。
- `surface.contribute`：注册/撤销、未注册名字拒绝、跨面名字拒绝、策略表重算、插件缺席时 bili 只剩 5 个。
- `schedule.onTick`：串行、异常隔离、`everyMs` 节流、`changed` 触发重读。
- `prompt`：按 session 隔离、turn/end 清理、兜底只清自己那段。
- `config.patch`：白名单、`persona` 拒绝、原子写、坏值归一化。
- schema v3：v2 读成 `surface:'core'`、v3 写读往返、v2 读者跳过 v3、备份版本拒绝。

### 10.2 单元（dsh-bili）

- 现有 92 个专项测试迁移后全绿；新增 `bili_reply` 去重、回复扫描不写 `cseen`、出门投递只写自己的处境段。
- `bili.js` 补直测：`mixinKey`、`signQuery`、`normalizeCookie`、`inCooldown`、`RISK_CODES` 映射（今天没有直测）。

### 10.3 集成

- 事件对齐：同一 fixture 分别走 core 旧路径与插件新路径，比较事件类型序列与关键字段。
- 面与工具：bili 面 8 个、web 面 5 个、`her_tools` 不跨面、插件缺席时 bili 面 5 个。
- 记忆：B 站评论在 web 的 `her_recall` 可查；`bili_reply` 不出现在 beliefs。
- 兼容：插件停用后 core 的 `/status`、`/memory`、`/away` 不抛。

### 10.4 真机

- 8710：重启后日志出现「出门会话（复用）」；出门一轮里 `bili_look` / `bili_watch` 落台账；工作台「出门」页数据与日志一致。
- 8720（dev）：独立 fish-home，事件 v3 写入后不回退；确认新事件不被旧代码误读。
- 明确边界：当天刷站配额用尽时，不把"UI 能打开"当成"调度投递已验证"。

### 10.5 不算通过

- 为了拆包改事件语义、删旧字段，或让她主动写的内容在某个面不可召回。
- `contribute` 变成授权：没注册的工具被放行、发送闸跟着放松。
- 双定时器或双调度路径（日志里同分钟两次 `background browse`）。
- 插件缺席时 core 报错或页面空白。
- 把 B 站数据另存一份"插件记忆"，与 `events.jsonl` 并行。

---

## 11. 风险与待决

### 风险

| 风险 | 缓解 |
| --- | --- |
| 接口定错，两包一起改 | A1 先只做接口与迁移，B 站行为不变；接口加契约测试，A2 前冻结 |
| 事件 v3 不可降级 | 独立 fish-home 验证；发布前备份；CHANGELOG 写清回退方式 |
| UI 迁移期两套入口 | 兼容期只保留代理，不双写；A3 后删旧代码 |
| 双调度 | 只允许 `schedule.onTick`；A2 同时删除 core 的 B 站调用 |
| cookie 暴露面变大 | 只经 `fishCore.owner`；不落日志/台账/模型；台账脱敏测试 |
| 封面缓存只写不删 | 随插件迁移时补 TTL（与 `media/` 的 3 天一致）或明确"不清理" |
| `bili.js` 无直测 | A2 搬文件时补直测，先测纯函数 |

### 待决

1. `fishCore.owner.read()` 是否返回 cookie 原文，还是只返回"能发/不能发 + 登录态"。**建议**：返回原文，但只在插件进程内使用，调用点全部过 `guard.looksLikeSecret` 的日志闸。
2. B 站 section 能否独立注册，取决于宿主是否支持多 section。**建议**：先按 `settings.section` 试；不支持则退回 core 壳 + `/dsh-bili/*` 代理。
3. `bili_reply` 是否参与成长门（`beliefCount`）。**建议**：不参与，与 `voice` 一致。
4. 出门会话的宿主转录是否要在工作台展示。**建议**：A3 先只给"最近一轮时间 + 跳转会话"，不复制转录。
5. 封面缓存 TTL 是否随本次一起做。**建议**：随 A2 做 7 天 TTL，与 `media/` 的清理策略对齐。

---

## 12. 关键文件

| 文件 | 角色 |
| --- | --- |
| `src/dsh-fish/lib/core-service.js` | 新增 `memory` / `prompt` / `owner` / `config.patch` / `schedule` 入口 |
| `src/dsh-fish/lib/surface.js` | 增加 `contribute` / `uncontribute` |
| `src/dsh-fish/lib/tool-policy.js` | 内置表 + 贡献表的合并视图 |
| `src/dsh-fish/lib/scheduler.js` | 串行 tick 上执行钩子；删除 B 站调用 |
| `src/dsh-fish/lib/schema.js` | v3：`surface`、`bili_reply`、`reply` 子对象 |
| `src/dsh-fish/lib/store.js` | 读路径补 `surface:'core'`；`appendEvent` 不动 |
| `src/dsh-fish/lib/derive.js` | `biliSaid` / `biliReplies` 只读事实 |
| `src/dsh-fish/lib/identity.js` | 收口成 `prompt` 原语 |
| `src/dsh-fish/lib/selfdoc.js` / `persona.js` | 删掉 B 站三段与 `bili_watch` 说明，迁到 `dsh-bili/lib/prompts.js` |
| `src/dsh-bili/**` | 新包：十四块代码 + 工具 + 路由 + section + 调度钩子 |
| `src/dsh-fish/test/schema.test.mjs` | v3 迁移与拒读 |
| `src/dsh-fish/test/core-service.test.mjs` | 新接口契约 |
| `src/dsh-bili/test/**` | 迁移后的 92 个用例 + 新增直测 |

---

## 13. 下一步

1. 本 spec 评审通过后，用 `writing-plans` 产出 A1 的实施计划（接口 + 事件 v3）。
2. A1 合并并验证后，再为 A2 / A3 各出一份计划——不在同一份计划里跨三个包。
