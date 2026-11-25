# 微信群聊支持 emoji 群名：模块改动调研

日期：2026-11-25　性质：只读调研，未改源码、配置、会话或运行数据
范围：`src/dsh-wx` 为主，少量 `workbench/` 与 `src/dsh-fish/lib/feedback-audit.js`

后续设计：`docs/superpowers/specs/2026-11-25-wx-emoji-full-chain-design.md`。
前/后缀评估：`docs/research/2026-11-25-wx-send-fuzzy-name-evaluation.md`（用户决定本轮不改，保持 exact/folded）。

## 0. 结论

**树路径（AT-SPI）基本已经能带 emoji，真正缺的不是“解析”，而是“比较键”和“OCR 回退”。**

- 会话名从无障碍树读取时按原字符保留。台账正文里有 `😯`、`🐴`、`🦀`，`inbound.jsonl` 的侧栏预览里有 `👿👾🤖👽💀`、`‼️` 等，说明同一条 label → `parseChatLabel` → `parseTree` → JSON/台账的链路不会把 emoji 变成方框；群名走的是同一套机制（`lib/chat-label.js`、`lib/tree.js:44-60`、`lib/wx-elements.mjs:34`）。
- 但整个模块把“名字”当成**一个字符串**在用，没有任何“显示名 / 匹配键 / OCR 证据”的分层。于是同一个群在不同来源里出现 `❤️读书群` 和 `❤读书群` 时，会被当成两个群：
  - `sameName` 只压空白，不做 Unicode 归一（`lib/tree.js:77`）；
  - `chatIdFor` 直接对原串取哈希（`lib/ledger.js:45`）；
  - 发送闸、@ 窗口、频率配额、主动额度、目录条目全部跟着分裂。
- 纯 emoji 群名（如 `🏖️🌊`）在 OCR 路径被几道互相不一致的符号过滤挡住；树路径倒是能显示，但目录/工作台/回退路径的行为不统一。
- 长 emoji 群名截断时按 UTF-16 码元计数，可能在 emoji 序列中间切断（半个代理对、悬空 ZWJ/变体选择符），再被当成正式名字持久化。
- **2026-11-25 现场实测修正了一个前提**：`口口口` 是字体缺失造成的显示问题；无障碍树的文本层仍能拿到 emoji 码点（输入框 `value`、侧栏预览都验证到）。但微信自己的输入控件会丢个别符号（`❤` U+2764 被丢掉，留下悬空 VS16），OCR 对方框只能读出噪声。详见 §1.1。

建议做成三层，而不是加一条正则：

1. **display name**：`NFC + 压空白 + trim`，emoji 原样保留，用于展示、持久化、`chatIdFor` 的首次派生。
2. **match key**：在 display 基础上做 Unicode 归一，并允许一次“变体选择符折叠”的唯一匹配；只在比较时用，不改写存量 `chatId`。
3. **OCR skeleton**：去掉标点/符号/组合符后的骨架，只用于“OCR 名 → 已知全名”的对账，且必须唯一，不用于展示、不用于发送目标的模糊猜测。

OCR 本身读不出 emoji（tesseract `chi_sim+eng` 没有 emoji 训练集）。所以“支持 emoji 群名”的现实目标是：**树健康时完整支持；树不可用时诚实降级**，而不是让 OCR 猜 emoji。

## 1. 现状实测

用模块自己的纯函数做了一组只读探针（未启动微信、未改运行数据）：

