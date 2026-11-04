# 大肥鱼常驻宿主：自启动、持久化与分层重试

日期：2026-11-04
状态：设计已口头确认，待评审后写实施计划

## 1. 背景

2026-11-04 开机后，工作台（8788）和微信（`:99`）都起来了，但大肥鱼没醒：微信耳朵 `dsh-wx` 只挂在 DSH Desktop NEXT 里，而 Desktop 没有任何开机自启。工作台和微信服务都是 systemd 管的，Desktop 不是，所以整条链路里唯一“没人负责”的一环正好是鱼的宿主。

临时补救是在 `~/.config/systemd/user/` 加了 `dsh-desktop-next.service`，让 Electron 应用随用户会话启动。但这要求前台一直挂着一个桌面窗口，不是长期方案。

用户已确认两个方向：

1. **Web 宿主独占，Desktop 退役**：由 `dsh-web`（profile `web`，端口 8710）同时承载 `dsh-fish` 和 `dsh-wx`。
2. **改造现有 web profile / 8710**，不新建 profile、不新占端口。

本设计要解决的不只是“起得来”，而是用户明确提出的：**自启动和持久化要配合起来，任何一环挂了或没起来，都要有简单的重试，不能静默中断。**

## 2. 目标与非目标

### 目标

- 开机后无需人工操作，鱼的宿主和耳朵自动就绪。
- 全链路只有一个 `dsh-fish` / `dsh-wx` 写者，不出现 `session.lock` 双写。
- 每一层都有明确的监督者：WSL、systemd、Xvfb、微信、DSH 宿主、耳朵循环、鱼的会话。
- systemd 能处理的崩溃交给 systemd；systemd 看不见的“进程活着但耳朵停摆”由看门狗处理。
- 保留现有的鱼历史、事件流和会话，不重建、不覆盖。
- 前台不再需要 Electron 窗口。

### 非目标

- 不改耳朵的识别、投递、回声保护等业务语义。
- 不做多宿主高可用或热备。
- 不修改 DSH 上游代码（`dsh-fish` 的重试属于本项目插件自身的健壮性修复）。
- 不在本轮改造工作台 UI；看门狗只写状态文件，工作台展示留待以后。

## 3. 现状事实

| 事实 | 证据 |
| --- | --- |
| `dsh-web` 是系统服务，`Restart=always`，端口 8710 | `/etc/systemd/system/dsh-web.service` |
| web profile 当前 bundles：`dsh-base`、`dsh-web-app`、`dsh-fish`，没有 `dsh-wx` | `~/.dsh/profiles/web/package.json` |
| web profile 的依赖里已经有 `dsh-wx` 链接，只差加进 bundles | 同上 |
| web profile 的 `dsh-fish.root` 是 `~/.dsh-fish-web`，不是真鱼 | `~/.dsh/profiles/web/cordis.patch.yml` |
| Desktop profile 的 bundles 含 `dsh-wx`、`dsh-fish` | `~/.dsh/profiles/desktop/package.json` |
| Desktop 现在由用户级 systemd 单元启动 | `~/.config/systemd/user/dsh-desktop-next.service` |
| `dsh-wx` 每 5 秒一轮耳朵；只有 `policy.enabled && policy.watch !== false` 时才跑并写 `health.json` | `src/dsh-wx/lib/index.js:1336-1340`、`:710` |
| `health.json` 每轮 `look()` 成功后写入 `at`、`tree.status`、聊天数等 | `src/dsh-wx/lib/index.js:716-735` |
| `dsh-fish` 只在 apply 时调用一次 `bootstrapHome`，失败只记日志、不重试 | `src/dsh-fish/lib/index.js:154` |
| `workspaceRegistry` / `sessionController` 在宿主里异步出现，启动瞬间可能还没有 | 2026-11-03 `~/.dsh-fish-web/logs/dsh-fish.log` |
| 真鱼的会话 `session-0891f0b7`（以及 `session-2d758dc0`）的 `agentPreset` 是 `standard` | 解压会话日志首行 |
| web 宿主跑 `standard` 会失败：`workflow-ptc … never started` | 2026-11-03 09:48:20 `dsh-fish-web` 日志 |
| web profile 已安装 `@deepseek-ai/dsh-workflow`（提供 `workflowEngine`）和 `dsh-workflow-ptc`，但没有把引擎加载进 profile | `~/.dsh/profiles/web/package.json`、`node_modules/@deepseek-ai/` |
| web 自己的鱼屋 `~/.dsh-fish-web` 用 `fish-home` preset，能正常建会话 | `~/.dsh-fish-web/config.json` |
| 耳朵在当前策略下健康：`tree.status=ok`、9 个聊天、`treeCalls` 持续增长 | `~/.dsh-wx/health.json` |

