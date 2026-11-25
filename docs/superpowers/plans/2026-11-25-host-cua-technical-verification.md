# 宿主 CUA 技术验证计划（G2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Windows 宿主上证明 cua-driver 0.55.0 的 MCP 服务、后台输入、截图、权限和生命周期边界，并单独验证 DSH 的 MCP client 能否在托管模式下动态挂载/卸载；用证据决定生产客户端和默认参数。

**Architecture:** 先用独立 WSL `node` 进程直连 `cua-driver.exe mcp --direct`，建立协议与能力基线；再用一个临时 DSH profile（端口 8790，不改 8710/`~/.dsh-fish`）验证 DSH MCP client 的动态 entry、工具名、调用和 dispose。所有验证只做只读或用户显式发起的应用内输入，不做前台切换、不提权、不碰微信/飞书。

**Tech Stack:** WSL2 + Windows 11 26200、Node.js 20+、`cua-driver.exe 0.55.0`（来自 `dsh-cua-driver@0.1.2` 的 vendor）、MCP newline-delimited JSON-RPC、DSH 0.2.1-rc.5 / `@deepseek-ai/dsh-mcp-client`、PowerShell/C# `PrintWindow`。

**Spec:** `docs/superpowers/specs/2026-11-25-host-cua-architecture-design.md`

## Global Constraints

- 验证代码全部放在 `/tmp/host-cua-verify` 或临时 profile `~/.dsh/profiles/hostcua-probe`；不改 `~/.dsh/profiles/web`、不改 `~/.dsh-fish/events.jsonl`、不部署到 8710。
- 驱动固定 0.55.0；不执行升级；不传 `--grant existing-profile`；不使用 `launch_app`/`kill_app`/`run_script`/`set_window_frame`/剪贴板/CDP/录制回放。
- 只测 `delivery_mode:"background"`；不调用 `foreground`，不调用 `bring_to_front`，不 `SetForegroundWindow`。
- 不测微信/飞书/密码管理器；不输入任何真实凭据；测试文本只用 `host-cua verify 123` 这类无意义串。
- 驱动默认遥测要关闭；验证结束后确认 `telemetry status` 为 disabled。
- 任何验证失败先保留现场（日志、进程、窗口截图），不自动清理或重试前台。
- 证据写进 `docs/research/2026-11-25-host-cua-verification.md`；只提交这份证据和计划更新，不提交临时脚本。

## Review Focus

- **WSL interop 从真实服务上下文失败**：`dsh-web.service` 的 PATH 不含 Windows 目录、环境没有 `WSL_INTEROP`。预期：用绝对路径 `/mnt/c/Windows/System32/...` 仍能 spawn；如果不能，记录确切的失败码和环境差异。
- **DSH MCP client 解析/生命周期**：loader 找不到 `@deepseek-ai/dsh-mcp-client`，或 `dispose` 后驱动进程还在。预期：记录模块解析来源；dispose 后 `Get-Process cua-driver` 为空。
- **后台输入矩阵与预期不符**：Terminal/VS Code/Chrome 可能返回 `background_unavailable` 或静默无操作。预期：记录每个应用的真实结果，不把“无报错”当成成功；用 `get_window_state` 复核。
- **截图路径/尺寸**：`screenshot_out_file` 的 Windows 路径与 WSL `/mnt/c` 读取不一致，或 1280 宽 JPEG/PNG 体积过大。预期：记录文件路径、字节数、耗时；给出默认 `max_image_dimension` 的依据。
- **权限与网络**：驱动以 Medium integrity 运行、无监听端口；但可能仍有遥测/更新出站。预期：`check_permissions`、`Get-NetTCPConnection`、`telemetry status` 三项都有记录。

---

### Task V0: 驱动与 MCP 基线（已做，补证据）

**Files:**
- Create: `/tmp/host-cua-verify/mcp-baseline.mjs`（临时）
- Create: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: 无。
- Produces: 基线证据：版本、工具数、`list_windows` 窗口数、`health_report`、`check_permissions`。

- [ ] **Step 1: 准备驱动**

```bash
mkdir -p /tmp/host-cua-verify/driver
cd /tmp/host-cua-verify
curl -sL https://registry.npmjs.org/dsh-cua-driver/-/dsh-cua-driver-0.1.2.tgz -o dsh-cua-driver.tgz
echo "0a3a46c6e84006444c34122a5600d1f53c240087f94589d3beb26b776c7b20d3  dsh-cua-driver.tgz" | sha256sum -c -
tar xzf dsh-cua-driver.tgz -C driver --strip-components=3 package/vendor/cua-driver-rs-0.55.0-windows-x86_64
chmod +x driver/cua-driver.exe
./driver/cua-driver.exe --version
```

