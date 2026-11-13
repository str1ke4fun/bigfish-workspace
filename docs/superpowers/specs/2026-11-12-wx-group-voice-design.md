# 大肥鱼在微信群里像她自己：说话方式调整设计

日期：2026-11-12
状态：已实现（2026-11-13，dev `e38a993`；未部署/未做真机微信验收）
范围：`src/dsh-fish/lib/selfdoc.js`、`src/dsh-wx/lib/index.js`、`src/dsh-wx/lib/proactive.js`、`src/speech/speech.mjs`、`workbench/server.mjs`、`workbench/assets/channels/{wx,speech}.js`

## 1. 问题与证据

用户在 web 会话里和大肥鱼说话，觉得「特别像人」；同样的她在微信群里明显不一样。查下来的原因不是模型或插件故障，而是四个可解释的机制叠加：

1. **身份文本分了两套寄存器**（`src/dsh-fish/lib/selfdoc.js:80-133`，线上 `~/.dsh-fish/home/她的身份.md`）。
   跟老哥：像真人、有点软、有点黏、可以叫哥、三百到八百字也正常。
   群里：*「可以软，不黏，不叫哥，不讲你和他的事」「对外只说事」「群里平时短，一条别超过一屏」*。
   web 会话里让她「像人」的东西，在群里被规则收起来了。
2. **输入形状不同**。web 是 `## 他跟你说话了` + 原话（`lib/say.js:178-186`）；微信是耳朵工单：会话名 / 未读 / 侧栏预览 / 谁 / 任务 id / 刚才台账（`dsh-wx/lib/index.js` `formatEarNote`）。
3. **群里只答不问**。`~/.dsh-wx/policy.json` 里 `requireMention: true`、窗口 3 分钟：群里每条都是「被叫到后 3 分钟内回一句」，从不主动开话头。
4. **她的字是工具参数，还被限流**。`wx_send` / `wx_type` 发出去，`wx_type` 不允许换行；通道说明要求「发完最多补一句」；同一会话 25 秒一条、每分钟 2 条、每小时 15 条（`speech.js`）。
   数据：web 提交话语中位数 63 字（最长 306）；微信群出站中位数 32 字。

用户结论：四个方向都改——群段放宽、允许偶尔主动、削弱手册感、放宽限流；并且先在一个群试「多说一点」会不会吵到别人。

## 2. 目标与非目标

目标：

- 群里保留「不黏、不叫哥、不讲私事、不讲机关」的边界，但**允许她把一件事讲清楚**，不再默认压成一句话。
- 群里**偶尔**可以在没人 @ 时接一句：按「每个群每天 N 条」的额度执行，额度可在工作台单独配置。
- 微信通道说明不再占满身份段后面的位置：判断型短规则留在前面，工具手册挪到提示词后段并压缩。
- 微信的发言频率放宽到能一来一回，同时不改变 QQ 的现有频率。

非目标：

- 不改 QQ 的行为（频率用覆盖层，不动 base）。
- 不动私聊（`noMentionChats` 本来就是免 @ 的）。
- 不放开隐私规则：窗口、坐标、白名单、发没发出去、她和老哥的私事，仍然不进群。
- 不新增工具，不改事件流 schema，不改台账格式。

## 3. 设计

### 3.1 身份文本：群段只放宽「短」这一条

`src/dsh-fish/lib/selfdoc.js`，群段改一行：

- 原文：`群里平时短。认真问技术、认真讲心事时再展开，一条别超过一屏。`
- 改为：`群里平时短；认真问技术、认真讲心事，或这件事本来就需要说清楚时再展开，一条别超过一屏。`

同段其余不动：「可以软，不黏，不叫哥，不讲你和他的事」「对外只说事」「有人往下三路带不陪着开」。

这是全文唯一一处群段改动。身份文本是一份全局文本，四个面都读；群段的措辞只在群语境里被采用，改动风险低。

### 3.2 主动额度：每个群每天 N 条「不等人 @ 也能接一句」

**配置**（`~/.dsh-wx/policy.json` 新增两个键，向后兼容）：

```json
{
  "proactivePerDay": 0,
  "proactiveChats": { "星晓家园10号楼1302": 5 }
}
```

- 生效额度 = `proactiveChats[群名] ?? proactivePerDay`，范围 0–50，0 表示关。
- 只对 `allowChats` 里的群生效；`noMentionChats` 本来就随时能说，不消耗额度。
- 被 @ 的 3 分钟窗口内发言**不消耗**额度。

