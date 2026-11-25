# 微信群聊 emoji 全链路支持设计

状态：待批准（builder 审后修订）
日期：2026-11-25
范围：`src/dsh-wx` 为主；`workbench/`、`src/dsh-fish` 的接入点；运行环境字体
依据：`docs/research/2026-11-25-wx-emoji-group-names.md`（代码调研 + 2026-11-25 现场实测）

## 1. 意图与成功标准

让微信侧把「带 emoji 的群名」当作一等公民：**树健康时，读名、建目录、唤醒、发送、配额、检索、工作台展示全部正确；树不可用时诚实降级，绝不因为看不见 emoji 而把消息发错群。**

成功标准（全部满足才算完成）：

1. 群名 `🌊周末海边🏖️` 在允许名单里时，侧栏 `@我` 能叫醒她，`wx_send` 能切到该群、核对当前会话并发出。
2. 同一群的 `❤️读书群` 与 `❤读书群` 两种写法不会分裂成两个 `chatId`、两个 @ 窗口、两个配额桶；能唯一合并时合并，不能唯一时 fail closed。
3. 纯 emoji 群名（`🏖️🌊`）能出现在工作台候选、能保存进名单、能被树路径识别；OCR 回退下不冒充。
4. 长 emoji 群名被微信截断时，不产生半个代理对、悬空 ZWJ/VS16，也不会把截断名写进 `chatId`。
5. 工作台对 emoji 群名的保存、展示、乱码提示行为一致；合法 emoji 名不被 `??` 规则误杀。
6. 现有目录、台账、任务、摘要、会话池的 `chatId` 和历史记录不发生迁移或丢失。
7. 树挂时，OCR 只确认明确的 `@我` 角标，不用 OCR 名字做身份；emoji 群名不支持，但不会发错。
8. 部署机装上 emoji 字体后，微信里不再显示方框；即使不装，代码路径 1–7 仍然成立。

## 2. 现状与约束

### 2.1 实测结论（详见调研 §1.1）

- 系统没有专门 emoji 字体：`fc-list ':charset=1f3d6'`、`':charset=1f30a'` 为空；微信显示为方框。
- 无障碍树文本层能拿到 emoji 码点：输入框 `value` 返回 `U+1F600 U+1F3D6 U+FE0F×3 U+1F30A`；历史侧栏预览里有 `👿👾🤖👽💀`、`‼️` 等。
- 微信输入控件会丢个别 BMP 符号（`❤` U+2764 被丢掉，留下悬空 VS16），所以「显示 == 文本」不成立。
- OCR 对方框只读出 `exX` 噪声；tesseract 不可能稳定识别 emoji。

### 2.2 约束

- `src/dsh-wx` 零依赖；不引入 OCR/视觉模型。
- 事件流、台账只追加；不删除、不重排、不改写历史。
- `chatId` 由首次见到的全名派生；**不能改成对比较键取哈希**，否则存量台账/任务/向量缓存全失配。
- 发送是安全边界：名字对不上、撞名、截断未解析，一律拒绝，不猜。
- 树是权威；OCR 只做证据补强（`@我` 角标、预览补全）。
- 工作台、`dsh-fish` 与插件之间通过文件和既有窄接口协作，不新增运行时依赖。
- 个人聊天数据不进仓库：测试夹具必须是合成/匿名化的，不能用活的 `directory.json` 提交。

### 2.3 关键约束带来的取舍

「全链路」定义为：**树健康时的完整链路** + **树不可用时的安全降级**。OCR 不承担 emoji 群名的识别；这是实测后的明确取舍，不是遗漏。

## 3. 方案选择

| 方案 | 做法 | 取舍 | 结论 |
| --- | --- | --- | --- |
| A. 树为准 + 名称键分层 | 树提供名字；新增 display / exact / folded / skeleton 四层；OCR 只认角标；截断按字素清理 | 零依赖、与现有架构一致；树挂时 emoji 群名不可用 | **采用**（用户已选） |
| B. 树 + 稳定别名 | 在 A 之上给 emoji 群绑 ASCII 别名，OCR 回退/发送可用别名 | 树挂时也能用；但别名需人工维护，且 OCR 仍要靠可读部分对上别名 | 不采用；留作未来可选 |
| C. OCR 识别 emoji | 引入视觉/emoji OCR 把屏幕方框读回 | 覆盖 OCR 全链路；打破零依赖，准确率、延迟、成本不可控 | 不采用 |

方案 A 的核心不是「兼容 emoji」，而是**把名字从“一个字符串”拆成“显示、比较、OCR 证据、身份”四种用途**。emoji 只是把这个长期存在的耦合暴露出来。

## 4. 设计

### 4.1 名称模型

新增 `src/dsh-wx/lib/name.js`，所有名字比较只从这里走。核心函数：

