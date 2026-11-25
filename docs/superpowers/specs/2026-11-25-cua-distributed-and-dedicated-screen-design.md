# 分布式 CUA 与专用副屏托管（方向记录）

状态：**未调研**（仅记录方向；未做技术调研、未设计、未排期）
日期：2026-11-25
范围：未来方向；不影响当前 host-cua v1

## 1. 两个方向

1. **分布式 CUA**：多个 agent 分别调用自己的 CUA，而不是当前单一 `host-cua` 实例、单驱动、5 个窄工具。
2. **专用副屏托管**：在 1 的基础上，把一块副屏整体锁给 agent team，人类输入隔离在该屏之外，team 全自动托管。

## 2. 当前已知现状（来自 2026-11-25 实测）

- host-cua 是单实例、单驱动；allowlist 四个应用（Code / Terminal / Notepad / Chrome）。
- 默认只后台；TTL 15 分钟；有动作预算/频率和审计。
- VS Code（`Chrome_WidgetWin_1`）后台键盘（`type_text` / `press_key`）不可用，后台 `click` 可用。
- 前台交付会激活目标窗口并抢焦点。
- 编辑器正文不在 UIA 树里（`Document.value` 只是文件 URI），内容检查靠截图 + 文件系统。

以上均已实测；其余均为**未调研**。

## 3. 未调研（明确列出）

- agent 与驱动/会话的隔离粒度：每 agent 一个 driver？一个 Windows session/desktop？还是整个 team 共享？
- 多 agent 并发驱动同一桌面时的窗口归属、焦点与输入冲突。
- “副屏独占”的实现方式：仅按显示器过滤，还是需要独立 Windows 会话/沙箱/虚拟机。
- 多显示器与虚拟桌面是否真正隔离输入和焦点（本机未验证）。
- 输入路由：如何保证 agent 的前台输入只落在指定屏/会话，不抢人类主屏。
- 权限模型：只读 / 可输入 / 独占，及其与确认、TTL、预算的关系。
- 多 agent 的审计、配额、回滚与责任边界。
- 多屏 DPI、坐标、截图尺寸与坐标映射。
- cua-driver 0.55.0 是否支持多实例/多会话并行；升级成本与版本绑定。
- 性能、资源占用与稳定性。

## 4. 不在本文档决定

- 不改变当前 v1 的 background-only、单实例、5 工具边界。
- 不承诺时间表或实现顺序。
- 不在此文档选型（driver 层、会话层、虚拟化层）。

## 5. 下一步（待调研后另写设计）

先做技术调研，回答第 3 节的隔离与输入路由问题；有结论后再拆成正式设计文档和计划。

## 6. 关联

- `docs/research/2026-11-25-host-cua-verification.md`
- `docs/superpowers/plans/2026-11-25-host-cua-execution.md`
- `docs/superpowers/specs/2026-11-25-host-cua-architecture-design.md`
- `scripts/cua-acceptance/`
