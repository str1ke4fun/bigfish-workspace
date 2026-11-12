# 大肥鱼工作台单入口设计

- 日期：2026-11-11
- 状态：已被 `2026-11-12-workbench-single-entry-design-v2.md` 取代；原稿保留作对照
- 范围：把面向人的管理入口从插件自带 UI 迁到 8788 工作台；插件继续拥有运行时、调度、数据与 HTTP 契约
- 修订：`ARCHITECTURE.md` §1、§6.8、§10；`2026-11-10-bili-workbench-integration-design-v2.md` §10（A3）

## 1. 结论

管理入口只留一个：**8788 工作台**。

工作台是浏览器唯一直接访问的管理界面；它通过一层 BFF 调 8710 上插件的 `/dsh-fish/*` HTTP 路由。插件仍然是状态、调度、工具和事件流的唯一所有者。搬的是**入口**，不是运行时。

聊天不搬，仍在 8710（经 8711 跳转）。

一句话边界：

> 工作台可以替人「看」和「按按钮」，不能替她「活」。

## 2. 要解决的问题

现状有两个管理入口：

1. 8710 宿主 UI 里的「大肥鱼」设置 section（`src/dsh-fish/lib/client.js`），包含现在、成长、住所、上网、B站、记忆、插件、原理、数据九个页签；
2. 8788 工作台，目前只做 QQ / 微信桥与 8710 健康检查。

由此产生三个具体问题：

- **入口分裂**：B 站相关操作分散在「上网」和「B站」两个页签，QQ/微信又在 8788，用户需要记住哪个功能在哪。
- **面板与工作台重复轮询**：插件面板每 30 秒打 `/status`、每 60 秒打 `/notify`；工作台再算一套，容易形成两套刷新节奏。
- **两套 UI 都要跟着宿主版本走**：`settings.section` 依赖宿主 slot 契约，宿主升级会牵连面板；8788 是独立进程，升级面小得多。

目标不是把插件掏空，而是把「人怎么管她」收敛到一处，同时让插件回归纯运行时。

## 3. 边界

### 3.1 做什么

- 把 8788 工作台扩成唯一管理入口：总览、B站、记忆、环境、通道、工具与规则、数据与运维、原理。
- 新增 `workbench/fish/` BFF：持有 8710 的 token 与 cookie，向浏览器只暴露 `/api/fish/*`。
- 把工作台源码迁进仓库（新顶层目录 `workbench/`），零依赖，运行数据移出源码目录。
- 双入口过渡至少一个发布周期（以 `dsh-fish` 的一个 minor 版本计）：工作台可用期间，插件面板保留但标为旧入口。
- 下一版本移除插件面板的浏览器 UI；插件 HTTP 路由永久保留，作为工作台与未来客户端的契约。

### 3.2 不做什么

- 不迁调度器、tick/wake 钩子、B 站抓取、评论扫描逻辑。
- 不在工作台里写 `events.jsonl`、`config.json`、`state.json` 或任何 `~/.dsh-fish` 下的文件。
- 不新增人格设置入口。`/config` 仍然只收环境参数；导入别人养过的那一位仍走 `/import` 的三条边界。
- 不把聊天搬进工作台。聊天仍由 8710 宿主 UI 提供。
- 不改事件 schema，不改 `channel` / `surface` 分层，不改记忆召回。
- 不做第二套 B 站调度，不新增第二个刷站循环。
- 不把 8788 暴露到 127.0.0.1 之外，不在这一版引入账号体系。
- 不删除插件路由，不移除 `fishCore` 接口。

## 4. 拓扑与职责

```
浏览器
  │  只访问 127.0.0.1:8788，无 token、无 cookie
  ▼
┌─────────────────────────────┐
│ 8788 workbench (Node, 零依赖)│
│  静态页面 / 工作台导航        │
│  /api/fish/*  ── BFF ───────┼──► 8711 ──302──► 8710 /dsh-fish/*
│  /api/qq/*    （现状不变）    │                     │
│  /api/wx/*    （现状不变）    │                     ├─ 插件：调度、工具、事件流
│  /api/her/open（现状不变）    │                     └─ fishCore：记忆、配置、台账
└─────────────────────────────┘
  │
  └─ 聊天入口：/api/her/open → ~/her-open.sh → 8711 → 8710 宿主 UI
```

职责划分：