```js
// 展示/持久化：sanitizeName(NFC + 连续空白压成一个 + trim)。
// emoji 原样保留，保留原始大小写。
displayName(s)

// 精确比较：displayName 的结果。大小写敏感，和现有 sameName 一致。
nameKey(s)

// 折叠比较：displayName 去掉变体选择符和零宽格式符。
// 只去掉 U+FE0E / U+FE0F / U+200B / U+200C / U+2060；
// 不去 U+200D（ZWJ），避免把不同的 ZWJ 序列合并。
foldedKey(s)

// OCR 对账：去掉标点、符号、组合符、格式符、代理码元、空白，只留字母/数字/汉字。
// 实现类是 [\p{P}\p{S}\p{M}\p{Cf}\p{Cs}\s]。
// 仅用于“OCR 名 → 已知全名”，不用于展示、不用于发送目标。
skeleton(s)

// chatId 的种子：只做 trim + 连续空白压成一个，和旧代码的 norm 完全一致。
// chatIdFor 只接这个；不用 displayName，避免 NFC 改变已有 id。
chatIdSeed(s)
```

辅助函数：

```js
const SEG = new Intl.Segmenter('zh', { granularity: 'grapheme' })
graphemeLength(s)        // 字素计数；所有长度阈值改用它

sanitizeName(s)          // 去孤立代理对、U+FFFD、C0/C1 控制符、bidi 控制符；
                         // 保留 ZWJ/VS/肤色/keycap/tag 字符
cleanTruncated(s)        // 只对“已确认截断”的字符串调用（见 §4.3）；
                         // 去末尾 .../…、悬空 ZWJ/VS/keycap/肤色/tag 字符、
                         // 孤立代理、U+FFFD、落单的 regional indicator
hasNameCharacter(s)      // 至少一个 \p{L} / \p{N} / \p{Emoji}
                         // \p{Emoji} 覆盖旗帜 RI、keycap、©/®/™；EP 不覆盖 RI
```

`displayName = sanitizeName(NFC(trim + 连续空白压成一个))`。

`sanitizeName` 的精确集合：去掉 `\p{Cc}`、`\p{Cs}`、`U+FFFD`、bidi 控制符（`U+202A–U+202E`、`U+2066–U+2069`）、零宽空格/连接符（`U+200B`、`U+200C`、`U+2060`）；**保留** `U+200D`（ZWJ）、`U+FE0E/FE0F`、肤色修饰符、keycap、tag 字符。这样既清掉会 spoof 显示的不可见控制符，又不破坏 `👨‍👩‍👧`、`❤️`、`1️⃣`、`🇨🇳` 这些序列。

**`cleanTruncated` 不能用在完整名字上。** 合法名字可以以 `❤️`、`👍🏽`、`1️⃣` 结尾；无条件去掉末尾 VS/肤色/keycap 会把名字改坏，导致 exact 匹配失败。只有 `looksTruncated(name)` 为真（或 OCR 明确给出截断标记）时才调用它。

**状态键**：

```js
// 按会话存的状态（mentions / proactive / speech / recent）统一用 chatId。
// 目录能唯一解析时用条目的 chatId；未知名字用 chatIdFor(chatIdSeed(s))；
// 折叠后撞名（ambiguous）返回 ''，调用方跳过状态写入，fail closed。
stateKey(s)
```

**分层匹配**：

```js
lookupName(input, { tiers, allowTruncated }) → {
  status: 'exact' | 'folded' | 'resolved' | 'truncated' | 'ambiguous' | 'unknown',
  entry?, chatId?, displayName?
}
// tiers 依次尝试；某一层命中 1 个 → 返回该命中；
// 命中 >1 → 立刻返回 ambiguous，不继续往更松的层找；
// 命中 0 → 试下一层；全部 0 → unknown。
// 折叠撞名优先：多个候选与输入的 foldedKey 相同 → 直接 ambiguous，
// 不能因为其中一个与输入精确相等就选它。
```

各调用点的 `tiers`：

| 场景 | tiers | 说明 |
| --- | --- | --- |
| 发送目标 / 发送闸 / 名单 | `exact`, `folded` | 不进入 skeleton，保持“不猜” |
| 目录 `findMatches` / `entry` | `exact`, `folded` | 撞名 → ambiguous |
| `reconcileChatName` / OCR 对账 | `exact`, `folded`, `skeleton` | skeleton 只在唯一时采用 |
| 截断前缀匹配 | `exact`, `folded`, `skeleton` + 前缀 | 见 §4.3 |

`skeleton` 只在非空且长度 ≥ 2 个字素时参与；`skeleton` 相等或较短一方是较长一方的前缀，且唯一命中，才采用。

**命名上的区分**（builder 审后明确）：