### 关键前置问题：真鱼会话的 preset

真鱼的两个会话都固定在 `standard`。web 宿主缺 workflow 引擎，`standard` 建/开会话会失败。因此“把 web 的 `dsh-fish.root` 改到 `~/.dsh-fish`”不能只看配置改对，还必须让 web 宿主能跑 `standard`，否则鱼醒着但没有可用的会话窗口。

设计采用的主方案：在 web profile 里加载 `@deepseek-ai/dsh-workflow`，让 `standard` 真正可用。若实施时验证失败，回退方案是：保留旧会话文件不动，把 `home.json` 指向一个新的 `fish-home` 会话；这会让对话窗口换新，但事件流、日记和历史会话都保留。**回退方案需要再次征得用户同意后才执行。**

## 4. 目标架构

```
Windows 登录
└─ FishKeepAlive.vbs（循环保活）
   └─ WSL / systemd（linger 已开）
      ├─ xvfb-fish.service        Restart=always
      ├─ wechat-fish.service      Restart=always，启动前等 AT-SPI 总线
      ├─ dsh-web.service          唯一宿主：profile=web，8710
      │   ├─ dsh-fish             root = ~/.dsh-fish（真鱼）
      │   └─ dsh-wx               display = :99（耳朵）
      ├─ fish-entry.service       8711 → 8710，Restart=always
      ├─ fish-workbench.service   8788，Restart=always
      └─ fish-watchdog.timer      每 60s 检查“宿主活着但耳朵停摆”
```

数据流不变：

- 微信窗口 → `dsh-wx` 每 5s 读 AT-SPI 树 → 写入 `~/.dsh-wx/health.json`，有新消息时投递到鱼的会话。
- `dsh-fish` 负责屋子、身份、事件流、提醒和工具面。
- 8711 是固定入口，302 到带 token 的 8710。
- 工作台 8788 不是 DSH 宿主，只读状态并做按钮操作。

## 5. 归属与 profile 变更

### 5.1 web profile

`~/.dsh/profiles/web/package.json`：

- bundles 增加 `dsh-wx`，顺序放在 `dsh-fish` 之前。
- 依赖保持不变（`dsh-wx`、`dsh-fish`、`dsh-workflow`、`dsh-workflow-ptc` 已存在）。

`~/.dsh/profiles/web/cordis.patch.yml`：

- `dsh-fish.root` 从 `/home/str1k3/.dsh-fish-web` 改为 `/home/str1k3/.dsh-fish`。
- 增加 `dsh-wx` 的配置覆盖：`display: ':99'`（与默认一致，但显式写出）。
- 增加 `workflow-engine` 的 insert 条目加载 `@deepseek-ai/dsh-workflow`，使 `standard` preset 可用；保留现有的 `preset-fish-home` 克隆，作为 `fish-home` 备用。
- 现有 LLM provider、默认模型等配置不动。

### 5.2 Desktop profile 与单元

- 先停用 Desktop：`systemctl --user disable --now dsh-desktop-next.service`。
- 单元文件保留，便于回滚。
- 从 `~/.dsh/profiles/desktop/package.json` 的 bundles 移除 `dsh-wx`、`dsh-fish`，防止以后误点图标时成为第二个写者。
- Desktop 的 `dsh.desktopNext*` 字段不动。

### 5.3 开发与验证环境：dev 优先

所有源码改动和端到端验证先在 `dev` 工作区完成，主工作区不合并未验证的改动。

