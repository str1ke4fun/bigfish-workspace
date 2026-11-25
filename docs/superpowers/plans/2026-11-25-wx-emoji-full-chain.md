# 微信群聊 emoji 全链路支持实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让微信侧在树健康时完整支持带 emoji 的群名（读名、匹配、发送、配额、工作台），树不可用时 OCR 安全降级。

**Architecture:** 新增 `lib/name.js` 统一名称语义；目录、树、发送链、状态键、OCR、工作台全部收口到它；`chatId` 作为身份和状态键；发送目标只走 exact/folded，歧义 fail closed。

**Tech Stack:** Node.js 20+（ESM，零依赖），`node --test`，既有 workbench / dsh-fish 测试。

**Spec:** `docs/superpowers/specs/2026-11-25-wx-emoji-full-chain-design.md`

## Global Constraints

- `src/dsh-wx` 保持零依赖；不引入新包；Node.js >= 20。
- `chatIdFor` 的实现和派生种子不变：种子是 `chatIdSeed`（trim + 连续空白压成一个），**不要**先做 NFC 再取 id。
- 发送目标只走 `exact` / `folded`；不做前缀、后缀、包含、拼音、编辑距离。前缀只用于**截断名解析**和 OCR 对已知全名的对账。
- `ambiguous` 与 `unknown` 必须区分：`ambiguous` 返回空/`null` 并 fail closed，不能和未知共用一个 `''`。
- OCR 名字不写目录、不写 policy、不写 `chatId`；OCR 只确认明确的 `@我` 角标。
- 台账、任务、摘要、事件流只追加；不迁移、不改写历史 `chatId`。
- 测试夹具只用合成/匿名化数据；不得提交活的 `~/.dsh-wx/directory.json`、群名、聊天记录。
- 不改外部 `/home/str1k3/dsh-plugins/speech/` 模块；speech key 由 dsh-wx 构造。
- 每个任务结束跑对应测试并提交；提交信息按模块前缀（`feat(dsh-wx): ...`、`feat(workbench): ...`、`feat(dsh-fish): ...`）。

## Review Focus

1. **纯 emoji / 纯旗帜 / 纯 keycap / 纯 tag 群名**：树和工作台候选必须接受，OCR 过滤不能把整行判死。
2. **完整名字以 VS16 / 肤色 / keycap 结尾**（`❤️`、`👍🏽`、`1️⃣`）：`displayName`/`sanitizeName` 不得改写，`cleanTruncated` 不得参与。
3. **截断点落在 ZWJ / 旗帜 / tag 序列中间**：不得持久化孤立代理、半个旗帜、悬空 ZWJ/VS。
4. **只差大小写 / VS / ZWJ 的名字**：VS 折叠、大小写与 ZWJ 不折叠；折叠撞名 fail closed。
5. **旧 bug 造成的两个真实 `chatId` 分裂**：加载后必须 fail closed，不自动合并、不静默发到其中一个。

---

## File Structure

**新增**

- `src/dsh-wx/lib/name.js` — 名称原语：display/exact/folded/skeleton、sanitize、grapheme、truncation、matchOne。
- `src/dsh-wx/lib/state-key.js` — 临时状态的一次性迁移纯函数。
- `src/dsh-wx/test/name.test.mjs`
- `src/dsh-wx/test/directory-emoji.test.mjs`
- `src/dsh-wx/test/tree-emoji.test.mjs`
- `src/dsh-wx/test/send-identity.test.mjs`
- `src/dsh-wx/test/state-key.test.mjs`
- `src/dsh-wx/test/ocr-emoji.test.mjs`
- `workbench/wx-names.mjs` — 工作台的乱码判定、名单规范化。
- `workbench/test/wx-emoji-scope.test.mjs`
- `src/dsh-fish/test/work-dispatch-emoji.test.mjs`

**修改**

- `src/dsh-wx/lib/directory.js`、`tree.js`、`chat-label.js`、`capture.js`、`context.js`、`capture-run.js`、`ear-open.js`
- `src/dsh-wx/lib/mention.js`、`proactive.js`、`send-gate.js`、`reminder.js`、`project.js`、`wx-send-tool.js`、`index.js`
- `src/dsh-wx/lib/ocr-snapshot.mjs`、`ocr.js`、`chats-json.mjs`、`ocr-complete.js`
- `workbench/server.mjs`、`workbench/assets/channels.js`、`workbench/assets/channels/wx.js`
- `src/dsh-fish/lib/work.js`、`src/dsh-fish/lib/feedback-audit.js`
- `src/dsh-wx/README.md`、`src/dsh-wx/NEXT-STAGE.md`

---

### Task 1: 名称原语 `lib/name.js`

**Files:**
- Create: `src/dsh-wx/lib/name.js`
- Test: `src/dsh-wx/test/name.test.mjs`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `sanitizeName(value: unknown): string`
  - `displayName(value: unknown): string`
  - `nameKey(value: unknown): string`
  - `foldedKey(value: unknown): string`
  - `skeleton(value: unknown): string`
  - `chatIdSeed(value: unknown): string`
  - `graphemeLength(value: unknown): number`
  - `cleanTruncated(value: unknown): string`
  - `hasNameCharacter(value: unknown): boolean`
  - `sameName(a: unknown, b: unknown): boolean`
  - `tierKey(value: unknown, tier: 'exact' | 'folded' | 'skeleton'): string`
  - `matchOne(input: string, candidates: string[], opts?: { tiers?: Array<'exact'|'folded'|'skeleton'>; prefix?: boolean }): { status: 'exact'|'folded'|'resolved'|'ambiguous'|'unknown'; match: string|null; matches: string[] }`

- [ ] **Step 1: 写失败测试**

