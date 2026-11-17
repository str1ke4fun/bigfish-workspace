# 桌宠事件链二期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌宠在 activity 之外响应她的发言、被回复、作息、出门和日期，同时保持手动动作、presence、事件流易失和皮肤可替换。

**Architecture:** 服务端 `pet-view` 只维护 scene/cue 事实和手动状态；`/pet/state` 输出增量字段。皮肤侧解析独立 `triggers.json`，由纯 trigger-engine 决定动作，再复用一期播放状态机。

**Tech Stack:** Node 24、Electron/React、TypeScript、`dsh-pet-component 0.2.5`、`node:test`。

**Spec:** `docs/superpowers/specs/2026-11-16-pet-event-chain-design.md`

**Base:** `6503bcc`

## Global Constraints

- 不写 `events.jsonl`、不写台账、不调用模型。
- activity 现有六档和一期 action/menu/playback 不退化。
- `waiting > scene > 其他 activity > presence:thinking > idle`；ambient 只在无稳态时。
- 服务端只报事实，不接触素材名；trigger 在桌宠侧匹配。
- cue 最多 8 条、默认 TTL 15 秒、文本 120 字；离线过期不补播。
- 手动动作/显式用户动作优先于 cue；viewing tests must prove offline expiry.
- 余额不响应；余额素材只能继续手动演。
- Windows 视觉/点击/时序另做 manual gate，不能由 Node 测试冒充。

## Review Focus

- `waiting` 必须压住宿睡 loop，且结束后能恢复最新 scene。
- cue over rest 不改变 scene；rest click 不能触发拖动停止 sleep。
- 同一 turn 的 live speech 与 persisted utterance 不能播两次。
- trigger 文件缺失/单条错误不能破坏手动动作目录。
- 皮肤切换时旧 trigger 不能在新皮肤上重放。

---

### Task 1: triggers.json 解析与合并

**Files:**
- Create: `desktop-pet/electron/triggers.ts`
- Modify: `desktop-pet/electron/main.ts`, `electron/preload.ts`, `renderer/App.tsx`, `package.json`
- Create: `desktop-pet/assets/triggers.json`
- Test: `desktop-pet/test/triggers.test.ts`, `test/shell.test.ts`

**Interfaces:**
- Produces `TriggerDefinition`, `parseTriggers(raw,{actionIds,log})`, `mergeTriggers(defaults,skin)`, `readTriggerCatalog(...)`.
- 校验 when、pool、w、once、minGapSec、inAmbient；坏条目逐条丢弃。
- 同 `when` 皮肤覆盖默认，保持默认位置；新 when 追加；pool 内按注入随机源选择。

- [ ] 写失败测试覆盖合法/非法 trigger、权重、缺少动作、默认/皮肤覆盖、顺序稳定。
- [ ] 实现解析/合并与 IPC catalog push/get；加载失败保留上一份有效 trigger。
- [ ] 手动动作目录不受 trigger 错误影响。
- [ ] 运行桌面 trigger/shell 测试，提交。

### Task 2: pet-view scene/cues/rest override

**Files:**
- Modify: `src/dsh-fish/lib/pet-view.js`, `lib/observe.js`
- Test: `src/dsh-fish/test/pet-view.test.mjs`, `test/observe-pet.test.mjs`

**Interfaces:**
- `noteCue({id,kind,text,at,ttlMs})`，max 8，dedupe id，text 120。
- `setScheduleRest({rest,at})`、`setOuting({active,at})`、`setRestOverride('auto'|'sleep'|'wake')`。
- snapshot 增加 `scene`, `cues`，旧字段不变。
- `POST /pet/rest { action }` 仅用户显式调用。

- [ ] 写失败测试覆盖 cue 环形缓冲、过期、去重、scene 优先级 out>rest、手动 wake/sleep override。
- [ ] 实现纯内存状态和 REST 路由；不写事件。
- [ ] 运行 fish focused/full 测试，提交。

### Task 3: 真实事实源接线

