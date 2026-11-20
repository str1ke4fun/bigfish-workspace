# 2026-11-19 交付审查修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉 2026-11-19 提交审查与 2026-11-18～20 运行日志里确认的缺陷，并恢复 `src/dsh-fish` 全绿基线。

**Architecture:** 微信耳朵的两条误判（跨 24 小时正文去重、群聊发送者归属）先收口；陪伴会话存活判断补齐「任何工作区都不再认它」；OCR 补全只在预览确实被截断时运行；随后加固 OCR 侧栏行解析（锚点/行带/@ 徽标）、禁止 OCR 来源写目录预览；最后补日志时间戳、降噪启动期 warn，并更新文档状态。

**Tech Stack:** Node.js 内置 `node:test` / `node:assert`；`src/dsh-fish` 与 `src/dsh-wx` 均零依赖。

**Spec:** 无独立 spec；需求来自 2026-11-20 对 `f09721f~12..f09721f` 的代码审查，以及 2026-11-18～20 的运行日志（见「问题来源与运行证据」）。

## 问题来源与运行证据（2026-11-20）

日志与现场复现确认了以下问题，均已并入本计划任务：

- **OCR 侧栏串行、误判 @（最严重，今天真实发生）**：09:41 重启后微信停在登录页，人工登录后 AT-SPI 树进入 `partial`（`dsh-web.log` 25 次 tree-partial），耳朵改用 OCR。09:59 投递 `1111111111111111111`、10:04 投递 `安卓4224柚厨圣`，预览都是跨行拼出来的垃圾（`ea] File Transfer 11/05 w 我需要重新集结部队 。 %9:55` 等）。今天 5 次投递里 2 次是假的。
- **现场复现**：重跑 `wx.sh ocr`，真实侧栏 9 行，OCR 输出 9 行，其中至少 3 行串台（File Transfer 与 `111111…` 互相吃行、Tencent News 与 `KS, AK!` 互相吃行、名字被截）。
- **根因**：预览行被当成锚点（File Transfer 的预览 `1111…` 被读成聊天名）；行带互相重叠，同一行同时进两行；mention 判定扫描全窗口 ±38px，邻行的 @ 徽标会算到本行，且 `anchor.line.text.includes('@')` 会把混入标题行的预览算成 @。
- **下游污染**：`directory.json` 6 条 `resolvedBy:ocr` 垃圾条目；`tasks.jsonl` 3 条垃圾任务（`(ger News 17:07` 等）；`people.json` 1 条垃圾人物（`星晓家园10号楼1302 (19) Or 4 …`）。OCR 来源的 `lastPreview` 还会经 `index.js:654` 的 `entry.lastPreview` 兜底继续流转。
- **摘要参与者被发言人归因噪声污染**：2026-11-19「星晓家园10号楼1302」的日摘要里，参与者出现 `oe Sh33p |(25)`、`番 ”。。 这玩意以前…`、`首 < 他一- * Q` 等；273 条里 82 条是「发言人未识别」。这是消息区发言人归因的问题，不在本轮修（见「待决」）。
- **日志无时间戳**：`dsh-web.log` 是插件 stdout 原样追加，这次只能按行号和 `inbound.jsonl` 的 UTC 时间反推；`dsh-fish.log` 有，`dsh-wx` 没有。
- **例行凭据取用按 warn 记**：三天 260 条 `owner.credentials() 被取用`（B 站每次读 cookie），把 warn 通道冲淡。
- **重复投递已确认被昨天修复**：11-19 上午同一 `capture:` key 重投 2–3 次，都发生在 `1172ae4` 部署（14:05 重启）之前；之后日志里没有同 key 重投。
- **登录页与 tree-partial**：00:34 WSL 关机 → 09:40 启动后微信在登录页，直到人工登录；tree-partial 期间耳朵完全依赖 OCR。代码有意不自动点登录、不在使用中自动重启树，这两条本轮不改，列入「待决」。

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 必须保持 `{}`。
- `src/dsh-wx` 不新增 npm 依赖；外部命令仍走 `wx.sh` 的子进程。
- 不新增工具、HTTP 接口、事件类型，不改 `EVENT_SCHEMA_VERSION`；`events.jsonl` 只追加。
- `src/dsh-fish`：`node --test` 必须 1193 全绿（Task 1 完成后）。
- `src/dsh-wx`：`node --test` 在现有 167 条基础上全绿；单文件可用 `node test-ear-seen.mjs` 形式快跑。
- 提交前跑 `python scripts/audit-staged.py`；只暂存本任务明确路径，不带上 `desktop-pet-candidates/`。所有 `git` / `audit-staged.py` 命令都在仓库根目录执行。
- 提交信息用 conventional commits 中文正文，末尾附 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## Review Focus

