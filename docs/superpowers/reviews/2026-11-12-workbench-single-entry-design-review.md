# 独立评审：大肥鱼工作台单入口设计

- 日期：2026-11-12
- 评审对象：`docs/superpowers/specs/2026-11-11-workbench-single-entry-design.md`（`dev@7f1ade1`）
- 评审基线：`src/dsh-fish` 0.8.0（A1 已落地并运行在 8710）、`/opt/fish/workbench`（未入 Git）、8711/8710/8788 现网
- 方法：三路独立只读评审（功能覆盖、运维与安全、架构一致性）+ 对关键代码与现网行为的抽查复核
- 结论：**方向成立，但不能按现稿进入 P0。** 功能覆盖不完整，P3 的“从 8788 能完成此前所有面板操作”无法验收；另有 6 类会直接阻塞落地的问题（BFF 请求头、数据迁移、Windows 交付链、XSS、Host 校验、A2 与 P0–P3 的顺序/路由归属）。

---

## 0. 结论摘要

设计把“搬入口、不搬运行时”的边界划得很清楚，BFF + 白名单 + 双入口过渡的思路也成立。问题在于它把现状想小了：

1. **旧面板的配置面远大于 §6「环境」列出的子集。** `settings.js:182-186` 的 `CONFIG_PATCH_KEYS` 有 16 个顶层键，设计只覆盖了其中一部分。
2. **旧面板的写操作远多于 P2 清单。** `/owner`、`/decide`、`/inbox`、`/notify`、`/risk`、`/avatar` 都有 POST，P2 一条没列。
3. **v2 A3 承诺迁入工作台的「出门 / 证据面」在八项导航和白名单里整体消失。**
4. **8788 现在的能力远不止“QQ/微信桥 + 健康检查”。** 通道页只写“现有卡片”，没有逐项清点，重做时会丢功能；其中“以她的身份发一句 / 微信窗口打字”还和设计的一句话边界冲突。
5. **白名单模型表达不了真实路由。** `/cover/<BV...>`、`/media/<name>.svg`、`/avatar/info`、`/comment-body?bvid=&rpid=`、`PUT /config|/owner` 都不是扁平 `{ path, methods }` 能覆盖的。
6. **BFF 契约只写了响应侧，没写请求头。** 浏览器 `Origin`/`Host`/`Sec-Fetch-*` 若透传给 8710，会被 dsh 信任栅栏拒绝，所有经 BFF 的写请求 403。

因此这份设计需要一次结构性的修订，而不是补几个按钮。

---

## 1. 功能遗漏（P0：按现稿实施会丢功能）

### P0-1 旧「成长 / 上网 / 记忆 / 插件」页的大量配置项没有归宿

**证据**

- `src/dsh-fish/lib/settings.js:182-186`：
  `growthDays, wakesPerDay, window, daily, diary, absenceAfterDays, avoid, browse, video, comment, notify, chat, memory, tools, observe, ui`
- `src/dsh-fish/lib/client.js`：
  - `1511-1555` 成长：`growthDays`、`wakesPerDay`、醒来时段、`chat.replyChars`、`daily.events/questions`、`absenceAfterDays`、`diary.enabled/visible/keepDays`、`memory.sleepEveryDays/sleepKeep`
  - `1648-1794` 上网：`browse.perDay/topN/deepRead/danmaku/voices/window`、`video.enabled/perDay/frames`、`avoid.keywords/minDuration/upMids`、`comment.enabled/perDay/replyPerDay/replyToReplies/scanEveryMin/window/atOwner`
  - `1897-1904` 记忆：`chat.rotateAfter`、`memory.docBudget`、`memory.beliefsShown`
  - `1004-1037` 插件：工具面白名单 `tools`
  - `1406-1422`：`ui.ownerHintDismissed`
- 设计 §6「环境」只列“醒来时间、每天事件数、刷站开关/次数/时段/分区/关键词、评论配额”。

**后果**

按 §6 字面实现，成长节奏、日记、深度思考、视频画面、黑名单、评论扫描间隔、上下文轮转、记忆预算、工具白名单、通知开关都没有编辑入口；P3 的“完成此前所有面板操作”不成立。

**建议**

