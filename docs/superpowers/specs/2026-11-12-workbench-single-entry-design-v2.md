# 大肥鱼工作台单入口设计（修订版 v2）

- 日期：2026-11-12
- 状态：修订稿，待评审
- 取代：`2026-11-11-workbench-single-entry-design.md`（原稿保留作对照）
- 修订依据：`docs/superpowers/reviews/2026-11-12-workbench-single-entry-design-review.md`
- 范围：把面向人的管理入口从插件自带 UI 迁到 8788 工作台；插件继续拥有运行时、调度、数据与 HTTP 契约
- 已裁定：
  1. Windows 工作台交付退役，只保 Linux/WSL。
  2. P0（工作台入仓 + BFF 骨架）先于 A2（拆 dsh-bili 后端包）。
  3. P4 移除旧面板时只注销 slot，保留 `client.js` 与打包元数据。
  4. 通道页现有“以她的身份发 QQ / 微信窗口打字回车”保留，但标注为**人工代操作**，与她的自主行为分开。

---

## 0. 相对原稿的修订摘要

| # | 原稿问题 | 本稿处理 |
| --- | --- | --- |
| 1 | 环境页只列了部分配置项 | 增 §4.4「配置键 × 页面」矩阵，16 个顶层键全部落位 |
| 2 | P2 写清单漏 `/owner` `/decide` `/inbox` `/notify` `/risk` `/avatar` | 增 §3.4 完整路由表与 §7 P2 写清单 |
| 3 | v2 A3 的出门/证据面消失 | 增 §4.2.2「出门」、§4.2.3「证据」；补 `/sheet` `/ledger` `/outings` `POST /risk` |
| 4 | 8788 现有能力未清点 | 增 §4.5「通道能力矩阵」，逐项标保留/退役/人工代操作 |
| 5 | 白名单表达不了动态路径与方法 | 增 §3.3 表项模型（`pattern`、`methods`、`maxBody`、`timeoutMs`、`binary`） |
| 6 | BFF 只写响应侧，请求头会触发 403 | 增 §3.2 请求头白名单；固定上游 Host，剥离浏览器 Origin/Sec-Fetch |
| 7 | 迁移只 `mv` 目录，旧数据丢失 | 增 §6.3 数据迁移：停服务、复制 `watch.json`/`frames/`、稳定符号链接、回读校验 |
| 8 | Windows 通知/打包/启动链被切断 | 按裁定退役 Windows 交付，删运行时引用，避免双 8788 |
| 9 | 没有 XSS/转义约束 | 增 §3.6：`textContent`/统一转义、禁 `innerHTML`、CSP、nosniff |
| 10 | 没有 Host/DNS rebinding 校验 | 增 §3.6：所有请求校验 Host；写请求 Origin；副作用 GET 同源 |
| 11 | 认证假设与 cookie 生命周期不符 | 增 §3.1：单飞重认证、区分业务 403、cookie 30 天持久 |
| 12 | A2 与 P0–P3 顺序、core 路由生命周期、P3 移除范围未定 | 增 §7 阶段与 §10 关系；明确 P0→A2→P1、core 代理保留到 P4 后一个版本、P4 只注销 slot |
| 13 | 错误契约丢业务故障码 | 增 §3.5：默认透传上游 body，保留 `code`/`unknown` |
| 14 | “浏览器无 token”与聊天入口矛盾 | §3.1/§8：限定为 `/api/fish/*` 管理流量；聊天/QQ WebUI 单列例外 |
| 15 | 事件“检索”语义不明 | §4.3：只做 `type`/`limit` 列表筛选，不承诺全文检索 |

---

## 1. 结论与边界

管理入口只留一个：**8788 工作台**。

工作台是浏览器唯一直接访问的管理界面；它通过一层 BFF 调 8710 上插件的 `/dsh-fish/*` 或 A2 后的 `/dsh-bili/*` HTTP 路由。插件仍然是状态、调度、工具和事件流的唯一所有者。搬的是**入口**，不是运行时。

聊天不搬，仍在 8710（经 8711 跳转）。

一句话边界：

> 工作台可以替人「看」和「按按钮」，不能替她「活」。人工代操作必须显式标注，并记为人工动作，不算她的行为。

### 1.1 做什么

- 把 8788 工作台扩成唯一管理入口：总览、B站、记忆、环境、通道、工具与规则、数据与运维、原理。
- 新增 `workbench/fish/` BFF：持有 8710 的 token 与 cookie，向浏览器只暴露 `/api/fish/*`。
- 把工作台源码迁进仓库（新顶层目录 `workbench/`），零依赖，运行数据移出源码目录。
- 双入口过渡至少一个 `dsh-fish` minor 版本：工作台可用期间，插件面板保留但标为旧入口。
- 下一版本注销插件面板的 slot；`client.js` 与 HTTP 路由保留。

### 1.2 不做什么

- 不迁调度器、tick/wake 钩子、B 站抓取、评论扫描逻辑。
- 不在 BFF 里直接写 `events.jsonl`、`config.json`、`state.json` 或任何 `~/.dsh-fish` 下的文件。
- 不新增人格设置入口。`/config` 仍然只收环境参数；导入仍走 `/import` 的三条边界。
- 不把聊天搬进工作台。聊天仍由 8710 宿主 UI 提供。
- 不改事件 schema，不改 `channel` / `surface` 分层，不改记忆召回。
- 不做第二套 B 站调度，不新增第二个刷站循环。
- 不把 8788 暴露到 127.0.0.1 之外，不在这一版引入账号体系。
- 不删除插件路由，不移除 `fishCore` 接口。
- 不做 Windows 桌面工作台、exe 打包与 PowerShell 通知。
- 不提供 B 站代发评论；只保留 QQ/微信现有人工代操作。
- 不做事件全文检索。

---

## 2. 拓扑与职责

```
浏览器（Windows 或 WSL）
  │  管理流量只访问 127.0.0.1:8788，无 token、无 cookie
  ▼
┌─────────────────────────────┐
│ 8788 workbench (Node, 零依赖)│
│  静态页面 / 工作台导航        │
│  /api/fish/*  ── BFF ───────┼──► 8710 /dsh-fish/* 或 /dsh-bili/*
│  /api/qq/*    （现有桥）      │
│  /api/wx/*    （现有桥）      │
│  /api/her/*   （现有桥）      │
└─────────────────────────────┘
  │
  ├─ 聊天入口：/api/her/open → 8711 → 8710?token=...（例外：浏览器会看到 token）
  └─ 握手：BFF 先 GET 8711 取 token，再 GET 8710 换 cookie；业务请求直连 8710
```

职责划分：

