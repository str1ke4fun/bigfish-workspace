# A0 + A1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `dev` 分支解掉 core 对 B 站的反向依赖，并让 `fishCore` 长出插件可用的记忆、策略、调度、处境与配置接口，同时把事件升到 v3。

**Architecture:** A0 只搬函数、不改行为；A1 先在 core 内实现窄接口与事件 v3，B 站代码仍留在 core，但改为走新接口。每个任务独立测试、独立提交，A2 搬包前接口冻结。

**Tech Stack:** Node.js 20+、原生 ESM、`node:test`、`node:assert`；零依赖。

**Spec:** `docs/superpowers/specs/2026-11-10-bili-workbench-integration-design-v2.md`

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 永远是 `{}`。
- `events.jsonl` 只追加；不删、不改、不重排；v3 迁移只在读路径补默认值。
- 原始经历层按 `channel` 隔离；学习层跨面共享，跨面渲染必须去引用化。
- 工具可见性只由 `tool-policy.js` 决定；`config.tools.allow` 只对 web 面兼容。
- `contribute` 只登记宿主已注册的工具；不放松发送闸、配额、guard。
- cookie/token 不进模型、投影、台账、日志；外来文本过 `sanitizeForeign`，发评论前过 `screenOutgoing`。
- UI 文案不出现男字旁的「他」、不出现「三道门/四道门」。
- 完整测试命令：`cd src/dsh-fish && node --test`；基线 813 pass。
- 提交前：只暂存本任务路径，跑 `git diff --cached --check` 与 `python scripts/audit-staged.py`。

## Review Focus

- 旧 v1/v2 事件没有 `surface` 时必须推断，不能拒读或丢事件。
- `contribute` 在首个 bili agent 之后到达时必须返回 pending，不能假装生效。
- `prompt.setWake` / `clearWake` 必须按 session 隔离，90 秒兜底不能清别的会话。
- 微信原话出现在信念里时，B 站 view 必须去引用化，纯想法保留。
- `owner.read()` 永不返回 cookie 原文，`credentials()` 不能被 `JSON.stringify` 序列化出明文。

---

### Task A0.1: 抽出 cookie 工具

**Files:**
- Create: `src/dsh-fish/lib/cookie.js`
- Modify: `src/dsh-fish/lib/owner.js:11-14,86-89`
- Modify: `src/dsh-fish/lib/bili.js:176-193`
- Test: `src/dsh-fish/test/cookie.test.mjs`

**Interfaces:**
- Produces: `export const COOKIE_NAMES`（`SESSDATA`、`bili_jct`、`buvid3`、`DedeUserID`、`DedeUserID__ckMd5`、`sid`）；`export function normalizeCookie(raw): string`。
- `owner.js` 与 `bili.js` 都从 `cookie.js` 取；`bili.js` 继续 re-export `normalizeCookie` 兼容旧测试。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCookie, COOKIE_NAMES } from '../lib/cookie.js'

