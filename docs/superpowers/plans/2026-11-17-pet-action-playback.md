# 桌宠动作播放层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「演一个动作」可播放已登记的 114 段本地动画，并支持一次性、顺序、持续循环、抢占、停止、重新载入和 `/pet/act` action id，同时保持现有 14 个组件动作和桌宠稳态行为兼容。

**Architecture:** 动作槽是播放通道。主进程维护动作注册表并上报 `hello`；渲染进程用纯状态机把注册表动作映射到保留槽 `waving`，通过 `pet.motion()` 播放，并用 `onMotionChange` / `onAnimationChange` 推进和恢复。服务端只保存动作 id 清单，不接触素材名。

**Tech Stack:** Electron 43、React 19、TypeScript、`dsh-pet-component 0.2.5`、Node `node:test --experimental-strip-types`、零新增依赖。

**Spec:**
- `docs/superpowers/specs/2026-11-16-pet-event-chain-design.md`
- `docs/superpowers/reviews/2026-11-17-diegetic-feedback-and-pet-requirements.md`

## Global Constraints

- 不 fork `dsh-pet-component`；只使用公开 `PetRef` API 和现有 props。
- 不引入上游人设、对话、记忆、余额状态或模型调用。
- 动作/评论状态易失，不写 `events.jsonl`、不写台账；一期不接事件 cue。
- webm 素材不进 Git；`assets/actions.json`、工具脚本、测试和文档进 Git。
- “常用”保留原 7 个 motion：`waving, thinking, working, result, waiting, success, error`。
- “状态”包含其余 7 个 motion：`idle, turn, moving-left, moving-right, running, review, failed`。
- 自定义动作只允许最近一次成功 `hello` 上报的 id；未知/空 id 返回 400，旧 `{ motion }` 继续有效。
- 同一时刻只允许一个借用槽；循环动作是持续状态，必须显式停止或抢占。
- presence 继续遵守现有 `presence.on -> thinking`；一期不改 `/pet/state.activity` 和事件源。
- 素材 MANUAL 验证边界：Node 测试不能证明透明、闪烁、指针穿透或视频解码正确。

## Review Focus

- 连续快速触发两个自定义动作时，旧 generation 的恢复回调不能覆盖新动作。
- `loop:true` 动作在 activity/presence 更新时不能因 `motion` prop 改变被组件静默清除。
- `dragging=true` 本身不会清除组件的 loop override；App 必须显式停止。
- `seq` 段切换不能长时间露出稳态画面，且最后一段 loop 后保持，非 loop 后恢复。
- 未登记素材不可通过 `/pet/act` 或菜单出现，不能把文件名当 action id 猜。

## Preflight Gate

- [ ] G-02/G-03 在 Windows 真机做最小实验：借用槽 config 替换、`onMotionChange`、`onAnimationChange`、activity 变化、拖动和 skin 切换。
- [ ] 若实验证明 config 替换会打断稳态，Task 3/6 改用预写动画池或独立视频层；不得把视觉缺陷留给发布验收。
- [ ] 实验结论写入本轮 SDD ledger；Node 实现可先做纯模块和协议，但不得宣称 Windows 播放层验收完成。

---

### Task 1: 服务端 action-id 协议

**Files:**
- Modify: `src/dsh-fish/lib/pet-view.js`
- Modify: `src/dsh-fish/lib/observe.js`
- Test: `src/dsh-fish/test/pet-view.test.mjs`
- Test: `src/dsh-fish/test/observe-pet.test.mjs`

**Interfaces:**
- Produces: `noteHello({ version, skins, actions }, at)`；`actions` 只接受 `{ id, label, group }`，按 id 去重/排序/限制 256 条。
- Produces: `act({ motion, text, ttlMs })` 保持旧行为。
- Produces: `act({ action, text, ttlMs })` 接受最近成功 hello 中的 action id，并返回 `{ action: { id, action, text?, at, ttlMs } }`。
- Produces: `/pet/act` 同时接受 `motion` 或 `action`；两者都给或都给空时 400。

- [ ] 写失败测试：hello 记录 action ids，前后重复 id 以后者为准，超过 256 截断，非法 actions 清空旧目录。
- [ ] 写失败测试：合法 action 生成 action 事件；未知 action 失败且不覆盖旧 action；旧 motion 仍成功。
- [ ] 写失败测试：`/pet/hello` 转发 actions，`/pet/act { action }` 成功/未知 action/双字段分别返回预期状态。
- [ ] 实现 `pet-view` action 目录与 union 校验；不把动作目录暴露到 `/pet/state`。
- [ ] 实现 `observe` 透传与 400 分支；不新增 BFF 路由，不写事件流。
- [ ] 运行 `node --test test/pet-view.test.mjs test/observe-pet.test.mjs`，再运行 `src/dsh-fish` 的 `node --test`。
- [ ] 提交：`feat(dsh-fish): accept pet action ids from the desktop shell`。

