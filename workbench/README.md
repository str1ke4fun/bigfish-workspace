# 大肥鱼工作台（8788）

浏览器唯一直接访问的管理入口。工作台只做页面、导航、交互和 BFF；状态、配置、事件流、
调度和校验仍然在 `src/dsh-fish`（A2 后 B 站部分在 `src/dsh-bili`）。

- 单入口设计：`docs/superpowers/specs/2026-11-12-workbench-single-entry-design-v2.md`
- 改版设计：`docs/superpowers/specs/2026-11-13-workbench-redesign-design.md`
- 当前阶段：P0–P4 源码完成（四组导航、二级页签、日 / 夜主题、通道适配器、只读与写操作）；
  P5 线上逐项验收待执行。commit 不代表已部署或已验收。
- 零依赖，Node.js 20+

## 页面结构

左侧书脊是四个大类，每个大类下是二级页签：

| 大类 | 页签 |
| --- | --- |
| 她 | 今天 · 记忆 · 成长 |
| B 站 | 今天 · 足迹 · 管理 |
| 通道 | 总览 · QQ · 微信 |
| 系统 | 设置 · 工具与规则 · 日志 · 数据 · 原理 |

- 地址是 hash 路由 `#<大类>/<页签>`，默认落到 `#her/today`；页面切换用
  `history.replaceState`，不往浏览器历史里堆。
- 旧地址（`#overview`、`#memory`、`#bili`、`#env`、`#tools`、`#data`、
  `#principles`、`#channels/qq` 等）映射到新地址，保留一个发布版本。
- 主题是 `<html data-theme="day|night">`，切换结果存在 `localStorage['fish.theme']`；
  `assets/theme-boot.js` 在样式表之前同步读，首屏不闪。未设置时跟随系统。
- 窄屏（≤900px）书脊折成顶部横条，页面单列；长文本统一 `overflow-wrap:anywhere`，
  焦点有 `:focus-visible` 外圈，`prefers-reduced-motion` 时关掉过渡。

### 扩展点

- 页面：`assets/pages/<name>.js` 导出 `{ id, nav, slug, label, order, enter(root, ctx), leave() }`，
  在 `assets/nav.js` 的 `NAV` 里登记。页面自己建 DOM，不用 `innerHTML`；上游文本一律
  `textContent`。`ctx` 提供 `go(nav, slug)`、`onStatus(fn)`、`setBadge(navId, level)`、
  `refreshStatus()`。
- 通道：`assets/channels/<id>.js` 导出
  `{ id, label, order, badge(status), summary(status, ctx), renderPanel(root, ctx), refresh(ctx), leave(), humanActions }`，
  在 `assets/channels/registry.js` 的 `CHANNELS` 里登记；总览和二级页签都由注册表生成，
  新增 QQ / 微信之外的通道只改适配器。
- 配置表单：`assets/config-form.js` 的 `configGroup()` 按组读写 `/config` 的顶层嵌套键，
  保存只提交这一组。

旧的 `pages/overview.js`、`pages/bili.js`、`pages/memory.js`、`pages/env.js`、
`pages/tools.js`、`pages/data.js`、`pages/principles.js`、`channels.js`、
`legacy-channels.js`、`legacy-pages.js` 已不被外壳和新页面引用，保留一个发布版本，
下一版删除（删除前单独确认）。

## 启动

```bash
cd workbench
node server.mjs
# http://127.0.0.1:8788/
```

只绑 `127.0.0.1`。正式运行由 systemd 管理，不要手工再起第二个进程。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WORKBENCH_PORT` | `8788` | 监听端口 |
| `WORKBENCH_HOME` | `$HOME`，再退回 `/home/str1k3` | 通道配置与她的运行数据所在家目录 |
| `WORKBENCH_DATA` | `$WORKBENCH_HOME/.fish-workbench` | 工作台自己的运行数据 |
| `FISH_ENTRY_ORIGIN` | `http://127.0.0.1:8711` | 聊天入口/一次性 token |
| `FISH_WEB_ORIGIN` | `http://127.0.0.1:8710` | dsh 宿主与插件路由 |
| `WORKBENCH_VERSION` | `0.1.0` | BFF 的 `User-Agent` 版本 |
| `WORKBENCH_PHASES` | `P0,P1,P2` | 放开的阶段，逗号分隔；调试时可用 `P0,P1` 退回只读、`P0` 退回骨架 |
| `WORKBENCH_DISABLE_WATCH` | 未设置 | 设为 `1` 时不起 QQ 掉线观察循环（测试用） |

