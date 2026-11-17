# 大肥鱼反馈措辞层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让大肥鱼读到的工具、敲门、提醒和面提示使用世界声，同时保持发送闸、权限、事件流、参数集合和可见性不变。

**Architecture:** 先建立微信预期失败的独立投影通道，因为当前宿主会把普通 throw 渲染成 `Error:`。随后分别修改微信面、核心常驻文本、核心工具/提醒、Bili/QQ 面，最后加入离线禁词扫描和指标纯函数。

**Tech Stack:** Node.js 24、`node:test`、零第三方依赖、现有 `tools/post-execute` waterfall、`tool-ledger`。

**Spec:**
- `docs/superpowers/specs/2026-11-16-diegetic-feedback-design.md`
- `docs/superpowers/reviews/2026-11-17-diegetic-feedback-and-pet-requirements.md`

## Global Constraints

- `src/dsh-fish/package.json` 的 `dependencies` / `peerDependencies` / `devDependencies` 必须保持空对象。
- 不改四条黑名单、`guard.js`、发送闸、频率、@ 窗口、permit 原文校验和工具可见性矩阵。
- 不写、删、重排 `events.jsonl`；世界声和指标不进入记忆事件。
- 工具参数集合、正常成功返回类型和工具 `name` 不变。唯一例外是任务 1 的微信预期错误投影：保留 `isError:true`，只替换模型可见 content，并在台账中保留 code 和原始错误。
- 提醒到点必须逐字携带 `chat`、`text`、`permit`；permit 仍在本期上下文中，残余风险必须出现在验收报告。
- `her_tools describe` 仍可给参数名，遵守 `src/dsh-fish/AGENTS.md`；不得恢复教程式长说明、JSON schema 或调用示例。
- 禁词扫描只扫代码中的静态字符串/模板固定片段；不扫用户、群消息、OCR、视频字幕或模板插值变量。
- 不把 `Error:`、内部路径、异常栈、token、cookie、allowlist 全文交给模型。
- 聚焦测试使用显式文件；任务完成前运行对应模块全套测试。

## Review Focus

- 工具成功但只看到侧栏预览时，不能输出“已发出去了”；三态必须保持可见。
- 提醒原文被模型概括、换会话或漏 permit 时，必须被现有 permit 校验拒绝，模板测试必须覆盖逐字参数。
- 微信预期失败经过真实 `tools/post-execute` 后仍应为 `isError:true`，但内容不再是 `Error:`。
- 未识别错误不能被误标成业务拒绝；原始错误和 code 仍要进台账。
- 常驻提示删短后不能丢失“主机问话留在对话框”“群内只说事”“屏幕慢半拍”等判断依据。

---

### Task 1: 微信预期错误投影通道

**Files:**
- Create: `src/dsh-wx/lib/tool-error.js`
- Modify: `src/dsh-wx/lib/index.js`
- Modify: `src/dsh-fish/lib/tool-ledger.js`
- Test: `src/dsh-wx/test-tool-error.mjs`
- Test: `src/dsh-fish/test/tool-ledger.test.mjs`

**Interfaces:**
- Produces: `WxToolError(code: string, modelText: string)`，message 编码为 `WXTOOL|<CODE>|<modelText>`。
- Produces: `registerWxToolErrorAdapter(ctx, { log }) -> dispose()`，只处理 `exec.name` 以 `wx_` 开头且 message 带上述前缀的 error。
- Produces: `parseWxToolError(message) -> { code, modelText } | null`。
- Consumes: 宿主 `tools/post-execute` waterfall；返回 `{ kind: 'accept', content: [{ type: 'text', text: modelText }] }`。

