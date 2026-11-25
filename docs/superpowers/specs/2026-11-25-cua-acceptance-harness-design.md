# 宿主 CUA 验收脚本包设计

状态：已批准并实现（2026-11-25）
日期：2026-11-25
范围：`scripts/cua-acceptance/`（新增）；只读引用 `src/dsh-fish/lib/*`，不改产品代码
依据：`docs/research/2026-11-25-host-cua-verification.md`、本日探针结果

## 1. 意图与成功标准

把 host-cua 的验收做成**可重复的脚本包**：一条命令能跑完 status、模式切换、fail-closed 和读路径，并对 VS Code 完成「新建→写→检查→修改→保存」闭环。四个无法自动化的边界单独列成人工步骤。

成功标准：

1. `node scripts/cua-acceptance/run.mjs --live` 能独立跑完 P0–P3，输出 `report.json` 与逐项通过/失败，退出码可用于 CI 或人工判断。
2. 加 `--allow-foreground` 后，P4 在真实 VS Code 上完成闭环，并以磁盘文件内容为准验证写入与修改。
3. 前台只用于 P4，且仅在显式 flag 下；产品代码与线上服务状态不被修改。
4. 四个未验边界（Chrome/Terminal 后台 click、真实模型调用、最小化/DRM/DPI、桌宠托盘徽标）在 `MANUAL.md` 里有可照做的步骤。

## 2. 探针结论（决定设计）

- VS Code 主窗口 class 为 `Chrome_WidgetWin_1`；`press_key` / `type_text` 后台返回 `background_unavailable`（原文要求 `delivery_mode:"foreground"`）。因此 Ctrl+N / Ctrl+S / 输入都无法纯后台完成。
- 后台 **click** 在 VS Code 上实测可用（`host_click` 返回 ok）；只有键盘类事件不可用。
- 首次 UIA 查询可能只返回 3 个标题栏 Button；之后 VS Code 会开启无障碍，树变丰富（Document/TabItem/Button 等）。但 `Document.value` 只是文件 URI，**编辑器正文读不到**。
- 结论：VS Code 的「检查」必须靠**截图 + 保存后的文件系统**；写/存闭环必须显式前台；产品后台键盘路径的正确行为是**如实返回 `BACKGROUND_UNAVAILABLE`**，这本身作为通过项断言。

## 3. 方案选择

**采用：独立脚本包** `scripts/cua-acceptance/run.mjs`。

- 不放进 `src/dsh-fish/test/`：真实驱动、真实窗口、前台抢焦点不适合被 `node --test` 自动收集；用 `test.skip` 也无法表达「必须显式开启」的语义。
- 不复用 8788 BFF 驱动工具：BFF 只暴露 status/mode，无法调用 `look_window`/`host_*`；脚本直接构造产品库实例，测的是真实代码路径。
- 不新增依赖，保持 Node 20+ / ESM / 零依赖。

## 4. 包结构

```
scripts/cua-acceptance/
  run.mjs       # 编排、断言、report.json
  README.md     # 用法、前置条件、前台警告、逐段说明
  MANUAL.md     # 四个未验边界的人工步骤
```

运行参数：

- `--live`：必填，防止误跑。
- `--allow-foreground`：开启 P4；缺省跳过并标记 `skipped`。
- `--out DIR`：默认 `~/.dsh-fish/cua-acceptance/<UTC 时间戳>/`。
- `--target Code.exe`：默认 VS Code；用于 P4。
- `--check-service`：只读查询 8788 `/api/fish/host-cua/status`，不做任何切换。

隔离原则：

- 脚本自建 `createHostCua({ root: <out>/runtime, config: { hostCua: { exe, ... } } })`，不碰线上服务的 mode/驱动。
- 驱动路径从 `~/.dsh-fish/host-cua.json` 只读解析并校验稳定目录；`exe` 显式传给实例。
- 所有截图、审计、抓帧落在 `<out>/`；脚本不删除任何文件。测试文件（含 P4 的 scratch 文本）保留并报告路径。
- 若 `--check-service` 发现线上 `mode !== "off"`，中止并提示先停托管，避免两个驱动实例。

