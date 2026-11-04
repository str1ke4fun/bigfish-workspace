# 微信后台采集器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让大肥鱼挂着时持续把微信会话（预览 + 白名单轮转全文）写进台账，并用 OCR 几何对齐补发言人，采集全程后台运行、她在说话时让路。

**Architecture:** 采集器是耳朵进程里的后台工作者，不注册成模型工具。每轮先做只读的预览流入账与入队判断，只在 `hostBusy`/发送/待投递/@ 窗口等暂停条件都不成立时，才在 GUI 锁内点开一个会话、读屏、OCR、回滚补断档、恢复原会话。解析、名册、对齐、队列、暂停判断都是纯函数模块，便于 fixture 测试；`index.js` 只做接线。

**Tech Stack:** Node.js ≥20（ESM，零新增依赖）、`node --test`、现有 `wx.sh`（AT-SPI + xdotool + ImageMagick + tesseract）、现有 JSONL 台账。

**Spec:** `docs/superpowers/specs/2026-11-04-wechat-background-capture-design.md`

## Global Constraints

- 只在 `dev` 工作树 `/home/str1k3/src/bigfish-workspace-dev`（分支 `dev`）改源码和验证；未经用户明确批准不合并 `main`、不部署。
- 零新增 npm 依赖；只用 Node 内置模块和系统已有的 `wx.sh`/`tesseract`/ImageMagick。
- 台账、`events.jsonl`、历史事件只追加，绝不删除、覆盖、重排；纠正只用 `repair`。
- 采集器不是模型工具。唯一新增的模型工具是只读的 `wx_history`。
- 服务号/新闻/文件传输（`policy.ignoreChats`）不进入预览台账、轮转队列和 `wx_history` 列表；旧记录不删除。
- 测试不得启动或操作真实微信；全部用 fixture 和临时目录。
- 测试命令：`cd /home/str1k3/src/bigfish-workspace-dev/src/dsh-wx && node --test`。
- 只暂存本任务涉及的明确路径；提交前跑 `git diff --cached --check` 和 `python scripts/audit-staged.py`。
- 不碰未跟踪的 `src/dsh-wx/lib/sticker-panel.mjs`。
- 所有中文面向用户/日志的文案保持现有“平铺陈述”风格，不加语气词。

## Review Focus

- 预览里的时间、系统提示、普通词被误认成发言人：`14:02 开会`、`注意：明天`、`[Link]`、`Someone: text` 必须分别落到“不认发言人”或正确名字（Task 2）。
- 时间行、引用块、贴纸/面板行被当正文写进台账：`14:02`、`Yesterday 16:29`、`Quote …`、`Animated Stickers`（Task 1）。
- 服务号因大小写、空格或“名字包含”混入：`Tencent News` 要挡，`Tencent News 讨论组` 不能被误挡；查询历史时也要挡（Task 4、Task 5）。
- OCR 名字行与气泡错位，或她自己右侧的气泡被记成别人：名字行只在消息项顶部 45% 内找；右侧对齐且无名字 → `out`（Task 9）。
- 采集与发送抢 UI、她正在说话时仍点开会话：暂停条件在 Task 4 有纯函数测试，打开/恢复/退避在 Task 11 有假 IO 测试，锁内串行由 Task 12 接线、Task 13 真机观察。

---

### Task 1: 消息行解析（时间 / 引用 / 贴纸）+ 台账新字段

**Files:**
- Create: `src/dsh-wx/lib/transcript.js`
- Modify: `src/dsh-wx/lib/ledger.js:190-260`（`append` 的 `rec` 对象）
- Create: `src/dsh-wx/test-transcript.mjs`
- Test: `src/dsh-wx/test-ledger.mjs`

**Interfaces:**
- Produces:
  - `kindOfLabel(label: string) -> 'text'|'sticker'|'image'|'file'|'voice'|'video'|'link'`
  - `isTimeMarker(text: string) -> boolean`
  - `parseSidebarTime(text: string, now?: number) -> { at: string, confidence: 'medium'|'low' }`（读不出时 `{at:'',confidence:'low'}`）
  - `splitMessageLabel(label: string) -> { text: string, quote: {author:string,text:string}|null, kind: string }`
  - `normalizeMessages(items: Array<{text:string, box?:object}>, opts?: {now?:number}) -> Array<{text:string, kind:string, quote:object|null, at:string, atConfidence:string, box?:object}>`
- 台账 `append` 新记录增加可选 `quote`（对象）与 `unreadBefore`（数字），没有就不写这两个键。

- [ ] **Step 1: 写失败测试**

`src/dsh-wx/test-transcript.mjs` 用现有风格（`import assert from 'node:assert/strict'`、自定义 `t(name, fn)`、末尾打印通过数并以非零退出表示失败）：

```js
const NOW = new Date(2026, 10, 4, 15, 0, 0).getTime() // 本地时间 2026-11-04 15:00

// parseSidebarTime
r = parseSidebarTime('14:02', NOW);      // 同日 14:02
r = parseSidebarTime('Yesterday 16:29', NOW); // 11-03 16:29
r = parseSidebarTime('Monday', NOW);     // 11-02 00:00
r = parseSidebarTime('昨天 09:05', NOW);  // 11-03 09:05
r = parseSidebarTime('14:02', new Date(2026, 10, 4, 9, 0, 0).getTime()); // 未来时间 → 11-03 14:02
r = parseSidebarTime('下午三点', NOW);    // { at:'', confidence:'low' }

// isTimeMarker
isTimeMarker('14:02') === true
isTimeMarker('Yesterday 16:29') === true
isTimeMarker('Monday') === true
isTimeMarker('14:02 开会') === false

// splitMessageLabel / kindOfLabel
splitMessageLabel("那里润\nQuote 计科4221陈子助's message: 很润是吧")
// → { text:'那里润', quote:{author:'计科4221陈子助', text:'很润是吧'}, kind:'text' }
splitMessageLabel('Animated Stickers').kind === 'sticker'
splitMessageLabel('[Image]').kind === 'image'
splitMessageLabel('普通一句话') // → text 原样，quote null，kind text

// normalizeMessages
normalizeMessages([{ text:'14:02', box:{x:1,y:2,w:3,h:4} }, { text:'甲说' }, { text:'乙说' }], { now:NOW })
// → 2 条，at 都是 14:02，atConfidence 都是 medium
normalizeMessages([{text:'Animated Stickers'},{text:'Animated Stickers'},{text:'Animated Stickers'}])
// → []（末尾连续 3 条相同贴纸是表情面板浮层）
normalizeMessages([{ text:'Animated Stickers' }, { text:'后面还有人说话' }])
// → 2 条，第一条 kind=sticker、text='Animated Stickers'
normalizeMessages([{ text:'那里润\nQuote 张三\'s message: 原文', box:{x:9,y:9,w:9,h:9} }])
// → 1 条，quote.author='张三'，box 原样保留
```

`test-ledger.mjs` 增加一条：

```js
const r = ledger.append('c_test', [{ text:'引用测试', quote:{author:'张三',text:'原文'}, unreadBefore:3 }], { chatName:'测试' })
const rec = ledger.recent('c_test', 1)[0]
assert.equal(rec.quote.author, '张三')
assert.equal(rec.unreadBefore, 3)
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-transcript.mjs test-ledger.mjs`
Expected: FAIL（`transcript.js` 不存在；台账新字段为 `undefined`）

- [ ] **Step 3: 实现 `lib/transcript.js`**

- `kindOfLabel`：识别 `[Sticker]`/`Animated Stickers`/`[Image]`/`[File]`/`[Voice]`/`[Video]`/`[Link]` 及对应中文标记；其余 `text`。
- `isTimeMarker` 正则覆盖 `HH:MM`、`(Yesterday|Today)\s+HH:MM`、`(昨天|今天)\s*HH:MM`、`Monday…Sunday`（可带时间）、`周[一二三四五六日天]`/`星期[一二三四五六日天]`（可带时间）。
- `parseSidebarTime`：按 `now` 的本地日期推断；`HH:MM` 解析结果晚于 `now + 60s` 时减一天；星期/`Monday` 取最近一次该星期几（无时间用 00:00）；返回 ISO 字符串与 `medium`。
- `splitMessageLabel`：先匹配 `/^([\s\S]*?)\nQuote (.+?)'s message: ([\s\S]+)$/u`；命中时正文取第一段，否则整段为正文；正文若整体是贴纸/图片等标记，`text` 保留该标记、`kind` 置对应值。
- `normalizeMessages`：逐条走，时间标记只更新“当前时间”不产出消息；其余用 `splitMessageLabel`；末尾连续 ≥3 条、`kind!=='text'` 且文本完全相同的贴纸行整体丢弃（表情面板浮层）；输出保留 `box`，并带 `at/atConfidence`（时间标记给的 `medium`，否则 `at:''`、`atConfidence:'unknown'`）。

- [ ] **Step 4: 台账补字段**

在 `append` 的 `rec` 对象里加：

