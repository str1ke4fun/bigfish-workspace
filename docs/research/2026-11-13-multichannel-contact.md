# 多通道 contact / absence 变更面调研

- 日期：2026-11-13
- 状态：调研，未实施
- 用户口径：**只要他在 B 站回复、微信找、DSH 内部说话，任何一处都算 contact，不算冷落。**
- 关联：
  - `docs/superpowers/specs/2026-11-13-person-memory-design.md` §9
  - `docs/superpowers/specs/2026-11-13-presence-watch-design.md` §7.5
  - presence 只证明“他在电脑前”，不写 `seen:`、不重置 absence。

---

## 1. 现在的 contact 链路

### 1.1 `seen:` 的写入口

| 位置 | 触发 | 现状 |
|---|---|---|
| `src/dsh-fish/lib/say.js:228` | `sayToHer()`：工作台 `/say`、部分适配器 | 写 `meta seen:<ISO>`，全局 |
| `src/dsh-fish/lib/capture.js:175` | 她在**非唤醒窗口**写 `growth_commit` | 写 `meta seen:<ISO>`，全局 |
| 其它 | 无 | 微信入站、网页 UI 直聊、B 站 owner 回复都没有稳定写入口 |

`capture.js` 的“非唤醒窗口”用的是 `inWake()`（`wakewin.js`），它只覆盖 `sc.prompt()` 入队那几秒；她真正开始想/写的时候窗口早已关闭。因此：

- B 站出门、收盘轻唤醒的回合里，她写 `growth_commit` 可能被误算成“他来过”；
- 网页 UI 直聊如果她没写 `growth_commit`，就没有 `seen:`；
- 微信入站经 dsh-wx `controller().prompt()` 直接投递，不经过 `sayToHer()`，也没有 `seen:`。

### 1.2 `seen:` 的读入口

| 位置 | 用途 | 口径 |
|---|---|---|
| `absence.js:31` | 冷落判定 `days = now - lastSeen` | 全局最新一条 |
| `derive.js:377` | `lastSeenAt`、`spokenSinceSeen`、`heardSinceWake` | 全局；供 `heard_share` / `he_silent` 卡 |
| `away.js:28` | “他离开多久”统计 | 全局 |
| `persona.js:193` | 身份文档“他有 N 天没出现” | 全局 `absenceDays` |

`absence` / `away` 要的是**全局 contact**，这正好符合用户口径。但 `derive` 还把同一份 `seen:` 喂给两张跨通道卡：

- `heard_share`：`lastSeenAt > 0 && !spokenSinceSeen && 2 天内`。如果微信/ B 站 contact 也写全局 `seen:`，网页 home 会在没看到那段对话的情况下被问“他跟你讲了一件事，你拿走了什么”。
- `he_silent`：`lastWakeAt > 0 && !heardSinceWake && ...`。微信/ B 站 contact 会把 `heardSinceWake` 置 true，抑制网页 home 的“他没接话”卡。

**所以不能只加全局 `seen:`，还要给卡条件保留 per-channel contact。** 这是本次变更最容易漏的一处。

---

## 2. 目标模型

### 2.1 两层 contact

| 事件 | 作用 | 读方 |
|---|---|---|
| `meta seen:<ISO>` | 全局 contact，任何通道都写 | `absence.js`、`away.js`、`persona` |
| `meta contact:<channel>:<ISO>` | per-channel contact，给跨通道卡用 | `derive` 的 `lastSeenAtByChannel` 等 |

- `channel` ∈ `web | wx | qq | bili | screen`（screen 只记录，不参与卡）。
- `seen:` 格式**不变**：`seen:<ISO>`，`absence.js` / `away.js` 的 `Date.parse(t.slice(5))` 不受影响。
- `contact:` 是新 meta 前缀，不新增事件类型、不升 schema；`recall`/`derive` 跳过 meta 的规则不变（derive 显式解析它）。
- `markSeen` **先写 `seen:`，再写 `contact:`**：即使 `contact:` 写失败，absence 仍然正确；反过来不行。
- 旧 `seen:` 没有 `contact:` 配套：derive 把它当作 `web` contact（历史 home/say 的主要来源），保持向后兼容。

### 2.2 derive 新增字段