| 层 | 拥有什么 | 不拥有什么 |
| --- | --- | --- |
| `src/dsh-fish`（未来含 `src/dsh-bili`） | 状态、配置、事件流、调度、工具、HTTP 路由、校验与配额 | 管理界面 |
| 8788 工作台 | 页面、导航、交互、BFF 会话、QQ/微信现有桥接 | 业务校验、事件写入、调度 |
| 8710 宿主 | 聊天、会话、工作区、插件加载 | 管理入口（过渡期除外） |

工作台不是第二个「大脑」。它所有鱼侧读写都走插件 HTTP 路由，插件返回什么就显示什么；工作台不复制配额、不判断风控、不缓存业务数据。

### 4.1 与现有 QQ / 微信通道的关系

工作台现在直接读写：

- QQ：`${H}/dsh-plugins/qq/policy.json`（经 `sync.mjs` 打补丁）；
- 微信：`${H}/.dsh-wx/policy.json`（插件每次调用现读）；
- 语音：`${H}/dsh-plugins/speech/speech.json`。

这些是**通道自己的配置**，不是鱼的记忆，也不是事件流。本设计**保持现状**，不把它们改道到 `/dsh-fish/*`，避免在这一版同时动三条通道。唯一的交集是微信扫码 `/wx/scan`：工作台「通道」页通过 BFF 调 `/dsh-fish/wx/scan`，不直接碰微信进程。

## 5. BFF 契约

### 5.1 认证流程

工作台不保存长期凭据。每次需要新的上游会话时：

1. `GET http://127.0.0.1:8711/`，`redirect: 'manual'`，从 `Location` 取 `?token=...`；
2. `GET http://127.0.0.1:8710/?token=...`，`redirect: 'manual'`，用 `Headers.getSetCookie()` 取 `Set-Cookie`；
3. 缓存 `{ token, cookie, cookieAt }`，后续请求带 `Cookie`；
4. 上游返回 `401` / `403` 时丢弃缓存，**只重认证一次**并重放该请求；仍失败则把上游状态原样返回。

约束：

- token 从 8711 现取，不读 `~/dsh-web.log`，不把 token 写进配置或日志。
- 缓存只存在进程内存；工作台重启后重新握手。
- 上游在普通响应里刷新 `Set-Cookie` 时更新缓存，不重新握手。
- 不把 token / cookie 返回给浏览器，不出现在 `/api/fish/*` 响应、错误信息或前端日志中。
- 上游地址写死为 127.0.0.1；BFF 不接受客户端传入的 upstream URL。

### 5.2 路由白名单

`/api/fish/<name>` 映射到 `/dsh-fish/<name>`，但 `<name>` 必须命中 `workbench/fish/routes.mjs` 的静态表。表项字段：

```js
// { path, methods, upstream, timeoutMs, maxBody, binary }
{ path: 'status',  methods: ['GET'], upstream: 'fish' },
{ path: 'config',  methods: ['GET', 'POST'], upstream: 'fish', maxBody: 64 * 1024 },
{ path: 'comment', methods: ['GET'], upstream: 'fish', timeoutMs: 120_000 },
```

规则：

- 未登记路径一律 404，不做通配转发。
- 默认只放 `GET`；写操作逐条登记 `POST` / `PUT`。
- 默认 body 上限 256 KB；`/backup/restore` 单独放宽到 96 MB（与插件现有上限一致）。
- 默认超时 30 秒；`comment`、`wx/scan`、`browse` 这类会打外网的读操作放宽到 120 秒，并让前端显示「正在问 B 站」。
- 上游前缀单独登记（`fish` / `bili`）。`dsh-bili` 拆包落地后，只改表里的 `upstream`，BFF 其余代码不动。
- 二进制响应（`cover`、`avatar`、`media`）透传 `Content-Type`、`Content-Length`、`Cache-Control` 与响应体，不 JSON 化。

### 5.3 请求与响应

- 浏览器只与 `127.0.0.1:8788` 同源通信；不设 CORS。
- 写请求要求 `Origin` 为空或等于 `http://127.0.0.1:8788` / `http://localhost:8788`；`Sec-Fetch-Site: cross-site` 一律拒绝。
- 上游 `Content-Type` 与状态码原样透传；只改写 `Set-Cookie` / `Location` 相关头（不向外暴露）。
- BFF 不合并、不改写业务 JSON；分页、字段裁剪都由插件决定。
- 错误统一为 `{ ok: false, error, upstreamStatus? }`，不包含 token、cookie、上游 URL。

### 5.4 危险操作

以下路径进入白名单，但必须同时满足：