```js
quote: raw.quote && typeof raw.quote === 'object'
  ? { author: str(raw.quote.author), text: normalizeText(raw.quote.text) }
  : undefined,
unreadBefore: Number.isFinite(Number(raw.unreadBefore)) ? Math.max(0, Number(raw.unreadBefore)) : undefined,
```

`JSON.stringify` 会丢掉 `undefined`，旧读法无需迁移。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test-transcript.mjs test-ledger.mjs`
Expected: PASS；再跑 `node --test` 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/dsh-wx/lib/transcript.js src/dsh-wx/lib/ledger.js src/dsh-wx/test-transcript.mjs src/dsh-wx/test-ledger.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 解析时间行、引用和贴纸标记"
```

---

### Task 2: 预览发言人排除时间与系统词

**Files:**
- Modify: `src/dsh-wx/lib/speaker.js:18-40`
- Test: `src/dsh-wx/test-speaker.mjs`

**Interfaces:**
- Consumes: 无。
- Produces: `parsePreviewSender(preview) -> {sender: string|null, text: string, confidence: 'medium'|'unknown'}` 行为收紧；签名不变。

- [ ] **Step 1: 写失败测试**

在 `test-speaker.mjs` 加：

```js
parsePreviewSender('计科4223薛长顺: 那里润') // sender '计科4223薛长顺', text '那里润'
parsePreviewSender('14:02 开会')            // sender null, text 原样
parsePreviewSender('Yesterday 16:29 在吗')  // sender null, text 原样
parsePreviewSender('注意：明天记得带伞')     // sender null, text 原样
parsePreviewSender('[Link] 某链接')         // sender null
parsePreviewSender('你撤回了一条消息')       // sender null
parsePreviewSender(': 冒号前为空')           // sender null
parsePreviewSender('一二三四五六七八九十一二三四五六七八九十一二三四五: x') // sender null（>24）
parsePreviewSender('Alice: hi')             // sender 'Alice'
parsePreviewSender('张三：内容')             // sender '张三'
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-speaker.mjs`
Expected: FAIL（时间/`注意`/长前缀仍被当成发言人）

- [ ] **Step 3: 实现排除**

在 `parsePreviewSender` 里，正则命中后加守卫：

```js
const CLOCK = /^\d{1,2}[:：]\d{2}$/
const DAY_WORD = /^(?:Yesterday|Today|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|昨天|今天|周[一二三四五六日天]|星期[一二三四五六日天])$/i
const NOT_NAME = /^(?:注意|提醒|通知|公告|重要|系统|请|大家|各位|友情|温馨|特别|紧急|欢迎)$/u
```

`who` 满足任一条件就返回 `{sender:null, text: raw, confidence:'unknown'}`：
- `CLOCK.test(who)` 或 `DAY_WORD.test(who)`；
- `NOT_NAME.test(who)`；
- 去掉标点后没有汉字/字母（纯数字、纯标点）；
- `[...who].length` 不在 1–24。

保留现有 `SYSTEM_PREFIX` 与 `你/You` 规则。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test-speaker.mjs`
Expected: PASS；再跑全量 `node --test`。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/speaker.js src/dsh-wx/test-speaker.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "fix(dsh-wx): 侧栏预览不再把时间和提示词当发言人"
```

---

### Task 3: 人物名册 `people.json`

**Files:**
- Create: `src/dsh-wx/lib/people.js`
- Create: `src/dsh-wx/test-people.mjs`

**Interfaces:**
- Produces:
  - `DEFAULT_PEOPLE = '/home/str1k3/.dsh-wx/people.json'`
  - `normalizePerson(name) -> string`（去所有空白、ASCII 小写）
  - `splitPersonSuffix(name) -> { name: string, suffix: string }`（`文天聪(w14973)` → `{name:'文天聪',suffix:'w14973'}`）
  - `createPeople({file?:string, now?:()=>number, log?:Function}) -> {learn, resolve, entry, all, reload}`
  - `learn({name, source='preview', chatId=''}) -> entry|null`
  - `resolve(raw) -> {name:string, confidence:'high'|'medium'|'low', matched:boolean}`
  - `entry(raw) -> entry|null`、`all() -> entry[]`、`reload()`

- [ ] **Step 1: 写失败测试**

`test-people.mjs`（临时目录 `mkdtempSync(join(tmpdir(),'people-'))`）：

```js
normalizePerson('计科 4223　薛长顺') === '计科4223薛长顺'
normalizePerson('Tina Yu') === 'tinayu'
splitPersonSuffix('文天聪(w14973)') // { name:'文天聪', suffix:'w14973' }
splitPersonSuffix('普通人')          // { name:'普通人', suffix:'' }

const p = createPeople({ file: join(dir,'people.json'), now: () => 1000 })
p.learn({ name:'计科4223薛长顺', source:'preview', chatId:'c_1' })
p.resolve('计科4223薛长顺').confidence === 'high'
p.resolve('薛长顺')                    // matched=false（不是别名，不能凭包含猜）
p.learn({ name:'薛长顺', source:'quote' })
p.resolve('薛长顺')                    // high → '计科4223薛长顺'（别名）
p.learn({ name:'计科4223薛' })         // 唯一前缀
p.resolve('计科4223薛').confidence === 'medium'
p.learn({ name:'计科4223薛长顺2' })
p.resolve('计科4223薛')                // 前缀撞名 → low, matched=false

// 别名与后缀
p.learn({ name:'文天聪(w14973)' })
p.resolve('文天聪').name === '文天聪'
p.entry('文天聪').aliases 包含 'w14973' 与 '文天聪(w14973)'

// 落盘再读
const p2 = createPeople({ file: join(dir,'people.json') })
p2.resolve('文天聪').name === '文天聪'
// 坏文件按空名册处理，不抛
writeFileSync(join(dir,'bad.json'), '{oops')
createPeople({ file: join(dir,'bad.json') }).all().length === 0
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-people.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现名册**

- 文件格式严格按 spec §5.2：`{version:1, people:[{key, display, aliases, chats, sources, firstSeenAt, lastSeenAt}]}`；原子写（`tmp` + `rename`，0600）；读坏 JSON 记日志并当空名册。
- `learn`：先 `splitPersonSuffix`；主名作为 `display`，`key=normalizePerson(name)`；后缀和原始带后缀写法进 `aliases`；按 `chats`/`sources` 去重追加；`firstSeenAt` 只设一次，`lastSeenAt` 每次更新；返回 entry。
- `resolve`：归一化后与 `display`/`key`/所有别名精确比 → `high`；否则在“至少 3 个字符”的唯一前缀（双向 `startsWith`）→ `medium`；撞名或不足 3 字 → `low`，`name` 返回 `str(raw)`，`matched:false`。
- 名字长度 1–24、不含换行/冒号才 `learn`，否则返回 null（名册不保存垃圾）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test-people.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/people.js src/dsh-wx/test-people.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 人物名册与别名归一"
```

---

### Task 4: 采集配置、服务号过滤、入队与暂停判定

**Files:**
- Create: `src/dsh-wx/lib/capture.js`
- Create: `src/dsh-wx/test-capture.mjs`

**Interfaces:**
- Produces:
  - `DEFAULT_IGNORE_CHATS`（spec §7 的 8 个名字）
  - `captureSettings(raw?: object) -> {ignoreChats:string[], preview:boolean, rotate:boolean, queueMax:number, chatCooldownSec:number, maxScrollPages:number, quietMs:number, ocrEveryMs:number}`
  - `isIgnoredChat(name, ignoreChats) -> boolean`（trim + 压空格 + ASCII 小写后精确比）
  - `previewSig(row:{unread?:number,time?:string,preview?:string}) -> string`
  - `shouldEnqueue({row, sig, prevSig, capturedSinceStart, lastCaptureAt, now, cooldownMs, allowChats, ignoreChats}) -> {enqueue:boolean, reason:string}`
  - `pauseReason({policy, hostBusy, hostActive, sending, pendingHits, treeStatus, stale, login, quietUntil, now}) -> string`（空串=不暂停）

- [ ] **Step 1: 写失败测试**

