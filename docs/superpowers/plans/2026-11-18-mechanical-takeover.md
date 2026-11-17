# 机械侧接管实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把微信任务绑定、提醒、配额、返回契约和参数面中可由机械侧承担的句柄收回，同时不放宽权限。

**Architecture:** 按项目独立上线。先做任务绑定与调度可见性，再做 durable reminder、quota、return envelope 和参数面；每个项目带 feature switch 与回滚点。

**Tech Stack:** Node 24、`dsh-fish`/`dsh-wx`/`workbench`、`node:test`、零依赖。

**Spec:** `docs/superpowers/specs/2026-11-16-diegetic-feedback-phase2-design.md`

**Base:** `6503bcc`

## Global Constraints

- 权限、allowlist、permit、@ hard gate、length/newline、speech circuit breaker 不放宽。
- `events.jsonl`、tasks.jsonl、permit store 只追加/兼容写，不重写或清理历史。
- 只在实际发送 confirmed 后记 task reply；preview/unconfirmed 不记。
- 机械提醒不把 permit/chat/text 放进模型上下文。
- 每个数据形状/可见性变化独立 commit、独立 feature switch、独立回滚。
- `qq_napcat_api` / `growth_commit.confidence` 移除前必须有数据证据和迁移方案。
- 旧 look/watch/speak 文件删除需用户针对确切路径的删除批准；本计划不执行。

## Tasks

### Task 1: `wx_send` implicit task binding

**Files:** `src/dsh-wx/lib/index.js`, `directory.js`, `tasks.js`, `project.js`, `src/dsh-wx/test-directory.mjs`, `test-context.mjs`, `test-tasks.mjs`, `test-ear-note.mjs`, `test/tool-surface.test.mjs`

**Interfaces:** canonical chatName→directory idFor→activeForChat；explicit task_id fallback；preview/unconfirmed no booking；duplicate msgId idempotent.

- [ ] 写失败测试：exact/resolved/unknown/ambiguous/renamed names, explicit wrong task, preview/unconfirmed, duplicate reply.
- [ ] 实现 feature flag `implicitTaskBinding`，默认开启仅在唯一解析时绑定。
- [ ] 从耳朵/逾期移除 task marker，保留 board.summary/her_inbox。
- [ ] 跑 dsh-wx + fish gate tests，提交。

### Task 2: Overdue visibility and blocked behavior

**Files:** `src/dsh-wx/lib/index.js`, `tasks.js`, `workbench/server.mjs`, `assets/channels/wx.js`, tests.

**Interfaces:** third reminder blocks/silences; workbench read-only blocked/overdue summary; new inbound on blocked task must produce a defined state.

- [x] 写失败测试：three reminders then block, no fourth; blocked+inbound; summary/workbench route.
- [x] 实现 pump/workbench read-only card; no task body/ID exposed at BFF.
- [x] 跑 wx/workbench tests，提交。

**Evidence (2026-11-18, `baae3f3`):** `src/dsh-wx`: `node --test` → 125 pass / 0 fail；`workbench`: `node --test` → 124 pass / 0 fail。覆盖 stale inbound/block precondition、提醒落盘失败退避、最终 block 单事件与旧半截修复、`overdueVisibility=false/true` 运行时回滚，以及任务摘要不可读时 `ok:false` / `unavailable`。`git diff --cached --check` 通过；`python3 scripts/audit-staged.py` 返回无候选密钥、无大文件。未部署、未重启服务。

**Evidence round 2 (2026-11-18, `f7f2b52`):** `src/dsh-wx`: `node --test` → 126 pass / 0 fail；`workbench`: `node --test` → 124 pass / 0 fail。补充覆盖 probe 可写但 append 连续失败时退避累计、stale block 返回 `stale` 且状态/版本不变。`git diff --cached --check` 通过；`python3 scripts/audit-staged.py` 返回无候选密钥、无大文件。未部署、未重启服务。

### Task 3: Durable mechanical reminder delivery

**Files:** `src/dsh-fish/lib/remind.js`, `schedule-hooks.js`, `src/dsh-wx/lib/reminder.js`, `index.js`, tests.

**Interfaces:** durable due record links id/chat/text/permit/dueAt/attempt/result; core schedule tick drives due jobs; at-most-once after pressed Return; confirmed/unconfirmed/failed/unknown surfaced next turn.

- [x] 写失败测试：due time, restart recovery, duplicate tick, unconfirmed send, revoke, feature switch.
- [x] 实现 plugin-owned delivery worker using schedule-hooks/core tick; no host prompt for new mechanical jobs.
- [x] 迁移 old schedule path behind feature switch, keep old records.
- [x] 跑 fish/wx/host-shaped tests，提交。

**Evidence (2026-11-18):** 新增只追加的 `~/.dsh-wx/reminder-jobs.jsonl` 与核心 tick worker；新任务不再创建宿主 prompt，Return 后确认/未确认/异常均终态，重启中的半截 attempted 记 unknown 且不再发。`mechanicalReminderDelivery:false` 回滚到旧 schedule 路径，旧记录与旧许可保留。`src/dsh-fish`: `node --test` → 1150 pass / 0 fail；`src/dsh-wx`: `node --test` → 137 pass / 0 fail；`workbench`: `node --test` → 124 pass / 0 fail。未部署、未重启服务、未做真机微信发送。