test('normalizeCookie: Netscape cookies.txt', () => {
  const raw = '# Netscape\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc\n.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\tdef'
  assert.equal(normalizeCookie(raw), 'SESSDATA=abc; bili_jct=def')
})
test('normalizeCookie: 普通串原样保留', () => {
  assert.equal(normalizeCookie('SESSDATA=x; bili_jct=y'), 'SESSDATA=x; bili_jct=y')
  assert.equal(normalizeCookie(''), '')
})
test('COOKIE_NAMES 含登录必需两项', () => {
  assert.ok(COOKIE_NAMES.includes('SESSDATA'))
  assert.ok(COOKIE_NAMES.includes('bili_jct'))
})
```

- [ ] **Step 2: 运行确认失败** — `node --test test/cookie.test.mjs`，预期 `ERR_MODULE_NOT_FOUND`。
- [ ] **Step 3: 新建 `cookie.js` 并搬函数；改 `owner.js` / `bili.js` 的 import。**
- [ ] **Step 4: 跑 `node --test test/cookie.test.mjs test/owner.test.mjs`（若 owner 测试名不同，跑 `node --test test/*owner*`），全绿。**
- [ ] **Step 5: 提交** — `git add src/dsh-fish/lib/cookie.js src/dsh-fish/lib/owner.js src/dsh-fish/lib/bili.js src/dsh-fish/test/cookie.test.mjs && git commit -m "refactor(dsh-fish): 抽出 cookie 工具，断开 owner→bili 反向依赖"`。

---

### Task A0.2: 抽出相似度与回声

**Files:**
- Create: `src/dsh-fish/lib/similarity.js`
- Modify: `src/dsh-fish/lib/derive.js:13,184-205`
- Modify: `src/dsh-fish/lib/voices.js:22-41,49-66,176-195`
- Test: `src/dsh-fish/test/similarity.test.mjs`

**Interfaces:**
- Produces: `similarity(a,b)`、`normVoice(text)`、`findEcho(voice, events)`、`VOICE_FRESH_DAYS=7`、`ECHO_WINDOW_MS`、`ECHO_MIN_SIM`。
- `derive.js` 从 `similarity.js` import 并继续 `export { similarity }`。
- `voices.js` 从 `similarity.js` import 并 re-export `normVoice` / `findEcho` / `VOICE_FRESH_DAYS`，保持旧调用与测试不变。
- 搬完 `derive.js` 不再 import `voices.js`，`voices.js` 不再 import `derive.js`。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { similarity, normVoice, findEcho } from '../lib/similarity.js'

test('similarity: 相同为 1，空为 0', () => {
  assert.equal(similarity('abc', 'abc'), 1)
  assert.equal(similarity('', 'x'), 0)
})
test('normVoice: 去 URL / @ / 标点', () => {
  assert.equal(normVoice('@a 你好 https://x.test ！'), '你好')
})
test('findEcho: 只在评论之后找相似的话', () => {
  const voice = { id: 'v1', at: '2026-11-10T00:00:00.000Z', text: '今天真冷' }
  const events = [
    { id: 'v1', type: 'voice', ts: voice.at, text: voice.text },
    { id: 'u1', type: 'utterance', ts: '2026-11-10T00:01:00.000Z', text: '今天真冷啊' },
  ]
  assert.equal(findEcho(voice, events)?.id, 'u1')
})
```

- [ ] **Step 2: 运行确认失败** — `node --test test/similarity.test.mjs`。
- [ ] **Step 3: 新建 `similarity.js`，搬 `similarity`、`normVoice`、`findEcho` 与常量；改 `derive.js` / `voices.js` import 与 re-export。**
- [ ] **Step 4: 跑 `node --test test/similarity.test.mjs test/derive.test.mjs test/voices.test.mjs`，全绿。**
- [ ] **Step 5: 提交** — `git add src/dsh-fish/lib/similarity.js src/dsh-fish/lib/derive.js src/dsh-fish/lib/voices.js src/dsh-fish/test/similarity.test.mjs && git commit -m "refactor(dsh-fish): 抽出相似度与回声，断开 derive↔voices 循环"`。

---

### Task A0.3: 依赖边界测试、README 与基线

**Files:**
- Create: `src/dsh-fish/test/dependency-boundary.test.mjs`
- Modify: `README.md`（「本辑只做…」段与代码结构表）
- Modify: `docs/superpowers/specs/2026-11-10-bili-workbench-integration-design-v2.md`（状态改为「A0 已实施」）

**Interfaces:**
- 测试断言：`owner.js` 不含 `from './bili.js'`；`derive.js` 不含 `from './voices.js'`；`voices.js` 不含 `from './derive.js'`。

- [ ] **Step 1: 写边界测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const src = (f) => readFileSync(new URL(`../lib/${f}`, import.meta.url), 'utf8')
test('A0: owner 不再依赖 bili', () => assert.ok(!/from ['"]\.\/bili\.js['"]/.test(src('owner.js'))))
test('A0: derive 与 voices 不再互相依赖', () => {
  assert.ok(!/from ['"]\.\/voices\.js['"]/.test(src('derive.js')))
  assert.ok(!/from ['"]\.\/derive\.js['"]/.test(src('voices.js')))
})
```

- [ ] **Step 2: 跑新测试确认失败**（如果 A0.1/A0.2 已完成则应直接通过；先写测试再确认它确实检查到边）。
- [ ] **Step 3: 更新 README：把「出门会话已落地、拆包/v3 未做」写成当前事实；代码结构表加 `ARCHITECTURE.md` 链接。**
- [ ] **Step 4: 跑全量 `node --test`，预期 813 + 新用例全绿。**
- [ ] **Step 5: 提交** — 只暂存 README、design v2、边界测试。

---

### Task A1.1: 事件 v3 与 surface 推断

**Files:**
- Modify: `src/dsh-fish/lib/schema.js`（`EVENT_SCHEMA_VERSION`、`ALL_TYPES`、`surface`、`reply`、`inferSurface`、`BILI_META_PREFIXES`）
- Modify: `src/dsh-fish/lib/store.js`（读路径补 `surface`）
- Modify: `src/dsh-fish/lib/events.js`（登记 `bili_reply`）
- Test: `src/dsh-fish/test/schema-v3.test.mjs`

**Interfaces:**
- `EVENT_SCHEMA_VERSION = 3`。
- `SURFACES = ['core','web','wx','qq','bili']`。
- `inferSurface(event): string`，按设计 §5.4。
- `validateEvent` 写路径：`raw.surface` 合法才采用，未知抛 `BAD_SURFACE`；`bili_reply` 缺 `reply.bvid/rpid` 抛 `BAD_REPLY`。
- `readEvents` 返回的每条事件都有 `surface`（推断值，不回写）。

- [ ] **Step 1: 写失败测试**

```js
test('v3: 合法 surface 往返', () => {
  const ev = validateEvent({ type: 'saw', text: 'x', surface: 'bili' }, { source: 'system' })
  assert.equal(ev.v, 3); assert.equal(ev.surface, 'bili')
})
test('v3: 未知 surface 拒绝', () => {
  assert.throws(() => validateEvent({ type: 'saw', text: 'x', surface: 'nope' }, { source: 'system' }), /BAD_SURFACE/)
})
test('v3: bili_reply 结构化去重键', () => {
  const ev = validateEvent({ type: 'bili_reply', text: '回了', surface: 'bili', reply: { bvid: 'BV1', rpid: '42' } }, { source: 'system' })
  assert.equal(ev.reply.rpid, '42'); assert.equal(ev.channel, 'core')
})
test('v3: 旧事件推断 surface', () => {
  assert.equal(inferSurface({ channel: 'wx', type: 'utterance' }), 'wx')
  assert.equal(inferSurface({ channel: 'core', type: 'saw', refs: ['BV1'] }), 'bili')
  assert.equal(inferSurface({ channel: 'core', type: 'meta', text: 'browse:2026-11-10 3' }), 'bili')
  assert.equal(inferSurface({ channel: 'core', type: 'meta', text: 'fired:x' }), 'core')
})
test('v3: v2 读者跳过 v3', async () => {
  // 写一条 v:3 到临时 events.jsonl，用 readEvents 读到；再把 EVENT_SCHEMA_VERSION 视为 2 的等价逻辑由 store.newer 计数覆盖
})
```

- [ ] **Step 2: 运行确认失败** — `node --test test/schema-v3.test.mjs`。
- [ ] **Step 3: 改 schema.js；`BILI_META_PREFIXES` 放 schema.js 并导出；store.js 读路径调用 `inferSurface`；events.js 的目录/类型登记补 `bili_reply`。**
- [ ] **Step 4: 跑 `node --test test/schema.test.mjs test/schema-v3.test.mjs test/store.test.mjs`，全绿。**
- [ ] **Step 5: 提交**。

---

### Task A1.2: `fishCore.memory`

**Files:**
- Create: `src/dsh-fish/lib/memory-service.js`
- Modify: `src/dsh-fish/lib/core-service.js`（挂 `memory`）
- Test: `src/dsh-fish/test/memory-service.test.mjs`

**Interfaces:**
- `createMemoryService({ root, core, refreshSelfDoc })` 返回设计 §5.5 的九个方法。
- `append(raw, opts)` 不抛，返回 `{ok,event?,why?}`；`source` 默认 `system`；`source:'tool'` 只允许 `HER_TYPES`。
- `channel` 优先级：`opts.channel` > `channelOfAgent(opts.agent)` > `core`；`surface` 同理，`agent` 推断用 `core.surface.current`。
- `read({since,until,types,channel,surface,limit=200,includeMeta=false})` 默认排除 `meta`。
- `commit(text,{type='utterance',refs,verdict,confidence,agent})` 固定 `source:'tool'`。
- `appendSystem(type,text,opts)` 固定 `source:'system'`。

- [ ] **Step 1: 写失败测试**（临时 root，调用 append/commit/read；断言 v3、channel、surface、meta 默认排除、非法类型返回 ok:false 不抛）。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现 `memory-service.js` 并在 `core-service.js` 挂上；`refreshSelfDoc` 用注入函数，避免 core-service 直接 import selfdoc。**
- [ ] **Step 4: 跑新测试 + `test/core-service.test.mjs`。**
- [ ] **Step 5: 提交**。

---

### Task A1.3: 派生事实与跨面去引用化

**Files:**
- Modify: `src/dsh-fish/lib/derive.js`（`biliSaid` / `biliReplies` / `biliThreads` / `originChannel` / `sharedBeliefs`）
- Modify: `src/dsh-fish/lib/guard.js`（`crossChannel`）
- Modify: `src/dsh-fish/lib/selfdoc.js`（信念渲染走 `crossChannel`）
- Test: `src/dsh-fish/test/cross-channel.test.mjs`

**Interfaces:**
- `guard.crossChannel(text, { from, to, rawTexts }) -> { text, redacted, why }`，规则按设计 §5.6。
- `deriveSelf(events, { viewSurface })` 的 `beliefs[].originChannel` 来自产生该信念的 `utterance/revise.channel`。
- `sharedBeliefs` 已按 `viewSurface` 去引用化；`biliSaid`/`biliReplies` 最多 5 条、不进 beliefs。

- [ ] **Step 1: 写隐私测试**：一条 `channel:'wx'` 的 utterance 含「我闺蜜叫小美」→ `deriveSelf(events,{viewSurface:'bili'}).sharedBeliefs` 不含「小美」；一条纯想法「我觉得人应该先照顾好自己」保留。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现 `crossChannel` 与 derive 字段；selfdoc 只在渲染跨面信念时调用。**
- [ ] **Step 4: 跑 `test/cross-channel.test.mjs test/derive.test.mjs test/selfdoc.test.mjs`。**
- [ ] **Step 5: 提交**。

---

### Task A1.4: 工具策略贡献

**Files:**
- Modify: `src/dsh-fish/lib/tool-policy.js`（贡献表、`contribute`、`ownTools`、`status`）
- Modify: `src/dsh-fish/lib/restrict.js`（`ownTools` 动态）
- Modify: `src/dsh-fish/lib/index.js`（把贡献接口挂到 `fishCore.toolPolicy`）
- Test: `src/dsh-fish/test/tool-policy-contribute.test.mjs`

**Interfaces:**
- `contribute({ id, tools, groups=[] }, { hostNames, surface='bili' }) -> { ok, off, why?, pending? }`。
- 校验：名字重复、跨面、不在 `hostNames`、`surface` 不存在 → 整次拒绝，返回 `why`。
- 晚于 bili agent 创建 → `{ok:false, why:'LATE_CONTRIBUTION', pending:true}`。
- `ownTools()` 返回内置 `FISH_TOOLS` + 当前贡献名；`restrict.js` 不再写死 B 工具。

- [ ] **Step 1: 写测试**：贡献 3 个名字后 `resolveAllow({surface:'bili'})` 含 8 个；撤销后回到 5 个；未注册名字整次拒绝；重复贡献幂等。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现贡献表并改 restrict 的默认 `ownTools`。**
- [ ] **Step 4: 跑 `test/tool-policy-contribute.test.mjs test/tool-exposure.test.mjs test/restrict.test.mjs`。**
- [ ] **Step 5: 提交**。

---

### Task A1.5: 调度钩子 `onTick` / `onWake`

**Files:**
- Create: `src/dsh-fish/lib/schedule-hooks.js`
- Modify: `src/dsh-fish/lib/scheduler.js`
- Modify: `src/dsh-fish/lib/core-service.js`（挂 `schedule`）
- Modify: `src/dsh-fish/lib/index.js`（把 `schedule` 传给 scheduler）
- Test: `src/dsh-fish/test/schedule-hooks.test.mjs`

**Interfaces:**
- `createScheduleHooks({ log })` 返回 `{ onTick, onWake, runTick, runWake, status, dispose }`。
- `onTick({id, everyMs=0, order=0, fn})` / `onWake({id, order=0, fn})` 返回 disposer。
- `runTick(ctx)` 按 order 串行；单钩子抛错只记日志；`everyMs` 是至少间隔；返回 `{changed:boolean}`。
- `runWake(ctx)` 只在真要唤醒时调用一次，返回合并后的 `{text,intro,picks,riskNote}`。
- scheduler 顺序：`detectAbsence → runTick → ensureSchedule → inWindow → plan → runWake → wake`。

- [ ] **Step 1: 写测试**：两个钩子按 order 跑、第一个抛错不影响第二个、`everyMs` 跳过、`changed:true` 触发重读。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现 `schedule-hooks.js`；scheduler 改调 `runTick` / `runWake`，删除直接 `backgroundBrowse` / `maybeOuting` / `lookBeforeWake`（A1 阶段先由 core 自己注册钩子，行为不变）。**
- [ ] **Step 4: 跑 `test/schedule-hooks.test.mjs test/scheduler.test.mjs`。**
- [ ] **Step 5: 提交**。

---

### Task A1.6: `prompt` 与 `sessions`

**Files:**
- Create: `src/dsh-fish/lib/prompt-service.js`
- Create: `src/dsh-fish/lib/session-service.js`
- Modify: `src/dsh-fish/lib/core-service.js`
- Modify: `src/dsh-fish/lib/index.js`
- Test: `src/dsh-fish/test/prompt-sessions.test.mjs`

**Interfaces:**
- `createPromptService({ root, log })`：`setWake(sessionId,text)`、`clearWake(sessionId)`、`getWake(sessionId)`、`wakeSectionFor(agent)`、`withWake(fn)`、`watchTurnEnd(sessionId,fn)`、`section({id,order,surface,render})`。
- `createSessionService({ ctx, surface, root, log })`：`create({title,cwd,preset,surface,agentId})`、`find({title,surface})`、`prompt(sessionId,text,{signal})`、`rename`、`list`。
- `create` 内部 `surface.reserve(id,surface)`；`sessionController` 缺席返回 `{ok:false, why:'NO_SESSION_CONTROLLER'}`。

- [ ] **Step 1: 写测试**：两条 session 的 wake 段互不串；`clearWake(a)` 不清 b；section 只对匹配面渲染；sc 缺席降级。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现两个 service，包装 `identity.js` / `turnend.js`，在 `core-service` 挂上。**
- [ ] **Step 4: 跑新测试 + `test/identity.test.mjs test/outing.test.mjs`。**
- [ ] **Step 5: 提交**。

---

### Task A1.7: `config` / `owner` / `toolLedger` / `self`

**Files:**
- Create: `src/dsh-fish/lib/owner-service.js`
- Modify: `src/dsh-fish/lib/core-service.js`
- Modify: `src/dsh-fish/lib/index.js`（挂 ledger/self）
- Modify: `src/dsh-fish/lib/settings.js`（LIMITS 补 `browse.rankingTids`、`video.enabled`/`video.ocr` 布尔、`browse.keywords` 数组）
- Test: `src/dsh-fish/test/core-services.test.mjs`

**Interfaces:**
- `config.get/getView('bili')/patch/onChange`，`persona` 不在白名单。
- `owner.read()` 返回 `publicOwner`；`credentials()` 返回 `CredentialHandle`，`JSON.stringify` 为 `"[redacted]"`；`write` 0600；`mentionPrefix()`。
- `toolLedger.status/read/artifact`，artifact 只允许 `tool-ledger/artifacts/` 前缀。
- `self.identity({surface})/refresh()`。

- [ ] **Step 1: 写测试**：`config.patch({persona:'x'})` 拒绝；`getView('bili').browse` 与顶层双读一致；`JSON.stringify(owner.read())` 不含 cookie；`JSON.stringify(credentials())` 不含明文；artifact 穿越拒绝。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 实现 owner-service 与 core 挂载；settings 补 LIMITS；ledger/self 在 index 接线。**
- [ ] **Step 4: 跑新测试 + `test/settings.test.mjs test/owner.test.mjs test/tool-ledger.test.mjs`。**
- [ ] **Step 5: 提交**。

---

### Task A1.8: B 站路径改走新接口

**Files:**
- Modify: `src/dsh-fish/lib/browse.js`（`recordSaw` → `memory.appendSystem('saw',...)`）
- Modify: `src/dsh-fish/lib/voices.js`（`recordVoice` → `memory.appendSystem('voice',...)`）
- Modify: `src/dsh-fish/lib/speak.js`（成功 → `memory.commit` + `my:`）
- Modify: `src/dsh-fish/lib/comment.js`（`scanReplies` → `bili_reply` + 三态）
- Modify: `src/dsh-fish/lib/watch.js`（成功 → `saw`）
- Modify: `src/dsh-fish/lib/outing.js`（`prompt.setWake` / `sessions`）
- Test: `src/dsh-fish/test/memory-closed-loop.test.mjs`

**Interfaces:**
- 所有写入走 `core.memory`，不直接 `appendEvent`（meta 记账可保留 `appendEvent`）。
- `bili_speak` 成功：一条 `utterance(surface='bili',channel='core')` + `my:<rpid>`；失败不写。
- `scanReplies`：新回复一条 `bili_reply`；投递成功写 `cseen`；`postReply` 成功写 `creply`。
- 旧 `cseen` 按已回读；新 `cseen` 按已呈现读。

- [ ] **Step 1: 写测试**：同一 fixture 一条评论 → 一条 utterance；一条回复 → 一条 bili_reply；重复扫描不重复写；投递失败不写 cseen。
- [ ] **Step 2: 运行确认失败。**
- [ ] **Step 3: 改各模块，保留旧 meta 记账。**
- [ ] **Step 4: 跑新测试 + `test/browse.test.mjs test/speak.test.mjs test/comment.test.mjs test/watch.test.mjs test/outing.test.mjs`。**
- [ ] **Step 5: 提交**。

---

### Task A1.9: 迁移说明、版本与全量验收

**Files:**
- Modify: `src/dsh-fish/package.json`（0.7.0 → 0.8.0）
- Modify: `src/dsh-fish/lib/index.js`（VERSION）
- Modify: `CHANGELOG.md`
- Modify: `src/dsh-fish/AGENTS.md`（基线数更新；若新增测试数变化）
- Test: 全量 + `test/integration-memory-v3.test.mjs`

**Interfaces:**
- CHANGELOG 写清：v3 字段、旧事件推断、回退会跳过 v3、备份要求。
- 集成测试：同一 fixture 走旧路径与新路径，事件类型序列一致；微信原话不进 bili view。

- [ ] **Step 1: 写集成测试并确认失败。**
- [ ] **Step 2: 升版本、写 CHANGELOG、更新 AGENTS 基线。**
- [ ] **Step 3: 跑全量 `node --test`，记录 pass 数与耗时。**
- [ ] **Step 4: 跑 `python scripts/audit-staged.py` 与 `git diff --cached --check`。**
- [ ] **Step 5: 提交**（只暂存本任务路径）。

---

## 完成后

- A1 合并后冻结接口；A2 另写计划，不把搬包塞进本计划。
- 8720 dev 实例在 A1 验收前启动，使用独立 `DSH_FISH_HOME`。
- 报告分开写：本地测试、提交 SHA、推送、WSL 拉取、运行验证。