| 操作 | 路由 | 额外要求 |
| --- | --- | --- |
| 恢复备份 | `POST backup/restore` | 前端要求输入 `restore`；上游仍做完整性校验与封存 |
| 导入 | `POST import` | 前端展示「只在她还没有起点时可用」；上游 409 照常返回 |
| 重置 | `POST reset` | 前端要求输入 `reset`；上游要求 `confirm:"reset"` |
| 清日志 | `POST log/clear` | 确认弹层；上游仍做自己的检查 |

确认弹层是 UX，不是安全边界；真正的校验留在插件。工作台不得为了「方便」绕过插件的 `confirm` 字面量。

## 6. 信息架构

导航固定为八项，顺序即重要度：

| 导航 | 内容 | 主要路由 |
| --- | --- | --- |
| 总览 | 状态条、今天的时间线、判断、通知、屋子入口、让她说一句 | `/status` `/state` `/events` `/beliefs` `/notify` `/inbox` `/home` `/decide` `/say` |
| B 站 | 视频足迹、评论足迹、待回复正文、浏览统计、登录状态、风控、手动唤醒 | `/footprint` `/browse` `/history` `/comment` `/comment-body` `/owner` `/risk` `/wake` `/away` |
| 记忆 | 事件检索、日记、日报、判断全文、模板 | `/memory` `/beliefs` `/diary` `/reports` `/templates` |
| 环境 | 醒来时间、每天事件数、刷站开关/次数/时段/分区/关键词、评论配额 | `GET/POST /config` |
| 通道 | 现有 QQ / 微信 / 语音卡片；微信扫码 | 现有 `/api/qq/*`、`/api/wx/*`；`/wx/scan` |
| 工具与规则 | 工具清单、规则分层、自检 | `/tools` `/rules` `/selfcheck` |
| 数据与运维 | 日志、导出、备份、恢复、导入、重置、路径、更新检查、头像与媒体 | `/log` `/log/export` `/backup` `/backup/restore` `/import` `/reset` `/paths` `/update` `/avatar` `/media` `/cover` |
| 原理 | 四个阶段、三道瓶颈、立场（静态页，放最后） | 无 |

交互约束：

- 总览只在页面可见时轮询，间隔 60 秒；切走即停。
- B 站页的 `/comment` 只在进入页面或点「刷新」时调用，不自动轮询。该路由会现扫 B 站，属于明确的人工动作。
- 环境页保存后重新拉取 `GET /config`，显示服务端返回值，不做本地乐观更新。
- 所有写操作在按钮上标注作用对象；危险操作放在各自页面底部，不与常用按钮相邻。
- 不提供「替她发评论」的输入框。评论只能由她在 B 站会话里用 `bili_speak` 发出。
- 不提供任何能直接描述人格的字段。环境页的键必须来自 `/config` 白名单。

## 7. 仓库、运行与交付

### 7.1 仓库结构

新增顶层目录：

```
workbench/
  package.json          # 零依赖；type: module；test: node --test
  server.mjs            # HTTP 入口、静态文件、现有 QQ/微信路由
  index.html            # 工作台页面（含新的八项导航）
  host/                 # 现有平台适配层（index/linux/win/pick）
  qq-watch.mjs          # 现有 QQ 监听
  fish/
    bff.mjs             # token/cookie 握手、缓存、fetch 封装
    routes.mjs          # /api/fish 白名单表
  test/
    bff.test.mjs
    routes.test.mjs
    server.test.mjs
  README.md             # 启动、环境变量、部署与回滚
```

迁移白名单：`server.mjs`、`index.html`、`host/*.mjs`、`qq-watch.mjs`。其余 `*.bak*`、`dist/`、`launcher/`、`deploy/`、`*.ps1`、`*.cmd`、`fish-up.sh`、个人排查脚本与交付说明**不进仓库**，留在本地。

工作台 UI 与插件面板**不共享代码**。插件面板依赖宿主 slot API，工作台只认 HTTP；共享代码会把宿主版本问题重新引进来。

### 7.2 运行数据

源码目录不再存放运行数据。新增：

- `WORKBENCH_DATA`，默认 `${WORKBENCH_HOME}/.fish-workbench`；
- 其下放 `frames/`、`watch.json`、工作台自己的临时文件。

现有路径保持不变：QQ 策略 `${H}/dsh-plugins/qq/policy.json`、微信策略 `${H}/.dsh-wx/policy.json`、语音 `${H}/dsh-plugins/speech/speech.json`。

