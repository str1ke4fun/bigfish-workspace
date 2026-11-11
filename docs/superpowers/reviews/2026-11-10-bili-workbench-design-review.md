# 独立评审：大肥鱼 B 站功能集成工作台设计

- 日期：2026-11-10
- 评审对象：`docs/superpowers/specs/2026-11-10-bili-workbench-integration-design.md`（提交 `f53bd0c`）
- 评审基线：WSL 主仓 `main@f53bd0c`、`src/dsh-fish` 0.7.0、`src/dsh-wx` 0.2.0
- 方法：五路只读勘察（core 架构、B 站代码清单、dsh-wx 打包先例、运行态/部署、上游设计一致性）+ 对关键代码的逐行复核
- 结论：**方向成立，但不能按原文直接进入 A1。** 有 7 个阻塞项、11 个重要缺口、10 处与上游设计的冲突；修订版见 `2026-11-10-bili-workbench-integration-design-v2.md`

---

## 0. 结论摘要

原设计把「拆包」识别为三个硬约束（记忆无写入口、策略表私有、调度必须唯一），判断正确。但它把拆包想成了一次「接口 + 搬文件 + 迁 UI」的线性工程，低估了四件事：

1. **记忆不是一层。** 「channel 决定召回范围」与「她主动写入的内容在所有面可召回」在原文里同时成立，实际做不到。需要拆成「原始经历层（按 channel 隔离）」与「学习层（跨面共享、但跨面必须去引用化）」。
2. **core 内部已经反向依赖 B 站。** `owner.js` 依赖 `bili.normalizeCookie`，`derive.js` 依赖 `voices.findEcho`，而 `voices.js` 又依赖 `derive.similarity`，已经是一个环。A2 直接搬文件会先弄坏 core。
3. **调度不止一个入口。** 原设计只看到 `backgroundBrowse` / `maybeOuting`，漏了 `wake()` 内部还会调用 `lookBeforeWake()` 现场刷站。只加 `schedule.onTick` 会让唤醒素材要么丢失、要么双刷。
4. **「十四块」和「92 个测试」都不是可执行的清单。** 真正的 B 专属模块是 15 个 / 3812 行；`client.js`、`observe.js` 是 core 共用文件，必须拆而不是搬；92 只有「85 个专项 + p7 的 7 个」这一种凑法，且 p7 文件里混有非 B 用例，不能整文件搬。

评审后用户已裁定四个产品/范围问题：记忆按通道隔离但学习层可透传、`cseen` 改为「呈现即记」、A3 全量迁移、历史事件按规则推断 surface 而非一律 `core`。修订版设计已按这四条重写。

---

## 1. 评审方法与当前事实

### 1.1 当前交付状态

| 项 | 事实 | 证据 |
| --- | --- | --- |
| 分支/HEAD | WSL 主仓 `main@f53bd0c`，比 `origin/main` 多 1 个文档提交 | `git log`、`git status` |
| dev worktree | `/home/str1k3/src/bigfish-workspace-dev`，`dev@f0fe2f9`，有 3 个未跟踪项 | `git worktree list` |
| Windows 仓 | `/mnt/d/fish-handoff` 停在 `7c5d207`（2026-11-02），落后 WSL main 107 个提交，且有未提交改动 | 只读核对 |
| 运行实例 | 只有 8710 在跑（pid 874，`dsh web --port 8710`，fish home `~/.dsh-fish`）；8720 未监听、进程已退出 | `ss`/`ps`/日志 |
| 工作台 | 8788 独立 `workbench/server.mjs` 在跑 | `ps` |
| 核心测试 | `src/dsh-fish`：813 pass / 0 fail / 0 skip，45.44s | `node --test` |
| 微信测试 | `src/dsh-wx`：67 pass / 0 fail / 0 skip，0.25s | `node --test` |
| 事件数据 | 323 行；v1=119、v2=204、无 v3；meta 209、saw 75、voice 29、utterance 6 | `events.jsonl` 统计 |
| 出门会话 | `bili-session.json` 存在；14:29 新建、14:36/15:20 复用 | 日志、文件 mtime |
| `dsh-bili` | 两侧都不存在 | `find src`、`~/dsh-plugins` |
| 部署接线 | `~/.dsh/profiles/web/node_modules/dsh-fish`、`dsh-wx` 均指向主仓 `src/`；`~/dsh-plugins/dsh-wx` 也是 symlink | 只读核对 |