| 场景 | 结果 |
| --- | --- |
| 树行 `会话 "🌊周末海边🏖️"` → `parseChatLabel` / `parseTree` | 名字完整，`current` 也完整 |
| 名单 `["🌊周末海边🏖️"]` + 树行 `@我` → `mentionHits` | 命中 |
| `sameName('❤️读书群', '❤读书群')` | `false` |
| `chatIdFor('❤️读书群')` vs `chatIdFor('❤读书群')` | 两个不同 id |
| 目录同时见到两种写法 | 两条 `exact` 条目，互不合并 |
| `canSendWithPolicy`（名单 `❤️读书群`，目标 `❤读书群`） | 拒绝 |
| `reconcileChatName('🌊周末海...', ['🌊周末海边🏖️'])` | 能补全 |
| `reconcileChatName('周末海边', ['🌊周末海边🏖️'])` | 不能（OCR 丢掉开头 emoji 后不是真前缀） |
| `groupTimestampAnchoredRows` 纯 emoji 标题 | 行被丢掉（`isNameWord` 要求字母/数字） |
| `groupTimestampAnchoredRows` emoji+汉字标题 | 行保留（汉字通过 `isNameWord`） |
| `^[\p{P}\p{S}\s]+$` 判纯 emoji | `🌊🏖`、`😀`、`❤` 为 true；`🏖️🌊`、`❤️` 为 false（VS16 是 `Mn`，不在 `P/S`） |

最后一条是现在最隐蔽的不一致：**带变体选择符的纯 emoji 名能过符号过滤，不带的反而被拒**。

### 1.1 2026-11-25 现场实测：字体、AT-SPI 与 OCR

只读检查 + 一次可逆输入测试（没有发消息、没有改群名；测试后已清空草稿）。微信跑在 Xvfb `:99`，Qt 主窗口 `914x666`，`QT_ACCESSIBILITY=1`。

**字体：系统没有 emoji 字体，方框是真的。**

- `fc-list ':charset=1f3d6'`（🏖）和 `fc-list ':charset=1f30a'`（🌊）结果为空；`fc-match emoji` 退回 DejaVu Sans。
- 只装了 `fonts-noto-cjk`、DejaVu、Ubuntu、文泉驿，没有 Noto Color Emoji / Symbola 这类专门 emoji 字体；`/opt/wechat` 也没有自带。😀 这种 DejaVu 有单色字形的还能画出轮廓，🏖/🌊 没有字形，直接方框。
- 把 `😀🏖️❤️🌊` 同时打进 GTK 输入框（zenity）和微信搜索框，截图都能看到“笑脸 + 方框 + 心 + 方框”的混合形态。用户记忆里的 `口口口` 由此复现。

**AT-SPI 文本层：基本保真，但不是绝对保真。**

- 在微信输入框里输入同一串后，主窗口无障碍元素 32 的 `label` 仍是会话名 `星晓家园10号楼1302`，`value` 是：
  `U+1F600 U+1F3D6 U+FE0F U+FE0F U+FE0F U+1F30A`
  即 😀、🏖、三个变体选择符、🌊。**文本层拿到的是码点，不是方框。**
- 但也观察到微信输入控件丢字：输入的 `❤`（U+2764）没有出现在 `value` 里，只留下它的 VS16。说明“屏幕上是什么”和“无障碍层拿到什么”不能划等号，个别 BMP 符号可能在微信侧就被改写。
- 会话行（`list item`）的证据来自历史运行数据：`~/.dsh-wx/inbound.jsonl` 的侧栏预览里出现过 `👿👾🤖👽💀`、`🤡`、`‼️`、`🐎`；台账正文里出现过 `😯`、`🐴`、`🦀`。这些字符串都是由 `parseChatLabel` 从同一个 list item label 拆出来的，说明**会话行 label（名字所在的那一行）本身能带 emoji**。
- 当前微信里没有 emoji 群名，所以没有对“真实 emoji 群名”做端到端改名测试；结论是基于同一 label 机制的旁证 + 输入框实测。

**OCR：方框只能读成噪声。**

- 把输入框里那串方框截图裁出来跑 `tesseract -l chi_sim+eng --psm 6`，输出 `exX`（`65 78 58 0a`）。它不是任何可用的名字，也过不了名单匹配。
- 这直接证实：**树挂时 OCR 回退不可能“读出”emoji 群名**；正确做法是 fail closed，靠树或已知全名对账。