- `nameKey` 是**精确**键，不合并 VS 变体；它只回答“是不是同一个字符串”。
- `foldedKey` 合并 VS 变体，但可能撞名；只在唯一时采用。
- **按会话存的状态用 `chatId`，不用 `nameKey` 或 `foldedKey`。** 这样 `❤️`/`❤` 两种写法天然落到同一个桶，而两个真正不同的群不会因为折叠撞名共享额度。
- `capture.js` 的服务号忽略/采集入队继续用 ASCII 小写：`serviceNameKey = asciiLower(displayName(s))`，保持 `Tencent News` 等英文服务号行为不变；不把全局 `nameKey` 改成大小写不敏感。

### 4.2 目录与身份

`directory.js`：

- `norm` 改为 `displayName`；`findMatches` 按 4.1 的两层顺序。
- **`chatIdFor` 的输入固定为 `chatIdSeed`**（旧 `norm`），所有调用点（`directory.merge`、`directory.idFor`、`context.js`、`capture-run.js`）都用同一个种子。`displayName` 的 NFC 只用于匹配和展示，不参与 id 派生。这样 NFC 会改变码点的名字（如组合重音）也不会产生两个 id。
- `tempIdFor` 继续用旧的 `chatIdSeed` 派生，避免已有 `c_tmp_*` 条目换 id。
- 条目**不新增持久化字段**：`matchKey`/`foldedKey` 在内存中现算（556 条量级，成本可忽略），避免派生字段过期。
- 读取 `directory.json` 时用 `sanitizeName` 清理非法码元：孤立代理对、`U+FFFD`、控制字符、bidi 控制符；**不**在读取时去省略号，也**不**去 VS/ZWJ/肤色/keycap（合法名字可能以 `❤️`、`👍🏽`、`1️⃣` 结尾）。`cleanTruncated` 只在确认截断时用。
- **折叠命中时的规范名**：
  - 保留条目已有的 `displayName` / `fullName`，不跟着最新观察到的写法变来变去；
  - 把新观察到的另一种写法加进 `aliases`（受 `MAX_ALIASES` 限制）；
  - 例外：已存的是 `truncated`、新观察到的是非截断全名 → 用新全名提升，旧截断名进 `aliases`（沿用现有行为）；
  - `sendableTarget` 返回保留的 display name + 原 `chatId`。
- **加载时折叠撞名扫描**：
  - 只扫非 `c_tmp_*` 条目；**不覆盖** `resolvedBy='duplicate-name'` 的临时条目，避免破坏 `merge()` 里现有的临时条目自愈逻辑（`directory.js:186-196`）；
  - 两条不同 `chatId` 的条目 `foldedKey` 相同 → 两条都标 `nameConfidence='ambiguous'`、`resolvedBy='folded-collision'`，不删除、不合并历史；
  - 写一条 `directory-name-collision` 日志/事件。
- **旧 bug 造成的两个真实 `chatId` 分裂**：本轮不自动合并，永久 fail closed，并在工作台标“需要处理”。合并需要用户确认的新工具，留到后续单独设计。
- `uniquePrefix` / `stripEllipsis`：长度按字素；`stripEllipsis` 后调用 `cleanTruncated`。
- `idFor` / `entry` / `sendableTarget` 用统一 `lookupName`；折叠命中返回已存储的 display name + 原 `chatId`；ambiguous 返回空。
- `chatIdFor` 实现本身不动。

身份原则：

- 显示名和 `chatId` 的首次派生继续用 `chatIdSeed`。
- 之后所有变体写法都通过匹配键收敛到已有条目，复用 `chatId`。
- 群改名（包括加/减 emoji）仍会产生新 `chatId`，这是现有设计的已知限制；本轮不引入改名合并，避免误并两个群。

### 4.3 入口、截断与字素

`tree.js` / `chat-label.js` / `wx-elements.mjs`：

- 名字仍只取会话行 label 的第一行（不变）。
- **入口先 `sanitizeName`**：`parseChatLabel` 的名字行和 preview、`parseTree` 的 `current`、`parseOcrChats` 的 `name` 都先清理孤立代理/`U+FFFD`/控制符/bidi；保留所有合法 emoji 序列。preview 只展示、不参与身份匹配，但同样要清掉不可见控制符。
- `reconcileChatName` 增加 skeleton 层；`treeMatchesOcr` 的前缀比较改字素级；`name.length` 改 `graphemeLength`。
- `looksTruncated` / `stripEllipsis` 保持识别规则，但**只在确认截断后**调用 `cleanTruncated`：
  - 去掉末尾 `...`/`…`；
  - 反复去掉末尾 `U+200D`、`U+FE0E`、`U+FE0F`、`U+20E3`、`U+1F3FB–U+1F3FF`、tag 字符 `U+E0020–U+E007F`、孤立高/低位代理、`U+FFFD`；
  - 如果末尾剩奇数个连续 regional indicator（半个旗帜），去掉最后一个；
  - 清理后长度 < 1 字素则视为空。