### 1.2 原设计的事实核对

| 原设计断言 | 判定 | 证据/偏差 |
| --- | --- | --- |
| `bili.js` 从首次提交就在 core，`dsh-bili` 不存在 | 属实 | `git log`、目录 |
| `fishCore` 只有 surface/guard/config/tools 四组（88-98 行） | 属实；`config.patch` 是空桩 | `core-service.js:88-98`，`:95` 只返回当前配置 |
| `POLICY` 是冻结常量，无 contribute | 属实 | `tool-policy.js:125-137` |
| 工具数 web 5 / wx 14+13 / qq 5+7 / bili 8 | 属实 | `tool-policy.js:46-137` |
| bili 面 cwd=`<root>/home/bili` | 属实 | `core-service.js:45-48` |
| 台账 append-only、不进事件流 | 属实 | `tool-ledger.js:224-262` |
| `ctx.provide('wx')` 在 `lib/index.js:61-64` | **偏差**：实际在 `lib/reminder.js:225-240` | 行号引用错误 |
| 出门会话已落地（`f36d6e8`） | 属实 | `lib/outing.js`、`bili-session.json` |
| 事件 v2、无 surface、无 `bili_reply` | 属实 | `schema.js:47`、`ALL_TYPES` |
| `derive` 无 `biliSaid`/`biliReplies` | 属实 | `derive.js:651-671` |
| `selfdoc`/`persona` 仍有 B 站三段与 `bili_watch` 说明 | 属实 | `selfdoc.js:258/276/278`、`persona.js:351` |
| `settings.section` 在 `client.js:2418-2429` | 基本属实；实际是 `ctx.slots.inject('settings.section')`，从 2412 起 | `client.js:2412-2429` |
| 工作台 B 站页/路由仍归 core | 属实 | `observe.js` 的 `/browse`、`/history`、`/footprint`、`/comment-body`、`/cover`、`/risk` |
| 「十四块 B 站代码」 | **不准确**：B 专属 15 个 / 3812 行；清单列 18 项；`prompts.js` 不存在 | 见 §3.6 |
| 「92 个专项测试」 | **口径不唯一**：7 个专项文件 85 例；+ p7 的 7 例 = 92 | 见 §3.6 |
| A1 后旧 meta 序列不变 | 设计意图合理，但 `bili_speak` 写 utterance、`bili_watch` 写 saw、回复扫描写 `bili_reply` 都会改变事件流，需要逐条验收 | 见 §4 |
| 「宿主不支持多 section 就退回 core 壳」 | 当前宿主 0.2.1-rc.5 已支持多 section；该退路只应作为旧版兼容 | 见 §3.7 |

---

## 2. 阻塞问题（P0）

### P0-1 记忆边界在原文里自相矛盾

原文不变量 3 写「channel 决定召回范围」，§5.1 又写「共享事实一律写 core，surface 只记来源」，§6.3 再写「her_recall 不过滤 surface」。三句话合起来无法回答：

- 微信群里别人说的原话，会不会出现在 B 站评论的上下文里？
- 她在微信里学到的一个想法，能不能在 B 站用？
- `surface='bili'` 的 `saw` 写 `channel='core'`，是否意味着 web 也能翻到？

当前代码的事实是：`her_recall` 按 `channel==='core' || channel===当前通道` 过滤（`recall.js:148-152`），而 `deriveSelf` 不按 channel 过滤（`derive.js:225` 起），所以「判断」已经天然跨通道，「原始事件」没有。原设计没有把这个已有事实写清楚。

**用户裁定**：原始经历按通道过滤，避免微信群聊/私聊事件透传到 B 站评论；但她在微信群聊里学到的聊天方式/想法可以透传。

**修订方向**：两层记忆模型。