**测试副作用。**

- 测试后 `current` 仍是 `星晓家园10号楼1302`，未读仍 33，草稿已清空，Send 按钮回灰。
- 最近 10 分钟没有新增/修改台账文件；`inbound.jsonl` 没有新事件；`health.capture` 为 `added:0 skipped:6`，没有产生假会话。
- 搜索窗口（独立的 Chromium `WeChatAppEx`）已关闭；期间主窗口曾短暂被遮挡，树状态恢复为 `ok`，没有重启或投递。

**运行层建议（未执行）。** 装 `fonts-noto-color-emoji` 能修复微信（以及在本机 Linux 浏览器里打开的工作台）的显示方框，需要 `apt` 和重启微信/刷新 fontconfig，属于系统变更，等你批准再做。它对 OCR 帮助有限：彩色 emoji 仍是图像，tesseract 不会读；树路径也不需要它。

## 2. 失效点清单

### A. 名称比较键（影响最大）

| 位置 | 现状 | emoji 下的问题 |
| --- | --- | --- |
| `src/dsh-wx/lib/tree.js:77` `sameName` | trim + `\s+ → ' '` | 不做 NFC，不折叠 `U+FE0E/FE0F`。树名与名单/目录名只要写法不同就判不同 |
| `src/dsh-wx/lib/capture.js:11` `nameKey` | 压空白 + ASCII 小写 | 同上；服务号过滤、采集入队用它 |
| `src/dsh-wx/lib/directory.js:31` `norm` | 压空白 | `findMatches`、`uniquePrefix`、别名合并都用它 |
| `src/dsh-wx/lib/project.js:58` `sameChatName` | 压空白 | 显式 `task_id` 回退时可能对不上 |
| `src/dsh-wx/lib/reminder.js:430` `findAllowedChat` | 逐项 `sameName` | 提醒许可、发送闸对不上 |
| `src/dsh-wx/lib/send-gate.js:65-91` | 逐项 `sameName` | @/免 @/当前会话核对全部依赖精确串 |
| `src/dsh-wx/lib/index.js:574` `canonicalName` | 目录精确 `entry()` | 两种写法在目录里是两条，规范名可能取错或取不到 |
| `src/dsh-wx/lib/index.js:2366`、`lib/mention.js` | @ 窗口用会话名做 JSON key | 写法不同 → @ 窗口丢；`canSpeak` 看不到 |
| `src/dsh-wx/lib/speech.js` + `project.js:62` `resolveSendKeys` | 频率/配额用会话名或 chatId 做 key | 同一个群可能落两个配额桶 |

结论：这不是只改 `sameName` 一处。`sameName` 是公共出口，但 `nameKey`、`norm`、`sameChatName`、`findAllowedChat`、工作台的 `includes` 各自实现了一遍比较。**必须收口到一个 `name.js`**。

### B. OCR 回退路径（能降级，不能猜）

| 位置 | 现状 | emoji 下的问题 |
| --- | --- | --- |
| `lib/ocr-snapshot.mjs:111` `isNameWord` | 必须含 `\p{L}\p{N}\p{Script=Han}` | 纯 emoji 标题词被丢弃，整行不出 |
| `lib/ocr-snapshot.mjs:186-190` `nameLooksLikeChat` | 拒绝 `^[\p{P}\p{S}\s]+$` | 纯 emoji 名被拒；带 VS16 的又漏过，规则不一致 |
| `lib/tree.js:340` `ocrMentionHits` | 同上符号过滤 | 同上 |
| `lib/chats-json.mjs:13` | 同上符号过滤（仅 OCR snapshot 分支） | 树分支不受影响；树挂时纯 emoji 候选消失 |
| `lib/ocr-snapshot.mjs:50` `cleanRowLabel` | 去掉行首 `[|>®©•\s]` | 以 `©`/`®` 开头的名字会被啃掉一截 |
| `lib/tree.js:141` `reconcileChatName` | 只做“真前缀”唯一匹配 | OCR 丢开头 emoji（`周末海边` vs `🌊周末海边🏖️`）时配不回来 |
| `lib/ocr-complete.js:13` `compactText` | 去掉所有非字母/数字 | 预览正文里的 emoji 被抹掉，只影响“补全预览”，不影响名字；但会让补全长度判断失真 |
| `lib/ocr.js:21` `parseOcrChats` | 名字原样接受 | 上游 snapshot 已经丢行；若换 OCR 适配器则要一起改 |