Expected: `cua-driver 0.55.0`

- [ ] **Step 2: 跑 MCP 基线脚本**

脚本行为：spawn `driver/cua-driver.exe mcp --direct`，发 `initialize`（协议 `2025-06-18`）、`notifications/initialized`、`tools/list`、`tools/call list_windows`、`tools/call health_report`、`tools/call check_permissions`；把结果写到 `/tmp/host-cua-verify/baseline.json`。

Run: `node /tmp/host-cua-verify/mcp-baseline.mjs`
Expected:
- `serverInfo.name === 'cua-driver'`，`version === '0.55.0'`
- `tools.length === 62`
- `list_windows` 返回 ≥ 1 个窗口
- `health_report` 含 `UIAutomation is reachable` 与 `Windows Graphics Capture will succeed`
- `check_permissions` 含 `Process integrity level: Medium`

- [ ] **Step 3: 写证据**

把命令、输出摘要、日期写进 `docs/research/2026-11-25-host-cua-verification.md` 的“V0 基线”一节。记录 2026-11-25 已观察到的 21 个窗口，但把它标为“当次快照，不是稳定值”。

- [ ] **Step 4: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: record host CUA driver baseline"
```

---

### Task V1: 真实服务上下文的 interop

**Files:**
- Create: `/tmp/host-cua-verify/service-spawn.mjs`（临时）
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: V0 的驱动路径。
- Produces: 结论：`dsh-web`（systemd system unit）能否 spawn 驱动并读写 stdio。

- [ ] **Step 1: 在用户 unit 里跑一次 spawn**

```bash
systemd-run --user --pipe --unit=host-cua-interop-$$ --collect \
  /usr/bin/node /tmp/host-cua-verify/service-spawn.mjs
```

`service-spawn.mjs` 只做：spawn `cua-driver.exe mcp --direct`，发 `initialize`，输出 `serverInfo` 和 `Windows session id`（可通过 `check_permissions` 或外部 PowerShell 获取），然后 dispose。

Expected: `serverInfo.name === 'cua-driver'`；退出码 0。

- [ ] **Step 2: 在真实 dsh-web 进程里跑一次**

在 `src/dsh-fish` 的临时分支上加一个只在 `HOST_CUA_DIAG=1` 时注册的 `GET /dsh-fish/host-cua/diag` 路由（该路由在正式实现前删除），并在 `workbench/fish/routes.mjs` 临时加 `host-cua/diag` P1 白名单；路由行为：spawn 驱动，`list_windows`，返回窗口数与 `process.pid`、`process.env.PATH`、`process.env.WSL_INTEROP`。

Run:
```bash
systemctl restart dsh-web
curl -s http://127.0.0.1:8788/api/fish/host-cua/diag
```
Expected: `ok:true`，窗口数 ≥ 1；`WSL_INTEROP` 缺失也不影响。验证完成后删除临时路由与 BFF 条目。

- [ ] **Step 3: 记录结论**

证据里写清楚：
- system unit 的 `PATH` / `WSL_INTEROP`；
- 是否使用绝对路径；
- 失败时的 `code`/`errno`；
- 结论：生产是否需要在 `dsh-web.service` 里补 `Environment=HOST_CUA_...`。

- [ ] **Step 4: 提交**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: verify host CUA interop from the live service"
```

---

### Task V2: DSH MCP client 动态挂载

**Files:**
- Create: `~/.dsh/profiles/hostcua-probe/`（从 `web` 复制）
- Create: `~/.dsh/profiles/hostcua-probe/probe-host-cua.js`（临时）
- Modify: `~/.dsh/profiles/hostcua-probe/cordis.patch.yml`
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: V0 驱动路径；`@deepseek-ai/dsh-mcp-client` 0.2.1-rc.5。
- Produces: 结论：`ctx.loader.create` 能否动态挂载 MCP entry；工具名/调用/dispose 行为。

- [ ] **Step 1: 建临时 profile**

```bash
cp -a ~/.dsh/profiles/web ~/.dsh/profiles/hostcua-probe
```

在 `hostcua-probe/cordis.patch.yml` 里：
- 把 `dsh-fish`、`dsh-wx`、`dsh-bili` 三条设为 `disabled: true`；
- 增加一条 `insert` 指向 `./probe-host-cua.js`。