| 层 | 拥有什么 | 不拥有什么 |
| --- | --- | --- |
| `src/dsh-fish` / `src/dsh-bili` | 状态、配置、事件流、调度、工具、HTTP 路由、校验与配额 | 管理界面 |
| 8788 工作台 | 页面、导航、交互、BFF 会话、QQ/微信现有桥接、`WORKBENCH_DATA` | 业务校验、事件写入、调度 |
| 8710 宿主 | 聊天、会话、工作区、插件加载 | 管理入口（过渡期旧面板除外） |

工作台不是第二个「大脑」。它的鱼侧读写都走插件 HTTP 路由，插件返回什么就显示什么；工作台不复制配额、不判断风控、不缓存业务数据。

### 2.1 与现有 QQ / 微信 / 语音通道的关系

工作台继续直接读写通道自己的配置：

- QQ：`${H}/dsh-plugins/qq/policy.json`（经 `sync.mjs` 打补丁）；
- 微信：`${H}/.dsh-wx/policy.json`；
- 语音：`${H}/dsh-plugins/speech/speech.json`；
- 工作台自己的：`WORKBENCH_DATA/watch.json`、`WORKBENCH_DATA/frames/`、`hold.json`。

这些是通道配置与运行数据，不是鱼的记忆，也不是事件流。本设计不把它们改道到 `/dsh-fish/*`。唯一的交集是微信会话目录补扫：工作台「通道」页通过 BFF 调 `/dsh-fish/wx/scan`。

---

## 3. 认证与 BFF 契约

### 3.1 认证流程

工作台不保存长期凭据。每次需要新的上游会话时：

1. `GET http://127.0.0.1:8711/`，`redirect: 'manual'`，从 `Location` 取 `?token=...`；
2. `GET http://127.0.0.1:8710/?token=...`，`redirect: 'manual'`，用 `Headers.getSetCookie()` 取 `Set-Cookie`；
3. 缓存 `{ token, cookie, cookieAt }`，后续请求带 `Cookie`；
4. 上游返回 `401` 时丢弃缓存，**单飞重认证一次**并重放该请求；
5. 上游返回 `403` 时同样单飞重认证一次并重放；重放仍 `403` 视为业务拒绝，原样返回上游 body；
6. 8711 返回 503（token 未就绪）或 8710 不可达时，返回 `502 UPSTREAM_UNAVAILABLE`，不无限重试。

约束：

- token 从 8711 现取，不读 `~/dsh-web.log`，不把 token 写进配置或日志。
- 缓存只存在进程内存；工作台重启后重新握手。
- **cookie 是 30 天持久签名 cookie**；普通 `/dsh-fish/*` 响应不发 `Set-Cookie`。不要假设 dsh-web 重启一定会触发重认证。验收按“cookie 失效时能重认证”写，而不是“重启必重认证”。
- 并发请求同时 401/403 时共享同一个 in-flight Promise，避免握手风暴。
- 不把 token / cookie 返回给浏览器，不出现在 `/api/fish/*` 响应、错误信息或前端日志中。
- 上游地址写死为 127.0.0.1；BFF 不接受客户端传入的 upstream URL。
- **例外**：`/api/her/open` 返回的聊天地址、`/api/qq/panel` 的 NapCat token/URL 会带凭据给浏览器。这是现有入口，不属于 `/api/fish/*`；页面必须显式标注，且不写入日志。

### 3.2 请求头白名单

BFF → 8710 只发送：

```
Host: 127.0.0.1:8710
Cookie: <缓存的 dsh cookie>
Content-Type: <客户端请求的 Content-Type，缺省 application/json>
Accept: <客户端 Accept，缺省 */*>
Content-Length: <由 BFF 计算>
User-Agent: fish-workbench/<version>
```

必须剥离：浏览器的 `Origin`、`Referer`、`Sec-Fetch-*`、`Host`、`Cookie`、`Connection`。

原因：dsh 0.2.1-rc.5 的信任栅栏要求 Host 为 loopback/trusted、Origin 与 Host 同 authority；透传 `Origin: http://127.0.0.1:8788`、`Sec-Fetch-Site: cross-site` 或错误 Host 会直接 403。

响应侧透传：状态码、`Content-Type`、`Content-Length`、`Cache-Control`、`Content-Disposition`、`ETag`、`Last-Modified`。剥离上游 `Set-Cookie`、`Location`。不设 CORS。

### 3.3 路由白名单模型

`/api/fish/<name>` 映射到插件的 `/dsh-fish/<name>` 或 `/dsh-bili/<name>`，`<name>` 必须命中 `workbench/fish/routes.mjs` 的静态表。表项：

```js
// { path, methods, upstream, pattern?, maxBody?, timeoutMs?, binary?, download? }
{ path: 'status',  methods: ['GET'], upstream: 'fish', timeoutMs: 30_000 },
{ path: 'config',  methods: ['GET','POST','PUT'], upstream: 'fish', maxBody: 64 * 1024 },
{ path: 'cover',   methods: ['GET'], upstream: 'bili', pattern: /^BV[0-9A-Za-z]{10}$/, binary: true },
```

规则：

- 未登记路径一律 404；未登记方法一律 405；不做通配转发。
- 默认只放 `GET`；写操作逐条登记 `POST` / `PUT`。
- 默认 body 上限 256 KB；按 §3.4 逐项放宽。
- 默认超时 30 秒；按 §3.4 逐项放宽。
- `pattern` 只匹配路径的最后一段（或明确声明的子路径），不允许 `/`、`..`、`%2e%2e`、反斜杠。
- 二进制/下载响应流式透传，不 JSON 化、不整包缓冲。
- `upstream` 为 `fish` 或 `bili`。A2 拆包只改表里的 `upstream`，BFF 代码不动。
- 上游前缀：`fish → /dsh-fish/`，`bili → /dsh-bili/`。

### 3.4 路由表

“owner”列：`fish` = 现有 core 路由；`bili` = A2 后由 dsh-bili 提供；`fish→bili` = A2 前走 core，A2 后切 bili。`新增` 表示当前不存在、需要随 A2/P1 补。

#### 总览 / 记忆 / 环境 / 工具 / 数据