## 5. 阶段与检查项

### P0 预检（只读）

- 驱动文件存在、`--version` 为 `cua-driver 0.55.0`。
- `host-cua.json` 的 `exe` 是稳定目录。
- `list_windows` 成功；报告 Code / Terminal / Chrome / notepad 是否存在。
- 目标 `Code.exe` 必须存在，否则 P4 标记 `skipped` 并说明原因。

### P1 服务状态机

- 新实例 `status()`：`mode:"off"`、`phase:"off"`、`apps` 含 4 个白名单且 `detail/input` 正确。
- `setMode({mode:"observe"})` → `mode:"observe"`，不启动驱动。
- `setMode({mode:"managed"})` → `driver.connected:true`、`version:"0.55.0"`、5 个允许工具齐全。
- `setMode({mode:"off"})` → `off`，驱动进程退出。
- 短 TTL 实例（`ttlMs: 1500`）observe 到期自动 `off`（等待 2s）。

### P2 读路径

- observe + `look_window` 无参：列出 Code / Terminal / Chrome；微信/飞书不在列表。
- `look_window` 指定 Code：返回图片路径，PNG 存在且尺寸合理；记录宽高。
- 配置 Chrome 为 `structure`：`look_window` 对 Chrome 返回 `DETAIL_NO_IMAGE`。
- managed + `host_look` Code（`full`）：`ok:true`、有 `snapshotId`/截图路径；记录 tree 只有 3 个 Button，作为已知限制证据（不判失败）。

### P3 fail-closed 矩阵（产品行为，必须逐项命中）

| 调用 | 期望 |
| --- | --- |
| `host_click` Code，x/y 无 `captureId` | `CAPTURE_REQUIRED` |
| `host_click` Code，带 `captureId` | `BACKGROUND_UNAVAILABLE` |
| `host_type` Code | `BACKGROUND_UNAVAILABLE` |
| `host_key` Code `ctrl+n` | `BACKGROUND_UNAVAILABLE` |
| `host_key` `alt+f4` | `BAD_ARGS` |
| `host_type` 含 `sk-` / Bearer | `INPUT_DENIED`，且不转发 |
| 非白名单窗口的 `windowId` | `WINDOW_NOT_ALLOWED` |
| `input:"deny"` 的配置实例 | `INPUT_DENIED` |
| 连续输入触发频率上限 | `RATE_LIMITED`（可选，默认开） |

### P4 VS Code 前台闭环（`--allow-foreground`）

1. 记录当前前台窗口；确认 `Code.exe` 主窗口。
2. **新建**：`press_key ctrl+n`，`delivery_mode:"foreground"`；重新列窗口确认标题出现 Untitled/未命名。失败则中止，不继续。
3. **写**：`type_text` foreground 写入合成标记 `cua-acceptance <stamp>`。
4. **保存**：`press_key ctrl+s` foreground → 等待 Save As 对话框；`list_windows` 找到后，`Ctrl+L` 输入目标目录回车导航，再用默认文件名（正文首行）点 `保存(S)`；点击前重新取快照，失败重试最多 3 次。不能把「目录 + 文件名」一次性塞进文件名框（会被解释成目录名）。找不到对话框 → 保留缓冲区并报告。
5. **检查**：从 WSL 读 `/mnt/c/...` 对应文件，断言内容等于标记；同时 `get_window_state` 截图存证。
6. **修改**：`press_key ctrl+a` + `type_text` 写入第二段标记，`ctrl+s`；若编辑器未聚焦，退化为按截图中心坐标 `click`（foreground）再重试。
7. **再检查**：磁盘内容等于第二段标记。
8. **收尾**：`ctrl+w` 关闭已保存标签页；记录前台是否变化；文件保留在 `<out>/windows/`。
9. 所有 foreground 调用走 `hostCua.call(..., { delivery_mode: "foreground" })`，不修改工具层的 background 语义。