```js
captureSettings({}).ignoreChats 包含 'Tencent News'
captureSettings({ ignoreChats: [] }).ignoreChats.length === 0   // 显式给就照用
captureSettings({ capture: { queueMax: 0, maxScrollPages: 99 } }).queueMax === 1
captureSettings({ capture: { maxScrollPages: 99 } }).maxScrollPages === 10

isIgnoredChat(' tencent   news ', DEFAULT_IGNORE_CHATS) === true
isIgnoredChat('Tencent News 讨论组', DEFAULT_IGNORE_CHATS) === false

previewSig({ unread:2, time:'14:02', preview:'张三: hi' }) === '2|14:02|张三: hi'

shouldEnqueue({ row:{name:'群A',unread:0,preview:'x',time:'14:02'}, sig:'0|14:02|x', prevSig:'0|14:02|x',
  capturedSinceStart:true, lastCaptureAt:0, now:1000, cooldownMs:60000,
  allowChats:['群A'], ignoreChats:[] }) // {enqueue:false, reason:'unchanged'}
shouldEnqueue({ ...同上, prevSig:'0|13:00|old' }).enqueue === true   // changed
shouldEnqueue({ ...同上, unread:3 }).enqueue === true                // unread
shouldEnqueue({ ...同上, capturedSinceStart:false }).enqueue === true // first
shouldEnqueue({ ...changed, lastCaptureAt:900000 }).enqueue === false // cooldown
shouldEnqueue({ ...changed, row:{draft:true} }).enqueue === false     // draft
shouldEnqueue({ ...changed, allowChats:[] }).enqueue === false        // not-allowed
shouldEnqueue({ ...changed, row:{name:'Tencent News'} }).enqueue === false // ignored

pauseReason({ policy:{enabled:false}, ... }) === 'policy-off'
pauseReason({ policy:{enabled:true,watch:false}, ... }) === 'policy-off'
pauseReason({ treeStatus:'partial' }) === 'tree-partial'
pauseReason({ login:true }) === 'login'
pauseReason({ treeStatus:'ok', stale:true }) === 'stale'
pauseReason({ treeStatus:'ok', hostBusy:true }) === 'host-busy'
pauseReason({ treeStatus:'ok', hostActive:true }) === 'host-active'
pauseReason({ treeStatus:'ok', sending:true }) === 'sending'
pauseReason({ treeStatus:'ok', pendingHits:1 }) === 'pending-hits'
pauseReason({ treeStatus:'ok', quietUntil:2000, now:1000 }) === 'quiet'
pauseReason({ policy:{enabled:true,watch:true}, treeStatus:'ok', now:1000 }) === ''
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-capture.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `lib/capture.js`**

- 默认值与 spec §12 一致；数值 clamp：`queueMax` 1–100、`chatCooldownSec` 0–3600、`maxScrollPages` 0–10、`quietMs` 0–600000、`ocrEveryMs` 0–600000；布尔项只有显式 `false` 才关。
- `shouldEnqueue` 判断顺序：not-allowed → ignored → draft → cooldown → 入队原因（`first` > `unread` > `changed`）；未变化返回 `unchanged`。
- `pauseReason` 判断顺序按 spec §4.3：policy-off → login → tree（非 ok）→ stale → host-busy → host-active → sending → pending-hits → quiet。

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `cd src/dsh-wx && node --test test-capture.mjs`
Expected: PASS

```bash
git add src/dsh-wx/lib/capture.js src/dsh-wx/test-capture.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 采集配置、服务号过滤与暂停判定"
```

---

### Task 5: 预览入账与只读历史查询

**Files:**
- Modify: `src/dsh-wx/lib/context.js`（新增三个函数并导出）
- Create: `src/dsh-wx/test-preview.mjs`

**Interfaces:**
- Consumes: Task 1 的 `parseSidebarTime`/`kindOfLabel`；Task 2 的 `parsePreviewSender`；Task 4 的 `isIgnoredChat`；现有 `ledger.append/searchDocs/window/chats/stats`。
- Produces（挂到 `createContextStore` 返回值上）：
  - `capturePreview({chat, chatId?, preview?, time?, unread?, isDM?, at?, ignoreChats?}) -> {ok, chatId, added, skipped, sender, kind, why?}`
  - `historyForChat({chat, chatId?, query?, hours?, limit?, ignoreChats?}) -> {ok, chatId, text, cards, shown, why?}`
  - `listRecordedChats({limit?, ignoreChats?}) -> {ok, text, chats:[{chat,chatId,count,lastAt}], shown}`

- [ ] **Step 1: 写失败测试**

`test-preview.mjs`，用临时目录建 `createContextStore({dir, now: () => NOW, sanitize})`，`NOW = new Date(2026,10,4,15,0,0).getTime()`：

```js
// 群预览
let r = store.capturePreview({ chat:'群A', preview:'计科4223薛长顺: 那里润', time:'14:02' })
r.added === 1; r.sender === '计科4223薛长顺'
store.capturePreview({ chat:'群A', preview:'计科4223薛长顺: 那里润', time:'14:02' }).added === 0
// 时间前缀不认发言人
store.capturePreview({ chat:'群B', preview:'14:02 开会' }).sender === null
// 贴纸
r = store.capturePreview({ chat:'群A', preview:'张三: [Sticker]', time:'14:03' })
r.kind === 'sticker'
// 单聊
r = store.capturePreview({ chat:'张三', preview:'在吗' })
r.sender === '张三'
// 服务号
store.capturePreview({ chat:'Tencent News', preview:'今日头条', ignoreChats:DEFAULT_IGNORE_CHATS }).added === 0

// 历史
store.capturePreview({ chat:'群A', preview:'张三: 明天九点开会', time:'10:00' })
store.capturePreview({ chat:'群A', preview:'李四: 收到', time:'14:30' })
let h = store.historyForChat({ chat:'群A' })              // 2 张卡
h = store.historyForChat({ chat:'群A', query:'开会' })    // 1 张，正文含“明天九点开会”
h = store.historyForChat({ chat:'群A', hours:2 })         // 只剩 14:30 那条（NOW=15:00）
h = store.historyForChat({ chat:'Tencent News', ignoreChats:DEFAULT_IGNORE_CHATS })
// ok=false, why 含“不记录服务号”

const list = store.listRecordedChats({ ignoreChats:DEFAULT_IGNORE_CHATS })
// chats 不含 Tencent News，含 群A/群B/张三；按 lastAt 倒序
```

另加一条 sanitize 用例：`sanitize = (t) => t.includes('SECRET') ? {text:'[已拦截]',dropped:1} : {text:t,dropped:0}`；`historyForChat({chat:'群A', query:'SECRET'})` 的 `text` 含 `[已拦截]`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-preview.mjs`
Expected: FAIL（`capturePreview is not a function`）

- [ ] **Step 3: 实现**

- `capturePreview`：
  - 先 `isIgnoredChat(chat, ignoreChats)` → `{ok:true, added:0, skipped:0, sender:null, kind:'text', why:'ignored'}`。
  - `parsePreviewSender(preview)` 拿 `sender/text/confidence`；群聊没读出发言人保持 null；单聊用会话名、`high`。
  - `kind = kindOfLabel(text)`；非 `text` 时 `text` 保留原标记（如 `[Sticker]`）。
  - `at` 优先用参数；否则 `parseSidebarTime(time, now())`；再否则 `new Date(now()).toISOString()`，`atConfidence` 分别为 `medium`/`low`。
  - `ledger.append(chatId, [msg], {chatName:chat, source:'preview'})`；返回 `added/skipped/sender/kind/chatId`。
- `historyForChat`：
  - 服务号先拒；`chatId = chatIdOf(chat, explicit)`。
  - `docs = ledger.searchDocs(chatId)`；`hours>0` 时只留 `Date.parse(d.at) >= now()-hours*3600_000`（时间读不出的丢掉）。
  - 无 `query`：按现有顺序取最后 `limit` 条，`reasons:['最近']`；有 `query`：`searchLexical(docs, q, {now:now(), limit:CANDIDATE_MAX})` 后再切 `limit`。
  - `formatCards(rows, {max:limit, sanitize})`；`limit` clamp 1–20；空结果文案“这个会话还没有可查的记录。”/“没有找到相关的上下文。”
- `listRecordedChats`：
  - 遍历 `ledger.chats()`；`stats(chatId)` 取 `count/lastAt`；`ledger.window(chatId,{limit:1})[0]` 取 `chatName`。
  - `isIgnoredChat(name)` 跳过；按 `lastAt` 倒序，切 `limit`（1–50，默认 30）。
  - 文本每行：`- <name>｜<timeText 可简化 ISO>｜<count> 条`；空时“还没有任何会话记录。”

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src/dsh-wx && node --test test-preview.mjs`
Expected: PASS；再跑全量 `node --test`。

- [ ] **Step 5: 提交**

```bash
git add src/dsh-wx/lib/context.js src/dsh-wx/test-preview.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 预览流写入台账与只读历史查询"
```

---

### Task 6: 目录保留非零未读快照

**Files:**
- Modify: `src/dsh-wx/lib/directory.js:55-74`（`blankEntry`）与 `merge` 的 `row.unread` 分支
- Test: `src/dsh-wx/test-directory.mjs`

**Interfaces:**
- Produces: 目录条目新增 `lastNonZeroUnread:number`、`lastNonZeroAt:string`；其余 API 不变。

- [ ] **Step 1: 写失败测试**

```js
const d = createDirectory({ file: join(dir,'directory.json'), now: () => NOW })
d.merge({ chats:[{ name:'群A', unread:3, preview:'张三: hi' }] })
let e = d.entry('群A')
e.unread === 3
e.lastNonZeroUnread === 3
e.lastNonZeroAt 是非空 ISO
d.merge({ chats:[{ name:'群A', unread:0, preview:'张三: hi' }] })
e = d.entry('群A')
e.unread === 0
e.lastNonZeroUnread === 3   // 清掉红点后仍保留
// 老文件没有字段：读出来默认 0/''
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-directory.mjs`
Expected: FAIL（`lastNonZeroUnread` 为 undefined）

- [ ] **Step 3: 实现**

`blankEntry` 加 `lastNonZeroUnread: 0, lastNonZeroAt: ''`。`merge` 的 `if (row.unread !== undefined)` 分支里：

```js
const u = Math.max(0, Number(row.unread) || 0)
e.unread = u
if (u > 0) { e.lastNonZeroUnread = u; e.lastNonZeroAt = at }
```

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `cd src/dsh-wx && node --test test-directory.mjs`
Expected: PASS

```bash
git add src/dsh-wx/lib/directory.js src/dsh-wx/test-directory.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 目录保留最后一次非零未读"
```

---

### Task 7: M1 接线（预览流、解析修复、名册、`wx_history`）

**Files:**
- Modify: `src/dsh-wx/lib/index.js`（`policy()`、`captureCurrent()`、`ear()`、提示词、工具注册）
- Modify: `src/dsh-wx/README.md`（配置与查询说明）

**Interfaces:**
- Consumes: Task 1 `normalizeMessages`；Task 3 `createPeople`；Task 4 `captureSettings`/`DEFAULT_IGNORE_CHATS`/`isIgnoredChat`；Task 5 `capturePreview`/`historyForChat`/`listRecordedChats`。
- Produces: `policy()` 返回新增 `ignoreChats: string[]`、`capture: object`（Task 12 使用）；工具 `wx_history`。

- [ ] **Step 1: `policy()` 读新配置**

成功分支加：

```js
ignoreChats: Array.isArray(raw.ignoreChats)
  ? raw.ignoreChats.map((s) => String(s).trim()).filter(Boolean)
  : DEFAULT_IGNORE_CHATS,
