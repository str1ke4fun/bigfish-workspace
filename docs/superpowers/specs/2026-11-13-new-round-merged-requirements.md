# 新一轮需求合并与一致性裁决（2026-11-13）

- 状态：合并稿，供落地使用；冲突项已按“文档 + 当前代码”裁决，开放项单列。
- 输入：
  - `docs/superpowers/specs/2026-11-13-person-memory-design.md`
  - `docs/superpowers/specs/2026-11-13-presence-watch-design.md`
  - `docs/superpowers/specs/2026-11-13-growth-self-trigger-design.md`
  - `docs/superpowers/plans/2026-11-13-person-memory.md`
  - `docs/superpowers/plans/2026-11-13-presence-watch.md`
  - `docs/superpowers/plans/2026-11-13-multichannel-contact.md`
  - `docs/research/2026-11-13-multichannel-contact.md`
- 已核对代码基线：`main@75138f0`，Node 24.21.0；`dsh-fish` 958 tests / `dsh-wx` 90 / `dsh-bili` 23，全绿。
- 本文件只裁决“这一轮怎么合、先做什么、谁改哪个文件”；不替代三份 spec 的细节。与源文档冲突时，以本文件 §2 的权威口径为准，源文档在落地时同步修订。

---

## 1. 一句话结论

这一轮不是四件独立的事：**人物记忆是数据地基，多通道 contact 是它的第一个消费者，成长自触发复用同一套派生，屏幕陪伴是最后一个消费面。** 落地顺序必须是：

1. `person_note` / schema v4 / owner facts（人物记忆 Phase 1）
2. 多通道 contact（全局 `seen:` + per-channel `contact:`）
3. 成长自触发（收盘、absence 时间线、sleep、刷站配额、stage 1 内容）
4. 屏幕陪伴 v1（screen 面、抓帧、独立小会话、工作台开关）

屏幕陪伴的 `fishCore.context` 可以提前到第 1 步之后作为小桥接实现；否则 presence v1 只能“能看能说”，主会话看不到“他正在做什么”。

---

## 2. 权威口径（D1–D18）

### D1. 管理 UI 统一落在 8788 工作台，不再改 8710 的 `client.js`

三份新设计的“设置页 / 工作台”段落都写在 `src/dsh-fish/lib/client.js`，但单入口 v2 已把 `settings.section` 注销（`client.js:2413-2426`），8788 工作台才是浏览器唯一管理入口（`workbench/README.md:3-10`）。

裁决：

- **人物记忆**：`#her/memory` 保持只读，消费 `/memory` 的新 `people` 摘要；事件类型下拉补 `person_note`（顺带补 `bili_reply`）。“标记为他的身份事实”第一版只保留 CLI，不做页面写按钮。
- **成长收盘**：`memory.closing` 放 `#system/settings` 的“记忆”组；收盘状态放 `#her/today` 或 `#system/settings` 的只读行。
- **屏幕陪伴**：新增 `#her/presence` 页面（她 → 陪伴），所有 `presence.*` 配置归这一页；BFF 新增 `presence/status`（GET，P1）与 `presence/mode`（POST，P2）。
- 工作台改版 §2.2 的“不新增插件 HTTP 路由、不改事件 schema、不改记忆召回”视为**对 v1 工作台自身的约束**；本轮新增的 `/presence/*`、schema v4、recall owner 例外是显式豁免，需在 presence/person-memory 实现时写进 CHANGELOG 与工作台说明。

### D2. schema v4 只由人物记忆线升一次；`screen` 同时进事件 schema

- `EVENT_SCHEMA_VERSION` 3 → 4，`ALL_TYPES` / `HER_TYPES` 加 `person_note`，`FLAGS` 加 `identity`。
- `schema.js` 的 `SURFACES` 是**事件来源面**（`core/web/wx/qq/bili`），与 `surface.js` 的“会话面”不是同一张表。本轮在 v4 里**同时加 `screen`**，避免 screen 会话通过 `fishCore.memory` 写事件时被 `BAD_SURFACE` 拒绝（`schema.js:245-249`）。
- `surface.js` 与 `tool-policy.js` 的 `SURFACES` 也加 `screen`；三张表同名不同层，实施时在注释里写清楚。

### D3. `screen` 是 surface，不是 channel

- presence 会话的 channel 仍按 cwd 推断为 `web`；`person_note.person.channel` 仍只允许 `wx/web/core`。
- `contact:` 的 channel 枚举保留 `screen` 作为预留，但 v1 没有任何来源写 `contact:screen`。
- presence 汇总 `meta presence:<dk>:<mode>:<minutes>:<count>` 不写 `seen:`、不写 `contact:`。

### D4. contact 两层模型

- `meta seen:<ISO>`：全局 contact，任何通道都写；`absence` / `away` / `persona` 只读它。
- `meta contact:<channel>:<ISO>`：per-channel contact，给跨通道卡用；channel ∈ `web|wx|qq|bili|screen`。
- `markSeen` 是唯一写入口：**先写 `seen:`，再写 `contact:`**；`contact:` 失败不回滚 `seen:`。
- v1 来源：DSH web 真实用户消息、微信 DM/免 @ 白名单、B 站 owner 回复。群 owner @、QQ、screen 暂不算。
- 60 秒同 channel 内存去重；重启后失效可接受。
- 旧 `seen:`（无 `contact:`）继续当 web contact 兼容。

### D5. recall 的 Phase 1 边界

- owner facts：`web` / `wx` / `screen` 放行；`bili` / `qq` 不放行。
- 非 owner 的 `person_note`：**Phase 1 一律不可 recall**（群/私聊笔记留到 Phase 2）。实现上不能只判 `person.id==='owner'` 后就 fall through 到 channel 过滤，否则 wx 会话会跨 chatId 看到别人的笔记。
- `screen` 面只放行 `core` + owner facts；**排除 `channel==='web'` 的普通事件**。否则 screen 会话会看到 web 对话，违反 §9.1 矩阵。
- 现有 B 站“channel 置空”的特例保留。

### D6. `fish:owner` 与 context 扩展的预算

采用**分层独立预算**，不再把 owner facts 与 extras 挤进同一个 300 字：

- owner 身份事实文档：≤300 字（≤5 条，按行截断，不切半个别名）。
- `fishCore.context.render` 的 extras：≤400 字（presence provider 实际只有两行，远小于此）；多个 provider 按 `order` 排序后共享 400 字。
- 最终拼接 `fish:owner` 的上限 700 字；只有极端多 provider 时才截 extras，再截 facts。
- presence provider 文本最多两行（`## 他现在在做什么` + 一句）；`get()` 同步、永不抛。
- `fishCore.context.render` 按 `section`/`surfaces` 过滤、TTL 过期不渲染、`surfaces` 显式列出。

### D7. `fishCore.context` 提前落地（桥接）

人物记忆 spec 把 context registry 放在 Phase 3；presence v1 的 provider 在它缺席时只能 no-op。为了让这一轮“主会话知道他在做什么”成立，**在人物记忆 Phase 1 之后、presence 之前实现最小 `lib/context-service.js`**：

