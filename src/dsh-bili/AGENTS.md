# 改 dsh-bili 的硬约束

这里是 B 站面从 `dsh-fish` 拆出来的独立插件。`src/dsh-fish/AGENTS.md` 里
关于零依赖、事件流只追加、文案守门词的约束**同样适用**；下面只补拆包后的边界。

---

## 1. 依赖方向只有一条：本插件 → `fishCore`

- **禁止** `import '../../dsh-fish/lib/...'`，也禁止复制 `schema.js`、`settings.js`、
  `tool-policy.js` 这类表与常量。
- 事件流只经 `core.memory`（append / readAll / derive / refreshSelfDoc / eventById）；
  配置只经 `core.config`；主人身份与 cookie 只经 `core.owner`；防注入只经
  `core.guard`；处境与会话只经 `core.prompt` / `core.sessions`。
- 唯一的桥是 `lib/core.js`。新增对 core 的调用先加在那里，业务模块不直接摸
  `fishCore` 对象，方便审查与测试替身。

## 2. 面边界

- 工具只在 `bili` 面可见；提示段只挂 `surface: 'bili'`。
- B 站公开内容写事件时 `channel='core'`、`surface='bili'`（事件 schema v3）。
- 不往屋子（web）会话里投 B 站素材；投递只走「去 B 站」出门会话。

## 3. 零依赖

`dependencies` / `peerDependencies` / `devDependencies` 三个永远是 `{}`。
HTTP 用内置 `fetch`，签名用 `node:crypto`，抽帧用 `ffmpeg` 子进程（存在才用）。
测试只用 `node:test` + `node:assert`。

## 4. 只追加

`events.jsonl` 不删、不改、不重排。配额与去重从事件流里数，不另建账本。
出门、回复、看过什么，全部只追加 `meta` / `saw` / `bili_reply`。

## 5. 两条路由必须一致

`/dsh-bili/*` 与 core 的 `/dsh-fish/*` B 站代理走**同一份** `lib/service.js`。
改一处逻辑要改服务层，不在路由里分叉；P3 的双入口一致性靠这条。

## 6. 不代她说话

工作台只读她的评论与回复；真发评论走 `bili_speak`。不给人一个「代她发」的按钮。

## 7. 测试

`node --test` 必须全绿；改模块时同步搬/改对应测试。新增纯函数优先放
`support.js` / `bili.js` 这类可单测的地方。