capture: captureSettings({ capture: raw.capture, ignoreChats: raw.ignoreChats }),
```

catch 分支同样给默认值。导入 `captureSettings`、`DEFAULT_IGNORE_CHATS`、`isIgnoredChat`、`normalizeMessages`、`createPeople`。

- [ ] **Step 2: 当前会话全文用 `normalizeMessages`**

在 `apply` 里建 `const people = createPeople({ log: ... })`（默认文件 `~/.dsh-wx/people.json`）。

`captureCurrent` 里把手工 `map` 换成：

```js
const messages = normalizeMessages(s.parsed.messages ?? [], { now: Date.now() })
for (const m of messages) if (m.quote?.author) people.learn({ name:m.quote.author, source:'quote', chatId: directory.idFor(chat) })
```

之后仍调用 `contextStore.capture({...})`，`source` 保持 `'tree'`。时间行不再入账；引用进 `quote`；贴纸/面板按 Task 1 处理。

- [ ] **Step 3: 预览流**

在 `apply` 里：

```js
const lastPreviewSig = new Map()
// 返回本轮每一行的 prevSig/sig，供 Task 12 在更新快照前做入队判断。
function recordPreviews(parsed) {
  const p = policy()
  let added = 0
  const rows = []
  for (const row of parsed?.chats ?? []) {
    const chat = String(row?.name ?? '').trim()
    if (!chat) continue
    const sig = previewSig(row)
    const prevSig = lastPreviewSig.get(chat) ?? ''
    rows.push({ chat, row, sig, prevSig })
    if (row.draft) continue
    if (isIgnoredChat(chat, p.ignoreChats)) continue
    const preview = String(row.preview ?? '')
    if (!preview || prevSig === sig) continue
    const entry = directory.entry(chat)
    const r = contextStore.capturePreview({
      chat,
      chatId: entry?.chatId ?? '',
      preview,
      time: String(row.time ?? ''),
      unread: Number(row.unread) || 0,
      isDM: entry?.kind === 'dm' ? true : null,
      ignoreChats: p.ignoreChats,
    })
    if (r.ok) {
      added += r.added
      if (r.sender) people.learn({ name: r.sender, source: entry?.kind === 'dm' ? 'dm' : 'preview', chatId: r.chatId })
    }
    lastPreviewSig.set(chat, sig)
  }
  if (added > 0) console.log('[dsh-wx] 采集：预览 +' + added)
  return { added, rows }
}
```

在 `ear()` 的登录判断和 `if (!tree.ok && !ocrRecovered) return` 之后、目录扫描之前，**只有树健康时**调用 `recordPreviews(parsed)`：

```js
if (tree.ok && !ocrRecovered) recordPreviews(parsed)
```

（M2 的 Task 12 会把它改成 `roundPreview = recordPreviews(parsed)` 以复用本轮快照做入队判断。）

spec §9 要求树 `partial`/`down`/`login` 时预览流也停（没有可信数据）；OCR 回退只在 @ 识别上用，不拿它写预览台账。预览流不点开、不滚动。

- [ ] **Step 4: 注册 `wx_history` 并写提示词**

- `reg({ name:'wx_history', description:'只读查询微信台账：不传 chat 列出有记录的非服务会话；传 chat 按会话名查最近记录，可选 query 关键词和 hours 时间窗。最多 20 条，带发言人、时间、来源和置信度。不建任务、不写事件流。', parameters:{ chat?, query?, hours?, limit? }, output:textOut, isConcurrencySafe:()=>true, execute })`。
- `execute`：`deny(exec)`；不检查 `policy().enabled`（纯读）；`const ignoreChats = policy().ignoreChats`；无 `chat` 调 `listRecordedChats`，有 `chat` 调 `historyForChat`；`!ok` 时 `throw new Error(r.why)`；返回 `r.text`。
- 提示词 `promptText()` 加一条 `wx_history`，并把“14 个工具”改成实际数量（新增后为 15；如贴纸阶段已使数量不符，以实际注册数为准）。

- [ ] **Step 5: README 记录**

在 `src/dsh-wx/README.md` 增加：`policy.json` 的 `ignoreChats`/`capture` 默认值、`wx_history` 的用法、预览流不点开/不清未读的边界。

- [ ] **Step 6: 跑全量测试**

Run: `cd src/dsh-wx && node --test`
Expected: 全部 PASS。

- [ ] **Step 7: M1 手工验收**

- 重启宿主：`sudo -n /usr/local/sbin/fish-ctl restart dsh-web.service`（若该脚本不可用，记录为待用户执行，不换方式绕审批）。
- 等 15 秒，检查 `~/.dsh-wx/ledger/` 当天文件出现 `"source":"preview"`，且 `Tencent News`/`File Transfer` 没有新增记录。
- 用只读 Node 调用核对（不启动微信）：
  `node --input-type=module -e "import {createContextStore} from './lib/context.js'; const s=createContextStore({}); console.log(s.listRecordedChats({}).text)"`
- 结果写进 `docs/superpowers/plans/` 对应的 progress/ledger 记录；未通过 `wx_history` 工具由模型实际调用这一点，要如实标为未验证。

- [ ] **Step 8: 提交**

```bash
git add src/dsh-wx/lib/index.js src/dsh-wx/README.md
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 预览流入账、人物名册接线与 wx_history"
```

---

### Task 8: OCR 发言人命令行 `wx.sh speakers`

**Files:**
- Create: `src/dsh-wx/lib/ocr-speakers.mjs`
- Modify: `src/dsh-wx/lib/wx.sh`（`ocr)` 之后加 `speakers)`）
- Create: `src/dsh-wx/test-ocr-speakers.mjs`

**Interfaces:**
- Produces:
  - `parseSpeakerTsv(tsv, {scale?:number, origin?:{x:number,y:number}, minConfidence?:number}) -> {lines:[{text,x,y,w,h,conf}]}`，坐标是屏幕绝对坐标。
  - CLI `node lib/ocr-speakers.mjs` 输出 `{ok:true, window:{x,y,w,h}, crop:{x,y,w,h}, scale:3, lines:[...]}`；失败输出 `{ok:false, why}` 并以非零退出。

- [ ] **Step 1: 写失败测试**

fixture TSV（两行，`scale:3`，`origin:{x:100,y:50}`）：

```js
const tsv = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t60\t30\t180\t24\t82.0\t计科',
  '5\t1\t1\t1\t1\t2\t250\t30\t180\t24\t80.0\t4223',
  '5\t1\t1\t1\t1\t3\t440\t30\t240\t24\t78.0\t薛长顺',
  '5\t1\t1\t2\t1\t1\t60\t120\t240\t24\t90.0\t那里润',
].join('\n')
const r = parseSpeakerTsv(tsv, { scale:3, origin:{x:100,y:50} })
r.lines.length === 2
r.lines[0].text === '计科4223薛长顺'      // 汉字/数字之间 OCR 空格压掉
r.lines[0].x === 120                      // 100 + 60/3
r.lines[0].y === 60                       // 50 + 30/3
r.lines[1].text === '那里润'
parseSpeakerTsv(tsv, { scale:3, origin:{x:100,y:50}, minConfidence:85 }).lines.length === 1
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-ocr-speakers.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现纯函数**