1. **跨天与时钟边界**：身份测试的 presence 日期、`freshHits` 的去重窗口在 00:00 前后、`seen` 记录缺少 `at` 时都不能误判。
2. **截断标记的写法**：全角「…」、三个点「...」、末尾空格都算截断；没有截断的完整短句不能被 OCR 结果替换。
3. **群聊发送者归属**：侧栏预览滞后、`matched` 为空时，不能借用旧预览里的发送者。
4. **宿主 registry 不可用或返回空列表**：不能把活着的陪伴会话误判成死的——`ensureSession` 每次聊天都会调用，误判会不断新建会话。
5. **OCR 噪声**：低置信度行、右对齐的她自己的回复、跨气泡粘连，都不能进入补全正文。
6. **OCR 侧栏行归属**：同一条 OCR 行不能同时属于两个会话；邻行的 `[You were mentioned]` 徽标不能算到本行；预览行（长数字串、正文句子）不能变成聊天名。
7. **OCR 目录写入**：树不可用时 OCR 只能贡献名字/别名，不能贡献预览与发送者——垃圾预览会经 `entry.lastPreview` 兜底继续流转。

---

### Task 1: 身份测试不再写死日期（恢复全绿）

**Files:**
- Modify: `src/dsh-fish/test/identity.test.mjs:365-391`
- Test: 同文件

**Interfaces:**
- Consumes: `dateKey(d = new Date())`（`src/dsh-fish/lib/settings.js:508` 已导出，返回本地 `YYYY-MM-DD`）。
- Produces: 无生产代码改动。

- [ ] **Step 1: 复现红**

Run: `cd src/dsh-fish && node --test test/identity.test.mjs`
Expected: FAIL —— `他这几天：写盘并只在 web 面的 fish:owner 出现`，`actual` 为 `''`。

- [ ] **Step 2: 把写死的日期换成本地相对时间**

在 `identity.test.mjs` 顶部加 `import { dateKey } from '../lib/settings.js'`，把 365 行起的用例改成：

```js
const dk = dateKey(new Date(Date.now() - 3600_000))
await appendEvent({
  type: 'meta',
  text: `presence:${dk}:work:120:0`,
  ts: new Date(Date.now() - 3600_000).toISOString(),
}, { source: 'system' }, root)
```

其余断言（`他这几天`、`在做事`、不出现 `工作 2 小时|120 分钟`）保持不变。

- [ ] **Step 3: 单文件转绿**

Run: `cd src/dsh-fish && node --test test/identity.test.mjs`
Expected: PASS

- [ ] **Step 4: 全套转绿**

Run: `cd src/dsh-fish && node --test`
Expected: `pass 1193` / `fail 0`。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/test/identity.test.mjs
python scripts/audit-staged.py
git commit -m "test(dsh-fish): derive presence fixture date from clock

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 耳朵去重收敛到时间窗与完整正文

**Files:**
- Modify: `src/dsh-wx/lib/speaker.js:61-81`（`normalize` → 导出 `normalizePreview`，新增 `previewTruncated`）
- Modify: `src/dsh-wx/lib/ear-seen.js:96-115`（`freshHits`）
- Modify: `src/dsh-wx/lib/index.js:2356-2367`（删掉 `rememberSuppressed` 循环，改用 `onDuplicate`）
- Test: `src/dsh-wx/test-ear-seen.mjs`

**Interfaces:**
- Produces:
  - `freshHits(hits, seen, { isEcho = () => false, same = samePreviewText, now = Date.now(), dedupeMs = BODY_DEDUPE_MS, onDuplicate } = {})`
  - `export const BODY_DEDUPE_MS = 10 * 60_000`
  - `onDuplicate(hit)`：仅当命中因「同会话正文重复」被拦下时调用；被回声判断拦下的不调用。
  - `src/dsh-wx/lib/speaker.js` 导出 `normalizePreview(text): string` 与 `previewTruncated(text): boolean`。
- Consumes: 现有 `bodyOf` / `previewOfKey` / `samePreviewText`。

**规则：**
- 只和 `now - rec.at <= dedupeMs` 的 `seen` 记录比正文；`at` 缺失或超窗直接跳过。
- 两边文本任意一边以「…」或「...」结尾（`previewTruncated`）→ 沿用 `same`（前缀匹配）。
- 两边都不是截断预览 → 用 `normalizePreview(bodyOf(a)) === normalizePreview(bodyOf(b))` 完全相等。

- [ ] **Step 1: 写失败的测试**

在 `test-ear-seen.mjs` 的 2d 之后追加：