- **原始经历层**：`saw`、`voice`、`utterance`、`bili_reply`、`answer`、`test`、`diary` 等，按 `channel` 隔离；`her_recall` 只翻 `core + 当前 channel`。
- **学习层**：`revise`、`narration`、`refusal` 以及由她们派生的 beliefs，跨面共享；但跨面渲染时必须去引用化（去掉引号原文、@、链接、长段逐字重合），只留她自己的总结。
- `surface` 只记来源与展示位置，不是隐私边界；`channel` 才是隐私边界。

这需要新增 `guard.crossChannel`（或 `guard.dequote`）与 `derive` 的 `originChannel` 字段，详见修订版 §5。

### P0-2 core 内部已有反向/循环依赖

搬文件前必须先解开：

| 位置 | 依赖 | 后果 |
| --- | --- | --- |
| `owner.js:12` | `import { normalizeCookie } from './bili.js'` | B 站文件搬走后 core 直接断 |
| `derive.js:13` | `import { findEcho, VOICE_FRESH_DAYS } from './voices.js'` | `voices.js:22` 又 import `derive.similarity`，已构成环；搬 voices 会断 derive |
| `selfdoc.js:30-31` | `persona.SPEAK_BRIEF`、`browse.LOOK_BRIEF/WATCH_RULE` | 删 B 文件会断身份文档 |
| `persona.js:351/368` | `bili_watch` 说明、`SPEAK_BRIEF` | 身份文档继续背着 B 站教程 |
| `scheduler.js:25-36` | 直接 import `backgroundBrowse`、`gather`、`maybeOuting`、`risk`、`cover`、`history`、`createClient` | 删文件 core 编译断，保留则双调度 |
| `observe.js:24-58` | 静态 import 8 个 B 模块 | 搬包必须拆路由，不是删文件 |

**修订方向**：新增 A0 阶段，先把 `normalizeCookie` 沉到 core 的 `lib/cookie.js`，把 `similarity` / `findEcho` / `VOICE_FRESH_DAYS` 沉到 core 的 `lib/similarity.js`（或通过 `fishCore.memory.similarity/findEcho` 暴露），再谈搬文件。A0 不改行为，只解依赖。

### P0-3 调度漏了 `wake()` 内部的 `lookBeforeWake()`

原设计 §7.1 说把 `backgroundBrowse` / `maybeOuting` 挂到 `schedule.onTick`，删掉 core 对 B 站的直接调用。但 `wake()` 内部还会调用 `lookBeforeWake()`（`scheduler.js:296`），后者会：

- 检查 `browse.enabled`、`browse.perDay`、上网时段、风控；
- 调 `gather()` 现场取素材；
- 写 `saw`、`browse:`；
- 刷新身份文档；
- 渲染 `renderWatchList` 与封面。

如果只挂 `onTick`，会出现两种坏结果：插件接管后台刷站后，唤醒素材没了；或者 core 的 `lookBeforeWake` 还在，和插件双刷。

**修订方向**：调度接口必须有两个相位：

- `schedule.onTick({ id, everyMs, order, fn })`：后台维护（刷站、回复扫描、出门投递）。
- `schedule.onWake({ id, order, fn })`：唤醒前的现场取材（`lookBeforeWake` 等价物），只在本次真的要唤醒时跑一次，返回 `{ text, intro, picks, riskNote }`。

core 的 `wake()` 只负责拼装，不再直接 import B 站模块。

### P0-4 A2 需要的接口在原设计里缺失

原设计列了 `memory` / `surface.contribute` / `schedule.onTick` / `prompt` / `config.patch` / `owner`，但 A2 搬 B 站工具时还需要：

| 缺失接口 | 谁需要 | 现状 |
| --- | --- | --- |
| `tools.wrap` / `tools.wrapRender` | `bili_look`/`watch`/`speak` 的统一返回契约、投影、台账 | 代码已有（`index.js:110-111`），设计没写 |
| `toolLedger` 只读查询 | 工作台「台账单条」、自检 | 只有内部实例，无对外接口 |
| `sessions`（create/find/prompt/rename） | 出门会话创建/复用/投递 | 现在直接 `sc.create` + `surface.reserve` |
| `memory.similarity` / `memory.findEcho` | `voices.chooseVoice`、`derive.findEcho` | 现在直接 import 对方源码 |
| `prompt.section` | 插件按面挂 `fish:bili` 段 | 现在只能直接调宿主 `agent.ctx.systemPrompt.section` |
| `config.onChange` | 配置改动后两包同步 | 原设计说广播 `config/changed`，全库不存在 |