在 §6 增加“配置键 × 页面 × 读写方式”矩阵，把 16 个顶层键逐项落位；至少补 `growthDays/wakesPerDay/window/daily/diary/absenceAfterDays`、`avoid.*`、`video.*`、`comment.*`、`chat.*`、`memory.*`、`tools.*`、`notify.enabled`、`ui.ownerHintDismissed`。P2 按页面分组验收，而不是只写“环境页 /config”。

---

### P0-2 P2 写操作清单漏掉多条导航里明确列出的写路由

**证据**

| 路由 | 方法 | 用途 | 证据 |
| --- | --- | --- | --- |
| `/owner` | GET / POST / PUT | 保存 B 站 cookie、账号、`test:true` 验证 | `observe.js:372-427` |
| `/decide` | POST | 裁决她提的申请 | `observe.js:336-370` |
| `/inbox` | GET / POST | 标记信箱已读 | `observe.js:750-762` |
| `/notify` | GET / POST | 标记已提醒、开关通知 | `observe.js:900-923` |
| `/risk` | GET / POST | 风控解冻 `{clear:true}` | `observe.js:654-664` |
| `/avatar` | GET / POST | 上传/移除头像 | `observe.js:588-611` |
| `/config` | GET / POST / PUT | 环境参数、工具白名单 | `observe.js:272-335` |

设计 P2（§8）只列 `/config`、`/wake`、`/away`、`/wx/scan`、`/say` 和四个数据危险操作。

**后果**

- 按 P1“只调 GET”实现，上述按钮全部 405/404。
- `/notify {shown:true}` 写不进去，通知会每 60 秒重复弹。
- B 站登录、规则裁决、信箱已读、风控解冻、头像全部不可用。

**建议**

P2 逐条登记上述方法与确认方式；“工具与规则”页还要明确 `POST /config`（仅 `tools` 键）归它还是归环境页。

---

### P0-3 v2 A3 的「出门 / 证据面」整体消失

**证据**

- 设计 §11.2（332 行）明确写：“A3 原计划把 B 站设置页、足迹、**出门、证据**迁进插件的 `settings.section`；现改为迁进 8788 工作台。”
- 但 §6「B 站」只有“视频足迹、评论足迹、待回复正文、浏览统计、登录状态、风控、手动唤醒”，路由只有 `/footprint /browse /history /comment /comment-body /owner /risk /wake /away`。
- v2 §10.2/§10.3 要求：
  - 出门页：今日次数/配额、最近出门、投递记录、会话入口、待回复
  - 证据面：抽帧拼图 `GET /sheet/<bvid>`、台账单条 `GET /ledger`、待回复正文 `GET /comment?waiting=1`、风控解冻 `POST /risk {clear:true}`
- 现状：`fishCore.toolLedger` 有进程内服务，但 `observe.js` **没有 `/ledger` HTTP 路由**（grep 无结果）；`/sheet`、`/outings` 也不存在。`outing.js` 只有 `biliout:` 记账，没有对外读接口。

**后果**

v2 A3 的核心交付没有落点；“风控解冻”只在导航里出现一次，P2 没有；“台账”工作台根本读不到。

**建议**

在 B 站页下设「出门」「证据」子区（或独立导航），补：
- `GET /sheet/<bvid>`（抽帧拼图）
- `GET /ledger?date=&session=&tool=`（台账）
- `GET /outings` 或 `GET /comment?waiting=1`（出门记录/待回复）
- `POST /risk {clear:true}`（解冻，二次确认）
若决定不迁，必须同步改 §11.2 与 v2 §10，不能两处互相矛盾。

---

### P0-4 8788 现有能力被低估，通道页没有逐项清点

设计 §2 说 8788“目前只做 QQ / 微信桥与 8710 健康检查”，实际还有：