```js
// 2f. 6 小时前的同开头消息不能压住今天的新消息
const oldBody = parseSeen({ delivered: [{
  key: 'capture:m_old', at: NOW - 6 * HOUR, chat: '某群', text: '你能帮我看一下这个吗',
}] }, NOW)
assert.equal(freshHits([{
  key: 'capture:m_new', chat: '某群', why: '@', preview: '你能帮我看一下这个吗？急',
}], oldBody, { now: NOW }).length, 1, '超出去重窗口的正文不能永久压住新消息')

// 2g. 窗口内、都没截断的两句只是延伸关系 → 算两条
const nearBody = parseSeen({ delivered: [{
  key: 'capture:m_a', at: NOW - 60_000, chat: '某群', text: '明天下午三点开会，记得带电脑',
}] }, NOW)
assert.equal(freshHits([{
  key: 'capture:m_b', chat: '某群', why: '@', preview: '明天下午三点开会，记得带电脑和充电器',
}], nearBody, { now: NOW }).length, 1, '没截断的两句不是同一句')

// 2h. 只把「正文重复」写进 seen；回声拦下的不写
const dup = []
const dupSeen = parseSeen({ delivered: [{
  key: 'capture:m_dup', at: NOW - 30_000, chat: '某群', text: '同一句',
}] }, NOW)
assert.equal(freshHits([{
  key: 'capture:m_dup2', chat: '某群', why: '@', preview: '同一句',
}], dupSeen, { now: NOW, onDuplicate: (m) => dup.push(m.key) }).length, 0)
assert.deepEqual(dup, ['capture:m_dup2'])

const echoDup = []
freshHits([{ key: '某个猫||哟', chat: '某个猫', why: 'exempt', preview: '哟' }], new Map(), {
  now: NOW,
  isEcho: () => true,
  onDuplicate: (m) => echoDup.push(m.key),
})
assert.deepEqual(echoDup, [], '回声拦下不等于正文重复')

// 2i. 缺 at 的旧记录不参与正文比对，不能被当成永远有效
const noAt = new Map([['capture:m_nat', { chat: '某群', text: '同一句' }]])
assert.equal(freshHits([{
  key: 'capture:m_nat2', chat: '某群', why: '@', preview: '同一句',
}], noAt, { now: NOW }).length, 1)
```

并把需要时间窗口的既有调用补上 `{ now: NOW }`：2c 的 `freshHits([…], prefixedSeen)`（39-41 行）、2d 的两处 `freshHits([…], captureSeen)`（56-63 行）。

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-ear-seen.mjs`
Expected: FAIL —— 2f 得到 0 条（新消息被吞）。

- [ ] **Step 3: 实现**

- `speaker.js`：把 `const normalize` 改名为 `export function normalizePreview`，更新文件内所有调用点；新增 `export function previewTruncated(text)`，正则 `/(?:…|\.{3,})\s*$/u`。
- `ear-seen.js`：按 Interfaces 改 `freshHits`；`onDuplicate` 只在前缀/完全相等命中时调用。
- `index.js`：`freshHits` 传 `onDuplicate: (m) => suppressed.push(m)`，返回后再统一 `seen.set(...)` 并 `saveSeen()`；删除 `rememberSuppressed` 循环。回调里只收集，不在 `freshHits` 遍历 `seen` 期间改 Map。

- [ ] **Step 4: 转绿并跑全套**

Run: `cd src/dsh-wx && node test-ear-seen.mjs && node --test`
Expected: 脚本打印 `ear-seen: 全部通过`；`node --test` 全绿（含新增断言）。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/speaker.js src/dsh-wx/lib/ear-seen.js src/dsh-wx/lib/index.js src/dsh-wx/test-ear-seen.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-wx): bound body dedupe to a short window

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 群聊发送者不再张冠李戴

**Files:**
- Modify: `src/dsh-wx/lib/ear-open.js:100-108`
- Test: `src/dsh-wx/test-ear-open.mjs`

**Interfaces:**
- Consumes: 现有 `matched`、`rec`、`pv.sender`。
- Produces: `openChatHit(...).preview` 只在 `matched.includes(rec)` 时带发送者前缀，否则为 `String(rec.text)`。

- [ ] **Step 1: 写失败的测试**

在 `test-ear-open.mjs` 的 16 之后追加：

```js
// 17. 侧栏预览跟丢（matched 为空）时，不能拿旧预览的发送者给新记录安名字
const staleSender = hit({
  chat: '测试群A',
  row: row({ name: '测试群A', preview: '张三: 早上的事' }),
  captured: captured(rec({ text: '李四这边的消息 @D33P533K 看一下' })),
  requirePreviewMatch: false,
})
assert.equal(staleSender?.preview, '李四这边的消息 @D33P533K 看一下')
assert.equal(staleSender?.why, 'at')
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-ear-open.mjs`
Expected: FAIL —— 实际 preview 是 `张三: 李四这边的消息 …`。

- [ ] **Step 3: 实现**

`preview: (matched.includes(rec) && pv.sender ? \`${pv.sender}: \` : '') + String(rec.text)`，并把注释改成「只有预览对上的那条才知道发送者」。

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-wx && node test-ear-open.mjs && node --test`
Expected: 打印 `ear-open: 全部通过`；`node --test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/ear-open.js src/dsh-wx/test-ear-open.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-wx): only prefix sender when the preview matched

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 陪伴会话以「任何工作区都不认它」判死

**Files:**
- Modify: `src/dsh-fish/lib/screen.js:214-245`（`sessionArchived` → `sessionDead`，`ensureSession` 改为 `await`）
- Test: `src/dsh-fish/test/screen.test.mjs:25-90`（`makeService` 增加 `liveSessions`）、`:108-147` 附近新增用例