**修订方向**：修订版 §6 把这些接口全部写成契约，包括签名、错误、并发、测试。

### P0-5 `surface.contribute` 与「单一策略表 / restrict 硬编码」冲突

原设计让 `surface.contribute({ tools, groups })` 声明工具。但：

- 上游顶层设计明确「`surface.register` 不声明 tools；可见性只由 `tool-policy` 唯一决定」。
- `restrict.js:48-59` 的 `FISH_TOOLS` 写死了 10 个名字，`HER_TOOLS` 再加 `read_image`；`restrict()` 的名字必须真实存在，否则抛错。
- 插件晚于 `agent/created` 加载时，`restrict` 已经把 bili 面的 allow 集合算完；新贡献的 3 个工具对已建会话不可见。
- 原设计没有定义「插件卸载后如何收回工具」。

**修订方向**：

- 接口改名为 `fishCore.toolPolicy.contribute({ id, tools, groups })`，`surface.register` 保持只管面判定；`surface.contribute` 可保留为兼容别名，但文档只推荐新名。
- `tool-policy.js` 改成「内置表 + 贡献表」的合并视图；`restrict.js` 的 `FISH_TOOLS` 改为 `toolPolicy.ownTools()` + 贡献名，禁止再写死。
- 贡献必须在 `bootstrapHome` / 首个 bili agent 创建之前完成；晚加载时标记 `pending`，要求重建会话，不假装已生效。
- `bili` 面第一版无 deferred 组，3 个工具全部 always；插件缺席时回到 coreEntries 的 5 个。

### P0-6 文件清单与测试口径不可执行

原设计 §4.3 列了 18 项，说「十四块」，实际：

- B 专属 lib 文件 **15 个 / 3812 行**：`bili.js`、`browse.js`、`browsejob.js`、`look.js`、`watch.js`、`speak.js`、`comment.js`、`video.js`、`ocr.js`、`cover.js`、`history.js`、`footprint.js`、`voices.js`、`risk.js`、`outing.js`。
- `prompts.js` **不存在**：常量散在 `browse.js:501/521`、`persona.js:351/368`、`selfdoc.js:162`。
- `client.js`、`observe.js` 是 core 共用文件，不是 B 专属；整搬会带走非 B 功能，必须拆。
- 测试：7 个专项文件 85 例（browse 32、browsejob 6、watch 6、ocr 7、footprint 5、voices 14、outing 15）；加 `p7.test.mjs:85-186` 的 7 个 cover/browse/observe 用例才是 92；另有 p4/p6/p5/tools/policy/surface/restrict 约 43 个分散用例。`p7.test.mjs` 不能整文件搬。
- `bili.js` 确无直测，`RISK_CODES` 未导出；`video.js` 也无直测；`observe` 的 B 路由只测了 `/away`、`/cover`。

**修订方向**：修订版 §7 给逐文件清单与归属；§12 给迁移测试矩阵，明确「哪些文件整搬、哪些拆、哪些留 core、哪些新增」。

### P0-7 工作台插件的打包元数据不完整

`dsh-wx` 证明独立包、`ctx.provide`、工具、systemPrompt、会话都成立；但 `dsh-wx` 没有 UI/路由。工作台 section 的唯一先例是 `dsh-fish`：

- `package.json` 必须有 `exports["./client"]` 与 `dsh.client.platform="web"`，否则宿主 client-modules 不会加载 `client.js`。
- 客户端用 `window.__ModuleLoader__.load` + `inject:['slots']` + `ctx.slots.register({ name:'settings.section', id:'dsh-bili', order:8 })`；id 不能复用 `fish`。
- 宿主 0.2.1-rc.5 的 settings 用 `ctx.slots.entries("settings.section")` 枚举多节，原设计「不支持多 section 就退回 core 壳」不必要；只应作为旧版兼容，并加版本门控，避免双实现。
- `/dsh-bili/*` 路由可以用 `webServer.register({kind:'prefix'})`，但必须像 `/dsh-fish` 一样过 `connection.requestRejection` 信任栅栏。
- 服务判空要接受 `undefined`（宿主缺服务多为 `undefined`），不要只判 `null`。