| 能力 | 现状 API | 设计归宿 |
| --- | --- | --- |
| QQ 启动/停止/重启 | `POST /api/qq/start|stop|restart` | 通道页，未清点 |
| NapCat 面板/token/登录页/二维码 | `GET /api/qq/panel`、`/api/qq/qr` | 通道页，未清点 |
| QQ 会话列表/历史/**以她的身份发一句** | `/api/qq/recent|history|send` | 通道页，未清点，且与“不能替她活”冲突 |
| QQ 掉线提醒/测试通知/说话频率 | `/api/watch`、`/api/speech` | 未清点 |
| 微信启动/停止/画面/点击/打字/回车/存图/补扫/关多余/清理 | `/api/wx/*`、`/api/gc` | 通道页，未清点 |
| 她的打开/启动/停止（hold 免打扰） | `/api/her/open|start|stop` | 无导航归宿 |
| 动作日志（最近 20 条） | `/api/status` 的 `log` | 无导航归宿 |
| 帧存档缩略图 | `/api/frames`、`/api/frames/<name>` | 数据迁移有，UI 无归宿 |
| 诊断/窗口/截图 | `/api/diagnostics`、`/api/wx/windows|shot` | 无（当前无按钮） |

**后果**

- “通道页只放现有卡片”会把上面这些能力的存在性藏起来；重做时容易丢。
- “以她的身份发 QQ / 在微信窗口打字回车”与设计第 18 行“工作台可以替人「看」和「按按钮」，不能替她「活」”以及第 175 行“不提供替她发评论”直接冲突。设计必须明确：保留、隐藏，还是限权。
- “停止她”和动作日志是排查通道问题的唯一入口，八项导航里没有位置。

**建议**

§4/§6 增加“通道页能力清单”，逐项标保留/移除/限权；总览增加“她”状态卡（打开/启动/停止 + 8710 健康）和动作日志，或明确写出移除理由。

---

### P0-5 主入口位置错误，聊天入口没有进信息架构

- `/wake`、`/away` 只放在「B 站」页。但叫醒是全局状态条动作（`client.js:1133-1138`），重置后的引导也明确让用户点“叫醒大肥鱼”（`client.js:891-911`）；“你不在的时候”也在「现在」页（`client.js:1498-1508`），与 B 站无关。
- 聊天入口 `/api/her/open` 只在拓扑图里，八项导航没有“找她”入口。点了之后浏览器会拿到带 `?token=` 的 8710 地址（`her-open.sh` 实测返回 `redirect_url`），与 §4/§5.1/§9 的“浏览器无 token”承诺冲突。

**建议**

- `/wake` 放回总览状态条；B 站页保留 `POST /wake?focus=browse`（dev）。
- `/away` 放回总览或新增“她”区域。
- 总览明确“打开她的界面”按钮，并把“无 token”限定为 `/api/fish/*` 管理流量，聊天入口单列例外。

---

### P0-6 白名单模型不覆盖真实路由

设计 §5.2 是扁平静态表：

```js
{ path: 'status', methods: ['GET'], upstream: 'fish' }
```

真实路由包含：

| 形态 | 例子 | 证据 |
| --- | --- | --- |
| 动态子路径 | `/cover/<BV...>` | `observe.js:565` 正则 |
| 动态子路径 | `/media/principle-*.svg` | `observe.js:617` 正则 |
| 固定子路径 | `/avatar/info`、`/backup/restore`、`/log/export` | `observe.js:590/1038/1011` |
| query | `/comment-body?bvid=&rpid=`、`/events?type=&limit=`、`/inbox?limit=`、`/update?ms=` | 各路由 |
| PUT | `PUT /config`、`PUT /owner` | `observe.js:277/382` |
| 二进制/下载 | `cover`、`avatar`、`media`、`log/export`、`backup` | 各路由 |

**后果**

按静态表实现，封面、头像、原理图、日志导出、恢复、登录保存、通知标记、判断裁决、信箱已读都会 404/405；若为了支持子路径改成简单前缀转发，白名单就退化成开放代理并引入路径穿越。

**建议**

表项改为：

```js
{ path, methods, upstream, pattern?, maxBody?, timeoutMs?, binary?, headers? }
```

`pattern` 用显式正则（`cover` 只允许 `^/BV[0-9A-Za-z]{10}$`，`media` 只允许 `principle-[a-z]+\.svg`），并补路径穿越测试。

---

### P0-7 传输方式与阶段遗漏

| 功能 | 现状 | 设计缺口 |
| --- | --- | --- |
| 日志导出 | `GET /log/export`，`text/plain` + `Content-Disposition` | §6 列了路由，P1/P2 没分配；若按 JSON 处理会坏 |
| 检查更新 | `GET /update?ms=` | §6 列了，P1/P2 没分配 |
| 数据路径 | `GET /paths` | §6 列了，P1/P2 没分配 |
| 报告导出 | 客户端 Blob | 记忆页只列 `/reports`，没写导出 |
| 导入模板 | 客户端 Blob | §5.4 只写一句条件提示，模板和边界说明会丢 |
| 备份下载 | `GET /backup`（实测 47MB）、`POST /backup/restore`（96MB） | P1 和 P2 都写了“备份下载”，重复；默认 30s 超时不够 |
| 头像元信息 | `GET /avatar/info` | §6 路由表没有 |
| 清日志 | `POST /log/clear` | §6 路由表没有，只在 §5.4/P2 出现 |
| 大 body | `/say` 12MB、`/avatar` 4MB、`/import` 200KB | 默认 256KB 会 413 |

**建议**

按路由逐条写 `methods / maxBody / timeoutMs / binary / download`，并明确 `/log/export` 与 `/backup` 用流式透传、不 JSON 化。

---

## 2. 落地阻塞（非功能，但决定 P0 能不能做）

### B1 BFF 请求头透传会让所有写请求 403

**证据（评审期间实测）**

- 带 cookie 访问 `8710/dsh-fish/status`，加 `Origin: http://127.0.0.1:8788` → 403。
- 加 `Sec-Fetch-Site: cross-site` → 403。
- 加 `Host: localhost:8710` → 403。
- 上游栅栏代码：`/opt/dsh-x64/node_modules/.pnpm/@deepseek-ai+dsh-client-connection@0.2.1-rc.5_*/lib/index.js:240-250`，要求 Host 为 loopback/trusted，且 Origin 必须与 Host 同 authority。

设计 §5.1/§5.3 只写了“后续请求带 Cookie”“响应头只改写 Set-Cookie/Location”，没有请求头白名单。

**建议**

BFF 只向上游发送 `Cookie`、`Content-Type`、`Accept` 等必要头；固定 `Host: 127.0.0.1:8710`；剥离浏览器 `Origin`、`Referer`、`Sec-Fetch-*`、`Host`、`Cookie`；补“带浏览器 Origin 的 BFF 写请求能成功”的测试。

---

### B2 数据迁移只 `mv` 目录，旧 `watch.json`/`frames/` 不会进新路径

**证据**

- 设计 §7.3 只有 `mv /opt/fish/workbench /opt/fish/workbench.pre-repo` + `ln -s`。
- `server.mjs:515` `WATCH_PATH = join(HERE,'watch.json')`、`server.mjs:55` `FRAMES = join(HERE,'frames')`。
- 现值：`watch.json = { enabled: true, pollSeconds: 30, nagMinutes: 0, notifyRecover: false }`；默认值（`server.mjs:516`）是 `15 / 10 / true`。
- `frames/` 目前为空，但迁移方案不能依赖“现在为空”。

**后果**

新服务读不到旧数据，会回落到默认值；回滚后旧服务读 pre-repo、新服务写 `WORKBENCH_DATA`，形成两套数据。若 `WORKBENCH_DATA` 不存在且没有 `mkdir -p`，`saveWatch()` 会失败。

**建议**

停服务 → `mkdir -p` → 复制（不是移动）`watch.json`、`frames/` 到新路径并留时间戳备份 → 切 symlink → 起服务 → 回读校验 → pre-repo 只读封存；回滚步骤写清数据回拷/冻结规则。

---

### B3 迁移白名单会切断 Windows 通知、打包和启动链

**证据**

- `server.mjs:40` 引用 `join(HERE,'notify.ps1')`；`host/win.mjs:20` 依赖它。
- `pack-deliver.ps1` 打包 `notify.ps1`、`build-exe.ps1`、`install-startup.ps1`、`run-server.cmd`、`fish-up.sh`、`launcher/`、`deploy/`；`build-exe.ps1` 需要 `launcher/FishWorkbench.cs`；`fish-up.sh` / `boot-chain.ps1` 会启动 Windows 侧 `node server.mjs`。
- 设计 §7.1 把 `*.ps1`、`launcher/`、`dist/`、`deploy/`、`*.cmd`、`fish-up.sh` 全部排除在仓库外。
- Windows 侧工作台副本与 WSL 侧已分叉（评审时可见）。

**后果**

Windows 通知静默失效；打包脚本会把 pre-repo 的旧 `server.mjs`/`index.html` 打进交付包；新 Windows 克隆无法生成 exe；`fish-up.sh`/`boot-chain.ps1` 可能和 WSL systemd 形成两个 8788。

**建议**

二选一并写死：
- Windows 交付仍在用 → 把 `notify.ps1`、`launcher/`、`deploy/`、打包/启动脚本一并入仓，并把数据路径改到 `WORKBENCH_DATA`；
- 已退役 → 明确写“退役”，删除启动脚本里的 Windows 分支，避免双实例。

---

### B4 设计没有把不可信文本转义列为硬约束（同源 XSS 可直接打危险路由）

**证据**

- 新工作台要渲染事件、日记、判断、B 站评论正文、微信消息、QQ 消息。
- 现有 `index.html` 大量使用 `innerHTML`（297、321、327、613、725 行），只有部分走 `escapeHtml`。
- `index.html` 的 8788 无账号体系；BFF 暴露 `/reset`、`/backup/restore`、`/import`、`/owner`，同源脚本可以带合法 Origin 直接调用。

**建议**

- 所有不可信文本必须 `textContent` 或统一转义函数渲染；禁止把上游文本拼进 `innerHTML`。
- 至少加 CSP `default-src 'self'`、`X-Content-Type-Options: nosniff`。
- §9 增加评论正文、日记、微信消息、QQ 昵称的 XSS 用例。
- 危险写路由可再加进程内随机令牌，不只依赖 Origin。

---

### B5 8788 缺少 Host/DNS rebinding 校验

**证据（评审期间实测）**

`curl -H 'Host: attacker.example:8788' http://127.0.0.1:8788/api/status` → **200**。