**状态**（新文件 `~/.dsh-wx/proactive.json`，只存计数）：

```json
{ "day": "2026-11-12", "used": { "星晓家园10号楼1302": 2 } }
```

- 日期用本地 `dateKey`；跨天把 `used` 清空。读到坏文件按「今天已用 0」处理，不崩。
- 写入走 tmp + rename，和 `mentions.json` 同一种容错方式。

**执行点**（`src/dsh-wx/lib/index.js` 的 `gateSend`，约 1007-1019 行）：

```
允许名单 / 禁发检查（不变）
→ 当前会话在 noMentionChats：放行（不变）
→ 当前会话在 @ 窗口内：放行，不扣额度（不变）
→ 额度 > 0：扣 1 条、写状态、记 inbound `{type:'proactive-send', chat, remaining}`，返回 { chat, snap, proactive: true }
→ 否则：报错「今天这条群的主动额度用完了，等下次 @」
```

`wx_send` 的返回值增加 `proactive: true|false` 和 `proactiveLeft: N`，让她知道这次是不是用了额度、还剩几条。

**提示词**（`promptText()` 动态生成，每次现读 policy 与状态）：

- 保留原 `requireMention` 那一段，追加一行：
  `有额度的会话今天还能主动说 N 条：星晓家园10号楼1302（剩 3/5）。那不是催你说话；额度用完就等下次 @。`
- 额度为 0 时不出现这行。

**工作台配置**：

- `GET /api/wx/scope` 增加返回 `proactivePerDay`、`proactiveChats`、以及每个群今天的已用条数（读状态文件）。
- `POST /api/wx/scope` 接受并保存这两个键。**必须同时改 `wxPolicy()` 与 `saveWxScope()`**——现在是整份重写，漏一个键就会把配置清掉（`watch`/`trigger` 有过同样的坑，代码里有注释）。
- `assets/channels.js` 的微信区加两栏：默认额度数字框 + 允许群列表里每群一个数字框（0 = 不主动）。保存沿用现有按钮与文案。

### 3.3 削弱手册感：通道说明拆成「短规则（前）」+「工具手册（后）」

现在 `agent/created` 只挂一段 `channel:dsh-wx`（order 91），25+ 条，全是操作细节，紧跟在身份段（order 50）之后。

拆成两段：

| 段名 | order | 内容 | 篇幅 |
| --- | --- | --- | --- |
| `channel:dsh-wx` | 92 | 判断型短规则 | ≈10 行 |
| `channel:dsh-wx-manual` | 8600 | 工具用法与流程 | 其余 |

留在前段的短规则（从现有文本搬，不新写语义）：

- `[微信]` / `[微信·逾期]` 是通道通知，不是对话；预览不是全文；「任务：t_…」是任务板 id。
- 只在被叫到（或免 @ 白名单）时开口；私聊不受此限；有主动额度的群按额度来。
- 群里不进：窗口、坐标、白名单、门禁、发没发出去、她和老哥的私事。
- 发不出去就算了，回对话框说一句。
- 要看前文用 `wx_context`；要读全文先 `wx_peek` 点开。

挪到后段的手册：15 个工具逐条说明、普通发送流程、到点提醒流程、表情相关的全部细节。工具 schema 本身已带描述，手册里对单一工具的一句式介绍可以压到最短，只留**跨工具流程**和**易错点**（如「表情格点下去就发送」「wx_type 不能含换行」「发送前核对当前会话」）。

顺序依据：身份 50 → 短通道规则 92 → 宿主自己的通用指导（约 0–5000）→ 微信工具手册 8600 → 唤醒处境 8700 → 定时提醒 8800 → 任务摘要 8850。后段手册仍在唤醒段之前，不会被「这一次的处境」挤掉。

### 3.4 限流：加微信覆盖层，不动 base

`src/dsh-wx/lib/speech.js` 的 `normalize()` 增加可选覆盖：

```json
{
  "enabled": true, "minGapSeconds": 25, "maxPerMinute": 2, "maxPerHour": 15,
  "wx": { "minGapSeconds": 8, "maxPerMinute": 4, "maxPerHour": 40 }
}
```

