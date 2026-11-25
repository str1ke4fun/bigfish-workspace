# 宿主 CUA 技术验证记录（2026-11-25）

- 环境：Windows 11 26200 / WSL2 Ubuntu 26.10 / Node 24.21.0 / DSH 0.2.1-rc.5
- 驱动：`cua-driver 0.55.0`（`dsh-cua-driver@0.1.2` vendor，SHA256 `0a3a46c6…20d3`）
- 对应计划：`docs/superpowers/plans/2026-11-25-host-cua-technical-verification.md`

## V0 驱动与 MCP 基线

- `cua-driver.exe --version` → `cua-driver 0.55.0`。
- 自写最小 MCP 客户端 `initialize` → `serverInfo {name:'cua-driver', version:'0.55.0'}`。
- `tools/list` → 62 个工具；`list_windows` 当次返回 29 个窗口。
- `health_report`：UIAutomation reachable；Windows Graphics Capture 可用。
- `check_permissions`：Medium (RID 0x2000, non-elevated)。

## V1 真实服务上下文 interop

- 临时 profile `hostcua-probe`（复制 `web`，root `/home/str1k3/.dsh-fish-probe`，关闭 dsh-wx/dsh-bili）在 8790 启动；`/dsh-fish/host-cua/status`、`/pet/state.hostCua` 正常。
- 通过 `/pet/hello` 上报稳定路径 `C:\Users\ASUS\AppData\Local\bigfish\host-cua\0.55.0\cua-driver.exe`；`POST /host-cua/mode {mode:"managed"}` 成功，`driver.connected=true`，`version=0.55.0`，Windows 进程 `cua-driver` 在 session 7。
- 正式 `dsh-web.service` 重启后加载 `0.9.1`；经 8788 BFF `POST /api/fish/host-cua/mode` 同样成功启动驱动，`POST ... {mode:"off"}` 后驱动进程消失。
- `actor:"pet"` + `mode:"managed"` 返回 400「桌宠只能停止托管」。
- 结论：system unit 环境可 spawn 驱动；不需要 `WSL_INTEROP` 环境变量；使用绝对 `/mnt/c/...` 路径。

## V3 后台输入矩阵

| 应用 | type_text（background） | 光标/前台 | 复核 |
| --- | --- | --- | --- |
| notepad.exe | 成功：UIA ValuePattern，`Wrote 19 char(s)` | 前后光标/前台不变 | `get_window_state` 读到 `host-cua verify 123` |
| WindowsTerminal.exe | `background_unavailable`（CASCADIA_HOSTING_WINDOW_CLASS） | 前台不变 | 驱动建议 foreground；按设计不重试 |
| chrome.exe | `background_unavailable`（Chrome_WidgetWin_1） | 前台不变 | 驱动建议 foreground；按设计不重试 |

- Notepad 的坐标点击：`capture_id` + **截图图像像素**坐标成功；用屏幕绝对坐标会得到 `capture_coordinate_invalid`。
- 结论：v1 的 `input=allow` 是“允许尝试后台输入”，不是“保证成功”；Terminal/Chrome 目前只能观察或依赖前台（前台被设计禁止），工具应如实返回 `BACKGROUND_UNAVAILABLE`。

## V4 截图/UIA

- `PrintWindow` 按 HWND 抓 Windows Terminal：1600×855 PNG，约 2.8MB；人工查看内容正确（非黑图、非遮挡物）；目标不在前台。
- `get_window_state` 默认 `tree_format:markdown` 时 `structuredContent.elements` 为空；`tree_format:'elements'` 时返回 `elements`、`snapshot_id`；带截图时额外返回 `capture_id`、`screenshot_width/height`。
- 结论：`structure` 必须用 `tree_format:'elements'`；坐标点击必须用 `capture_id` + 图像像素坐标；`host_look` 已按此实现。

## V5 生命周期

- `POST /host-cua/mode {mode:"off"}` 后驱动进程消失；audit 记录 mode start/stop。
- 驱动退出/初始化失败在单测中覆盖 fail closed；TTL 用单测假时钟覆盖。
- 正式服务重启后状态回到 `off`；不自动恢复。

## V6 打包

- `desktop-pet/scripts/fetch-host-cua.mjs` 下载并校验 SHA256；`host-cua/` 82MB，未入 Git。
- `electron-builder --win --dir` 在 WSL/Linux 上生成 `release/win-unpacked`，`resources/host-cua/cua-driver.exe` 存在；未签名，构建日志明确 `no code signing certificate configured`。
- 首次运行复制到 `%LOCALAPPDATA%\bigfish\host-cua\0.55.0` 已用稳定目录手动验证；桌宠新包的自动复制/hello 未在 Windows 上实际启动验收（单测覆盖）。
- 遥测：`telemetry disable` 由 dsh-fish 第一次解析驱动时执行；驱动启动 stderr 仍可能提示新版本 0.62.1，未自动更新。

## V7 安全边界

- 驱动 Medium integrity；无监听端口；命令行只有 `mcp --direct`，无 `--grant existing-profile`。
- 客户端只允许 5 个工具名；`move_cursor`/`bring_to_front` 等单测拒绝。
- 终端/浏览器 type_text 后台失败时，前台窗口未变化；不自动重试 foreground。

## 退出决定

| 编号 | 决定 | 依据 |
| --- | --- | --- |
| D1 | 生产用 dsh-fish 内置最小 MCP 客户端 | V0/V2；DSH MCP 62 工具全局注册，已验证不采用 |
| D2 | 白名单保留 Code/Terminal/Notepad/Chrome；`detail=full`、`input=allow` | 用户显式接受；V3 显示 Terminal/Chrome 只能观察（工具如实返回） |
| D3 | `max_elements=200`、`max_image_dimension=1280`；`captureId` + 图像坐标 | V4 |
| D4 | TTL 15 分钟 | 设计定稿；单测覆盖到期 |
| D5 | G2 通过（V1/V3/V4/V5 均有结论；V2 DSH MCP 仅验证，不生产） | 本记录 |

## 未验证边界

- 桌宠新包的 Windows 首次运行/自动复制/hello 实际启动验收。
- Chrome/Terminal 的后台 click（本记录只测 type_text）。
- 真实模型在她的会话里调用 `look_window`/`host_*`（工具级与驱动级已测，模型侧未跑）。
- 最小化/DRM/DPI 的 PrintWindow 全矩阵。