设计 §5.3 只校验写请求的 `Origin` 和 `Sec-Fetch-Site`，没有 Host 白名单。

**建议**

所有请求校验 `Host` 必须是 `127.0.0.1:8788` 或 `localhost:8788`；`Sec-Fetch-Site: cross-site` 一律拒绝；保留写请求 Origin 校验。

---

### B6 认证假设与实测不符，重认证没有单飞

- 8710 的 cookie 是 30 天持久签名 cookie（`Max-Age=2592000`），普通 `/dsh-fish/*` 响应不发 `Set-Cookie`。**dsh-web 重启后 cookie 很可能仍然有效**，设计 §9“重启后 token 旋转 → 下一次调用自动重新握手”的验收可能永远不触发。
- `/dsh-fish/status` 未认证返回 403；业务 403（风控/权限）也是 403，BFF 无法区分。
- 页面并发请求会同时触发 N 次握手；8711 在 dsh-web 刚重启、日志还没 token 时返回 503。
- 8788 的聊天/QQ WebUI 会向浏览器返回带 `token=` 的 URL，与 §4/§5.1/§9 的“浏览器无 token”冲突。

**建议**

- 验收改成“cookie 失效（过期/凭据被清）时，401/403 能触发一次重认证并重放成功”。
- 重认证用共享 in-flight Promise 单飞；区分“未认证 / 业务 403 / 上游不可达”，分别映射。
- 把“无 token”限定为 `/api/fish/*` 响应与日志；聊天入口单列例外，或改成一次性兑换码。

