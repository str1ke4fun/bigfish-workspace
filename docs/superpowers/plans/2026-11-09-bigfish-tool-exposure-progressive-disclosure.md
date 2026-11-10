# 大肥鱼工具暴露与渐进披露实施计划（第一辑：Web/WX 先行）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把“一张全局 allow 名单 + 所有面共用”改成“按面判定 + 一张显式策略表 + always/deferred 按需揭示”，并给所有工具调用补上完整台账与选择性模型投影；先在 Web/WX 落地，QQ/B 站只留策略入口，不改事件流、不改部署线。

**Architecture:** 在 `dsh-fish` 新增 `surface.js`（面注册/预分配/判定）、`tool-policy.js`（唯一可见性来源）、`tool-result.js`（统一信封 + 投影）、`tool-ledger.js`（只读观察 `tools/result` 的完整台账）、`tools.js`（`her_tools`）。`restrict.js` 改成“按 surface 解析 allow + 每个 agent 可变 revealed + guard 读同一个 Set”。`dsh-wx` 在建会话前预分配 session id 并登记 surface，关键工具通过 `fishCore.tools.wrap` 使用统一投影。所有工具调用由 `tools/result` 观察者写台账，监听器永不改变工具结果。

**Tech Stack:** Node.js 24、`node:test`、DSH 0.2.1-rc.5 既有接口：`ctx.tools.register/restrict/guard/view`、`tools/pre-execute`、`tools/post-execute`、`tools/result`、`agent/created`、`agent/pre-step`、`sessionController.create({ sessionId })`。

**Spec:**
- `docs/superpowers/specs/2026-11-09-bigfish-tool-exposure-top-level-design.md`
- `docs/superpowers/specs/2026-11-09-bigfish-person-core-surfaces-design.md`
- `docs/superpowers/specs/2026-11-09-bigfish-tool-return-contract-design.md`

## Global Constraints

- `src/dsh-fish/package.json` 和 `src/dsh-wx/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 必须始终是 `{}`。
- 本计划**不改** `EVENT_SCHEMA_VERSION`、不新增事件类型、不改 `~/.dsh-fish/events.jsonl` 的写入语义。
- 不加人格设置入口；任何新的外来文本输入口必须过 `lib/guard.js`。
- 工具台账不进 `events.jsonl`，不参与 `deriveSelf` / `her_recall`。
- 策略表只能收窄可见性，不能授予权限；发送闸、频率、permit、黑名单、guard 一律不变。
- 宿主工具（shell、读写、子代理、技能、工作流）永不出现在任何面的策略表里。
- `src/dsh-fish` 提交前跑完整 `node --test`；`src/dsh-wx` 提交前跑完整 `node --test`。
- 只暂存本任务明确涉及的文件；提交前跑 `git diff --cached --check` 和 `python3 scripts/audit-staged.py`。
- 每条提交信息末尾加一行 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 实现只在 `dev` 工作树（`/home/str1k3/src/bigfish-workspace-dev`）进行；`main` 是部署线，不改。
- `rm`、`git clean`、破坏性 reset、强推、带 `--delete` 的同步必须先取得用户明确批准。

## Review Focus

- **首次 `agent/created` 拿不到 session id**：WX/home 的会话 id 在 `sc.create()` 之后才落盘；如果 `surface.current` 只认落盘 id，第一次创建会返回 `null`，身份段和工具收窄整条会话漏挂。测试必须覆盖“预分配 id 先登记，create 返回同一个 id”和“create 返回不同 id 时以返回值为准”。
- **`restrict` 掩码只增不减**：宿主限制是相交的；`load` 后不 dispose 旧限制就再 `restrict`，新工具永远进不来。测试必须断言旧 disposer 被调用、新 allow 是并集。
- **`output.schema` 先于 `render` 校验**：handler 的失败分支如果不满足 schema，宿主抛 `ToolOutputError`，`project` 根本不会执行。测试必须覆盖成功/预期失败/意外异常三条路径。
- **台账观察者不能改变工具结果**：台账写失败、脱敏抛错、目录不可写都不能把成功调用变成 `isError`。用 `tools/result`（只读观察）而不是 `post-execute` 写台账，并用测试钉死。
- **策略泄漏**：`resolveAllow` 不能把别的面的工具、宿主工具、宿主没注册的名字放进 allow；`load` 不能揭示当前面 catalog 之外的名字。测试必须逐面断言。
- **guard 与 reveal 不同步**：guard 如果读创建时的闭包快照，`load` 后新工具会被 guard 挡住。测试必须断言 reveal 后 guard 放行新工具。

---

## Task 0: 开发线对齐与基线

**Files:**
- 只读：`/home/str1k3/src/bigfish-workspace-dev` 的 `git status`、`git log`
- 复制：本计划的 spec 和 plan 到 dev 工作树（如 dev 还没有）

**Interfaces:**
- Consumes: 无
- Produces: dev 工作树包含三份 spec + 本计划，且 `node --test` 基线可复现

- [ ] **Step 1: 确认 dev 工作树没有会被覆盖的已跟踪改动**

Run:
```bash
git -C /home/str1k3/src/bigfish-workspace-dev status --short
git -C /home/str1k3/src/bigfish-workspace-dev log --oneline -3
```
Expected: 只有未跟踪的 `src/dsh-wx/lib/sticker-panel.mjs`；当前提交是 `483b8c8` 或其后代。

- [ ] **Step 2: 把设计文档同步到 dev**

`dev` 与 `main` 已分叉（dev 有 52 个 main 没有的提交，main 有 4 个 docs 提交），不要做破坏性合并。只复制本任务需要的文档：

```bash
mkdir -p /home/str1k3/src/bigfish-workspace-dev/docs/superpowers/plans
cp -a /home/str1k3/src/bigfish-workspace/docs/research /home/str1k3/src/bigfish-workspace-dev/docs/
cp /home/str1k3/src/bigfish-workspace/docs/superpowers/specs/2026-11-09-*.md /home/str1k3/src/bigfish-workspace-dev/docs/superpowers/specs/
cp /home/str1k3/src/bigfish-workspace/docs/superpowers/plans/2026-11-09-bigfish-tool-exposure-progressive-disclosure.md /home/str1k3/src/bigfish-workspace-dev/docs/superpowers/plans/
```
Expected: `git -C .../bigfish-workspace-dev status --short` 显示这些 docs 为新增/修改；`src/dsh-wx/lib/sticker-panel.mjs` 仍是未跟踪且不 stage。

- [ ] **Step 3: 跑 dev 基线**

Run:
```bash
cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test
cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-wx && node --test
```
Expected: 两条命令都 `fail 0`。把实际条数记进最终报告；如果 dev 基线本来就有红，先记录红项和原因，不得把既有红算成本计划的失败。

- [ ] **Step 4: 提交文档基线**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add docs/research docs/superpowers/specs/2026-11-09-*.md docs/superpowers/plans/2026-11-09-bigfish-tool-exposure-progressive-disclosure.md
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "docs: 工具暴露与渐进披露第一辑实施计划"
```
Expected: 审计通过；提交只含 docs。

---

## Task 1: 策略表与解析器

**Files:**
- Create: `src/dsh-fish/lib/tool-policy.js`
- Test: `src/dsh-fish/test/tool-policy.test.mjs`

**Interfaces:**
- Consumes: 无（纯模块）
- Produces:
  - `export const KINDS = ['read','write','send','navigate','maintain','discover']`
  - `export const POLICY`：`Array<{ name, surface, tier, group, summary, kind, requires, safety? }>`
  - `export function resolveAllow({ surface, caps = {}, revealed = new Set(), hostNames = null }): string[]`
  - `export function catalog({ surface, caps = {}, hostNames = null }): Array<entry>`
  - `export function loadTargets({ surface, caps = {}, hostNames = null, group = '', names = [] }): { ok: boolean, names: string[], group: string, why: string }`
  - `export function groupsFor(surface): string[]`
  - `export function entriesFor(surface): entry[]`
  - `export function describeEntry(name, surface): entry | null`

- [ ] **Step 1: 写失败测试**