- `provide(id, { order, surfaces, ttlMs, get })` / `remove(id)` / `render({ agent, surface, section, now })`。
- 纯内存、同步、永不抛；provider 抛错只记日志并跳过。
- 挂到 `fishCore.context`，presence `publishProvider()` 检测不到时 no-op（兼容老宿主）。

### D8. 成长参数的实例配置

- `growthDays=60`、`window=["09:30","18:20"]`、`browse.window`、`comment.window`、`wakesPerDay=1` 是**线上实例配置**，不写进 `DEFAULTS`。
- `DEFAULTS` 只新增 `memory.closing`（见 D9）。
- 配置改动与代码部署分开：先代码 + 测试，部署时再改 `~/.dsh-fish/config.json` 并重启；重启前必须取得用户同意。

### D9. 收盘任务

- `memory.closing = { enabled: true, time: '18:00', wake: true, diaryOnly: true }` 进 `DEFAULTS.memory`，并补 `normalizeConfig` 的布尔严格化与 HH:MM 回退。
- `runClosing` 必须挂在 `scheduler.tick()` 的**提前 return 之前**（或在 `finally` 里），否则无日程/窗口外时收盘永远不会跑。
- 收盘不占 `wakesPerDay` / `daily.events`，不写 `fired:`，不写 `seen:`。
- `flushMissingReports` 的“已有报告”口径统一为：**已存在则跳过，不覆盖**；只补今天和昨天。

### D10. `absenceDays` 时间线（以成长 spec §6 为唯一口径）

- `absenceDays` = **当前这次冷落已经持续几天，他回来就是 0**；不是“距最近一条 `seen:` 的天数，保持不变”。
- 新增 `absenceGapDays`（已完成的那次冷落）、`absenceBack`、`absenceBackDays`。
- `absence_probe` 条件：`absenceBack && absenceGapDays >= absenceThreshold(growthDays) && absenceBackDays <= 2`。
- `lastSeenAt` 只保留一份口径（`seen:` 最大值），`absence.js` 不再另算一套。
- 人物记忆 spec §9.2 的“absenceDays 保持不变”与 research §2.2 的“absence_days/absence_probe 继续用全局值”**作废**，落地时回写；presence 只读 `presenceRecent`，不碰 absence。

### D11. sleep 到期

- 新增 `lib/sleep.js` 的 `sleepDue(events, model, everyDays, dk)`，替换 `model.day % every === 0`。
- `scheduler.wake()` 与 `closing.runClosing()` 共用；同一天只写一条 `sleep:<dk>`。

### D12. 刷站配额释放

- 改 `src/dsh-bili/lib/browsejob.js`（运行时实现），不改 `src/dsh-fish/lib/browsejob.js`（2026-11-12 已软删除）。
- 测试新增 `src/dsh-bili/test/browsejob.test.mjs`；`src/dsh-fish/test/browsejob.test.mjs` 测的是死副本，不覆盖生产代码。
- `browseBudget(config, events, dk, { now })` 加 `now`；`scheduledAtFrom(events, dk)` 解析 `sched:<dk> <ISO>` 的剩余文本。
- 唤醒点后 30 分钟且当天 `wake=0` 才释放 reserve；有 wake 继续预留；没有 `sched:` 退回旧行为。

### D13. stage 1 内容与 `name_offer`

- 三张新卡（`notice_one_thing` / `leave_a_line` / `what_changed_today`）加进 `events.js` CATALOG，`asks:false`、`once:false`、有 `repeat`。
- `name_offer` 条件改为 `!m.nameOffered && m.beliefCount >= 1`。
- `nameOffered` 只在 `utterance` / `revise` 的 `pickName` 命中时置 true；`import-name:` 只设 `name`，不设 `nameOffered`。
- `import.js:26` 的注释与 `test/import.test.mjs:170-180` 的“import-name 后 cond=false”断言要一起改，否则测试红。
- `name_offer` 的 prompt“你还没想好怎么叫他”在 import-name 场景会与已知称呼矛盾；改成不假设未知称呼的措辞。

### D14. 工具面

- `screen` 面只给 `read_image` + `presence_speak` + `her_recall`，**不要用 `coreEntries('screen')`**（那会带 5 个工具）。
- `OWN_TOOL_NAMES` 加 `presence_speak`；同步更新 `tools.test.mjs`（10 个自有工具名）、`restrict.test.mjs`（HER_TOOLS）、`tool-policy-contribute.test.mjs`（`OWN_TOOL_NAMES.length` 7→8）。
- `presence_speak` 只允许 `surface==='screen'`；非 screen 直接拒绝。
- `person_note` 加入 `HER_TYPES` 后，`growth_commit` 在 bili/qq 面也能被调用；在 `capture.js` 里加一道 surface 门禁：`person_note` 只在 `web` / `wx` / `screen` 面可写，bili/qq 返回“这里不是记人的地方”。

### D15. contact 的 derive 顺序

- 不能用“先全量 prepass 置 true，再主循环遇 wake 清零”的写法，否则最后一次唤醒之后的 web contact 会被清掉。
- 按事件顺序处理：`seen:` 同时更新全局与 web；`contact:<ch>:` 更新对应 channel；`wake:` 只清 web 的 `heardSinceWakeByChannel.web`；她自己的 `utterance` / `revise` 要按 channel 置 `spokenSinceSeenByChannel[ch]=true`。
- 现有 `events-v2.test.mjs` 用手工 model 调 `t.cond`，切到 web 字段后要先补夹具，再改断言。

### D16. contact 的系统前缀

- `isContactMessage` 排除的 rpcId 前缀统一为：`wake-` / `wake-fresh-` / `closing-` / `bili-` / `say-` / `presence-` / `fish-`。
- `fish-` 是 `session-service.js:150` 的 `sessions.prompt` 前缀（B 站出门 fallback 也走它）；spec §9.2 的 `manual-` 在仓库里不存在，删掉或标为预留。
- 文本 trigger 继续排除 `WAKE_TRIGGER` / `CLOSING_TRIGGER` / `BILI_TRIGGER` / `[微信·主机]` poke。
- `surface.current` 在 bootstrap 前可能为 null；监听器只认 `web`，null 不写，避免把系统消息误记。

### D17. 微信与 B 站 contact

- dsh-wx `deliver` / `deliverToChat` 增加 `{ contact }`，成功后惰性取 `fishCore.memory.markSeen({channel:'wx'})`；DM / 免 @ 白名单才传 true。
- B 站 `scanReplies`：先读 `readOwner()`（无参数），构造 `ownerMids = Set([ow.mid, ow.account?.mid])`；**先判 `isOwner`，再决定是否跳过 `s.mid === mine`**，否则 owner.account.mid 的回复永远到不了 `out.push`。
- contact 写在 `bili_reply` 成功落盘处，时间戳优先用 `s.ctime`（回复发生时间），不用扫描时刻；同一 `rpid` 只写一次。
- `service.js` / `outing.js` 的 `memory` 传递已满足（`core.memory`），实现时确认即可。