**Interfaces:**
- Produces: `async function sessionDead(id): boolean` —— 满足任一即死：在 `archivedSessionIds` 里；或 registry 有 `list()` 且返回非空、但没有任何工作区的 `sessionIds` 含该 id。
- 读取失败、registry 不存在、没有 `list`、`list()` 抛错或返回空数组 → 返回 `false`（沿用旧 id，不误判）。
- Consumes: `workspaceRegistry.list()` 返回 `[{ sessionIds, path, title, id }, …]`（与 `home.js:67`、`retire.js:59` 一致）。

- [ ] **Step 1: 给测试夹具加 registry 列表**

`makeService` 参数增加 `liveSessions = null`；构造 registry 时：

```js
if (name === 'workspaceRegistry') {
  return {
    archivedSessionIds: archived,
    ...(liveSessions ? { list: () => [{ sessionIds: liveSessions }] } : {}),
  }
}
```

- [ ] **Step 2: 写失败的测试**

在「陪伴会话被删/归档后自动换新」之后追加：

```js
test('陪伴会话不在任何工作区的 sessionIds 里也算死，自动换新', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'screen-session.json'), JSON.stringify({
      sessionId: 'gone-1', mode: 'event',
      segmentStartedAt: Date.parse('2026-11-13T09:50:00Z'),
      segmentDayKey: '2026-11-13', segmentComments: 0, sessionComments: 2,
    }))
    const svc = makeService(root, { liveSessions: ['other-session'] })
    await svc.service.setMode({ mode: 'event', on: true })
    assert.equal(svc.service.companionInfo().sessionId, 's1')
  })
})

test('registry 返回空列表时不能误判死会话', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'screen-session.json'), JSON.stringify({
      sessionId: 'live-2', mode: 'event',
      segmentStartedAt: Date.parse('2026-11-13T09:50:00Z'),
      segmentDayKey: '2026-11-13', segmentComments: 0, sessionComments: 1,
    }))
    const svc = makeService(root, { liveSessions: [] })
    await svc.service.setMode({ mode: 'event', on: true })
    assert.equal(svc.service.companionInfo().sessionId, 'live-2')
  })
})
```

既有「还活着的陪伴会话照旧复用」（registry 没有 `list`）必须继续通过。

- [ ] **Step 3: 跑到失败**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs`
Expected: 新用例 1 FAIL（复用了 `gone-1`）。

- [ ] **Step 4: 实现**

按 Interfaces 改 `sessionDead`；`ensureSession` 里 `if (await sessionDead(savedId))` 走换新分支，日志文案保持「陪伴会话已被归档/删除，换一条新的」。

- [ ] **Step 5: 转绿并跑全套**

Run: `cd src/dsh-fish && node --test test/screen.test.mjs && node --test`
Expected: `fail 0`（既有用例 + 新增 2 条全绿）。

- [ ] **Step 6: 提交**

```bash
git add src/dsh-fish/lib/screen.js src/dsh-fish/test/screen.test.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-fish): treat sessions missing from every workspace as dead

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: OCR 只在预览被截断时补全

**Files:**
- Modify: `src/dsh-wx/lib/ocr-complete.js:76-85`（`completeFromOcrLines` 入口）
- Modify: `src/dsh-wx/lib/index.js:2288-2314`（OCR 分支前置条件）
- Test: `src/dsh-wx/test-ocr-complete.mjs`

**Interfaces:**
- Consumes: Task 2 产出的 `previewTruncated(text): boolean`（从 `./speaker.js` 导入）。
- Produces: `completeFromOcrLines(preview, lines, opts)` 在 `previewTruncated(preview)` 为 false 时直接返回 `''`。

- [ ] **Step 1: 写失败的测试**

在 `test-ocr-complete.mjs` 末尾追加：

```js
test('预览没被截断时不补全，哪怕 OCR 能拼出更长的行', () => {
  const list = lines([
    ['@D33P533K 在吗晚上吃什么', 0],
    ['再拼一句', 21],
  ])
  assert.equal(completeFromOcrLines('@D33P533K 在吗', list), '', '完整短句不能被替换')
  assert.match(
    completeFromOcrLines('@D33P533K 在吗…', list),
    /晚上吃什么/,
    '全角省略号算截断',
  )
  assert.match(
    completeFromOcrLines('@D33P533K 在吗...', list),
    /晚上吃什么/,
    '三个点也算截断',
  )
  assert.match(
    completeFromOcrLines('@D33P533K 在吗… ', list),
    /晚上吃什么/,
    '省略号后面的空格不影响截断判断',
  )
})
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-ocr-complete.mjs`
Expected: FAIL —— 完整短句被替换成 `@D33P533K 在吗晚上吃什么`。

- [ ] **Step 3: 实现**

- `ocr-complete.js` 顶部 `import { previewTruncated } from './speaker.js'`；`completeFromOcrLines` 在 `if (!body) return ''` 后加 `if (!previewTruncated(body)) return ''`。
- `index.js` 的 OCR 分支加同样判断：`const body = pv.text || String(m.preview ?? '')` 之后、`if (!body) continue` 附近改为 `if (!body || !previewTruncated(body)) continue`。`previewTruncated` 与 `parsePreviewSender` 同源导入。

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-wx && node test-ocr-complete.mjs && node --test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/ocr-complete.js src/dsh-wx/lib/index.js src/dsh-wx/test-ocr-complete.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-wx): only complete OCR for truncated previews

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: OCR 拼行不吞右对齐的她自己的话

