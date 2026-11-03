# 大肥鱼 · Big Fat Fish

基于 DSH 的 AI 陪伴与自主成长项目。大肥鱼通过对话、观察和持续积累的经历形成自己的判断，留下记忆，也会反思和修正过去的想法。

项目围绕事件驱动的成长、长期记忆与多通道交流展开：人格通过经历逐渐形成，环境参数用于控制唤醒节奏、浏览活动和交流频率。

## 核心能力

- **成长与记忆**：以追加事件记录经历，支持判断、反思、日记和旧事召回；历史事件保留，召回内容按重要程度整理。
- **自主活动**：定时唤醒，浏览 B 站内容，并通过专用工具观察视频、参与评论和回复。
- **对话与观察**：提供对话入口、成长状态和记忆展示界面。
- **微信桥接**：通过客户端窗口观察与交互接入微信，包含会话识别、提及检测与发送限制。
- **交流频率控制**：在不同通道中管理发送间隔和配额。

## 代码结构

| 目录 | 内容 |
| --- | --- |
| [`src/dsh-fish`](src/dsh-fish/) | 成长、事件存储、记忆、对话、B 站工具与界面 |
| [`src/dsh-wx`](src/dsh-wx/) | 微信客户端交互与消息触发逻辑 |
| [`src/speech`](src/speech/) | 交流频率与配额控制 |

核心插件运行在 DSH 宿主中，需要 Node.js 20 或更新版本。微信桥接还依赖 Linux 图形环境和外部客户端辅助程序，当前仓库尚不包含完整的微信运行依赖；QQ 接入也尚未包含完整源码。

## 开发验证

核心插件使用 Node.js 内置测试工具：

```bash
cd src/dsh-fish
node --test
```

在仓库根目录运行微信及交流频率自测：

```bash
node src/dsh-wx/selftest.mjs
node src/dsh-wx/test-mention.mjs
node src/dsh-wx/test-mention-hits.mjs
node src/dsh-wx/test-ear-note.mjs
node src/dsh-wx/test-speech.mjs
node src/dsh-wx/test-remind-permit.mjs
node src/dsh-wx/test-ledger.mjs
node src/dsh-wx/test-tasks.mjs
node src/dsh-wx/test-retrieval.mjs
node src/dsh-wx/test-context.mjs
node src/dsh-wx/test-vector.mjs
```

运行时的记忆、会话、账户凭据和本机运维资料保留在本地，不纳入源码仓库。

## 来源与授权

核心插件基于 [ssamurias/dsh-fish](https://github.com/ssamurias/dsh-fish) 继续开发，原作者与 MIT 授权声明保留在 [`src/dsh-fish/LICENSE`](src/dsh-fish/LICENSE)。本仓库维护大肥鱼项目使用的插件源码及后续改进。