| BFF 路径 | 方法 | owner | 路径模式/query | maxBody | timeout | 响应 |
| --- | --- | --- | --- | --- | --- | --- |
| `status` | GET | fish | — | — | 30s | JSON |
| `state` | GET | fish | — | — | 30s | JSON |
| `events` | GET | fish | `?type=&limit=`（limit ≤ 500） | — | 30s | JSON |
| `beliefs` | GET | fish | — | — | 30s | JSON |
| `memory` | GET | fish | — | — | 30s | JSON |
| `diary` | GET | fish | `?day=` | — | 30s | JSON |
| `reports` | GET | fish | `?date=` | — | 30s | JSON |
| `templates` | GET | fish | — | — | 30s | JSON |
| `notify` | GET, POST | fish | POST body `{shown:true}` 或 `{enabled}` | 64KB | 30s | JSON |
| `inbox` | GET, POST | fish | POST 标记已读 | 64KB | 30s | JSON |
| `decide` | POST | fish | `{id, decision}` | 64KB | 30s | JSON |
| `home` | GET | fish | — | — | 30s | JSON |
| `say` | POST | fish | 文本或图片；**不是连续聊天** | 12MB | 120s | JSON |
| `wake` | POST | fish | `?focus=browse`（dev） | 64KB | 180s | JSON |
| `away` | GET | fish | — | — | 30s | JSON |
| `owner` | GET, POST, PUT | fish | POST/PUT 保存 cookie/账号；`test:true` 会联网 | 64KB | 120s | JSON |
| `config` | GET, POST, PUT | fish | 白名单键；`persona` 拒绝 | 64KB | 30s | JSON |
| `tools` | GET | fish | — | — | 30s | JSON |
| `rules` | GET | fish | — | — | 30s | JSON |
| `selfcheck` | GET | fish | `?net=1` 会联网 | — | 120s | JSON |
| `log` | GET | fish | — | — | 30s | text |
| `log/export` | GET | fish | — | — | 30s | 下载，`text/plain` + `Content-Disposition` |
| `log/clear` | POST | fish | `{confirm}` | 64KB | 30s | JSON |
| `backup` | GET | fish | — | — | 120s | 下载/二进制，流式 |
| `backup/restore` | POST | fish | `{confirm:"restore", ...}` | 96MB | 300s | JSON |
| `import` | GET, POST | fish | `{confirm,...}`；上游仍校验“还没有起点” | 256KB | 60s | JSON |
| `reset` | POST | fish | `{confirm:"reset"}` | 64KB | 60s | JSON |
| `paths` | GET | fish | — | — | 30s | JSON；页面只提供复制，不默认显示绝对路径 |
| `update` | GET | fish | `?ms=` | — | 60s | JSON |
| `avatar` | GET, POST | fish | POST `{data}` 或 `{remove:true}` | 4MB | 30s | JSON/二进制 |
| `avatar/info` | GET | fish | — | — | 30s | JSON |
| `media` | GET | fish | `pattern: /^principle-[a-z]+\.svg$/` | — | 30s | SVG（二进制） |
| `wx/scan` | POST | fish | 微信会话目录补扫，不是扫码登录 | 64KB | 120s | JSON |

#### B 站

| BFF 路径 | 方法 | owner | 路径模式/query | maxBody | timeout | 响应 |
| --- | --- | --- | --- | --- | --- | --- |
| `bili/status` | GET | bili（新增） | — | — | 30s | JSON |
| `browse` | GET | fish | 只读事件与配置 | — | 30s | JSON |
| `history` | GET | fish | 视频历史（事件聚合） | — | 30s | JSON |
| `footprint` | GET | fish→bili | — | — | 30s | JSON |
| `comment` | GET | fish→bili | `?waiting=1` 只取未呈现 | — | 120s | JSON；会现扫 B 站 |
| `comment-body` | GET | fish→bili | `?bvid=&rpid=` | — | 120s | JSON |
| `cover` | GET | fish→bili | `pattern: /^BV[0-9A-Za-z]{10}$/` | — | 30s | 图片（二进制） |
| `risk` | GET, POST | fish→bili | POST `{clear:true}` 解冻 | 64KB | 60s | JSON |
| `sheet` | GET | bili（新增） | `pattern: /^BV[0-9A-Za-z]{10}$/` 抽帧拼图 | — | 120s | 图片（二进制） |
| `ledger` | GET | bili（新增） | `?date=&session=&tool=` | — | 60s | JSON |
| `outings` | GET | bili（新增） | `?date=` 出门记录/配额/最近投递 | — | 30s | JSON |

说明：

- `/footprint`、`/comment`、`/comment-body`、`/cover`、`/risk` 是 B 站专属；A2 后切 `bili`。
- `/browse`、`/history`、`/owner`、`/wake`、`/away`、`/config` 留 `fish`：它们读事件/配置、管账号或管全局唤醒，不属于 B 站包。
- `POST /risk {clear:true}` 是写操作，必须二次确认。
- `GET /comment` 有外部副作用，只允许同源页面在进入 B 站页或点刷新时触发；BFF 对所有带副作用 GET 做 `Sec-Fetch-Site` 同源校验。
- `/sheet`、`/ledger`、`/outings`、`bili/status` 当前不存在，必须在 A2 或 P1 前置补齐；如果决定不迁出门/证据，必须同步删掉本设计 §4.2.2/§4.2.3 与 v2 §10 的相关承诺。

### 3.5 错误契约

- 上游有 body：**原样透传**状态码、`Content-Type` 与 body，不包一层 `{ok:false}`，保留 `code`、`unknown` 等业务字段。
- 上游无 body 或 BFF 自身错误：`{ ok:false, error, upstreamStatus? }`，不包含 token、cookie、上游 URL。
- 传输错误：`502 UPSTREAM_UNAVAILABLE`；8711 未就绪：`503 AUTH_UNAVAILABLE`。
- 认证失败且重认证后仍失败：`401 AUTH_FAILED`。
- 业务 403：原样返回上游 body，页面显示业务原因（风控、权限、@ 窗口等），不当作认证失败。

### 3.6 安全

1. **Host 校验（所有请求）**：`Host` 必须是 `127.0.0.1:8788` 或 `localhost:8788`。不匹配直接 403。防 DNS rebinding。
2. **Origin / Sec-Fetch（写请求）**：`Origin` 为空或等于 `http://127.0.0.1:8788` / `http://localhost:8788`；`Sec-Fetch-Site: cross-site` 一律拒绝。
3. **副作用 GET**：`comment`、`comment-body`、`selfcheck?net=1`、`cover`（懒加载）、`inbox`（读取时不应写盘）等，必须校验 `Sec-Fetch-Site` 为同源或缺失；跨站 `<img>` 不得触发 B 站扫描。
4. **不可信文本转义**：事件、日记、判断、B 站评论正文、微信/QQ 消息、昵称、报告等一律用 `textContent` 或统一 `escapeHtml()` 渲染；禁止把上游文本拼进 `innerHTML`。工作台新增页面不得沿用现有 `innerHTML` 模式。
5. **CSP / 安全头**：静态页至少 `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`；所有响应加 `X-Content-Type-Options: nosniff`。
6. **静态文件**：先 `path.resolve` 再 `path.relative(root, target)`，拒绝越界、以 `..` 开头、编码斜杠、反斜杠、绝对路径、符号链接逃逸。只服务 `index.html` 与 `assets/`。
7. **危险操作**：
   - `backup/restore`：前端输入 `restore`；上游仍做完整性校验与封存。
   - `reset`：前端输入 `reset`；上游要求 `confirm:"reset"`。
   - `log/clear`：确认弹层。
   - `import`：展示“只在她还没有起点时可用”；上游 409 照常返回；模板可随时下载。
   - `risk` 解冻：二次确认。
   - QQ 人工发消息 / 微信打字回车：确认弹层 + “人工代操作”标注 + 动作日志；不写事件流、不算她的行为。
   - 确认弹层是 UX，不是安全边界；真正的校验留在插件。工作台不得绕过插件的 `confirm` 字面量。