`WORKBENCH_DATA` 下放 `watch.json`、`frames/`。启动时自动 `mkdir -p`。
**例外**：`hold.json` 仍在 `$WORKBENCH_HOME/.dsh-wx/hold.json`，因为
`scripts/fish_watchdog.py` 读它；搬走会让“停止她”失效。要迁移必须同时改看门狗。

## BFF

浏览器只访问 `/api/fish/*`，工作台进程持有 8710 的 cookie：

1. `GET 8711/` → 从 `Location` 取一次性 `token`；
2. `GET 8710/?token=...` → 从 `Set-Cookie` 取 30 天 `dsh-auth-*`；
3. 后续请求带 `Cookie` 直连 8710；
4. 上游 `401`/`403` 时丢弃缓存、单飞重认证一次并重放；重放仍 `403` 视为业务拒绝；
5. 8711 未就绪 → `503 AUTH_UNAVAILABLE`；8710 不可达 → `502 UPSTREAM_UNAVAILABLE`。

请求头只发 `Cookie`、`Content-Type`、`Accept`、`User-Agent`（以及 fetch 自带的 Host/
Content-Length 等传输头）；浏览器的 `Origin`、`Referer`、`Sec-Fetch-*`、`Cookie` 一律剥离。
token/cookie 不写日志、不进 `/api/fish/*` 响应。

路由白名单在 `fish/routes.mjs`。每条路由标注阶段（`P0` / `P1` / `P2`）和上游
（`fish` → `src/dsh-fish`，`bili` → `src/dsh-bili`）。未登记路径 404，阶段未开 404，
未登记方法 405，body 超限 413，默认 256 KB / 30 秒。A2 拆包只改 `upstream` 列；
上游路径与 BFF 路径不同名时用 `target`（当前只有 `bili/status` → `/dsh-bili/status`）。

P1 只放 `GET`：

- 总览：`status`、`state`、`bili/status`、`tools`、`events`、`beliefs`、`inbox`、`home`、`away`；
- B 站：`owner`、`bili/status`、`history`、`comment`、`comment-body`、`cover`、`outings`、`risk`、`ledger`、`sheet`、`footprint`；
- 记忆：`events`、`diary`、`reports`、`beliefs`、`templates`；
- 工具与规则：`tools`、`config`、`rules`、`selfcheck`；
- 数据：`log`、`paths`、`update`、`avatar/info`、`avatar`、`log/export`、`backup`。

P2 放开的写方法（都要求同源 `Origin`，跨站直接 403）：

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `config` | POST / PUT | 16 个白名单键，`persona` 永不接受 |
| `notify` | POST | `{shown:true}` 或 `{enabled:boolean}` |
| `inbox` | POST | 标为已读 |
| `decide` | POST | `approve` / `reject` 待裁决申请 |
| `say` | POST | 跟她说一句，可带图片，12MB / 120 秒 |
| `wake` | POST | 人工叫醒，180 秒 |
| `owner` | POST / PUT | B 站领养人，cookie 只上行不回显 |
| `log/clear` | POST | 清空运行日志 |
| `backup/restore` | POST | 恢复备份，96MB / 300 秒，前端要求输入 `restore` |
| `import` | POST | 导入交接单，200KB（与上游 `readBody` 同一上限，超出直接 413） |
| `reset` | POST | 重开一局，要求 `{confirm:"reset"}` |
| `avatar` | POST | 上传/移除头像，4MB；原图上限 2MB 在页面侧先拦 |
| `wx/scan` | POST | 微信会话目录补扫（通道页按钮；不是扫码登录） |
| `risk` | POST | `{clear:true}` 解冻，页面二次确认 |

确认弹层只是 UX，不是安全边界；上游自己的 `confirm` 字面量必须原样传递。
通道页的 QQ / 微信 / 语音 / 画面走工作台本地 `/api/*`，不经 BFF。

人工代操作（QQ 以她的身份发一句、微信窗口打字/回车/按键）在按钮文案和页面说明里
显式标注，操作前二次确认；服务端把动作记为人工动作（操作者=人、通道、目标、结果），
不写 `events.jsonl`，不算她的行为。

