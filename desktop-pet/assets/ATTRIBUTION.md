# 桌宠素材与代码署名

本目录的桌宠播放器复用以下开源项目的表现层组件与动画素材，不包含对方的人设、对话、记忆或模型能力。

## 代码

- **dsh-pet-component 0.2.5** — React 桌宠组件，MIT License。
  - 来源：<https://github.com/dsh-tauri/dsh-pet-component>
- **dsh-pet** — 动作协议与工作状态映射参考，代码 MIT License。
  - 来源：<https://github.com/PC2005-cloud/dsh-pet>

## 形象与动画素材

- 角色形象与 `assets/webm/` 下的 114 段动画素材来自 **dsh-pet v0.4.9**，采用 **CC BY-NC-SA 4.0**（Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International）许可。
  - 许可要点：署名（BY）、非商业性使用（NC）、相同方式共享（SA）。
  - 许可全文：<https://creativecommons.org/licenses/by-nc-sa/4.0/>
  - 素材来源与版本：<https://github.com/PC2005-cloud/dsh-pet/tree/v0.4.9>（素材路径 `dsh-pet/assets/webm`）
- 本仓库只随源码附带其中 **1 段待机动画** `assets/webm/待机呼吸休闲.webm`（441,437 B），
  用于离线最小验证。这 1 段已进入本仓库的 Git 历史；其余 113 段不随本仓库分发，
  由 `scripts/fetch-assets.mjs` 从上游同步。
- **商用限制**：本项目按非商业用途使用这些素材。若要商业使用或公开分发，必须把
  已入库的这 1 段以及同步得到的其余素材替换为自有素材，或另行取得授权。

## 说明

- `assets/webm/` 中除上述待机动画外仍被 `.gitignore` 忽略；
  其余素材由 `scripts/fetch-assets.mjs`（`npm run assets:fetch`）从上游同步，
  或通过 `scripts/sync-assets.mjs --from <目录>` 从本地素材目录复制。
- 同步脚本默认保留 `assets/webm/` 里已存在的文件，避免覆盖自定义动画。
- 本项目的源码许可以仓库根目录为准；上述许可以各自项目页面为准。