8. **本机进程信任边界**：8788 无账号体系，本机进程可 `curl` 调 `/api/fish/*`。设计明确“本机进程视为可信”；浏览器侧靠 Host/Origin/CSP/转义防跨站。
9. **日志脱敏**：握手失败、上游错误、代理异常都不得把 `token=`、`Cookie`、上游 URL 写入日志或错误体；单测断言。

---

## 4. 信息架构

导航固定为八项，顺序即重要度：

| 导航 | 内容 | 主要路由 |
| --- | --- | --- |
| 总览 | 状态条、今天的时间线、判断、通知、屋子入口、找她、叫她、你不在的时候、动作日志 | `/status` `/state` `/events` `/beliefs` `/notify` `/inbox` `/home` `/decide` `/say` `/wake` `/away` |
| B 站 | 视频足迹、评论足迹、待回复、浏览统计、登录状态、风控、手动唤醒、**出门**、**证据** | `/footprint` `/browse` `/history` `/comment` `/comment-body` `/owner` `/risk` `/wake` `/away` `/bili/status` `/outings` `/sheet` `/ledger` |
| 记忆 | 事件列表、日记、日报、判断全文、模板 | `/memory` `/events` `/beliefs` `/diary` `/reports` `/templates` |
| 环境 | 成长、醒来、浏览、视频、黑名单、评论、对话、记忆、通知的全部配置键 | `GET/POST/PUT /config` |
| 通道 | QQ / 微信 / 语音卡片、微信会话目录补扫、人工代操作 | `/api/qq/*` `/api/wx/*` `/api/speech` `/wx/scan` `/api/watch` |
| 工具与规则 | 工具清单、工具白名单、规则分层、自检 | `/tools` `/rules` `/selfcheck` `POST /config {tools}` |
| 数据与运维 | 日志、导出、备份、恢复、导入、重置、路径、更新检查、头像与媒体、帧存档 | `/log` `/log/export` `/log/clear` `/backup` `/backup/restore` `/import` `/reset` `/paths` `/update` `/avatar` `/avatar/info` `/media` `/api/frames` |
| 原理 | 四个阶段、三道瓶颈、立场（静态页，放最后） | 本地静态资源 |

### 4.1 总览

- 状态条：阶段、第几天、工具数、出门状态、风控、8710 健康。
- 时间线：`/events?limit=` 的只读列表。
- 判断/通知/信箱：`/beliefs`、`/notify`、`/inbox`；通知 `POST {shown:true}` 去重，`{enabled}` 开关。
- 屋子入口：`/home`；找她：`/api/her/open`（带 token 例外，按钮旁注明“会打开宿主界面”）。
- 叫她：`POST /wake`；你不在的时候：`/away`。
- 动作日志：8788 的 `/api/status.log`（最近 20 条），只读。
- 让她说一句：`POST /say`，单次动作，不提供历史/连续会话；支持图片时按 12MB 上限。

### 4.2 B 站

#### 4.2.1 足迹与评论

- 视频足迹：`/footprint`、`/history`、`/cover/<bvid>`。
- 评论足迹：`/footprint.comments`、`/comment.mine`。
- 待回复正文：`/comment?waiting=1` + `/comment-body?bvid=&rpid=`；进入页面或点“刷新”才调用，不自动轮询。
- 登录：`/owner` 只读展示 `hasCookie`/`hasCsrf`/mid/nickname；保存 cookie 用 `POST/PUT /owner`，`test:true` 会联网验证；未保存提示可 `POST /config {ui:{ownerHintDismissed:true}}` 关闭。
- 风控：`/risk` 只读；解冻 `POST /risk {clear:true}`，二次确认。
- 手动唤醒：`POST /wake?focus=browse`（dev 用），入口放 B 站页；主“叫她”仍在总览。
- 浏览统计：`/bili/status`（A2 后）或 `/status`（A2 前）。

#### 4.2.2 出门

- 今日次数/配额、最近出门时间、最近投递（`biliout:` 记录）、待回复数。
- 路由：`/outings?date=`（新增，A2 后由 dsh-bili 提供）。
- 会话入口：显示出门会话 id 与最后活动；不新增“切换会话”接口，需要进入宿主界面由 `/api/her/open` 承担。
- 只读，不提供“替她发评论”按钮。

#### 4.2.3 证据

- 抽帧拼图：`GET /sheet/<bvid>`，二进制，只在点开单条视频时加载。
- 台账：`GET /ledger?date=&session=&tool=`，只读；`fishCore.toolLedger` 必须在 A2 补 HTTP 只读路由。
- 待回复正文：复用 `/comment?waiting=1`。
- 风控解冻：`POST /risk {clear:true}`。
- 所有证据页只读；不提供编辑事件流的能力。

### 4.3 记忆

- 事件列表：`/events?type=&limit=`，只做类型/数量筛选，**不承诺全文检索**。
- 日记：`/diary?day=`；日报：`/reports?date=`；判断全文：`/beliefs`；模板：`/templates`。
- 记忆预算等配置在「环境」页，不在记忆页重复编辑。
- 报告导出：客户端 Blob，不需要新路由；按钮放在报告卡片上。

### 4.4 环境（配置键矩阵）

`settings.js` 的 `CONFIG_PATCH_KEYS` 16 个顶层键必须全部有归宿；“persona” 永远不出现。

| 顶层键 | 页面/分组 | 主要子键 | 读写 |
| --- | --- | --- | --- |
| `growthDays` | 环境 · 成长 | 天数 | GET/POST `/config` |
| `wakesPerDay` | 环境 · 成长 | 每天唤醒数 | 同上 |
| `window` | 环境 · 成长 | 醒来时段 | 同上 |
| `daily` | 环境 · 成长 | `events`、`questions` | 同上 |
| `diary` | 环境 · 成长 | `enabled`、`visible`、`keepDays` | 同上 |
| `absenceAfterDays` | 环境 · 成长 | 缺席天数 | 同上 |
| `avoid` | 环境 · 浏览 | `keywords`、`minDuration`、`upMids` | 同上 |
| `browse` | 环境 · 浏览 | `perDay`、`topN`、`deepRead`、`danmaku`、`voices`、`window` | 同上 |
| `video` | 环境 · 浏览 | `enabled`、`perDay`、`frames`、`ocr` | 同上 |
| `comment` | 环境 · 评论 | `enabled`、`perDay`、`replyPerDay`、`replyToReplies`、`scanEveryMin`、`window`、`atOwner` | 同上 |
| `notify` | 环境 · 通知 | `enabled` | 同上 |
| `chat` | 环境 · 对话 | `replyChars`、`rotateAfter` | 同上 |
| `memory` | 环境 · 记忆 | `docBudget`、`beliefsShown`、`sleepEveryDays`、`sleepKeep` | 同上 |
| `tools` | 工具与规则 | 工具白名单 | `POST /config {tools}` |
| `observe` | 数据与运维 | 观测/日志参数 | `POST /config {observe}` |
| `ui` | B 站 / 界面偏好 | `ownerHintDismissed` 等 | `POST /config {ui}` |

