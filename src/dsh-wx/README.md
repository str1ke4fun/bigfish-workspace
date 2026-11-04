# dsh-wx

微信通道插件：通过无障碍树 + OCR 观察微信窗口，按策略向会话发送文字；零依赖，Node.js 20 或更新版本。

运行数据默认在 `~/.dsh-wx/`。本目录的单元测试不启动微信：

```bash
cd src/dsh-wx
node --test
```

## 配置：`~/.dsh-wx/policy.json`

每次调用工具、每轮耳朵都会重新读取，改完不需要重启。

```json
{
  "enabled": true,
  "allowChats": ["测试群A"],
  "noMentionChats": [],
  "ignoreChats": ["Tencent News", "File Transfer"],
  "capture": {
    "preview": true,
    "rotate": true,
    "queueMax": 20,
    "chatCooldownSec": 60,
    "maxScrollPages": 3,
    "quietMs": 10000,
    "ocrEveryMs": 20000
  }
}
```

- `ignoreChats`：不采集、不列出、不查询的会话。缺省为
  `Tencent News`、`File Transfer`、`Service Messages`、`Weixin Team`、
  `微信团队`、`微信ClawBot`、`微信支付`、`服务通知`。名字按去空白、ASCII 小写后精确比较，不做前缀或包含匹配。旧台账记录留在盘上，只是不再出现在预览流和 `wx_history` 列表里。
- `capture`：采集参数。`preview` / `rotate` 只有显式 `false` 才关闭；数值越界会被限制在允许范围内，读不出数字时用缺省值。`chatCooldownSec` 是同一会话两次轮转采集的最小间隔。
- `allowChats`：允许发送的会话；`noMentionChats`：免 @ 的私聊/文件传输会话。两者仍是发送与叫醒的门槛，和采集开关相互独立。

## 查询：`wx_history`

只读查询本地台账，不建任务、不写事件流，也不需要微信窗口在线。

- 不传 `chat`：列出有台账记录的非服务会话，按最后记录时间倒序，每行含会话名、最后时间和记录条数。
- 传 `chat`：按会话名查该会话的最近记录，可选 `query` 关键词和 `hours` 时间窗。
- `limit`：最多返回条数；会话内记录最多 20 条。
- 结果带发言人、时间、来源和置信度；发言人读不出来时如实标未识别，不从正文猜。

```text
wx_history {}
wx_history { "chat": "测试群A", "query": "排期", "hours": 24, "limit": 10 }
```

## 预览流边界

树健康时，耳朵每轮把侧栏里变化过的预览追加进台账（`source: "preview"`）。这条流只读当前侧栏：

- 不点开会话、不滚动列表、不清未读；未读数只作为记录字段。
- 草稿行和服务号会话跳过。
- 树处于 `partial` / `down` / `login` 时不写预览；OCR 回退只用于识别 @，不拿 OCR 结果写预览台账。
- 时间分隔行不当作消息；引用进 `quote` 字段；贴纸、图片等占位标记保留类型。
- 群聊发言人只认预览里明确的名字，读不出保持未识别；私聊发言人由目录判定为会话本人。