`probe-host-cua.js` 只做四件事：
```js
export const name = 'hostcua-probe'
export const inject = ['webServer', 'tools']
export function apply(ctx) {
  // GET /probe/start -> ctx.loader.create({ id:'host-cua-mcp', name:'@deepseek-ai/dsh-mcp-client', config:{...} })
  // GET /probe/tools -> ctx.tools.view?.()?.restrictableNames 里 mcp__host-cua__* 的数量与名字
  // GET /probe/call   -> ctx.tools.execute({ callId:'probe-1', name:'mcp__host-cua__list_windows', arguments:{}, signal:AbortSignal.timeout(30000) })
  // GET /probe/stop   -> ctx.loader.remove('host-cua-mcp')
}
```

- [ ] **Step 2: 启动并观察模块解析**

```bash
systemd-run --user --unit=hostcua-probe --collect \
  /usr/local/bin/dsh --profile hostcua-probe web --no-open --port 8790
```

Run: `curl -s http://127.0.0.1:8790/probe/start`
Expected: entry 创建成功；`/probe/tools` 里出现 62 个 `mcp__host-cua__*`。
若报 `MODULE_NOT_FOUND`：在 `hostcua-probe/package.json` 加 `"@deepseek-ai/dsh-mcp-client": "0.2.1-rc.5"`，`pnpm install` 后重试；记录解析来源与是否引入重复核心包。

- [ ] **Step 3: 调用与停止**

Run: `curl -s http://127.0.0.1:8790/probe/call`
Expected: `list_windows` 返回 ≥ 1 个窗口。

Run: `curl -s http://127.0.0.1:8790/probe/stop`
Run（Windows）: `powershell.exe -NoProfile -Command "Get-Process cua-driver -ErrorAction SilentlyContinue | Select Id,SessionId"`
Expected: 无进程；`/probe/tools` 不再有 `mcp__host-cua__*`。

- [ ] **Step 4: 记录结论**

写清楚：
- 是否能动态 create/remove；
- 工具是否进入全局工具表（预期：是，62 个）；
- dispose 是否杀子进程（预期：是）；
- 是否建议生产使用（按设计预期：不，仅验证）。

- [ ] **Step 5: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: verify DSH MCP dynamic entry for cua-driver"
```

---

### Task V3: 后台输入矩阵

**Files:**
- Create: `/tmp/host-cua-verify/input-matrix.mjs`（临时）
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: V0 驱动。
- Produces: 每个应用的真实结果表：`背景 type_text` / `背景 click` / `background_unavailable` / 复核方式。

- [ ] **Step 1: 准备窗口**

Run（Windows）:
```powershell
Start-Process notepad.exe
Start-Process chrome.exe -ArgumentList "about:blank"
```
Windows Terminal / VS Code 用用户已开的窗口；不主动启动微信/飞书。

- [ ] **Step 2: 逐应用执行**

脚本对每个目标：
1. `list_windows` 找 `pid/window_id`；
2. `get_window_state`（`include_accessibility_tree:true`、`include_screenshot:false`、`max_elements:100`）拿 element token；
3. `type_text`（`element_token` 或窗口，`text:'host-cua verify 123'`，`delivery_mode:'background'`）；
4. `get_window_state` 复核文本是否出现；
5. 对 Notepad 额外测一次 `click`（点 Edit 区或按钮）；
6. 每次动作前后用 PowerShell 取 `GetCursorPos` 与 `GetForegroundWindow`，记录是否变化；预期都不变；
7. 记录 `isError`、`structuredContent.errorCode`、耗时。

只输入 `host-cua verify 123` 这类无意义串；不在 Terminal/Chrome 里输入任何会执行的命令或真实网址。

Expected（待实测，不预设成功）：
- Notepad：type/click 成功，文本可复核；
- Windows Terminal：type 可能成功或 `background_unavailable`；
- VS Code：编辑器可能 `background_unavailable`，命令面板/菜单可能成功；
- Chrome：页面文本大概率 `background_unavailable`，工具栏按钮待测。

- [ ] **Step 3: 写矩阵**

| 应用 | type_text | click | 光标/焦点变化 | 复核 | 备注 |
| --- | --- | --- | --- | --- | --- |
| notepad.exe | 待测 | 待测 | 待测 | 待测 | |
| WindowsTerminal.exe | 待测 | 待测 | 待测 | 待测 | |
| Code.exe | 待测 | 待测 | 待测 | 待测 | |
| chrome.exe | 待测 | 待测 | 待测 | 待测 | |

- [ ] **Step 4: 不做前台重试**

任何 `background_unavailable` 只记录，不重发 `foreground`。若某个应用在后台完全不可用，结论写成“v1 只支持观察，不支持输入”，不要为了绿灯改 delivery。

- [ ] **Step 5: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: record background input matrix"
```

