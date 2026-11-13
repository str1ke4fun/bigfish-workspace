# 微信群里像她自己（wx-group-voice）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `2026-11-12-wx-group-voice-design.md` 落地四件事：群段放宽、每群主动额度、微信提示词拆成短规则 + 工具手册、微信限流覆盖层。

**Architecture:** 三个纯模块（`speech.js` 的通道覆盖、`proactive.js` 的额度账本、可独立求值的两段提示词）承担全部判定；`index.js` 只在 `gateSend` 与各发送路径接线。工作台只做读写与展示，不另存一份状态。主动额度只在真正发送前的最后一次 `gateSend` 扣一次，避免一次发送被多次闸门重复计数。

**Tech Stack:** Node.js ≥20、原生 ESM、`node:test`、零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-12-wx-group-voice-design.md`

## Global Constraints

- 零新增 npm 依赖；只用 Node 内置模块与 `node:test`。
- 不改 QQ 的限流行为：`speech.json` 的顶层 base 不动，微信只走 `wx` 覆盖层。
- 不改事件流 schema、不改台账格式、不新增模型工具。
- 不动私聊语义：`noMentionChats` 仍然随时能说，且不消耗主动额度；被 @ 窗口内也不消耗。
- 群隐私禁令保留：窗口、坐标、白名单、门禁、发没发出去、她和老哥的私事，仍然不进群。
- 新文案不出现男字旁的「他」、不出现「三道门 / 四道门」。
- 工作台整份重写 policy 时必须保留未知/旧键（`watch`、`trigger`、`proactive*`），不能因为漏一个键把配置清掉。
- 测试命令：`src/dsh-fish`、`src/dsh-wx`、`workbench` 各自 `node --test`；提交前 `git diff --cached --check` 与 `python scripts/audit-staged.py`。
- 只暂存本任务涉及的明确路径；不碰 `src/dsh-wx/lib/sticker-panel.mjs` 等未跟踪文件。

## Review Focus

- **一次发送扣多次额度**：`gateSend()` 在一次发送里会被调用 2–3 次；只有最后一道、真正按回车/点发送前的调用能消费额度，前几次只检查。
- **额度为 0 时绕过 @ 闸**：额度 0、状态文件损坏、群名对不上，都必须拒绝主动发言，不能默认放行。
- **不该扣额度的路径被扣**：`noMentionChats`、@ 窗口内、`wx_type enter=false`、到点提醒 permit，都不消耗主动额度。
- **工作台保存丢键**：`saveWxScope` / `saveSpeech` 是整份重写；漏掉 `watch`、`trigger`、`wx` 覆盖或旧的 `proactiveChats` 会静默清掉配置。
- **手册拆分把安全规则挪走**：短段必须保留通知语义、@/免 @ 规则、群隐私禁令和"发不出去就说"；工具手册可以后置，但不能让短段失去判断依据。
- **QQ 被微信覆盖层带偏**：`resolve(policy, 'qq')` 必须与 `normalize` 的顶层值完全一致。

---

### Task 1: 微信限流覆盖层

**Files:**
- Modify: `src/dsh-wx/lib/speech.js`
- Test: `src/dsh-wx/test-speech-override.mjs`

**Interfaces:**
- Produces:
  - `WX_DEFAULTS = { minGapSeconds: 8, maxPerMinute: 4, maxPerHour: 40 }`
  - `normalize(raw) -> { enabled, minGapSeconds, maxPerMinute, maxPerHour, wx: { minGapSeconds, maxPerMinute, maxPerHour } }`
  - `resolve(policy, channel = 'qq') -> { enabled, minGapSeconds, maxPerMinute, maxPerHour }`
  - `admit(chatKey, now = Date.now(), channel = channelOf(chatKey))`
  - `waitAndAdmit(chatKey, maxWaitMs = 60_000, now = Date.now, channel = channelOf(chatKey))`
- `channelOf(chatKey)` 返回 `'wx'`（key 以 `wx:` 开头）否则 `'qq'`。

- [ ] **Step 1: 写失败测试**

`test-speech-override.mjs` 用临时 `SPEECH_POLICY` / `SPEECH_STATE`，在 `import` 前设置 env（模块顶层读路径）：

```js
process.env.SPEECH_POLICY = join(tmp, 'speech.json')
process.env.SPEECH_STATE = join(tmp, 'state.json')
const { normalize, resolve, decide, DEFAULTS, WX_DEFAULTS } = await import('./lib/speech.js')