### D18. 测试与状态基线

- 当前真实基线：`dsh-fish` 958、`dsh-wx` 90、`dsh-bili` 23，全绿。
- `src/dsh-fish/AGENTS.md` 的 947/935/813 与 `README.md` 的 641 已过时；本轮提交时一并更新为实际数字（以 `node --test` 输出为准）。
- 所有 `ev.v===3` 硬断言（`schema-v3.test.mjs`、`backup.test.mjs`、`memory-service.test.mjs` 共 7 处）在升 v4 时统一改为 4。
- `identity.test.mjs` 的“正好 4 段”断言会因 `fish:owner` 变 5 段；实现时同步改。
- `memory-service.loadKnownIds` 只认 revise/narration，`person_note` 的 `refs/supersedes/revokes` 在校验时也要读全量 id；否则 `memory.commit` 路径绕过存在性校验。

### D19. `fishCore.context` 的缺失/降级契约

- `provide(id, { order, surfaces, ttlMs, get, section = 'owner' })`；provider 必须能声明归属段，默认 `owner`。
- `fishCore.context` 不存在时：`provide` 返回一个 no-op 的 off 函数、`remove` 无操作、`render` 返回 `''`；消费方（presence）不得因此报错。
- `render({ agent, surface, section = 'owner', now })` 只取 `section` 匹配且 `surfaces` 含当前面的 provider；`get()` 抛错只记日志并跳过该 provider。
- `at` 统一为 epoch 毫秒 number；render 内部若收到 ISO 字符串先 `Date.parse`。TTL 用 `now - at >= ttlMs` 判断，类型不合法按过期处理。

### D20. `her_recall` 的父设计冲突

- 以 bili v2 §5.1/§5.6 的“原始层按 channel + chatId 隔离”为准。
- person-core §4.2/§5.5 的“recall 翻整份事件流、不按通道过滤、surface 不是隐私墙”**作废**；落地时在 person-core 文档加撤回注记，避免后续实现者按父设计把微信原话带进 B 站/别的群。
- 人物记忆的 owner facts 例外是**显式白名单**，不是“取消 channel 过滤”。

### D21. ownerFacts 的判据

- `person.id === 'owner' && person.kind === 'identity' && person.label` 非空；`flags` **不参与筛选**。
- spec §6.1 的“flags 含 identity”删除；补一条“无 flag 的 owner note 仍进 ownerFacts”的测试。

### D22. presence 汇总格式与 minutes

- 唯一格式：`meta presence:<dk>:<mode>:<minutes>:<count>`；文档中的 `presence:<dk>` 简写全部删除。
- `minutes = Math.max(1, Math.floor(activeMs / 60_000))`（不足 1 分钟按 1，不用 `Math.round`）。
- `<count>` 为 `presence_speak` 条数，0 也写；`<dk>` 用开始日；切模式先写旧段再开新段。
- 补 30 秒 / 61 秒 / 59 分 59 秒三个测试。

### D23. 工作台配置归属

- `memory.closing` 归 `#system/settings` 的“记忆”组；键为 `memory.closing.enabled` / `.time` / `.wake` / `.diaryOnly`。
- `presence.*` 归 `#her/presence`（她 → 陪伴）；键包括 `presence.enabled` / `mode` / `ffmpegExe` / `event` / `ambient` / `work` / `retentionHours` / `rotateAfter`。
- 工作台改版 §4.4 的“16 个顶层键”改成“当前 N 个”，并补“看屏/陪伴”一行；`CONFIG_PATCH_KEYS` 加 `presence`，`LIMITS` 补对应范围。
- 不在两个页面同时写同一组配置。

### D24. `person_note` 的可见性判据

- `person_note` 的归属看 `person.channel` + `person.chatId`；事件顶层 `channel` 只表示“她当时在哪写的”，不参与人物笔记的召回/渲染。
- `fish:people` 只渲染 `person.channel === 'wx'` 且 `person.chatId === 当前 chatId` 的 note；别的群、私聊、web、screen 都不渲染。
- `her_recall` 的 Phase 1 只放行 owner facts；Phase 2 放行群笔记时也必须用 `person.channel` + `person.chatId`，不能退回事件顶层 channel。
- 这条同时解决“在 web 会话里记下某个微信群的人”被 wx 召回漏掉、或反过来跨群泄露的问题。

### D25. `contact:` 的第二个字段叫 source，不叫 channel

- 序列化格式保持 `contact:<source>:<ISO>`，`source ∈ web|wx|qq|bili|screen`。
- 文档与代码注释明确：这是**来源标记**，不是事件 `channel`（事件 channel 域仍是 `core|wx|qq|web`）。
- `markSeen({ source = 'web' })`；为兼容计划里的命名，函数参数可以叫 `channel`，但落盘值按 source 语义解读。

### D26. 收盘标记只在报告写成功后落

- `flushReport` 返回 `null`（写失败）时：不写 `closing:<dk> report`，写 `closingfail:<dk> report-failed`，下一个 tick 重试。
- 报告写成功后才继续判断“最近 15 分钟是否刚唤醒”“是否有日记”“是否发收盘唤醒”。
- 补测试：`flushReport` 返回 null → 无 `closing:` 完成标记，下一次 tick 仍 due。

### D27. presence 汇总：0 也写、崩溃可补

- 删除“少于 30 秒且 0 条评论可以跳过”的例外；只要开过一段，就写一条 `meta presence:<dk>:<mode>:<minutes>:<count>`，`minutes` 最少 1，`count` 可为 0。
- `screen-session.json` 除 sessionId 外，持久化未闭合段的 `{ segmentStartedAt, segmentDayKey, mode }`；启动时若发现未闭合段，先补写一条汇总（minutes 按实际差值，count 用已落盘评论数），再开新段。
- 用户关闭、切模式、自动停止、dispose 都走 `stopSegment()`；SIGKILL 后靠启动补写兜底。

### D28. `fish:owner.surfaces` 的归属

- **人物记忆线**独占 `identity.js` 的 `fish:owner`、`surfaceOf`、`recall` 的 owner/screen 分支。
- **presence 线**独占 `surface.js` / `tool-policy.js` 的 `screen` 面与 `presence_speak`。
- 人物记忆 Phase 1 的 `fish:owner` 测试只断言 web/wx 有内容、bili/qq 为空；`screen` 断言等 presence Task 1 落地后再加，避免 Phase 1 依赖未实现的 `SURFACES`。
- 两线不互相改对方的文件；`schema.js` 的 `SURFACES` 由 D2 一次性加 `screen`。

### D29. 三条线的文件串行顺序

必须按以下顺序合，不能并行改同一文件：

