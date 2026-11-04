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
- `capture`：采集参数。`preview` / `rotate` 只有显式 `false` 才关闭；数值越界会被限制在允许范围内，读不出数字时用缺省值。`chatCooldownSec` 是同一会话两次轮转采集的最小间隔。`queueMax` / `chatCooldownSec` 在采集队列首次创建时读取，改完配置需要重启服务才生效。
- `allowChats`：允许发送的会话；`noMentionChats`：免 @ 的私聊/文件传输会话。两者仍是发送与叫醒的门槛，和采集开关相互独立。

## 查询：`wx_history`

只读查询本地台账，不建任务、不写事件流，也不需要微信窗口在线。

- 不传 `chat`：列出有台账记录的非服务会话，按最后记录时间倒序，每行含会话名、最后时间和记录条数。
- 传 `chat`：按会话名查该会话的最近记录，可选 `query` 关键词和 `hours` 时间窗。
- `limit`：最多返回条数；两种模式（会话内记录、会话列表）都最多 20 条，列表模式缺省也是 20。
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

## 后台轮转采集

采集是后台流水线，不是模型工具：耳朵每轮把侧栏里变化过的会话放进队列，空闲时点开一个会话、补一屏历史、写台账，再切回原会话（`source: "capture"`）。

- 只轮转 `allowChats`；`ignoreChats` 不预看、不入队、不查询。
- 每次最多回滚 `maxScrollPages` 屏；与台账末尾已有重叠就不回滚。
- 同一会话两次采集至少间隔 `chatCooldownSec`；失败按 120 秒退避；队列上限 `queueMax`，满时丢最早入队的会话。
- 点开会清掉该会话未读（已接受的行为）；侧栏预览流本身不点开、不清未读。
- 暂停条件：策略关闭、登录页、树不健康、数据过期、宿主这一轮还没答完（host-busy）、正在发送（sending）、有 @ 等待投递（pending-hits）、发送后静默期（quiet）。暂停期间只排队，不点开任何会话；队列在暂停期间继续收新消息，空闲后补采。
- 采集到的 @ 会并入下一轮投递，避免清未读后漏叫。
- 查看状态：`~/.dsh-wx/health.json` 的 `capture` 块（`paused`、`pauseReason`、`queued`、`lastAt`、`lastChat`、`lastResult`、`lastError`）；日志前缀 `[dsh-wx] 采集：`。

## 发言人识别

- 结构化消息按「结构化 > 单聊本人 > 侧栏预览」归因；群聊结构化读不到名字时，用截图 OCR 对齐气泡上方的名字行。
- 名册在 `~/.dsh-wx/people.json`。OCR 行里带图标前缀时（如 `+e 张三`），先按精确名字查，查不到再用最后一个空格后的片段查。
- 只有名字已在名册里（精确或前缀命中）才直接采用；名字不认识时保留 OCR 原文并标 `low`。
- OCR 学到的新名字要**第二次**被看到才建档；第一次只在内存里挂起。证据按观察身份计数：同一屏/同一帧的稳定指纹只算一次，不同指纹累计到两次才建档。待确认名字 24 小时过期，最多保留 500 个，超出丢最旧的；`reload()` 清空。
- 微信昵称可以是任意字符串（纯 emoji、纯数字、标点结尾、词典词都行），不按字符类别或词典过滤。不含字母/汉字的预览名（纯 emoji、纯数字、纯标点）要第二次证据才建档；含字母/汉字的名字从侧栏预览、引用一次建档。
- 当前打开的会话最多每 `ocrEveryMs` 做一次 OCR 补名；OCR 前后在 GUI 锁内复核会话，已经切走就跳过；只对台账里发言人仍为空的记录追加 repair，不覆盖已有记录。
- 读不出就如实标未识别，不从正文猜。

## 验收边界

- 单测覆盖纯函数（解析、名册、队列、编排、OCR 对齐），`node --test` 不启动微信。
- 真机验证过：后台轮转点开 `allowChats` 里的会话、补历史、写入 `source: "capture"` 记录；预览流与服务号过滤；`health.json` 的采集暂停/静默状态；`people.json` 生成。
- 尚未由模型实际调用 `wx_history`（工具已注册）；`host-busy` / `sending` 暂停需要在真实对话回合里观察；OCR 发言人识别的准确率依赖截图质量，读不出时会明确标未识别。
- 群聊发言人只认预览里明确的名字，读不出保持未识别；私聊发言人由目录判定为会话本人。