规则：

- 每个键只在一个页面可编辑，避免双写；其他页面只读或链接过去。
- 保存后重新拉 `GET /config`，显示服务端返回值，不做本地乐观更新。
- 未知键整次拒绝；`persona` 单列只读；`/config` 白名单与 `CONFIG_PATCH_KEYS` 同源。
- 环境页按分组折叠，不把所有键堆成一列。

### 4.5 通道（能力矩阵 + 人工代操作）

| 能力 | 现有 API | 决定 |
| --- | --- | --- |
| QQ 启动/停止/重启 | `POST /api/qq/start|stop|restart` | 保留 |
| QQ NapCat 面板/登录页/二维码 | `GET /api/qq/panel`、`/api/qq/qr` | 保留；token/URL 不写日志 |
| QQ 会话列表/历史 | `/api/qq/recent|history` | 保留 |
| QQ 以她的身份发一句 | `/api/qq/send` | **保留，标注“人工代操作”**；确认弹层 + 动作日志；不写事件流 |
| QQ 掉线提醒/测试 | `/api/watch`、`/api/watch/test` | 保留；Windows toast 退役，改页面内提示/浏览器通知可选 |
| QQ 说话范围/管理员 | `/api/qq/scope` | 保留；保存后重启她属于危险操作，单独确认 |
| 语音频率 | `GET/POST /api/speech` | 保留 |
| 微信启动/停止 | `/api/wx/start|stop` | 保留 |
| 微信实时画面 | `/api/wx/frame.jpg` | 保留 |
| 微信点击 | `/api/wx/click` | 保留 |
| 微信打字/回车/按键 | `/api/wx/type|key` | **保留，标注“人工代操作”**；确认 + 动作日志 |
| 微信存图/识别/补扫/关多余/清理 | `/api/wx/save|peek|scan|close-extra`、`/api/gc` | 保留 |
| 微信允许说话/候选/坏名 | `/api/wx/scope` | 保留 |
| 她的打开/启动/停止 | `/api/her/open|start|stop` | 保留；总览「她」卡 |
| 动作日志 | `/api/status.log` | 保留；总览只读 |
| 帧存档 | `/api/frames`、`/api/frames/<name>` | 保留；数据与运维/微信卡片 |
| 诊断/窗口/截图 | `/api/diagnostics`、`/api/wx/windows|shot` | 不纳入导航；Windows 适配退役后随之下线，除非 Linux 仍需要 |
| Windows 工作台/exe/toast | `host/win.mjs`、`notify.ps1`、`launcher/`、`dist/`、`*.ps1`、`*.cmd`、`fish-up.sh`、`boot-chain.ps1` | **退役**；归档到 pre-repo，不再引用；删除需单独批准 |

人工代操作规则：

- 按钮文案必须含“人工代操作”或等价说明；与她的自主行为分开。
- 发送/打字前二次确认；执行后写动作日志（操作者=人、通道、目标、时间、结果），不写 `events.jsonl`。
- 不新增 B 站代发入口。

### 4.6 工具与规则

- 工具清单：`/tools`；规则分层：`/rules`；自检：`/selfcheck?net=1`。
- 工具白名单：`POST /config {tools}`，保存后回读；工具名必须真实存在，未知名字整次拒绝。
- 台账：`/ledger` 主入口在 B 站「证据」；工具页只放链接，避免两处编辑。
- 自检必须显示 B 站插件状态：`biliPlugin`、`contributions`、`restrict`、`sessions`、`ledger`、`eventSchema`；插件缺席显示 `BILI_PLUGIN_ABSENT`，贡献未生效显示 `BILI_CONTRIBUTION_PENDING`。
- A2 需要给 `selfcheck` 补这些字段；本设计要求展示，不要求 P0 实现。

### 4.7 数据与运维

- 日志：`/log` 预览；`/log/export` 下载（`text/plain` + `Content-Disposition`，不要 `fetch().json()`）；`/log/clear` 确认。
- 备份：`/backup` 下载（实测约 47MB，流式）；`/backup/restore` 96MB，输入 `restore`。
- 导入：`/import`，保留原有关键边界文案（哪些会过来、哪些不会、人设字数、工具白名单需重启、豁免只认导入动作）与“下载交接单模板”。
- 重置：`/reset`，输入 `reset`。
- 路径：`/paths`，页面只提供复制按钮，不默认把绝对路径上屏。
- 更新：`/update?ms=`，只读检查。
- 头像：`/avatar`、`/avatar/info`，上传上限 4MB（base64 前原图 2MB）。
- 媒体：原理图优先用工作台本地静态副本；`/media/principle-*.svg` 保留作兼容。
- 帧存档：`/api/frames` 缩略图与 `/api/frames/<name>`；清理 `/api/gc` 放本页。
- 表格/列表里的用户文本一律转义。

### 4.8 原理

- 四个阶段、三道瓶颈、立场，内容与插件面板一致。
- 两张原理图放 `workbench/assets/`，不依赖插件路由。
- 静态页，无写操作。

### 4.9 轮询与状态

- 应用外壳统一轮询：`/status` 30 秒、`/notify` 60 秒；只在页面可见时跑，切走即停。
- 总览额外 60 秒刷新时间线/判断；离开总览停。
- B 站 `/comment` 只在进入页面或点“刷新”时调用一次；不自动轮询。
- 环境保存后立即 `GET /config` 回读。
- 双入口期：旧面板在 P3 前保持现有 30s/60s 轮询；P3 把它改为“旧入口”横幅 + 链接并停掉自动轮询；P4 注销 slot。§8 的双入口一致性清单按 P3 验收。
- 页面状态只允许：当前页、筛选、最后刷新时间；不持久化业务快照。

---

## 5. 仓库、运行数据与部署

### 5.1 仓库结构

新增顶层目录：