### P5 报告

- `<out>/report.json`：每项 `{id, phase, expected, actual, status: passed|failed|skipped, evidence}`。
- 终端表格摘要；有任何 `failed` 退出码 1，全部 `passed/skipped` 退出码 0。
- 明确打印「前台阶段会抢焦点」与测试文件路径。

## 6. 人工步骤（MANUAL.md）

1. **Chrome / Terminal 后台 click**：在托管模式下手动放两张白名单窗口，按 README 记录的坐标/`elementToken` 各点一次，记录是否 `BACKGROUND_UNAVAILABLE`、前台是否变化。
2. **真实模型调用**：在 8710 的她会话里让她“看一眼 VS Code / 在 VS Code 里新建文件”，记录工具名、参数、返回 code、是否触发确认。
3. **最小化/DRM/DPI 矩阵**：最小化、副屏、不同缩放、DRM 视频窗口各抓一次，记录成功/失败 code 与图片尺寸。
4. **桌宠托盘徽标**：替换为新桌宠后，开启托管，确认托盘/窗口显示托管中；点停止后驱动退出、状态 `off`。

每项都给出预期结果、证据保存位置和「失败时记什么」。

## 7. 约束与反目标

- 不改 `src/dsh-fish` 产品逻辑；脚本只 import。
- 不删除文件、不清理目录、不写 `~/.dsh-fish` 运行数据（只读注册文件）。
- 不用真实凭据/真实聊天内容做标记；标记只含时间戳和固定前缀。
- 不把前台回退描述成产品能力；README 与报告都标注 test-only。
- 不是单测的替代；`node --test` 仍覆盖纯函数与状态机。

## 8. 风险与未决

| 风险 | 处理 |
| --- | --- |
| Save As 对话框无法用 UIA 定位或输入 | 明确 `SAVE_DIALOG_NOT_FOUND`，保留缓冲区，MANUAL 提供手点保存后的续跑说明 |
| 前台抢焦点影响用户 | 默认关闭；`--allow-foreground` 显式开启；开始/结束打印当前前台窗口 |
| 预算被前台调用消耗 | 进入 P4 前 `setMode(off→managed)` 重置计数；报告写出消耗 |
| Chrome/Terminal 最小化窗口抓帧失败 | P2 只对可见窗口断言；最小化场景留给 MANUAL |
| 线上服务正在托管 | `--check-service` 预检发现非 `off` 即中止 |
| 驱动升级导致工具名/参数变化 | 预检比对 5 个允许工具；缺失则 fail closed |

## 9. 交付

- 新增 `scripts/cua-acceptance/{run.mjs,README.md,MANUAL.md}`。
- 不提交任何测试产物；`report.json`/截图只在 `~/.dsh-fish/cua-acceptance/`。
- 文档提交信息：`feat(scripts): add host CUA acceptance harness`。

## 10. 实现记录（2026-11-25）

- 实测结果：`--live --allow-foreground` 运行 **32 passed / 3 observed / 0 failed**；VS Code 闭环全部通过。
- VS Code 后台 click 可用、后台键盘不可用；编辑器正文不在树里，`Document.value` 是文件 URI。
- Save As：`Ctrl+L` 导航目录 + 点 `保存(S)`；导航后要等稳定并重取快照，否则点击会落在旧坐标。
- 保存流程连续消耗输入动作，会撞 `maxActionsPer10s=8`；脚本在改写前 `off→managed` 重置预算。
- 观察项：最小化 Chrome 的 elementToken click 返回 `CALL_FAILED`；最小化 Terminal 的 PrintWindow 只得到 237×39（标题条）。
- 未做：真实模型调用、DRM/DPI、桌宠托盘徽标（见 `MANUAL.md`）。