const raw = normalize({})
assert.deepEqual(raw.wx, WX_DEFAULTS)
assert.equal(resolve(raw, 'qq').minGapSeconds, DEFAULTS.minGapSeconds)
assert.equal(resolve(raw, 'wx').minGapSeconds, 8)
assert.equal(resolve(normalize({ wx: { minGapSeconds: 3, maxPerMinute: 6, maxPerHour: 60 } }), 'wx').maxPerMinute, 6)
assert.equal(resolve(normalize({ wx: { maxPerMinute: 999 } }), 'wx').maxPerMinute, 1000)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-speech-override.mjs`
Expected: FAIL，`WX_DEFAULTS`/`resolve` 未导出。

- [ ] **Step 3: 实现覆盖层**

`normalize` 先按原逻辑算 base，再用同一套 `num()` 把 `raw.wx` 归一到 `WX_DEFAULTS`。`resolve` 对 `'wx'` 返回 `{ enabled: policy.enabled, ...policy.wx }`，其他通道返回顶层四键。`admit` / `waitAndAdmit` 把 `channel` 透传给 `resolve`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test-speech-override.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/dsh-wx/lib/speech.js src/dsh-wx/test-speech-override.mjs
git commit -m "feat(dsh-wx): 微信说话频率覆盖层"
```

---

### Task 2: 主动额度纯模块

**Files:**
- Create: `src/dsh-wx/lib/proactive.js`
- Test: `src/dsh-wx/test-proactive.mjs`

**Interfaces:**
- Produces:
  - `STATE_FILE = process.env.WX_PROACTIVE_STATE || '/home/str1k3/.dsh-wx/proactive.json'`
  - `MAX_PER_DAY = 50`
  - `dateKey(now = Date.now()) -> 'YYYY-MM-DD'`（本地时区）
  - `parseQuota(v) -> 0..50`（NaN/负数落 0）
  - `quotaFor(policy, chat) -> number`（`proactiveChats[chat] ?? proactivePerDay`，再 clamp）
  - `loadState(file = STATE_FILE, now = Date.now()) -> { day, used }`
  - `saveState(state, file = STATE_FILE) -> boolean`
  - `remaining(policy, state, chat, today = dateKey()) -> number`
  - `consume(policy, state, chat, today = dateKey()) -> { state, left }`
  - `decideProactive({ policy, state, chat, mention, exempt, now }) -> { ok, proactive, left, why? }`

- [ ] **Step 1: 写失败测试**

```js
import assert from 'node:assert/strict'
import { dateKey, parseQuota, quotaFor, loadState, remaining, consume, decideProactive } from './lib/proactive.js'

const NOW = new Date(2026, 10, 13, 10, 0, 0).getTime()
assert.equal(dateKey(NOW), '2026-11-13')
assert.equal(parseQuota(-1), 0)
assert.equal(parseQuota(999), 50)
assert.equal(quotaFor({ proactivePerDay: 0, proactiveChats: { 群A: 5 } }, '群A'), 5)
assert.equal(quotaFor({ proactivePerDay: 2 }, '群B'), 2)

const state = { day: dateKey(NOW), used: { 群A: 2 } }
assert.equal(remaining({ proactiveChats: { 群A: 5 } }, state, '群A', dateKey(NOW)), 3)
const c = consume({ proactiveChats: { 群A: 5 } }, state, '群A', dateKey(NOW))
assert.equal(c.left, 2)
assert.equal(c.state.used['群A'], 3)
assert.equal(state.used['群A'], 2, 'consume 必须是纯函数')

assert.deepEqual(
  decideProactive({ policy: { proactiveChats: { 群A: 5 } }, state, chat: '群A', mention: { ok: false }, exempt: false, now: NOW }),
  { ok: true, proactive: true, left: 3 },
)
assert.equal(decideProactive({ policy: { proactiveChats: { 群A: 0 } }, state, chat: '群A', mention: { ok: false }, exempt: false, now: NOW }).ok, false)
assert.equal(decideProactive({ policy: {}, state, chat: '群A', mention: { ok: true }, exempt: false, now: NOW }).proactive, false)
assert.equal(decideProactive({ policy: {}, state, chat: '群A', mention: { ok: false }, exempt: true, now: NOW }).proactive, false)
```