### Task 2: 动作注册表解析与合并

**Files:**
- Create: `desktop-pet/electron/actions.ts`
- Modify: `desktop-pet/package.json`
- Test: `desktop-pet/test/actions.test.ts`

**Interfaces:**
- Produces: `ActionDefinition = { id, label, anim?, seq?, loop, group }`。
- Produces: `parseActions(raw, { mediaDir, exists, log }) -> { actions, errors }`；单条坏动作丢弃，不拒绝整份文件。
- Produces: `mergeActionCatalogs(defaults, skin)`；同 id 按文件顺序后者覆盖前者。
- Produces: `actionAnimationNames(action) -> string[]`。

- [ ] 把 `desktop-pet/test/actions.test.ts` 加入 `package.json` 的测试列表。
- [ ] 写失败测试：合法 anim/seq、anim+seq 同时出现、缺 label、非法 id、路径穿越、缺失 webm、重复 id、skin 覆盖。
- [ ] 实现纯解析器和合并器；`anim` 与 `seq` 严格二选一，`seq` 非空且每段存在。
- [ ] 保证缺省 `group` 为“其他”，缺省 `loop` 为 false，输出顺序稳定。
- [ ] 运行 `node --test --experimental-strip-types test/actions.test.ts`。
- [ ] 提交：`feat(desktop-pet): parse and merge action registries`。

### Task 3: 纯播放状态机

**Files:**
- Modify: `desktop-pet/renderer/controller.ts`
- Test: `desktop-pet/test/controller.test.ts`

**Interfaces:**
- Produces: `PlaybackState`，状态限 `idle | playing-once | playing-seq | holding-loop | restoring`。
- Produces: `reducePlayback(state, event, { actions, steady, now }) -> { state, effects }`。
- Produces effects：`bind-slot`、`play-motion`、`clear-motion`、`restore-slot`。
- Produces: `startAction`, `stopAction`, `motionChanged`, `animationChanged`, `steadyChanged`, `dragStarted`, `skinChanged` 事件处理。

- [ ] 写失败测试：一次性动作从开始到恢复；顺序动作逐段推进；最后 loop 保持。
- [ ] 写失败测试：新动作抢占、stop、拖动、skin 切换、activity 更新都保留最新 steady。
- [ ] 写失败测试：旧 generation 的动画完成/恢复事件被忽略。
- [ ] 实现五状态 reducer；借用槽固定为 `waving`，恢复时输出最新 steady 的 mapping。
- [ ] `onAnimationChange` 只认可 `once:true` 的目标动画结束；不增加固定时长 timer。
- [ ] 保持 `performedMotion()` 和现有 one-shot effect API 向后兼容。
- [ ] 运行 `node --test --experimental-strip-types test/controller.test.ts`。
- [ ] 提交：`feat(desktop-pet): add manual playback state machine`。

### Task 4: 分组菜单模型

**Files:**
- Modify: `desktop-pet/electron/menu-model.ts`
- Test: `desktop-pet/test/shell.test.ts`

**Interfaces:**
- Produces: `buildMenuModel(state, actions, callbacks)`，动作清单从参数读取而不是硬编码。
- Produces callbacks：`motion`, `action`, `stop`, `reload`。

- [ ] 写失败测试：常用 7 项、状态 7 项、注册表 group 二级菜单、空 group、重复 label、stop/reload。
- [ ] 实现菜单构建；无“未登记”分组，顺序稳定。
- [ ] 保持现有陪看、外观和其他菜单行为不变。
- [ ] 运行 `node --test --experimental-strip-types test/shell.test.ts`。
- [ ] 提交：`feat(desktop-pet): group manual actions from the registry`。

### Task 5: 主进程与 preload 桥接

**Files:**
- Modify: `desktop-pet/electron/main.ts`
- Modify: `desktop-pet/electron/preload.ts`
- Test: `desktop-pet/test/shell.test.ts`

**Interfaces:**
- Produces: `pet:action` payload `{ motion: string } | { action: string }`。
- Produces: `pet:action-catalog` push/get，`pet:action-stop`，`pet:actions-reload`。
- Produces: `hello.actions = [{ id, label, group }]`；重载/skin 切换成功后立即 hello。

- [ ] 写失败测试：菜单 payload、catalog 推送、stop、reload、hello 字段和旧 motion 兼容。
- [ ] 主进程启动时加载 default + active skin actions，保存当前 catalog。
- [ ] 重载动作只读磁盘并在成功后推 renderer、重建菜单、立即 hello；失败保留旧 catalog 并提示。
- [ ] skin 切换前先向 renderer 发停止通知，再应用新 skin 和 catalog。
- [ ] preload 暴露 catalog/stop/reload API；保持 contextIsolation 和现有桥接风格。
- [ ] 运行 `node --test --experimental-strip-types test/shell.test.ts`。
- [ ] 提交：`feat(desktop-pet): bridge registered actions through Electron`。