1. 人物记忆：`schema.js` → `store.js` / `inbox.js` → `derive.js` → `people-view.js` / `selfdoc.js` / `identity.js` / `index.js` → `capture.js` → `recall.js` → `memory-service.js` / `observe.js` → 迁移 CLI。
2. 多通道 contact：`contact.js` → `memory-service.js`（markSeen 门面）→ `say.js` / `capture.js` → `derive.js` → `events.js` → `index.js` → dsh-wx → dsh-bili。
3. 成长自触发：`closing.js` / `sleep.js` → `settings.js` → `scheduler.js` → `derive.js`（absence/nameOffered）→ `events.js`（卡片）→ `index.js` → dsh-bili/browsejob。
4. presence：`surface.js` / `tool-policy.js` / `presence-speak.js` → `host-capture.js` / `foreground.js` → `screen.js` → `index.js` / `settings.js` → `observe.js`。

`derive.js` / `capture.js` / `memory-service.js` / `index.js` / `observe.js` / `events.js` 是热点；每个 PR 只改自己那一段，提交信息写清楚“基于上一线的哪次提交”。

### D30. v4 的部署与回滚

- 三份计划统一 Node.js 24。
- 部署顺序：人物记忆 schema v4 代码先上线（不写 `person_note`）→ 多通道 contact → 成长 → presence。
- v4 事件落盘后，**只允许功能开关/配置回滚，不允许把插件降回 v3**；旧代码读到 v4 会跳过，造成静默丢事件。
- 多通道“每步独立可回滚”改为“每步可回滚代码，但不能降 schema 版本”。

### D31. `presenceRecent` 的归属

- 不挂在 `bigfish-workspace-91` 或任何会话上；由**presence v1 的 PR** 自带 `derive` 的 `presenceRecent` 解析与测试，或由人物记忆 Phase 3 的 PR 承接。
- 本轮选择 presence v1 自带解析（Wave 3），因为 presence 已写 `meta presence:`；如果 derive 解析暂不做，必须在验收里写明“meta 有写入、无消费者”的边界。
- presence plan 里对 `bigfish-workspace-63` / `-91` / `-c9` 的 SendMessage 协调改为签入仓库的接口契约（共享字段/常量 + 对端 ACK 任务），不再依赖会话名。

### D32. `/memory` 的统一响应

- 三份功能 PR 不各自改 `/memory`；把 `people` / `contacts` / `closing` / `presence` 合并成一个 observability PR，放在三个功能 PR 之后。
- 响应形状固定为：
  `{ people: { ownerFacts, notesByChat, counts }, contacts: { lastAt, lastByChannel }, closing: {...}, presence: {...} | null }`
- 8788 的 `#her/memory` 消费 `people` 与 `contacts`；`#system/settings` 消费 `closing`；`#her/presence` 消费 `presence`。
- 如果某个键 Phase 1 不实现，返回空对象/`null`，不要 `undefined`。

### D33. `person_note` 不走 `crossChannel` 去引用化

- `person_note` 是她自己写的摘要，不是外来原文；**不要**把它送进 `guard.crossChannel`，否则引号里的别名会再次被删成“私聊名是。”，正是 11-12 失效的根因。
- `person.name` / `person.label` 只做 schema 长度/类型校验，**不要**做字符类/字典校验（微信昵称可以是任意字符串）；`looksLikeSecret` 也不要套在 label 上，32 位以上的昵称会误伤。
- `person_note` 的 `text` 只可能被 `her_recall` 和 `fish:owner`/`fish:people` 读取；`fish:people` 只走 wx，bili/qq 不渲染，因此不构成对外泄露通道。
- 工具入参仍由 `validateEvent` 做结构校验；`refs/supersedes/revokes` 必须过 `knownIds`。

### D34. `fish:owner` / `fish:people` / provider 文本的注入边界

- 所有进入提示段的外来字符串（`person.label`、`person.name`、`person_note.text`、presence `summary`）在渲染前过 `guard.sanitizeForeign({ notice: false })`；命中 `looksLikeRewriting` 的条目**整条丢弃**并记日志，不做“劝她别听”的提示。
- `fish:owner` 只渲染 label/name/channel，不渲染 `person_note.text`；`fish:people` 才渲染 text，且只在 wx 当前 chat。
- 她通过 `growth_commit` 写 `person.id='owner'` 的 identity fact 时：必须带非空 `label` 与至少一个 `refs`；只在 web/wx/screen 面可写；bili/qq 拒绝。写的是“她自己的认知”，不是系统设定；仍受 D33 的“不做字符类校验”约束。
- presence provider 的 `summary` 由本地 `renderActivity` 生成，不直接拼窗口标题；若用户配置显示 title，也必须先过 `sanitizeForeign`。

### D35. presence 对 host-desktop-capture 非目标的显式修订

- `2026-11-12-host-desktop-capture-design.md` 的“不做持续录屏/后台监视”在 presence 下修订为：**只在用户点击开启的模式内做低频候选帧采集**；关闭即停；不做历史回放、不做后台常驻、不做远程访问。
- 首次开启某个模式必须弹一次确认，文案明确“会把当前窗口/屏幕发给模型”；工作模式常驻显示“正在看 <process>”。
- 候选帧只保留 `media/presence-*`，24 小时后清理；presence 台账只留 `{at, mode, event, text}`，不写 `events.jsonl`。
- denylist 在默认四款（飞书/微信）之外，补密码管理器类（至少 `KeePass.exe`、`1Password.exe`、`Bitwarden.exe`）；denylist 永远优先于 allowlist。
- 终端类窗口（`WindowsTerminal.exe` / `powershell.exe` / `pwsh.exe`）保留在默认 allowlist，但首次开启工作模式时单独提示“终端里可能有凭据”；用户可移除。

### D36. screen 的 fail-closed 面判定

- 除 `surface.reserve(id,'screen')` 外，`core-service.js` 注册一个 `screen` matcher：`cwd === join(baseRoot,'home','screen')`。这样即使宿主创建会话时忽略了预分配 id、`agent/created` 早于 reserve，`surface.current` 仍返回 `screen`，不会落到 `restrict.js` 的 `isHerAgent` web 兜底。
- `restrict.js` 不需要新增 cwd 特判；matcher 是唯一新增点。
- 补测试：不 reserve、只给 cwd=home/screen 时，`surface.current` 返回 screen；screen 面拿不到 `growth_commit`。

### D37. `presence_speak` 的降级可见性

- `presence_speak` 加入 `OWN_TOOL_NAMES` 后会进入 `HER_TOOLS`；`restrict.js` 的无策略兜底对 web 返回 `[...HER_TOOLS]`，会让 web 面看见它。
- 在 `restrict.js` 的 fallback `effectivePolicy` 里对 web 显式排除 `presence_speak`；正常路径仍由 `tool-policy.js` 的 screen 策略决定。
- 补测试：无 tool-policy 时 web 的 `resolveAllow` 不含 `presence_speak`；screen 有策略时含。

---

## 3. 需求合并表（按主题）