Tesseract 的实际行为是：emoji 通常**不输出**，偶尔输出 `?`、空白或无关符号。所以 OCR 路径的正确目标是“不要因为 emoji 把整行/整群判死”，而不是期待它读出 emoji。

### C. 截断与字素

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `lib/directory.js:33` `TRUNCATED` / `36` `stripEllipsis` | 只去掉末尾 `...`/`…` | 截断点若落在 emoji 序列中，会留下半个代理对、悬空 ZWJ、悬空 VS16 |
| `lib/directory.js:50` `base.length < 2` | UTF-16 码元 | 单个 emoji = 2 码元，单个汉字 = 1；阈值语义不一致 |
| `lib/tree.js:148` 同上 | UTF-16 码元 | 同上 |
| `lib/tree.js:170-171` `treeMatchesOcr` | `name.length` / `startsWith` | 码元级前缀，截断在 emoji 中间时对账失败 |
| `lib/index.js:239/252` `resolveLabel` | `toLowerCase` + `lw.length >= 2` | 码元长度；emoji 名更容易误判长度 |
| `lib/directory.js:370` `localeCompare(..., 'zh')` | 排序 | emoji 排序结果不稳定，但不影响正确性 |

emoji 是双宽字符，同样像素宽度下截断得更早；所以 emoji 群名**更容易**踩到这条线。

### D. 工作台

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `workbench/server.mjs:450` `looksGarbled` | 含 `??` 或 `U+FFFD` 即拒存 | 任何连续两个 `?` 都拒存；OCR 把 emoji 读成 `??` 时确实该拒，但合法名字含 `??` 也会误伤；且不检查孤立代理对 |
| `workbench/server.mjs:434/458` | 读/写都过 `looksGarbled` | 一旦 OCR 候选被读坏，用户无法保存整份名单（一次拒绝所有条目） |
| `workbench/assets/channels.js:159`、`assets/channels/wx.js:334` `isBad` | 同上，前后端各一份 | 与后端规则重复且更宽 |
| `workbench/server.mjs:396-411` `wxScope` | 候选来自 `wx.sh chats` | 树健康时 emoji 名能出现；树挂走 OCR 时纯 emoji 名消失。这是可接受的降级，但应在 UI 说清楚 |
| 工作台 / 微信字体 | 已确认缺失（2026-11-25） | `fc-list :charset=1f3d6` 为空，微信把 emoji 显示成方框；工作台在 Windows 浏览器里通常正常，只有在无 emoji 字体的本机 Linux 浏览器里才会方框 |

### E. 持久化 / 身份

- `chatIdFor(fullName)`（`lib/ledger.js:45`）对原串取 SHA-256。**不能改成对 match key 取哈希**——那会让所有存量台账、任务、向量缓存、摘要的 `chatId` 全部失配，违反“历史事件不得删除/重排”。
- 正确的做法是保持 `chatIdFor` 不变；在目录层用 match key 找到已有条目并复用它的 `chatId`。只有真正的新名字才派生新 id。
- 群改名（包括加/减 emoji）本来就会产生新 `chatId`，这是现有设计（`NEXT-STAGE.md` §2.2）。emoji 让“OCR 前缀对账”更容易失败，从而放大这个问题；但不要为此引入模糊匹配发送目标。