参照 `lib/ocr-snapshot.mjs` 的 `parseTsv` 分组逻辑（按 `block/par/line` 聚合，单词排序拼接，CJK 间空格用正则压掉）；把 `left/scale + origin.x`、`top/scale + origin.y` 作为输出坐标；`conf` 取行内平均；低于 `minConfidence`（默认 30）丢弃。

- [ ] **Step 4: 实现 CLI**

- `xdotool search --name 'Weixin'` 取面积最大的窗口；`getwindowgeometry --shell` 拿 `X/Y/WIDTH/HEIGHT`。
- 截图 `import -window <id>` 到 `mkdtempSync` 临时目录。
- 裁剪 spec 的区域：左 `0.34*W`、上 `0.07*H`、宽 `0.66*W`、高 `0.70*H`；`convert` 放大 300%。
- `tesseract <crop.png> stdout -l chi_sim+eng --psm 6 tsv`。
- `parseSpeakerTsv(tsv, {scale:3, origin:{x:X+cropX, y:Y+cropY}})`。
- `finally` 里删自己的临时目录（`rmSync(dir,{recursive:true,force:true})`）。
- 任何一步失败都输出 `{ok:false,why}` 并非零退出；不抛栈给 `wx.sh`。

- [ ] **Step 5: `wx.sh` 接入**

在 `ocr)` 分支后加：

```bash
speakers)
  node "$LIB_DIR/ocr-speakers.mjs" 2>&1 | head -c 200000
  ;;
```

- [ ] **Step 6: 跑测试并提交**

Run: `cd src/dsh-wx && node --test test-ocr-speakers.mjs`
Expected: PASS

```bash
git add src/dsh-wx/lib/ocr-speakers.mjs src/dsh-wx/lib/wx.sh src/dsh-wx/test-ocr-speakers.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): OCR 发言人命令行 speakers"
```

---

### Task 9: 发言人几何对齐 `alignSpeakers`

**Files:**
- Create: `src/dsh-wx/lib/speaker-align.js`
- Create: `src/dsh-wx/test-speaker-align.mjs`

**Interfaces:**
- Consumes: Task 3 的 `resolve`（只要求 `{resolve(raw) -> {name, matched}}` 形状）；Task 1 的 `isTimeMarker`/`kindOfLabel`。
- Produces:
  - `alignSpeakers(messages, lines, {roster?, pane?}) -> Array<{sender:string|null, senderConfidence:'medium'|'low'|'unknown', direction:'in'|'out'}>`，与 `messages` 等长同序。
    - `messages: [{text, box:{x,y,w,h}}]`，**屏幕绝对坐标**（`parseTree`/`wx-elements.mjs` 输出的就是屏幕坐标；spec 里的 scale 换算已经在那一层做完，这里不再乘）。
    - `lines: [{text,x,y,w,h,conf}]`，屏幕绝对坐标。
    - `pane?: {left,right}`（屏幕坐标）；不给就从消息框推导。
  - `planSpeakerRepairs(aligned, docs) -> Array<{msgId:string, sender:string, senderConfidence:string}>`
    - `aligned` 是 `alignSpeakers` 的返回（与 `messages` 同序），`docs` 是台账最近记录；只给 `sender` 非空且台账里 `sender` 为 null 的同文记录生成 repair，不覆盖已有发言人。

- [ ] **Step 1: 写失败测试**

```js
const roster = { resolve: (raw) => raw === '计科 4223 薛长顺'
  ? { name:'计科4223薛长顺', matched:true }
  : { name: raw, matched:false } }

// 名字行在气泡上方
alignSpeakers(
  [{ text:'那里润', box:{x:100,y:100,w:600,h:80} }],
  [{ text:'计科 4223 薛长顺', x:120, y:105, w:200, h:14, conf:82 }],
  { roster },
)[0] // { sender:'计科4223薛长顺', senderConfidence:'medium', direction:'in' }

// 没有名册：保留原文、low
alignSpeakers([{ text:'那里润', box:{x:100,y:100,w:600,h:80} }],
  [{ text:'某 人', x:120, y:105, w:60, h:14, conf:82 }], {})[0]
// { sender:'某 人', senderConfidence:'low', direction:'in' }

// 右侧对齐、无名字行 → out
alignSpeakers([{ text:'我自己说的', box:{x:100,y:100,w:600,h:80} }],
  [{ text:'我自己说的', x:650, y:130, w:100, h:16, conf:90 }],
  { pane:{left:100,right:800} })[0]
// { sender:null, senderConfidence:'unknown', direction:'out' }

// 文字行在左侧、无名字 → in/unknown
alignSpeakers([{ text:'别人说的', box:{x:100,y:100,w:600,h:80} }],
  [{ text:'别人说的', x:140, y:130, w:100, h:16, conf:90 }],
  { pane:{left:100,right:800} })[0].direction === 'in'

// 时间行/贴纸行不能当名字
alignSpeakers([{ text:'正文', box:{x:100,y:100,w:600,h:80} }],
  [{ text:'14:02', x:120, y:105, w:50, h:14, conf:90 },
   { text:'Animated Stickers', x:120, y:120, w:150, h:14, conf:90 }],
  {})[0].sender === null

// 气泡文字落在名字带里，不能被当成人名
alignSpeakers([{ text:'很短', box:{x:100,y:100,w:600,h:40} }],
  [{ text:'很短', x:120, y:105, w:40, h:16, conf:90 }],
  { pane:{left:100,right:800} })[0].sender === null

// 坐标不二次缩放：box.y=100 就是屏幕 100，名字行 y=105 命中
alignSpeakers([{ text:'正文', box:{x:100,y:100,w:600,h:80} }],
  [{ text:'张三', x:125, y:105, w:40, h:14, conf:80 }],
  { roster:{resolve:(r)=>({name:r,matched:true})} })[0].sender === '张三'

// 只补空位：台账已有发言人的不覆盖
planSpeakerRepairs(
  [{ text:'你好', sender:'张三', senderConfidence:'medium' },
   { text:'收到', sender:'李四', senderConfidence:'low' },
   { text:'已经有人', sender:'王五', senderConfidence:'medium' }],
  [{ msgId:'m1', text:'你好', sender:null },
   { msgId:'m2', text:'收到', sender:null },
   { msgId:'m3', text:'已经有人', sender:'赵六' }],
) // → [{ msgId:'m1', sender:'张三', senderConfidence:'medium' },
  //    { msgId:'m2', sender:'李四', senderConfidence:'low' }]（没有 m3）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-speaker-align.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

- 消息框的 `box.x/y/w/h` 已经是屏幕绝对坐标（`wx-elements.mjs` 里乘过 `screenScale()`，`wx_click` 也直接拿它点），**这里不再乘任何缩放**，与 OCR 行同坐标系比较。
- 名字带：`[top-2, top + height*0.45]`；候选条件：`conf>=50`、文本 1–24 字符、`plausibleName`、且与消息正文不相等（归一化后比较，正文长度 ≥4 时允许互不包含）。
- `plausibleName`：含汉字/字母；不含 `:：。，,、!！?？`；不是 `isTimeMarker`；`kindOfLabel(text)==='text'`；不是 `Animated Stickers` 等系统标记。
- 候选按 `|lineCenterY - top|` 最小取一个（并列取 `conf` 高者）。
- 命中名字：有名册且 `resolve.matched` → `{name: resolved.name, confidence:'medium'}`；否则 `{name: line.text（压空格）, confidence:'low'}`；`direction:'in'`。
- 没命中名字：找与正文匹配（归一化相等或短串 ≥4 字前缀）且 `conf>=50` 的行，若其中心 x 在 `(pane.left+pane.right)/2` 右侧 → `direction:'out'`；否则 `in`；两者 `sender:null`、`unknown`。
- 名字归一化：只压空白（供名册匹配），保留原文用于 low。
- `planSpeakerRepairs`：按 `text` 建 doc 索引（同一文本取背包里的最后一条未识别记录），只对 `aligned.sender` 非空且 `doc.sender` 为 null 的生成；返回 `{msgId, sender, senderConfidence}`，不给同一 `msgId` 生成两条。

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `cd src/dsh-wx && node --test test-speaker-align.mjs`
Expected: PASS

```bash
git add src/dsh-wx/lib/speaker-align.js src/dsh-wx/test-speaker-align.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): OCR 名字行与消息气泡几何对齐"
```

---

### Task 10: 采集队列（冷却、上限、退避）

**Files:**
- Create: `src/dsh-wx/lib/capture-queue.js`
- Create: `src/dsh-wx/test-capture-queue.mjs`

**Interfaces:**
- Produces: `createCaptureQueue({now?:()=>number, queueMax?:number, cooldownMs?:number}) -> {offer, due, done, fail, size, jobs, lastDoneAt, clear}`
  - `offer({chat, reason?, unread?, dueAt?}) -> boolean`
  - `due(at?:number) -> {chat, reason, unread, dueAt, tries} | null`
  - `done(chat) -> void`
  - `fail(chat, {backoffMs?}) -> void`
  - `lastDoneAt(chat) -> number`（无记录返回 0；`fail` 后返回“可重试时间”）

- [ ] **Step 1: 写失败测试**

```js
let t = 1000
const q = createCaptureQueue({ now: () => t, queueMax: 2, cooldownMs: 60_000 })