**Files:**
- Modify: `src/dsh-fish/lib/index.js`, `lib/memory-service.js`, `lib/turnend.js`
- Test: `src/dsh-fish/test/memory-service.test.mjs`, `test/pet-event-sources.test.mjs`

**Interfaces:**
- `memory.onAppend(fn) -> off`，只在成功 append 后通知。
- assistant live speech → speak cue；同一 turn persisted utterance 去重。
- `bili_reply` → replied cue，以 event id 去重。
- Bili `session/event` turn/start/end → outing scene。
- 每分钟/状态组装时根据 `settings.inWindow` 更新 schedule rest。

- [ ] 写失败测试覆盖 append observer 成功/失败、reply cue、speech 单次、outing start/end、rest window。
- [ ] 实现观察器与接线；任何异常不得影响原事件写入。
- [ ] 运行 fish/bili focused 与全套，提交。

### Task 4: trigger engine 与三层优先级

**Files:**
- Create: `desktop-pet/renderer/trigger-engine.ts`
- Modify: `desktop-pet/renderer/controller.ts`
- Test: `desktop-pet/test/trigger-engine.test.ts`, `test/controller.test.ts`

**Interfaces:**
- `reduceTriggers({state,triggers,actions,seen,now,manualBusy,rng})` 输出 action/bubble/steady effects。
- 优先：manual/cue > waiting > scene transition > other activity transition > presence > idle > ambient。
- cue/activity/ambient/date 只一次性；scene enter 可 loop，scene exit 唤醒。
- cue 在 rest 中可播动作但不改变 scene；waiting 可临时压住 loop，解除后恢复。

- [ ] 写失败测试覆盖所有优先级 pair、transition-once、权重可复现、cue 与 scene 恢复。
- [ ] 实现纯 reducer，并复用一期 playback dispatch。
- [ ] 运行 controller/trigger tests，提交。

### Task 5: App/菜单/点击休息集成

**Files:**
- Modify: `desktop-pet/renderer/App.tsx`, `renderer/playback-adapter.ts`, `electron/menu-model.ts`, `electron/main.ts`
- Test: `desktop-pet/test/playback-adapter.test.ts`, `test/shell.test.ts`

**Interfaces:**
- trigger catalog 与 action catalog 分开存储；Seen 增加 bounded cue ids/occurrence keys。
- cue dispatch 前重查 TTL；presence.recent 不再独立触发同类 waving。
- 点击休息显示“在休息”，不打开聊天；拖动仍停止 loop。
- 菜单“睡觉/起来”调用 `/pet/rest`，并播放对应注册动作但不双触 scene trigger。

- [ ] 写失败测试覆盖 stale cue、rest click vs drag、manual sleep/wake、skin switch scene loop。
- [ ] 实现 UI/菜单/IPC 集成。
- [ ] 运行 desktop-pet tests，提交。

### Task 6: 日期与 ambient

**Files:**
- Modify: `desktop-pet/renderer/trigger-engine.ts`, `renderer/App.tsx`
- Test: `desktop-pet/test/trigger-engine.test.ts`, `test/triggers.test.ts`

**Interfaces:**
- date:MM-DD once per local day；ambient only when no steady/cue/manual。
- minGapSec per trigger；持久化 bounded date/ambient keys。
- ambient 默认不循环，quiet hours 由注入配置控制。

- [ ] 写失败测试覆盖本地日期、跨日、minGap、quiet hours、重启不重播、离线过期。
- [ ] 实现并接 UI。
- [ ] 运行全套测试，提交。

### Task 7: 真机验收与文档

**Files:**
- Modify: `desktop-pet/README.md`, `docs/superpowers/specs/2026-11-16-pet-event-chain-design.md`

**Interfaces:** none

- [ ] Windows 手测 activity/rest/waiting/out/cue/click/drag/skin/date/ambient/offline TTL。
- [ ] 记录透明、闪烁、点击穿透和 loop 恢复边界。
- [ ] 更新 README 的 triggers 格式与测试边界。
- [ ] 提交 final docs。