`src/dsh-fish/test/tool-policy.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAllow, catalog, loadTargets, groupsFor } from '../lib/tool-policy.js'

const caps = { hasGui: true, hasOcr: true, hasImageRoute: true }
const CORE = ['growth_commit', 'her_recall', 'her_leave', 'her_tools']

test('web 只有 core + read_image，看不到 wx/qq/bili', () => {
  const allow = resolveAllow({ surface: 'web', caps })
  for (const n of CORE) assert.ok(allow.includes(n), n)
  assert.ok(allow.includes('read_image'))
  assert.equal(allow.some((n) => /^(wx_|qq_|bili_)/.test(n)), false)
})

test('wx 常驻是 core + 10 个常用动作，deferred 不常驻', () => {
  const allow = resolveAllow({ surface: 'wx', caps })
  for (const n of ['wx_peek', 'wx_send', 'wx_context', 'wx_task_done', 'wx_task_snooze', 'her_inbox', 'her_remind', 'her_reminders', 'her_remind_cancel', 'read_image']) {
    assert.ok(allow.includes(n), n)
  }
  assert.equal(allow.includes('wx_see'), false)
  assert.equal(allow.includes('wx_sticker_scan'), false)
  assert.equal(allow.some((n) => /^(qq_|bili_)/.test(n)), false)
})

test('revealed 组只打开该组，revealed 名字只打开该名字', () => {
  const byGroup = resolveAllow({ surface: 'wx', caps, revealed: new Set(['wx.ui']) })
  for (const n of ['wx_see', 'wx_click', 'wx_type', 'wx_key', 'wx_ocr']) assert.ok(byGroup.includes(n), n)
  assert.equal(byGroup.includes('wx_sticker_scan'), false)

  const byName = resolveAllow({ surface: 'wx', caps, revealed: new Set(['wx_history']) })
  assert.ok(byName.includes('wx_history'))
  assert.equal(byName.includes('wx_see'), false)
})

test('qq 和 bili 只看见自己的面', () => {
  const qq = resolveAllow({ surface: 'qq', caps })
  assert.ok(qq.includes('read_image'))
  assert.equal(qq.some((n) => /^(wx_|bili_)/.test(n)), false)

  const bili = resolveAllow({ surface: 'bili', caps })
  for (const n of ['bili_look', 'bili_watch', 'bili_speak', 'read_image']) assert.ok(bili.includes(n), n)
  assert.equal(bili.some((n) => /^(wx_|qq_)/.test(n)), false)
})

test('hostNames 过滤掉宿主没注册的名字', () => {
  const allow = resolveAllow({ surface: 'wx', caps, hostNames: new Set(['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'wx_peek', 'read_image']) })
  assert.deepEqual(allow.sort(), ['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'read_image', 'wx_peek'].sort())
})

test('能力不满足就不列（wx.ui 需要 hasGui，wx_ocr 需要 hasOcr）', () => {
  const noGui = resolveAllow({ surface: 'wx', caps: { hasGui: false, hasOcr: false, hasImageRoute: true }, revealed: new Set(['wx.ui']) })
  assert.equal(noGui.includes('wx_see'), false)
  assert.equal(noGui.includes('wx_ocr'), false)
})

test('catalog 只列当前面的 deferred，且不列宿主工具', () => {
  const cat = catalog({ surface: 'wx', caps })
  assert.ok(cat.length > 0)
  assert.equal(cat.every((e) => e.surface === 'wx' && e.tier === 'deferred'), true)
  assert.equal(cat.some((e) => e.name === 'bash' || e.name === 'write' || e.name === 'skill'), false)
  assert.equal(cat.some((e) => /^bili_/.test(e.name)), false)
})

test('loadTargets 只接受当前面的组/名字；别的面、未注册名字、宿主工具一律拒绝', () => {
  assert.equal(loadTargets({ surface: 'wx', caps, group: 'wx.ui' }).ok, true)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['wx_see'] }).ok, true)
  assert.equal(loadTargets({ surface: 'wx', caps, group: 'qq.media' }).ok, false)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['bili_look'] }).ok, false)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['bash'] }).ok, false)
  assert.equal(loadTargets({ surface: 'wx', caps, names: ['wx_not_real'] }).ok, false)
})

test('groupsFor 返回策略表里的组，不含空组', () => {
  assert.deepEqual(groupsFor('wx').sort(), ['wx.history', 'wx.stickers', 'wx.ui'])
  assert.deepEqual(groupsFor('bili'), [])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test test/tool-policy.test.mjs`
Expected: FAIL，`Cannot find module '../lib/tool-policy.js'`。

- [ ] **Step 3: 实现策略表与解析器**

`src/dsh-fish/lib/tool-policy.js` 必须包含：

- `CORE = ['growth_commit','her_recall','her_leave','her_tools']`，四个面各一条 `always`。
- `read_image` 四个面各一条 `always`，`requires: ['hasImageRoute']`。
- `wx`：矩阵里的 10 个 always；deferred 组
  - `wx.ui`：`wx_see`、`wx_click`、`wx_type`、`wx_key`、`wx_ocr`（`wx.ui` 全部 `requires: ['hasGui']`；`wx_ocr` 再加 `hasOcr`）
  - `wx.stickers`：`wx_sticker_scan`、`wx_sticker_list`、`wx_sticker_find`、`wx_sticker_tag`、`wx_sticker_send`、`wx_sticker_collect`、`wx_sticker_search`
  - `wx.history`：`wx_history`
- `qq`：always 只有 core + `read_image`；deferred 组
  - `qq.media`：`qq_send_image`、`qq_send_voice`、`qq_send_video`、`qq_send_file`、`qq_send_forward`
  - `qq.api`：`qq_napcat_api`
  - `qq.history`：`qq_group_history`
- `bili`：`bili_look`、`bili_watch`、`bili_speak` 全部 `always`。
- `kind` 按设计 §4.3 填；`safety` 对发送类填 `'send'`。
- `resolveAllow` 顺序：surface 过滤 → `always || revealed.has(name) || revealed.has(group)` → `requires.every(c => caps[c] === true)` → `hostNames ? hostNames.has(name) : true`。
- `catalog` 只返回 `deferred` 且通过 caps/hostNames 过滤的条目。
- `loadTargets`：`group` 与 `names` 二选一；先按 catalog 解析，再逐个校验；任何未知/跨面/未注册名字都返回 `{ ok:false, why:'这条路上打不开' }`，不改变任何状态。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/tool-policy.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/lib/tool-policy.js src/dsh-fish/test/tool-policy.test.mjs
git commit -m "feat(dsh-fish): 工具可见性策略表"
```

---

## Task 2: surface 注册表与判定

**Files:**
- Create: `src/dsh-fish/lib/surface.js`
- Test: `src/dsh-fish/test/surface.test.mjs`

**Interfaces:**
- Consumes: 无（纯模块）
- Produces:
  - `export const SURFACES = ['web','wx','qq','bili']`
  - `export function createSurfaceRegistry({ log, priority = ['bili','wx','qq','web'] } = {})`
  - registry: `register({ id, match, sections = [] }) -> () => void`、`reserve(sessionId, surfaceId) -> void`、`release(sessionId) -> void`、`current(agent) -> string|null`、`list() -> Array<{id, sections}>`、`known() -> string[]`
  - `export function agentSessionId(agent): string`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSurfaceRegistry, agentSessionId } from '../lib/surface.js'

const agent = (id, cwd = '') => ({ session: { header: { id, cwd } } })

test('预分配 id 优先于 matcher', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'web', match: ({ id }) => id === 'home' })
  r.reserve('wx-1', 'wx')
  assert.equal(r.current(agent('wx-1')), 'wx')
})

test('按 bili → wx → qq → web 顺序命中即返回', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'web', match: ({ cwd }) => cwd === '/home' })
  r.register({ id: 'wx', match: ({ id }) => id.startsWith('wx-') })
  r.register({ id: 'qq', match: ({ id }) => id.startsWith('onebot-') })
  r.register({ id: 'bili', match: ({ cwd }) => cwd === '/home/bili' })
  assert.equal(r.current(agent('x', '/home/bili')), 'bili')
  assert.equal(r.current(agent('wx-2', '/home/bili')), 'bili')
  assert.equal(r.current(agent('wx-2', '/home')), 'wx')
  assert.equal(r.current(agent('onebot-1', '/home')), 'qq')
  assert.equal(r.current(agent('home', '/home')), 'web')
})

test('未知会话返回 null，不默认归 web', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'web', match: ({ id }) => id === 'home' })
  assert.equal(r.current(agent('random', '/tmp')), null)
})

test('create 返回不同 id 时两个 id 都要能认', () => {
  const r = createSurfaceRegistry()
  r.reserve('requested', 'wx')
  r.reserve('returned', 'wx')
  assert.equal(r.current(agent('requested')), 'wx')
  assert.equal(r.current(agent('returned')), 'wx')
})

test('重复注册同一个 surface 抛错；release 后回到 matcher', () => {
  const r = createSurfaceRegistry()
  r.register({ id: 'wx', match: () => false })
  assert.throws(() => r.register({ id: 'wx', match: () => false }), /SURFACE_DUPLICATE|already registered/)
  r.reserve('s1', 'wx')
  r.release('s1')
  assert.equal(r.current(agent('s1')), null)
})

test('agentSessionId 兼容 session.header.id / session.id / agent.id', () => {
  assert.equal(agentSessionId({ session: { header: { id: 'a' } } }), 'a')
  assert.equal(agentSessionId({ session: { id: 'b' } }), 'b')
  assert.equal(agentSessionId({ id: 'c' }), 'c')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/surface.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `register` 校验 `id` 在 `SURFACES` 里；重复抛 `new Error('SURFACE_DUPLICATE: ...')`；返回 disposer 移除注册。
- `reserve` 只接受合法 surface id；空 id 直接返回；重复 reserve 同一 id 以最后一次为准；记录 `Map<sessionId, surfaceId>`。
- `current(agent)`：先查 reserved；再按 `priority` 顺序跑 matcher；`match` 返回真值即命中；全不中返回 `null`。
- `match` 入参固定 `{ id, cwd, serviceState: undefined }`；`cwd` 从 `agent.session.header.cwd ?? agent.header.cwd ?? agent.session.cwd`。
- `list()` 返回 `[{ id, sections }]`；`known()` 返回 reserved 的 id 数组。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/surface.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/surface.js src/dsh-fish/test/surface.test.mjs
git commit -m "feat(dsh-fish): surface 注册表与预分配判定"
```

