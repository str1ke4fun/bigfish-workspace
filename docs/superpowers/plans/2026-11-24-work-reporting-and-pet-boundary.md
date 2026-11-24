# Work Reporting and Pet Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 桌宠只做桌宠；工头用自己的人话汇报；陪伴会话能从内部工作状态回答“那两个 agent 怎么样、接下来推进什么”。

**Architecture:** 现有 `work` 面/WorkUnit/worker 保持不变。只做四层切分：桌宠事件不再接受 `work`；`bossSummary` 成为唯一用户可见汇报；`her_worker_control.get` 输出人话回述；陪伴 prompt 增加 `fish:work` 处境并改工具描述。

**Spec:** `docs/superpowers/specs/2026-11-24-work-reporting-and-pet-boundary-design.md`

## Global Constraints

- 不改 `work-guard`、worker preset、sandbox、事件 schema、微信发送闸。
- worker 的 `summary` / `report` 仍留在 `work-units.json`，但不进 `her_work_status`、不进微信、不进桌宠。
- 桌宠状态视觉本轮不做；只移除 `work` 面。
- 测试基线：`dsh-fish` 1243、`dsh-wx` 176；每步跑对应套件。

### Task 1: 桌宠移除 work 面

**Files:** `src/dsh-fish/lib/pet-view.js`、`src/dsh-fish/lib/index.js`、`src/dsh-fish/test/pet-view.test.mjs`

- [ ] 写失败测试：`petSurfaceAllowed('work') === false`；`noteSessionEvent` 对 work 返回 false。
- [ ] 从 `PET_SURFACES` 移除 `work`；`wirePetEventSources.isHerSession` 恢复为只认 `isHerAgent`（不再把 work 会话当桌宠事实源）。
- [ ] 跑 `test/pet-view.test.mjs` 和 `test/observe-pet.test.mjs`。
- [ ] 提交 `feat(dsh-fish): keep work sessions out of the pet`。

### Task 2: bossSummary 与状态/回述

**Files:** `src/dsh-fish/lib/work.js`、`src/dsh-fish/test/work.test.mjs`

- [ ] 写失败测试：worker 结算后 `her_work_status` 不出现 worker 原文；工头 `assistant/message` + `turn/end` 后出现工头那句话；`her_worker_control.get` 不含 `report`，summary 是人话回述。
- [ ] 记录新增 `bossSummary: ''`；`finishUnit` 不再写 `row.lastSummary = unit.summary`；`handleTurnEnd` 把 `heard` 写入 `bossSummary`。
- [ ] `her_work_status` 返回 `lastSummary`（来源 bossSummary）+ `workers: [{label, mode, status}]`；通知只用 `/ heard / 泛化文案`，不再用 worker summary。
- [ ] `her_worker_control.get` 用 report 压成人话（摘要/文件数/验证数/blockers），不返回原始 `report`。
- [ ] 跑 `test/work.test.mjs`、全套 `node --test`。
- [ ] 提交 `feat(dsh-fish): report work in the boss's own words`。

### Task 3: fish:work 处境与自然语言描述

**Files:** `src/dsh-fish/lib/work.js`、`src/dsh-fish/lib/identity.js`、`src/dsh-fish/lib/index.js`、`src/dsh-fish/test/work.test.mjs`

- [ ] 写失败测试：`promptSection(screenAgent)` 含目录、worker 标签/状态、bossSummary，不含 worker summary/report；无工作会话时为空；非 screen 面为空。
- [ ] 新增 `workService.promptSection(agent)`；`identity.js` 增加 `fish:work` 段（仅 screen），`registerIdentity` 接收 `workText`；`index.js` 注入。
- [ ] 改四个工具描述为场景句（用户问“他们做完没/那两个 agent” → `her_work_status`；用户说“接着推进/让他们做” → `her_work` 同目录）。
- [ ] 跑 `test/work.test.mjs`、全套 `node --test`。
- [ ] 提交 `feat(dsh-fish): give the companion a work situation and natural-language hints`。

### Task 4: 部署与真机验收

**Files:** `CHANGELOG.md`、spec/plan、线上 `~/.dsh/profiles/web/cordis.patch.yml`（无变化）

- [ ] 合并到 main、推送、`fish-ctl restart dsh-web`。
- [ ] 自检 `work` 项仍 ok；桌宠不再出现工头文字。
- [ ] 用用户原句“帮我看下屏幕上那两个 agent 做完工作了吗？有什么工作你可以进一步让他们推进的”真机验证：她能回答两个 worker 的状态和下一步建议；如她没调用 `her_work_status`，记录为后续 prompt/工具发现项。
- [ ] 更新 CHANGELOG 测试数；记录验证边界。