- **完整名字不清理尾部**：`❤️`、`👍🏽`、`1️⃣`、`🇨🇳` 结尾的名字必须原样保留；这是 exact/folded 匹配的基础。
- `resolveLabel` 的 `length >= 2` 改字素计数。

**截断匹配**：输入 `🌊周末海...` → base `🌊周末海`；先 exact/folded 全名，再对候选的全名做字素级前缀；再比 skeleton。任何一层命中 >1 就 ambiguous，不猜。

**发送链的身份核对**（builder 审后明确）：发送链的 5 处 `sameName(current, target)`（导航、点开后、清浮层后、打字后、回车前）不能只比名字字符串，改为 **`targetMatches(current, targetChatId)`**：

```js
targetMatches(current, targetChatId):
  hit = lookupName(current, { tiers: ['exact','folded'] })
  if (hit.status === 'ambiguous') return false
  id = hit.chatId || chatIdFor(chatIdSeed(current))
  return Boolean(id) && id === targetChatId
```

- `targetChatId` 由目标名解析：`directory.idFor(target)`；目录未知时 `chatIdFor(chatIdSeed(target))`；ambiguous 时直接拒绝。
- `planChatNavigation` 改为收集所有匹配行：0 行按树健康度返回 unreadable/missing；1 行 navigate；**>1 行返回 `{action:'ambiguous'}`**，发送链报 `WX_CHAT_AMBIGUOUS`，绝不点第一行。
- 切过去之后再比对 `parsed.current` 的 `chatId`，而不是字符串；折叠命中也安全。

### 4.4 唤醒、发送与配额

`index.js` / `mention.js` / `send-gate.js` / `reminder.js` / `project.js` / `speech.js`：

- `canonicalName(name)` 契约：
  - exact / folded / resolved → 目录里保留的 display name；
  - unknown → 原样 trim 返回（便于配置未出现的群）；
  - ambiguous → `null`；
  - truncated → 原样返回，但发送闸会拒绝（不可发送）。
  - **不要用 `''` 同时表示 unknown 和 ambiguous**。`index.js:2052` 那种 `canonicalName(a) === canonicalName(b)` 的写法改为 `directory.sameEntry(a,b)`（两边都解析到同一个非空 `chatId` 才为真）。
- 发送链路的导航、核对统一用 §4.3 的 `targetMatches`；`canSendWithPolicy` / `findAllowedChat` 用 `lookupName` 的 exact/folded。
- 名单内部如果两条折叠撞名：保存时拒绝（见 §4.6）；运行时如果发现 `allowChats` 有多个条目匹配同一个 `foldedKey`，返回 `WX_CHAT_AMBIGUOUS`。
- 新增错误码 `WX_CHAT_AMBIGUOUS`：模型文案按返回契约写“这个会话名对不上唯一的群，先在工作台确认”，不暴露 chatId。
- **状态键统一为 `chatId`**：
  - `mentions.json`：`{ [chatId]: timestamp }`；`grant`/`canSpeak`/`grantMentioned` 都先 `stateKey(chat)`；空 key 不写。
  - `proactive.json`：`{ day, used: { [chatId]: n } }`；`remaining`/`consume` 用 `stateKey(chat)`。
  - `speech-state.json`：key 由 dsh-wx 构造成 `wx:<chatId>`；**不改外部 speech 模块**（它只存任意 key）。`index.js:1236` 用 chatId、`1398/1542` 用 `allowed.chat` 的不一致统一到同一个 key。
  - `recent-chats.json`：`[{ chatId, chat, at }]`；`recentChats()` 返回 display name，`isRecentChat` 比 `stateKey`。
  - 工作台读 `mentions[current]` 和 `proactiveUsed[current]` 时，先用目录/`chatIdFor(chatIdSeed(current))` 算出 `stateKey(current)`；`wxScope` 的 speaking 计算同样用这个 key。
- `proactiveChats` 是人工配置的名字键：运行时 `quotaFor` 不用属性直取，改为在 `proactiveChats` 的键里做 exact/folded 查找；保存时把键规范化到目录 display name。
- 主动额度按 `chatId` 优先、名称键兜底（`resolveSendKeys` 已有形状，但把 `quota` 改为 chatId 优先，`speech` 用 chatId）。
- 群委派 `work.wx.dispatchChats`：`dsh-wx` 的 `wxService` 增加 `sameChatName(a,b)` / `canonicalChatName(name)`；`src/dsh-fish/lib/work.js` 优先用这两个接口，接口不在时回退到 trim + 压空白。**本轮不做工作台 picker**；`dispatchChats` 仍手工配置，只修比较逻辑。

### 4.5 OCR 回退（fail closed）

`ocr-snapshot.mjs` / `ocr.js` / `chats-json.mjs` / `tree.js`：