这样 `/opt/fish/workbench` 可以安全地变成指向工作树的符号链接，而不会把截图和运行状态写进 Git 仓库。

### 7.3 部署

`/opt/fish/workbench` 从实体目录改为符号链接，指向当前工作树的 `workbench/`：

```bash
# 一次性迁移（实施时单独确认；旧目录移走，不删除）
mv /opt/fish/workbench /opt/fish/workbench.pre-repo
ln -s <worktree>/workbench /opt/fish/workbench
```

systemd 单元沿用现有 `fish-workbench.service`，补一个环境变量：

```ini
WorkingDirectory=/opt/fish/workbench
Environment=WORKBENCH_HOME=/home/str1k3
Environment=WORKBENCH_PORT=8788
Environment=WORKBENCH_DATA=/home/str1k3/.fish-workbench
ExecStart=/usr/local/bin/node /opt/fish/workbench/server.mjs
Restart=always
```

切换开发线/主线 = 重指符号链接 + `systemctl restart fish-workbench`。不手工 `node server.mjs`，避免与 systemd 争端口。工作台重启不影响 8710 上的她。

### 7.4 交付链路

- 源码从 WSL 的 `/opt/fish/workbench` 种子化到仓库工作树，提交后推送；Windows 克隆拉取同一份。
- 后续 Windows 编辑按既有约定：Windows 改 → 测试 → 提交 → push → WSL `fetch` + `pull --ff-only`。
- 部署工作台只在 WSL 执行；部署 8710 仍走 profile 符号链接 + `systemctl restart dsh-web`。
- 提交前跑 `workbench` 的 `node --test`；插件侧改动（本设计原则上没有）仍跑 `src/dsh-fish` 的 `node --test`。

## 8. 实施阶段

每个阶段单独出实施计划，不把 P0–P3 塞进同一份计划。P0 必须先落地并跑通，再谈 P1。

### P0：源码入仓与可部署骨架

- 种子化 `workbench/`，补 `package.json` 与 README。
- 把 `frames/`、`watch.json` 改为 `WORKBENCH_DATA`。
- 新增 `fish/bff.mjs` 与 `routes.mjs`，只放通 `GET /api/fish/status`。
- 8788 增加「鱼」导航壳，暂只显示状态；旧面板继续可用。
- 部署：`/opt/fish/workbench` 改符号链接，重启 `fish-workbench`。

验收：`node --test` 绿；工作台 `GET /api/fish/status` 返回 200；浏览器网络里看不到 token/cookie；8710 聊天不受影响。

### P1：只读页面

- 总览、B 站、记忆、工具与规则、数据（日志查看、备份下载）、原理。
- 所有页面只调白名单里的 `GET`。
- 前端拆分模块，单文件不再继续膨胀；每个页面一个渲染函数。

验收：各页数据与插件面板逐项一致；`/comment` 只在进入 B 站页时触发一次；断网时页面显示上游错误而不是白屏。

### P2：写操作

- 环境页 `/config`；B 站页 `/wake`、`/away`；通道页 `/wx/scan`；总览 `/say`。
- 数据页的备份下载、恢复、导入、重置、清日志，按危险度从低到高接入。
- 每个写操作补 BFF 测试：方法白名单、body 上限、跨站拒绝、上游错误透传。

验收：保存后服务端回读一致；危险操作必须输入确认词；未登记方法返回 405/404；工作台不产生任何直接文件写入。

### P3：入口切换

- 工作台八项导航完整可用。
- 插件面板标为「旧入口」：设置 section 顶部提示「管理入口已迁到 8788 工作台」。
- 双入口并存一个版本，两处读同一组路由，不双写、不缓存。
- 下一版本移除插件面板的浏览器 UI；`lib/observe.js` 路由与 `fishCore` 契约保留。

验收：从 8788 能完成此前所有面板操作；面板与工作台显示同一份数据；关闭工作台后 8710 与插件不受影响。

## 9. 验收清单

