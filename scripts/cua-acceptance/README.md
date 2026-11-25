# 宿主 CUA 验收脚本

可重复的 host-cua 验收：状态机、fail-closed、读路径，以及在真实 VS Code 上完成「新建→写→检查→修改→保存」闭环。

设计：`docs/superpowers/specs/2026-11-25-cua-acceptance-harness-design.md`

## 前置条件

- WSL2 + Windows interop；能从 WSL 启动 `/mnt/c/.../cua-driver.exe`。
- 桌宠已上报驱动：`~/.dsh-fish/host-cua.json` 指向稳定目录（`%LOCALAPPDATA%\bigfish\host-cua\<ver>\cua-driver.exe`）。
- Node.js 20+（零依赖，只用仓库里的 `src/dsh-fish/lib/*`）。
- VS Code 正在运行（前台闭环需要）；Notepad / Chrome / Terminal 按需。
- 线上服务未处于托管：脚本会自建隔离实例，但 `--check-service` 会先读 8788 确认 `mode:"off"`。

## 用法

```bash
# 只跑 P0–P3（不抢焦点）
node scripts/cua-acceptance/run.mjs --live

# 加 VS Code 前台闭环（会激活 VS Code、抢焦点）
node scripts/cua-acceptance/run.mjs --live --allow-foreground

# 先只读检查线上服务 mode，再跑
node scripts/cua-acceptance/run.mjs --live --allow-foreground --check-service

# 自定义输出目录 / 目标应用
node scripts/cua-acceptance/run.mjs --live --out ./tmp-cua --target Code.exe
```

- `--live` 必填，防止误跑。
- `--allow-foreground` 只影响 P4；缺省时 P4 标记 `skipped`。
- 输出默认在 `~/.dsh-fish/cua-acceptance/<UTC 时间戳>/`，含 `report.json`、截图和审计。

## 检查内容

| 阶段 | 内容 |
| --- | --- |
| P0 | 驱动文件/版本、`host-cua.json` 稳定路径、可选线上服务 `mode=off` |
| P1 | `off → observe → managed → off`、5 工具齐全、短 TTL 自动 off |
| P2 | `look_window` 列白名单/抓帧、`structure` 无图、`host_look` 截图+快照、最小化抓帧观察项 |
| P3 | `CAPTURE_REQUIRED`、`BACKGROUND_UNAVAILABLE`、`INPUT_DENIED`、`WINDOW_NOT_ALLOWED`、`BAD_ARGS`、`RATE_LIMITED` |
| P4 | VS Code：Ctrl+N → 写入 → Ctrl+S → Save As（Ctrl+L 导航目录 + 点保存）→ 读磁盘校验 → 全选改写 → Ctrl+S → 再校验 → Ctrl+W |

## 前台阶段（P4）

- 只对目标 VS Code 窗口使用 `delivery_mode:"foreground"`；产品代码仍只走后台。
- **会激活 VS Code 并抢焦点**；报告记录阶段前后的前台窗口。
- 不改动已保存文件：新建缓冲区，保存到 `%TEMP%\cua-acceptance\<时间戳>\`，文件名来自正文首行。
- Save As 对话框：先 `Ctrl+L` 输入目录回车，再点 `保存(S)`；若快照未稳定会重试 3 次。
- 测试文件保留在 Windows 临时目录，不删除；报告打印路径。

## 已知发现（2026-11-25 实测）

- VS Code 窗口 class 是 `Chrome_WidgetWin_1`：**后台 `press_key` / `type_text` 不可用**（`background_unavailable`），**后台 `click` 可用**。
- VS Code 首次 UIA 查询可能只返回标题栏按钮；之后无障碍树会变丰富（Document/TabItem 等），但 `Document.value` 只是文件 URI，**编辑器正文读不到**——内容检查以磁盘文件 + 截图为准。
- Save As 不能把「目录 + 文件名」一次性塞进文件名框（会被解释成目录名）；必须先导航目录，再用默认文件名保存。
- 保存对话框会连续消耗多个输入动作，可能撞上 `maxActionsPer10s`；脚本在改写前重启托管以重置预算。
- Chrome 最小化窗口的 `elementToken` click 返回 `CALL_FAILED`（观察项，不作为失败）。
- 最小化 Terminal 的 PrintWindow 只抓到 237×39（标题条区域，观察项）。

## 安全边界

- 不修改产品代码、不切换线上服务 mode、不删除任何文件。
- 标记文本只含时间戳，不含真实聊天内容或凭据。
- 仅当显式 `--live` 时启动驱动；仅当显式 `--allow-foreground` 时抢焦点。

## 还需人工验证

见 `MANUAL.md`：真实模型调用、Chrome/Terminal 后台 click 矩阵、最小化/DRM/DPI、桌宠托盘徽标。