- dev 工作区：`/home/str1k3/src/bigfish-workspace-dev`，分支 `dev`。
- 实施前先把 `dev` 快进到 `main`（当前只差文档提交），保证 dev 上有本 spec。
- `dsh-fish` 的源码改动只改 dev；验证期间只把 web profile 的 `dsh-fish` 链接临时指向 dev 的 `src/dsh-fish`，`dsh-wx` 仍用主工作区版本。
- 记录并备份两个链接的原始目标，验证结束或回滚时恢复。
- 只有端到端验证通过、用户确认后，才把 `dev` 合并回 `main`；合并后重新指向主工作区并重启宿主复验一次。

### 5.4 切换顺序（避免双写）

分两阶段，第一阶段不碰生产耳朵：

**阶段 A：不中断的 preset 验证**

- 用 web profile 的副本在空闲端口（如 8712）起临时宿主。
- 鱼根目录指向临时目录，`dsh-wx` 在临时 profile 中禁用，避免第二个耳朵投递。
- 目标：证明加载 `@deepseek-ai/dsh-workflow` 后，`standard` preset 能新建会话并完成一轮对话。
- 不影响 8710、真鱼 `~/.dsh-fish`、Desktop 和当前耳朵。
- 失败：按第 3 节回退方案处理，先征得用户同意，不进入阶段 B。

**阶段 B：真实切换**

1. 停 Desktop 单元，确认进程退出。
2. 备份 web/desktop profile 的三个文件。
3. 改 web profile，改 desktop bundles，临时把 `dsh-fish` 链接指向 dev。
4. `systemctl restart dsh-web.service`。
5. 验证 web 宿主复用了 `session-0891f0b7`，耳朵持续写 health，且没有第二个 `dsh-fish` 进程。
6. 验证通过并经用户确认后，合并 `dev` → `main`，把链接恢复指向主工作区，重启宿主复验。
7. 任何一步失败：按第 12 节回滚，不继续改看门狗。

## 6. 故障矩阵

| 故障 | 监督者 | 处理 |
| --- | --- | --- |
| Windows 关闭 / WSL VM 退出 | `FishKeepAlive.vbs` | 循环执行 `wsl.exe -d Ubuntu-26.10 -u root -- sleep infinity`，退出后等 60s 重试 |
| WSL 内 systemd 未启动 | Windows 保活 + systemd | 保活进程拉起 WSL；启用过的单元自动启动 |
| Xvfb `:99` 崩溃 | systemd | `Restart=always`，2s |
| 微信崩溃/被杀 | systemd + `dsh-wx` | 服务级 `Restart=always`；插件初始化阶段最多重启 2 次，之后只告警 |
| 微信未登录 | 插件 + 工作台 | `tree.status=login`，不重启宿主；health 持续新鲜，看门狗不介入 |
| `dsh-web` 进程崩溃 | systemd | `Restart=always`，5s，无启动次数上限 |
| 宿主活着但 HTTP 8710 不通 | 看门狗 | 重启 `dsh-web` |
| 宿主活着但耳朵停摆（health 不更新） | 看门狗 | 微信/Xvfb 正常时重启 `dsh-web`；异常时先拉起依赖服务 |
| `workspaceRegistry` 启动晚 | `dsh-fish` 自身 | 有界重试（第 8 节） |
| 微信会话丢失 | `dsh-wx` | 每轮 `ensureWxSession` 重试 |
| 8711 / 8788 崩溃 | systemd | `Restart=always` |

## 7. 看门狗

### 7.1 形态

- 脚本：`/usr/local/sbin/fish-watchdog`（Python 3 标准库，无第三方依赖）。
- 单元：`/etc/systemd/system/fish-watchdog.timer`，每 60 秒触发一次 `fish-watchdog.service`（`Type=oneshot`）。
- 以 root 运行，只做检查和 `systemctl restart/start`，不读写鱼的历史文件。
- 支持 `--dry-run`：只打印决策，不执行；用于验收和排障。

### 7.2 检查与决策

每轮按顺序：

1. `systemctl is-active dsh-web.service` 不是 `active`，或 `http://127.0.0.1:8710/` 在 5 秒内没有 HTTP 响应 → 判定“宿主不健康”。若服务正处于 `activating`，等下一轮，不和 systemd 抢重启。
2. 读取 `~/.dsh-wx/policy.json`。只有 `enabled === true && watch !== false` 时才检查耳朵新鲜度；否则跳过第 3 步。
3. 读取 `~/.dsh-wx/health.json` 的 `at`。距现在超过 **120 秒** → 判定“耳朵停摆”。