| ID | 需求 | 来源 | 落点 | 本轮 |
|---|---|---|---|---|
| R1 | `person_note` 事件、schema v4、`person` 校验、`supersedes/revokes` | person-memory spec §4/§10；plan Task 1 | `schema.js` / `store.js` / `inbox.js` | 是 |
| R2 | derive 收集 `ownerFacts` / `personNotes` / `personNotesByChat` / `personNoteCount` | spec §6.1；plan Task 2 | `derive.js` | 是 |
| R3 | owner 文档 `home/关于他.md` 与 `fish:owner` 段 | spec §7.1；plan Task 3/4 | `people-view.js` / `selfdoc.js` / `identity.js` / `index.js` | 是 |
| R4 | `growth_commit` 支持 `person_note`，带 surface 门禁 | spec §5.1；plan Task 5 | `capture.js` | 是 |
| R5 | `her_recall` owner facts 放行、screen 排除 web、非 owner Phase 1 不放行 | spec §6.2/§9.1；plan Task 6 | `recall.js` | 是 |
| R6 | `memory.commit` / `REFRESH_TYPES` / `/memory` people 摘要 | spec §10/§11；plan Task 7 | `memory-service.js` / `observe.js` / `people-view.js` | 是 |
| R7 | 11-12 旧事件迁移 CLI（默认 dry-run） | spec §5.2；plan Task 8 | `owner-fact.js` / `scripts/append-owner-fact.mjs` | 是（不 apply） |
| R8 | 全局 `seen:` + per-channel `contact:`；`markSeen` | research §2；plan Task 1–4 | `contact.js` / `memory-service.js` / `say.js` / `capture.js` | 是 |
| R9 | derive per-channel + `heard_share` / `he_silent` 改用 web 值 | plan Task 2 | `derive.js` / `events.js` | 是 |
| R10 | DSH web 真实用户消息监听 | plan Task 5 | `index.js` | 是 |
| R11 | 微信 DM/免 @ 白名单 contact | plan Task 6 | `dsh-wx/lib/index.js` / `contact.js` | 是 |
| R12 | B 站 owner 回复 contact（含 account.mid） | plan Task 7 | `dsh-bili/lib/comment.js` | 是 |
| R13 | 收盘任务 + `memory.closing` | growth spec §5/§10 | `closing.js` / `settings.js` / `scheduler.js` / `index.js` | 是 |
| R14 | `absenceDays` 时间线 | growth spec §6 | `derive.js` / `events.js` | 是 |
| R15 | `sleepDue` 到期触发 | growth spec §7 | `sleep.js` / `scheduler.js` / `closing.js` | 是 |
| R16 | 刷站 reserve 释放 | growth spec §8 | `dsh-bili/lib/browsejob.js` | 是 |
| R17 | 三张 stage 1 卡 + `name_offer` 修正 | growth spec §9 | `events.js` / `derive.js` / `import.js` | 是 |
| R18 | 成长设置页与 `/memory` 收盘状态 | growth spec §10 | `settings.js` / `observe.js` / 8788 `system-settings.js` | 是 |
| R19 | `screen` 面、`presence_speak`、工具策略 | presence spec §7.4；plan Task 1/2 | `surface.js` / `tool-policy.js` / `presence-speak.js` | 是 |
| R20 | ddagrab 抓帧、前台窗口、模式状态机 | presence spec §6–§8；plan Task 3–6 | `host-capture.js` / `foreground.js` / `screen.js` | 是 |
| R21 | presence 观测路由与 8788 页面 | presence spec §8；plan Task 7 | `observe.js` + `workbench/fish/routes.mjs` + `assets/pages/her-presence.js` | 是 |
| R22 | `fishCore.context` provider 桥接 | person-memory spec §8.2（Phase 3 提前） | `context-service.js` / `core-service.js` | 是 |
| R23 | 人物/成长/contact 的工作台消费 | 合并新增 | `her-memory.js` / `system-settings.js` / `her-today.js` | 是（最小） |
| R24 | 迁移 apply、部署、真机验收 | 三份 plan 的验收步骤 | 运行环境 | 否（需用户批准） |

---

## 4. 冲突与裁决（四维验证结果已回填）

### 4.0 验证结论

- 组织方式：6 组文档/代码盘点 → 4 个维度交叉检查（数据模型、接口契约、计划排期、产品约束）→ 对 blocker/major 做对抗验证。
- 结果：**33 条成立**（其中 4 条 blocker）、19 条被推翻（多为重复项、术语差异或已被本合并稿 §2 裁定）、7 条 minor/info 未做对抗验证；完整性批判员因 429 限流未完成，补漏改由人工按三份源文档与工作台实现核对（见 §4.2）。
- 所有成立项都已在上面的 D1–D37 中给出唯一口径；下面 §4.1 是逐条证据，§4.2 是验证阶段新增/修正的口径。

### 4.1 已由代码盘点与对抗验证确认