**Files:**
- Modify: `src/dsh-wx/lib/ocr-complete.js:30-60`（`joinOcrBubble` 循环）
- Test: `src/dsh-wx/test-ocr-complete.mjs`

**Interfaces:**
- Produces: `joinOcrBubble` 在下一行 `left > start.left + Math.max(24, median)` 时停止（右对齐气泡，通常是她的回复）。

- [ ] **Step 1: 写失败的测试**

追加：

```js
test('右对齐的下一行（她自己的回复）不拼进对方气泡', () => {
  const right = [
    { text: '@D33P533K 这条被截断了', top: 0, height: 20, left: 20, width: 300, confidence: 80 },
    { text: '我看到了，这就来', top: 21, height: 20, left: 520, width: 200, confidence: 80 },
  ]
  const joined = joinOcrBubble(right, 0)
  assert.equal(joined.lines.length, 1)
  assert.equal(joined.text.includes('这就来'), false)
})
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-ocr-complete.mjs`
Expected: FAIL —— 两行被拼在一起。

- [ ] **Step 3: 实现**

在 `joinOcrBubble` 循环里、现有右边缘检查旁加：

```js
if (Number(line.left) > Number(start.left) + Math.max(24, median)) break
```

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-wx && node test-ocr-complete.mjs && node --test`
Expected: 全绿（原有左对齐多行用例不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/ocr-complete.js src/dsh-wx/test-ocr-complete.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-wx): stop OCR line joining at right-aligned bubbles

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: tesseract 低置信度行不再进拼行

**Files:**
- Modify: `src/dsh-wx/lib/ocr-messages.mjs:20-35`（`parseMessageTsv`）
- Test: Create `src/dsh-wx/test-ocr-messages.mjs`

**Interfaces:**
- Produces: `parseMessageTsv(tsv, { scale = 1, minConfidence = 25 })`；`confidence < minConfidence` 的单词直接丢弃（与 `ocr-snapshot.mjs:12` 的 `parseTsv` 一致）。

- [ ] **Step 1: 写失败的测试**

新建 `src/dsh-wx/test-ocr-messages.mjs`：

```js
// ocr-messages 的 TSV 解析：低置信度行不能进入拼行。
import assert from 'node:assert/strict'
import { parseMessageTsv } from './lib/ocr-messages.mjs'

const header = 'level\tpage\tblock\tpar\tline\tword\tleft\ttop\twidth\theight\tconf\ttext'
const tsv = [
  header,
  '5\t1\t1\t1\t1\t0\t10\t20\t300\t20\t-1\tjunk',
  '5\t1\t1\t1\t1\t1\t10\t20\t300\t20\t88\thello',
].join('\n')

const lines = parseMessageTsv(tsv)
assert.equal(lines.length, 1, '置信度 -1 的单词不应成行')
assert.equal(lines[0].text, 'hello')
console.log('ocr-messages: 全部通过')
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-ocr-messages.mjs`
Expected: FAIL —— 解析出 1 行 `junk`。

- [ ] **Step 3: 实现**

`parseMessageTsv` 增加参数 `minConfidence = 25`；把现有 `if (!Number.isFinite(confidence) || …)` 改成 `if (!Number.isFinite(confidence) || confidence < minConfidence || …)`。

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-wx && node test-ocr-messages.mjs && node --test`
Expected: 打印 `ocr-messages: 全部通过`；`node --test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/ocr-messages.mjs src/dsh-wx/test-ocr-messages.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-wx): drop low-confidence OCR words in the message pane

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: OCR 侧栏行解析加固（锚点、行带、@ 徽标）

**Files:**
- Modify: `src/dsh-wx/lib/ocr-snapshot.mjs:85-95`（`isClockWord`、`isMention`）
- Modify: `src/dsh-wx/lib/ocr-snapshot.mjs:105-185`（`groupTimestampAnchoredRows`）
- Test: `src/dsh-wx/test-ocr-snapshot.mjs`

**Interfaces:**
- `isClockWord(text)` 增加日期与星期写法：`\d{1,2}/\d{1,2}`、`Monday…Sunday`、`星期[一二三四五六日天]`、`周[一二三四五六日天]`、`昨天/今天`（可带时间）。
- `isMention(text)` 增加中文徽标：`有人@我`。
- `groupTimestampAnchoredRows` 规则：
  - 行带边界取相邻锚点 top 的中点（首行 `top-6`，末行 `height*0.96`），一行只属于一个会话。
  - `rest` 排除**所有**锚点的标题行，不只是当前行。
  - mention 只看本行带内的 `isMention` 行；删除 `anchor.line.text.includes('@')` 和跨行 ±38px 扫描。
  - `preview` 同时排除 `isMention` 行，徽标文字不能进预览。
  - 无时间锚点按「行距」验收：先取带时间的锚点算中位行距；候选到最近带时间锚点的距离必须在 `0.6–1.4 × 中位行距` 内。带时间锚点不足 2 个时，退回 `nameConfidence >= 90` 且名字像标题：长度 ≤ 24、不是 `isPreview(name)`、不匹配 `/^[\d\s.…_-]{4,}$/`。
  - 已用当前代码验证过：phantom 夹具会多出 `1111111111111111111` 行，badge 夹具会把 `hello there` 当行、并把 `[You were mentioned]` 算到 Group B——新规则下都应消失。

- [ ] **Step 1: 写失败的测试**

在 `test-ocr-snapshot.mjs` 追加三组用例（`word()` 坐标仍按 2x 放大，函数入参 width=339）：

```js
// 1) 长数字预览不能变成聊天名；日期/星期也要能当锚点
const phantomLines = [
  word(1,1,1,1, 250, 940, 180, 44, 95, 'File'), word(1,1,1,1, 440, 944, 220, 44, 95, 'Transfer'),
  word(1,1,1,1, 1096, 948, 104, 28, 96, '11/05'),
  word(1,1,1,2, 250, 992, 480, 40, 96, '1111111111111111111'),
  word(1,1,1,3, 250, 1060, 180, 44, 95, 'Tina'), word(1,1,1,3, 440, 1064, 80, 44, 95, 'Yu'),
  word(1,1,1,3, 1096, 1068, 120, 28, 96, 'Monday'),
].join('\n')
const phantom = groupTimestampAnchoredRows(parseTsv(`header\n${phantomLines}`, { scale: 2 }), 339, 666)
assert.deepEqual(phantom.map((row) => row.name), ['File Transfer', 'Tina Yu'], '预览行不再是锚点')
assert.equal(phantom[0].preview, '1111111111111111111', '预览留在原行，不串到下一行')