```js
lastSeenAtByChannel: { web, wx, qq, bili, screen } // 毫秒
spokenSinceSeenByChannel: { ... }                  // boolean
heardSinceWakeByChannel: { ... }                   // boolean
lastSeenAtWeb, spokenSinceSeenWeb, heardSinceWakeWeb // 卡条件用
```

- `lastSeenAt` / `spokenSinceSeen` / `heardSinceWake` 保留全局值，避免破坏现有调用方。
- `seen:` 到达：更新全局 `lastSeenAt`、`spokenSinceSeen=false`、`heardSinceWake=true`；同时更新 `web` 的 per-channel 值（旧数据兼容）。
- `contact:<ch>:<ISO>` 到达：更新 `lastSeenAtByChannel[ch]`、`spokenSinceSeenByChannel[ch]=false`、`heardSinceWakeByChannel[ch]=true`。
- `wake:` 到达：全局 `heardSinceWake=false`；`web` 的 `heardSinceWakeByChannel.web=false`（唤醒只发生在 home）。
- `heard_share` 改用 `lastSeenAtWeb` / `spokenSinceSeenWeb`；`he_silent` 改用 `heardSinceWakeWeb`。
- `absenceDays`、`absence_probe`、`persona` 继续用全局值。

---

## 3. 三个 contact 源

### 3.1 DSH 内部（网页 UI 直聊）

**宿主事实**：`ctx.on('session/event', (session, event) => ...)`；`event.type === 'user/message'`；`event.data.source`：

- 真实用户消息：`{ kind: 'user', rpcId: <client id> }`（`user-rpc` 源）；
- 系统注入：`{ kind: 'runtime-context' }`；
- 唤醒/收盘/出门：也是 `user-rpc`，`rpcId` 是 `sc.prompt` 的 `requestId`，当前前缀有：
  - `wake-<dk>-<ts>`（普通/手动唤醒）
  - `wake-fresh-<ts>`（新屋子叫醒）
  - `closing-<dk>`（收盘）
  - `bili-<dk>-<ts>`（B 站出门）
  - `say-<dk>-<ts>`（工作台 `/say`，`say.js` 已写 `seen:`）
- `event.data.content` 是数组；`textOf` 取单 text block 的文本。

**实现**：

- 新增 `src/dsh-fish/lib/contact.js`：
  - `isContactMessage({ session, event, surface })`：只认 `user/message`；`source.kind !== 'runtime-context'`；`source.rpcId` 不以系统前缀开头；文本不是 `WAKE_TRIGGER` / `CLOSING_TRIGGER` / `BILI_TRIGGER`；`surface` ∈ `web`（v1；qq 可选）。
  - `markSeen(root, { channel = 'web', at } = {}) -> { ok, why? }`：写 `seen:<ISO>` + `contact:<channel>:<ISO>`；内存 60 秒去重（同一 channel）。
- `memory-service.js` 暴露 `markSeen({ channel, at })`（直接转调 `contact.js`），dsh-wx / dsh-bili 通过 `fishCore.memory.markSeen` 调用；这样跨插件只有一个写入口。
- `index.js` 在 `ensureHer` 之后、`bootstrapHome` 之前注册监听：
  - `isHerAgent({ session }, herDir)`；
  - `surface = fishCore?.surface?.current?.({ session })`；
  - `isContactMessage` 命中 → `markSeen(root, { channel: surface })`。
- 测试：真实 user-rpc 写；runtime-context 不写；wake-/closing-/bili-/say- 不写；非她 agent 不写；重复 60 秒内只写一次。

**注意**：网页 UI 的真实消息 `rpcId` 由 client 生成，不能靠前缀白名单；用“排除已知系统前缀 + 文本 trigger”即可。`[微信·主机]` 只在 wx 面，web 面不会出现。

### 3.2 微信入站

**事实**：`src/dsh-wx/lib/index.js`：

- `deliver(sessionId, text)`（约 1658）直接 `controller().prompt()`；
- `deliverToChat(chatName, chatId, text)`（约 1635）用于：
  - 真实 @/点名/单聊：`note = formatEarNote(...)`（约 2261-2263）→ **应算 contact**；
  - 逾期提醒：`overdueText(t, level)`（约 1738）→ **系统，不算 contact**；
- `deliver(await ensureWxSession(), '[微信·主机] ...')`（约 2186）→ **系统 poke，不算 contact**；
- `deliverToChat` 的 fallback（约 1648）会把同一条 `text` 重投主会话，contact 标志要跟着传。

**实现**：