坏文件：写 `{ day:'2000-01-01', used:{群A:9} }`，`loadState` 必须返回 `{ day: 今天, used: {} }`；写坏 JSON 返回空账本。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-proactive.mjs`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现纯模块**

`loadState` 只认 `used` 里的非负整数；`day !== today` 时清空。`saveState` 先 `mkdirSync(dirname(file))`，tmp + rename，失败返回 `false`，不抛。`decideProactive` 的顺序固定：`requireMention === false` → 放行、不主动；`exempt` → 放行、不主动；`mention.ok` → 放行、不主动；否则看 `remaining`，`<= 0` 拒绝并带 `mention.reason`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test-proactive.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/dsh-wx/lib/proactive.js src/dsh-wx/test-proactive.mjs
git commit -m "feat(dsh-wx): 每群主动额度账本"
```

---

### Task 3: 把主动额度接进发送闸

**Files:**
- Modify: `src/dsh-wx/lib/index.js`
- Test: 由 Task 2 的纯模块覆盖；本任务只做接线，跑 `node --test` + `test-proactive.mjs`

**Interfaces:**
- `policy()` 新增 `proactivePerDay`、`proactiveChats`。
- `gateSend({ consume = false } = {})` 返回 `{ chat, snap, proactive, proactiveLeft }`。
- `sendToChat` 返回新增 `proactive`、`proactiveLeft`；`wx_send` 的文本在主动发言时追加一句剩余额度。

- [ ] **Step 1: 在 `policy()` 里读取额度**

```js
proactivePerDay: parseQuota(raw.proactivePerDay),
proactiveChats: raw.proactiveChats && typeof raw.proactiveChats === 'object'
  ? Object.fromEntries(Object.entries(raw.proactiveChats).map(([k, v]) => [String(k).trim(), parseQuota(v)]).filter(([k, v]) => k && v > 0))
  : {},
```

- [ ] **Step 2: 改 `gateSend`**

保留现有的允许名单 / 免 @ / 主机闸 / 树落后检查。在 `canSpeak` 之后改为：

```js
const verdict = p.requireMention && !exempt ? canSpeak(readMentions(), hit, Date.now(), p.mentionWindowMinutes) : { ok: true }
const state = loadState()
const dec = decideProactive({ policy: p, state, chat: hit, mention: verdict, exempt, now: Date.now() })
if (!dec.ok) throw new Error(`「${hit}」${dec.why}；今天这个群的主动额度也用完了，先不发。`)
let left = dec.left
if (dec.proactive && consume) {
  const next = consume(p, state, hit)
  saveState(next.state)
  left = next.left
  logInbound({ type: 'proactive-send', chat: hit, remaining: left })
}
return { chat: hit, snap: s, proactive: dec.proactive, proactiveLeft: left }
```

注意：`decideProactive` 已经处理 `requireMention === false`、`exempt`、`mention.ok`，不要在 `gateSend` 里再写一套判断。

- [ ] **Step 3: 只在每个发送路径的最后一道闸消费**

逐处改成 `gateSend({ consume: true })`：
- `sendToChat` 非 permit 分支的**最后一次** `gateSend`（回车前、`speechGate` 之后）。
- `wx_type` 的 `enter === true` 第二次 `gateSend`。
- `wx_click` 的「发送」按钮回退分支。
- `sendStickerToChat` 的 `last`。
- `searchStickerInChat` 的 `last`。
- `wx_key` 的 Return 分支。

其余 `gateSend()`（初次检查、permit 分支）保持 `consume: false`。permit 到点提醒不消费额度。

- [ ] **Step 4: 把额度写进 `wx_send` 的返回文本**

`sendToChat` 返回里带 `proactive: last.proactive, proactiveLeft: last.proactiveLeft`；`wx_send` 的 `execute` 在成功文本后追加：

```js
const pro = r.proactive ? `这条用了主动额度，今天「${r.chat}」还剩 ${r.proactiveLeft} 条。` : ''
return `已发到「${r.chat}」。${r.receipt}${taskLine ? ' ' + taskLine : ''}${pro ? ' ' + pro : ''}` + fresh.notice()
```

- [ ] **Step 5: 验证与提交**

Run: `cd src/dsh-wx && node --test`
Expected: 原有 67 + 新增用例全绿。
Run: `grep -n "gateSend({ consume: true })" src/dsh-wx/lib/index.js`
Expected: 恰好 6 处，且都在最终发送动作之前。

```bash
git add src/dsh-wx/lib/index.js
git commit -m "feat(dsh-wx): 主动额度接入发送闸"
```