q.offer({ chat:'A', reason:'changed' }) === true
q.due(t).chat === 'A'
q.offer({ chat:'A', reason:'unread', unread:2 }) === false   // 同一会话不重复入队
q.size() === 1
q.jobs()[0].reason === 'unread' && q.jobs()[0].unread === 2

q.done('A')                       // 删除 job，lastDoneAt('A')=1000
q.lastDoneAt('A') === 1000
q.offer({ chat:'A' }) === true    // 冷却期内的更新不丢，排到冷却结束
q.due(t + 59_000) === null
q.due(t + 60_000).chat === 'A'
q.done('A')

q.offer({ chat:'B' }); q.offer({ chat:'C' }); q.offer({ chat:'D' })
q.size() === 2                    // queueMax=2，丢最早入队的 B
q.jobs().map((j) => j.chat).join(',') === 'C,D'

t = 200_000
q.done('D')
q.fail('C', { backoffMs: 120_000 })
q.lastDoneAt('C') === 320_000
q.offer({ chat:'C' })
q.due(200_001) === null           // 退避期内不取
q.due(320_000).chat === 'C'
```

`due` 不消费；调用方必须 `done`/`fail`。`jobs()` 返回按入队顺序的副本。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-capture-queue.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

- 内部 `Map<chat, job>` + 插入顺序数组；`offer` 同一会话只更新 `reason/unread` 与 `dueAt=min(旧, 新)`。
- 冷却：`dueAt = max(dueAt, lastDoneAt(chat) + cooldownMs)`；不拒绝，避免冷却期内的新消息丢失。
- 超过 `queueMax` 时删最早插入的 job。
- `done` 删除 job，`lastDone[chat]=now()`；`fail` 删除 job，`lastDone[chat]=now()+backoffMs`（默认 120000）。
- `due(at)` 返回插入顺序中第一个 `dueAt <= at` 的 job 副本（不删除）。

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `cd src/dsh-wx && node --test test-capture-queue.mjs`
Expected: PASS

```bash
git add src/dsh-wx/lib/capture-queue.js src/dsh-wx/test-capture-queue.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 后台采集队列与退避"
```

---

### Task 11: 单次采集编排 `runCapture`

**Files:**
- Create: `src/dsh-wx/lib/capture-run.js`
- Create: `src/dsh-wx/test-capture-run.mjs`

**Interfaces:**
- Consumes: Task 1 `normalizeMessages`；Task 9 `alignSpeakers`；Task 5 `contextStore.capture`/`ledger.window`；现有 `samePreviewText`/`sameName`/`chatIdFor`。
- Produces: `runCapture({job, io, contextStore, directory?, people?, settings?, policy?, now?, log?}) -> Promise<{ok, chat, added, skipped, why?, scrolled?, restored?, records?, ocrSenders?}>`
  - `settings` 默认 `{maxScrollPages:3}`；`policy` 默认 `{trigger:[]}`。
  - `ocrSenders` 是本次 OCR 对齐里识别出的名字数组，供调用方写入人物名册。

  - `job: {chat, chatId?, reason?, unread?}`
  - `io` 必须提供：`read() -> snapshot`、`open(chat, before) -> snapshot|null`、`scrollUp(parsed) -> snapshot|null`、`scrollDown(parsed, times) -> void`、`ocrSpeakers() -> {lines}`、`restore(chat) -> boolean`、`onMention(hit) -> void`；可选 `outboxFor(chat) -> array`。
  - snapshot 形状：`{parsed:{ok, current, chats, messages, window}, source?}`。

- [ ] **Step 1: 写失败测试**

`test-capture-run.mjs` 用真实 `createContextStore({dir:tmp})` + 假 `io`：

```js
// 1) 已经是当前会话：不点开、不恢复
io.read → { parsed:{ ok:true, current:'群A', chats:[], messages:[{text:'你好', box:{x:100,y:100,w:600,h:60}}], window:{scale:1} } }
runCapture(...) → { ok:true, added:1 }
io.open 未被调用；io.restore 未被调用
台账 recent(chatId,1)[0].text === '你好'

// 2) 别的会话 + 首次接触：点开、回滚、恢复
read → current:'群B'
open → 群A 快照，messages 第 1 屏 ['最近一条']
scrollUp 第 1 次 → ['较早一条','最近一条']；第 2 次 → ['更早一条','较早一条','最近一条']
runCapture(... settings:{maxScrollPages:3}) → scrolled===2, restored===true
台账顺序为 ['更早一条','较早一条','最近一条']

// 3) 点不开：ok=false, why='open-failed'，不写台账
// 4) OCR 抛错：仍入账，sender 为 null
// 5) OCR 命中：io.ocrSpeakers 返回 [{text:'张三',x:120,y:105,w:40,h:14,conf:90}]，
//    消息 box 与名字带对得上 → 台账 sender==='张三'，senderConfidence==='medium'（roster 命中）；
//    返回值 ocrSenders 含 '张三'
// 6) 正文含 trigger：io.onMention 被调用一次，hit.chat/ hit.preview 正确
// 7) 回滚后调用 io.scrollDown(parsed, 2)
// 8) 恢复失败（restore 返回 false）：ok 仍 true，日志含“恢复”
// 9) 与台账末尾重叠：不 scrollUp
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src/dsh-wx && node --test test-capture-run.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

1. `before = await io.read()`；`!before?.parsed?.ok || before.source==='ocr'` → `{ok:false, why:'tree-not-ok'}`。
2. `prev = before.parsed.current`；同会话直接用 `before`，否则 `opened = await io.open(job.chat, before)`；失败 → `{ok:false, why:'open-failed'}`，不写台账。
3. `initial = normalizeMessages(opened.parsed.messages, {now:now()})`；`chatId = job.chatId || directory?.idFor?.(job.chat) || chatIdFor(job.chat)`。
4. OCR：`try { ocr = await io.ocrSpeakers() } catch { ocr = null }`；有 OCR 时 `aligned = alignSpeakers(initial, ocr.lines, {roster: people})`，把 `sender/senderConfidence/direction` 合并进对应消息；`ocrSenders = [...new Set(aligned.map(a => a.sender).filter(Boolean))]`；OCR 失败不影响入账（`ocrSenders=[]`）。
5. 断档回滚：`lastDoc = contextStore.ledger.window(chatId,{limit:1})[0]`；`hasOverlap(msgs) = lastDoc && msgs.some(m => samePreviewText(lastDoc.text, m.text))`；当前屏已有重叠就不滚；否则最多 `settings.maxScrollPages`（默认 3）次 `io.scrollUp`，每次 `normalizeMessages`，**按文本序列去重合并**（旧屏在前），出现重叠或屏没变化就停。
6. 回滚过就 `await io.scrollDown(opened.parsed, scrolled)`；失败只记日志。
7. `const row = (opened.parsed.chats ?? []).find((c) => sameName(c.name, job.chat)) ?? null`；每条消息带 `unreadBefore: Math.max(0, Number(job.unread)||0)`；调用 `contextStore.capture({chat, chatId, messages: merged, source:'capture', preview: row?.preview ?? '', isDM: directory?.entry?.(job.chat)?.kind === 'dm' ? true : null, outbox: io.outboxFor?.(job.chat) ?? []})`。
8. 扫描 `captured.records` 的 `text`，命中 `policy.trigger` 任一词就 `await io.onMention({chat, chatId, preview: record.text, msgId: record.msgId, key:'capture:'+record.msgId, why:'@'})`。
9. `prev && !sameName(prev, job.chat)` 时 `await io.restore(prev)`；false 只 `log('恢复原会话失败：'+prev)`，不重试。
10. 返回 `{ok:captured.ok, chat, added:captured.added, skipped:captured.skipped, scrolled, restored, records:captured.records, ocrSenders}`；任何异常 catch 成 `{ok:false, chat, why:...}`。

去重合并算法（测试锁定）：相邻两屏找最长 `k`，使旧屏末尾 `k` 条与新屏开头 `k` 条 `kind+text` 相同，只追加新屏 `slice(k)`。

- [ ] **Step 4: 跑测试确认通过并提交**

Run: `cd src/dsh-wx && node --test test-capture-run.mjs`
Expected: PASS

```bash
git add src/dsh-wx/lib/capture-run.js src/dsh-wx/test-capture-run.mjs
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 后台单次采集编排（点开/回滚/OCR/恢复）"
```

---

### Task 12: M2 接线（轮转工作者、暂停、健康、@ 补扫）

**Files:**
- Modify: `src/dsh-wx/lib/index.js`（导入、`withSendLock`、`ear()`、`writeHealth()`、`sendToChat`/投递）

**Interfaces:**
- Consumes: Task 4 `pauseReason`/`shouldEnqueue`/`previewSig`；Task 10 `createCaptureQueue`；Task 11 `runCapture`；Task 8 `wx.sh speakers`；Task 6 目录未读快照。
- Produces: `health.json` 的 `capture` 块；`~/.dsh-wx/people.json` 的 OCR/预览学习；采集暂停日志。

