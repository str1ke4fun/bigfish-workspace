# 工作委派、手机派活与主动看屏 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `look_screen` 主动抓屏工具，以及工作委派 P1 + 微信派活/汇总（`work` 面、`WorkUnit`、`her_work`/`her_worker`/`her_worker_control`/`her_ask_user`、`work-guard`、三个 preset）。

**Architecture:** 工头仍是鱼本人，跑在独立 `work` 面会话，cwd 为用户显式给出的工作目录；`her_worker` 通过宿主 `ctx.subagents.startActivation()` 派 durable 子会话，worker preset 决定宿主工具上限，fish 侧 `work-guard` 挂全局 `tools/pre-execute` 检查路径与外发命令。状态只写 `~/.dsh-fish/work-sessions.json` / `work-units.json`，事件流仍只经 `growth_commit` 追加（`work` 面映射为事件面 `web`）。

**Tech Stack:** Node.js 20+ 内置模块、`node:test` / `node:assert`、DSH host `0.2.1-rc.5`（`ctx.subagents`、`permissionPresets`、`sessionController`、`tools/pre-execute`）。

**Spec:**
- `docs/superpowers/specs/2026-11-20-work-delegation-and-phone-intake-design.md`
- `docs/superpowers/specs/2026-11-23-cross-session-work-status-design.md`
- `docs/superpowers/specs/2026-11-19-look-screen-tool-design.md`

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 永远为 `{}`；`src/dsh-wx` 不新增依赖。
- 不新增人格设置入口；工作写入不进 `events.jsonl` schema；不改 `EVENT_SCHEMA_VERSION`。
- `events.jsonl` 只追加，不删除、不覆盖、不重排。
- `work` 是会话/工具面，事件来源面仍写 `web`；worker 不写事件流。
- 只暂存本任务明确路径；提交前跑 `python3 scripts/audit-staged.py`。
- `src/dsh-fish` 测试基线 1196；`src/dsh-wx` 基线 173；每条任务结束必须跑对应套件。
- 读隔离走 G：`work-guard` 是代码级 denylist，不是内核隔离；P4 才做 bwrap/容器。
- 生产配置 `~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh-fish/config.json`、`~/.dsh-wx/policy.json` 不进 Git；仓库只放示例/文档。
- 受信微信私聊：`cat不到flag的cat`（已在 `~/.dsh-wx/policy.json` 的 `allowChats` 与 `noMentionChats`）。

## Review Focus

- **worker 不能看见/调用鱼工具**：worker 是 preset own 层宿主工具，`tools.restrict({allow: WORKER_HOST_TOOLS})` 只掩 global/inherited 的鱼工具；不要给 worker 装会误杀 `structured_output` 的 scoped guard。
- **worker 的 fs/bash 必须过 guard**：路径按 realpath 判断；`~/.ssh` 等受保护路径和裸外发命令拒绝；guard 初始化失败时 `her_worker` fail closed。
- **完成通知不是状态源**：`activation.result` 写 `WorkUnit`；`list_agents` 的 `inactive` 永不改成 `done`；重启后 `running` 变 `unknown`。
- **inspect 结构化结果**：只有 inspect 请求 `outputSchema`；没交结构化结果按 `failed` + `failureKind='structured-missing-or-error'`，不报“评审通过”。
- **受信闸**：微信只接受 `work.wx.dispatchChats` 里的私聊；桌宠只接受 `say.js` 标记的受信轮次；屏幕采集/群会话拒绝。
- **目录校验**：拒绝受保护路径及其子目录，也拒绝包含受保护路径的祖先（用户 home、`/home`、`/`）。
- **工作写入不喂 presence**：`capture.js` 在 `surface==='work'` 时跳过 `markSeen`。

---

### Task 1: `look_screen` 主动抓屏工具

**Files:**
- Create: `src/dsh-fish/lib/look-screen.js`
- Modify: `src/dsh-fish/lib/tool-policy.js` (`screenEntries`)
- Modify: `src/dsh-fish/lib/restrict.js` (`OWN_TOOL_NAMES`)
- Modify: `src/dsh-fish/lib/index.js` (register)
- Test: `src/dsh-fish/test/look-screen.test.mjs`
- Test: `src/dsh-fish/test/tool-policy.test.mjs` (expected screen allow)

**Interfaces:**
- `registerLookScreen(ctx, { root, core, screen, log })` → disposer
- `screen.captureNow({ waitMs, maxAgeMs })` already returns `{ ok, path, at, mode, ageMs }`.