```js
// src/dsh-wx/test/name.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeName, displayName, foldedKey, skeleton, chatIdSeed,
  graphemeLength, cleanTruncated, hasNameCharacter, sameName, matchOne,
} from '../lib/name.js'

test('foldedKey 折叠 VS16，但保留 ZWJ 与肤色', () => {
  assert.equal(foldedKey('❤️'), foldedKey('❤'))
  assert.equal(foldedKey('1️⃣'), foldedKey('1⃣'))
  assert.notEqual(foldedKey('👨‍👩‍👧'), foldedKey('👨‍👩‍👦'))
  assert.notEqual(foldedKey('👍🏽'), foldedKey('👍'))
})

test('hasNameCharacter 接受纯旗帜、keycap、©，拒绝问号/标点', () => {
  assert.equal(hasNameCharacter('🇨🇳'), true)
  assert.equal(hasNameCharacter('1️⃣'), true)
  assert.equal(hasNameCharacter('©'), true)
  assert.equal(hasNameCharacter('?'), false)
  assert.equal(hasNameCharacter('，'), false)
})

test('skeleton 只留字母/数字，旗帜和纯 emoji 为空', () => {
  assert.equal(skeleton('🌊周末海边🏖️'), '周末海边')
  assert.equal(skeleton('🇨🇳群'), '群')
  assert.equal(skeleton('🇨🇳'), '')
  assert.equal(skeleton('👨‍👩‍👧'), '')
})

test('sanitizeName 去掉孤立代理/U+FFFD/控制符/bidi，保留 ZWJ/VS', () => {
  assert.equal(sanitizeName('a\u0000b'), 'ab')
  assert.equal(sanitizeName('😀\uD83D'), '😀')
  assert.equal(sanitizeName('😀�'), '😀')
  assert.equal(sanitizeName('群‮名'), '群名')
  assert.equal(sanitizeName('👨‍👩‍👧'), '👨‍👩‍👧')
  assert.equal(sanitizeName('❤️'), '❤️')
})

test('displayName 不改写完整名字的尾部', () => {
  for (const s of ['❤️', '👍🏽', '1️⃣', '🇨🇳', '🏴󠁧󠁢󠁳󠁣󠁴󠁿']) {
    assert.equal(displayName(s), s)
  }
})

test('cleanTruncated 只处理截断串的尾巴', () => {
  assert.equal(cleanTruncated('👨‍👩...'), '👨‍👩')
  assert.equal(cleanTruncated('🇨...'), '')
  assert.equal(cleanTruncated('🏴󠁧...'), '🏴')
  assert.equal(cleanTruncated('🌊周末海...'), '🌊周末海')
  assert.equal(cleanTruncated('😀\uD83D'), '😀')
})

test('graphemeLength 按字素计数', () => {
  assert.equal(graphemeLength('😀'), 1)
  assert.equal(graphemeLength('🇨🇳'), 1)
  assert.equal(graphemeLength('🇨🇳🇺🇸'), 2)
  assert.equal(graphemeLength('👨‍👩‍👧'), 1)
  assert.equal(graphemeLength('1️⃣'), 1)
})

test('chatIdSeed 只做 trim + 压空白，不做 NFC', () => {
  assert.equal(chatIdSeed('  a   b '), 'a b')
  assert.equal(chatIdSeed('é'), 'é')
})

test('matchOne 先精确、再折叠、撞名回 ambiguous', () => {
  assert.deepEqual(matchOne('❤️读书群', ['❤️读书群', '别的群']), {
    status: 'exact', match: '❤️读书群', matches: ['❤️读书群'],
  })
  assert.equal(matchOne('❤读书群', ['❤️读书群']).status, 'folded')
  assert.equal(matchOne('❤读书群', ['❤️读书群', '❤读书群']).status, 'ambiguous')
  assert.equal(matchOne('不存在', ['❤️读书群']).status, 'unknown')
  assert.equal(matchOne('周末海边', ['🌊周末海边🏖️'], { tiers: ['exact', 'folded', 'skeleton'] }).status, 'resolved')
  assert.equal(sameName('❤️读书群', '❤️读书群'), true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test/name.test.mjs`
Expected: FAIL，`Cannot find module '../lib/name.js'`

- [ ] **Step 3: 实现 `lib/name.js`**

使用以下精确规则（实现体由执行者写）：

- `sanitizeName`：去掉 `\p{Cc}`、`\p{Cs}`、`�`、`‪-‮`、`⁦-⁩`、`​`、`‌`、`⁠`；保留 `‍`、`︎`、`️`、`\u{1F3FB}-\u{1F3FF}`、`\u{1F3F4}` 后的 tag 字符。
- `displayName`：`sanitizeName(String(s ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim())`。
- `nameKey`：`displayName`。
- `foldedKey`：`displayName(s).replace(/[︎️​‌⁠]/gu, '')`。
- `skeleton`：`displayName(s).replace(/[\p{P}\p{S}\p{M}\p{Cf}\p{Cs}\s]+/gu, '')`。
- `chatIdSeed`：`String(s ?? '').trim().replace(/\s+/g, ' ')`（不要用 `displayName`）。
- `graphemeLength`：`Intl.Segmenter('zh', { granularity: 'grapheme' })` 实例只建一次。
- `cleanTruncated`：
  1. 去掉末尾 `\s*(?:\.{2,}|…)\s*$`；
  2. 反复去掉末尾 `[‍︎️⃣\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}�]` 和孤立高/低位代理；
  3. 如果末尾连续 regional indicator 的个数为奇数，去掉最后一个；
  4. `trim()`。
- `hasNameCharacter`：`/[\p{L}\p{N}\p{Emoji}]/u`。
- `sameName(a,b)`：`nameKey(a) === nameKey(b)`。
- `tierKey`：`exact → nameKey`、`folded → foldedKey`、`skeleton → skeleton`。
- `matchOne(input, candidates, { tiers = ['exact','folded'], prefix = false })`：
  - **折叠撞名优先**：如果 `tiers` 包含 `folded`，先算 `foldedKey(input)`，统计候选里 `foldedKey` 相同的条目；>1 → 立刻 `{status:'ambiguous', match:null, matches}`，**不因为其中一个 exact 相等就选它**；
  - 否则每个 tier 依次过滤候选；
  - `prefix` 为真时，允许“候选以输入开头”或“输入以候选开头”，但较短一方字素数 ≥ 2；
  - 命中 1 个 → `{status: tier === 'skeleton' ? 'resolved' : tier, match, matches}`；
  - 命中 >1 → 立刻 `{status:'ambiguous', match:null, matches}`，不再下降；
  - 全 0 → `{status:'unknown', match:null, matches:[]}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test/name.test.mjs`
Expected: PASS，9 tests

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/name.js src/dsh-wx/test/name.test.mjs
git commit -m "feat(dsh-wx): add emoji-aware name primitives"
```

---

### Task 2: 目录身份与折叠合并

**Files:**
- Modify: `src/dsh-wx/lib/directory.js`、`src/dsh-wx/lib/capture.js`、`src/dsh-wx/lib/context.js`、`src/dsh-wx/lib/capture-run.js`
- Test: `src/dsh-wx/test/directory-emoji.test.mjs`、`src/dsh-wx/test-capture.mjs`

**Interfaces:**
- Consumes: `name.js` 的 `displayName`、`nameKey`、`foldedKey`、`skeleton`、`chatIdSeed`、`matchOne`、`graphemeLength`、`cleanTruncated`、`sanitizeName`。
- Produces:
  - `createDirectory({...})` 返回值新增：
    - `lookupName(name: string, opts?: { tiers?: Array<'exact'|'folded'|'skeleton'>; prefix?: boolean }): { status: 'exact'|'folded'|'resolved'|'truncated'|'ambiguous'|'unknown'; matches: object[]; match: object|null; chatId: string; displayName: string }`
    - `stateKey(name: string): string`（能解析时返回 `chatId`；`ambiguous` 或空名返回 `''`）
    - `sameEntry(a: string, b: string): boolean`
  - `chatIdFor` 的调用统一改为 `chatIdFor(chatIdSeed(rawName))`。

- [ ] **Step 1: 写失败测试**

```js
// src/dsh-wx/test/directory-emoji.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDirectory } from '../lib/directory.js'