---

### Task 4: 提示词拆成短规则 + 工具手册

**Files:**
- Modify: `src/dsh-wx/lib/index.js`
- Test: `src/dsh-wx/test-prompt-split.mjs`

**Interfaces:**
- `channelRulesText(policy = policy(), { proactiveState, now = Date.now() } = {}) -> string`
- `channelManualText() -> string`
- `proactivePromptLine(policy, state = loadState(), now = Date.now()) -> string`（无额度返回空串）
- 挂载：`channel:dsh-wx` order 92 = `channelRulesText()`；`channel:dsh-wx-manual` order 8600 = `channelManualText()`。

- [ ] **Step 1: 写失败测试**

```js
import assert from 'node:assert/strict'
import { channelRulesText, channelManualText, proactivePromptLine } from './lib/index.js'

const p = { enabled: true, allowChats: ['群A'], noMentionChats: ['私聊B'], requireMention: true, mentionWindowMinutes: 3, proactivePerDay: 0, proactiveChats: { 群A: 5 } }
const state = { day: '2026-11-13', used: { 群A: 2 } }
const short = channelRulesText(p, { proactiveState: state, now: new Date(2026, 10, 13).getTime() })
const manual = channelManualText()

assert.match(short, /\[微信\]/)
assert.match(short, /侧栏预览/)
assert.match(short, /任务：t_/)
assert.match(short, /窗口、坐标、白名单/)
assert.match(short, /发不出去就算了/)
assert.match(short, /主动说/)
assert.doesNotMatch(short, /wx_sticker_send/)
assert.match(manual, /wx_peek/)
assert.match(manual, /不能含换行/)
assert.match(manual, /点下去就发送/)
assert.ok(manual.length > short.length)
assert.equal(proactivePromptLine({ proactiveChats: {} }, state), '')
assert.match(proactivePromptLine(p, state), /群A（剩 3\/5）/)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-prompt-split.mjs`
Expected: FAIL，导出不存在。

- [ ] **Step 3: 拆函数**

把现有 `promptText()` 拆成两个可独立求值的导出函数：
- 短段只保留：`[微信]`/`[微信·逾期]` 通知语义、任务 id、只在被叫到/免 @/主动额度内开口、群隐私禁令、发不出去就说、用 `wx_context` 查前文 / `wx_peek` 点开全文、发完最多补一句、对话框里的主机指令、当前状态、`requireMention` 动态句、`proactivePromptLine`。
- 手册段保留 15 个工具说明、普通发送流程、到点提醒流程、界面会变以返回为准、表情发送的"点下去就发送/没有二次确认/wx_type 不能含换行"等跨工具易错点。
- `channelRulesText` 的 `policy` 参数默认 `policy()`；测试传假 policy 时不读真实文件。`proactivePromptLine` 的 state 可注入。
- 文案里把原有的「他问什么」改成「主机问什么」，不新增男字旁的「他」。

- [ ] **Step 4: 改 `agent/created` 挂两段**