- `isNameWord`：接受 `\p{L}`、`\p{N}`、`\p{Script=Han}`、`\p{Emoji}`。**不要只用 `\p{Extended_Pictographic}`**：旗帜（`🇨🇳` 的 regional indicator）和 keycap 的 `#`/`*` 不是 EP，但都是合法名字字符。
- `nameLooksLikeChat`：不再用 `^[\p{P}\p{S}\s]+$`；改为 `hasNameCharacter(name)` 为真，且不是导航词、不是时间、长度 ≤ 80 字素。纯旗帜、纯 keycap 名应通过；纯 `?` 噪声仍被拒。
- `ocrMentionHits` / `chats-json` 的纯符号过滤：统一调用 `hasNameCharacter`，消除“带 VS16 能过、不带被拒”的不一致。
- `skeleton` 对纯旗帜/纯 ZWJ 家族是空串：这类名字不参与 OCR skeleton 对账（要求非空），只能靠树；这是预期的 fail closed。
- **拼词时空格规则也要覆盖 emoji**：`parseTsv` 的 `text` 拼接和 `groupTimestampAnchoredRows` 的 `rawName` 目前只在 Han/L/N 之间去空格；OCR 把 `🌊` 和 `周末海边` 分成两个词时会得到 `🌊 周末海边`，和全名对不上。改为在**任意两个 `hasNameCharacter` 字符**之间去空格（保留真正的词间空格只在非名字字符处）。
- `cleanRowLabel`：只剥离布局字形 `|`、`>`、`•` 和前导空白；不再无条件剥 `®`、`©`（它们可能是名字的一部分）。
- `nameConfidence`：emoji 词不计入均值（OCR 对 emoji 的置信度天然低）；如果标题全是 emoji 词，再用它们的均值。
- **OCR 名字永远不写目录、不写 policy、不写 `chatId`**。它只做两件事：
  1. 明确的 `@我` 角标确认（保留 `source==='ocr'`、`mention===true`、`nameConfidence >= 55`）；
  2. 对已知全名做 skeleton 对账（`reconcileChatName`），唯一命中才改写成本地展示名，不改 `chatId`。
- 树挂时的对外行为：`planChatNavigation` 返回 `unreadable`，发送闸报“没看清，稍后再试”；不把 OCR 名当发送目标。工作台状态里明确写“OCR 回退不保证识别 emoji 群名”。

### 4.6 工作台

`workbench/server.mjs` / `assets/channels.js` / `assets/channels/wx.js`：

- `looksGarbled` 改为：
  - 含 `U+FFFD` → 坏；
  - 含孤立代理对 → 坏；
  - `?` 数量 ≥ 2、占字素数 ≥ 50%，**且不含** `\p{L}` / `\p{N}` / `\p{Emoji}` → 坏；
  - 合法 emoji、单个 `?`、含汉字/字母的普通问号句（如 `什么??`）不误杀。
- 保存 `allowChats` / `noMentionChats` / `proactiveChats` 时：服务端逐条校验，返回 `bad` 列表和原因；默认**整份拒绝**并高亮坏条目，由用户取消勾选后重存；不自动丢弃，避免静默改变她的说话范围。
- 保存时做名称规范化：
  - 用 `directory.json` + `name.js` 的 exact/folded 匹配；
  - **只改写自 `exact`/`resolved` 条目**；唯一折叠命中就改写成该条目的 display name；
  - 命中的条目是 `truncated`/`ambiguous` → 该条拒绝保存，提示“名字还没解析全/撞名，先点开会话或在候选里选”；
  - 完全不认识的名字 → 原样保留，但提示“目录里还没见到，可能发不出去”。
  - 同一份名单里两条折叠撞名 → 拒绝保存。
- 候选列表：树健康时来自 `wx.sh chats`（已是树分支，含 emoji）；树挂时来自 OCR，标注“OCR 读取，可能不含 emoji”；纯 emoji 名在 OCR 分支按 §4.5 处理，读不出就不出现，不伪造。
- 前端 `isBad` 不再自己判，直接消费后端返回的 `bad` 标记；显示名用文本节点，避免 HTML 注入。
- 工作台读取 `name.js`：沿用 `wx.sh` 的 `DSH_WX_DIR`/部署路径约定；import 不到时回退到本地 `trim + 压空白`，并记日志。部署时工作台与插件一起更新（状态键从 name 改成 chatId，旧工作台读不到提及窗口；状态是临时的，可接受）。
- 前端展示 emoji 依赖查看端字体：Windows 浏览器通常正常；本机 Linux 浏览器需要字体（§4.8）。

### 4.7 跨模块接入