---

## 3. 重要缺口（P1）

### P1-1 事件 v3 的校验与迁移不完整

原设计只说「加 surface、加 bili_reply、读路径补默认值」，没有定义：

- `surface` 的写时白名单与未知值处理（拒绝还是落 core）。
- `bili_reply` 的 `reply` 子对象校验：必填、长度、空文本占位、`rpid` 去重键。
- v2 读者遇到 v3 的跳过行为（`store.readEvents` 已有 `newer` 计数，够用，但要写进验收）。
- 备份文件头版本、恢复 v2 备份的升级路径。
- `events.js` 的事件目录登记（`AGENTS.md` 第 5 条要求新增类型必须改 `schema.js` 并在 `events.js` 登记）。
- `CHANGELOG.md` 迁移说明。

修订版 §5.3/§5.7 补齐。

### P1-2 `cseen` 语义需要状态机

原设计保留「`cseen` 只在真的回复时写」，同时新增 `bili_reply` 去重。用户已裁定改为「呈现即记」。需要明确：

- `bili_reply` = 观察到（去重键 `reply.rpid`）。
- `cseen` = 已投递给她看（v3 起）。
- `creply` = 她已经回了。
- 旧 `cseen`（v2）= 已回，读时按「已回」处理；不能把旧数据误判成「待回复」。
- 投递失败时 `cseen` 不应提前写，或写 `biliout:` 投递记录作为二次确认。

修订版 §6.2 给三态状态机与迁移规则。

### P1-3 `bili_watch` 没有写 `saw`

原设计目标 3 说「她看的、回的、别人回的」进记忆，但 `bili_watch` 现在只写 `watched:` meta。上游 person-core 明确要求 `bili_watch` 写 `saw`（title + OCR）。不补，目标 3 落空。

### P1-4 `bili_speak` 的 utterance 缺少线程与失败语义

原设计只写 `utterance` + 旧 meta，没有：

- `refs` 线程键（bvid / rpid / parent）。
- `my:<rpid>` 去重，防重复入账。
- 失败/不确定时不写 utterance；`action: confirmed | unconfirmed | failed` 的投影。
- 发评论成功但写事件失败时的补偿或明确「以平台回执为准」。

上游 return-contract §5.2 已给出 `bili_speak` 的投影要求，原设计引用错了章节（§6 是 Prompt 重编译，不是投影）。

### P1-5 `config.patch` 与命名空间

- `config.patch` 现在是空桩（`core-service.js:95`）。
- 原设计说「键名沿用顶层键，不做重命名迁移」，上游说「写 `bili.*` + 双读」。两者需要统一。
- 全库没有 `config/changed` 广播；不能假设宿主有。
- `LIMITS` 缺 `browse.rankingTids`、`video.enabled`/`video.ocr` 布尔归一；`browse.keywords` 无 UI。

修订版 §6.5 用「顶层存储 + `bili.*` 视图 + `config.onChange`」解决，不迁移文件。

### P1-6 owner 的 cookie 暴露面

原设计待决 1 建议 `owner.read()` 返回 cookie 原文。这违反 `owner.js` 现有设计（`publicOwner` 永远不含 cookie）。插件需要 cookie 才能发评论，但不应把原文放进可序列化对象、日志、台账或模型。

修订版 §6.6 改为：

- `owner.read()` 只返回 `publicOwner`（含 `hasCookie`/`hasCsrf`）。
- `owner.credentials()` 返回一个带 `toJSON()/toString()` 脱敏的包装对象，仅进程内使用；core 在调用点记一条审计日志（不含值）。
- `owner.write()` 保留，走 `/owner` 现有 0600 写盘。

### P1-7 工作台兼容期与新页面

原设计没说清楚：

- core 的 8 条 B 路由在 A2/A3 期间是代理还是删除；代理的 404 语义与文案。
- core 的「上网」页签隐藏方式（不能用 `display:none` 假装不存在）。
- 抽帧图、台账、待回复正文、风控解冻的鉴权与脱敏。
- 出门页只读，不提供「替她发评论」按钮（原设计已提，要保留）。
- 插件停用后出门会话仍在，但不再被投递；页面如何表达。