决策：

- 宿主不健康 → 重启 `dsh-web`。
- 耳朵停摆：
  - `xvfb-fish.service` 或 `wechat-fish.service` 不是 active → `systemctl start` 对应服务，本轮不重启宿主。
  - 两者都 active → 重启 `dsh-web`。
- 其他情况 → 记录 `ok`，不动作。

微信登录态、树 `down`、树 `partial` 都不触发重启：这些情况下 `look()` 仍会写 `health.json`，新鲜度正常；它们需要的是人工确认或微信自己恢复，重启宿主无益。

### 7.3 限流与退避

- 状态文件：`/run/fish-watchdog/state.json`（tmpfs，重启后清空）。
- 同一类动作最短间隔 **600 秒**。
- 连续 3 次重启后耳朵仍不新鲜：间隔退避到 **1800 秒**，继续重试，不永久停止。
- 每次动作和判定写 journal（`journalctl -u fish-watchdog`），并追加到 `~/.dsh-wx/watchdog.json`（保留最近 50 条），供工作台以后读取。
- `watchdog.json` 记录：时间、判定、动作、health 年龄、tree 状态、连续失败次数。

### 7.4 看门狗不做什么

- 不杀微信进程，不点微信界面。
- 不修改 `policy.json`、`health.json`、会话或事件流。
- 不在 `dsh-web` 启动后的前 90 秒内因耳朵不新鲜而重启（给宿主和插件初始化留时间）。

## 8. `dsh-fish` 启动重试

### 8.1 问题

`src/dsh-fish/lib/index.js:154` 在插件 apply 时调用一次 `bootstrapHome`。宿主的 `workspaceRegistry` / `sessionController` 是异步服务，插件先于它们就绪时会得到 `{ok:false, why:'宿主没有 workspaceRegistry 服务'}`，之后再也不尝试，鱼就一直没有屋子。

### 8.2 行为

- 对 `bootstrapHome` 增加有界重试：最多 10 次，间隔 1.5 秒（总计约 15 秒）。
- 不复用中文错误字符串做判断。`home.js` 在“宿主服务还没出现”的两处返回上增加结构化标记 `retryable: true`（`宿主没有 workspaceRegistry 服务`、`宿主没有 sessionController 服务`），`bootstrapHome` 原样透传；`index.js` 只对 `!ok && retryable` 重试。
- 建会话本身失败（例如 preset 起不来）不带 `retryable`，不重试，保持现有的一次性失败日志，避免掩盖真实配置错误。
- 每次重试记一行 `warn`，最终成功记 `屋子就绪`，最终失败保留现有错误日志。
- 重试期间不阻塞其他插件的 apply：使用定时器/异步等待，不 sleep 整个宿主。
- 插件 dispose 时取消未完成的重试。

### 8.3 测试

- 在 `src/dsh-fish/test/home.test.mjs` 增加：假的 ctx，`workspaceRegistry` 前 N 次返回缺失、之后返回正常，断言最终 `ok:true` 且调用次数符合预期。
- 增加：非服务缺失类错误（不带 `retryable`）只调用一次。
- 增加：重试进行中 dispose，不再继续调用。
- 运行 `src/dsh-fish` 的完整 `node --test`（基线 641 项）后提交。

## 9. systemd 单元调整

### 9.1 `dsh-web.service`

- `[Unit]` 增加：
  - `After=network-online.target xvfb-fish.service wechat-fish.service`
  - `Wants=network-online.target xvfb-fish.service wechat-fish.service`
  - `StartLimitIntervalSec=0`
- `[Service]` 增加：
  - `Environment=XDG_RUNTIME_DIR=/run/user/1000`
  - `Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`
- 保留 `Restart=always`、`RestartSec=5`、`TimeoutStopSec=20`。
- `ExecStartPre` 的日志截断保留，但看门狗的健康判断以 `health.json` 和 HTTP 为准，不依赖日志内容。

### 9.2 其他单元

- `xvfb-fish`、`wechat-fish`、`fish-entry`、`fish-workbench` 已有 `Restart=always`，不改。
- `wechat-fish` 的 AT-SPI 顺序 drop-in 保留。
- 新增 `fish-watchdog.service` + `fish-watchdog.timer`。