### F. 审计 / 展示

- `src/dsh-fish/lib/feedback-audit.js:546` `comparableText` 用 `[\s\p{P}\p{S}]` 去掉符号，会把群名里的 emoji 抹掉。它只用于“投影 vs 回复”的相似度，不用于会话匹配；但如果以后要用它核对“回复里有没有正确说出群名”，需要保留 `\p{Extended_Pictographic}`。
- `src/dsh-fish/lib/work.js:548` 的 `work.wx.dispatchChats` 用 `list.includes(chat)` 精确匹配当前会话名。名单里如果存的是 `❤️读书群`、运行时读到 `❤读书群`，工作委派会被判 `NOT_TRUSTED_CHAT`。改法：读名单时用同一套 `nameKey` 比较，或只允许从目录候选里勾选（保证同源）。
- `src/dsh-fish/lib/remind.js:62` 的 `normalizeChatName` 只去前缀和成对引号，不按字符类别过滤，emoji 安全；但它把名字原样交给 `dsh-wx` 的 `canSendWithPolicy`，所以最终仍受 comparison key 影响。
- `lib/retrieval.js`、`lib/summaries.js`、`lib/project.js` 只是把名字插进文案，emoji 无碍。
- 单聊/群聊判据 `looksDM`（`lib/tree.js:311`、`lib/ear-open.js:26`）用无 `u` 标志的 `[^:：]{1,20}`，量词按 UTF-16 码元计；成员昵称 emoji 多时容易超过 20，导致群聊被误判成单聊。`speaker.js` 的预览头有 `u` 标志且额外用码点计数，不受影响。这是**成员昵称**问题，不是群名，但 emoji 场景下会一起暴露；建议顺手把 `looksDM` 改字素计数。

## 3. 建议设计

### 3.1 新增 `lib/name.js`（唯一名称语义）

```js
// 仅示意，具体命名按仓库风格
export const displayName = (s) =>
  String(s ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim()

// 比较用：先精确键，再折叠变体选择符；折叠只在唯一命中时采用
export const nameKey = (s) => displayName(s)
export const foldedKey = (s) => displayName(s).replace(/[\uFE0E\uFE0F\u200B]/gu, '')
export const sameName = (a, b) => nameKey(a) === nameKey(b)

// OCR 对账用：去标点/符号/组合符，只用于“OCR 名 → 已知全名”
export const skeleton = (s) => displayName(s).replace(/[\p{P}\p{S}\p{M}\s]+/gu, '')

const SEG = new Intl.Segmenter('zh', { granularity: 'grapheme' })
export const graphemeLength = (s) => [...SEG.segment(String(s ?? ''))].length
export const cleanTruncated = (s) => /* 去掉悬空代理对、末尾 ZWJ/VS/肤色修饰符 */
```

匹配顺序（所有地方一致）：

1. `displayName` 精确相等；
2. `foldedKey` 相等，且候选唯一；
3. `skeleton` 相等/前缀，**只允许 OCR 证据与目录对账使用**，且候选唯一；发送目标（模型/用户给的 `chat`）不走这一层，保持“不猜”。

`chatIdFor` 不动。目录 `findMatches` 用 1→2；`uniquePrefix` 用 1→2；`reconcileChatName` 用 1→2→3。

### 3.2 逐文件改动