---

## Task 3: `fishCore` 服务与 core surface 注册

**Files:**
- Create: `src/dsh-fish/lib/core-service.js`
- Modify: `src/dsh-fish/lib/index.js`（boot 里创建/注入，`bootstrapHome` 后 `reserve` home 会话）
- Test: `src/dsh-fish/test/core-service.test.mjs`

**Interfaces:**
- Consumes: `createSurfaceRegistry`、`paths`、`guard` 函数
- Produces:
  - `export function provideFishCore(ctx, { root, herDir, log } = {}): { core, registry, dispose }`
  - `core` 至少含：
    ```js
    {
      surface: registry,
      guard: { sanitizeForeign, looksLikeSecret, looksLikeRewriting, screenOutgoing },
      config: { get: () => object, patch: (patch) => Promise<object> },
      tools: { wrap: null, wrapRender: null, reveal: null }, // Task 5/6 在 index.js 里接线
    }
    ```
  - `index.js` 在 `ensureHer` 之后、`registerToolRestrict` 之前调用 `provideFishCore`，并把 `core` 传给后续任务。
  - `config.get` 在根目录不可读/不存在时返回 `loadConfig` 的默认值，不抛错（测试用临时空目录）。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { provideFishCore } from '../lib/core-service.js'

function fakeCtx() {
  const provided = new Map()
  const services = new Map()
  return {
    provided, services,
    provide(name, value) { provided.set(name, value); services.set(name, value); return () => { provided.delete(name); services.delete(name) } },
    get(name) { return services.get(name) },
  }
}

const agent = (id, cwd = '') => ({ session: { header: { id, cwd } } })

test('provideFishCore 暴露 surface/guard/config，并登记 web/wx/qq/bili', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  assert.equal(ctx.get('fishCore'), core)
  assert.equal(typeof core.guard.sanitizeForeign, 'function')
  assert.equal(core.tools.wrap, null)
  core.surface.reserve('home-1', 'web')
  assert.equal(core.surface.current(agent('home-1')), 'web')
  core.surface.reserve('wx-1', 'wx')
  assert.equal(core.surface.current(agent('wx-1')), 'wx')
  dispose()
  assert.equal(ctx.get('fishCore'), undefined)
})

test('qq 按 onebot- 前缀判定，未知会话 null', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  assert.equal(core.surface.current(agent('onebot-123')), 'qq')
  assert.equal(core.surface.current(agent('random', '/tmp')), null)
  dispose()
})