- `src/dsh-fish/lib/work.js`：`dispatchChats` 的 `includes` 改用 `wxService.sameChatName`（或等价的 `nameKey`）。不做 picker。
- `src/dsh-fish/lib/remind.js`：`normalizeChatName` 不按字符类别过滤，已兼容 emoji；最终仍由 `dsh-wx` 的 `canSendWithPolicy` 做 `lookupName` 比较。
- `src/dsh-fish/lib/feedback-audit.js`（可选 P2）：`comparableText` 保留 `\p{Extended_Pictographic}`，避免审计时把群名里的 emoji 抹掉。
- `lib/retrieval.js`、`lib/summaries.js`、`lib/project.js`、`lib/tasks.js`：只做文案拼接和 `chatId` 关联，不需要改；继续写原始 display name。
- `lib/sessions.js`：以 `chatId` 为键，天然稳定，不改。
- `src/dsh-wx/lib/speech.js` 及外部 `/home/str1k3/dsh-plugins/speech/`：**不改**；只改 dsh-wx 传入的 key（`wx:<chatId>`）。

### 4.8 显示环境（运行层）

- 在 WSL/Xvfb 主机安装 `fonts-noto-color-emoji`，执行 `fc-cache -f`，重启 `wechat-fish.service`；这一步是系统变更，需用户批准。
- 它只修复人眼看到的方框和本机 Linux 浏览器里的工作台；**不改变**树路径的正确性，也不让 tesseract 学会读 emoji。
- 不装时，§1 的成功标准 1–7 仍然成立；标准 8 不成立。
- 字体安装后做一次目视验收：微信侧栏、消息区、工作台候选三处都不再出现方框。

### 4.9 安全与失败方式

- 任何一层匹配出现多候选 → ambiguous：不唤醒、不发送、不写新 `chatId`、不写状态；工作台提示。
- 发送目标只走 exact/folded，绝不走 skeleton；skeleton 只用于 OCR/目录对账。
- 不做“包含”匹配、不做拼音/模糊/编辑距离匹配。
- 两个视觉相同的 emoji 群（例如同一个 `🏖️🌊`）在目录里撞名时，必须靠 `chatId` 或工作台明确选择；在提供显式选择前，发送 fail closed。
- OCR 名字不进入目录/policy；OCR 不能因为“看起来像”而授权发送。
- 日志、事件、任务卡、台账继续写原始 display name，不写比较键/chatId 作为展示。
- 写 JSON/日志前清理孤立代理对，避免宿主 lossless JSON 检查拒绝。

### 4.10 可观测性

- 新增 `name-match` 日志/事件：`{ from, to, tier, chatId }`，只在 folded/skeleton 命中时写，便于排查“为什么两个写法合到了一起”。
- 目录加载时撞名写 `directory-name-collision`。
- 工作台状态显示：当前会话的匹配状态（exact / folded / ambiguous / truncated）、折叠撞名的候选。
- 不新增健康检查端点；复用现有 `health.json` 和 `wx_peek`。

### 4.11 关键契约（builder 审后定稿）

| # | 问题 | 决定 |
| --- | --- | --- |
| 1 | mentions/proactive/speech/recent 的规范键 | **`chatId`**（`stateKey`），不是 `nameKey`/`foldedKey`；两写法共享一个桶，两个真群不共享 |
| 2 | 发送链的导航/核对 | `targetMatches(current, targetChatId)`；`planChatNavigation` 对多行返回 `ambiguous`，不点第一行 |
| 3 | 加载时折叠撞名与旧临时条目 | 排除 `c_tmp_*`，不覆盖 `duplicate-name`，用 `folded-collision`；旧的两真 id 分裂不自动合并，fail closed + 工作台提示 |
| 4 | 折叠命中后谁是规范名 | 保留已存 display/fullName；新写法进 aliases；已存 truncated + 新观察全名时提升 |
| 5 | dispatchChats picker | **不做**；只改 `work.js` 比较逻辑，配置仍手工 |
| 6 | 名称大小写 | `nameKey` 大小写敏感；`capture.js` 服务号继续 ASCII 小写；发送名单保持现有大小写语义 |
| 7 | 测试夹具 | 只用合成/匿名化夹具；不提交活的 `directory.json` |
| 8 | unknown vs ambiguous | 用 `lookupName` 状态区分；`canonicalName` 对 unknown 原样返回、对 ambiguous 返回 `null`；不共用 `''` |
| 9 | speech key 改在哪 | 只改 dsh-wx 构造的 key（`wx:<chatId>`）；不改外部 speech 模块/QQ 补丁；旧 `wx:<name>` 键一小时内自然过期 |
| 10 | `chatIdFor` 的输入 | 固定 `chatIdSeed`（旧 trim+压空白）；`displayName` 的 NFC 只用于匹配/展示 |
| 11 | 旗帜/keycap/tag/肤色 | `hasNameCharacter` 用 `\p{Emoji}`（含 RI），不用只靠 EP；`cleanTruncated` 只处理截断串，完整名结尾的 VS/肤色/keycap 不改写 |

## 5. 迁移与兼容