- `normalize(raw)` 保留原 shape；新增 `resolve(policy, channel)`：channel 为 `'wx'` 时把 `raw.wx` 合并到 base 上，QQ 传 `'qq'`（目前没有覆盖，等于 base）。
- 调用方：`index.js` 的 `speechGate` 传 `'wx'`；QQ 的 vendor 补丁不改。
- `waitAndAdmit` 等待上限仍是 45 秒；8 秒间隔在等待范围内。
- 工作台 `/api/speech` 增加 `wx` 三个字段的展示与保存；保存时 `saveSpeech` 一并写回，避免整份重写丢掉覆盖层。

### 3.5 工作台与部署

- `workbench/server.mjs`：`wxPolicy()` / `saveWxScope()` 增两个键；`speechPolicy()` / `saveSpeech()` 增 `wx` 覆盖；`wxScope()` 的 `speaking` 解释行增加「今天主动额度剩 N」。
- `workbench/assets/channels.js`：上面两处输入（微信群设置区、说话频率区）。
- 部署：dev 提交 → push → WSL 原生 `fetch`/`pull --ff-only` → `systemctl restart dsh-web`；工作台 8788 需要单独重启（`/opt/fish/workbench` 指向 dev worktree）。

## 4. 错误处理

- 状态文件损坏 / 权限问题：按「今天 0 条」读、写失败只记日志；额度判断失败时**拒绝主动发言**（宁可不说话，也不绕过 @ 闸）。
- 群名乱码：沿用 `saveWxScope` 现有的 `looksGarbled` 拒存逻辑，`proactiveChats` 的键也要过同一检查。
- 提示词里引用额度时，若状态读失败，只写「今天还没用过」，不写错数。
- 手册拆分后若 `agent.ctx.systemPrompt.section` 不可用：两段都挂不上，行为退回「只有身份段」，和现在缺段时的降级一致，不崩。

## 5. 测试

单元（不连微信）：

1. `src/dsh-wx/lib/proactive.js`（新，纯函数）：`quotaFor(policy, chat)`、`remaining(state, chat, today)`、`consume(state, chat, today)`。覆盖：默认 0、群覆盖、跨天重置、坏文件、上限 50。
2. `src/dsh-wx/test-proactive.mjs`（沿用 `test-mention.mjs` 的脚本式断言）：额度判定与 `canSpeak` 的组合顺序——有 @ 不扣、无 @ 扣、扣完拒绝、免 @ 群不扣。
3. `src/dsh-wx/test-speech-override.mjs`：`resolve(policy,'wx')` 合并覆盖；`'qq'` 不受影响；`decide` 在覆盖值下放行/拒绝。
4. `src/dsh-fish/test/identity.test.mjs` 增一条：群段仍含「不黏」「不讲你和他的事」；「短」不再是硬限制（匹配新措辞）。
5. `src/dsh-fish/test/` 针对 `promptText` 的拆分：短段含任务 id / 通知语义 / 隐私禁令；手册段含「不能含换行」「点下去就发送」；两段都能独立求值。
6. `workbench` 相关：`wxPolicy` 读取缺键时给默认值；`saveWxScope` 保存后 `proactivePerDay` / `proactiveChats` 不丢。

集成/人工验收（先单群）：

- 把 `星晓家园10号楼1302` 的额度设为 **5**，其余群 0，观察 1 天。
- 看 `~/.dsh-wx/ledger` 的出站与 `inbound.jsonl` 的 `proactive-send`：
  - 主动条数 ≤ 5；
  - 每条之后群里是否有人接、有没有人表示烦；
  - 被 @ 之后的来回是否变顺（限流放宽的效果）。
- 用户主观判断「吵不吵」优先于数字；不合适就把该群额度降到 2 或 0。

## 6. 回滚

- 配置级：`proactivePerDay` / `proactiveChats` 归 0、`speech.json` 删掉 `wx` 覆盖，立即恢复原行为，不用改代码。
- 代码级：四个改动是独立 commit（身份文本 / 额度 / 手册拆分 / 限流覆盖），可单独 revert。

## 7. 实施顺序

1. `speech.js` 覆盖层 + 工作台限流字段（最小、无提示词风险）。
2. 身份文本群段一行。
3. 通道说明拆分（短段 + 后段手册）。
4. 主动额度（纯函数 → gateSend → 提示词 → 工作台配置）。
5. 单群试运行，收集一天数据后再决定是否推广到别的群。

每步单独 `node --test`（`src/dsh-fish`）与对应 `test-*.mjs`（`src/dsh-wx`），提交前跑 `python scripts/audit-staged.py`。