| # | 冲突 | 证据 | 裁决 |
|---|---|---|---|
| C1 | 三份新设计的 UI 写在 8710 `client.js`，但 8788 才是唯一管理入口 | `client.js:2413-2426`；`workbench/README.md:3-10` | D1：全部迁到 8788 页面/BFF |
| C2 | `schema.js` 的 `SURFACES` 没有 `screen`，screen 会话写事件会被拒 | `schema.js:45,245-249` | D2：随 v4 加 `screen` |
| C3 | person-memory 说 screen 可见 core+owner，但 channel 推断为 web，recall 会把 web 事件带进 screen | `recall.js:154-157`；spec §6.2/§9.1 | D5：screen 显式排除 `channel==='web'` |
| C4 | `recall` 只判 owner 后 fall through，会让非 owner 的 wx 笔记跨 chatId 可见 | plan Task 6 的 `mine` 片段 | D5：非 owner `person_note` Phase 1 一律不放行 |
| C5 | `browseBudget` 测试指向 `dsh-fish/test/browsejob.test.mjs`，测的是软删除副本 | `dsh-fish/lib/browsejob.js:1-3`；test import | D12：改 `dsh-bili` 并新增 `dsh-bili/test` |
| C6 | `scanReplies` 先 `if (mine && s.mid === mine) continue`，owner.account.mid 回复被跳过 | `dsh-bili/lib/comment.js:193,228-236` | D17：先判 isOwner，再按 owner 集合过滤 |
| C7 | `SYSTEM_RPC` 前缀在 spec/plan 不一致，且漏了 `fish-` | `session-service.js:150`；spec §9.2；plan Task 1 | D16：统一前缀表 |
| C8 | contact derive 的 prepass + wake 清零顺序会让最后一次唤醒后的 web contact 失效 | plan Task 2 伪代码 | D15：按事件顺序处理 |
| C9 | `spokenSinceSeenByChannel` 从未被 utterance 置 true，`heard_share` 会反复触发 | plan Task 2 | D15：utterance/revise 按 channel 置 true |
| C10 | `person-memory` 迁移示例缺 `label`，会被 `normalizePerson` 拒 | spec §5.2 vs plan Task 1 | 统一用带 `label` 的示例 |
| C11 | `fish:owner` 300 字与 context.render 400 字预算冲突 | spec §7.1 vs §8.2；plan Task 3 | D6：facts 300 / extras 400 / 总计 700，分层独立预算 |
| C12 | `memory-service.loadKnownIds` 只认 revise/narration，person_note 的 refs 绕过校验 | `memory-service.js:129-137`；plan 只改 store.js | D18：一并扩展 |
| C13 | `identity.test.mjs` 断言正好 4 段，加 `fish:owner` 会红 | `test/identity.test.mjs:87,199` | D18：同步改为 5 段 |
| C14 | 7 处 `ev.v===3` 硬断言，plan 只点名 2 处 | `schema-v3` / `backup` / `memory-service` 测试 | D18：统一改 4 |
| C15 | `import-name` 后 `name_offer` 语义要反转，现有注释/测试相反 | `import.js:26`；`test/import.test.mjs:170-180` | D13：一起改 |
| C16 | `scheduler.tick` 多处提前 return，收盘放末尾会被跳过 | `scheduler.js:108-134` | D9：放提前 return 之前/`finally` |
| C17 | `flushMissingReports` 正文与测试对“已有报告”行为相反 | growth spec §5.6 vs §11.1 | D9：已存在则跳过 |
| C18 | `channelOfAgent` 对 bili/screen 一律返回 web，capture 兜底写不出 `contact:bili` | `store.js:146-159`；`memory-service.js:87` | D17：bili contact 只在 scanReplies 写，不靠 capture 兜底 |
| C19 | `presence_speak` 进 `OWN_TOOL_NAMES` 后会进 `HER_TOOLS`，降级路径 web 面可见 | `restrict.js` fallback | D37：fallback 对 web 排除 presence_speak，补降级测试 |
| C20 | presence 命令 `-loglevel error` 下读不到 YAVG/scene/freeze | presence spec §6.2/§6.3 vs plan Task 3 | 实现时补 `signalstats` / `metadata=print` / `-loglevel info`，或 Node 侧算 YAVG |
| C21 | presence plan 缺自动停止、沉默台账、provider 刷新、启动补写汇总 | spec §7.3/§8.1 vs plan Task 5/6 | 实现时补任务与测试 |
| C22 | `snapshot.at` 在 spec 里是数字，在 person-memory 里是 ISO 字符串 | spec §4.1 vs person-memory §8.3 | 统一用毫秒数字；render 的 TTL 用数字比较 |
| C23 | `schema.SURFACES` 与 `surface.js` / `tool-policy.js` 三张表漂移 | 代码现状 | D2：本轮统一加 screen，并在注释标明层义 |
| C24 | `person_note` 进 HER_TYPES 后 bili/qq 面也能写 | `capture.js:74`；plan 无门禁 | D14：capture 加 surface 门禁 |
| C25 | `her-memory` 页不消费 `/memory`，人物摘要不会显示 | `workbench/assets/pages/her-memory.js:1-5` | D1/R23：页面增加 `/memory` 读取 |
| C26 | presence 的 `/presence/*` 不在 BFF 白名单，8788 浏览器不可达 | `workbench/fish/routes.mjs:19-66` | D1/R21：新增两条 BFF 路由 |
| C27 | 工作台改版 §2.2 禁止新插件路由/schema/recall，本轮三项都要动 | `workbench-redesign-design.md:55` | D1：显式豁免并写说明 |
| C28 | `#her/memory` 约定全页只读，人物记忆想加写按钮 | `workbench-redesign-design.md:347` | D1：第一版只读，写操作走 CLI |
| C29 | `personNotesByPerson` / `notesByChat` 在 spec 要求但 plan 未产出 | spec §6.1/§11.1 vs plan Task 2/7 | Phase 1 可只做 ownerFacts + counts；观测台需要时再补，标为 Phase 2 |
| C30 | `selfdoc` 只写 `她的身份.md`，plan 新增 `关于他.md` 未进 spec 文件清单 | `selfdoc.js:141-143`；plan Task 4 | 以 plan 为准，落地后回写 spec §15 |
| C31 | `absenceDays` 在人物记忆与成长两份同日设计中定义互斥：前者“距最近 seen、保持不变”，后者“当前冷落天数、回来即 0” | person-memory spec:609；growth spec:275；research:76 | D10：以成长 spec 为准，回写另两份 |
| C32 | `fishCore.context` 的 no-op / section 契约只写在消费方 plan，定义处没写；provider 如何归属 section 未定义 | presence plan:460,738；person-memory spec:455-463 | D19：定义处补 no-op、section、抛错降级 |
| C33 | `ownerFacts` 判据在 spec §6.1 要求 flags 含 identity，§4.3 与 plan 又说 flags 不参与权限 | person-memory spec:340 vs 191；plan:462-470 | D21：id+kind+label，flags 不筛选 |
| C34 | presence 汇总在摘要/plan 里简写成 `presence:<dk>`，minutes 用 `Math.round` 与 spec 的 floor 不一致 | presence spec:28,354,359；plan:7,463 | D22：只保留五段格式 + floor |
| C35 | `presence.*` 与 `memory.closing` 未进工作台配置归属矩阵，presence 还多一个顶层键 | workbench-redesign:136-158；growth spec:576；presence plan:688 | D23：补矩阵行、指定唯一页面、更新键数 |
| C36 | `fish:people` 的参与者行在 spec §4.5 与 §7.2 有两种逐字写法 | person-memory spec:233 vs 402 | 以 §7.2 为准：`最近说话的人：…`，§4.5 回写 |
| C37 | 人物记忆/多通道的“按 channel+chatId 隔离”与 person-core 的“recall 不按面过滤”并列生效 | person-core:134,205；bili v2:248；person-memory:104 | D20：以 bili v2 为准，person-core 加撤回注记 |
| C38 | `scanReplies` 的 owner.account.mid 回复在 `s.mid === mine` 处被跳过 | `dsh-bili/lib/comment.js:193,228-236` | D17：先判 isOwner，再按 owner 集合过滤 |
| C39 | B 站 contact 时间戳若用扫描时刻，会把“三天前回复”记成“刚刚来过” | plan Task 7 默认 `markSeen()` now | D17：优先 `s.ctime` |
| C40 | `readOwner(root)` 签名与代码 `readOwner()` 不符 | research:143；`dsh-bili/lib/core.js:52` | D17：无参数调用 |
| C41 | `memory.resolveSurface` 会把 screen 会话事件解析成 `surface:'screen'`，schema v3 会 BAD_SURFACE | `memory-service.js` + `schema.js:245-249` | D2：v4 加 screen；screen 写事件时显式 surface |
| C42 | presence 命令 `-loglevel error` 下读不到 YAVG/scene/freeze；plan 的 parseCaptureStderr 无输入 | presence spec §6.2/§6.3；plan Task 3 | C20 同：补 `signalstats`/`metadata=print` 或 Node 算 YAVG |
| C43 | presence plan 缺自动停止、沉默台账、provider 刷新、启动补写汇总；spec 要求 | presence spec §7.3/§8.1 vs plan Task 5/6 | C21 同：实现时补任务与测试 |
| C44 | `name_offer` 改成 `!nameOffered` 后，import-name 场景的 prompt“你还没想好怎么叫他”与已知称呼矛盾 | growth spec §9.3；events.js:36；import.js:26 | D13：改 prompt，不假设未知称呼 |
| C45 | `flushMissingReports` 正文“有事件才写/已有文件不覆盖”与测试要求不一致 | growth spec §5.6 vs §11.1 | D9：已存在则跳过，不覆盖 |
| C46 | 迁移 CLI 的默认 `label` 硬编码为 `cat不到flag的cat`，换机器/换别名会写错身份事实 | plan:1273-1284；spec §5.2 | R7：`--label` 必填、无默认；统一 §16.5 的完整 person 示例 |
| C47 | `person_note` 的 `person.channel` 与事件顶层 `channel` 被不同代码消费，同一条 note 可能“渲染得到但召回不到”或反向泄露 | spec §4.4/§6.2；plan Task 2/6 | D24：可见性统一按 `person.channel + person.chatId` |
| C48 | `contact:<channel>` 的 channel 域把 bili/screen 这两个 surface 当事件 channel | research §2.1；schema `channel` 域 | D25：字段按 source 语义，明确不是事件 channel |
| C49 | `flushReport` 返回 null 时仍写 `closing:<dk> report`，当天日报永久缺失 | growth spec §5.3；`report.js:158-175` | D26：失败写 `closingfail:`，下个 tick 重试 |
| C50 | presence“0 也写”与“<30 秒且 0 评论可跳过”矛盾；SIGKILL 后段丢失 | presence spec §7.5/§16.6；plan dispose | D27：0 也写，持久化未闭合段，启动补写 |
| C51 | `chatParticipants` 直接来自 summaries，含“大肥鱼”自己、“发言人未识别”和 OCR 噪声 | dsh-wx `summaries.js:39-46`；spec §4.5 | Phase 2 契约：聚合窗口、排除自己/未识别、people.json 归一 |
| C52 | `fish:owner` 300 字与 context.render 400 字的截断规则互相覆盖，且“按行不截半个人名”与 plan 的 char cut 相反 | 第一轮 F3/F15；spec §7.3；plan:590 | D6：facts 300 / extras 400 / 总计 700，按行整条截断 |
| C53 | `deriveSelf` 被人物记忆、contact、presence 三份计划同时改写，无先后仲裁 | plan Task2 各自新增分支/字段 | D29：按 person-memory → contact → growth → presence 串行 |
| C54 | `capture.js` 的 `growth_commit` 被 person-memory 与 multichannel 同时改 | person-memory Task5；multichannel Task3 | D29：Task5 先合，Task3 后合，补联测 |
| C55 | `memory-service.js` 被 person-memory Task7 与 multichannel Task4 同时改 | 两份 plan | D29：Task7 先合，Task4 后合，测试分段 |
| C56 | `index.js` 的 boot 接线被三份计划同时改 | person-memory Task4；multichannel Task5；presence Task2/7/8 | D29：surfaceOf → session/event → presence 串行 |
| C57 | `fish:owner.surfaces` 的归属在 person-memory/presence 之间互相推，Phase 1 又提前测 screen | person-memory spec/plan；presence spec/plan | D28：identity 归人物记忆，surface 归 presence，Phase 1 只测 web/wx |
| C58 | presence 计划依赖 `bigfish-workspace-63/91/c9` 的会话协调，仓库里没有对端任务 | presence plan Task1/交接；person-memory spec §8.6 | D31：改为签入契约 + ACK 任务 |
| C59 | Node 版本 24 vs 20+，v4 部署/回滚顺序未写 | person-memory/multichannel plan 写 24；presence 写 20+ | D30：统一 24；v4 先上，之后不降级 |
| C60 | 三份计划各自改 `/memory`，没有合并响应契约；8788 无消费者 | person-memory Task7；multichannel Task8；presence Task7 | D32：observability PR 统一响应，8788 页面消费 |
| C61 | `fish:owner`/`fish:people`/provider 文本未过 `guard.js`，她可用 `growth_commit` 直接影响下一轮系统提示 | person-memory spec §7/§8；AGENTS §3 | D34：渲染前 sanitizeForeign，丢弃 rewriting 条目；owner 写入带 refs + 面门禁 |
| C62 | presence 常驻采集与 host-desktop-capture 的“不做持续录屏/后台监视”非目标冲突，未正式修订 | host spec 非目标；presence spec §0/§8 | D35：显式修订；开关即授权、首次确认、24h、denylist 补密码管理器 |
| C63 | `surface.reserve` 失败时 `restrict.js` 把 home/screen 兜底成 web，screen 拿到 growth_commit 等工具 | `restrict.js:222`；`surface.js` | D36：core-service 注册 screen matcher，fail-closed |
| C64 | `presence_speak` 进 `HER_TOOLS` 后，无策略兜底让 web 面可见 | `restrict.js` fallback；spec §7.4 | D37：fallback 对 web 排除 presence_speak |
| C65 | 群 owner @ 识别若用单个别名字符串匹配，违反昵称任意/备注掩盖群昵称的教训 | research §3.2；memory `wechat-nickname-arbitrary` | O5：v1 不算；未来需稳定 id + 多次证据 |
| C66 | presence 的 `powershell/pwsh` 默认 allowlist 可能截到终端凭据 | presence spec §6.3/§8.2 | D35：保留默认但首次单独提示，用户可移除；denylist 扩展 |
| C67 | presence 计划的 `setMode`/`onFrame` 没有自动停止计时器、黑屏计数、崩溃计数、沉默台账 | spec §7.3/§8.1 vs plan Task5/6 | D27 + F11：补实现与假帧测试 |