---

### Task V4: 截图、UIA 与体积

**Files:**
- Create: `/tmp/host-cua-verify/capture-matrix.mjs`（临时）
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: V0 驱动。
- Produces: 默认 `max_elements` / `max_image_dimension` 的依据。

- [ ] **Step 1: 抓一张带文件的截图**

```js
// 对 Terminal / Code / Chrome 各一次；截图目录用 PowerShell 的 $env:LOCALAPPDATA 拼出
get_window_state({
  pid, window_id,
  include_accessibility_tree: true,
  include_screenshot: true,
  max_elements: 200,
  max_image_dimension: 1280,
  screenshot_out_file: 'C:\\Users\\<user>\\AppData\\Local\\Temp\\host-cua-verify\\win-<id>.png',
})
```

- [ ] **Step 2: 量尺寸与耗时**

Run:
```bash
ls -l /mnt/c/Users/ASUS/AppData/Local/Temp/host-cua-verify/
```
Expected: 每个文件存在；记录字节数、`identify` 或 PowerShell 读出的像素尺寸、`get_window_state` 耗时。

- [ ] **Step 3: 看内容**

用 `read_image` 或人工确认抓到的是目标窗口本身，不是黑图/遮挡物。记录最小化窗口的结果（应为明确失败或黑图，不能假装成功）。

- [ ] **Step 4: 定默认值**

写结论：
- `max_image_dimension` 默认 1280 是否合适；
- `max_elements` 默认 200 是否足以定位按钮；
- 截图落盘用 `screenshot_out_file` 还是 base64（生产客户端用 base64 + `saveImage`，验证两者体积/耗时）。

- [ ] **Step 5: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: record window capture cost"
```

---

### Task V5: 生命周期与失败封闭

**Files:**
- Create: `/tmp/host-cua-verify/lifecycle.mjs`（临时）
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: V2 的临时 DSH profile。
- Produces: 结论：dispose、崩溃、超时、TTL 到期都 fail closed。

- [ ] **Step 1: 正常 dispose**

`/probe/stop` 后确认驱动进程消失、工具消失。

- [ ] **Step 2: 外部杀死驱动**

Run（Windows）:
```powershell
Get-Process cua-driver | Stop-Process
```
Expected: 下一次 `tools/call` 报错；`/probe/tools` 在重连关闭后不再列工具；DSH 进程不崩。

- [ ] **Step 3: 挂起**

用一个假的 MCP server 替代驱动，收到 `tools/call` 后不回包；确认客户端在 `toolCallTimeoutMs` 内失败，不永远 pending。

- [ ] **Step 4: TTL**

在临时 profile 里把 TTL 设为 5 秒；开启后等 6 秒，确认状态回 `off`、驱动进程结束、下一次调用被拒。

- [ ] **Step 5: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: verify managed-mode fail-closed lifecycle"
```

---

### Task V6: 打包、稳定落盘与遥测

**Files:**
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: Task 9 的 `fetch-host-cua.mjs`、`installBundledHostCua`。
- Produces: 结论：portable 包里的驱动能复制到稳定目录；遥测关闭；路径上报可用。

- [ ] **Step 1: 拉取与校验**

Run: `cd desktop-pet && npm run host-cua:fetch`
Expected: `host-cua/manifest.json`、`cua-driver.exe`、`cua_driver_sdk.dll` 存在；SHA256 与 manifest 一致。

- [ ] **Step 2: 首次运行复制**

Run（Windows）: `npm run dist:win`
启动 `release/win-unpacked/大肥鱼桌宠.exe`（或 portable），确认 `%LOCALAPPDATA%\bigfish\host-cua\0.55.0\cua-driver.exe` 存在；关闭桌宠后文件仍在。

- [ ] **Step 3: 遥测关闭**

先在临时环境或实现后的 P1 里成功启动一次托管（由 dsh-fish 执行 `telemetry disable`），再 Run（Windows）:
```powershell
& "$env:LOCALAPPDATA\bigfish\host-cua\0.55.0\cua-driver.exe" telemetry status
```
Expected: `Telemetry: disabled`。

- [ ] **Step 4: 未签名/MOTW 行为**

从 `release/win-unpacked/` 或 portable 包启动桌宠，记录 Windows SmartScreen/Defender 对 `cua-driver.exe` 的反应；检查目标文件是否有 `Zone.Identifier`。Expected: 记录实际行为；本轮不要求签名，但要把用户会看到的提示写进证据。