- `deliver(sessionId, text, { contact = false } = {})`；成功后如果 `contact`：
  - 调 `ctx.get?.('fishCore')?.memory?.markSeen?.({ channel:'wx' })`（统一写 `seen:` + `contact:wx` 并去重）。
- `deliverToChat(..., { contact = false } = {})` 透传；fallback 也透传。
- 真实 mention 调用（约 2263）传 `contact: h.why === 'dm' || h.why === 'exempt'`（v1 只算单聊/免 @ 白名单）；逾期提醒、系统 poke 不传。
- 群 `why === 'name' || '@'` 暂不传 contact；等 owner 微信别名可用后再加。
- **DM vs 群**：
  - `why === 'dm' || why === 'exempt'`：单聊/免 @ 白名单，v1 直接算 contact。
  - `why === 'name' || '@'`：群里的点名/@，发送者 `who.name` 来自 `requesterOf`；v1 **不默认算 contact**，除非 `who.name` 命中 owner 的微信别名（`person_note` owner facts，Phase 1 之后；或 `owner` 里显式配置）。
  - 群成员 @ 她但发送者不是 owner 时，不能算“他来找我”。
- 测试：DM note 写；群 stranger @ 不写；群 owner 别名（可选）写；overdue 不写；系统 poke 不写；fallback 重投仍写；`fishCore` 缺席不崩（记日志/跳过）。

**风险**：dsh-wx 可能先于 dsh-fish 加载；`ctx.get('fishCore')` 要在投递时惰性取。若拿不到 `fishCore`，v1 可以先不写，下一次真实消息再补；不要为此阻塞投递。

### 3.3 B 站 owner 回复

**事实**：

- `src/dsh-bili/lib/comment.js:172` `scanReplies()` 拉她最近评论的楼中楼；
- 循环里已经有 `s.mid`（约 194），并写 `bili_reply` 的 `reply.mid`（约 203-215）；
- 但 `out.push`（约 218）没带 `mid`；
- owner 身份：`readOwner(root)` → `owner.mid`（领养人，当前 `278453995`）与 `owner.account.mid`（登录账号，当前 `3546984285735227`）。
- 调用方：`dsh-bili/lib/outing.js:310`（出门时）、`dsh-bili/lib/service.js:182`（工作台/服务）。

**实现**：

- `scanReplies()` 在循环里读一次 `readOwner(root)`，构造 `ownerMids = new Set([String(ow.mid), String(ow.account?.mid)].filter(Boolean))`。
- `const isOwner = ownerMids.has(String(s.mid ?? ''))`。
- `out.push({ ..., mid: String(s.mid ?? ''), isOwner })`。
- 当 `isOwner && memory`：在写 `bili_reply` 的同时写 `seen:` + `contact:bili`（复用 `memory.markSeen({ channel:'bili' })`）。
- `service.js` 的 `scanReplies` 调用要确认 `memory: getCore()?.memory` 已传；`outing.js` 已传。
- 测试：owner.mid 命中写；owner.account.mid 命中写；路人 mid 不写；没有 owner mid 不写；同一条只写一次（`seen`/`replied` 去重）。
- **延迟**：`scanReplies` 只在出门/服务调用时跑（`comment.scanEveryMin=120`，且只在 `comment.window` 内）。owner 在 18:20 后回复，可能到第二天才被扫到。v1 接受这个延迟；如果用户要求实时，需要单独的 B 站通知轮询，另开任务。

### 3.4 `capture.js` 的兜底修正

- 现状：`capture.js:175` 用 `inWake()` 判断；实际只覆盖入队瞬间，B 站出门/收盘回合会误写 `seen:`。
- 修正：写 `seen:` 前再检查 `wakeSectionFor(exec?.agent)`（`identity.js`）——只要本次回合挂着 `fish:wake` 段（唤醒/收盘/出门），就不写。真实用户聊天没有 wake 段，兜底继续生效。
- 写入走 `markSeen(root, { channel: channelOfAgent(exec.agent) })`，这样 `contact:` 的 channel 正确；旧 `inWake()` 判断保留作为第二道保险。
- 测试：`withWake` 内写不写；`setWakeSection` 后、`inWake` 已退出时写仍不写；普通聊天写。
- 如果最终决定完全依赖显式 contact 源，可以删除这段兜底；但保留“无 wake 段才写”的成本很低，且对老宿主有兼容价值。