---

### B7 带副作用的 GET 与“只读页面”冲突

- `GET /comment` 会现扫 B 站（`observe.js:929-951`）。
- `GET /comment-body` 会访问 B 站（`observe.js:482-507`）。
- `GET /selfcheck?net=1` 会联网（`observe.js:510-537`）。
- `GET /inbox` 会重写 `inbox.md`（`observe.js:750-762`）。
- `GET /paths` 会 `ensureDataReadme`（`observe.js:792-794`）。
- `/cover` 缺图时会去 B 站拉取（`observe.js:564-581`）。

任何网页都可以用 `<img src="http://127.0.0.1:8788/api/fish/comment">` 触发扫描，消耗 B 站风控配额。

**建议**

对这类 GET 也做 `Sec-Fetch-Site` 同源校验，或改成 POST；页面只在明确动作时调用；§9 加“跨站 GET 不能触发扫描”的测试。

---

### B8 systemd 与回滚方案过于乐观

- 设计 §7.3 的 systemd 片段漏掉现有 `Environment=HOME=/home/str1k3`、`DISPLAY=:99`、`StandardOutput/StandardError=append:/home/str1k3/workbench.log`（`fish-workbench.service:11-19`）。按片段整段替换会坏微信截图、xdotool、`~` 展开和日志落盘。
- `/opt/fish/workbench` 直接指向临时 worktree，worktree 被清理后 systemd 会 `Restart=always` 循环。
- 设计 §10 回滚只写“符号链接指回 pre-repo”，但新数据已写到 `WORKBENCH_DATA`，回滚后两套数据分叉。

**建议**