// 2) 紧贴下一行的 @ 徽标只属于下一行
const neighborBadge = [
  word(1,1,1,1, 250, 940, 180, 44, 95, 'Group A'),
  word(1,1,1,1, 1096, 948, 104, 28, 96, '10:00'),
  word(1,1,1,2, 250, 984, 300, 40, 95, 'hello there'),
  word(1,1,1,3, 250, 1006, 480, 40, 95, '[You were mentioned]'),
  word(1,1,1,4, 250, 1030, 180, 44, 95, 'Group B'),
  word(1,1,1,4, 1096, 1036, 104, 28, 96, '10:01'),
].join('\n')
const badgeRows = groupTimestampAnchoredRows(parseTsv(`header\n${neighborBadge}`, { scale: 2 }), 339, 666)
assert.deepEqual(badgeRows.map((row) => row.name), ['Group A', 'Group B'], '预览行不再变成一行')
assert.equal(badgeRows.find((row) => row.name === 'Group A')?.mention, false, '邻行的徽标不算本行')
assert.equal(badgeRows.find((row) => row.name === 'Group A')?.preview, 'hello there', '自己的预览留在本行')
assert.equal(badgeRows.find((row) => row.name === 'Group B')?.mention, true, '徽标跟着自己的行')
assert.equal(badgeRows.find((row) => row.name === 'Group B')?.preview, '', '徽标不混进预览')