test('bili 按专属 cwd 判定', () => {
  const ctx = fakeCtx()
  const { core, dispose } = provideFishCore(ctx, { root: '/tmp/fish-root', herDir: '/tmp/fish-root/home' })
  assert.equal(core.surface.current(agent('bili-1', '/tmp/fish-root/home/bili')), 'bili')
  dispose()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/core-service.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `provideFishCore` 创建 registry，注册四个面：
  - `bili`：`match({ cwd }) => cwd === join(root, 'home', 'bili')`
  - `wx`：`match({ id }) => { const wx = ctx.get?.('wx'); return !!wx?.isWxSession?.(id) || !!wx?.isReservedSession?.(id) }`；matcher 抛错按 false。
  - `qq`：`match({ id }) => id.startsWith('onebot-')`
  - `web`：`match({ id, cwd }) => id === homeSessionId || cwd === herDir`；`homeSessionId` 由 `core.surface.reserve(id,'web')` 之后自然命中，matcher 里也保留一个可写的 `let homeSessionId`，并提供 `core.surface.noteHome(id)`。
- `config.get` 用 `loadConfig(root)` 的 `config`（每次现读）；`config.patch` 本任务先返回当前 config，不实现写入（后续任务再加）。
- `dispose` 注销四个 surface 并调用 `ctx.provide` 返回的 disposer。
- `index.js`：`provideFishCore` 放在 `ensureHer` 之后；`bootstrapHome` 成功后 `core.surface.reserve(home.sessionId, 'web')`；`dispose` 时调用 `core disposal`。
- 不要在 `provideFishCore` 里 import `dsh-wx`；只用 `ctx.get('wx')`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/core-service.test.mjs`
Expected: PASS。

- [ ] **Step 5: 跑 dsh-fish 全量**

Run: `node --test`
Expected: 全绿（原 680 + 新增）。

- [ ] **Step 6: 提交**

```bash
git add src/dsh-fish/lib/core-service.js src/dsh-fish/lib/index.js src/dsh-fish/test/core-service.test.mjs
git commit -m "feat(dsh-fish): fishCore 服务与 surface 判定"
```

---

## Task 4: 工具台账

**Files:**
- Create: `src/dsh-fish/lib/tool-ledger.js`
- Modify: `src/dsh-fish/lib/store.js`（`paths()` 增加 `toolLedgerDir`、`toolLedgerArtifacts`）
- Modify: `src/dsh-fish/lib/index.js`（创建 ledger 并注册观察者）
- Test: `src/dsh-fish/test/tool-ledger.test.mjs`

**Interfaces:**
- Consumes: `paths`、`guard.looksLikeSecret`
- Produces:
  - `export function createToolLedger({ root, guard, log, now = Date.now, maxInlineBytes = 32768 } = {})`
  - ledger: `register(ctx) -> () => void`、`record(exec, result, extra = {}) -> Promise<entry|null>`（`extra` 支持 `{ surface, durationMs, startedAt }`）、`status() -> { ok, written, failed, lastError, artifacts }`
  - 台账路径：`<root>/tool-ledger/YYYY-MM-DD.jsonl`，artifact：`<root>/tool-ledger/artifacts/<tc_id>.json`
  - 记录字段按返回契约设计 §4.3：`v,id,ts,surface,sessionId,tool,args,argsHash,redacted,ok,code,durationMs,value,content,modelText,handles,refs,effects,error,projectionVersion`；大字段用 `artifact,bytes,sha256`。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolLedger } from '../lib/tool-ledger.js'

const guard = { looksLikeSecret: (s) => ({ hit: /sk-|cookie|token/i.test(String(s ?? '')), why: '' }) }

async function tmpRoot() { return mkdtemp(join(tmpdir(), 'fish-ledger-')) }

test('成功的工具调用写一条完整台账', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard })
    const exec = { name: 'wx_context', arguments: { query: '晚上' }, agent: { session: { header: { id: 's1' } } } }
    const result = { isError: false, value: { ok: true, code: 'OK', data: { n: 3 } }, content: [{ type: 'text', text: '[翻到] 3 条' }] }
    const entry = await ledger.record(exec, result, { surface: 'wx', durationMs: 42 })
    assert.equal(entry.tool, 'wx_context')
    assert.equal(entry.ok, true)
    assert.equal(entry.durationMs, 42)
    assert.equal(entry.modelText, '[翻到] 3 条')
    const line = (await readFile(join(root, 'tool-ledger', `${entry.ts.slice(0, 10)}.jsonl`), 'utf8')).trim()
    assert.equal(JSON.parse(line).id, entry.id)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('失败调用也写台账，error 进 error 字段', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard })
    const entry = await ledger.record(
      { name: 'wx_send', arguments: {}, agent: { session: { header: { id: 's1' } } } },
      { isError: true, error: { message: 'boom', info: { code: 'WX_FAILED' } }, content: [{ type: 'text', text: 'Error: boom' }] },
      { surface: 'wx' },
    )
    assert.equal(entry.ok, false)
    assert.equal(entry.code, 'WX_FAILED')
    assert.match(entry.error, /boom/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('密钥被脱敏，redacted=true', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard })
    const entry = await ledger.record(
      { name: 'qq_napcat_api', arguments: { token: 'sk-123' }, agent: { session: { header: { id: 's1' } } } },
      { isError: false, value: { ok: true, data: { cookie: 'abc' } }, content: [{ type: 'text', text: 'ok' }] },
      { surface: 'qq' },
    )
    assert.equal(entry.redacted, true)
    assert.equal(JSON.stringify(entry).includes('sk-123'), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('超过 32KB 的结果落 artifact，台账只留 sha256', async () => {
  const root = await tmpRoot()
  try {
    const ledger = createToolLedger({ root, guard, maxInlineBytes: 64 })
    const entry = await ledger.record(
      { name: 'wx_ocr', arguments: {}, agent: { session: { header: { id: 's1' } } } },
      { isError: false, value: { ok: true, data: { text: 'x'.repeat(200) } }, content: [{ type: 'text', text: 'ocr' }] },
      { surface: 'wx' },
    )
    assert.equal(typeof entry.artifact, 'string')
    assert.equal(typeof entry.bytes, 'number')
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('台账写失败不抛，只记 status', async () => {
  const root = await tmpRoot()
  try {
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'x') // 用普通文件占位，mkdir 其下必然失败
    const ledger = createToolLedger({ root: blocker, guard })
    const entry = await ledger.record({ name: 'x', arguments: {}, agent: {} }, { isError: false, value: { ok: true }, content: [] }, {})
    assert.equal(entry, null)
    assert.equal(ledger.status().failed >= 1, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/tool-ledger.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `paths(root)` 增加：
  ```js
  toolLedgerDir: join(root, 'tool-ledger'),
  toolLedgerArtifacts: join(root, 'tool-ledger', 'artifacts'),
  ```
- `record(exec, result, extra)`：
  - `id = 'tc_' + newId-like`：用 `crypto.randomUUID()` 或 `newId()` 前缀；不要复用事件 id 生成器（避免语义混淆）。用 `randomUUID`。
  - `ts = new Date(now()).toISOString()`；文件名用 `ts.slice(0, 10)`（UTC 日期），测试与写入同一口径。
  - `args` 递归脱敏；`value`/`content`/`modelText` 同样脱敏；命中任何密钥 → `redacted:true`。
  - `argsHash = 'sha256:' + sha256(JSON.stringify(args))`。
  - `durationMs = extra.durationMs ?? (now() - extra.startedAt)`，没有就 0。
  - `ok = !result.isError && result.value?.ok !== false`。
  - `code = result.value?.code ?? result.error?.info?.code ?? ''`。
  - `handles = result.value?.handles ?? []`；`refs = result.value?.refs ?? {}`；`effects = result.value?.effects ?? null`。
  - 大字段：`JSON.stringify(sanitizedValue).length > maxInlineBytes` → 写 artifact，`value` 替换为 `{ artifact, bytes, sha256 }`；artifact 目录 `0700`、文件 `0600`。
  - 追加队列：模块内 `let tail = Promise.resolve()`；`tail = tail.then(append).catch(markFailed)`；返回 entry，失败返回 `null`。
  - `register(ctx)` 监听 **`tools/result`**（只读观察，不参与 waterfall）：
    ```js
    ctx.on('tools/result', (exec, result) => { void ledger.record(exec, result, { surface }) })
    ```
    `surface` 由调用方传入 `surfaceOf(exec.agent)`；未知 surface 的记录仍写，但 `surface: null`。
  - 监听器整体 `try/catch`，绝不抛。
- `index.js` 创建 ledger 后 `const offLedger = ledger.register(ctx)`，放进 disposers。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/tool-ledger.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/tool-ledger.js src/dsh-fish/lib/store.js src/dsh-fish/lib/index.js src/dsh-fish/test/tool-ledger.test.mjs
git commit -m "feat(dsh-fish): 工具调用完整台账"
```

---

## Task 5: 返回包装器与投影

**Files:**
- Create: `src/dsh-fish/lib/tool-result.js`
- Modify: `src/dsh-fish/lib/index.js`（接线 `core.tools.wrap` / `core.tools.wrapRender`）
- Test: `src/dsh-fish/test/tool-result.test.mjs`

**Interfaces:**
- Consumes: 无（纯模块；`core` 可选）
- Produces:
  - `export const PROJECTION = Symbol('fish.projection')`
  - `export const CALL_META = Symbol('fish.callMeta')`
  - `export class ToolError extends Error { constructor(code, modelText, { cause } = {}) }`
  - `export function projectError(err): string`
  - `export function universalOutputSchema(): object`
  - `export function wrapTool(def, { core } = {}): object`（对象返回值；投影在 execute 时算一次）
  - `export function wrapRenderOnly(def, { core } = {}): object`（返回值保持原样；投影在 render 时算一次）
  - `export function registerTool(ctx, def, { core } = {}): () => void`
  - `export function renderProjection(projection): ContentBlock[]`

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wrapTool, wrapRenderOnly, registerTool, renderProjection, ToolError, PROJECTION } from '../lib/tool-result.js'

function fakeCtx() {
  const regs = []
  return { regs, tools: { register(def) { regs.push(def); return () => {} } } }
}

test('project 只算一次，render 只读预计算结果', () => {
  let calls = 0
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, render: () => { throw new Error('should not use legacy render') } },
    execute: async () => ({ ok: true, id: 'ev_1' }),
    project: (result, args, view) => { calls += 1; return { text: `[好] ${view.surface}` } },
  }
  const wrapped = wrapTool(def, { core: { surface: { current: () => 'wx' } } })
  return wrapped.execute({}, { agent: { id: 's1' } }).then((result) => {
    assert.equal(calls, 1)
    assert.equal(result[PROJECTION].text, '[好] wx')
    const blocks = wrapped.output.render({}, result)
    assert.equal(calls, 1)
    assert.equal(blocks[0].text, '[好] wx')
  })
})

test('handles 渲染成末尾一行编号，正文不重复', () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    execute: async () => ({ ok: true }),
    project: () => ({ text: '[翻到] 一条', handles: [{ label: '1', value: 'ev_1' }] }),
  }
  const wrapped = wrapTool(def)
  return wrapped.execute({}, {}).then((r) => {
    const blocks = wrapped.output.render({}, r)
    assert.equal(blocks[0].text, '[翻到] 一条\n（编号：1=ev_1）')
  })
})

test('project 抛错时 render 兜底，不把 Error 带进上下文', async () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    execute: async () => ({ ok: true }),
    project: () => { throw new Error('boom') },
  }
  const wrapped = wrapTool(def)
  const r = await wrapped.execute({}, {})
  assert.equal(wrapped.output.render({}, r)[0].text, '[结果没能显示出来]')
})

test('预期失败走信封，投影仍可读', async () => {
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' } }, required: ['ok'] } },
    execute: async () => ({ ok: false, code: 'NO', message: '这个会话不在名单里' }),
    project: (r) => ({ text: r.ok ? '[好]' : `[没做成：${r.message}]` }),
  }
  const wrapped = wrapTool(def)
  const r = await wrapped.execute({}, {})
  assert.equal(wrapped.output.render({}, r)[0].text, '[没做成：这个会话不在名单里]')
})

test('没有 outputSchema 时用通用信封 schema', () => {
  const wrapped = wrapTool({ name: 't', description: 'd', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: true }), project: () => ({ text: 'x' }) })
  assert.equal(wrapped.output.schema.type, 'object')
})

test('ToolError 保留 code 与人话', () => {
  const e = new ToolError('WX_NOT_ALLOWED', '这个会话不在能说话的名单里')
  assert.equal(e.code, 'WX_NOT_ALLOWED')
  assert.equal(e.message, '这个会话不在能说话的名单里')
})