在现有 unit 上追加 `WORKBENCH_DATA`，保留 HOME/DISPLAY/日志；部署到稳定的 `/opt/fish/workbench-current` 符号链接，不直接指临时 worktree；回滚写明数据回拷/冻结。

---

### B9 BFF 错误契约会丢掉业务故障码

设计 §5.3 说“上游 Content-Type 与状态码原样透传、不改写业务 JSON”，§5.3 末又说错误统一成 `{ ok:false, error, upstreamStatus? }`。v2 §13.3 的 `BILI_PLUGIN_ABSENT`、`BILI_CONTRIBUTION_PENDING`、`BILI_SESSION_MISSING`、`BILI_HOOK_FAILED`、`BILI_RISK_COOLDOWN` 都是 `code`；`/config` 400 还带 `unknown` 数组。包一层会丢字段。

**建议**

默认原样透传上游状态码与 body；若必须统一，保留 `code`、`unknown` 等业务字段，或把原始 body 放 `upstreamBody`。

---

### B10 A2 与 P0–P3 的顺序、路由归属、旧面板移除没有定

- 设计没有写 A2 和 P0–P3 谁先谁后；§11.2 只说“A2 完成后白名单把 upstream 从 fish 切到 bili”。
- v2 §4.3/§10.1 要求 A2 从 `client.js` 拆出 B 页面、`dsh-bili` 注册 `settings.section`；但本设计 P3 又要“下一版本移除插件面板的浏览器 UI”。A2 先做会先造 section 再拆掉；P3 先做则 A2 的 client 拆分成为死代码。
- “B 站项整组切 upstream”不成立：`/browse`、`/comment-body`、`/owner`、`/wake`、`/away` 在 core；v2 的插件路由只有 `/sheet`、`/ledger`、`/comment`、`/risk`、`/status`、`/history`、`/footprint`。
- core B 路由的生命周期冲突：本设计说“永久保留”，v2 §10.4/ARCHITECTURE §10 说 A3 后删除。
- v2 A3 的验收/回滚仍写 `settings.section`，与本设计冲突；P3 的移除范围（只注销 slot，还是删 `client.js` + exports + `dsh.client`）没有定义，且与 §9“本设计不应改插件代码”冲突。

**建议**

先冻结三张矩阵再开工：
1. 路由归属：`path / method / owner(fish|core-proxy|bili) / upstream / pattern / body / timeout / 缺席行为`
2. 配置键：`16 个顶层键 → 页面 → 只读/可写`
3. 现有 8788 按钮：保留 / 移除 / 限权

并明确：
- A2 只做后端拆包，不建 `dsh-bili/lib/client.js`、不注册 section；或把客户端拆分整体后移。
- 插件 `/dsh-bili/*` 永久保留；core `/dsh-fish/*` 代理保留到 P3 后一个版本。
- 新增 P4“移除旧面板 UI”，写清只注销 slot 还是删文件，并更新测试口径。

---

## 3. 现有功能 → 新设计归宿（对账摘要）

| 现有页/能力 | 现状路由 | 新设计归宿 | 判定 |
| --- | --- | --- | --- |
| 状态条/时间线 | `/status`、`/state` | 总览 | 覆盖 |
| 叫醒 / 让她去刷 B 站 | `POST /wake`、`/wake?focus=browse` | B 站 | 位置错，应回总览 |
| 你不在的时候 | `GET /away` | B 站 | 位置错；且设计误当写操作 |
| B 站登录 / cookie | `GET/POST/PUT /owner` | B 站 | POST 没进 P2 |
| 规则裁决 | `POST /decide` | 工具与规则/总览 | 没进 P2 |
| 信箱已读 | `GET/POST /inbox` | 总览 | POST 没进 P2 |
| 通知去重/开关 | `GET/POST /notify` | 总览 | POST 没进 P2；会重复弹 |
| 头像 | `GET/POST /avatar`、`/avatar/info` | 数据与运维 | 4MB 上限未写；`/avatar/info` 缺 |
| 成长节奏/日记/深度思考 | `POST /config` | 环境（部分） | 大量键无归宿 |
| 上网：刷站/视频/黑名单/评论 | `POST /config` | 环境（部分） | 大量键无归宿 |
| 记忆：上下文/预算/睡眠 | `POST /config` | 环境（部分） | 无归宿 |
| 插件：工具白名单 | `POST /config {tools}` | 工具与规则 | 页面无写方法 |
| 看视频历史 | `/history`、`/browse`、`/cover/<BV>` | B 站 | 动态路径未覆盖 |
| 足迹 / 待回复正文 | `/footprint`、`/comment-body` | B 站 | 正文超时未设 |
| 风控解冻 | `POST /risk {clear:true}` | B 站 | 没进 P2 |
| 出门记录 / 证据面 | 无 HTTP 路由 | 无 | **缺失** |
| 台账 | 仅 `fishCore.toolLedger` | 无 | **缺失 HTTP 入口** |
| 数据路径/更新/日志导出 | `/paths`、`/update`、`/log/export` | 数据与运维 | 无阶段；下载类型未写 |
| 备份/恢复/导入/重置/清日志 | `/backup`、`/backup/restore`、`/import`、`/reset`、`/log/clear` | 数据与运维 | 大 body/超时/模板说明缺失 |
| 报告导出/导入模板 | 客户端 Blob | 记忆/数据 | 未写 |
| 微信会话目录补扫 | `POST /wx/scan` | 通道 | 被误称“扫码” |
| 8788 QQ/微信/她 的全部按钮 | `/api/qq/*`、`/api/wx/*`、`/api/her/*` | 通道（模糊） | 未清点，且“替她发/打字”边界冲突 |
| 8788 动作日志/帧存档 | `/api/status.log`、`/api/frames` | 无 | 无归宿 |