- [ ] **Step 1: Write failing test** — tool only executes on `screen` surface; presence off/not-capturing/no-frame return human messages; success returns path/at/mode; policy exposes `look_screen` only on screen.
- [ ] **Step 2: Run test, expect failure** — `node --test test/look-screen.test.mjs`.
- [ ] **Step 3: Implement** — `look_screen` description: “真的想现在看一眼才调用；不要连续；拿到路径后用 read_image 看”. Execute: surface check → `captureNow({ waitMs: 1500, maxAgeMs: 15000 })` → `{ok:true,path,at,mode}` or `{ok:false,code,message}`. Projection: `看一眼：〔path〕（用 read_image 看）` / `现在看不到屏幕（…）`.
- [ ] **Step 4: Wire** — add `tool('look_screen','screen',ALWAYS,'','看一眼此刻的屏幕','read')`, add to `OWN_TOOL_NAMES`, register in `index.js` next to presence_speak.
- [ ] **Step 5: Run** — `cd src/dsh-fish && node --test test/look-screen.test.mjs test/tool-policy.test.mjs`; expect pass.
- [ ] **Step 6: Commit** — `feat(dsh-fish): add look_screen capture tool`.

### Task 2: `WorkUnit` / boss 状态存储

**Files:**
- Create: `src/dsh-fish/lib/work-state.js`
- Test: `src/dsh-fish/test/work-state.test.mjs`

**Interfaces:**
- `createWorkState({ root, now = Date.now, log })` → `{ sessionsPath, unitsPath, readSessions(), mutateSessions(fn), readUnits(), createUnit(input), updateUnit(id, patch), settleUnit(id, settlement), appendGuardHit(id, hit), unitsForBoss(sessionId), unitsForDir(dir), activeCounts(bossSessionId), reconcileRunning(), status() }`
- `mapSettlement({ stopReason, structured, requestedSchema })` → `{ status, stopReason, failureKind, summary, report }`
- `truncateSummary(text)` (≤2000, flattened), `sanitizeReport(report)` (arrays ≤20, items ≤500, teammates ≤16), `sanitizeGuardHit(text)` (≤200, no full command/path).
- `newUnitId(now)` → `wu_<base36 time><random>`.

- [ ] **Step 1: Write tests** — atomic write, 0600, retention 200 keeps running, corrupt file → empty + `.corrupt-*`, mapping table (`completed/no blocker→done`, `completed+done:false→blocked`, `aborted→aborted`, `error→failed`, `unknown`), one-time settle, active counts only `queued|running`, summary/report truncation and `looksLikeSecret` behavior injected as a function.
- [ ] **Step 2: Run, expect fail** — `node --test test/work-state.test.mjs`.
- [ ] **Step 3: Implement** — serialize all mutations through one promise chain; read-modify-write with `writeAtomic(file, json, 0o600)`; unknown fields ignored on read; `sessions` object keyed by absolute dir.
- [ ] **Step 4: Run, expect pass**.
- [ ] **Step 5: Commit** — `feat(dsh-fish): add work session and WorkUnit state`.

### Task 3: `DelegationBackend` subagent adapter

**Files:**
- Create: `src/dsh-fish/lib/work-backend.js`
- Test: `src/dsh-fish/test/work-backend.test.mjs`

**Interfaces:**
- `createSubagentBackend({ getService, now, log })`
- `available()` → boolean (`service.startActivation` + `list()` includes `spawn`)
- `capabilities()` → `{ structuredOutput: true, peerMessaging: true, taskBoard: false, maxConcurrent: 2 }`
- `spawn({ parent, dir, preset, prompt, outputSchema, label, signal })` → `{ ok:true, childId, result, dispose }` | `{ ok:false, code, why }`
- `message({ sender, childId, text, signal })` → `{ ok, messageId }` | `{ ok:false, code }`
- `interrupt({ sender, childId })` → `{ ok, accepted }`
- `onSettle(resultPromise, cb)` → unsubscribe

- [ ] **Step 1: Write tests with a fake subagent service** — assert `startActivation` spec: `provider:'spawn'`, `delivery:'parent'`, `request.parent`, `request.cwd===dir`, `request.agentPreset`, `request.maxDepth===1`, `outputSchema` only when passed; result settle callback; `message`/`interrupt` delegation; missing service → `{ok:false,code:'NO_SUBAGENTS'}`.
- [ ] **Step 2: Run, expect fail**.
- [ ] **Step 3: Implement** — do not import host packages; `getService()` reads `ctx.get('subagents')`; extract output text from `result.output` content blocks; `stopReason` passthrough.
- [ ] **Step 4: Run, expect pass**.
- [ ] **Step 5: Commit** — `feat(dsh-fish): add subagent delegation backend`.