test('wrapRenderOnly 不改返回值，只在 render 时投影', async () => {
  const raw = '原始字符串'
  const def = {
    name: 't', description: 'd', parameters: { type: 'object', properties: {} },
    execute: async () => raw,
    project: (v) => ({ text: `[投影]${v}` }),
  }
  const wrapped = wrapRenderOnly(def)
  assert.equal(await wrapped.execute({}, {}), raw)
  assert.equal(wrapped.output.render({}, raw)[0].text, '[投影]原始字符串')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/tool-result.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `wrapTool(def, { core })` 返回新对象，不修改入参：
  - `output.schema = def.outputSchema ?? def.output?.schema ?? universalOutputSchema()`
  - `output.render = (args, result) => renderProjection(result[PROJECTION])`
  - `execute = async (args, exec) => { const startedAt = Date.now(); let result; try { result = await def.execute(args, exec) } catch (err) { throw err instanceof ToolError ? err : new ToolError('TOOL_FAILED', projectError(err), { cause: err }) } const view = Object.freeze({ surface: core?.surface?.current?.(exec?.agent) ?? null, sessionId: exec?.agent?.id ?? '', now: Date.now(), imageRoute: true }); let projection; try { projection = def.project?.(result, args, view) ?? { text: String(result ?? '') } } catch { projection = { text: '[结果没能显示出来]' } } Object.defineProperty(result, PROJECTION, { value: projection, enumerable: false }); Object.defineProperty(result, CALL_META, { value: { startedAt }, enumerable: false }); return result }`
- `wrapRenderOnly(def, { core })`：不改 `execute`、不改 `output.schema`；只把 `output.render` 换成 `(args, result) => renderProjection(safeProject(def.project, result, args, { surface: null, sessionId: '', now: Date.now(), imageRoute: true }))`。用于返回字符串的旧工具（`wx_*`、`qq_*`），投影在 render 时算一次，返回值类型不变。
- `safeProject`：`project` 缺失 → `{ text: String(result ?? '') }`；抛错 → `{ text: '[结果没能显示出来]' }`。
- `wrapTool` 只用于返回对象的工具；`project` 收到原始返回值，不是包装后的信封。
- `renderProjection(p)`：`blocks = p.blocks ?? []`；`footer = p.handles?.length ? '\n（编号：' + p.handles.map(h => `${h.label}=${h.value}`).join('，') + '）' : ''`；返回 `[...blocks, { type:'text', text: (p.text ?? '') + footer }]`；整体 `try/catch` 兜底。
- `registerTool(ctx, def, opts)`：`const d = wrapTool(def, opts); return ctx.tools.register(d)`。
- `index.js`：`provideFishCore` 之后接线 `core.tools.wrap = (def, opts = {}) => wrapTool(def, { ...opts, core })`、`core.tools.wrapRender = (def, opts = {}) => wrapRenderOnly(def, { ...opts, core })`；`core` 是同一个对象引用。
- `projectError(err)`：只按 `err.code` 映射已知码（`WX_NOT_ALLOWED`→`这个会话不在能说话的名单里`，`WX_UNCONFIRMED`→`没看到回执，可能没发出去`，`BILI_COOLDOWN`→`今天说得够多了`，`REMIND_EXPIRED`→`这条提醒已经过期了`）；未知 → `没做成，再试一次`；绝不拼 `err.message`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/tool-result.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/tool-result.js src/dsh-fish/test/tool-result.test.mjs
git commit -m "feat(dsh-fish): 工具返回包装器与模型投影"
```

---

## Task 6: 策略化 restrict 与可变 reveal

**Files:**
- Modify: `src/dsh-fish/lib/restrict.js`
- Modify: `src/dsh-fish/test/restrict.test.mjs`（保留旧用例，新增策略用例）
- Modify: `src/dsh-fish/lib/index.js`（把 `core`/policy 传给 `registerToolRestrict`）

**Interfaces:**
- Consumes: `tool-policy.js`、`surface.js`、`core-service.js`
- Produces:
  - `registerToolRestrict(ctx, { herDir, surface, policy, caps, extra, enabled, log, onResult }) -> dispose`
  - `export function revealTools(agent, names): { ok, added, allow, why }`
  - `export function getAgentToolState(agent): { surface, allow, revealed, restrictDispose } | null`
  - `export function resetAgentToolState(agent): void`（测试用）
  - 旧导出 `FISH_TOOLS`、`HER_TOOLS`、`isHerAgent`、`knownToolNames`、`readRestrictState`、`describeRestrict` 保留。

- [ ] **Step 1: 写失败测试（追加到 restrict.test.mjs）**

```js
// 复用本文件已有的 fakeCtx / fakeAgent helper。如果 helper 没有记录
// restrict 的 disposer，就在 helper 里补一个 disposed 计数；不要另起一套宿主模型。
test('按面解析 allow：web 不给 wx，wx 不给 bili', () => {
  const ctx = fakeCtx()
  const surface = { current: (a) => a.__surface ?? null }
  const policy = {
    resolveAllow: ({ surface: s }) => s === 'web' ? ['growth_commit', 'read_image'] : ['growth_commit', 'wx_peek'],
  }
  const off = registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  const web = fakeAgent('/her'); web.agent.__surface = 'web'
  const wx = fakeAgent('/her'); wx.agent.__surface = 'wx'
  ctx.emit('agent/created', { agent: web.agent })
  ctx.emit('agent/created', { agent: wx.agent })
  assert.deepEqual(web.calls.at(-1).allow.sort(), ['growth_commit', 'read_image'])
  assert.deepEqual(wx.calls.at(-1).allow.sort(), ['growth_commit', 'wx_peek'])
  off()
})

test('reveal 先 dispose 旧限制，再按并集重新 restrict；guard 放行新工具', () => {
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  let allow = ['growth_commit']
  const policy = {
    resolveAllow: () => allow,
    loadTargets: ({ names }) => names.includes('wx_see') ? { ok: true, names: ['wx_see'] } : { ok: false, why: '这条路上打不开' },
  }
  const a = fakeAgent('/her')
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })
  const beforeDisposed = a.disposed
  allow = ['growth_commit', 'wx_see']
  const r = revealTools(a.agent, ['wx_see'])
  assert.equal(r.ok, true)
  assert.equal(a.disposed, beforeDisposed + 1)
  assert.deepEqual(a.calls.at(-1).allow.sort(), ['growth_commit', 'wx_see'])
  assert.doesNotThrow(() => a.guards.at(-1)({ name: 'wx_see' })) // guard 用的同一个 Set 已更新
})

test('reveal 拒绝别的面/宿主工具/未注册名字，失败不改变 allow', () => {
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  const policy = {
    resolveAllow: () => ['growth_commit'],
    loadTargets: () => ({ ok: false, why: '这条路上打不开' }),
  }
  const a = fakeAgent('/her')
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })
  const before = a.calls.length
  const r = revealTools(a.agent, ['bili_look'])
  assert.equal(r.ok, false)
  assert.equal(a.calls.length, before)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/restrict.test.mjs`
Expected: 新用例 FAIL（`revealTools` 不存在或策略未生效）。

- [ ] **Step 3: 实现**

- 模块级 `let active = null`：`{ surface, policy, caps, herDir }`，由 `registerToolRestrict` 设置；`revealTools` 读它。
- 模块级 `const agentStates = new WeakMap()`；每个 agent 存 `{ surface, allow:Set, revealed:Set, restrictDispose, guardDispose }`。
- `onCreated`：
  - `const s = active?.surface?.current(agent) ?? (isHerAgent(agent, active?.herDir) ? 'web' : null)`；`null` 直接返回（不再默认 web）。
  - `const hostNames = readHostNames(agent)`（沿用现有 view(agent) + 兜底）。
  - `const allow = active.policy.resolveAllow({ surface: s, caps: active.caps ?? {}, revealed: new Set(), hostNames })`；`extra` 只对 web 合并（兼容 `config.tools.allow`），且必须在 hostNames 里。
  - 创建 `allowSet = new Set(allow)`；guard 用 `allowSet`（同一个 Set，后续 `clear()/add()` 原地改）。
  - `applyRestrict(names)`：先 `state.restrictDispose?.()`，再 `state.restrictDispose = scopedTools.restrict({ allow: names })`；`agent.ctx.effect?.(() => dispose)` 保留。
  - 保留现有“从报错里捡名字”的 healing。
- `revealTools(agent, names)`：
  - `state = agentStates.get(agent)`；没有 → `{ok:false, why:'这条路上打不开'}`。
  - `targets = active.policy.loadTargets({ surface: state.surface, caps, hostNames: state.hostNames, names })`；`!ok` → 返回 `why`。
  - 把 targets 加进 `state.revealed`；重算 `allow = policy.resolveAllow(...)`；`state.allow.clear(); for (n of allow) add(n)`；`applyRestrict(allow)`。
  - 返回 `{ ok:true, added: targets.names, allow }`。
- `isHerAgent` 保留旧签名；如果传入 surface registry，用 `surface.current(agent) !== null` 优先。
- `describeRestrict` 文案改成“已收窄（按面策略）”，但保留旧测试兼容（旧测试只断言三种说法不混；调整断言如需要）。
- `index.js` 在 `registerToolRestrict` 之后接线 `core.tools.reveal = (agent, names) => revealTools(agent, names)`；Task 7 的 `her_tools` 只通过 `core.tools.reveal` 调用，不直接 import `restrict.js`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/restrict.test.mjs`
Expected: 全部 PASS（旧用例 + 新用例）。

- [ ] **Step 5: 跑 dsh-fish 全量**

