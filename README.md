# 大肥鱼 · Big Fat Fish

基于 DSH 的 AI 陪伴与自主成长项目。大肥鱼通过对话、观察和持续积累的经历形成自己的判断，留下记忆，也会反思和修正过去的想法。

项目围绕事件驱动的成长、长期记忆与多通道交流展开：人格通过经历逐渐形成，环境参数用于控制唤醒节奏、浏览活动和交流频率。

## 运行形态

项目分两侧运行：**WSL 里是大脑和通道，Windows 里只有桌宠壳**。

```text
Windows                                  WSL (Linux)
┌──────────────────────┐                 ┌────────────────────────────────────────────┐
│ 桌宠壳 (Electron)    │  HTTP 8788      │ 工作台 8788   通道桥 + 鱼侧 BFF              │
│ desktop-pet/         │ ──────────────▶ │ DSH 宿主 8710  dsh-fish / dsh-wx / dsh-bili │
│ 只做表现层，无人设    │  轮询状态        │ Xvfb :99 虚拟屏                              │
└──────────────────────┘                 │   ├─ Linux 微信   ← dsh-wx（无障碍树 + OCR） │
                                         │   └─ LinuxQQ + NapCat（OneBot）             │
                                         └────────────────────────────────────────────┘
```

- **DSH 宿主**（`dsh-web`，8710）：加载 `dsh-fish`、`dsh-wx`、`dsh-bili`，是她思考、记忆和说话的地方。
- **微信**：Linux 版客户端跑在 Xvfb `:99` 虚拟屏里，`dsh-wx` 通过无障碍树与 OCR 读窗口、模拟输入。
- **QQ**：LinuxQQ 同样跑在 `:99`，由 NapCat 注入并以 OneBot 协议收发；会话 id 以 `onebot-` 开头。
- **工作台**（8788）：统一管理入口，聚合 QQ / 微信通道页、她的状态页与桌宠页。
- **桌宠壳**（Windows）：Electron 薄壳，轮询工作台的 `/api/fish/pet/state`，把状态翻译成动作和气泡；
  说话走 `/api/fish/say`。不含人设、提示词、记忆或模型调用。构建与首次启动见 [`desktop-pet/README.md`](desktop-pet/README.md)。
- 服务由 systemd 管理：`dsh-web`、`fish-workbench`、`xvfb-fish`、`wechat-fish`、`napcat-fish`、`fish-watchdog`。

## 核心能力

- **成长与记忆**：以追加事件记录经历，支持判断、反思、日记和旧事召回；历史事件保留，召回内容按重要程度整理。
- **自主活动**：定时唤醒，浏览 B 站内容，并通过专用工具观察视频、参与评论和回复。
- **对话与观察**：提供对话入口、成长状态和记忆展示界面。
- **微信桥接**：通过客户端窗口观察与交互接入微信，包含会话识别、提及检测、投递去重与发送限制。
- **QQ 通道**：LinuxQQ + NapCat（OneBot）接入，掉线观察与人工代发在工作台通道页。
- **桌宠**：Windows 桌宠壳显示她的状态、气泡与动作，支持陪你看屏幕；工作台可调外观并一键拉起壳。
- **交流频率控制**：在不同通道中管理发送间隔和配额。
- **工具可见性**：按面由策略表决定常驻与按需工具，按需工具经 `her_tools` 查看和打开；工具调用另记只读台账，不进事件流。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| [`src/dsh-fish`](src/dsh-fish/) | 成长、事件存储、记忆、对话、B 站工具与界面 |
| [`src/dsh-wx`](src/dsh-wx/) | 微信客户端交互与消息触发逻辑 |
| [`src/speech`](src/speech/) | 交流频率与配额控制 |
| [`src/dsh-bili`](src/dsh-bili/) | B 站出门会话与工具 |
| [`workbench/`](workbench/) | 8788 统一管理入口：通道桥 + 鱼侧 BFF + 她 / B 站 / 通道 / 系统页面 |
| [`desktop-pet/`](desktop-pet/) | Windows 桌宠壳（Electron + React），仅表现层 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 拆分完成后的目标架构与各层接口说明 |

核心插件运行在 DSH 宿主中，需要 Node.js 20 或更新版本。微信与 QQ 桥接依赖 Linux 图形环境（Xvfb）和外部客户端（Linux 微信、LinuxQQ、NapCat），这些程序与其安装迁移记录不在本仓库内；桌宠壳需要 Windows 与 Node.js 22.6 或更新版本。

当前已落地：按面工具可见性与自检、B 站独立出门会话（浏览与回复不再投进屋子）、core 与 B 站之间的反向依赖清理、事件 schema v3 与跨面去引号；`dsh-bili` 已拆包；8788 工作台的 P0–P4 源码已落地（BFF、只读页、写操作、旧入口标记与停轮询、注销旧面板 slot）。线上部署与双入口实测仍待执行；分段与验收见 [`ARCHITECTURE.md`](ARCHITECTURE.md) 与 [`单入口设计`](docs/superpowers/specs/2026-11-12-workbench-single-entry-design-v2.md)。

## 开发验证

核心插件使用 Node.js 内置测试工具：

```bash
cd src/dsh-fish
node --test
```

工作台与桌宠壳：

```bash
cd workbench && npm test
cd desktop-pet && npm test   # 在 Windows 上；首次构建见 desktop-pet/README.md
```

微信通道的单元测试与自测：

```bash
cd src/dsh-wx
node --test
node selftest.mjs
```

`node --test` 会跑 `test-*.mjs`，覆盖提及识别、耳朵注记、台账、任务板、检索、目录、发言人归因、归档、摘要、多会话映射和向量侧车。侧车本身需要模型和 GPU 时另行启动，测试只验证协议与回退，不联网。

运行时的记忆、会话、账户凭据和本机运维资料保留在本地，不纳入源码仓库。

## 来源与授权

核心插件基于 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish) 继续开发，原作者与 MIT 授权声明保留在 [`src/dsh-fish/LICENSE`](src/dsh-fish/LICENSE)。本仓库维护大肥鱼项目使用的插件源码及后续改进。