### 5.1 不迁移

- `ledger/`、`tasks.jsonl`、`summaries/`、`sessions.json`、向量缓存：全部按 `chatId` 或原始 `chatName` 继续读，不改写。
- `directory.json`：结构仍是 version 1；不新增必填字段；不重写 `chatId`、`aliases`、`firstSeenAt`；`chatId` 派生种子不变。
- `people.json`：人名，不是群名，不改。

### 5.2 需要一次性规范化（临时状态）

| 文件 | 现状 key | 迁移规则 |
| --- | --- | --- |
| `mentions.json` | 会话名 | 改为 `stateKey(old)`；撞键取最大时间戳；`stateKey` 为空的条目丢弃并记日志 |
| `proactive.json` | `{ day, used: { 会话名: n } }` | 改为 `{ day, used: { stateKey(old): n } }`；撞键取**较大**计数（保守，不放大额度） |
| `recent-chats.json` | `{ chat, at }[]` | 不做文件迁移；新写入用 `{ chatId, chat, at }`，旧条目 30 分钟内自然过期；读取时两种形状都认 |
| `speech-state.json` | `wx:会话名` | 不迁移；新写入 `wx:<chatId>`，旧键 1 小时内自然过期 |

规则：

- `mentions.json` / `proactive.json` 迁移前复制为 `<file>.v1.bak`（保留恢复路径）。
- 迁移失败/写不进去：保留原文件，记日志；只影响临时的 @ 窗口/额度，不影响发送名单与台账。
- 迁移后 key 变化会导致当天的 @ 窗口/主动额度一次性合并或重置；在发布说明里写明。
- 旧键如果是截断名，迁移出的 `chatId` 可能和后来解析出的条目对不上；这类条目随 `mentions` 24 小时 / `proactive` 当天自然过期，不阻塞发送。
- 工作台必须与插件同批更新：旧工作台读 `mentions[current]` 会读不到新的 `chatId` 键；状态是临时的，可接受，但发布时一起重启。

## 6. 测试与验收

### 6.1 单元测试（`src/dsh-wx`，`node --test`）

1. `name.js` 基础：NFC 等价；`❤` vs `❤️`；`👨‍👩‍👧` 不被 folded 合并；肤色修饰符；孤立代理对；`cleanTruncated` 不产生半个代理对。
2. `name.js` emoji 边界：`🇨🇳`/`🇺🇸` 的 `hasNameCharacter` 为真（`\p{Emoji}` 覆盖 RI，`\p{Extended_Pictographic}` 不覆盖）；`1️⃣`/`1⃣` folded 等价；`🏴󠁧󠁢󠁳󠁣󠁴󠁿` tag 序列；`🏳️‍🌈` / `🧑🏽‍🚀` 的 ZWJ+肤色；`skeleton('🇨🇳')` 为空。
3. `name.js` 不误伤完整名：以 `❤️`、`👍🏽`、`1️⃣`、`🇨🇳` 结尾的完整名字经过 `displayName`/`sanitizeName` 不改写；`cleanTruncated` 只在 `looksTruncated` 为真时调用；`cleanTruncated('🇨🇳...')` / `('🏴󠁧󠁢...')` 不留下半个旗帜/tag；孤立代理和 `U+FFFD` 被 `sanitizeName` 清掉。
4. 分层匹配：exact 优先；folded 唯一才采用；folded 撞名回 ambiguous 且不落到 skeleton；skeleton 只在唯一时采用。
5. `chatIdSeed` / `chatIdFor`：同一名字在 NFC 改变码点时仍派生同一个 id；旧 `c_tmp_*` 不变；`stateKey` 在 ambiguous 时为空。
6. `directory.merge`：两种写法合并到同一 `chatId`；两个不同 emoji 群不合并；折叠撞名 → ambiguous；`duplicate-name` 临时条目的自愈不被 `folded-collision` 覆盖；合成夹具跑完后 `chatId`/`aliases` 不变。
7. `reconcileChatName`：真前缀、skeleton 唯一、skeleton 多候选不解析、截断在 emoji 中间被清理。
8. `parseChatLabel` / `parseTree`：emoji 名原样保留（含旗帜、keycap、tag 序列）；孤立代理被 `sanitizeName` 清掉；`"` 转全角规则不变。
9. `mentionHits` / `ocrMentionHits`：纯 emoji 名（有/无 VS16、纯旗帜）行为一致；树路径命中；OCR 路径仍要求角标 + 置信度。
10. `canSendWithPolicy` / `send-gate` / `planChatNavigation`：名单与当前会话差一个 VS16 时能发；两个近似群同时存在时 `WX_CHAT_AMBIGUOUS`；多行同名时绝不点第一行。
11. `ocr-snapshot` / `chats-json`：纯 emoji / 纯旗帜标题行在允许 `\p{Emoji}` 后能出；纯 `?` 噪声仍被拒。
12. 状态与迁移：mentions/proactive 旧名字键 → `chatId`；撞键合并规则；`speech`/`recent` 旧键过期；工作台按 `stateKey(current)` 读提及窗口。
13. 工作台：`looksGarbled` 对合法 emoji 名放行、对 U+FFFD/孤立代理对拒绝；单条坏名返回 `bad` 列表，不自动丢；truncated/ambiguous 条目不被规范成不可发送的 policy 名。
14. `dsh-fish/lib/work.js`：`dispatchChats` 在 VS16 变体下仍放行；不可用 `wxService` 时回退比较。