```js
agent.ctx?.systemPrompt?.section?.({
  name: 'channel:dsh-wx',
  order: 92,
  text: () => channelRulesText(),
})
agent.ctx?.systemPrompt?.section?.({
  name: 'channel:dsh-wx-manual',
  order: 8600,
  text: () => channelManualText(),
})
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test-prompt-split.mjs`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/dsh-wx/lib/index.js src/dsh-wx/test-prompt-split.mjs
git commit -m "feat(dsh-wx): 微信提示词拆成短规则与工具手册"
```

---

### Task 5: 身份文本群段放宽

**Files:**
- Modify: `src/dsh-fish/lib/selfdoc.js:133`
- Test: `src/dsh-fish/test/mem.test.mjs`

**Interfaces:**
- 仅改一行：`群里平时短。认真问技术、认真讲心事时再展开，一条别超过一屏。` → `群里平时短；认真问技术、认真讲心事，或这件事本来就需要说清楚时再展开，一条别超过一屏。`

- [ ] **Step 1: 写失败测试**

在 `mem.test.mjs` 既有 `model()` 辅助旁加：

```js
test('群段允许把需要说清楚的事讲完，但不放开私事与黏人', () => {
  const doc = renderSelfDoc(model(), { carry: '' })
  assert.match(doc, /群里平时短；认真问技术、认真讲心事，或这件事本来就需要说清楚时再展开/)
  assert.match(doc, /可以软，不黏，不叫哥，不讲你和他的事/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/mem.test.mjs`
Expected: FAIL，匹配不到新措辞。

- [ ] **Step 3: 改这一行并确认通过**

Run: `cd src/dsh-fish && node --test test/mem.test.mjs`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/dsh-fish/lib/selfdoc.js src/dsh-fish/test/mem.test.mjs
git commit -m "feat(dsh-fish): 群段允许把话说清楚"
```

---

### Task 6: 工作台读写新配置

**Files:**
- Modify: `workbench/server.mjs`
- Test: `workbench/test/policy.test.mjs`

**Interfaces:**
- `normalizeSpeechPolicy(raw) -> { enabled, minGapSeconds, maxPerMinute, maxPerHour, wx: { minGapSeconds, maxPerMinute, maxPerHour } }`
- `normalizeWxProactive(body = {}, before = {}) -> { proactivePerDay, proactiveChats }`
- `localDateKey(now = Date.now()) -> 'YYYY-MM-DD'`
- `wxPolicy()` 返回值新增 `proactivePerDay`、`proactiveChats`。
- `wxScope()` 返回值新增 `proactiveUsed`（当天、`{ 群名: 已用条数 }`）。
- `saveWxScope` 保存 `proactivePerDay` / `proactiveChats`；`proactiveChats` 的键也过 `looksGarbled`。
- `speechPolicy()` 返回 `wx` 覆盖；`saveSpeech()` 写回 `wx`。

- [ ] **Step 1: 写失败测试**

`workbench/test/policy.test.mjs` 直接 import server 导出的纯函数：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSpeechPolicy, normalizeWxProactive, localDateKey } from '../server.mjs'

test('speech 覆盖层：缺省 wx=8/4/40，QQ 仍是 base', () => {
  const p = normalizeSpeechPolicy({})
  assert.deepEqual(p.wx, { minGapSeconds: 8, maxPerMinute: 4, maxPerHour: 40 })
  assert.equal(p.minGapSeconds, 25)
  assert.equal(normalizeSpeechPolicy({ wx: { minGapSeconds: 2 } }).wx.minGapSeconds, 2)
})

test('主动额度：保留旧值、clamp 0..50、丢掉 0', () => {
  assert.deepEqual(normalizeWxProactive({}, { proactivePerDay: 3, proactiveChats: { 群A: 5 } }), { proactivePerDay: 3, proactiveChats: { 群A: 5 } })
  assert.deepEqual(normalizeWxProactive({ proactivePerDay: 99, proactiveChats: { 群A: 0, 群B: -2, 群C: 7 } }), { proactivePerDay: 50, proactiveChats: { 群C: 7 } })
})

test('localDateKey 用本地日期', () => {
  assert.equal(localDateKey(new Date(2026, 10, 13, 23, 59).getTime()), '2026-11-13')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/policy.test.mjs`
Expected: FAIL，导出不存在。

- [ ] **Step 3: 实现并接线**

- 新增并导出三个纯函数；`speechPolicy()` / `saveSpeech()` 都走 `normalizeSpeechPolicy`，保存时 `wx` 一并写回。
- `wxPolicy()` 在返回对象里展开 `normalizeWxProactive(j)`。
- `wxScope()` 读 `~/.dsh-wx/proactive.json`：`day === localDateKey()` 时把 `used` 作为 `proactiveUsed`，否则 `{}`；读失败按空。
- `saveWxScope()`：`const pro = normalizeWxProactive(body, before)`；`next` 加 `...pro`；坏名检查加入 `Object.keys(pro.proactiveChats)`。`saveWxScope` 目前用 `before.watch` / `before.trigger` 兜底，保持。
- `/api/speech` 的 `note` 可以追加微信覆盖值，但不是必须。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/policy.test.mjs`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add workbench/server.mjs workbench/test/policy.test.mjs
git commit -m "feat(workbench): 微信主动额度与限流覆盖读写"
```

---

### Task 7: 工作台表单与文案

**Files:**
- Modify: `workbench/assets/legacy-channels.js`
- Modify: `workbench/assets/channels.js`
- Test: `workbench/test/assets.test.mjs`

**Interfaces:**
- 新增 DOM id：`wx-proactive-perday`、`wx-proactive-chats`（容器，内部 input `data-chat`）。
- 新增限流输入：`speech-wx-gap`、`speech-wx-permin`、`speech-wx-perhour`。
- `renderWxScope` 为每个 `allowChats` 生成一个数字框，值来自 `policy.proactiveChats[chat] ?? ''`。
- 保存时 `picked('#wx-proactive-chats')` 不适用；用 `proactiveChatsFromDom()` 读 `input[data-chat]`，只收 `> 0`。
- 说话频率区新增「微信覆盖」三个数字框和一行的说明：微信默认 8 秒 / 4 条每分钟 / 40 条每小时，QQ 仍用上面的值。

- [ ] **Step 1: 写失败测试**

在 `assets.test.mjs` 加：

```js
test('主动额度与微信限流字段都在通道模块里', () => {
  const legacy = read('legacy-channels.js')
  for (const id of ['wx-proactive-perday', 'wx-proactive-chats', 'speech-wx-gap', 'speech-wx-permin', 'speech-wx-perhour']) {
    assert.match(legacy, new RegExp(`id="${id}"`), id)
  }
  const js = read('channels.js')
  assert.match(js, /proactivePerDay/)
  assert.match(js, /proactiveChats/)
  assert.match(js, /speech-wx-gap/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/assets.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 加 DOM 与读写**

- `legacy-channels.js`：`wx-scope` 的允许名单下面加「主动额度」小节；`speech` 卡片底部加「微信覆盖」三个输入。
- `channels.js` 的 `loadSpeech` / `speech-save` 读写 `wx.*`。
- `renderWxScope` 渲染 `#wx-proactive-chats`，每个 input 带 `data-chat`；`wx-scope-save` 的 body 加 `proactivePerDay` 与 `proactiveChats`。
- `wx-scope-summary` 可追加「主动额度 N 个会话」；不写男字旁的「他」。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add workbench/assets/legacy-channels.js workbench/assets/channels.js workbench/test/assets.test.mjs
git commit -m "feat(workbench): 主动额度与微信限流表单"
```

---

### Task 8: 文档、全量验证与收尾

**Files:**
- Modify: `src/dsh-wx/README.md`（配置段补 `proactivePerDay` / `proactiveChats` / `speech.json` 的 `wx` 覆盖）
- 可选：`README.md` 的微信能力描述补一句主动额度

- [ ] **Step 1: 更新 README 配置示例**

在 `policy.json` 示例里加：

```json
"proactivePerDay": 0,
"proactiveChats": { "测试群A": 5 }
```

并说明：`0` 表示不主动；只对 `allowChats` 生效；@ 窗口内和 `noMentionChats` 不消耗。

- [ ] **Step 2: 全量测试**

```bash
cd src/dsh-fish && node --test
cd ../dsh-wx && node --test
cd ../../workbench && node --test
```

Expected: `dsh-fish` 957+；`dsh-wx` 67+；`workbench` 75+；0 fail。

- [ ] **Step 3: 检查暂存与凭据**

```bash
git diff --cached --check
python scripts/audit-staged.py
```

- [ ] **Step 4: 提交文档**

```bash
git add src/dsh-wx/README.md README.md
git commit -m "docs: 微信主动额度与限流覆盖说明"
```

- [ ] **Step 5: 报告交付状态**

分别报告：本地测试、提交 SHA、是否推送、是否合并 dev、是否部署/重启、真实微信验收边界。**不把单测通过写成"群里的说话方式已经验收"**；主动额度需要用户先把某个群的额度设成 5，观察一天。

---

## Self-Review

**Spec coverage:**
- §3.1 群段 → Task 5。
- §3.2 主动额度（配置 / 状态 / gateSend / 返回 / 提示词 / 工作台）→ Task 2、3、4、6、7。
- §3.3 手册拆分 → Task 4。
- §3.4 限流覆盖 → Task 1、6、7。
- §3.5 工作台与部署 → Task 6、7、8。
- §4 错误处理 → Task 2（坏文件按 0）、Task 3（额度 0 拒绝）、Task 6（坏名拒存）、Task 4（段不可用时只挂短段）。
- §5 测试 → Task 1、2、4、5、6、7 覆盖纯函数；真机验收在 Task 8 明确边界。

**Type consistency:** `gateSend({ consume })`、`decideProactive`、`remaining` / `consume` 的签名在 Task 2/3 一致；`normalizeSpeechPolicy` / `normalizeWxProactive` 在 Task 6/7 一致。

**Proportion:** 计划给签名、断言与关键算法，不抄整段实现；`index.js` 的大段改造只标出六个消费点。