---

## 4. 设计文档需要同步修订的清单

### 本设计

- §3/§4/§6/§8：补 A2 与 P0–P3 的依赖、先决条件、A2 的 client 边界；新增 P4。
- §6：补出门/证据子页、`/sheet`、`/ledger`、`/outings`、`/comment?waiting=1`、`POST /risk`；补插件缺席/停用文案与故障分类展示；补“她”状态卡/动作日志。
- §6：配置改为逐键矩阵，不要只列子集；工具白名单写方法。
- §5.2/§5.3：补动态路径 `pattern`、方法、body 上限、超时、二进制/下载头、错误体透传/故障码保留。
- §5.1/§9：修正“浏览器无 token”的适用范围（排除聊天/QQ WebUI 入口）；补 cookie 生命周期与单飞重认证。
- §5.3/§9：补 Host 校验、XSS/转义、CSP/nosniff、静态路径穿越、跨站 GET。
- §4/§6：把 `/wx/scan` 改为“微信会话目录补扫”；修正 8711 拓扑（只做握手/聊天入口，BFF 业务直连 8710）。
- §8/§9：把 `/away` 改为 GET；补 `/log/export`、`/update`、`/paths`、报告导出、导入模板、`/avatar/info`、`/log/clear`。
- §7.3：补旧数据复制、`mkdir -p`、稳定符号链接、systemd 现有环境变量、回滚数据规则。
- §7.1：补 Windows 通知/打包/启动链的保留或退役决定。
- §11.1：修正节号（“工作台只读”在 §4.1，不是 §1），并补 §3/§3.2/§7.3/§13/§14/§16。
- §9：修正“本设计不应改插件代码”（P3 至少改 slot 注册/文案测试）。

### `ARCHITECTURE.md`

- `:12` §0 读法：删“独立工作台 section”。
- `:80` §3：`dsh-bili` 不再拥有“B 站工作台”。
- `:120-129` §3.2：工作台 UI 不再由插件包提供。
- `:141/147` §4.1：工作台不再“只读为主”。
- `:393-404` §6.8：改为“8788 工作台 → BFF → 插件路由”。
- `:458` §7.3：`ctx.slots.register` 不再是管理入口。
- `:536-563` §10：按新设计重写；10.2 改为过渡期旧入口；10.3 写清 core B 路由保留/删除时间。
- `:584/596` §11：A3 改为工作台阶段；回滚改写。
- `:638-647`、`:667-678` §13：自检/故障展示面改为工作台。
- `:685-692` §14、`:723-729` §16：目标/DoD 与文档链接。

### v2 设计

- §3 不变量 10：保留，但明确由工作台展示。
- §4.3：`dsh-bili/lib/client.js`、`exports["./client"]` 删除或标注仅过渡期。
- §10.1–10.5：UI 归属、出门、证据、A2 代理时间线、插件缺席文案全部改为工作台。
- §11 A3：重定义为工作台 B 页，或声明被本设计取代。
- §12.1/12.4/12.5/12.7：UI 路由/插件缺席/出门页/空白页验收改为工作台。
- §13.1/13.3：自检/故障码展示面改为工作台。
- §14.2 D3/D10、§15、§16、§17：同步改写。