### Task 6: App/Pet 播放集成

**Files:**
- Create: `desktop-pet/renderer/playback-adapter.ts`
- Modify: `desktop-pet/renderer/App.tsx`
- Modify: `desktop-pet/package.json`
- Test: `desktop-pet/test/playback-adapter.test.ts`

**Interfaces:**
- Consumes: Task 1 action payload，Task 2 `ActionDefinition`，Task 3 reducer，Task 5 bridge。
- Produces: App-owned `actionCatalog`、`playbackState`、frozen steady while loop、config clone per borrowed mapping。
- Produces: `onMotionChange` / `onAnimationChange` dispatch into reducer；drag/skin switch explicit stop。
- Produces: `borrowActionConfig(config, action, slot)`、`restoreActionConfig(config, slot)`、`petMotionProp(playback, latestSteady)`。

- [ ] 把 `desktop-pet/test/playback-adapter.test.ts` 加入 `package.json` 测试列表。
- [ ] 写失败测试：config 只改 `waving`、原 mapping 可恢复、holding-loop 冻结 motion prop、stop 后使用最新 steady。
- [ ] 在 App 订阅 catalog，并把旧 `onAction` 字符串兼容为 `{ motion }`。
- [ ] 用 reducer effects 生成借用槽 config；只修改 `config.motions.waving`，其余 config 不改。
- [ ] `holding-loop` 期间冻结 `<Pet motion>` 的最新值，避免 prop 变化清除 loop override。
- [ ] 拖动开始、skin 切换、skin 失败、stop 按钮和 reload 都先让当前 generation 失效。
- [ ] 一次性动作完成后恢复 borrowing slot，并落到 reducer 保存的最新 steady。
- [ ] `onAnimationChange` 仅在 expected once animation 结束并切到不同动画时推进；不能用固定 sleep/timer。
- [ ] 运行 `node --test --experimental-strip-types test/playback-adapter.test.ts`、`npm test` 和 `npm run build`；若本地无 node_modules/assets，记录为环境边界。
- [ ] 提交：`feat(desktop-pet): play registered one-shot and looping actions`。

### Task 7: 114 段动作注册表与素材工具

**Files:**
- Create: `desktop-pet/assets/actions.json`
- Modify: `desktop-pet/scripts/check-assets.mjs`
- Modify: `desktop-pet/scripts/sync-assets.mjs`
- Modify: `desktop-pet/test/config.test.ts`
- Modify: `desktop-pet/README.md`
- Modify: `desktop-pet/assets/ATTRIBUTION.md`

**Interfaces:**
- Produces: 稳定的 `asset-NNN` action ids；`sleep` 使用 `["睡觉-开始", "睡觉-循环"]` seq + `loop:true`，`wake` 使用 `睡觉-起来`。
- Produces: `actions.json` 中每个 `anim` / `seq` 都指向本机 webm 文件名；114 个 webm 全部被至少一个 action 引用。
- Produces: check/sync 脚本识别 actions.json 的 anim/seq，而不仅 config.motions。
- Group 规则：`睡觉*` → 休息；`点击回应*`、`被鼠标拖拽*` → 回应；`工作状态*`、`写代码`、`碎碎念*` → 工作；节日素材 → 节日；`余额*` → 其他；其余 → 日常。

- [ ] 从 `/mnt/d/bigfish-desktop-pet/assets/webm` 的 114 个文件名生成稳定 actions.json；label 用中文文件名，group 使用“日常/回应/工作/休息/节日/其他”。
- [ ] 余额类素材只能作为手动动画保留在“其他”，不新增余额状态、接口或 trigger。
- [ ] 写测试：114 个文件名覆盖、睡眠 seq、id 稳定、label/group 非空、无重复 id。
- [ ] 更新 check/sync 脚本，缺失引用明确报错；素材仍不进 Git。
- [ ] README 写清注册、重载、循环、seq、停止、分组和 Windows 真机验收边界。
- [ ] 更新 ATTRIBUTION 来源版本到实际素材版本。
- [ ] 运行 `npm test`、`node scripts/check-assets.mjs`（有本地素材时）和 `npm run build`（有 node_modules 时）。
- [ ] 提交：`feat(desktop-pet): register the full manual animation catalog`。

## Final Verification

- [ ] `cd src/dsh-fish && node --test` -> 全绿。
- [ ] `cd desktop-pet && npm test` -> 全绿。
- [ ] 有 node_modules 时运行 `npm run build`。
- [ ] 有本地素材时运行 `node scripts/check-assets.mjs`，确认 114 段全部被引用。
- [ ] Windows 真机逐项验收：透明、闪烁、一次性、seq、loop、stop、抢占、拖动、skin 切换、activity 变化、`/pet/act { action }`。
- [ ] 分别报告单测、构建、Windows 真机、部署/运行状态；不得把单测或菜单可点说成动作播放已验收。
