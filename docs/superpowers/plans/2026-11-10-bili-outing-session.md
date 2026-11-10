# B 站出门会话（第一版）

日期：2026-11-10
范围：只做「出门会话 + 调度投递」，不拆 `dsh-bili`，不改事件流 schema。

## 目标

1. Web/home 会话的 `config.tools.allow` 清空，web 面回到策略表里的 5 个常驻工具。
2. 新建并复用「大肥鱼出门 / 去 B 站」会话，cwd `~/.dsh-fish/home/bili`，面 `bili`。
3. 后台刷站成功、或评论区有新回复时，往出门会话投一次「出门看看」，素材与回复走
   `fish:wake` 段；她能用 `bili_look` / `bili_watch` / `bili_speak`。
4. home 唤醒不再代答 B 站回复；回复只在出门会话里出现。
5. `wakesPerDay` 打开（live 设为 2）。

## 设计

- 会话幂等沿用 `home.js` 的口径：`bili-session.json` 里记 `wsId/sessionId/title/createdAt`；
  工作区仍在、会话仍在 `sessionIds` 且未归档才复用。
- 创建顺序：预分配 id → `surface.reserve(id,'bili')` → `sc.create({ sessionId })`；
  宿主返回不同 id 时以返回值为准并补登记。
- 出门调度器仍在 core（`lib/outing.js`），不新增 `dsh-bili` 包；后续拆包时整块搬走。
- 出门触发：
  - 本次 tick 的后台刷站成功 → 带素材出门；
  - 否则有未回回复、且距上次出门 ≥ 60 分钟 → 只带回复出门；
  - 每天出门次数上限 = `max(1, browse.perDay)`，用 `meta biliout:<日期>` 计数；
  - 只在 `comment.window` / `browse.window` 内，风控冷却中不出门。
- 出门对话里只留短触发「（出门看看）」，正文进 system prompt 的 `fish:wake` 段；
  回合结束或超时清掉该会话的段，不影响 home 的段。
- 工具面：策略表 bili 面已有 8 个常驻（core 5 + `bili_look`/`bili_watch`/`bili_speak`），
  不新增工具、不放开宿主工具。

## 任务

1. `identity.js`：`setWakeSection/clearWakeSection` 支持按 session 区分，旧调用保持兼容。
2. 新增 `lib/outing.js`：`ensureBiliSession()` + `maybeOuting()`。
3. `index.js`：home 建好后确保出门会话，把 `ensureBiliSession` 传给 scheduler。
4. `scheduler.js`：tick 里在后台刷站后调用 `maybeOuting`；home 唤醒删除 `scanReplies` 渲染。
5. 测试：会话幂等/预分配/重建；出门触发/配额/时段/无会话降级；按会话的 wake 段不串。
6. 文档：README、`src/dsh-fish/AGENTS.md` 的「未做」条目改为当前边界。
7. 全量 `node --test`，提交、重启 8710/8720，核对日志与工具面。

## 验收

- `~/.dsh-fish/bili-session.json` 存在，侧栏出现「去 B 站」，cwd 是 `home/bili`。
- 出门会话日志显示 8 个工具；home 下次收窄为 5 个（`tools.allow` 为空）。
- 走到刷站槽位后，出门会话收到「（出门看看）」并出现她的回合。
- 事件流只追加，`events.jsonl` 不删改；零依赖；测试全绿。