工作台进程自己维护的只读接口只有 `GET /api/status.log`（最近 20 条动作，不触发检查）。
`/comment` 只在进入 B 站页或点刷新时请求一次，不做自动轮询。

**已知偏差**：上游 `GET /inbox` 会重写信箱文件、`GET /paths` 会补路径——两个读接口
本身都会写一次文件，路由表因此用 `sideEffect: true` 做同源校验。P2 只给 `/inbox`
补了「标为已读」的 POST，两个读接口的形状都暂不改；`/paths` 仍只有 GET。

## 安全边界

- 所有请求校验 `Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`，防 DNS rebinding；
- 写请求校验 `Origin` 同源，`Sec-Fetch-Site: cross-site` 直接拒绝；
- 有副作用的 GET（评论扫描、自检、封面/抽帧懒加载、查更新等）拒绝跨站触发；
- 静态文件只服务 `index.html` 与 `assets/`，先 `resolve` 再 `relative`，拒绝 `..`、
  编码斜杠、反斜杠、绝对路径；
- 所有响应 `X-Content-Type-Options: nosniff`；HTML 带 CSP；
- 上游文本进页面一律 `textContent` / `escapeHtml()`，不拼 `innerHTML`。

## 部署与数据迁移（P0，一次性）

从旧的 `/opt/fish/workbench` 迁到仓库工作树。**先停服务、复制而不是移动**：

```bash
systemctl stop fish-workbench
mkdir -p /home/str1k3/.fish-workbench/frames
cp -a /opt/fish/workbench/watch.json /home/str1k3/.fish-workbench/watch.json
cp -a /opt/fish/workbench/frames/. /home/str1k3/.fish-workbench/frames/
mv /opt/fish/workbench /opt/fish/workbench.pre-repo
ln -s <worktree>/workbench /opt/fish/workbench-current
ln -s /opt/fish/workbench-current /opt/fish/workbench
```

`<worktree>` 用稳定的集成工作树，不要指向会被清理的临时 worktree。
旧 `watch.json` 当前是 `{"enabled":true,"pollSeconds":30,"nagMinutes":0,"notifyRecover":false}`；
迁移后用 `GET /api/watch` 回读并断言一致。

systemd 模板见 `scripts/systemd/fish-workbench.service`。切换开发线/主线 =
重指 `workbench-current` + `systemctl restart fish-workbench`。

回滚：

```bash
systemctl stop fish-workbench
rm /opt/fish/workbench            # 只是符号链接
ln -s /opt/fish/workbench.pre-repo /opt/fish/workbench
systemctl start fish-workbench
```

回滚后旧服务继续读 pre-repo 里的旧 `watch.json`；新数据冻结，需要回拷时单独确认。
（`rm` 针对的是符号链接，执行前仍按项目约定单独确认。）

## 测试

```bash
cd workbench
node --test
```

测试用假上游（8711/8710 的本地替身），不碰真实服务、不写 `~/.dsh-fish`。
改版后的断言分布在 `theme.test.mjs`（主题引导）、`router.test.mjs`（hash 与旧地址）、
`shell.test.mjs`（导航 / 页签 / 挂载点）、`pages.test.mjs`（各页契约与数据源）、
`channels.test.mjs`（通道适配器）、`assets.test.mjs`（无 `innerHTML`、窄屏、旧文件
不被引用），以及原有的 `server.test.mjs` / `bff.test.mjs` / `routes.test.mjs` /
`security.test.mjs`。

P5 手工验收按 spec 13.2 逐项走，结果只记录当次实际看到的：默认落点、日 / 夜刷新保持、
390px 窄屏、B 站五个写动作、QQ 启停 / 扫码 / 人工发送、微信画面 / 点按 / 打字 / 回车 /
Esc / 允许说话 / 补扫 / 清理、系统工具白名单 / 自检 / 日志 / 备份 / 路径 / 头像、
跨站 POST 403 / 错误 Host 403、`assets/../server.mjs` 404。停 8710 验证错误态前先取得
用户同意，验证完恢复；UI 能打开不等于消息收发已验收。

## 已退役

Windows 桌面交付、`host/win.mjs`、`notify.ps1`、`launcher/`、`dist/`、打包脚本和
`fish-up.sh`/`boot-chain.*` 不再进入仓库运行时。工作台只在 Linux/WSL 本机运行。
