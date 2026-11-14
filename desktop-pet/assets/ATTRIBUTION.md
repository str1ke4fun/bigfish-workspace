# 桌宠素材与代码署名

本目录的桌宠播放器复用以下开源项目的表现层组件与动画素材，不包含对方的人设、对话、记忆或模型能力。

## 代码

- **dsh-pet-component 0.2.5** — React 桌宠组件，MIT License。
  - 来源：<https://github.com/dsh-tauri/dsh-pet-component>
- **dsh-pet** — 动作协议与工作状态映射参考，代码 MIT License。
  - 来源：<https://github.com/PC2005-cloud/dsh-pet>

## 形象与动画素材

- 角色形象与 `assets/webm/` 下的动画素材来自 **dsh-pet**，采用 **CC BY-NC-SA 4.0**（Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International）许可。
  - 许可要点：署名（BY）、非商业性使用（NC）、相同方式共享（SA）。
  - 许可全文：<https://creativecommons.org/licenses/by-nc-sa/4.0/>
  - 素材来源：<https://github.com/PC2005-cloud/dsh-pet>
- 若要用于商业用途或公开分发，必须替换为自有人工形象与素材，或另行取得授权。

## 说明

- `assets/webm/` 不进入 Git，由 `scripts/sync-assets.mjs` 从本地 dsh-pet 素材目录同步。
- 本项目的源码许可以仓库根目录为准；上述许可以各自项目页面为准。