修订版 §10 补齐。

### P1-8 测试矩阵不足

原设计只列了「92 个迁移 + 新增几类」，没有：

- 契约测试（接口签名、错误、并发、幂等）。
- 迁移测试（v1/v2/v3 混合、备份恢复、旧 cseen）。
- 隐私测试（微信原话不出现在 B 站 prompt/评论）。
- 插件缺席测试（core 不报错、页面降级、工具数回到 5）。
- 晚加载测试（restrict 已生效后贡献工具）。
- 双调度测试（同分钟只一次）。
- 真机验收矩阵（8710/8720/Windows 同步）。

修订版 §12 给矩阵。

### P1-9 可观测性缺失

拆包后出问题最难查的是「插件没装上」「钩子没跑」「贡献没生效」「会话没复用」。原设计只有日志一句话。修订版 §13 定义：

- 启动自检行：插件版本、service 是否 provide、贡献工具数、restrict 状态、会话 id。
- 运行时计数：browsedToday、outingsToday、waiting、riskUntil、lastOutingAt、biliSaid/biliReplies。
- 失败分类：`BILI_PLUGIN_ABSENT`、`BILI_CONTRIBUTION_PENDING`、`BILI_SESSION_MISSING`、`BILI_HOOK_FAILED`。
- 隐私：所有日志过 `guard.looksLikeSecret`，不打印 cookie/正文。

### P1-10 回滚与双读

- v3 不可降级：v2 代码读 v3 会跳过并计数，等于看不到新事件；回退前必须备份。
- 插件回滚：A2 后 core 已删 B 文件，不能只停插件；需要保留一个版本的兼容代理与降级路径。
- 配置双读：顶层键与 `bili.*` 视图必须在同一份 config 上工作，避免分叉。
- 双调度：A2 必须同时删 core 的 `backgroundBrowse`/`maybeOuting`/`lookBeforeWake` 调用，否则日志会出现同分钟两次刷站。

### P1-11 A3 范围与上游非目标冲突

上游 person-core §2 曾把「第一版 UI 暂留 core」列为非目标。原设计 A3 全量迁移是范围扩大，需要用户明确授权。用户已选择「全量迁移」，修订版把它写成显式授权，并保留 A3a/A3b 的可回退切分。

---

## 4. 与上游设计的一致性

| # | 上游说 | 原设计说 | 裁定/修订 |
| --- | --- | --- | --- |
| 1 | person-core：recall 去通道过滤，整份事件流可搜 | §3.3/§5.1/§6.3：channel 决定召回范围 | **用户裁定按通道过滤**；修订为两层模型：原始层隔离、学习层共享 |
| 2 | person-core：旧事件按 B 站前缀/channel 推断 surface | §6.1/§6.4：旧事件默认 core | **用户裁定按规则推断**；修订版 §5.3 给推断表 |
| 3 | person-core：cseen=已呈现、creply=已回，scan 从事件取未呈现 | §6.2：cseen 只在 replyReply 写 | **用户裁定呈现即记**；修订版 §6.2 给三态状态机 |
| 4 | person-core：config 写 `bili.*`，双读测试 | §5.5：顶层键，不迁移 | 修订版：顶层存储 + `bili.*` 视图 + 双读测试，不迁移文件 |
| 5 | 顶层/person-core：owner 只读，暴露前安全评审 | §5.6：读写，cookie 原文待决 | 修订版：`read()` 公开信息、`credentials()` 脱敏包装、`write()` 保留 |
| 6 | 顶层：`surface.register` 不声明 tools，单一策略表 | §5.2/§5.8：`surface.contribute` 声明 tools；插件直挂 section | 修订版：改名 `toolPolicy.contribute`；section 走 `prompt.section` 统一封装 |
| 7 | person-core：dsh-bili 自己调度 | §7.1：core 单 tick + onTick | **采用原设计**（单调度更安全），但补 `onWake`；记为对上游的偏差并更新上游文档 |
| 8 | person-core：新写入可停 `cbody`，观测台读 utterance | §6.2：保留 `comment/creply/cbody` 全部 meta | 修订版：A1/A2 保留 `cbody` 兼容，A3 起读 utterance，`cbody` 标 deprecated |
| 9 | person-core：`bili_reply` 用 text+refs，不新增字段 | §6.1：新增 `reply` 子对象 | 修订版：保留 `reply` 子对象，但补 schema/校验/迁移测试；理由：去重键必须是结构化 rpid |
| 10 | person-core 非目标：第一版 UI 暂留 core | §8：A3 全量迁移 | **用户裁定全量迁移**；修订版把它写成显式范围扩大，保留 A3a/A3b 切分 |