### Task 4: `work-guard` read/egress guard

**Files:**
- Create: `src/dsh-fish/lib/work-guard.js`
- Test: `src/dsh-fish/test/work-guard.test.mjs`

**Interfaces:**
- `WORKER_HOST_TOOLS = ['read','write','edit','glob','grep','bash','pwsh','structured_output']`
- `createWorkGuard({ state, log, now })` → `{ register(ctx), isWorkerSession(agent), isWorkSubtree(agent), check({ toolName, args, agent }), flushHits(childId), status() }`
- `check` returns `{ ok:true }` or `{ ok:false, reason }` (reason is world voice, no paths/commands).

- [ ] **Step 1: Write tests** — worker by `backendRef.childId` or `parentSession + agentPreset fish-work-*`; non-worker sessions unaffected; `read/write/edit` path inside cwd allowed, outside/`../`/symlink escape/`~/.ssh`/`~/.aws`/`~/.dsh`/`~/.dsh-fish`/`/etc/shadow` denied; `glob/grep` path same; bash secret path and `curl|wget|nc|ssh|scp|rsync|git push|git clean|git reset --hard|sudo` denied; `npm`/`pnpm`/`pip` allowed; guard hit sanitized and queued.
- [ ] **Step 2: Run, expect fail**.
- [ ] **Step 3: Implement** — register `ctx.on('tools/pre-execute', (exec,next)=>...)`; return `{kind:'deny',reason}` on hit, `next()` otherwise; realpath of nearest existing ancestor; protected path list from `os.homedir()` + root; bash string denylist (documented as P1 boundary).
- [ ] **Step 4: Run, expect pass**.
- [ ] **Step 5: Commit** — `feat(dsh-fish): add worker read and egress guard`.

### Task 5: Work service, tools, trusted gates, notification state machine

**Files:**
- Create: `src/dsh-fish/lib/work.js`
- Modify: `src/dsh-fish/lib/settings.js` (DEFAULTS.work + normalize)
- Modify: `src/dsh-fish/lib/config-service.js` (allow `work` top-level keys)
- Test: `src/dsh-fish/test/work.test.mjs`

**Interfaces:**
- `createWorkService({ ctx, core, config, state, backend, guard, wx, root, now, log })`
- `service.tools` → `{ her_work, her_work_status, her_worker, her_worker_control, her_ask_user }` (plain tool defs)
- `service.register(ctx)` → registers tools + session listener; returns disposer
- `service.reserveKnown()`; `service.noteTrustedTurn(sessionId)`; `service.isTrustedTurn(sessionId)`; `service.isWorkSession(sessionId)`; `service.onSessionEvent(session,event)`; `service.reconcile()`; `service.status()`
- `validateWorkDir(dir, { root, home, platform })` → `{ ok, real, why }`

- [ ] **Step 1: Write tests** — dir validation (absolute, exists, protected, ancestor), `her_work` trusted gates (wx dispatch list, screen trusted turn, group rejected), boss reuse/new, preset required no fallback, `her_worker` no `cwd` param + workspace-write check + maxActive 2/build 1 + start failure creates failed unit, `her_worker_control` message settled rejection + list/get, `her_ask_user` waiting, notify state machine (active workers → “已派出”, waiting → “在等你”, settlement → “做完了/卡住了”, plain status → none), reconciliation running→unknown.
- [ ] **Step 2: Run, expect fail**.
- [ ] **Step 3: Implement** — tool projections use world voice; no machine ids in text except necessary handles; `her_work` prompt format from spec §4.4; `her_worker` prompt from spec §4.3; `structuredOutput` only for inspect; per-unit `runTimeoutMs` timer; `onSettle` writes state once; `guard.flushHits` before settle.
- [ ] **Step 4: Run, expect pass**.
- [ ] **Step 5: Commit** — `feat(dsh-fish): add work delegation service and tools`.

### Task 6: Surface / policy / identity / memory / pet wiring