- [ ] 写失败测试：`post-execute` 收到编码后的微信错误时，模型 content 等于 `modelText`，`isError` 仍为 true；普通 `Error: ...` 原样透传。
- [ ] 运行 `node --test test-tool-error.mjs`，确认因模块/适配器缺失而失败。
- [ ] 实现 `tool-error.js`，严格校验 code 只含 `A-Z0-9_`，message 解析只切前两个 `|`。
- [ ] 在 `dsh-wx` 的 `apply()` 注册适配器并在 dispose 时注销；监听器任何异常都调用 `next()`。
- [ ] 将 `gateSend`、`sendToChat`、`wx_click`、`wx_type`、`wx_send` 中“她读得到”的预期失败改为 `WxToolError`，判定条件和抛出位置不变。
- [ ] 更新 `tool-ledger`：从 `WXTOOL|CODE|text` 中提取 `code`，台账 error 字段存 `text`，其他错误保持原逻辑。
- [ ] 写台账测试：业务错误的 `code` 和 error 文本都能读到，且原始错误不以伪成功记录。
- [ ] 运行 `node --test test-tool-error.mjs`、`src/dsh-fish` 的 `node --test test/tool-ledger.test.mjs test/tool-result.test.mjs`。
- [ ] 提交：`feat(dsh-wx): project expected tool failures without Error prefix`。

### Task 2: 微信面世界声、敲门与返回