- [ ] **Step 5: hello 上报**

抓 `/pet/hello` 请求体或看 `~/.dsh-fish/host-cua.json`，确认 `exe` 是 `C:\...` 路径、`version` 是 `0.55.0`。

- [ ] **Step 6: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: verify driver packaging and telemetry"
```

---

### Task V7: 安全边界

**Files:**
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: V2/V3 的运行现场。
- Produces: 结论：无监听端口、无提权、无 CDP 授权、无前台切换。

- [ ] **Step 1: 进程命令行**

Run（Windows）:
```powershell
Get-CimInstance Win32_Process -Filter "Name='cua-driver.exe'" | Select-Object ProcessId,CommandLine
```
Expected: 只有 `mcp --direct`；没有 `--grant existing-profile`；没有 shell 包装。

- [ ] **Step 2: 网络**

Run（Windows）:
```powershell
$p = (Get-Process cua-driver).Id
Get-NetTCPConnection -OwningProcess $p -ErrorAction SilentlyContinue
```
Expected: 没有 `Listen` 状态的本地端口。若出现出站连接，记录目标与用途（遥测/更新）。

- [ ] **Step 3: 权限**

Run: MCP `check_permissions`
Expected: `Medium (RID 0x2000, non-elevated)`。

- [ ] **Step 4: 前台**

在 V3 全过程中记录前台窗口是否变化（`foreground.js` 的 watcher 或 PowerShell `GetForegroundWindow` 采样）。Expected: 没有因验证脚本改变。

- [ ] **Step 5: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: verify host CUA security boundary"
```

---

### Task V8: P0 PrintWindow 矩阵（可与实现并行）

**Files:**
- Create: `/tmp/host-cua-verify/printwindow-matrix.ps1`（临时）
- Modify: `docs/research/2026-11-25-host-cua-verification.md`

**Interfaces:**
- Consumes: 无。
- Produces: P0 的窗口兼容性证据：Code / Chrome / Terminal / 最小化 / DPI / 副屏。

- [ ] **Step 1: 抓帧**

对每个窗口用 `PrintWindow(hwnd, hdc, 2)`，保存 PNG；记录耗时、尺寸、平均亮度/方差（至少人工看）。

- [ ] **Step 2: 覆盖**

| 条件 | 结果 |
| --- | --- |
| VS Code（非最小化） | 待测 |
| Chrome（非最小化） | 待测 |
| Windows Terminal | 已过（2026-11-25，3 个窗口） |
| 最小化 | 待测 |
| 150% DPI / 副屏 | 待测 |

- [ ] **Step 3: 结论**

写进证据：`look_window` 对哪些窗口可靠；最小化时的错误码；是否需要 WGC 兜底（本版不做）。

- [ ] **Step 4: 提交证据**

```bash
git add docs/research/2026-11-25-host-cua-verification.md
git commit -m "docs: record PrintWindow window matrix"
```

---

## 退出决定（Gate 记录）

验证结束后在证据文档末尾写一张表，逐项拍板：

| 编号 | 决定 | 依据 |
| --- | --- | --- |
| D1 | 生产用 dsh-fish 内置最小 MCP 客户端，不用 DSH MCP 挂载 | V2：62 工具全局注册、无过滤；内置客户端可控窄面 |
| D2 | v1 白名单保留哪些应用，以及各应用的 `detail`（full/structure/image/none）和 `input`（allow/deny）；终端/浏览器明确 allow | V3 矩阵 + Task 6 测试；后台不可用的应用只保留观察/结构 |
| D3 | `max_elements` / `max_image_dimension` 默认值 | V4 体积/耗时/可读性 |
| D4 | TTL 15 分钟是否合适 | V5 + 实际使用感受 |
| D5 | G2 是否通过，能否进入 P1 实现 | V0–V7 全部有结论；任何 P0 阻塞项单列 |

## Self-Review

- **Spec coverage**：驱动与协议（V0）、服务上下文（V1）、DSH MCP（V2）、后台输入（V3）、截图/UIA（V4）、生命周期（V5）、打包（V6）、安全（V7）、PrintWindow（V8）。
- **Step scan**：每个实验都有命令、预期和证据落点；没有“看看情况”类步骤。
- **Type consistency**：所有 MCP 方法名与驱动 0.55.0 的 `tools/list` 一致；`delivery_mode` 固定 `background`。
- **Review Focus**：5 条都在实验里有对应记录项。
- **Proportion**：验证计划不复制生产实现；只规定实验条件、命令和证据。