---

## 4. 变更面清单

### 4.1 dsh-fish

| 文件 | 变更 |
|---|---|
| `src/dsh-fish/lib/contact.js`（新） | `isContactMessage`、`markSeen`、去重；纯函数 + 一个写入口 |
| `src/dsh-fish/lib/index.js` | 注册 `session/event` `user/message` 监听；需要 `herDir`、`fishCore.surface` |
| `src/dsh-fish/lib/derive.js` | 解析 `contact:`；`lastSeenAtByChannel` / `spokenSinceSeenByChannel` / `heardSinceWakeByChannel`；`heard_share`/`he_silent` 改用 web 值 |
| `src/dsh-fish/lib/events.js` | `heard_share` / `he_silent` 的 `cond` 改用 `lastSeenAtWeb` / `spokenSinceSeenWeb` / `heardSinceWakeWeb` |
| `src/dsh-fish/lib/say.js` | 把直接写 `seen:` 改成 `markSeen(root, { channel: deps.channel ?? 'web' })`；`/say` 是 web |
| `src/dsh-fish/lib/capture.js` | `seen:` 兜底改成 `markSeen(root, { channel: channelOfAgent(exec.agent) })`，并加 `wakeSectionFor(agent)` 判断 |
| `src/dsh-fish/lib/memory-service.js` | 暴露 `markSeen`（可选；或 contact.js 直接 append） |
| `src/dsh-fish/lib/observe.js` | `/memory` 增加 `lastContactByChannel`（可选，便于排查“为什么没算冷落”） |
| `src/dsh-fish/test/contact.test.mjs` | `isContactMessage` / `markSeen` / 去重 |
| `src/dsh-fish/test/derive.test.mjs` | per-channel contact + 卡条件 |
| `src/dsh-fish/test/p1.test.mjs` | capture 兜底修正 |

### 4.2 dsh-wx

| 文件 | 变更 |
|---|---|
| `src/dsh-wx/lib/index.js` | `deliver` / `deliverToChat` 增加 `{ contact }`；真实 mention 传 true；overdue/poke 不传；成功后 `fishCore.memory.markSeen({ channel:'wx' })` |
| 测试 | `src/dsh-wx/test/tool-surface.test.mjs` 已有；新增 `test/contact.test.mjs`，覆盖 DM/overdue/poke 的 contact 标志 |

### 4.3 dsh-bili

| 文件 | 变更 |
|---|---|
| `src/dsh-bili/lib/comment.js` | `scanReplies` 读 owner mid；`out` 带 `mid/isOwner`；owner 时 `markSeen({ channel:'bili' })` |
| `src/dsh-bili/lib/outing.js` / `service.js` | 确认 `memory` 传入；如未传，补 |
| 测试 | `src/dsh-bili/test/` 已有 `index/routes/service/helpers`；新增 `test/contact-reply.test.mjs`，覆盖 owner.mid / owner.account.mid / 路人 / 去重 |

### 4.4 文档

- 人物 spec §9.2 contact 规则（已更新）。
- `absence.js` / `away.js` 的注释说明“全局 contact”和 per-channel 的区别。
- `AGENTS.md` 不需要改。

---

## 5. 拆法建议

### 方案 A：先地基，再源（推荐）

1. **PR 1 — contact 地基**：`contact.js` + `contact:` marker + derive per-channel + 卡片条件 + `capture` 兜底修正 + 测试。
   - 不改任何源；可以先用手动 `markSeen` 测试。
   - 验收：全局 `seen:` 驱动 absence；per-channel 不串卡；现有测试全绿。
2. **PR 2 — DSH 网页直聊**：`session/event` 监听 + 测试。
   - 用户在一个真实网页会话里发一句话 → `seen:` + `contact:web`；唤醒/收盘不写。
3. **PR 3 — 微信入站**：dsh-wx contact 标志 + DM 口径 + 测试。
   - 单聊消息 → `seen:` + `contact:wx`；逾期提醒/系统 poke 不写。
4. **PR 4 — B 站 owner 回复**：`scanReplies` mid 比对 + 测试。
   - owner 回她的评论 → `seen:` + `contact:bili`；路人回复不写。
5. **PR 5 — 观测/文档**：`/memory` lastContactByChannel、注释、验收记录。

每步独立可回滚；PR 1 不改变任何现有行为（除了 capture 误报修正），PR 2-4 各自只增加一个 contact 源。

