# 2026-11-18 三份设计实现交接

## 本次检查

- 反馈措辞层：已在 `main` 的 `48257e4` 完成；核心、微信、Bili 测试通过。
- 机械侧接管：`feat/mechanical-takeover-phase2` 已并入 `main`，包含 `wx_send` 活动任务隐式绑定、逾期状态/退避、提醒到点机械投递、主动额度分层和微信返回信封。`dsh-fish`、`dsh-wx`、工作台测试通过。
- 桌宠事件链：`feat/full-design-landing-phase2` 已并入 `main`，包含事件源、纯内存 scene/cue、触发注册表与桌面调度。`dsh-fish`、Bili、桌宠测试通过。

## 未完成的设计边界

- 机械侧路线图中的 QQ/NapCat 可见性、表情 id 参数收口、`growth_commit.confidence` 数据迁移、图片块替代路径等仍未实现；需逐项完成前置验证并独立设计，不能按整份路线图标为完成。
- 桌宠注册表与事件驱动已有自动化实现，但 Windows 透明/闪烁/视频解码/点击穿透及真实桌面播放仍待真机验收。
- 机械提醒和微信返回信封的自动化测试通过；真实微信、模型及线上重启后的端到端收发未在本环境验证。

## 验证

- `src/dsh-fish`: `1178/1178`
- `src/dsh-wx`: `161/161`
- `src/dsh-bili`（单并发）: `45/45`
- `desktop-pet`: 12 个测试文件通过
- `workbench`（单并发）: `129/129`
- `desktop-pet npm run build`: 未运行成功，当前 checkout 没有安装 `vite` / `node_modules`。

首次并行跑工作台与 Bili 时，各有测试因共享环境产生假红；按仓库要求串行复跑后全绿。
