# 2026-11-18 main 测试 Handoff

## 当前状态

- 本地 `main` 已 fast-forward 到反馈措辞层和桌宠动作播放一期。
- 实现分支：`feat/diegetic-feedback-pet-v1`
- 最新实现提交：`48257e4 fix: close residual feedback and pet races`
- 尚未 push 到远程，尚未部署或重启服务。

## 已完成并通过自动测试

- 微信世界声、三态发送回执、耳朵/逾期/读屏投影、提醒固定模板。
- 微信预期错误专用 post-execute 投影，保留 `isError`、code 和原始原因到台账。
- 核心身份、叫醒/场景、Bili/QQ 文案收口和 `bili_speak` 回声抑制。
- 禁词扫描与反馈指标纯函数。
- 桌宠动作注册表、menu、IPC/preload、播放状态机、App 集成、113 个动作覆盖 114 段 webm。

自动验证：

- `src/dsh-fish`: `1147/1147`
- `src/dsh-wx`: `108/108`
- `src/dsh-bili --test-concurrency=1`: `45/45`
- `desktop-pet`（单并发）：`112/112`
- 凭据/大文件审计：无告警

## Windows 醒来后必测

1. 启动桌面壳，确认默认皮肤、托盘、右键菜单和工作台不回归。
2. 「演一个动作」：常用 7 项、状态 7 项、各自定义分组均能打开。
3. 播放一次性动作，结束后回到最新 activity/presence 稳态。
4. 睡觉 seq：开始 → 循环，点“起来”或“停下当前动作”能结束并恢复稳态。
5. 连续快速切换两个动作，旧动作不能提前结束或覆盖新动作。
6. 循环动作中触发聊天 thinking，聊天结束后不能残留或错误打断。
7. 拖动、切皮肤、切回默认皮肤、重新载入动作；动作 id 和 `/pet/act` 能同步更新。
8. 抽查至少一轮透明通道、闪烁、视频解码、点击穿透。
9. `/pet/act { action }` 使用最新 hello 中的 id；旧 `{ motion }` 仍可用。

## 已知边界

- `dsh-pet-component 0.2.5` 没有 source-tagged `onReady`，旧媒体 ready 回调的极端时序仍需 Windows 真机验证（G-02/G-03）。
- 没有执行 `npm run build`，本地缺少 `desktop-pet/node_modules`。
- 没有真实微信/Bili/QQ/模型消息往返验收。
- 机械侧下期路线图和桌宠事件链二期仍是 roadmap，不应视为已完成。

如果 Windows 测试发现动作播放问题，优先保存桌面壳日志、动作 id、当前皮肤和复现顺序，不要先改代码。