**Review fix evidence (2026-11-18, `a0eacbf`):** 机械投递改为逐条 claim → send → settle，每条前重读开关；新增两任务进程崩溃恢复与过期许可终态测试。workbench 保存保留 `mechanicalReminderDelivery:false`；系统提示按开关选择机械/旧指令；提醒世界声改为先 peek，`sc.prompt` 成功排队后才 ack；机械创建不再依赖宿主 `schedule` / `grantReminder`。`src/dsh-fish`: `node --test` → 1154 pass / 0 fail；`src/dsh-wx`: `node --test` → 140 pass / 0 fail；`workbench`: `node --test` → 125 pass / 0 fail。`git diff --cached --check` 通过；`python3 scripts/audit-staged.py` 返回无候选密钥、无大文件。未推送、未部署、未重启服务、未做真机微信发送。

### Task 4: Quota tiering

**Files:** `src/dsh-wx/lib/proactive.js`, `send-gate.js`, `index.js`, workbench policy/UI/tests.

**Interfaces:** `softLimit`, `hardBreaker`; mention window remains hard; soft overage allowed only where proactive send is already permitted; audit marker.

- [x] 写失败测试：mention window hard, noMention/exempt paths, soft overage, breaker, bad state fails closed.
- [x] 实现 config-compatible keys and audit flags; keep old proactive.json.
- [x] 更新 workbench and prompt-removal tests.
- [x] 跑 wx/workbench/fish tests，提交。

**Evidence (2026-11-18, `fc70f40`):** 保留 `proactivePerDay` / `proactiveChats` 作为软上限，新增 `hardBreaker`（默认和上限 50）及 `softLimit` 读兼容别名；超过软上限但未到硬熔断仍放行，显式 0 仍静音，@/免 @/名单/主机/permit/长度/speech 闸未放宽。`inbound.jsonl` 的 `proactive-send` / `proactive-breaker` 记录完整 `used` / `softLimit` / `hardBreaker` / `overSoftLimit` / `atHardBreaker` 审计标记。坏 `proactive.json` 状态失败关闭主动路径，文件路径与 `{ day, used }` 形状未迁移；workbench 表单和状态卡接入软/硬阈值，prompt-removal 回归仍不含额度数字。`src/dsh-wx`: `node --test` → 149 pass / 0 fail；`workbench`: `node --test` → 128 pass / 0 fail；`src/dsh-fish`: `node --test` → 1154 pass / 0 fail。`git diff --cached --check` 通过；`python3 scripts/audit-staged.py` 返回无候选密钥、无大文件。未推送、未部署、未重启服务、未做真机微信发送。

### Task 5: WeChat return envelopes

**Files:** `src/dsh-wx/lib/index.js`, `tool-error.js`, `project.js`, `src/dsh-fish/lib/tool-result.js`, `tool-ledger.js`, tests.

**Interfaces:** all wx registrations return object envelope; expected failures `{ok:false,code,message}`, unexpected throws remain errors; one registration-level switch.

- [ ] 重新统计并分类 throw sites；写契约测试覆盖所有 wx tools.
- [ ] 迁移 success/failure/callers atomically; ledger full result + model projection.
- [ ] 跑 wx/fish tests，提交。

### Task 6: Parameter surface closure

**Files:** `src/dsh-wx/lib/index.js`, `sticker-query.js`, `sticker-send.js`, `src/dsh-fish/lib/capture.js`, `schema.js`, `derive.js`, `tool-policy.js`, tests.

**Interfaces:** one sub-change per commit:
- sticker human selection `第 N 张`/description resolver; remove st_ from projection only when resolver works.
- `qq_napcat_api` hide or dedicated tool after ledger action inventory.
- `growth_commit.confidence` migration only after choosing default/missing semantics.
- `wx_click` x/y removal only after label-failure evidence.

- [ ] Gather ledger evidence; record decisions.
- [ ] Implement stateless sticker/qq changes first with visibility snapshots.
- [ ] Implement confidence migration last with append-only compatibility tests.
- [ ] 跑 wx/fish/workbench tests，提交。

### Task 7: Image blocks and cleanup gates

**Files:** `media.js`, `observe.js`, `say.js`, `session-service.js`, `screen.js`, `src/dsh-wx/lib/index.js`, `src/dsh-bili/lib/watch.js`, tests.

**Interfaces:** production uses `ctx.attachments.saveImage` and `{type:'image',attachment}` when host supports; path+read_image fallback otherwise.

- [ ] Host capability test; fix obsolete image block test shape.
- [ ] Add one producer at a time behind feature switch: bili_watch, wx_see, /say, screen.
- [ ] Migration of old look/watch/speak tests only; deletion remains explicit approval gate.
- [ ] 跑 fish/wx/bili tests，提交.