### 4.2 验证阶段新增/修正的口径

1. **迁移 CLI**：`--label` 不设默认值；无 `--label` 且源文本里没有「…」别名时 abort，不允许写入一条会被 `BAD_PERSON` 拒的 note。`--channel` 在计划 CLI 里不存在，删掉或显式校验；不要静默吞未知 flag。
2. **absenceDays**：D10 的裁决成立，但它主要是**源文档回写项**，不是实现阻塞；实现以成长 spec §6 为准。
3. **recall**：Phase 1 的 screen 分支在 `surface.js` 还没有 screen 时是死代码，但本轮 presence 会加 screen，所以按 D5 一次写对；非 owner 的 `person_note` 在 Phase 1 直接 `return false`，不要 fall through。
4. **UI**：工作台改版 §2.2 的“不新增插件路由”是该计划自身的改动边界，不是全局禁令；本轮 presence 的 `/presence/*`、schema v4、recall 例外按 D1/D2 显式豁免，并在 CHANGELOG/工作台说明里标注。
5. **owner 写入**：D34 的边界是 AGENTS“新输入口必须过 guard”和“owner 身份是信任锚”，不是 `no-self-modify` 机制本身；工具写 owner 身份事实要带 `refs`、只在 web/wx/screen 面，渲染前 sanitize。
6. **B 站 owner.account.mid**：skip 在 `comment.js:192-193`（去重之后、写 `bili_reply` 之前），改成 `if (!isOwner && mine && s.mid === mine) continue`。
7. **预算**：D6 的分层预算（facts 300 / extras 400 / 总 700）是最终口径；`presenceRecent` 计入 extras；按行整条截断，不切半个别名/半句话。
8. **Critic 未跑**：429 限流导致完整性批判员失败；人工补漏确认三个易漏面已覆盖：presence 自动停止/沉默台账（D27）、8788 消费页（D32）、部署/回滚顺序（D30）。