**Files:**
- Modify: `src/dsh-fish/lib/surface.js` (`work` in SURFACES, priority)
- Modify: `src/dsh-fish/lib/tool-policy.js` (work surface entries; screen/wx her_work)
- Modify: `src/dsh-fish/lib/restrict.js` (new tool names; worker restrict path; web fallback filter)
- Modify: `src/dsh-fish/lib/identity.js` (work identity + fish:owner)
- Modify: `src/dsh-fish/lib/memory-service.js` (work→web surface/channel)
- Modify: `src/dsh-fish/lib/capture.js` (skip markSeen on work)
- Modify: `src/dsh-fish/lib/pet-view.js` (`work` in PET_SURFACES)
- Modify: `src/dsh-fish/lib/index.js` (create work service, matcher, reserve known, wire restrict/identity/pet, register tools)
- Modify: `src/dsh-fish/lib/settings.js` / `config-service.js` if not done in Task 5
- Tests: existing `test/tool-policy.test.mjs`, `test/tool-policy-contribute.test.mjs`, `test/restrict.test.mjs`; new assertions in `test/work.test.mjs`.

**Interfaces:**
- `registerToolRestrict(..., { workerMatch, workerNames })`: when worker, `allow = workerNames ∩ hostNames`, apply `restrict` without scoped guard; record state surface `'worker'`.
- `surface.current` returns `'work'` for boss session ids (reserve + matcher).
- `memory.resolveSurface`: agent surface `work` → event surface `web`; channel `web`.

- [ ] **Step 1: Update tests** — expected matrices add `her_work`/`her_work_status` to screen/wx and a `work` row; `OWN_TOOL_NAMES` length updated; web fallback excludes worker/screen-only tools; worker restrict test (fish names hidden, host names kept).
- [ ] **Step 2: Implement wiring**.
- [ ] **Step 3: Run full `node --test`** in `src/dsh-fish`; expect green.
- [ ] **Step 4: Commit** — `feat(dsh-fish): wire work surface, tools, identity and pet state`.

### Task 7: WeChat dispatch and `notifyOwner`

**Files:**
- Modify: `src/dsh-wx/lib/index.js` (`wxService.notifyOwner`)
- Test: `src/dsh-wx/test/work-notify.test.mjs` (new) or existing test file.
- Modify: `~/.dsh-fish/config.json` (deployment): `work.wx.dispatchChats=['cat不到flag的cat']`, `ownerChat='cat不到flag的cat'`.

**Interfaces:**
- `wx.notifyOwner({ text, chat })` → `{ ok, why? }`; flatten newlines, ≤500 chars, `fishGuard.looksLikeSecret` hit → generic text, `withSendLock(() => sendToChat({chat,text}))`.

- [ ] **Step 1: Write tests** — flatten/truncate/secret fallback; send gate failure returned; target fixed to requested chat.
- [ ] **Step 2: Implement**; expose on `wxService`.
- [ ] **Step 3: Run `src/dsh-wx` tests**; expect green.
- [ ] **Step 4: Commit** — `feat(dsh-wx): add owner work notification`.

### Task 8: Presets, selfcheck, docs, deployment

**Files:**
- Modify: `~/.dsh/profiles/web/cordis.patch.yml` (deployment): insert `fish-work-boss`, `fish-work-inspect`, `fish-work-build`.
- Modify: `src/dsh-fish/lib/selfcheck.js` (work backend/preset/units/unknown).
- Modify: `src/dsh-fish/CHANGELOG.md`, `README.md`, `ARCHITECTURE.md` (status).
- Test: `src/dsh-fish/test/selfcheck-work.test.mjs`.

- [ ] **Step 1: Presets** — boss: persona/time-context/tool-todo/compaction; inspect: persona(executor)/agent-instructions/time-context/tool-fs(read only, readImage:false)/tool-fs-search/compaction; build: same + tool-fs write/edit + bash/pwsh with `enableRunInBackground:false`, `promoteOnTimeout:false`.
- [ ] **Step 2: Selfcheck** — report subagents availability, preset readiness, unit counts, unknown count; no secrets.
- [ ] **Step 3: Deploy** — merge branch to main, restart `dsh-web`, verify presets loaded and `her_work` available on screen/wx; run real pet/WeChat acceptance where possible.
- [ ] **Step 4: Docs/CHANGELOG** — record P1/P2 landed, P2 worker events and P3 agent boss deferred, G boundary.
- [ ] **Step 5: Commit and push** — push main; report SHA and verification boundary.

## Self-Review

- Spec coverage: look_screen; work面; WorkUnit; her_work/her_work_status/her_worker/her_worker_control/her_ask_user; work-guard G; worker presets; pet/微信前台; 受信闸; 目录祖先; 权限校验; 通知状态机; 对账; 事件面映射; 子代理适配层。P2 worker events / P3 agent boss intentionally deferred per spec recommendation.
- Type consistency: `WorkUnit.status` enum `queued|running|done|blocked|failed|aborted|unknown`; boss state `idle|running|waiting|unknown`; tool result keys match service methods.
- Review Focus tests are assigned to Tasks 4–6.