| 文件 | 改动 |
| --- | --- |
| `lib/name.js`（新增） | 三层 key、字素长度、截断清理 |
| `lib/tree.js` | `sameName` 改为 `nameKey` 比较；`reconcileChatName` 增加 skeleton 唯一匹配；`treeMatchesOcr` 前缀改字素级；`ocrMentionHits` 的纯符号过滤改为“至少有一个字母/数字/emoji”，允许纯 emoji |
| `lib/directory.js` | `norm` → `displayName`；`findMatches` 两层匹配；`uniquePrefix` 字素级；读取时清理悬空代理对；条目增加 `matchKey` 字段（派生，不参与历史） |
| `lib/capture.js` | `nameKey` 复用 `name.js`；`isIgnoredChat` 行为不变（服务号名没有 emoji） |
| `lib/reminder.js` / `lib/send-gate.js` / `lib/project.js` | 所有 `sameName`/`sameChatName` 收口到 `name.js`；`resolveSendKeys` 用 `chatId` 优先，名称键用 `nameKey` |
| `lib/mention.js` / `lib/index.js` | `grant`/`canSpeak`/`canonicalName` 的 key 统一为 `nameKey`；`@` 窗口在两种写法间共享 |
| `lib/ocr-snapshot.mjs` | `isNameWord` 接受 `\p{Extended_Pictographic}`；`nameLooksLikeChat` 改为“至少一个 L/N/emoji”；`cleanRowLabel` 只剥离布局字形（`•`、`|`、`>`），不剥 `®©` 这类可能是名字的符号；emoji 词的置信度不计入 `nameConfidence` 均值 |
| `lib/ocr.js` / `lib/chats-json.mjs` | 纯符号过滤与 `tree.js` 共用同一个判定函数，消除“带 VS16 能过、不带被拒”的不一致 |
| `lib/ocr-complete.js` | 可选：`compactText` 保留 `\p{Extended_Pictographic}`，避免 emoji 预览被当成更短 |
| `lib/tree.js` / `lib/ear-open.js` | `looksDM` 的长度阈值改字素计数（顺手修，不是群名本身） |
| `workbench/server.mjs` | `looksGarbled` 改为：含 `U+FFFD`、孤立代理对，或 `?` 占比过高且长度 ≥2；不再“任意 `??` 一刀切”；候选保存失败时按条目报，不整份拒绝 |
| `workbench/assets/channels.js` / `channels/wx.js` | `isBad` 与后端共用同一规则（或由后端返回 `garbled` 标记，前端不再自己判） |
| `src/dsh-fish/lib/feedback-audit.js` | 可选：`comparableText` 保留 emoji；不影响会话匹配 |
| `src/dsh-fish/lib/work.js` | `dispatchChats` 的 `includes` 改用 `nameKey` 比较（或要求从目录候选勾选） |
| `README.md` / `NEXT-STAGE.md` | 写明“群名可含任意字符；树健康时完整支持；OCR 回退不保证读出 emoji，读不出就 fail closed” |

### 3.3 OCR 策略（明确边界）

1. **树健康时，名字只信树。** OCR 只用于 `@我` 角标、预览补全、发言人几何对齐；不要把 OCR 名字写进目录/政策，除非它已经对账到已知全名。
2. **树挂时，纯 emoji 名不可能被 OCR 读出**（2026-11-25 实测：方框被 tesseract 读成 `exX` 噪声）；`ocrMentionHits` 继续保持保守（只认明确 @ 角标 + 高置信度名字），并在工作台状态里说明“OCR 回退下 emoji 群名不保证识别”。
3. **对账用 skeleton，不用模糊包含。** `周末海边` 的 skeleton 等于 `🌊周末海边🏖️` 的 skeleton 时唯一命中才补全；有多个候选就不动。
4. **不要为 emoji 引入新的 OCR 依赖。** 插件零依赖是硬约束；PaddleOCR/多模态识别都超出本次范围，也改变不了“桌面截图像素里 emoji 就是彩色小图”的事实。

### 3.4 安全与一致性

- emoji 群名更容易出现“看起来一样、码点不同”的两个群。目录已有 `ambiguous` fail-closed（`lib/directory.js:117-126`、`237-241`），match key 折叠后仍要保持：**折叠后撞名 → ambiguous，不允许发送**。
- 发送目标的解析顺序保持“精确 → 折叠唯一”，不进入 skeleton；skeleton 只用于 OCR/目录对账，避免模型凭一个近似名把消息发错群。
- `chatIdFor` 不变，保证存量台账可读；新名字的 id 由 `displayName` 派生，之后靠目录复用。
- 日志、事件流、任务卡里继续写原始显示名；比较用 key 只存在于内存和目录的派生字段，不污染历史。