```
workbench/
  package.json          # 零依赖；type: module；test: node --test
  server.mjs            # HTTP 入口、静态文件、现有 QQ/微信/她 路由
  index.html            # 工作台页面（八项导航）
  assets/               # 原理图等本地静态资源
  host/
    index.mjs
    linux.mjs
    pick.mjs
  qq-watch.mjs
  fish/
    bff.mjs             # token/cookie 握手、缓存、fetch 封装、请求头白名单
    routes.mjs          # /api/fish 白名单表
  test/
    bff.test.mjs
    routes.test.mjs
    server.test.mjs
    security.test.mjs
  README.md             # 启动、环境变量、部署与回滚
```

迁移白名单：`server.mjs`、`index.html`、`assets/`、`host/{index,linux,pick}.mjs`、`qq-watch.mjs`。

不进仓库：`*.bak*`、`dist/`、`launcher/`、`deploy/`、`*.ps1`、`*.cmd`、`fish-up.sh`、`boot-chain.*`、个人排查脚本、交付说明。Windows 适配 `host/win.mjs`、`notify.ps1` 退役；归档到 `/opt/fish/workbench.pre-repo`，不再引用。

工作台 UI 与插件面板**不共享代码**。插件面板依赖宿主 slot API，工作台只认 HTTP。

### 5.2 运行数据

源码目录不存放运行数据：

- `WORKBENCH_DATA`，默认 `join(WORKBENCH_HOME || HOME, '.fish-workbench')`；
- 其下放 `frames/`、`watch.json`、`hold.json`、工作台临时文件；
- 启动时 `mkdir -p WORKBENCH_DATA` 与 `WORKBENCH_DATA/frames`；
- `WORKBENCH_HOME` 未设置时用 `HOME`，再退回 `/home/str1k3`；不允许出现 `undefined` 路径。

现有通道路径不变：QQ 策略 `${H}/dsh-plugins/qq/policy.json`、微信策略 `${H}/.dsh-wx/policy.json`、语音 `${H}/dsh-plugins/speech/speech.json`。

### 5.3 数据迁移（P0 一次性）

```bash
systemctl stop fish-workbench
mkdir -p /home/str1k3/.fish-workbench/frames
# 复制，不是移动；保留旧目录用于回滚
cp -a /opt/fish/workbench/watch.json /home/str1k3/.fish-workbench/watch.json
cp -a /opt/fish/workbench/frames/. /home/str1k3/.fish-workbench/frames/
# 旧目录封存
mv /opt/fish/workbench /opt/fish/workbench.pre-repo
# 稳定符号链接：不直接指向临时 worktree
ln -s <worktree>/workbench /opt/fish/workbench-current
ln -s /opt/fish/workbench-current /opt/fish/workbench
```

迁移前记录旧值（当前 `watch.json` 为 `pollSeconds:30, nagMinutes:0, notifyRecover:false`），迁移后用新服务回读并断言一致。`frames/` 目前为空，但流程按“可能非空”写。

回滚：停服务 → 把 `/opt/fish/workbench` 指回 `pre-repo` → 启动 → 校验；新路径数据冻结，若需要回拷需单独确认。回滚后旧服务继续读 pre-repo 的旧 `watch.json`，不会因为新服务写过而脑裂。

### 5.4 systemd

在现有 `fish-workbench.service` 上追加 `WORKBENCH_DATA`，**保留**现有的 `HOME`、`DISPLAY`、日志重定向：

```ini
WorkingDirectory=/opt/fish/workbench-current
Environment=WORKBENCH_HOME=/home/str1k3
Environment=WORKBENCH_PORT=8788
Environment=WORKBENCH_DATA=/home/str1k3/.fish-workbench
Environment=HOME=/home/str1k3
Environment=DISPLAY=:99
ExecStart=/usr/local/bin/node /opt/fish/workbench-current/server.mjs
Restart=always
RestartSec=5
StandardOutput=append:/home/str1k3/workbench.log
StandardError=append:/home/str1k3/workbench.log
```

切换开发线/主线 = 重指 `workbench-current` + `systemctl restart fish-workbench`。不手工 `node server.mjs`，避免与 systemd 争端口。启动前确认 8788 没有被 Windows 侧或手工进程占用。

### 5.5 交付链路

- 源码从 WSL 的 `/opt/fish/workbench` 种子化到仓库工作树，提交后推送；Windows 克隆拉取同一份。
- 后续 Windows 编辑按既有约定：Windows 改 → 测试 → 提交 → push → WSL `fetch` + `pull --ff-only`。
- 部署工作台只在 WSL 执行；部署 8710 仍走 profile 符号链接 + `systemctl restart dsh-web`。
- 提交前跑 `workbench` 的 `node --test`；插件侧改动（P1 的 `/inbox` 只读小修、P3/P4 的 slot 改动）跑 `src/dsh-fish` 的 `node --test`。

---

## 6. 实施阶段

每个阶段单独出实施计划；Stage 0 的矩阵必须先冻结。

### Stage 0：契约冻结（不写代码）

1. 冻结 §3.4 路由归属矩阵（path/method/owner/upstream/pattern/body/timeout/缺席行为）。
2. 冻结 §4.4 配置键矩阵（16 个顶层键 → 页面 → 读写）。
3. 冻结 §4.5 8788 现有能力矩阵（保留/退役/人工代操作）。
4. 裁定已在本稿写死：P0 先行；A2 后端拆包不做 client/section；core 代理保留到 P4 后一个 minor；P4 只注销 slot；Windows 退役。

### P0：源码入仓与可部署骨架

- 种子化 `workbench/`，补 `package.json`、README、`assets/`。
- `frames/`、`watch.json`、`hold.json` 改 `WORKBENCH_DATA`；启动时 `mkdir -p`。
- 新增 `fish/bff.mjs` 与 `routes.mjs`：先只放通 `GET /api/fish/status`。
- BFF 基线：请求头白名单、Host 校验、错误脱敏、单飞重认证、静态路径校验、CSP/nosniff。
- 数据迁移按 §5.3；systemd 按 §5.4；Windows 适配从运行时引用中移除。
- 8788 增加「鱼」导航壳，暂只显示状态；旧面板继续可用。
- 修掉现有 `server.mjs` 的 `writeFileSync` 未导入问题（`saveWatch` 500）。

验收：

- `workbench` 的 `node --test` 绿；零依赖。
- `GET /api/fish/status` 200；浏览器网络与 `/api/fish/*` 响应无 token/cookie。
- 伪造 Host 403；跨站写请求 403。
- 旧 `watch.json` 值回读一致；`frames/` 可读；回滚到 pre-repo 可启动。
- 8710 聊天与插件调度不受影响。

### A2：后端拆包（P0 之后，P1 之前）