// 3) 中文徽标也能识别
const zhBadge = [
  word(1,1,1,1, 250, 940, 180, 44, 95, '某群'),
  word(1,1,1,1, 1096, 948, 104, 28, 96, '10:00'),
  word(1,1,1,2, 250, 984, 300, 40, 95, '[有人@我]'),
].join('\n')
const zhRows = groupTimestampAnchoredRows(parseTsv(`header\n${zhBadge}`, { scale: 2 }), 339, 666)
assert.equal(zhRows.find((row) => row.name === '某群')?.mention, true, '中文 @ 徽标也能识别')
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-ocr-snapshot.mjs`
Expected: FAIL —— 多出 `1111111111111111111` 行 / Group A 的 mention 为 true。

- [ ] **Step 3: 实现**

按 Interfaces 改 `ocr-snapshot.mjs`；保持返回结构不变，既有「锚点标题词」「截断名」用例必须继续通过。

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-wx && node test-ocr-snapshot.mjs && node --test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/ocr-snapshot.mjs src/dsh-wx/test-ocr-snapshot.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-wx): keep OCR sidebar rows from bleeding into each other

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: OCR 来源的目录合并只写名字

**Files:**
- Modify: `src/dsh-wx/lib/directory.js:240-260`（`merge` 里按 `source` 收窄）
- Test: `src/dsh-wx/test-directory.mjs`

**Interfaces:**
- `merge({ chats, current, source, … })`：当 `source === 'ocr'` 时，只更新名字、全名、别名与 `lastSeenAt`；跳过 `lastPreview`、`lastSender`、`unread`、`pinned`、`position`，也不从预览推断 `kind`。
- tree / scan 来源行为不变。

- [ ] **Step 1: 写失败的测试**

在 `test-directory.mjs` 追加（沿用文件里的 `t()` / `file()` / `T` 夹具）：

```js
await t('OCR 来源只写名字，不写预览与发送者', async () => {
  const d = createDirectory({ file: file(), now: () => T })
  d.merge({ chats: [{ name: '某群', preview: 'ea] File Transfer 11/05' }], source: 'ocr' })
  assert.equal(d.entry('某群').lastPreview, '', 'OCR 不写预览')
  assert.equal(d.entry('某群').lastSender, null, 'OCR 不写发送者')
  d.merge({ chats: [{ name: '某群', preview: '真的预览' }], source: 'tree' })
  assert.equal(d.entry('某群').lastPreview, '真的预览', 'tree 照旧写预览')
})
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-directory.mjs`
Expected: FAIL —— `lastPreview` 被写成垃圾预览。

- [ ] **Step 3: 实现**

在 `directory.js` 的 merge 里按 `source === 'ocr'` 跳过上述字段；注释写明「树不可用时 OCR 只负责名字，预览交给树/扫描」。

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-wx && node test-directory.mjs && node --test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/directory.js src/dsh-wx/test-directory.mjs
python scripts/audit-staged.py
git commit -m "fix(dsh-wx): stop OCR merges from writing previews into the directory

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: dsh-wx 控制台日志加时间戳

**Files:**
- Create: `src/dsh-wx/lib/log.mjs`
- Modify: `src/dsh-wx/lib/index.js`（62 处 `console.log(` → `logLine(`）
- Test: Create `src/dsh-wx/test-log.mjs`

**Interfaces:**
- `logLine(...args)`：输出 `YYYY-MM-DD HH:mm:ss ` 前缀 + `args.join(' ')`；本地时区，月/日/时/分/秒补零。
- `formatStamp(date = new Date())`：返回 `YYYY-MM-DD HH:mm:ss`，供测试与复用。
- 只替换 `lib/index.js`；`lib/wx-elements.mjs` 与 `ocr-*.mjs` 的 stdout 是给解析器读的，保持原样。

- [ ] **Step 1: 写失败的测试**

新建 `test-log.mjs`：

```js
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { formatStamp } from './lib/log.mjs'

assert.equal(formatStamp(new Date(2026, 10, 20, 9, 5, 3)), '2026-11-20 09:05:03')
const src = readFileSync(new URL('./lib/index.js', import.meta.url), 'utf8')
assert.equal(src.includes('console.log('), false, 'index.js 的人读日志都要带时间戳')
assert.equal(src.includes('logLine('), true)
console.log('log: 全部通过')
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-wx && node test-log.mjs`
Expected: FAIL —— `lib/log.mjs` 不存在 / index.js 仍有 `console.log(`。

- [ ] **Step 3: 实现**

新建 `lib/log.mjs`；在 `index.js` 顶部 `import { logLine } from './log.mjs'`，把 62 处 `console.log(` 机械替换为 `logLine(`（模板字符串与单引号都覆盖）。

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-wx && node test-log.mjs && node --test`
Expected: 打印 `log: 全部通过`；`node --test` 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/log.mjs src/dsh-wx/lib/index.js src/dsh-wx/test-log.mjs
python scripts/audit-staged.py
git commit -m "chore(dsh-wx): timestamp console logs

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: 例行凭据取用降为 info

**Files:**
- Modify: `src/dsh-fish/lib/core-service.js:39-43, 117`（`asInfo`，把 `info` 传给 owner service）
- Modify: `src/dsh-fish/lib/owner-service.js:54-59`
- Modify: `src/dsh-fish/lib/index.js:239`（`log: logger`，保留 `.warn`/`.info`）
- Test: `src/dsh-fish/test/core-services.test.mjs`

**Interfaces:**
- `asInfo(log)`：`log.info` 是函数时返回转发函数，否则 `undefined`。
- `createOwnerService({ root, log, info })`：`credentials()` 的审计行走 `(info ?? log)`；失败路径仍走 `log`。
- `provideFishCore(ctx, { log: logger })` 时，其他服务仍经 `asWarn` 拿 `.warn`，行为不变。

- [ ] **Step 1: 写失败的测试**

在 `core-services.test.mjs` 增加：

```js
test('owner.credentials 的例行取用走 info，不占 warn', async () => {
  const calls = { info: [], warn: [] }
  await withCore(async ({ core, root }) => {
    await writeOwner({ mid: '42', cookie: 'SESSDATA=abc' }, root)
    await core.owner.credentials()
    assert.equal(calls.info.some((a) => String(a[0]).includes('owner.credentials')), true)
    assert.equal(calls.warn.some((a) => String(a[0]).includes('owner.credentials')), false)
  }, { log: { info: (...a) => calls.info.push(a), warn: (...a) => calls.warn.push(a) } })
})
```

- [ ] **Step 2: 跑到失败**

Run: `cd src/dsh-fish && node --test test/core-services.test.mjs`
Expected: FAIL —— 审计行进了 `warn`。

- [ ] **Step 3: 实现**

按 Interfaces 改三个文件；`index.js:239` 改为 `log: logger`（宿主 logger 已由 `makeLogger` 提供 `info/warn`）。

- [ ] **Step 4: 转绿**

Run: `cd src/dsh-fish && node --test test/core-services.test.mjs && node --test`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-fish/lib/core-service.js src/dsh-fish/lib/owner-service.js src/dsh-fish/lib/index.js src/dsh-fish/test/core-services.test.mjs
python scripts/audit-staged.py
git commit -m "chore(dsh-fish): log routine credential access at info

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: 文档、CHANGELOG 与本地忽略

**Files:**
- Modify: `docs/superpowers/specs/2026-11-19-pet-long-wake-design.md:3`
- Modify: `src/dsh-fish/CHANGELOG.md`（顶部新增一节）
- Modify: `.gitignore`（依赖/生成物一节）

- [ ] **Step 1: 更新长唤醒设计状态**

第 3 行改为：

```markdown
> 状态：**已实现**（2026-11-19，`f316efe` / `27cb990` / `4bdd225`）；本文件保留为设计记录。
```

- [ ] **Step 2: 写 CHANGELOG**

在 `src/dsh-fish/CHANGELOG.md` 顶部加：

```markdown
## 未发布 — 2026-11-20

**审查与日志修复：耳朵去重、发送者归属、陪伴会话存活、OCR 行归属、日志可诊断性**

- 微信耳朵：`freshHits` 的正文去重只在 10 分钟内生效，且未截断的两句必须完全相等；只剩「正文重复」写进 seen，回声拦下的不再记成已投递。
- 当前会话命中：发送者前缀只在侧栏预览真的对上那条记录时添加。
- 陪伴会话：除了 `archivedSessionIds`，还检查宿主 registry 里是否仍有工作区认这条 session；registry 读不到或列表为空时沿用旧 id。
- OCR 补全：只在预览以「…」/「...」结尾时运行；拼接行遇到右对齐气泡（她自己的回复）停止；tesseract 置信度低于 25 的行丢弃。
- OCR 侧栏：预览行不再变成聊天名；相邻会话的行带按锚点中点切开，一条 OCR 行只属于一个会话；@ 徽标只归本行（含中文「有人@我」）。
- 目录：OCR 来源只贡献名字/别名，不写预览与发送者，避免垃圾预览经 `entry.lastPreview` 继续流转。
- 日志：`dsh-wx` 的控制台日志加 `YYYY-MM-DD HH:mm:ss` 前缀；`owner.credentials()` 的例行取用从 warn 降为 info。
- 测试：`src/dsh-fish` 全绿；`src/dsh-wx` 全绿（含新增用例）。
```

- [ ] **Step 3: 忽略本地候选目录**

`.gitignore` 在「Dependencies, generated files…」一节加：

```
/desktop-pet-candidates/
```

- [ ] **Step 4: 检查后提交**

```bash
git diff --check
git add docs/superpowers/specs/2026-11-19-pet-long-wake-design.md src/dsh-fish/CHANGELOG.md .gitignore
python scripts/audit-staged.py
git commit -m "docs: record review fixes and ignore local pet candidates

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 5: 整体验证**

Run: `cd src/dsh-fish && node --test`
Run: `cd src/dsh-wx && node --test`
Expected: 两套全绿；`git status` 只剩原本未跟踪的调研文档。

## 不做的事

- 不实现 `look_screen` 工具（仍按 `2026-11-19-look-screen-tool-design.md` 待批准）。
- 不清理 `pet-view.js` 的 `exportRestState`（目前只有测试在用；保留作为状态导出的唯一定义）。
- 不新增 OCR 裁剪配置；窗口几何仍按 `ocr-messages.mjs` 的固定比例。
- 不改微信登录页策略：仍然只提醒、不自动点登录（会骚扰手机端）。
- 不改 tree-partial 的使用期重启策略（见「待决」）。
- 不删除历史污染数据（6 条 OCR 目录条目、1 条人物、3 条任务）；修复上线后单独确认清理。
- 不动 workbench / desktop-pet / 调度器。

## 待决

1. **tree-partial 持续多久后做有界恢复**：这次登录后 partial 约半小时，期间耳朵完全依赖 OCR。现有约定是「使用中不自动重启」，因为 partial 也可能只是微信停在通讯录页。需要定一个阈值（例如连续 15 分钟）和恢复动作（重启微信 / 只重新挂桥 / 只报警）。
2. **历史污染清理**：`directory.json` 6 条 `resolvedBy:ocr` 垃圾条目、`people.json` 1 条垃圾人物、`tasks.jsonl` 3 条垃圾任务；删除前需要逐条列出并取得批准。
3. **登录页运维提示**：重启后微信需要人工登录是已知事实；是否在工作台把「需要人工登录」做成更醒目的状态（目前只在日志/健康里）。
4. **摘要参与者噪声**：`summaries.js` 的 `participantsOf` 直接按 `sender` 原字符串计数，归因噪声会进摘要和检索。可选规则：只让 people 名册里已确认的名字进摘要，或按出现次数/多个证据键过滤。需要和「昵称任意、不按字符类判定」的约定一起定，不在本轮改。