---

## 5. 开放决策（需要用户拍板，未定前按暂定值实现并标注）

| # | 问题 | 暂定 | 影响 |
|---|---|---|---|
| O1 | `growthDays` 最终 60 / 45 / 90+补内容 / “门+最少天数”重构 | **60**，只改线上实例，不写 DEFAULTS | 阶段边界、内容量 |
| O2 | 收盘时间 18:00 | **18:00** | 打扰度 |
| O3 | `closing.diaryOnly` 默认 true | **true** | 每天是否多一次唤醒 |
| O4 | presence 页面放 `#her/presence` 还是 `#system/settings` | **`#her/presence`**（她 → 陪伴） | 页面 IA、BFF 路由 |
| O5 | 群 owner @ 是否本轮算 contact | **不算**（等 owner 微信别名稳定） | 微信 contact 覆盖率 |
| O6 | presence 是否本轮做真机 T0/T4 | **代码 + 静态验收，T0/T4 等用户有空** | 验收边界 |
| O7 | 迁移 apply 是否现在执行 | **否**，只 dry-run；apply 需明确批准 | 事件流写入 |
| O8 | 部署与重启 dsh-web 的时间 | **本轮不做**，等用户批准 | 线上生效 |

---

## 6. 落地顺序与文件归属

### Wave 0：工作区与基线

1. `bigfish-workspace-dev` 从 `dev@9a59385` 快进到 `main@75138f0`（`git merge --ff-only main`）。
2. 把本轮三份 spec、三份 plan、research、本合并稿同步到 dev worktree 的 `docs/`（只同步这些文件）。
3. 跑基线：`dsh-fish` / `dsh-wx` / `dsh-bili` 三套测试全绿。
4. 不重启 `dsh-web`；不改线上 `config.json`。

### Wave 1：人物记忆 Phase 1（串行，地基）

文件归属：

- `schema.js` / `store.js` / `inbox.js` / `memory-service.js`（schema v4、person_note、REFresh、knownIds）
- `derive.js`（ownerFacts/personNotes；不与 Wave 2 的 contact 字段同时改）
- `people-view.js` / `selfdoc.js` / `identity.js` / `index.js`（`fish:owner`；index 的 surfaceOf）
- `capture.js`（person_note 分支 + surface 门禁）
- `recall.js`（owner facts + screen 排除 web）
- `observe.js`（/memory people）
- `owner-fact.js` / `scripts/append-owner-fact.mjs`
- 对应测试

### Wave 2：三条线并行，按文件串行

可并行的前提是文件不重叠；同一文件按下列顺序串行：

1. **多通道 contact**（`contact.js`、`derive.js`、`events.js`、`say.js`、`capture.js`、`memory-service.js`、`index.js`、`dsh-wx`、`dsh-bili/comment.js`）
2. **成长自触发**（`closing.js`、`sleep.js`、`derive.js`、`events.js`、`settings.js`、`scheduler.js`、`index.js`、`dsh-bili/browsejob.js`）
3. **presence 地基**（`surface.js`、`tool-policy.js`、`presence-speak.js`、`host-capture.js`、`foreground.js`、`screen.js`）

`derive.js` / `events.js` / `index.js` 是三条线的公共热点：contact 先做（人物记忆刚改完 derive），growth 再做（events 内容 + absence），presence 最后接 `index.js` 的 screen 服务。

### Wave 3：桥接与工作台

1. `context-service.js` + `core-service.js`（fishCore.context）
2. `observe.js` + `workbench/fish/routes.mjs`（presence 路由、/memory 消费）
3. `workbench/assets/pages/her-presence.js` + `nav.js`；`her-memory.js` 读 `/memory`；`system-settings.js` 加 `memory.closing`
4. `CHANGELOG.md`、`AGENTS.md`/`README` 测试基线更新

### Wave 4：验收

- 三套 `node --test` 全绿；记录新数字。
- `python scripts/audit-staged.py` 只扫描本轮路径。
- 迁移 dry-run；展示 note，不 apply。
- 报告分列：本地检查 / 提交 SHA / 推送 / WSL 拉取 / 部署 / 真机验收。

---

## 7. 验收标准（合并版）

1. 微信私聊、网页会话能看到 owner 别名；B 站/QQ 看不到（测试夹具覆盖）。
2. `person_note` 不改变 beliefs / facts / 成长门 / 日报引用。
3. 群/私聊笔记在 Phase 1 不可 recall；screen 看不到 web 普通事件。
4. 任一通道 contact 后 `absence` 的 `days` 为 0；presence 不改变 absence。
5. 网页 home 的 `heard_share` / `he_silent` 不被 wx/bili contact 串扰。
6. 收盘每天写报告；收盘不占唤醒配额、不写 `seen:`；同一天最多一条 `closing:<dk>`。
7. `absence_probe` 在他回来后 2 天内可出，之后不补触发。
8. `browseBudget` 在 quiet 日唤醒点后 30 分钟释放 reserve。
9. stage 1 三张新卡可出；`name_offer` 在她自己给过称呼后不再出，import-name 不抑制。
10. presence 三模式默认关、互斥、关闭即停；work 模式 deny 优先；不写事件流，只写 `meta presence:` 汇总。
11. 8788 能开关 presence、看到状态；`#her/memory` 能看到人物摘要；`#system/settings` 能改 `memory.closing`。
12. 事件流只追加；没有删除/重排/改写历史事件。

---

## 8. 需要回写的源文档

落地时同步修订（不是另起一份）：

- `person-memory-design.md` §6.2/§9.1：screen 排除 web；§8.2 预算 400；§11.2 改 8788；§15 加 `home/关于他.md` 与 `context-service.js`。
- `presence-watch-design.md` §4.4/§11：`screen` 同时进 `schema.SURFACES`；UI 改 8788；补自动停止/沉默台账/provider 刷新/`signalstats`。
- `growth-self-trigger-design.md` §11.1/§14：browsejob 测试改 `dsh-bili`；§12.1 的“dev 已指向线上 profile”按实际拓扑改写；`flushMissingReports` 口径统一。
- `multichannel-contact.md`（research）：`readOwner()` 无参数；移除 `manual-`；补 `fish-` 前缀；B 站 contact 用 `s.ctime`。
- `workbench-redesign-design.md` §2.2：标注本轮三项显式豁免；§6.3 事件类型补 `person_note`/`bili_reply`。