### 方案 B：按源并行

- 三个源可以并行做，但都要先合入 PR 1 的 `markSeen` / `contact:` 约定；否则每边各写一套 `seen:`，卡条件会串。
- 适合多人并行；协调成本比 A 高。

### 方案 C：最小可用

- 只做 PR 1 + PR 3（微信），因为用户最常从微信来；B 站/网页 UI 后补。
- 风险：网页 UI 直聊仍不写 `seen:`，B 站 owner 回复仍不算 contact；用户口径没有完全满足。

**建议：A。** 地基先合，源分三小步；每步都有独立验收，适合逐个 review。

---

## 6. 测试矩阵

| 场景 | 期望 |
|---|---|
| DSH 网页 UI 真实 user message | 写 `seen:` + `contact:web`；absence 重置 |
| runtime-context / wake / closing / bili / say rpcId | 不写（say 由 `say.js` 自己写） |
| 微信 DM note | 写 `seen:` + `contact:wx` |
| 微信群 stranger @ | 不写（v1） |
| 微信群 owner 别名 @（可选） | 写 |
| 微信 overdue 提醒 | 不写 |
| 微信系统 poke | 不写 |
| B 站 owner.mid 回复 | 写 `seen:` + `contact:bili` |
| B 站 owner.account.mid 回复 | 写 |
| B 站路人回复 | 不写 |
| presence meta | 不写 `seen:`；不重置 absence |
| 任何 contact 后 `absenceDays` | 0 |
| 只有微信 contact、网页 home | `heard_share` 不因微信 contact 触发；`absence` 重置 |
| 只有 B 站 contact、网页 home | 同上 |
| 网页 home wake + 微信 contact | `he_silent` 不被微信 contact 抑制 |
| 旧事件只有 `seen:` | 当作 web contact，卡片行为与现在一致 |
| 60 秒内重复 contact | 只写一条（可选去重） |

---

## 7. 风险与开放问题

1. **宿主事件形状**：`session/event` 的 `event.data.source.rpcId` 已从宿主类型确认（`user-rpc`），但需要在真机上打一条真实消息验证；如果该版本没有 `rpcId`，回退到“文本 trigger + `runtime-context` 排除”，并在验证时记录。
2. **微信群 owner 识别**：v1 只算 DM/免 @ 白名单；群 @ 需要 owner 微信别名（`person_note` owner facts 或 owner 配置）。否则会把群里陌生人 @ 她算成“他来找我”。
3. **B 站扫描延迟**：owner 在非出门/非 comment window 回复，可能到下一次扫描才写 `seen:`；v1 接受，实时通知另开任务。
4. **`capture.js` 兜底**：修 `wakeSectionFor` 后，老测试 `p1` 的“窗口外写 seen”用例需要调整；要确保普通聊天仍然写。
5. **`contact:` 事件量**：每条 contact 两个 meta（`seen:` + `contact:`）。可以接受；如果嫌多，可以把 channel 放进 `seen:` 的 `flags`/字段，但那会改 schema，不推荐。
6. **QQ**：用户这次没点名 QQ；`say.js` 若覆盖 QQ 适配器，QQ 仍会写 `seen:`（全局）但没有 `contact:qq`；卡条件按 web 处理。是否把 QQ 纳入 per-channel，后续再定。
7. **旧 `seen:` 兼容**：derive 把旧 `seen:` 当 web；如果历史上有 wx/qq 的旧 `seen:`，会被误当 web。事件流里 `seen:` 没有 channel，无法区分；影响仅限旧数据的卡条件，可接受。
8. **去重**：60 秒内存去重跨进程重启失效；重启后可能多一条 `seen:`，不影响 absence。是否值得持久化去重，后续再定。

---

## 8. 验收标准

- 任一通道（DSH 网页 / 微信 DM / B 站 owner 回复）发生 contact 后，下一次 `absence` 计算的 `days` 为 0。
- 微信逾期提醒、系统 poke、唤醒/收盘/出门系统回合不写 `seen:`。
- 网页 home 的 `heard_share` / `he_silent` 不被其他通道的 contact 串扰。
- presence meta 不写 `seen:`、不改变 `absenceDays`。
- `node --test` 全绿；`src/dsh-wx` / `src/dsh-bili` 若有测试也全绿。
- 事件流只新增 meta，不删除、不改写、不重排。