### 6.2 端到端验收（需要真实微信群，用户配合）

1. 建/找一个 emoji 群名，加进允许名单；在群里 @ 她，确认叫醒、发送、当前会话核对、频率配额、台账 `chatId` 一致。
2. 把名单名改成另一种 VS 写法，确认仍指向同一群且能发。
3. 造两个折叠撞名的会话（或临时改一名），确认工作台报 ambiguous、发送被拒、不会点第一行。
4. 长 emoji 群名截断后，确认目录解析成全名、不写坏代理对。
5. 树挂（临时停 AT-SPI 或改窗口）时，确认只认明确 `@我`，不做 emoji 名字匹配，不发送。
6. 装字体的机器上目视检查侧栏、消息区、工作台候选。

### 6.3 回归

- `cd src/dsh-wx && node --test` 全绿。
- `workbench` 测试（若存在）全绿。
- `src/dsh-fish` 相关测试全绿。
- 测试夹具全部合成/匿名化；不提交真实群名、聊天记录或 `directory.json`。

## 7. 非目标

- 让 tesseract/OCR 识别 emoji。
- 引入视觉模型、外部 OCR、云端接口。
- 群改名时自动合并 `chatId`。
- 把 `chatId` 改成对比较键取哈希。
- QQ/NapCat 通道的 emoji 群名（另属 QQ 侧）。
- 修改微信本身或打补丁。
- 为 emoji 群名做模糊/拼音/编辑距离匹配。
- 工作台 `dispatchChats` picker（本轮只修比较逻辑）。
- 删除或重写任何历史事件。

## 8. 分阶段落地

| 阶段 | 内容 | 完成标志 |
| --- | --- | --- |
| P0 | `name.js`（display/exact/folded/skeleton/chatIdSeed/stateKey）；`sameName`/`norm`/`nameKey`/`sameChatName` 收口；目录两层匹配；字素级截断/清理；发送链 `targetMatches`；状态键改 chatId + mentions/proactive 迁移 | 树健康时标准 1、2、4、6 通过；单测全绿 |
| P1 | OCR 过滤统一；`reconcileChatName` skeleton；工作台 `looksGarbled`、保存规范化与按 chatId 读状态；`work.js` 接入 | 标准 3、5、7 通过；树挂时 fail closed |
| P2 | `fonts-noto-color-emoji` + `fc-cache` + 重启微信（需批准）；`looksDM` 字素长度；`feedback-audit` 保留 emoji；README/NEXT-STAGE | 标准 8；目视验收 |

部署链路按仓库约定：Windows 修改 → Windows 测试/审查/commit → push → WSL 原生 `git fetch` / `pull --ff-only` → WSL 侧 `node --test` → 重启 `dsh-web`（代码）→ 需要时重启 `wechat-fish`（字体）。工作台与插件同批更新（`mentions` 状态键变化）。

## 9. 已定决策与待批准项

### 已定（本设计采纳）

1. 树为准，OCR fail closed（用户 2026-11-25 选定）。
2. 名称四层：display / exact / folded / skeleton；folded 只去 VS 与零宽格式符，不去 ZWJ。
3. 发送目标只走 exact / folded；skeleton 只用于 OCR 与目录对账。
4. 状态键统一为 `chatId`；`chatIdFor` 的种子保持旧的 `chatIdSeed`，不迁移历史 id。
5. 发送链用 `targetMatches(current, targetChatId)`；导航多行 → ambiguous，不点第一行。
6. 折叠命中保留已有规范名，新写法进 aliases；旧的两真 id 分裂不自动合并。
7. 工作台保存沿用 fail closed：整份拒绝并列出坏条目，不自动丢弃；只从 exact/resolved 条目规范名。
8. 临时状态做一次性 key 规范化；`speech`/`recent` 让旧键自然过期；保留 `.v1.bak`。
9. 测试夹具只用合成/匿名化数据。
10. 不做 `dispatchChats` picker；不改外部 speech 模块。

### 待用户批准

1. 本设计文档。
2. P2 的系统变更：安装 `fonts-noto-color-emoji` 并重启微信（会打断她当前一轮）。
3. 端到端验收需要真实 emoji 群名和一次群操作（建/改名或改备注），需要用户配合。