- [ ] **Step 1: 导入与发送/投递活跃度**

在 `lib/index.js` 顶部导入：`pauseReason, shouldEnqueue, previewSig`（`./capture.js`）、`createCaptureQueue`（`./capture-queue.js`）、`runCapture`（`./capture-run.js`）、`alignSpeakers, planSpeakerRepairs`（`./speaker-align.js`）。

`withSendLock` 外加计数：

`withSendLock` 外加计数：

```js
let sendBusy = 0
function withSendLock(fn) {
  sendBusy += 1
  const p = sendLock.then(fn, fn)
  sendLock = p.then(() => {}, () => {})
  return p.finally(() => { sendBusy -= 1 })
}
```

发送结束的静默：在 `sendToChat` 成功返回前，以及 `ear()` 每成功投递一个会话后，设 `quietUntil = Math.max(quietUntil, Date.now() + p.capture.quietMs)`。`pauseReason` 只看 `quietUntil`。

- [ ] **Step 2: 采集工作者状态**

在 `apply` 里加：

```js
let captureQueue = null        // 用 policy 首次创建；queueMax/cooldown 取当时配置
let lastCaptureAttemptAt = 0
let quietUntil = 0
let lastCurrentOcrAt = 0
let lastCurrentCapture = null  // captureCurrent 存下的 {chat, chatId, messages}
let roundPreview = null        // 本轮 recordPreviews 的返回值，供 captureTick 入队
const pendingCaptureHits = []  // 采集补扫到的 @，等下一轮投递
const capturedSinceStart = new Set()
let captureHealth = { paused:false, pauseReason:'', queued:0, lastAt:'', lastChat:'', lastResult:'', lastError:'' }
let lastPauseLog = { reason:'', at:0 }

function ensureCaptureQueue(p) {
  if (!captureQueue) {
    captureQueue = createCaptureQueue({
      queueMax: p.capture.queueMax,
      cooldownMs: p.capture.chatCooldownSec * 1000,
    })
  }
  return captureQueue
}
```

`captureCurrent` 把 `contextStore.capture(...)` 的返回（含 `chatId`）和归一化后的 `messages` 存进 `lastCurrentCapture = {chat, chatId, messages}`。`writeHealth()` 的 JSON 加 `capture: captureHealth`。

- [ ] **Step 3: 预览流后入队**

`ear()` 里 `const roundPreview = recordPreviews(parsed)`，把返回值存到函数级 `let roundPreview = null`（`finally` 的 `captureTick` 要用）。`captureTick` 在暂停判断**之前**先入队，这样暂停期间新消息也会排队，等空闲再采：

```js
ensureCaptureQueue(p)
for (const { chat, row, sig, prevSig } of roundPreview?.rows ?? []) {
  const name = canonicalName(chat) || chat
  const r = shouldEnqueue({
    row, sig, prevSig,
    allowChats: p.allowChats, ignoreChats: p.ignoreChats,
    capturedSinceStart: capturedSinceStart.has(name),
    lastCaptureAt: captureQueue.lastDoneAt(name),
    now: Date.now(), cooldownMs: p.capture.chatCooldownSec * 1000,
  })
  if (r.enqueue) captureQueue.offer({ chat: name, reason: r.reason, unread: row.unread })
}
roundPreview = null
```

`recordPreviews` 返回的 `prevSig` 是**更新快照前**的值，所以这里不需要回读 `lastPreviewSig`。

启动后第一轮 `capturedSinceStart` 为空，所有 `allowChats` 都会入队；`captureTick` 的 `lastCaptureAttemptAt < 5000` 保证每轮最多采一个，自然错开，不会连点。

- [ ] **Step 4: 采集 tick**

`ear()` 现在有很多 `return`；用 `finally` 统一跑采集，才能保证“这一轮该停就停、不该停就采一次”。在 `ear()` 顶部加 `let roundParsed = null; let heldHits = 0`，在通过登录/tree 检查后设 `roundParsed = parsed`；投递循环后设 `heldHits = hits.length - sentChats.length`；`finally` 里：

```js
} finally {
  try {
    await captureTick({ parsed: roundParsed, p, pendingHits: pendingCaptureHits.length + heldHits })
  } catch (err) {
    console.log('[dsh-wx] 采集：本轮出错（' + String(err?.message ?? err).slice(0, 120) + '）')
  }
  busy = false
}
```

```js
async function captureTick({ parsed, p, pendingHits }) {
  if (!p.capture.rotate) return
  ensureCaptureQueue(p)
  if (Date.now() - lastCaptureAttemptAt < 5000) return
  const reason = pauseReason({
    policy: p,
    hostBusy: hostBusy(),
    hostActive: !!hostState?.active && Date.now() - hostState.at < HOST_BUSY_MS,
    sending: sendBusy > 0,
    pendingHits,
    treeStatus: treeLast?.status ?? 'down',
    stale: !!fresh.stale,
    login: treeLast?.status === 'login',
    quietUntil,
    now: Date.now(),
  })
  captureHealth = { ...captureHealth, paused: !!reason, pauseReason: reason, queued: captureQueue.size() }
  if (reason) {
    if (lastPauseLog.reason !== reason || Date.now() - lastPauseLog.at > 30_000) {
      lastPauseLog = { reason, at: Date.now() }
      console.log('[dsh-wx] 采集：暂停（' + reason + '）')
    }
    writeHealth()
    return
  }
  const job = captureQueue.due(Date.now())
  if (!job) { writeHealth(); return }
  lastCaptureAttemptAt = Date.now()
  const settings = p.capture
  const io = makeCaptureIo()
  try {
    const r = await withGuiLock(() => runCapture({job, io, contextStore, directory, people, settings, policy:p, log: ...}))
    if (r.ok) {
      for (const name of r.ocrSenders ?? []) people.learn({ name, source:'ocr', chatId:job.chatId })
      captureQueue.done(job.chat)
      capturedSinceStart.add(job.chat)
      quietUntil = Date.now() + settings.quietMs
      captureHealth = { ...captureHealth, lastAt:new Date().toISOString(), lastChat:job.chat, lastResult:`added:${r.added} skipped:${r.skipped}`, lastError:'' }
      if (r.added > 0) console.log(`[dsh-wx] 采集：${job.chat} +${r.added}（回滚 ${r.scrolled} 屏）`)
    } else {
      captureQueue.fail(job.chat)
      captureHealth = { ...captureHealth, lastError:r.why ?? 'failed' }
      console.log('[dsh-wx] 采集：' + job.chat + ' 失败（' + (r.why ?? '') + '）')
    }
  } catch (err) {
    captureQueue.fail(job.chat)
    captureHealth = { ...captureHealth, lastError:String(err?.message ?? err).slice(0, 160) }
  }
  writeHealth()
}
```

`parsed` 只用于日志/诊断；`captureTick` 自己不信任它，`runCapture` 的 `io.read()` 会重新取快照。

- [ ] **Step 5: `makeCaptureIo()`**

```js
const makeCaptureIo = () => ({
  read: () => look({ confirm:false }),
  open: async (chat, before) => { /* 下面 */ },
  scrollUp: async (parsed) => { /* 下面 */ },
  scrollDown: async (parsed, times) => { /* 下面 */ },
  ocrSpeakers: async () => { const d = JSON.parse(await run(['speakers'], 90_000)); if (!d.ok) throw new Error(d.why || 'speakers 失败'); return d },
  restore: async (chat) => { /* 下面 */ },
  onMention: (hit) => { saveMentions(grant(readMentions(), hit.chat, Date.now())); pendingCaptureHits.push(hit); logInbound({type:'capture-mention', chat:hit.chat, msgId:hit.msgId}) },
  outboxFor: (chat) => outboxFor(chat),
})
```

- `open(chat, before)`：从 `before.parsed.chats` 找行（`sameName` 或 `canonicalName`）；找不到返回 null。`run(['clean'])`、`fresh.reset()`、`run(['click', String(box.cx), String(box.cy)])`（`parseTree` 的 box 已经是屏幕绝对坐标，`wx_click` 也直接这么用）、`sleep(700)`、`look({confirm:false})`；`sameName(current, chat)` 则返回快照；否则重试一次同样的点击+核对，仍不对返回 null。
- `restore(chat)`：`look({confirm:false})` 找行，点一次，`sleep(700)`，`look({confirm:false})`，返回是否对上；不重试。
- `scrollUp(parsed)`：锚点取最后一条消息 `box` 的屏幕中心（`box.cx, box.cy`），没有消息就取 `window.ox + w*0.6, window.oy + h*0.55`；`run(['scroll', x, y, 'up', '5'])`、`sleep(600)`、`look({confirm:false})`。
- `scrollDown(parsed, times)`：同一锚点，`['scroll', x, y, 'down', String(times)]`、`sleep(600)`。
- 坐标只取整，不再乘 `window.scale`（`wx-elements.mjs` 已经乘过）。

- [ ] **Step 6: 当前会话 OCR 补发言人（最多每 `ocrEveryMs` 一次）**