Run: `node --test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/dsh-fish/lib/restrict.js src/dsh-fish/lib/index.js src/dsh-fish/test/restrict.test.mjs
git commit -m "feat(dsh-fish): 按面策略收窄与按需揭示"
```

---

## Task 7: `her_tools` 导航工具

**Files:**
- Create: `src/dsh-fish/lib/tools.js`
- Modify: `src/dsh-fish/lib/index.js`（注册 `her_tools`）
- Test: `src/dsh-fish/test/her-tools.test.mjs`

**Interfaces:**
- Consumes: `registerTool`、`tool-policy`、`fishCore.surface.current`、`fishCore.tools.reveal`（Task 6 的 `revealTools`）
- Produces:
  - `export function registerHerTools(ctx, { core, policy } = {})`
  - 工具 `her_tools`：`{ action: 'search'|'describe'|'load', query?, group?, names? }`

- [ ] **Step 1: 写失败测试**

测试用 fake ctx 捕获注册的 def，直接调 `def.execute({...}, { agent })`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHerTools } from '../lib/tools.js'

function fakeHost() {
  const defs = new Map()
  return {
    defs,
    ctx: { tools: { register(def) { defs.set(def.name, def); return () => {} } } },
  }
}

const policy = {
  catalog: ({ surface }) => surface === 'wx' ? [
    { name: 'wx_see', surface: 'wx', tier: 'deferred', group: 'wx.ui', summary: '看屏幕' },
    { name: 'wx_click', surface: 'wx', tier: 'deferred', group: 'wx.ui', summary: '点一下' },
  ] : [],
  loadTargets: ({ names, group }) => {
    if (group === 'wx.ui' || (names?.length === 1 && names[0] === 'wx_see')) return { ok: true, names: group ? ['wx_see', 'wx_click'] : ['wx_see'], group, why: '' }
    return { ok: false, names: [], group, why: '这条路上打不开' }
  },
}

test('search 只列当前面 deferred，最多 5 条，不改 revealed', async () => {
  const h = fakeHost()
  let revealed = 0
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: () => { revealed += 1 } } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'search', query: '屏幕' }, { agent: {} })
  assert.match(def.output.render({}, out)[0].text, /wx_see/)
  assert.equal(revealed, 0)
})

test('describe 只返回最多 2 条，给说明不给 JSON schema', async () => {
  const h = fakeHost()
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: () => {} } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'describe', names: ['wx_see', 'wx_click'] }, { agent: {} })
  const text = def.output.render({}, out)[0].text
  assert.match(text, /wx_see/)
  assert.equal(text.includes('{'), false)
})

test('load 组成功返回已打开，并调用 reveal', async () => {
  const h = fakeHost()
  let got = null
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: (_a, names) => { got = names; return { ok: true } } } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'load', group: 'wx.ui' }, { agent: {} })
  assert.deepEqual(got.sort(), ['wx_click', 'wx_see'])
  assert.match(def.output.render({}, out)[0].text, /已打开/)
})