- 建 `src/dsh-bili`：15 个模块 + `prompts.js` + `index.js` + `package.json` + `cordis.patch.yml` + `AGENTS.md` + `README.md`。
- **不建 `dsh-bili/lib/client.js`，不注册 `settings.section`**；客户端 UI 仍由旧面板 + 8788 工作台承担。
- 搬 3 个工具、`toolPolicy.contribute`、`onTick`/`onWake`、`sessions`、`prompt.section`、`/dsh-bili/*` 路由。
- 补 `/dsh-bili/status`、`/comment`、`/comment-body`、`/footprint`、`/cover`、`/risk`、`/sheet`、`/ledger`、`/outings`。
- core 删除 B 模块直接调用，保留 `/dsh-fish/*` B 路由代理；`/wake`、`/away`、`/owner`、`/browse`、`/history`、`/config` 留 core。
- 工作台 `routes.mjs` 只把 `fish→bili` 的项切到 `bili`；其余不动。

验收：

- 两包 `node --test` 全绿；合计 ≥ A1 用例数。
- 独立 fish-home 跑一天，事件流逐类对齐；日志无同分钟双刷。
- 插件停用后 core 不报错；bili 面回到 5 个工具；工作台 B 站页显示 `BILI_PLUGIN_ABSENT`，不白屏。
- `/sheet`、`/ledger`、`/outings` 返回真实数据；台账可读。
- `/owner`、`/wake`、`/away` 仍走 core，未被误切。

### P1：只读页面

- 总览、B 站（含出门/证据）、记忆、工具与规则、数据（日志查看、备份下载）、原理。
- 所有页面只调白名单里的 `GET`；`/comment` 只在进入页面或点刷新时触发一次。
- 前端拆模块，每个页面一个渲染函数；统一转义；不再增长单文件。
- 插件小修（如需）：`GET /inbox` 改为纯读，不重写 `inbox.md`；`GET /paths` 不写 readme。若暂不改，BFF 对这两个路由做同源校验并接受一次写盘，记为已知偏差。

验收：

- 各页数据与插件面板逐项一致（按 §8 清单）。
- 断网/上游 502 时显示上游错误，不白屏。
- 评论正文、日记、微信消息的恶意 HTML 不执行。
- 跨站 `<img>` 不能触发 `/comment`、`/comment-body`、`/selfcheck?net=1`。

### P2：写操作

- 环境页 `/config`（16 个键按 §4.4）。
- B 站 `/owner`（保存/验证 cookie）、`POST /risk {clear:true}`、`/wake?focus=browse`。
- 总览 `/say`、`/notify`、`/inbox`、`/decide`。
- 工具与规则 `POST /config {tools}`。
- 数据页 `/avatar`、备份/恢复/导入/重置/清日志。
- 通道页 `/wx/scan`、QQ/微信现有写操作、人工代操作确认。
- 每个写操作补 BFF 测试：方法白名单、body 上限、跨站拒绝、上游错误透传、确认字面量。

验收：

- 保存后服务端回读一致；未知配置键被拒绝；`persona` 被拒绝。
- 危险操作必须输入确认词；上游 `confirm` 未被绕过。
- 未登记方法 405；未登记路径 404；body 超限 413。
- 人工代操作有确认弹层与动作日志，且不写事件流。
- BFF 不直接写 `~/.dsh-fish`；通道配置与 `WORKBENCH_DATA` 的现有直接写入按 §2.1 保留并单列。

### P3：入口切换

- 工作台八项导航完整可用。
- 插件面板标为「旧入口」：设置 section 顶部提示「管理入口已迁到 8788 工作台」；停掉旧面板自动轮询（保留路由）。
- 双入口并存一个 `dsh-fish` minor 版本；两处读同一组路由，不双写、不缓存。
- 跑 §8 的双入口一致性清单。

验收：

- 从 8788 能完成 §4 的全部操作（按矩阵逐项打勾）。
- 面板与工作台显示同一份数据；写后回读一致。
- 关闭工作台后 8710 与插件不受影响。
- 旧面板不再自动轮询；无两套刷新节奏。

### P4：移除旧面板 UI（只注销 slot）

- 注销 `settings.section` 注册；`client.js`、`exports["./client"]`、`dsh.client` 保留。
- 插件 HTTP 路由与 `fishCore` 契约保留。
- core `/dsh-fish/*` B 路由代理保留到 P4 后一个 minor，再单独决定删除。
- 更新文案测试与 README；不删除数据。

验收：

- 宿主设置里不再出现旧面板；工作台全部功能正常。
- `client.js` 仍可被手动恢复注册；回滚只需恢复 slot。
- `src/dsh-fish` 与 `src/dsh-bili` 测试全绿。

---

## 7. 验收清单

### 功能覆盖

- [ ] §4.4 的 16 个配置顶层键全部在工作台有唯一可写入口。
- [ ] §3.4 路由表的每个路径/方法都有对应页面或明确“不在 UI 暴露”。
- [ ] B 站页包含出门与证据；`/sheet`、`/ledger`、`/outings`、`POST /risk` 可用。
- [ ] 旧面板九个页签的每个控件都能在 §3.4/§4 找到归宿（按评审对账表逐项打勾）。
- [ ] 8788 现有 QQ/微信/她/语音/帧存档/动作日志按钮按 §4.5 矩阵保留或退役。
- [ ] 人工代操作有标注、确认、动作日志；不写事件流。
- [ ] 事件“检索”只承诺 `type`/`limit` 列表；不出现全文检索文案。

### BFF / 安全

- [ ] 未登记路径 404；未登记方法 405；body 超限 413。
- [ ] 伪造 Host 403；跨站写请求 403；副作用 GET 跨站拒绝。
- [ ] BFF → 8710 的请求头符合 §3.2；带浏览器 Origin 的写请求成功。
- [ ] `/api/fish/*` 响应、错误、日志无 token/cookie；聊天/QQ WebUI 例外已标注。
- [ ] cookie 失效时单飞重认证一次并重放成功；业务 403 不误判为认证失败。
- [ ] 二进制/下载透传 `Content-Type`、`Content-Length`、`Cache-Control`、`Content-Disposition`；`/backup` 流式。
- [ ] `/say` 12MB、`/avatar` 4MB、`/import` 200KB、`/backup/restore` 96MB 不被 BFF 误拦。
- [ ] 不可信文本全部转义；CSP/nosniff 生效；恶意评论/日记/微信消息不执行脚本。
- [ ] 静态文件路径穿越（`..`、编码斜杠、反斜杠、绝对路径）被拒。
- [ ] 错误契约保留 `code`/`unknown`；插件缺席显示 `BILI_PLUGIN_ABSENT`。

### 部署 / 数据

- [ ] 旧 `watch.json`/`frames/` 迁移后回读一致；`WORKBENCH_DATA` 自动创建。
- [ ] `/opt/fish/workbench` 指向稳定的 `workbench-current`；worktree 清理不影响服务。
- [ ] systemd 保留 `HOME`、`DISPLAY`、日志；重启后工作台可用。
- [ ] 回滚到 pre-repo 可启动；新数据冻结规则写入 README。
- [ ] Windows 适配、`notify.ps1`、launcher、dist、打包脚本已从运行时引用中移除并归档；无第二个 8788。
- [ ] `workbench` 零依赖；`node --test` 全绿；`src/dsh-fish` 全绿。