## 4. 测试计划

新增/扩展（`src/dsh-wx`，`node --test`）：

1. `parseChatLabel` / `parseTree`：emoji 名（含 ZWJ、VS16、肤色修饰符）原样保留；名字里的 `"` 继续被 `q()` 转全角。
2. `sameName` / `nameKey`：精确、NFC 等价、VS16 折叠、折叠后撞名 fail closed。
3. `directory.merge`：同一群的两种写法合并到同一 `chatId`；两个不同的 emoji 群不合并；折叠撞名 → `ambiguous`。
4. `reconcileChatName`：真前缀、skeleton 唯一、skeleton 多候选不解析、截断在 emoji 中间不产生半个代理对。
5. `uniquePrefix` / `stripEllipsis` / 字素长度：单个 emoji、emoji+汉字、ZWJ 家族、悬空 VS16。
6. `mentionHits` / `ocrMentionHits`：纯 emoji 名（有/无 VS16）行为一致；树路径命中；OCR 路径仍要求角标与置信度。
7. `canSendWithPolicy` / `send-gate`：名单与当前会话写法差一个 VS16 时能发；两个近似群同时存在时拒绝。
8. `ocr-snapshot` / `chats-json`：纯 emoji 标题行在允许 `Extended_Pictographic` 后能出；噪声行（纯 `?`）仍被拒。
9. `workbench`：`looksGarbled` 对合法 emoji 名放行、对孤立代理对/`U+FFFD` 拒绝；保存单条失败不拖垮整份名单。
10. 存量兼容：用现有 `directory.json` 夹具跑一遍，确认 `chatId`、`aliases`、`nameConfidence` 不变。

## 5. 优先级与工作量

| 级别 | 内容 | 说明 |
| --- | --- | --- |
| P0 | `lib/name.js` + `sameName`/`norm`/`nameKey`/`sameChatName` 收口；目录两层匹配；纯 emoji 过滤统一；字素级截断与清理 | 树健康时就能完整支持 emoji 群名；不迁移存量 id |
| P1 | `reconcileChatName` skeleton 对账；OCR 路径允许 `Extended_Pictographic`；工作台乱码判定按条 | 树短暂不可用时不再“整个群消失”，但仍 fail closed |
| P2 | `looksDM` 字素长度；`feedback-audit` 保留 emoji；README/NEXT-STAGE；部署机安装 `fonts-noto-color-emoji`（系统变更，需批准） | 体验与文档收尾 |

粗估：P0 约 1–2 天（含测试），P1 约半天到 1 天，P2 半天。真正的工作量在测试与存量兼容，不在改正则。

## 6. 待确认

1. **是否允许折叠 VS16。** 折叠能让 `❤` 与 `❤️` 互相匹配，但会让两个视觉上略有差别的群在目录里撞名（撞名仍 fail closed）。建议允许，但只在“唯一”时生效。
2. **纯 emoji 群名是否允许进入发送名单。** 建议允许：名字本身不构成安全边界，真正的边界是名单 + 当前会话核对 + 频率闸；emoji 只是更难读，不应因此被结构性排除。
3. **树挂时工作台是否展示 OCR 候选。** 建议展示但标注“OCR 读取，可能不含 emoji”，并允许用户手填；保存时仍过乱码检查。
4. **是否现在安装 `fonts-noto-color-emoji`。** 能修复微信里的方框显示；需要 `apt` 安装、刷新 fontconfig，并重启微信（可能打断她当前一轮）。不装也不影响树路径读名字和发送，只影响人眼观感和 OCR（OCR 本来也读不出来）。