test('load 别的面/宿主工具失败，不假装成功', async () => {
  const h = fakeHost()
  registerHerTools(h.ctx, { core: { surface: { current: () => 'wx' }, tools: { reveal: () => { throw new Error('should not') } } }, policy })
  const def = h.defs.get('her_tools')
  const out = await def.execute({ action: 'load', names: ['bili_look'] }, { agent: {} })
  assert.match(def.output.render({}, out)[0].text, /没打开/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/her-tools.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `parameters` 用 `toJsonSchema`：`action` 必填 enum；`query`、`group`、`names` 可选。
- `execute(args, exec)`：
  - `surface = core.surface.current(exec.agent)`；`null` → `{ ok:false, code:'NO_SURFACE', message:'这里打不开工具目录' }`。
  - `search`：`core` 的 policy.catalog({surface}) 过滤 `query`（对 name/summary/group 做小写包含）；最多 5 条；返回 `{ ok:true, data:{items} }`。
  - `describe`：最多 2 个名字；从 `exec.agent.ctx.tools.get(name, exec.agent)` 或 `exec.agent.ctx.tools.view(exec.agent).visible.get(name)` 取 description/parameters；只列参数名与一句说明，不输出 JSON；找不到就只用 policy.summary。
  - `load`：`resolve = core.tools.reveal(exec.agent, targets.names)`；成功 `{ok:true, data:{opened:targets.names}}`；失败 `{ok:false, code:'LOAD_FAILED', message: resolve.why}`。
- `project`：`search` → `[工具] 1. name — summary`；`describe` → `[说明] name：...`；`load` → `[已打开] name…` 或 `[没打开：why]`。
- `registerTool(ctx, def, { core })`；`ctx.tools.register` 的 disposer 返回给 index.js。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/her-tools.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/tools.js src/dsh-fish/lib/index.js src/dsh-fish/test/her-tools.test.mjs
git commit -m "feat(dsh-fish): her_tools 工具目录与按需打开"
```

---

## Task 8: 核心工具接入统一投影

**Files:**
- Modify: `src/dsh-fish/lib/capture.js`、`recall.js`、`letter.js`、`taskinbox.js`、`remind.js`
- Modify: `src/dsh-fish/lib/index.js`（把 `core` 传给各 register 函数）
- Test: 现有 `capture.test.mjs`、`mem.test.mjs`、`letter.test.mjs`、`taskinbox.test.mjs`、`remind.test.mjs` + 新增投影断言

**Interfaces:**
- Consumes: `registerTool` / `wrapTool`
- Produces:
  - 每个工具保留现有 handler 返回值形状与 `output.schema`；
  - 新增 `project(result, args, view)`：
    - `growth_commit`：`[已记下 · ev_…]` / `[没记下：note]`，handle `{label:'1', value:id}`。
    - `her_recall`：`[翻到] 日期（B 站/微信/QQ）｜原话`；handles 为事件 id 编号列表。
    - `her_leave`：`[已留]` / `[没留：note]`。
    - `her_inbox`：`[待回] 「会话」：最后一句…`；需要后续操作时给 task handle。
    - `her_remind`：`[已定：明天 09:00 发到「X」]`。
    - `her_reminders`：`[提醒] 明天 09:00「X」` + 编号 handle。
    - `her_remind_cancel`：`[已取消]` / `[没取消：note]`。

- [ ] **Step 1: 写一条失败投影测试**

在 `capture.test.mjs` 末尾追加（复用本文件已有的 fake ctx 与临时根目录 helper；不要改生产代码来迁就测试）：

```js
test('growth_commit 的模型投影是方括号状态 + handle，不是她的台词', async () => {
  const { ctx } = fakeCtx()
  const root = await tmpRoot()
  const off = registerCapture(ctx, { root })
  const def = ctx.tools.registered.find((d) => d.name === 'growth_commit')
  const out = await def.execute({ type: 'utterance', text: '今天有点累' }, {})
  const text = def.output.render({}, out)[0].text
  assert.match(text, /^\[已记下 · ev_/)
  assert.equal(text.includes('今天有点累'), false)
  off?.()
})
```
（如果现有测试文件没有 `registered` 数组，用本文件的 fake ctx 捕获注册定义；不要改生产代码来迁就测试。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/capture.test.mjs`
Expected: 新用例 FAIL（现有 render 仍是 `[已记下 ev_…]` 或没有 `·`）。

- [ ] **Step 3: 实现**

- `capture.js`：`return registerTool(ctx, { ...defineTool({...}), project }, { core: deps.core })`。保留 `output.schema`；删除手写 `output.render`，或保留作为 fallback（`registerTool` 会覆盖 render）。投影：
  ```js
  project: (out) => out.ok
    ? { text: `[已记下 · ${out.id}]`, handles: [{ label: '1', value: out.id }] }
    : { text: `[没记下：${out.note}]` }
  ```
  注意：如果 `text` 已含 id，footer 会重复 id；设计要求正文不重复 handle。改成 `[已记下]` + handle，或 `[已记下 · ev_…]` 且不给 handle。选后者（单条写操作可内联一个 id，设计 §3.5）。测试相应断言 `[已记下 · ev_` 且没有 footer。
- `recall.js`：投影 `[翻到] ...`；`handles` 用结果里的 id 列表；正文不写 `id`。
- `letter.js`、`taskinbox.js`、`remind.js` 按上表。
- `index.js`：给 `registerCapture/Recall/Letter/Remind/Inbox` 传 `core`。
- 不改任何 handler 的业务逻辑、发送闸或 quota。

- [ ] **Step 4: 跑相关测试 + 全量**

Run:
```bash
node --test test/capture.test.mjs test/mem.test.mjs test/letter.test.mjs test/taskinbox.test.mjs test/remind.test.mjs
node --test
```
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/capture.js src/dsh-fish/lib/recall.js src/dsh-fish/lib/letter.js src/dsh-fish/lib/taskinbox.js src/dsh-fish/lib/remind.js src/dsh-fish/lib/index.js src/dsh-fish/test/*.test.mjs
git commit -m "feat(dsh-fish): 核心工具接入统一模型投影"
```

---

## Task 9: dsh-wx 接入 surface 与包装器

**Files:**
- Modify: `src/dsh-wx/lib/index.js`
- Create: `src/dsh-wx/lib/project.js`
- Test: `src/dsh-wx/test/tool-surface.test.mjs`

**Interfaces:**
- Consumes: `fishCore.surface` / `fishCore.tools.wrapRender`（通过 `ctx.get('fishCore')`，可缺席）
- Produces:
  - `src/dsh-wx/lib/project.js`：`export function projectWxContext(raw): string`、`export function projectWxOcr(raw): string`、`export function projectWxPeek(raw): string`
  - `wxService.isReservedSession(sessionId): boolean`
  - `ensureWxSession` / `sessionForChat` 在建会话前 `reserveWxSession(randomUUID())`，并 `sc.create({ cwd: HER_DIR, sessionId })`
  - `reg(tool)`：有 `tool.project` 且 fishCore 可用时走 `fishCore.tools.wrapRender`；否则维持旧注册
  - `wx_peek`、`wx_ocr`、`wx_context` 的 `project` 引用 `lib/project.js`

- [ ] **Step 1: 写失败测试**

`src/dsh-wx/test/tool-surface.test.mjs`（只测纯函数/契约，不启动 GUI、不 import 整个插件）：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectWxContext, projectWxOcr } from '../lib/project.js'

test('wx_context 投影去掉匹配原因/来源/置信度/msgId', () => {
  const raw = '[上下文 1/3] 群名｜阿明｜2026-11-09 12:30\n「晚上来吗」\n匹配：关键词 + 同线程；来源：台账 msg_1；置信度：high'
  const text = projectWxContext(raw)
  assert.match(text, /晚上来吗/)
  assert.equal(text.includes('匹配：'), false)
  assert.equal(text.includes('置信度'), false)
  assert.equal(text.includes('msg_1'), false)
})

test('wx_ocr 投影只保留可读文字，不返回 JSON 字段', () => {
  const raw = JSON.stringify({ lines: [{ text: '晚上来吗', box: [1,2,3,4], confidence: 0.9 }] })
  const text = projectWxOcr(raw)
  assert.match(text, /晚上来吗/)
  assert.equal(text.includes('confidence'), false)
  assert.equal(text.includes('[1,2'), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-wx && node --test test/tool-surface.test.mjs`
Expected: FAIL，`lib/project.js` 不存在。

- [ ] **Step 3: 实现**

- `lib/project.js` 实现三个纯函数：
  - `projectWxContext(raw)`：按行过滤 `匹配：` / `来源：` / `置信度：`，其余原样保留。
  - `projectWxOcr(raw)`：优先 `JSON.parse`，递归收集字符串，跳过 `box/confidence/score/x/y/width/height` 键；去重后输出 `[屏幕上看到]\n…`；解析失败保留原文并截断 2000 字。
  - `projectWxPeek(raw)`：去掉 `box=[…]`，截断 12000 字。
- `index.js` 顶部 `import { projectWxContext, projectWxOcr, projectWxPeek } from './project.js'`；新增：
  ```js
  const reservedWxSessions = new Set()
  const reserveWxSession = (id) => { const s = String(id ?? ''); if (s) reservedWxSessions.add(s) }
  ```
- `ensureWxSession` / `sessionForChat`：
  ```js
  const requested = randomUUID()
  reserveWxSession(requested)
  const created = await sc.create({ cwd: HER_DIR, sessionId: requested })
  const id = String(created?.sessionId ?? created?.id ?? '')
  reserveWxSession(id)
  ```
  如果 `sc.create` 不接受 `sessionId`（抛错），回退到不带 `sessionId` 的旧调用，但保留 `reserveWxSession(requested)`，并把返回 id 也 reserve。
- 在 `index.js` 组装 `wxService` 的对象字面量里加 `isReservedSession: (id) => reservedWxSessions.has(String(id ?? ''))`；如果 `provideWxService` 是逐字段拷贝，把该字段一并加进去。
- `reg(tool)`：
  ```js
  const core = (() => { try { return ctx.get?.('fishCore') } catch { return null } })()
  const base = { ...tool, execute: (...a) => withGuiLock(() => tool.execute(...a)) }
  const def = tool.project && core?.tools?.wrapRender ? core.tools.wrapRender(base, { core }) : base
  disposers.push(ctx.tools.register(def))
  ```
  注意 `core.tools.wrapRender` 的签名是 `(def, opts) => wrapRenderOnly(def, { ...opts, core })`；Task 5 已定义。
- 给 `wx_context` 加 `project: (out) => ({ text: projectWxContext(out) })`；`wx_ocr` 加 `project: (out) => ({ text: projectWxOcr(out) })`；`wx_peek` 加 `project: (out) => ({ text: projectWxPeek(out) })`。`wx_*` 的 execute 仍返回字符串，`wrapRenderOnly` 不改返回值。

- [ ] **Step 4: 跑 dsh-wx 测试**

Run: `node --test`
Expected: 全绿（含新 `test-tool-surface.mjs`）。

- [ ] **Step 5: 跑 dsh-fish 全量**

Run: `cd ../dsh-fish && node --test`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/dsh-wx/lib/index.js src/dsh-wx/lib/project.js src/dsh-wx/test/tool-surface.test.mjs
git commit -m "feat(dsh-wx): 预分配 surface 会话并接入统一投影"
```

---

## Task 10: QQ surface 与返回投影适配

**Files:**
- Create: `src/dsh-fish/lib/qq-adapter.js`
- Modify: `src/dsh-fish/lib/index.js`（注册 adapter）
- Test: `src/dsh-fish/test/qq-adapter.test.mjs`

**Interfaces:**
- Consumes: `tools/post-execute`、`fishCore.surface.current`
- Produces:
  - `export function projectQqTool(name, value, content): ContentBlock[] | null`
  - `export function registerQqAdapter(ctx, { core, log }): () => void`
  - 只处理 `qq_*` 工具；未覆盖的工具返回 `null`，由 `tools/post-execute` 原样放行，并在 `status()` 里记 `legacy`。

- [ ] **Step 1: 写失败测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectQqTool, registerQqAdapter } from '../lib/qq-adapter.js'

test('qq 发送工具去掉 message_id/chatId', () => {
  const blocks = projectQqTool('qq_send_image', 'sent=true message_id=123 chatId=group_1', [])
  assert.equal(blocks[0].text, '[发出去了]')
  assert.equal(blocks[0].text.includes('123'), false)
})

test('qq_group_history 保留正文，不只是条数', () => {
  const raw = JSON.stringify({ messages: [{ nickname: '阿明', text: '晚上来吗' }, { nickname: '小李', text: '来' }] })
  const blocks = projectQqTool('qq_group_history', raw, [])
  assert.match(blocks[0].text, /阿明：晚上来吗/)
  assert.match(blocks[0].text, /小李：来/)
})

test('qq_napcat_api 未知 action 不返回原始 JSON', () => {
  const blocks = projectQqTool('qq_napcat_api', JSON.stringify({ retcode: 0, data: { secret: 'x' } }), [])
  assert.equal(blocks[0].text.includes('retcode'), false)
  assert.equal(blocks[0].text.includes('secret'), false)
})

test('非 qq 工具返回 null，不接管', () => {
  assert.equal(projectQqTool('wx_peek', 'x', []), null)
})

test('adapter 监听器抛错不影响工具结果', async () => {
  const listeners = []
  const ctx = { on: (ev, fn) => { listeners.push([ev, fn]); return () => {} } }
  registerQqAdapter(ctx, { core: { surface: { current: () => 'qq' } } })
  const fn = listeners.find(([ev]) => ev === 'tools/post-execute')[1]
  const result = { isError: false, content: [{ type: 'text', text: '原样' }] }
  const decision = await fn({ name: 'qq_send_image', agent: {} }, result, () => Promise.resolve({ kind: 'accept' }))
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.content[0].text, '[发出去了]')
  // 让 project 抛错也不改变原结果
  const bad = await fn({ name: 'qq_group_history', agent: {} }, { isError: false, content: [{ type: 'text', text: '原样' }] }, () => Promise.resolve({ kind: 'accept' }))
  assert.equal(bad.kind, 'accept')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/qq-adapter.test.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现**

- `projectQqTool` 纯函数：
  - `qq_send_*`：`[发出去了]` / `[没发出去：原因]`；从 value/content 里判断成功；绝不输出 `message_id`/`chatId`/路径。
  - `qq_group_history`：优先 JSON parse，取 `messages[]` 的 `nickname`/`text`（或 `sender.name`/`content`），渲染 `[群历史] 最近 N 条：\n昵称：原话`；解析失败就保留原文本但截断 4000 字。
  - `qq_napcat_api`：识别 `action`；群成员 → 名字/角色；OCR → 文字；其他 → `[拿到了]`；绝不输出原始 JSON/retcode。
  - 其他 `qq_*` 返回 `[拿到了]`；非 qq 返回 `null`。
- `registerQqAdapter` 注册 `tools/post-execute`：
  - `surface = core.surface.current(exec.agent)`；不是 `qq` 就 `return next()`。
  - `blocks = projectQqTool(exec.name, result.value, result.content)`；`null` → `next()`。
  - 返回 `{ kind:'accept', content: blocks }`；整体 `try/catch`，异常时 `return next()`。
  - 注意：`post-execute` 只能替换 content，不能替换失败结果的 value；失败结果也允许替换 content。
- `index.js` 注册并放进 disposers；`status()`/selfcheck 记录 `legacy` 工具名（未覆盖的 `qq_*`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/qq-adapter.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/qq-adapter.js src/dsh-fish/lib/index.js src/dsh-fish/test/qq-adapter.test.mjs
git commit -m "feat(dsh-fish): QQ 工具返回投影适配层"
```

---

## Task 11: 自检、文档与验收

**Files:**
- Modify: `src/dsh-fish/lib/selfcheck.js`（策略/surface/台账/wrapped-legacy）
- Modify: `src/dsh-fish/README.md`、`src/dsh-fish/AGENTS.md`、`src/dsh-fish/CHANGELOG.md`、根 `README.md`（只写行为变化和边界）
- Test: `src/dsh-fish/test/selfcheck.test.mjs`（新增断言）

**Interfaces:**
- Consumes: `readRestrictState`、`core.surface.list()`、`ledger.status()`
- Produces: `/selfcheck` 多三项：
  - `surface`：当前识别到的面数量与各面名称
  - `tool-policy`：当前面 always/deferred 数量、revealed 数量
  - `tool-ledger`：最近写入/失败/artifact 数量；`legacy` 工具列表可见

- [ ] **Step 1: 写失败测试**

在 `selfcheck.test.mjs` 追加：构造 `o.tools = { surface: [...], policy: {...}, ledger: { written: 3, failed: 0, artifacts: 1 } }`，断言输出含 `surface`、`tool-policy`、`tool-ledger` 三项，且 `legacy` 出现在描述里。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/selfcheck.test.mjs`
Expected: 新断言 FAIL。

- [ ] **Step 3: 实现**

- `observe.js` 传 `surface`/`policy`/`ledger` 状态给 `selfcheck`（按现有 `o` 结构扩展；不引入新服务调用）。
- `selfcheck.js` 加三项，文案中性；`legacy` 必须显示工具名，不能只说“部分未覆盖”。
- 文档只写：
  - 工具可见性由 `tool-policy` 唯一决定；`config.tools.allow` 仅作 web 额外放行兼容；
  - `her_tools` 的 search/describe/load 语义；
  - 台账位置、保留策略（不自动删除）；
  - 本辑未做：B 站独立出门会话、`dsh-bili` 拆包、事件 v3 跨面记忆；QQ/B 站仍按旧调度运行。
- `CHANGELOG.md` 写清“未改事件流、未改发送闸”。

- [ ] **Step 4: 跑全量**

Run:
```bash
cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test
cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-wx && node --test
```
Expected: 两边全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/selfcheck.js src/dsh-fish/lib/observe.js src/dsh-fish/test/selfcheck.test.mjs src/dsh-fish/README.md src/dsh-fish/AGENTS.md src/dsh-fish/CHANGELOG.md README.md
git diff --cached --check
python3 scripts/audit-staged.py
git commit -m "docs: 工具策略与台账自检、边界说明"
```

---

## Task 12: 端到端假宿主验收

**Files:**
- Create: `src/dsh-fish/test/integration-tool-exposure.test.mjs`

**Interfaces:**
- Consumes: 全部前序模块
- Produces: 一条不依赖真实宿主的端到端测试，证明“面 → allow → restrict → load → 下一步 allow → her_tools 目录”闭环

- [ ] **Step 1: 写失败测试**

测试构造 fake ctx（`provide/get/on/tools.register`）和两个 fake agent（web/wx），走：
1. `provideFishCore` + `registerToolRestrict`；
2. 触发 `agent/created`；
3. 断言 web allow 不含 `wx_*`、wx allow 含 `wx_peek` 不含 `wx_see`；
4. 调 `her_tools` 的 `search`，断言只列 wx deferred；
5. 调 `load({group:'wx.ui'})`，断言 restrict 被重新下、disposer 被调用、新 allow 含 `wx_see`；
6. 调 guard，断言 `wx_see` 放行、`bili_look` 仍拒绝；
7. 调一次工具并触发 `tools/result`，断言台账文件存在且 `tool`/`surface`/`modelText` 正确。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/integration-tool-exposure.test.mjs`
Expected: FAIL（模块/接口未齐）。

- [ ] **Step 3: 让测试通过**

只改生产代码中真实缺口；不改测试来绕开。若发现设计冲突（例如宿主 `restrict` 不接受某个名字），在计划文档末尾追加“实现偏差”一节，写清偏差和原因。

- [ ] **Step 4: 跑两边全量并提交**

```bash
cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-fish && node --test
cd ../dsh-wx && node --test
cd /home/str1k3/src/bigfish-workspace-dev
git add src/dsh-fish/test/integration-tool-exposure.test.mjs
git commit -m "test(dsh-fish): 工具暴露端到端闭环"
```

---

## 最终验收清单

- [ ] `src/dsh-fish` 的 `node --test` 全绿；`src/dsh-wx` 的 `node --test` 全绿。
- [ ] `git diff --cached --check` 干净；`python3 scripts/audit-staged.py` 通过。
- [ ] 所有提交只在 `dev` 工作树；`main` 未改动。
- [ ] 报告中分别列出：本地单测、提交 SHA、未推送/未部署、未做真实模型调用。
- [ ] 明确记录本辑未做：B 站独立出门会话、`dsh-bili` 拆包、事件 v3、QQ vendor 薄 fork。
- [ ] 如果有实现偏差，追加在本文末尾“实现偏差”一节。

---

## 实现偏差（终版记录，2026-11-10）

以下偏差都在逐任务审查或终审中确认过，均为有意选择，不是漏做：

1. **`fishCore` 惰性解析**：计划里 `dsh-wx` 的 `reg()` 片段在 apply 阶段就 `ctx.get('fishCore')`；实际改为 `lazyRender` 在 render 时解析并只缓存成功结果。原因：profile bundle 里 `dsh-wx` 先于 `dsh-fish` 应用，`fishCore` 要等异步 `boot()`，apply 阶段判断会静默关掉投影（Task 9 Critical）。
2. **台账只观察 `tools/result`**：不使用 `tools/post-execute`。宿主那里监听器抛错会把成功调用翻成 isError；`tools/result` 是只读观察点，写失败只记 `status()`。
3. **`ownTools` 并入 `her_tools`**：`agent/created` 早于本插件注册工具，启动期宿主名单过滤必须把 `[...FISH_TOOLS, 'her_tools']` 并进去，否则她自己的工具被静默剥掉（Task 6 C1）。
4. **工具注册整体移到 `bootstrapHomeWithRetry` 之前**：`restrict` 因「名字还没登记」报错时的自愈会按宿主人名单求交集，把 `her_tools` 一起丢掉。注册提前后竞态消失；自愈分支保留，并改为如实上报实际生效名单（终审 I3）。
5. **`wx_ocr` 返回完整 JSON，投影侧截断**：先截 24k 再解析会把原始 JSON（含 `box`）回吐给模型并丢掉大部分文字。现在 `execute` 返回完整 JSON（台账落 artifact），模型投影只出可读文字；`fishCore` 缺席的降级渲染单独限 24k（终审 I2）。
6. **未知 `qq_*` 原样放行并记入 `legacy`**：不做统一投影。整段替换会毁掉未来 vendor 工具已经渲染好的内容；只有策略表里的 7 个 QQ 名字走投影（Task 10 返修）。
7. **计划内 Task 4 测试片段的两处修正**（`writeFile` import、用普通文件占位制造写失败）随本文件一并提交；这是计划文本的勘误，不影响实现。

终版验证：`src/dsh-fish` 796/796、`src/dsh-wx` 67/67；所有提交只在 `dev` worktree，`main` 未动；未推送、未在 WSL 拉取、未部署重启，未做真实模型调用与消息收发验收。