`captureCurrent` 存下的 `lastCurrentCapture = {chat, chatId, messages}` 供这里用。在 `ear()` 里通过 `if (!tree.ok && !ocrRecovered) return` 之后、目录扫描之前调用：

```js
async function maybeOcrCurrent(p) {
  const cap = lastCurrentCapture
  if (!cap || !cap.messages?.length) return
  if (Date.now() - lastCurrentOcrAt < p.capture.ocrEveryMs) return
  if ((treeLast?.status ?? 'down') !== 'ok') return
  lastCurrentOcrAt = Date.now()
  try {
    const d = JSON.parse(await run(['speakers'], 90_000))
    if (!d.ok) return
    const aligned = alignSpeakers(cap.messages, d.lines, { roster: people })
    for (const name of new Set(aligned.map((a) => a.sender).filter(Boolean))) {
      people.learn({ name, source:'ocr', chatId:cap.chatId })
    }
    const docs = contextStore.ledger.recent(cap.chatId, 30)
    for (const fix of planSpeakerRepairs(aligned, docs)) {
      contextStore.ledger.repair(cap.chatId, { ...fix, why: 'OCR 补发言人' })
    }
  } catch (err) {
    console.log('[dsh-wx] 采集：当前会话 OCR 失败（' + String(err?.message ?? err).slice(0, 120) + '）')
  }
}
```

只调 `repair`（追加），不改已有记录；OCR 失败/超时只记日志，不阻塞本轮。`lastCurrentOcrAt` 在真正尝试前就更新，失败也不会每 5 秒重跑。

- [ ] **Step 7: 采集到的 @ 参与下一轮投递**

在 `ear()` 计算 `mentionsRaw` 后合并 `pendingCaptureHits`（按 `key` 去重），合并后的 `mentions` 仍走现有 `grant`/`sig`/投递逻辑：

```js
const baseMentions = ocrRecovered
  ? ocrMentionHits(parsed)
  : mentionHits(parsed, trigger, p.noMentionChats, p.allowChats)
const merged = new Map()
for (const m of [...baseMentions, ...pendingCaptureHits]) merged.set(m.key, m)
const mentionsRaw = [...merged.values()]
```

投递循环结束后：

```js
for (let i = pendingCaptureHits.length - 1; i >= 0; i--) {
  if (seen.has(pendingCaptureHits[i].key)) pendingCaptureHits.splice(i, 1)
}
```

保留未投递的（例如 `hostBusy` 压着），避免采集清掉未读后 @ 丢失；数组上限 20，超出丢最旧。

- [ ] **Step 8: 全量测试**

Run: `cd src/dsh-wx && node --test`
Expected: 全部 PASS（Task 8–11 的纯函数测试覆盖新增逻辑；`index.js` 只做接线，不写真实 UI 测试）。

- [ ] **Step 9: 提交**

```bash
git add src/dsh-wx/lib/index.js
git diff --cached --check && python scripts/audit-staged.py
git commit -m "feat(dsh-wx): 后台轮转采集与 OCR 发言人接线"
```

---

### Task 13: M2 真机验收与文档

**Files:**
- Modify: `src/dsh-wx/README.md`
- Modify: `docs/superpowers/plans/2026-11-04-wechat-background-capture.md`（勾选与记录，若执行器按本文件跟踪）

**Interfaces:**
- Consumes: Task 12 的 `health.json.capture`、日志前缀 `[dsh-wx] 采集：`、`people.json`、目录 `lastNonZeroUnread`。

- [x] **Step 1: 重启并观察启动**

```bash
sudo -n /usr/local/sbin/fish-ctl restart dsh-web.service
sleep 20
jq '.capture' ~/.dsh-wx/health.json
```

Expected: `paused` 为 false 或带明确 `pauseReason`；`queued` 数字合理；20 秒内至少有一次 `lastResult`。

- [ ] **Step 2: 验证暂停让路**（观测到 `quiet` 暂停与恢复；本轮没有真实宿主回合，`host-busy` / `host-active` / `sending` 仍未在真机观察）

在宿主对话框里让大肥鱼处理一件需要模型回合的事（或等一次真实回复），同时：

```bash
journalctl -u dsh-web -f | grep '\[dsh-wx\] 采集'
```

Expected: 回合期间出现 `采集：暂停（host-busy）` 或 `host-active`；回合结束后（且 10 秒静默过去）才出现 `采集：<会话> +N`。采集暂停期间不点开任何会话（日志中没有新的 `采集：<会话>` 行）。

- [x] **Step 3: 验证记录与发言人**

```bash
node --input-type=module -e "import {createContextStore} from './src/dsh-wx/lib/context.js'; const s=createContextStore({}); console.log(s.listRecordedChats({}).text)"
```

Expected:
- 列表里没有 `Tencent News`/`File Transfer`/`Service Messages` 等；
- 旧服务号记录仍存在于 `~/.dsh-wx/ledger/`（不删除）；
- 对一个最近轮转过的群 `historyForChat` 能查到 `source:'capture'` 的记录，至少部分 `sender` 非 null 或明确 `null`；
- 找一个群里连续 3 条、中间一条不是最后一条的场景：预览流至少记到最后一条；轮转后 3 条都在台账，发言人正确或明确“发言人未识别”；
- `~/.dsh-wx/people.json` 存在且包含预览/引用里见过的名字；
- `directory.json` 中被点开过的会话 `lastNonZeroUnread` 保留点开前的值。

发送不被抢占：在她回复或宿主 `wx_send` 期间观察 `journalctl`，采集日志必须出现暂停，且 `wx_send` 的返回时间不因采集被拖长；两者不交叉执行（采集与发送共用 `withGuiLock`）。

- [ ] **Step 4: 验证 `wx_history` 工具（模型调用）**（工具已注册，本轮未由模型实际调用；仅用 Node 直接调用 `createContextStore` 验证）

让大肥鱼实际调用一次 `wx_history`（用户在微信或宿主里问“查一下某群最近的记录”）。记录她的工具返回和 `~/.dsh-wx/context-queries.jsonl`（若有）。若本轮没有模型调用，明确写“工具已注册，未由模型实际调用”，不算验收通过。

- [x] **Step 5: README 补验收边界**

写清楚：预览流只覆盖侧栏最后一条且不点开；轮转点开会清未读（用户已接受）；OCR 失败退化为“发言人未识别”；采集暂停条件与查看方法（`health.json.capture`、`journalctl` 前缀）。

- [x] **Step 6: 提交**

```bash
git add src/dsh-wx/README.md
git diff --cached --check && python scripts/audit-staged.py
git commit -m "docs(dsh-wx): 后台采集的配置、验收与边界"
```

**验收记录（2026-11-04，live dsh-web on dev plugin tree）**

- 重启后 `health.json.capture` 出现：`paused:false`、`queued`、`lastAt/lastChat/lastResult`；日志 `[dsh-wx] 采集：` 可见暂停/恢复与 `<会话> +N`。
- 轮转覆盖 `allowChats`：内部赤石群、计科4223薛长顺、cat不到flag的cat、Tina Yu、我需要重新集结部队；`source:"capture"` 行写入台账；采集到的 @ 并入下一轮投递。
- 预览流去重生效（`added:0 skipped:4/5`）；`ignoreChats` 无新增预览；`listRecordedChats` 不列服务号，旧服务号台账仍在盘上。
- `directory.json` 的 `lastNonZeroUnread` 在点开后保留（星晓家园10号楼1302=1、Tencent News=4、内部赤石群=1），`unread` 归零。
- 暂停观测：发送后 `quiet` → 到期恢复采集；真实宿主回合未出现，`host-busy/host-active/sending` 未验证。
- 发言人：OCR 名字带图标前缀时用尾部片段回查名册（`medium`）；首次见到的 OCR 新名字不建档，第二次才建档；重启后 `people.json` 未再新增噪声 key。遗留噪声条目来自修复前的运行（见 `~/.dsh-wx/people.json`，8 个 OCR-only key），未自动清理。
- `wx_history`：工具已注册；Node 直接调用 `createContextStore` 可查，但本轮没有模型实际调用，按 Step 4 记为未验证。

---

## 执行顺序与依赖

- 可并行：Task 1、2、3、4、6、10 相互独立（都是新纯函数或局部改动）。
- Task 5 依赖 1/2/4；Task 7 依赖 1/3/4/5/6。
- Task 8、9 依赖 1/3；Task 11 依赖 1/5/9/10；Task 12 依赖 4/6/8/10/11；Task 13 依赖 12。
- 每个任务结束必须 `node --test` 全绿再提交；不把“提交了”写成“已部署/已验收”。

## 手工验收记录

- [x] M1：预览流台账出现 `source:"preview"`；服务号无新增；`wx_history` 的只读 Node 调用可用。
- [x] M2：`health.json.capture` 有数据；暂停日志出现；突发通讯录轮转后有 `source:"capture"`；`people.json` 生成；`lastNonZeroUnread` 保留。
- [ ] `wx_history` 由模型实际调用（未调用则记为未验证）。
