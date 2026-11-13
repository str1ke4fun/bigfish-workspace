# dsh-bili

大肥鱼的 B 站面。从 `dsh-fish` 拆出来的独立插件：刷站、出门、看画面、在评论区说话。

- **零依赖**：HTTP 用内置 `fetch`，签名用 `node:crypto`，抽帧用宿主机上的 `ffmpeg`。
- **不 import `dsh-fish` 内部文件**：只通过宿主服务 `fishCore` 读写事件流、配置、
  主人身份、防注入、处境与会话。边界见 [`AGENTS.md`](AGENTS.md)。
- **状态库不变**：仍然是 `~/.dsh-fish`（`DSH_FISH_HOME` 可覆盖），事件流只追加。

## 它提供什么

| 入口 | 说明 |
| --- | --- |
| 工具 `bili_look` | 看首页 / 搜词 / 顺着一条视频往下看。只读。 |
| 工具 `bili_watch` | 从一条视频抽几帧拼图并 OCR，读画面上的字。 |
| 工具 `bili_speak` | 在评论区留一句话，或回一句别人留在她评论下面的话。 |
| 「去 B 站」会话 | 工作区 `<root>/home/bili`；刷站素材与新回复投进这条会话。 |
| `schedule.onTick` | 后台刷站 + 到点出门（60s 粒度，跑在 core 的串行 tick 里）。 |
| `schedule.onWake` | 醒来前的素材（原 `lookBeforeWake`）。 |
| `prompt.section` | `fish:bili`，只挂 `bili` 面；含「上网」「在网上说话」「最近刷到的」。 |
| `/dsh-bili/*` | 只读路由，见下。 |
| `ctx.provide('bili')` | core 的 `/dsh-fish/*` B 站路由代理到这里；工作台 BFF 也用它。 |

## 路由

全部挂在 `/dsh-bili` 前缀下，fail-closed（拿不到 `connection` 服务即 503）：

```
GET  /status                 安装、今日刷站/出门数、风控、出门会话
GET  /browse                 今日候选、看过的 BV、配额、关键词与避让
GET  /history?days=14        看过的视频（按天分组）
GET  /footprint?days=&limit= 视频足迹 + 评论足迹
GET  /comment-body?bvid=&rpid=  现取一条评论正文（10 分钟缓存）
GET  /comment                评论开关、配额、今天发过的、谁回了她
GET  /risk                   风控状态
POST /risk {clear:true}      解冻
GET  /cover/<bvid>           封面图（本地没有就取一次）
GET  /sheet/<bvid>           抽帧拼图（本地没有就现场抽一次）
GET  /ledger?date=&session=&tool=&limit=  core 工具台账只读回看
GET  /outings                出门配额、最近一次、会话 id
GET  /material?limit=10      最近刷到的素材
```

## 加载顺序

`dsh-bili` 在 `apply` 里等 `fishCore` 出现（最多 60 秒，500ms 轮询），然后才注册
工具、贡献策略表、挂提示段、建出门会话、挂调度钩子与路由。`fishCore` 一直没出现时
只记一条日志，不抛错、不空转。停用插件 = dispose 钩子与路由，零后台活动。

## 测试

```bash
node --test
```

测试使用假 `ctx` / 假 `fishCore`，不联网、不读写真实状态库。