### 双入口

- [ ] P3 的双入口一致性清单逐项通过（§3.4 全部路由的读、写后回读）。
- [ ] 旧面板不再自动轮询；工作台切走即停。
- [ ] P4 后旧面板 slot 不再挂载；路由与 `client.js` 保留；恢复 slot 可回滚。

---

## 8. 双入口一致性清单（P3 用）

对以下路由逐项对比旧面板与工作台的读数；写操作还要对比“写后回读”：

`status`、`state`、`events`、`beliefs`、`memory`、`diary`、`reports`、`templates`、`notify`、`inbox`、`decide`、`home`、`say`、`wake`、`away`、`owner`、`config`、`tools`、`rules`、`selfcheck`、`log`、`backup`、`import`、`reset`、`paths`、`update`、`avatar`、`media`、`browse`、`history`、`footprint`、`comment`、`comment-body`、`cover`、`risk`、`wx/scan`。

外加 8788 的：`/api/qq/*`、`/api/wx/*`、`/api/her/*`、`/api/speech`、`/api/watch`、`/api/frames`、`/api/status.log`。

---

## 9. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| token / cookie 泄露 | 只在进程内存；请求头白名单；错误/日志脱敏；`/api/fish/*` 不含凭据；聊天/QQ WebUI 例外显式标注 |
| 工作台变成第二套状态 | BFF 无业务缓存；页面每次回读上游；工作台不碰 `~/.dsh-fish` |
| 同源 XSS 打危险路由 | 全量转义；禁 `innerHTML`；CSP；Host/Origin；危险操作确认 |
| DNS rebinding | 所有请求校验 Host；跨站 Sec-Fetch 拒绝 |
| 请求头把写操作打成 403 | 固定上游 Host；剥离浏览器 Origin/Sec-Fetch；补集成测试 |
| 数据迁移丢失/回滚脑裂 | 停服务、复制不移动、回读校验、pre-repo 只读封存、回滚数据冻结 |
| Windows 双实例 | Windows 适配退役；启动脚本分支移除；启动前检查 8788 占用 |
| 符号链接指向临时 worktree | 用稳定的 `workbench-current`；worktree 清理不影响 systemd |
| 旧面板移除后没有退路 | P4 只注销 slot，保留 `client.js` 与路由；恢复 slot 即回滚 |
| `dsh-bili` 拆包后路由前缀变化 | 路由表按项登记 `upstream`；拆包只改表 |
| 插件缺席/贡献未生效 | 工作台 B 站页显示故障码；不白屏；selfcheck 补字段 |

回滚：

1. 工作台：`/opt/fish/workbench` 指回 `pre-repo`，`systemctl restart fish-workbench`；新数据冻结，需回拷单独确认。
2. 旧入口：撤销 P3 的横幅/轮询改动；P4 恢复 slot 注册。
3. 代码：Git revert 对应提交；事件流与配置不受影响，无需数据迁移。
4. A2：redeploy A1 提交；卸载 dsh-bili；保留 core 代理与数据。

---

## 10. 与既有设计的关系

### 10.1 对 `ARCHITECTURE.md` 的修订

- §0 读法：删“独立工作台 section”。
- §3 包职责表：`dsh-bili` 不再拥有“B 站工作台”。
- §3.2 打包元数据：工作台 UI 不再由插件包提供；`exports["./client"]` 只对过渡期旧面板成立。
- §4.1：工作台不再“只读为主”，改为“唯一管理入口，经 BFF 读写”。
- §6.8：改为“8788 工作台 → BFF → 插件路由；旧面板过渡期保留”。
- §7.3：`ctx.slots.register` 注明“不再是鱼/B 站管理入口”。
- §10：按本设计 §4 重写；10.2 改为过渡期旧入口；10.3 明确 core B 路由保留到 P4 后一个 minor。
- §11.2/§11.3：A3 改为工作台阶段；回滚改为工作台/P3/P4 回滚。
- §13.1/§13.3：自检与故障展示面改为工作台；补插件缺席文案。
- §14/§16：目标与 DoD 同步；加入本设计链接。

### 10.2 对 B 站集成设计 v2 的修订

- A0/A1 不受影响；A2 改为**后端拆包，不做 client/section**。
- A3 被本设计取代：B 站设置页、足迹、出门、证据迁进 8788 工作台，不再注册 `settings.section`。
- v2 §4.3 的 `dsh-bili/lib/client.js`、`exports["./client"]` 删除或标注仅过渡期。
- v2 §10.1–§10.5 的 UI 归属、出门、证据、代理时间线、插件缺席文案全部改为工作台。
- v2 §11 A3 的验收/回滚/DoD 改为 P1–P4。
- v2 §12.1/§12.4/§12.5/§12.7 的 UI 路由/插件缺席/出门页/空白页验收改为工作台。
- v2 §13.1/§13.3 的自检/故障码展示面改为工作台。
- v2 §14.2 D3/D10、§15、§16、§17 同步改写。

### 10.3 其他文档

- 根 `README.md:27`：“工作台全量迁移”改为“8788 工作台单入口”。
- `src/dsh-fish/README.md` 中 settings.section/设置入口说明标注过渡期。
- `2026-11-10` 评审的 P0-7（工作台 section 唯一先例）加“已被 2026-11-11/11-12 单入口设计取代”注记。
- `2026-11-09-bigfish-person-core-surfaces-design.md` 的“第一版 UI 暂留 core/观测台”加注记。

---

## 11. 非目标

- 不做移动端适配或远程访问。
- 不做多用户、登录、权限分级。
- 不做工作台内嵌聊天。
- 不做事件流的可视化编辑器或全文检索。
- 不把 QQ / 微信 / 语音的策略文件迁到插件路由（留给后续单独设计）。
- 不删除任何插件路由或数据。
- 不做 Windows 桌面工作台、exe、PowerShell toast。
- 不提供 B 站代发评论。

---

## 12. 实施时待确认（不阻塞本稿评审）

- `observe.*`、`ui.*` 的具体子键以 `settings.js` 的 `DEFAULTS` 为准，P0 计划里逐项列出。
- `/outings` 的响应字段（今日次数/配额、最近投递、待回复）在 A2 计划里定稿。
- `/sheet` 是单张抽帧还是拼图、缓存多久，在 A2 计划里定稿。
- 浏览器通知是否启用 `Notification API`；默认只做页面内提示，不依赖 PowerShell。
- `GET /inbox` / `GET /paths` 的只读小修是否放进 P1；若不放，按 §7 P1 的已知偏差处理。