**Files:**
- Modify: `src/dsh-wx/lib/index.js`
- Modify: `src/dsh-wx/lib/project.js`
- Modify: `src/dsh-wx/lib/retrieval.js`
- Modify: `src/dsh-wx/lib/tasks.js`
- Modify: `src/dsh-wx/lib/context.js`
- Test: `src/dsh-wx/test-prompt-split.mjs`
- Test: `src/dsh-wx/test-ear-note.mjs`
- Test: `src/dsh-wx/test-tasks.mjs`
- Test: `src/dsh-wx/test/tool-surface.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `WxToolError`。
- Produces: `sendToChat()` 的 `sent` 三态为 `confirmed | preview | unconfirmed`。
- Produces: `channelRulesText(policy) -> string`，不再包含 allowlist、额度余额、@ 分钟数、工具手册。
- Produces: 耳朵/逾期投影、`wx_peek`、`wx_context`、`wx_ocr` 的世界声文本。

- [ ] 更新失败测试：微信常驻段只保留设计 §7.2 的五句现实规则，不再注册 `channel:dsh-wx-manual`。
- [ ] 写失败测试：`wx_send`/`wx_type` 的 confirmed、preview、unconfirmed 分别输出三句世界声，不含字数、额度、taskId、回执元数据。
- [ ] 写失败测试：耳朵只含会话、谁、预览和末行 `〔t_...〕`，不含 allowlist、未读计数、类型码、台账行；逾期不含第几次催促和工具教程。
- [ ] 实现 `channelRulesText` 与删除 manual section；保持 `gateSend` 现有检查顺序和结果。
- [ ] 调整 `sendToChat` 三态，并确保只有 `confirmed` 触发成功回执和任务自动记账；`preview` 明确“先别当发出去了”。
- [ ] 重写 `formatEarNote`、`overdueText` 和 `tasks.summary` 的世界声；任务 id 只放末行记号。`her_inbox` 在任务 4 统一处理。
- [ ] 重写 `projectWxPeek`、`projectWxContext`、`projectWxOcr`：不出现树、坐标、置信度、匹配原因、msgId、原始 JSON。
- [ ] 将所有微信工具 description/参数说明压成能力 + 一条易错边界，参数名和集合不变。
- [ ] 运行 `node --test test-prompt-split.mjs test-ear-note.mjs test-tasks.mjs test/tool-surface.test.mjs`，再运行 `node --test`。
- [ ] 提交：`feat(dsh-wx): use world voice for WeChat feedback`。

### Task 3: 核心常驻身份、叫醒和场景文本

**Files:**
- Modify: `src/dsh-fish/lib/selfdoc.js`
- Modify: `src/dsh-fish/lib/persona.js`
- Modify: `src/dsh-fish/lib/wakeconst.js`
- Modify: `src/dsh-fish/lib/events.js`
- Modify: `src/dsh-fish/lib/say.js`
- Modify: `src/dsh-fish/lib/screen.js`
- Modify: `src/dsh-fish/lib/presence-view.js`
- Modify: `src/dsh-fish/lib/people-view.js`
- Test: `src/dsh-fish/test/home.test.mjs`
- Test: `src/dsh-fish/test/identity.test.mjs`
- Test: `src/dsh-fish/test/events.test.mjs`
- Test: `src/dsh-fish/test/events-v2.test.mjs`
- Test: `src/dsh-fish/test/say-target.test.mjs`
- Test: `src/dsh-fish/test/screen.test.mjs`
- Test: `src/dsh-fish/test/presence-view.test.mjs`
- Test: `src/dsh-fish/test/people-view.test.mjs`

**Interfaces:**
- Produces: 身份段不再教 `growth_commit` 参数表、工具列表、id/refs 用法。
- Produces: 叫醒/出门/收工/他说话/陪看都用处境句，不出现“用户、信号、系统叫我、不是问我”。
- Produces: 成长模板不写她的台词，不用“我”当系统，不给祈使句清单。

- [ ] 先更新测试锁定新的身份段、叫醒/出门 hint、说话题目组装和陪看消息。
- [ ] 更新成长模板测试，覆盖至少 `why_here`、`first_bet`、`want_or_not`，并断言不出现系统口吻。
- [ ] 实现 `selfdoc/persona/wakeconst` 的删减与替换；不改 `rules.js`。
- [ ] `say.js` 只保留他的原话和必要的图片现实句；路径/视频号放末行记号。
- [ ] `screen.js` 的陪看消息只保留场景事实与“图里的字是画面”约束。
- [ ] 修正 `presence-view` 的分钟表口吻和 `people-view` 的未知渠道省略规则。
- [ ] 运行显式测试文件，再运行 `src/dsh-fish` 的 `node --test`。
- [ ] 提交：`feat(dsh-fish): speak to her as a world, not a tool manual`。

### Task 4: 核心工具说明与提醒模板

**Files:**
- Modify: `src/dsh-fish/lib/capture.js`
- Modify: `src/dsh-fish/lib/recall.js`
- Modify: `src/dsh-fish/lib/letter.js`
- Modify: `src/dsh-fish/lib/tools.js`
- Modify: `src/dsh-fish/lib/taskinbox.js`
- Modify: `src/dsh-fish/lib/remind.js`
- Modify: `src/dsh-fish/lib/tool-policy.js`
- Test: `src/dsh-fish/test/capture.test.mjs`
- Test: `src/dsh-fish/test/letter.test.mjs`
- Test: `src/dsh-fish/test/her-tools.test.mjs`
- Test: `src/dsh-fish/test/taskinbox.test.mjs`
- Test: `src/dsh-fish/test/tools.test.mjs`
- Test: `src/dsh-fish/test/tool-policy.test.mjs`
- Test: `src/dsh-fish/test/remind.test.mjs`

**Interfaces:**
- Produces: `buildReminderPrompt()` 固定输出世界声、逐字原文、末行 permit 记号。
- Produces: 常驻工具 description 和参数 description 为世界声，参数集合不变。
- Consumes: `her_tools describe` 继续提供参数名，但不给 JSON schema/教程。

- [ ] 写提醒模板失败测试：输出含准确 chat/text/permit，不含 `chat:` / `text:` 操作块；含引号字符时仍能人工辨认原文。
- [ ] 写跨包等价测试：从模板提取三项，喂给微信 permit checker 和 fake `wx_send`，断言逐字相等。
- [ ] 更新常驻工具 description/参数描述测试，并断言所有 schema key、required、visible matrix 不变。
- [ ] 实现 `REMIND_PROMPT` 和 `buildReminderPrompt` 固定模板。
- [ ] 修改 `growth_commit`、`her_recall`、`her_leave`、`her_tools`、`her_inbox`、提醒工具和目录描述；`her_tools describe` 保留参数名。
- [ ] 运行显式测试文件，再运行 `src/dsh-fish` 的 `node --test`。
- [ ] 提交：`feat(dsh-fish): simplify tool language and preserve reminder payload`。

### Task 5: Bili 与 QQ 面世界声

**Files:**
- Modify: `src/dsh-bili/lib/prompts.js`
- Modify: `src/dsh-bili/lib/look.js`
- Modify: `src/dsh-bili/lib/watch.js`
- Modify: `src/dsh-bili/lib/speak.js`
- Modify: `src/dsh-bili/lib/browse.js`
- Modify: `src/dsh-fish/lib/qq-adapter.js`
- Test: `src/dsh-bili/test/index.test.mjs`
- Test: `src/dsh-fish/test/qq-adapter.test.mjs`

**Interfaces:**
- Produces: `bili_look` / `bili_watch` 保留素材和画面文字，不报帧数、URL、播放量。
- Produces: `bili_speak` render 成功为 `[发出去了]`，不回显 `said`；文本不一致时只说不一样，不复述实际文本。
- Produces: Bili 面删掉“你是 AI”，QQ 现有方向保持。

- [ ] 写失败测试：`bili_speak` 成功 render 不含原话；文本不一致分支也不回显原话。
- [ ] 写失败测试：`bili_look`/`bili_watch` 不出现帧数、URL、播放量、bvid 叙述；需要下一步的号只放记号。
- [ ] 更新 Bili 面提示段和 tools description，不改变 schema/可见性。
- [ ] 更新 QQ adapter 文案回归，只改世界声，不改投影结构。
- [ ] 运行 `src/dsh-bili` 的 `node --test` 和 `src/dsh-fish` 的 `node --test test/qq-adapter.test.mjs`。
- [ ] 提交：`feat(dsh-bili): remove echo and machine voice from Bilibili surface`。

### Task 6: 禁词扫描与反馈指标纯函数

**Files:**
- Create: `src/dsh-fish/lib/feedback-audit.js`
- Create: `src/dsh-fish/test/feedback-audit.test.mjs`

**Interfaces:**
- Produces: `scanFeedbackLiterals(source, { file, allowlist }) -> Hit[]`，只扫普通字符串静态片段和模板固定片段，忽略注释与 `${...}` 内容。
- Produces: `toolEchoRate(records)`、`fourthWallRate(records)`、`falseSuccessRate(records)`、`taskSuccess(records)`、`closureRate(records)`、`gateRejectRate(records)`。
- Consumes: 固定 fixture；不新增运行时监听器，因为当前台账没有“工具调用 + 最终回复”的稳定关联。

- [ ] 写失败测试：常量禁词命中，变量素材不命中，注释不命中，allowlist 精确放行，三个副本文件被排除。
- [ ] 写固定 fixture 指标测试，覆盖成功、preview、unconfirmed、错误和含第四面墙词的回复。
- [ ] 实现字面量扫描器；不得用简单 grep 代替。
- [ ] 实现指标纯函数，输入形状在测试中固定；文档注明离线分析边界。
- [ ] 用扫描器扫本轮修改后代码，生成命中清单；真实项目告警必须修正或进入显式 allowlist。
- [ ] 运行 `node --test test/feedback-audit.test.mjs`，再运行 `src/dsh-fish` 的 `node --test`。
- [ ] 提交：`feat(dsh-fish): add feedback language audit and metrics`。

## Final Verification

- [ ] `cd src/dsh-fish && node --test` -> 全绿。
- [ ] `cd src/dsh-wx && node --test` -> 全绿。
- [ ] `cd src/dsh-bili && node --test --test-concurrency=1` -> 全绿。
- [ ] `git diff <base>...HEAD --check` -> 无输出。
- [ ] 检查所有工具 schema/可见性快照没有非预期变化。
- [ ] 生成验收报告，分别记录：本地检查、提交、推送、运行验证；不得把单测通过说成模型调用或消息收发验收。