const T = Date.UTC(2026, 10, 25, 4, 0, 0)
const temp = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-emoji-dir-')), 'directory.json')
const seeded = (chats) => {
  const file = temp()
  writeFileSync(file, JSON.stringify({ version: 1, chats }, null, 2), 'utf8')
  return createDirectory({ file, now: () => T, log: () => {} })
}

test('VS 变体合并到同一个 chatId，规范名保留第一次见到的写法', () => {
  const dir = seeded([{
    chatId: 'c_heart', displayName: '❤️读书群', fullName: '❤️读书群',
    nameConfidence: 'exact', firstSeenAt: new Date(T).toISOString(),
  }])
  dir.merge({ chats: [{ name: '❤读书群', preview: '' }], knownNames: ['❤️读书群'] })
  const hit = dir.lookupName('❤读书群')
  assert.equal(hit.status, 'folded')
  assert.equal(hit.chatId, 'c_heart')
  assert.equal(hit.displayName, '❤️读书群')
  assert.equal(dir.stateKey('❤读书群'), 'c_heart')
  assert.equal(dir.sameEntry('❤️读书群', '❤读书群'), true)
})

test('两个不同 emoji 群不会被折叠合并', () => {
  const dir = seeded([])
  dir.merge({ chats: [{ name: '👨‍👩‍👧群' }, { name: '👨‍👩‍👦群' }] })
  assert.notEqual(dir.idFor('👨‍👩‍👧群'), dir.idFor('👨‍👩‍👦群'))
})

test('折叠撞名 fail closed，stateKey 为空', () => {
  const dir = seeded([
    { chatId: 'c_a', displayName: '❤️读书群', fullName: '❤️读书群', nameConfidence: 'exact' },
    { chatId: 'c_b', displayName: '❤读书群', fullName: '❤读书群', nameConfidence: 'exact' },
  ])
  const hit = dir.lookupName('❤读书群')
  assert.equal(hit.status, 'ambiguous')
  assert.equal(hit.chatId, '')
  assert.equal(dir.stateKey('❤️读书群'), '')
  assert.equal(dir.sendableTarget('❤读书群'), null)
})

test('纯旗帜群名能建条目并拿到稳定 chatId', () => {
  const dir = seeded([])
  dir.merge({ chats: [{ name: '🇨🇳群', preview: '' }] })
  const id1 = dir.idFor('🇨🇳群')
  assert.match(id1, /^c_/)
  dir.merge({ chats: [{ name: '🇨🇳群', preview: '' }] })
  assert.equal(dir.idFor('🇨🇳群'), id1)
})

test('截断 emoji 名解析成全名，不留下半个代理', () => {
  const dir = seeded([])
  dir.merge({ chats: [{ name: '🌊周末海边🏖️' }], knownNames: ['🌊周末海边🏖️'] })
  dir.merge({ chats: [{ name: '🌊周末海...' }] })
  assert.equal(dir.lookupName('🌊周末海...').displayName, '🌊周末海边🏖️')
  assert.equal(JSON.stringify(dir.all()).includes('\uD83D'), false)
})