### 9.3 权限

- `/etc/systemd/system/` 下的改动需要 sudo。当前会话没有免密 sudo，实施时由用户在 `!` 前缀下执行，或先配置好 sudo 规则。
- 看门狗以 root 运行，不需要给用户额外 sudo 权限。

## 10. Windows 保活

`C:\Users\ASUS\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\FishKeepAlive.vbs` 当前只执行一次 `wsl.exe -d Ubuntu-26.10 -u root -- /bin/sleep infinity`。改为循环：

- 启动 WSL 保活命令。
- 命令退出后等待 60 秒，再次启动。
- 整个循环隐藏窗口运行，不弹控制台。

这保证 WSL 被意外关闭后还能再起来。Windows 侧的实际重启验证由用户完成。

## 11. 验收

### 11.1 静态与单元测试

- 在 dev 工作区 `src/dsh-fish`：`node --test` 全绿（含新增重试测试）。
- `fish-watchdog --dry-run` 在健康状态下输出 `ok`，不执行动作。

### 11.2 阶段 A：临时宿主验证

- 8712 临时宿主启动成功，没有出现 `workflow-ptc … never started`。
- 用 `standard` preset 新建会话并完成一轮对话。
- 真鱼 `~/.dsh-fish`、8710、Desktop、当前耳朵都没有被改动。

### 11.3 阶段 B：切换后功能验证

1. `systemctl status dsh-web` 为 active；8710 和 8711 可访问。
2. `~/.dsh/logs` 或 `dsh-web.log` 出现 `[dsh-wx] mounted`。
3. `~/.dsh-wx/health.json` 的 `at` 持续更新，`tree.status=ok`，聊天数大于 0。
4. web 宿主复用 `session-0891f0b7`（或明确记录为何换成新会话），鱼的 `events.jsonl` 未被重写。
5. `pgrep -f 'dsh-fish|host.js'` 只有一个 DSH 宿主；Desktop 进程不存在。
6. 8711 打开后能看到鱼，能正常对话一轮。

### 11.4 故障演练

- `systemctl kill -s KILL dsh-web`：systemd 拉起，耳朵在 2 个轮询周期内恢复。
- `kill -STOP <dsh-web 主进程>`：health 停止更新，看门狗在 120–180 秒内重启宿主；`kill -CONT` 后的旧进程不再持有锁。
- 停 `wechat-fish`：先由 systemd 拉起；若未拉起，看门狗只拉微服务、不重启宿主。
- `fish-watchdog --dry-run` 对上述状态给出正确判定。

需要 sudo 或会影响现场的操作，由用户确认后执行。Windows 冷启动验证需要用户实际重启一次。

## 12. 回滚

1. `systemctl --user enable --now dsh-desktop-next.service`。
2. 恢复 `~/.dsh/profiles/web/package.json`、`~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/profiles/desktop/package.json` 的备份。
3. 把 web profile 的 `dsh-fish` 链接恢复指向主工作区。
4. `systemctl restart dsh-web.service`。
5. 停用并移除 `fish-watchdog.timer` / `fish-watchdog.service`（保留脚本文件）。
6. 确认 Desktop 重新成为唯一耳朵，web 不再加载 `dsh-wx`。

备份放在 `~/.dsh/backups/2026-11-04-resident-host/`，包含原文件和时间戳。

## 13. 风险与开放点

- **`standard` 在 web 宿主能否真正跑起来**：这是本设计最大的不确定性。加载 `@deepseek-ai/dsh-workflow` 后需要在实施时先做一次最小验证；失败则按第 3 节的回退方案处理，且回退前征得用户同意。
- **上游版本升级**：DSH 升级可能改变 preset、bundle 和 `dsh-workflow` 的解析方式；升级后需要重跑第 11 节的验证。
- **看门狗误判**：耳朵在某些合法长时间操作（例如大批量 OCR）中可能超过 120 秒不写 health。120 秒阈值按 5 秒轮询、24 轮漏写设定；若实测误判，调到 180 秒。
- **单写者**：只要 Desktop 单元被重新启用，就可能双写。除 profile 移除插件外，不额外做锁级互斥；这是有意的简化。
- **Windows 保活**：VBS 循环无法从 WSL 内部验证，最终以用户重启为准。