---

## 5. 范围与交付状态问题

1. **A3 全量迁移是范围扩大**：已获用户授权，但必须单独验收、单独回滚，不能当作 Phase 4 的自然延伸。
2. **Windows 仓严重落后**：`/mnt/d/fish-handoff` 停在 11-02，落后 107 个提交，且有未提交改动。继续按「Windows 修改 → WSL 拉取」的旧流程会制造冲突。修订版架构文档明确：WSL `main` 是当前交付主线，Windows 仓先对齐再使用。
3. **8720 未运行**：dev 实例已退出。A1/A2 的 v3 验证需要先启动 8720（独立 fish home），不能拿 8710 当试验田。
4. **README 陈旧**：根 README 第 26 行说「B 站独立出门会话、dsh-bili 拆包、事件 v3 未做」，其中出门会话已落地；`src/dsh-fish/README` 第 129/131 行更准确。修订版把 README 更新列入 A0。
5. **`f53bd0c` 未推送**：评审基线只在 WSL 本地；正式进入 A1 前应推送，避免 Windows/WSL 两侧继续分叉。
6. **`src/dsh-wx/lib/sticker-panel.mjs` 只在 dev worktree 未跟踪**：与本次设计无关，但说明 dev 线有未收敛文件；A0 应先决定它去留，避免拆包时混入无关改动。

---

## 6. 修订版必须回答的问题（验收清单）

修订版设计 `2026-11-10-bili-workbench-integration-design-v2.md` 必须逐条回答：

- [ ] 两层记忆模型的字段、写入规则、召回规则、跨面渲染规则、隐私测试。
- [ ] v1/v2/v3 事件混合的读路径推断表；未知值处理；备份/回滚。
- [ ] `memory` / `toolPolicy.contribute` / `schedule.onTick+onWake` / `prompt` / `config` / `owner` / `tools.wrap` / `toolLedger` / `sessions` 的完整契约。
- [ ] 15 个 B 专属模块 + `prompts.js`/`client.js`/`observe.js` 的逐文件归属。
- [ ] A0/A1/A2/A3 每阶段的前置、改动、验收、回滚、测试数。
- [ ] `cseen`/`creply`/`bili_reply` 三态状态机与旧数据迁移。
- [ ] `bili_speak` 的 utterance/线程/失败语义；`bili_watch` 的 saw。
- [ ] 工作台 section 的打包元数据、路由、鉴权、降级、兼容期。
- [ ] 隐私威胁模型：cookie、微信群聊原话、外来文本、日志/台账/模型。
- [ ] 测试矩阵：单元/契约/集成/迁移/真机/性能。
- [ ] 可观测性与故障分类。
- [ ] 交付状态：Windows/WSL、8710/8720、推送、部署、验收边界。

---

## 7. 评审结论

**不建议按原设计直接开 A1。** 建议按修订版的 A0 → A1 → A2 → A3 推进：

- A0 解依赖、补文档、对齐基线（不改行为）。
- A1 接口 + 事件 v3 + 两层记忆（B 站代码仍在 core，行为变化限制在记忆层）。
- A2 搬 15 个模块 + 3 个工具 + 调度钩子 + 路由，core 删直接调用、留兼容代理。
- A3 工作台全量迁移 + 证据面 + 配置补全，core 留一个版本的代理。

原设计的方向、三个硬约束、不变量的大部分仍然有效；修订版保留这些骨架，补齐的是「边界、接口、迁移、验收」四件事。