test('加载时折叠撞名不覆盖 duplicate-name 临时条目的自愈', () => {
  const dir = seeded([
    { chatId: 'c_real', displayName: '撞名群', fullName: '撞名群', nameConfidence: 'exact' },
    { chatId: 'c_tmp_x', displayName: '撞名群', fullName: '撞名群', nameConfidence: 'ambiguous', resolvedBy: 'duplicate-name' },
  ])
  assert.equal(dir.entry('撞名群'), null)
  assert.equal(dir.stateKey('撞名群'), '')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test/directory-emoji.test.mjs`
Expected: FAIL，`lookupName is not a function` / `stateKey is not a function`

- [ ] **Step 3: 改造 `lib/directory.js`**

按规格 §4.2 实现：
- `norm` 改为 `displayName`；新增 `chatIdSeed` 用于 `chatIdFor` 和 `tempIdFor`。
- `findMatches`：先用 `foldedKey` 分组；同一 foldedKey 有 >1 个条目 → 直接 ambiguous（**即使其中一个与输入精确相等**，也不能挑那一个）；只有 foldedKey 唯一时才按 exact/folded 返回。
- `lookupName`：用同一规则对条目名（displayName/fullName/aliases）匹配；`looksTruncated(name)` 时默认启用字素级前缀（调用方也可显式 `{prefix:true}`）；`truncated` 状态当且仅当 `looksTruncated` 且无唯一命中。
- `uniquePrefix`：字素级；`stripEllipsis` 后调用 `cleanTruncated`。
- 读取时 `sanitizeName` 每个 displayName/fullName/alias；不剥省略号、不去 VS/ZWJ/肤色/keycap。
- 折叠命中保留已存 `displayName`/`fullName`，新写法进 `aliases`；已存 truncated + 新全名时提升。
- 加载时扫描折叠撞名：排除 `c_tmp_*`，不覆盖 `resolvedBy==='duplicate-name'`，用 `resolvedBy='folded-collision'`；两条都 ambiguous，不删除、不合并。
- `stateKey(name)`：`lookupName(name, { tiers: ['exact','folded'] })`；`ambiguous`/空名 → `''`；有条目 → 条目 `chatId`；未知非空 → `chatIdFor(chatIdSeed(name))`。
- `sameEntry(a,b)`：两边 `stateKey` 都非空且相等。
- `sendableTarget`/`idFor`/`entry` 走 `lookupName`；ambiguous 返回空。
- `context.js` 的 `chatIdOf` 和 `capture-run.js` 的 fallback 改为 `chatIdFor(chatIdSeed(chatName))`；目录 `idFor` 仍是第一优先。
- `capture.js` 的 `nameKey` 改为 `serviceNameKey = asciiLower(displayName(s))`；`isIgnoredChat` / `shouldEnqueue` 继续 ASCII 小写，保持 `Tencent News` 行为；在 `test-capture.mjs` 加一条 `isIgnoredChat('Tencent News', DEFAULT_IGNORE_CHATS) === true`。
- `lookupName` 放在 directory（需要 entries）；`name.js` 只提供 `matchOne` 作为底层。这是本计划对规格 §4.1 的落点。
- folded/skeleton 命中时通过 `createDirectory` 的 `log` 回调写 `name-match` 日志（`{from,to,tier,chatId}`）；只给调试，不进模型文案。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test/directory-emoji.test.mjs test-directory.mjs test-capture.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/directory.js src/dsh-wx/test/directory-emoji.test.mjs
git commit -m "feat(dsh-wx): resolve directory names with exact/folded keys"
```

---

### Task 3: 树入口、截断与导航歧义

**Files:**
- Modify: `src/dsh-wx/lib/tree.js`、`src/dsh-wx/lib/chat-label.js`、`src/dsh-wx/lib/ear-open.js`
- Test: `src/dsh-wx/test/tree-emoji.test.mjs`

**Interfaces:**
- Consumes: `name.js` 的 `displayName`、`sanitizeName`、`nameKey`、`foldedKey`、`skeleton`、`graphemeLength`、`hasNameCharacter`、`matchOne`。
- Produces:
  - `sameName(a,b)` 继续导出，内部改为 `nameKey` 比较。
  - `reconcileChatName(name, names)`：`matchOne` 的 tiers 为 `['exact','folded','skeleton']`，skeleton 唯一才改写。
  - `planChatNavigation` 新增返回 `{ action: 'ambiguous', matches: object[], chatCount: number }`。
  - `ocrMentionHits` 用 `hasNameCharacter` 替代 `^[\p{P}\p{S}\s]+$`。
  - `parseChatLabel` 的名字行和 preview 先 `sanitizeName`。

- [ ] **Step 1: 写失败测试**

```js
// src/dsh-wx/test/tree-emoji.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChatLabel } from '../lib/chat-label.js'
import { parseTree, reconcileChatName, planChatNavigation, ocrMentionHits } from '../lib/tree.js'

test('会话行 label 保留 emoji/旗帜/keycap，清掉孤立代理', () => {
  assert.equal(parseChatLabel('🌊周末海边🏖️\n[3]\n张三: 在吗\n12:03').name, '🌊周末海边🏖️')
  assert.equal(parseChatLabel('🇨🇳群\n预览\n12:03').name, '🇨🇳群')
  assert.equal(parseChatLabel('1️⃣群\n预览\n12:03').name, '1️⃣群')
  assert.equal(parseChatLabel('😀\uD83D\n预览\n12:03').name, '😀')
})

test('parseTree 的 current 与行名保留 emoji', () => {
  const text = [
    '微信窗口 100x100 原点(0,0) · 元素 10 个 · 缩放 1.0000 · 测试',
    '当前会话："🌊周末海边🏖️"',
    '--- 会话列表 ---',
    '会话 "🌊周末海边🏖️" 未读=2 预览="张三: 在吗" 中心(10,20) 100x30',
    '--- 当前聊天里的消息 ---',
    '--- 能点的 ---',
  ].join('\n')
  const parsed = parseTree(text)
  assert.equal(parsed.current, '🌊周末海边🏖️')
  assert.equal(parsed.chats[0].name, '🌊周末海边🏖️')
})

test('reconcileChatName 用 skeleton 唯一补全 OCR 丢掉的 emoji', () => {
  assert.equal(reconcileChatName('周末海边', ['🌊周末海边🏖️']), '🌊周末海边🏖️')
  assert.equal(reconcileChatName('周末海边', ['🌊周末海边🏖️', '🏖️周末海边']), '周末海边')
})

test('planChatNavigation 命中多行返回 ambiguous，不点第一行', () => {
  const rows = [
    { name: '❤️读书群', box: { cx: 1, cy: 1 } },
    { name: '❤读书群', box: { cx: 2, cy: 2 } },
  ]
  const plan = planChatNavigation({
    parsed: { ok: true, current: '别的群', chats: rows },
    target: '❤读书群',
    tree: { status: 'ok', ok: true, chats: 2 },
  })
  assert.equal(plan.action, 'ambiguous')
  assert.equal(plan.matches.length, 2)
})

test('ocrMentionHits 接受纯旗帜，拒绝纯问号', () => {
  const flag = ocrMentionHits({ chats: [{ source: 'ocr', name: '🇨🇳', mention: true, unread: 1, nameConfidence: 80 }] })
  assert.equal(flag.length, 1)
  const noise = ocrMentionHits({ chats: [{ source: 'ocr', name: '???', mention: true, unread: 1, nameConfidence: 80 }] })
  assert.equal(noise.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test/tree-emoji.test.mjs`
Expected: FAIL，plural on `ambiguous` / sanitize assertions

- [ ] **Step 3: 实现**

按规格 §4.1、§4.3、§4.5：
- `chat-label.js` 的 `parseChatLabel` 在 `lines[0]` 和 preview 拼接前调用 `sanitizeName`。
- `tree.js` 的 `sameName` 委托 `nameKey`；`reconcileChatName` 用 `matchOne(..., { tiers: ['exact','folded','skeleton'] })`；`treeMatchesOcr` 用 `graphemeLength` 和字素前缀。
- `planChatNavigation` 收集所有 matching rows：0 行按树健康度返回 unreadable/missing；1 行 navigate；>1 行返回 `{ action: 'ambiguous', matches, chatCount }`。
- `ocrMentionHits` 的过滤改为 `hasNameCharacter(name)`。
- 长度阈值（`base.length < 2`、`lw.length >= 2`）改 `graphemeLength`。
- `looksDM`（`tree.js:311`、`ear-open.js:26`）不再用无 `u` 的 `[^:：]{1,20}` 数码元；改为用 `parsePreviewSender` 的 sender + `graphemeLength(sender) <= 20` 判断。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test/tree-emoji.test.mjs test/chat-navigation.test.mjs test-ocr.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/tree.js src/dsh-wx/lib/chat-label.js src/dsh-wx/test/tree-emoji.test.mjs
git commit -m "feat(dsh-wx): keep emoji chat names through tree parsing"
```

---

### Task 4: 发送身份：政策匹配、targetMatches、导航歧义

**Files:**
- Modify: `src/dsh-wx/lib/reminder.js`、`send-gate.js`、`tree.js`、`index.js`、`wx-send-tool.js`
- Test: `src/dsh-wx/test/send-identity.test.mjs`

**Interfaces:**
- Consumes: `name.js` 的 `matchOne`、`chatIdSeed`；`directory.js` 的 `lookupName`、`stateKey`、`sameEntry`。
- Produces:
  - `findAllowedChat(p, chat)`：exact/folded；ambiguous → `null`。
  - `canSendWithPolicy(p, chat)`：ambiguous → `{ ok:false, code:'WX_CHAT_AMBIGUOUS', why:'...' }`。
  - `targetMatches(current: string, targetChatId: string, { lookupName, deriveId }): boolean`（放在 `tree.js` 或 `name.js`；本计划放 `tree.js` 并导出）。
  - `sendToChatUnsafe` 内 5 处核对改用 `targetMatches`；`planChatNavigation` 的 `ambiguous` 转 `WX_CHAT_AMBIGUOUS`。

- [ ] **Step 1: 写失败测试**

```js
// src/dsh-wx/test/send-identity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDirectory } from '../lib/directory.js'
import { canSendWithPolicy, findAllowedChat } from '../lib/reminder.js'
import { targetMatches } from '../lib/tree.js'
import { chatIdFor } from '../lib/ledger.js'
import { chatIdSeed } from '../lib/name.js'

const T = Date.UTC(2026, 10, 25, 4, 0, 0)
const temp = () => join(mkdtempSync(join(tmpdir(), 'dsh-wx-send-id-')), 'directory.json')
const seeded = (chats) => {
  const file = temp()
  writeFileSync(file, JSON.stringify({ version: 1, chats }, null, 2), 'utf8')
  return createDirectory({ file, now: () => T, log: () => {} })
}

test('名单与目标只差 VS16 时仍能匹配', () => {
  const p = { enabled: true, allowChats: ['❤️读书群'], noMentionChats: [] }
  assert.equal(findAllowedChat(p, '❤读书群'), '❤️读书群')
  assert.deepEqual(canSendWithPolicy(p, '❤读书群'), { ok: true, chat: '❤️读书群' })
})

test('名单内部折叠撞名时拒绝', () => {
  const p = { enabled: true, allowChats: ['❤️读书群', '❤读书群'], noMentionChats: [] }
  const r = canSendWithPolicy(p, '❤读书群')
  assert.equal(r.ok, false)
  assert.equal(r.code, 'WX_CHAT_AMBIGUOUS')
})

test('targetMatches 比 chatId，不比字符串', () => {
  const dir = seeded([{
    chatId: 'c_heart', displayName: '❤️读书群', fullName: '❤️读书群',
    nameConfidence: 'exact',
  }])
  const targetId = dir.idFor('❤️读书群')
  const lookup = (name) => dir.lookupName(name, { tiers: ['exact', 'folded'] })
  assert.equal(targetMatches('❤读书群', targetId, { lookupName: lookup }), true)
  assert.equal(targetMatches('别的群', targetId, { lookupName: lookup }), false)
})

test('未知会话也能用 chatIdSeed 派生同一个 id', () => {
  const targetId = chatIdFor(chatIdSeed('🌊周末海边🏖️'))
  const lookup = () => ({ status: 'unknown', chatId: '', match: null, matches: [] })
  assert.equal(targetMatches('🌊周末海边🏖️', targetId, { lookupName: lookup }), true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test/send-identity.test.mjs`
Expected: FAIL，`targetMatches is not a function` / policy ambiguous not implemented

- [ ] **Step 3: 实现**

- `reminder.js`：`findAllowedChat` 先检查 `allow`/`exempt` 里是否有 >1 个条目与 `want` 的 `foldedKey` 相同；有 → ambiguous，**不因其中一个 exact 而放行**。没有折叠撞名时再用 `matchOne`。`canSendWithPolicy` 在 ambiguous 时返回 `{ ok:false, code:'WX_CHAT_AMBIGUOUS', why:'「...」对不上唯一的会话。' }`。
- `tree.js`：导出 `targetMatches(current, targetChatId, { lookupName, deriveId = (s) => chatIdFor(chatIdSeed(s)) })`。`lookupName` 由调用方注入（避免 tree.js 依赖 directory）。
- `index.js`：`sendToChatUnsafe` 先算 `targetChatId`：`targetChatId` 参数优先；否则 `directory.idFor(navigateTo)`；为空则 `chatIdFor(chatIdSeed(navigateTo))`。5 处 `sameName(s.parsed.current, navigateTo)` 改 `targetMatches(...)`；`planChatNavigation` 返回 `ambiguous` 时抛 `WX_CHAT_AMBIGUOUS`，文案按返回契约。
- `send-gate.js`：`createSendGate` 增加可选 `lookupName`/`targetMatches` 注入；`targetHit` 用 `targetMatches(s.parsed.current, target.chatId)`；没有注入时退回 `sameName`（保持旧测试可用）。
- `index.js` 的 `canonicalName(name)`：exact/folded/resolved → 目录保留的 display name；unknown → trim 原样；ambiguous → `null`；truncated → 原样。`index.js:2052` 的 `canonicalName(a) === canonicalName(b)` 改为 `directory.sameEntry(a,b)`；`makeCaptureIo` 的 `findRow` 同步改。
- folded/skeleton/chatId 命中时写 `name-match` 事件（`{from,to,tier,chatId}`）；只在发生非 exact 解析时写。
- `wx-send-tool.js`：`BINDING_FAILURE_TEXT` 已有 `WX_CHAT_AMBIGUOUS`，确认透传。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test/send-identity.test.mjs test/chat-navigation.test.mjs test/wx-send-tool.test.mjs test/reminder-delivery.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/reminder.js src/dsh-wx/lib/send-gate.js src/dsh-wx/lib/tree.js src/dsh-wx/lib/index.js src/dsh-wx/lib/wx-send-tool.js src/dsh-wx/test/send-identity.test.mjs
git commit -m "feat(dsh-wx): verify send targets by chatId and fail closed on ambiguity"
```

---

### Task 5: 状态键改 chatId + 一次性迁移

**Files:**
- Create: `src/dsh-wx/lib/state-key.js`
- Modify: `src/dsh-wx/lib/mention.js`、`proactive.js`、`index.js`
- Test: `src/dsh-wx/test/state-key.test.mjs`

**Interfaces:**
- Consumes: `directory.stateKey`。
- Produces:
  - `state-key.js`：
    - `migrateMentions(raw: object, keyOf: (name:string)=>string): object`
    - `migrateProactive(raw: { day?: string, used?: object }, keyOf): { day?: string, used: object }`
    - `migrateRecent(raw: Array<{chat?:string, at?:number}>, keyOf): Array<{chatId:string, chat:string, at:number}>`
  - `mention.grant(state, chat, now, keyOf = (v)=>v)`；`canSpeak(state, chat, now, windowMinutes, keyOf = (v)=>v)`；`grantMentioned(state, text, chats, now, keyOf = (v)=>v)`。
  - `proactive` 的 `used` key 由调用方传 chatId；`quotaFor` 在 `proactiveChats` 的键里做 exact/folded 查找。

- [ ] **Step 1: 写失败测试**

```js
// src/dsh-wx/test/state-key.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateMentions, migrateProactive, migrateRecent } from '../lib/state-key.js'
import { grant, canSpeak } from '../lib/mention.js'
import { quotaFor, consume, remaining } from '../lib/proactive.js'

test('mentions 旧名字键迁到 chatId，撞键取最大时间戳', () => {
  const keyOf = (n) => (n === '❤️读书群' || n === '❤读书群' ? 'c_heart' : 'c_' + n)
  assert.deepEqual(migrateMentions({ '❤️读书群': 10, '❤读书群': 20 }, keyOf), { c_heart: 20 })
})

test('proactive 旧名字键迁到 chatId，撞键取较大计数', () => {
  const keyOf = () => 'c_heart'
  assert.deepEqual(migrateProactive({ day: '2026-11-25', used: { A: 2, B: 5 } }, keyOf).used, { c_heart: 5 })
})

test('recent 旧数组迁到 chatId，按 key 去重取最大 at', () => {
  const keyOf = () => 'c_heart'
  assert.deepEqual(migrateRecent([{ chat: 'A', at: 1 }, { chat: 'B', at: 9 }], keyOf), [{ chatId: 'c_heart', chat: 'B', at: 9 }])
})

test('mention 两种 VS 写法共享同一个 @ 窗口', () => {
  const keyOf = (n) => (n === '❤️读书群' || n === '❤读书群' ? 'c_heart' : '')
  const state = grant({}, '❤️读书群', 1000, keyOf)
  assert.deepEqual(canSpeak(state, '❤读书群', 1000, 3, keyOf), { ok: true, leftMs: 180000 })
})

test('proactive 的 used 以 chatId 记账，额度按名字折叠查', () => {
  const policy = { proactivePerDay: 0, proactiveChats: { '❤️读书群': 2 }, hardBreaker: 50 }
  assert.equal(quotaFor(policy, 'c_heart', '❤读书群'), 2)
  const state = { ok: true, day: '2026-11-25', used: {} }
  const next = consume(policy, state, 'c_heart', '2026-11-25', '❤读书群')
  assert.deepEqual(next.state.used, { c_heart: 1 })
  assert.equal(remaining(policy, next.state, 'c_heart', '2026-11-25', '❤读书群'), 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test/state-key.test.mjs`
Expected: FAIL，module missing / signature mismatch

- [ ] **Step 3: 实现**

- 新建 `state-key.js`：三个纯迁移函数；跳过 `keyOf` 返回空串的条目；`mentions` 撞键取 `Math.max`；`proactive` 撞键取 `Math.max`；`recent` 按 key 取最大 `at`，保留 `chat` 显示名。
- `mention.js`：加可选 `keyOf` 参数，所有 `state[String(chat)]` 改为 `state[keyOf(chat)]`；空 key 不写、`canSpeak` 返回 `{ok:false, reason:'没有有效的会话身份'}`。
- `proactive.js`：`quotaFor` 用 `matchOne` 在 `Object.keys(map)` 上做 exact/folded；`usedToday`/`consume` 使用传入的 chatId key。
- `index.js`：
  - 启动时读 `mentions.json` / `proactive.json` / `recent-chats.json`，用 `directory.stateKey` 迁移；迁移前复制 `<file>.v1.bak`；写回失败保留原文件。
  - `grant`/`canSpeak`/`grantMentioned`/`saveMentions` 都传 `directory.stateKey`。
  - `recent` 新写入 `{chatId, chat, at}`；读取兼容旧形状。
  - `project.resolveSendKeys` 改为 `quota = chatId || canonicalChat || chat`、`speech = chatId || quota`；`speechGate` 的 3 处调用（`index.js:1236/1398/1542` 附近）统一为 `wx:<speech>`。
  - `loadState`/`saveState`/`decideProactive`/`consumeProactive` 的 `chat` 参数统一传 `sendKeys.quota`（chatId）。
  - `send-gate.js` 的 `canSpeak` 调用传入 `stateKey`（`createSendGate` 新增可选 `stateKey` 注入，默认 `(v)=>v`）；`index.js` 传 `directory.stateKey`。
  - `index.js` 的 `grant(...)` / `grantMentioned(...)` 调用全部传 `directory.stateKey`。
  - 写 `recent-chats.json` 的 `chat` 前过 `sanitizeName`；不写孤立代理/U+FFFD。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test/state-key.test.mjs test-mention.mjs test-proactive.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/state-key.js src/dsh-wx/lib/mention.js src/dsh-wx/lib/proactive.js src/dsh-wx/lib/index.js src/dsh-wx/test/state-key.test.mjs
git commit -m "feat(dsh-wx): key transient chat state by chatId"
```

---

### Task 6: OCR 路径的 emoji 边界

**Files:**
- Modify: `src/dsh-wx/lib/ocr-snapshot.mjs`、`ocr.js`、`chats-json.mjs`、`ocr-complete.js`
- Test: `src/dsh-wx/test/ocr-emoji.test.mjs`

**Interfaces:**
- Consumes: `name.js` 的 `hasNameCharacter`、`displayName`、`graphemeLength`。
- Produces:
  - `isNameWord` 使用 `hasNameCharacter`。
  - `nameLooksLikeChat` 使用 `hasNameCharacter`。
  - `groupTimestampAnchoredRows` 的 `rawName` 在任意两个 `hasNameCharacter` 字符之间去空格。
  - `parseOcrChats` / `chats-json` 的纯符号过滤共用同一判定。
  - `chatsJson` 返回 `source: 'tree' | 'ocr'`，供工作台标注 OCR 候选。

- [ ] **Step 1: 写失败测试**

```js
// src/dsh-wx/test/ocr-emoji.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupTimestampAnchoredRows } from '../lib/ocr-snapshot.mjs'
import { parseOcrChats } from '../lib/ocr.js'
import { chatsJson } from '../lib/chats-json.mjs'

const line = (top, words) => ({ top, height: 18, left: 10, width: 200, words, text: words.map(w => w.text).join(' ') })
const word = (text, left) => ({ text, left, width: 60, confidence: 90 })
const time = (top, left) => ({ text: '12:03', left, width: 40, confidence: 90 })
const rows = (words) => groupTimestampAnchoredRows([line(150, [...words, time(150, 300)])], 400, 400, { x: 0, y: 0 })

test('纯旗帜标题行能出', () => {
  assert.deepEqual(rows([word('🇨🇳', 150)]).map(r => r.name), ['🇨🇳'])
})

test('emoji 和汉字被 OCR 分成两个词时不留空格', () => {
  assert.deepEqual(rows([word('🌊', 150), word('周末海边', 175)]).map(r => r.name), ['🌊周末海边'])
  assert.deepEqual(rows([word('周末海边', 150), word('🏖️', 220)]).map(r => r.name), ['周末海边🏖️'])
})

test('纯问号噪声仍被拒', () => {
  assert.deepEqual(rows([word('???', 150)]).map(r => r.name), [])
})

test('parseOcrChats 接受纯旗帜，拒绝纯问号', () => {
  const flag = parseOcrChats([{ name: '🇨🇳', lines: ['🇨🇳', '[2]', '有人@我'], nameConfidence: 80 }])
  assert.equal(flag.length, 1)
  const noise = parseOcrChats([{ name: '???', lines: ['???', '[2]', '有人@我'], nameConfidence: 80 }])
  assert.equal(noise.length, 0)
})

test('chats-json snapshot 分支接受纯旗帜', () => {
  const out = chatsJson(JSON.stringify({ ok: true, reliable: true, rows: [{ name: '🇨🇳', nameConfidence: 80 }] }))
  assert.deepEqual(out.chats.map(c => c.name), ['🇨🇳'])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test/ocr-emoji.test.mjs`
Expected: FAIL，旗帜行/空格断言不通过

- [ ] **Step 3: 实现**

- `isNameWord(text)` → `hasNameCharacter(text) && !isNavigation(text)`。
- `nameLooksLikeChat(name)` → `hasNameCharacter(name)` + 原有导航/时间/长度条件；长度用 `graphemeLength`。
- `groupTimestampAnchoredRows` 的拼词去空格规则扩展到 `hasNameCharacter` 相邻字符（`parseTsv` 的 `text` 拼接同样处理）。
- `nameConfidence`：emoji 词不计入均值；全 emoji 时用 emoji 词均值。
- `chats-json` 的 snapshot 过滤与 `parseOcrChats` 共用 `hasNameCharacter`；返回 `source`（tree/ocr）。
- `cleanRowLabel` 只剥 `|`、`>`、`•` 和前导空白。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test/ocr-emoji.test.mjs test-ocr-snapshot.mjs test-chats-json.mjs test-ocr.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/ocr-snapshot.mjs src/dsh-wx/lib/ocr.js src/dsh-wx/lib/chats-json.mjs src/dsh-wx/lib/ocr-complete.js src/dsh-wx/test/ocr-emoji.test.mjs
git commit -m "feat(dsh-wx): accept emoji names in OCR fallback"
```

---

### Task 7: 工作台乱码判定、名单规范化与状态读取

**Files:**
- Create: `workbench/wx-names.mjs`
- Modify: `workbench/server.mjs`、`workbench/assets/channels.js`、`workbench/assets/channels/wx.js`
- Test: `workbench/test/wx-emoji-scope.test.mjs`

**Interfaces:**
- Consumes: `src/dsh-wx/lib/name.js` 的 `displayName`、`matchOne`、`graphemeLength`、`sanitizeName`；`directory.json`。
- Produces:
  - `looksGarbled(name: string): boolean`：含 `U+FFFD`、孤立代理，或 `?` ≥2 且占字素 ≥50%。
  - `sanitizePolicyList(list: string[]): { kept: string[]; bad: Array<{ name: string; why: string }> }`
  - `canonicalizePolicyName(name: string, entries: object[]): { status: 'exact'|'folded'|'ambiguous'|'unknown'|'truncated'; name: string }`（只有 exact/folded 且条目 `nameConfidence` 为 `exact`/`resolved` 才改写）
  - 服务端 `/api/wx/scope` 返回 `bad` 列表；前端消费它，不再自己 `isBad`。

- [ ] **Step 1: 写失败测试**

```js
// workbench/test/wx-emoji-scope.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { looksGarbled, sanitizePolicyList, canonicalizePolicyName } from '../wx-names.mjs'

test('合法 emoji 名不被乱码规则误杀', () => {
  for (const s of ['🌊周末海边🏖️', '🇨🇳群', '1️⃣群', '❤️读书群']) assert.equal(looksGarbled(s), false)
})

test('U+FFFD / 孤立代理 / 高密度问号被判坏', () => {
  assert.equal(looksGarbled('😀�'), true)
  assert.equal(looksGarbled('😀\uD83D'), true)
  assert.equal(looksGarbled('????'), true)
  assert.equal(looksGarbled('什么??'), false)
})

test('坏条目按条返回，不静默丢弃', () => {
  const r = sanitizePolicyList(['🌊周末海边🏖️', '????', '❤️读书群'])
  assert.deepEqual(r.kept, ['🌊周末海边🏖️', '❤️读书群'])
  assert.equal(r.bad.length, 1)
  assert.equal(r.bad[0].name, '????')
})

test('只从 exact/resolved 条目规范名', () => {
  const entries = [
    { chatId: 'c1', displayName: '❤️读书群', fullName: '❤️读书群', nameConfidence: 'exact' },
    { chatId: 'c2', displayName: '长名...', fullName: '', nameConfidence: 'truncated' },
  ]
  assert.deepEqual(canonicalizePolicyName('❤读书群', entries), { status: 'folded', name: '❤️读书群' })
  assert.equal(canonicalizePolicyName('长名', entries).status, 'truncated')
  assert.equal(canonicalizePolicyName('没见过的群', entries).status, 'unknown')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd workbench && node --test test/wx-emoji-scope.test.mjs`
Expected: FAIL，module missing

- [ ] **Step 3: 实现**

- `workbench/wx-names.mjs`：实现三个导出；默认从 `../src/dsh-wx/lib/name.js` 导入（测试用），服务端生产用 `WX_LIB` 指向部署的 `dsh-wx/lib/name.js`，加载失败时回退到本地 `trim + 压空白` 并记日志。
- `looksGarbled` 的问号规则：`?` ≥2、占字素 ≥50%，**且不含** `L/N/Emoji` 才算坏；`????` 坏，`什么??` 不坏。
- `server.mjs`：
  - `saveWxScope`：用 `sanitizePolicyList` 逐条校验；有坏条目时整份拒绝，返回 `{ ok:false, error, bad }`；无坏条目时用 `canonicalizePolicyName` 规范化（ambiguous/truncated 拒绝该条）。
  - `wxScope`：`mentions[current]` 和 `proactiveUsed[current]` 改为 `stateKey(current)`（用目录或 `chatIdFor(chatIdSeed(current))`）。
  - `wxSpeakingState`（`server.mjs:256`）的 `allowChats` / `noMentionChats` / `proactiveChats` 判断改用 exact/folded 匹配；`used` 按 `stateKey(current)` 取。
  - 返回 `bad` 列表给前端；候选额外带 `nameConfidence` / `matchStatus` / `source`，前端显示 ambiguous/truncated 提示、折叠撞名候选；`source === 'ocr'` 时显示“OCR 读取，可能不含 emoji”。
- 前端：删除 `isBad` 自己判的逻辑，改用后端 `bad`；显示名用文本节点。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd workbench && node --test test/wx-emoji-scope.test.mjs test/server.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add workbench/wx-names.mjs workbench/server.mjs workbench/assets/channels.js workbench/assets/channels/wx.js workbench/test/wx-emoji-scope.test.mjs
git commit -m "feat(workbench): handle emoji chat names without false garbling"
```

---

### Task 8: 跨模块 `dispatchChats` 与审计

**Files:**
- Modify: `src/dsh-wx/lib/index.js`（`wxService` 增加 `sameChatName` / `canonicalChatName`）、`src/dsh-fish/lib/work.js`、`src/dsh-fish/lib/feedback-audit.js`
- Test: `src/dsh-fish/test/work-dispatch-emoji.test.mjs`

**Interfaces:**
- Consumes: `wxService.sameChatName(a,b)`（可选）或本地 `nameKey`。
- Produces:
  - `work.js` 的 `dispatchChats` 比较改用 `wxService.sameChatName`；接口不存在时回退到 `trim + 压空白`。
  - `feedback-audit.comparableText` 保留 `\p{Extended_Pictographic}`。

- [ ] **Step 1: 写失败测试**

```js
// src/dsh-fish/test/work-dispatch-emoji.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sameDispatchChat } from '../lib/work.js'

test('dispatchChats 在 VS16 变体下仍放行', () => {
  const same = (a, b) => a.replace(/️/gu, '') === b.replace(/️/gu, '')
  assert.equal(sameDispatchChat('❤️读书群', ['❤读书群'], same), true)
  assert.equal(sameDispatchChat('别的群', ['❤读书群'], same), false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-fish && node --test test/work-dispatch-emoji.test.mjs`
Expected: FAIL，`sameDispatchChat` 未导出

- [ ] **Step 3: 实现**

- `src/dsh-wx/lib/index.js` 的 `wxService` 对象增加：
  - `sameChatName(a, b)` → `directory.sameEntry(a, b)`（exact/folded，ambiguous 为 false）；
  - `canonicalChatName(name)` → exact/folded/resolved 返回 display name；unknown 返回 trim 原样；ambiguous 返回 `null`。
- `work.js` 导出 `sameDispatchChat(chat, list, same = ...)`；`dispatchChats` 的实际检查改为调用它；优先用 `wxService.sameChatName`。
- `feedback-audit.js` 的 `comparableText` 把 `\p{S}` 排除改成“保留 `\p{Extended_Pictographic}`”（即先把 EP 从待删除集合里排除）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-fish && node --test test/work-dispatch-emoji.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/work.js src/dsh-fish/lib/feedback-audit.js src/dsh-fish/test/work-dispatch-emoji.test.mjs
git commit -m "feat(dsh-fish): match emoji dispatch chats by name key"
```

---

### Task 9: 文档与运行环境字体（需批准）

**Files:**
- Modify: `src/dsh-wx/README.md`、`src/dsh-wx/NEXT-STAGE.md`

**Interfaces:**
- Consumes: 无。
- Produces: 文档明确支持字符范围、OCR 边界、exact/folded 规则、字体安装步骤。

- [ ] **Step 1: 更新文档**

在 `src/dsh-wx/README.md` 增加：
- 群名支持任意 emoji（含旗帜、keycap、ZWJ、肤色、tag 序列）。
- 发送目标只认 exact/folded；截断名解析不属于模糊发送。
- OCR 回退不保证识别 emoji；树挂时 fail closed。
- 工作台保存的坏条目按条返回，不静默丢弃。
- 字体安装：`sudo apt-get install -y fonts-noto-color-emoji && sudo fc-cache -f && sudo systemctl restart wechat-fish`（系统变更，需用户批准）。

在 `NEXT-STAGE.md` 的已知限制里补一条：OCR 方框无法读出 emoji，只能靠树。

- [ ] **Step 2: 安装字体（需用户明确批准后执行）**

```bash
sudo apt-get install -y fonts-noto-color-emoji
sudo fc-cache -f
sudo systemctl restart wechat-fish
```

验证：
```bash
fc-list ':charset=1f3d6' | head
```
Expected: 至少一行 Noto Color Emoji。

- [ ] **Step 3: 目视验收**

截图微信侧栏/消息区/工作台候选，确认不再出现方框；记录到调研文档或提交说明。

- [ ] **Step 4: 提交文档**

```bash
git add src/dsh-wx/README.md src/dsh-wx/NEXT-STAGE.md
git commit -m "docs(dsh-wx): document emoji chat-name support and font requirement"
```

---

### Task 10: 全量验证与交付

**Files:**
- 无新增；运行全部测试与交付检查。

- [ ] **Step 1: 跑 dsh-wx 全量测试**

Run: `cd src/dsh-wx && node --test`
Expected: 全部通过，0 fail。

- [ ] **Step 2: 跑 workbench / dsh-fish 测试**

Run:
```bash
cd workbench && node --test
cd ../src/dsh-fish && node --test
```
Expected: 全部通过。

- [ ] **Step 3: 提交前检查**

Run:
```bash
cd /home/str1k3/src/bigfish-workspace
git status --short
git diff --cached --check
python scripts/audit-staged.py
```
Expected: 暂存内容只包含本任务文件；无空白错误；审计无真实凭据告警。

- [ ] **Step 4: 按仓库约定交付 WSL**

Windows 侧 commit/push → WSL 原生 `git fetch` + `git pull --ff-only` → WSL 侧 `cd src/dsh-wx && node --test` → 重启 `dsh-web`；需要时重启 `wechat-fish`（字体）。记录两侧 SHA。

- [ ] **Step 5: 端到端验收（需要用户配合）**

用真实 emoji 群名验证：
1. `@` 叫醒；2. 发送；3. 当前会话核对；4. 台账 `chatId`；5. VS 变体仍指向同一群；6. 撞名拒绝；7. 树挂时只认明确 `@我`。

- [ ] **Step 6: 最终提交**

```bash
git add <本任务涉及的文件>
git commit -m "test(dsh-wx): verify emoji chat-name chain end to end"
```

---

## 自审记录

- **Spec coverage:** 设计 §4.1 → Task 1；§4.2 → Task 2；§4.3 → Task 3；§4.4 → Task 4/5；§4.5 → Task 6；§4.6 → Task 7；§4.7 → Task 8；§4.8 → Task 9；§6 → 各任务测试 + Task 10。无未覆盖的设计要求。
- **Step scan:** 每个代码步骤给签名/规则；测试步骤给断言；没有“TBD/适当处理”式空步骤。
- **Type consistency:** `lookupName` 在 Task 2 定义（directory 返回值），Task 4 通过注入使用；`stateKey` 在 Task 2 定义，Task 5 使用；`targetMatches` 在 Task 4 定义并使用；`matchOne` 在 Task 1 定义，Task 2/3/4/6/7 使用。
- **Review Focus:** 每条都有测试：纯 emoji/旗帜 → Task 2/3/6/7；完整名尾部 → Task 1；ZWJ/旗帜/tag 截断 → Task 1/2；大小写/VS/ZWJ → Task 1/2/4；旧两 id 分裂 → Task 2。