### 其他

- 根 `README.md:27`：“工作台全量迁移”改为“8788 工作台单入口”。
- `src/dsh-fish/README.md` 中 settings.section/设置入口说明标注过渡期。
- 2026-11-10 评审的 P0-7（工作台 section 唯一先例）加“已被 2026-11-11 单入口设计取代”注记。

---

## 5. 建议的阶段与放行条件

**Stage 0（不是代码，是进入门槛）**

1. 冻结路由归属矩阵。
2. 冻结配置键覆盖矩阵。
3. 冻结 8788 现有按钮保留/移除/限权表。
4. 裁定：A2 与 P0–P3 的顺序；A2 是否做 client/section；core B 路由保留多久；P3 移除范围（slot vs 文件）。

**推荐顺序**

1. A2 后端拆包（不含 client/section），补 `/dsh-bili/*` 的出门/台账/抽帧/待回复/风控解冻路由；core 保留代理。
2. P0 工作台入仓 + BFF 骨架（可与 A2 并行），只放通 `GET /api/fish/status`。
3. P1 只读页面（含 B 站/证据/出门/记忆/工具/数据/原理）。
4. P2 写操作（补齐所有 POST、body/timeout、跨站校验、配置键）。
5. P3 入口切换（双入口一致性清单，跑满一个 `dsh-fish` minor）。
6. P4 移除旧面板 UI（新增）。

**放行条件**

- P0 前必须修 B1（请求头）、B2（数据迁移）、B5（Host）、B4（转义约束）的设计缺口；B3（Windows 交付）先有明确决定。
- P1 前必须有路由矩阵、配置矩阵、通道能力清单。
- P3 前必须有双入口逐项一致性清单。
- 以上每条都要落进 §9 验收。

---

## 6. 评审边界

**本次直接复核的事实**

- `CONFIG_PATCH_KEYS` 16 个顶层键（`settings.js:182-186`）。
- body 上限：`/avatar` 4MB、`/say` 12MB、`/backup/restore` 96MB、`/import` 200KB（`observe.js:594/725/1038/1071`）。
- 动态路由：`cover/<BV...>`、`media/principle-*.svg`、`avatar/info`（`observe.js:565/617/590`）。
- `/events` 只支持 `type`、`limit`（`observe.js:227-237`）。
- `/away` 是 GET（`observe.js:559`）；`/ledger` 没有 HTTP 路由（grep 无结果）。
- `watch.json` 现值 `30 / 0 / false`，默认 `15 / 10 / true`（`server.mjs:516`）。
- `server.mjs` 只 import `readFileSync`，却在 `:540` 调 `writeFileSync`（一处现存 bug）。
- `fish-workbench.service` 现有 `HOME`、`DISPLAY`、日志重定向。
- 8788 对伪造 Host 返回 200；8711 Location 带 token；`her-open.sh` 返回带 token 的 URL。

**子代理实测、未由我重复的事实**

- 8710 信任栅栏对 `Origin: http://127.0.0.1:8788`、`Sec-Fetch-Site: cross-site`、`Host: localhost:8710` 返回 403。
- `/backup` 实测约 47MB、0.45s。
- 8710 cookie 为 30 天持久签名 cookie，普通插件响应不发 `Set-Cookie`。

**未确认、需要产品/运行确认**

- Windows 工作台交付是否已正式退役。
- 设计里的“事件检索”是列表筛选还是全文检索。
- 双入口期是否需要保留 8788 现有 3 秒 `/api/status` 轮询。
- 旧面板移除时 `exports["./client"]` / `dsh.client` 的去留。

---

## 7. 总体意见

设计的核心判断——“管理入口收敛到 8788，插件保留运行时与 HTTP 契约”——是对的，BFF 白名单也是对的方向。但它目前是一份**入口搬迁的愿景**，还不是一份可执行的迁移设计：缺少三张对账表（路由、配置键、8788 现有能力），也缺少请求头、数据迁移、XSS、Host 校验这些“一实施就踩”的契约细节。

建议先按本评审 §5 的 Stage 0 补齐矩阵和裁定，再修改设计进入复审；在 B1–B5 与 P0-1–P0-7 闭合前，不要开始 P0 的符号链接切换。