- [ ] `workbench`：`node --test` 全绿，零依赖（`dependencies` / `devDependencies` 均为 `{}`）。
- [ ] `src/dsh-fish`：`node --test` 全绿（本设计不应改插件代码；如因 P0 需要极小的路由兼容，单独说明）。
- [ ] 浏览器只访问 8788；network 面板中没有任何 `token=`、`Cookie: dsh`、`Set-Cookie` 泄露。
- [ ] 重启 `dsh-web` 后 token 旋转，工作台下一次调用自动重新握手，只重试一次。
- [ ] 上游 401/403 不会把 cookie 或 token 写进日志。
- [ ] 未登记路径返回 404；未登记方法返回 405；body 超限返回 413。
- [ ] 跨站 `Origin` 的写请求被拒绝。
- [ ] 二进制路由（封面、头像、媒体）字节与 `Content-Type` 正确。
- [ ] 工作台停机、崩溃、重启期间，8710 聊天与插件调度不受影响。
- [ ] 工作台与旧面板对同一路由的读数一致。
- [ ] 工作台目录下没有运行数据（`frames/`、`watch.json` 不落在仓库）。
- [ ] 危险操作确认词生效，且插件侧 `confirm` 校验未被绕过。
- [ ] 文案守门词通过（不出现「他」「四道门」「三道门」），原理页与插件现有文案一致。

## 10. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| token / cookie 泄露 | 只在进程内存保存；错误与日志统一脱敏；测试断言响应体不含 `token` |
| 工作台变成第二套状态 | BFF 无业务缓存；页面每次回读上游；工作台不碰 `~/.dsh-fish` |
| 双入口读数不一致 | 两侧调同一路由；P3 验收逐项对比；不在工作台做本地派生 |
| 危险操作误触 | 确认词 + 上游 `confirm` 双重校验；危险按钮隔离 |
| 工作台崩溃影响她 | 独立 systemd 单元；8710 不依赖 8788；聊天走 8711 |
| 符号链接切换把运行数据写进仓库 | `WORKBENCH_DATA` 移出源码目录；`.gitignore` 兜底 `workbench/frames/`、`workbench/watch.json` |
| `dsh-bili` 拆包后路由前缀变化 | 白名单表按项登记 `upstream`；拆包时只改表 |
| 旧面板移除后没有退路 | 路由与 `fishCore` 永久保留；回滚只需恢复宿主 slot 注册，不必回滚数据 |

回滚：

1. 工作台：符号链接指回 `/opt/fish/workbench.pre-repo`，`systemctl restart fish-workbench`。
2. 旧入口：撤销 P3 的隐藏/标注改动，插件面板恢复原样。
3. 代码：Git revert 对应提交；事件流与配置不受影响，无需数据迁移。

## 11. 与既有设计的关系

### 11.1 对 `ARCHITECTURE.md` 的修订

- §1 与宿主表中的「工作台 8788 只读为主，不替代宿主 web 服务」作废。8788 成为**唯一管理入口**，可读可写（写经 BFF）。
- §6.8 的「core 现在页 + dsh-bili section」改为「8788 工作台 → BFF → 插件路由」。`ctx.slots.register` / `settings.section` 仍可作为宿主扩展点存在，但不再是 B 站或鱼管理的目标位置。
- §10「工作台信息架构」按本设计第 6 节重写；原 10.1 core 页面与 10.2 dsh-bili section 作为过渡期的旧入口保留，P3 后移除。
- §7.3 的 `ctx.slots.register` 一行保留，注明「不再用于管理工作台」。

### 11.2 对 B 站集成设计 v2 的修订

- A0（解依赖）、A1（接口与事件 v3）、A2（拆包）不受影响。
- A3 原计划把 B 站设置页、足迹、出门、证据迁进插件的 `settings.section`；现改为迁进 8788 工作台。插件侧只保留 HTTP 路由与 `fishCore` 契约。
- v2 §10 的「工作台集成（A3 全量迁移）」中，`settings.section` 注册、宿主 slot 版本门控、core 代理三条不再适用；BFF 白名单表取代它们，成为 UI 与插件之间唯一的接缝。
- v2 中「工作台只读」的相关表述同步作废。
- A2 完成后，白名单表把 B 站项的 `upstream` 从 `fish` 切到 `bili`；工作台页面不变。

### 11.3 不变的部分

- 事件 schema v3、`channel` / `surface` 分层、只追加的 `events.jsonl`。
- `fishCore` 的 memory / toolPolicy / schedule / prompt / config / owner / sessions / toolLedger / self 接口。
- 出门会话、单一调度器、B 站风控与配额、`guard.js` 的全部闸门。
- 微信、QQ 通道的现有配置路径与工作台卡片。

## 12. 非目标

- 不做移动端适配或远程访问。
- 不做多用户、登录、权限分级。
- 不做工作台内嵌聊天。
- 不做事件流的可视化编辑器。
- 不把 QQ / 微信的策略文件迁到插件路由（留给后续单独设计）。
- 不在本设计里删除任何插件路由或数据。
