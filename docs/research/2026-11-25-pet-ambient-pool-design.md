# 桌宠氛围池设计（2026-11-25）

- 状态：方案稿，未改产品代码
- 范围：从“仅手动”的日常 / 节日动作里挑出一组，作为空闲时自动播放的**氛围池**
- 不在本稿：工作委派、来信、模型生成文案、新素材

---

## 1. 目标与非目标

### 目标

1. 桌宠在真正空闲时，能自己玩一会儿，而不是永远 idle。
2. 只用现有动作，不新增素材、不调模型、不弹文字。
3. 频率可控：不打扰、不抢稳态、不和休息/出门/陪看/手动动作冲突。
4. 池子可调：换权重、换动作、换冷却不需要改代码。

### 非目标

- 不做“剧情动作”：需要外部原因的动作不放进氛围池。
- 不做余额、工作主题、点击回应；它们各有自己的角色。
- 不做循环动作；氛围动作一次性播完回 idle。
- 不做“她主动找用户说话”；氛围池只演动作，不产生消息。

---

## 2. 选池原则

一个动作能进氛围池，需要同时满足：

1. **能自启动**：没有外部原因也能开始。
   - 反例：被吓一跳、偷吃零食被抓住、打瞌睡被惊醒、拆礼物、玩游戏气急败坏。
2. **低叙事**：不暗示“刚发生了什么”或“有人在旁边”。
3. **短、可中断**：一次性，播完回 idle；不选 loop。
4. **不抢稳态**：看起来不像休息、工作、出门、陪看。
5. **有辨识度**：用户一眼能看出她在干什么，而不是模糊的小动作。
6. **可重复**：同一动作隔一段时间再播不违和。

按这个口径，日常 62 条里大部分可以进池，但需要排除“反应型/剧情型”；节日 19 条更适合走日期池，不放进日常氛围池。

---

## 3. V1 池：19 条，三档权重

V1 只改 `triggers.json` 的 `ambient` 池，不改引擎。

### 3.1 常用（权重 3，8 条）

低强度、短、可重复，构成氛围主体。

| id | 动作 | 子类 |
| --- | --- | --- |
| `asset-109` | 超大伸懒腰 | 起居 / 身体 |
| `asset-087` | 照镜子 | 起居 / 身体 |
| `asset-070` | 撸猫 | 动物 |
| `asset-063` | 悠闲哼歌 | 音乐 |
| `asset-069` | 摇扇纳凉 | 起居 / 季节 |
| `asset-112` | 轻快记录 | 起居 / 记录 |
| `asset-110` | 踢毽子 | 玩耍（现有 ambient） |
| `asset-099` | 荡秋千 | 玩耍（现有 ambient） |

### 3.2 偶尔（权重 2，6 条）

需要一点“投入”，但不长。

| id | 动作 | 子类 |
| --- | --- | --- |
| `asset-018` | 原地专心玩魔方 | 玩耍 |
| `asset-002` | 下五子棋 | 玩耍 |
| `asset-001` | 三球抛接 | 玩耍 |
| `asset-066` | 抽陀螺 | 玩耍 |
| `asset-047` | 吹气球 | 玩耍 |
| `asset-113` | 骑木马 | 玩耍 |

### 3.3 少见（权重 1，5 条）

表演性更强，出现时有一点“今天运气不错”的感觉。

| id | 动作 | 子类 |
| --- | --- | --- |
| `asset-054` | 小提琴演奏 | 音乐 |
| `asset-064` | 扑克魔术 | 魔术 |
| `asset-114` | 鲸鱼吐泡泡特效 | 特效 |
| `asset-102` | 蝴蝶蜜蜂环绕头顶开花 | 特效 |
| `asset-027` | 可爱宅舞 | 舞蹈 |

权重合计：常用 24、偶尔 12、少见 5。抽样比例约 **58% / 29% / 12%**；如果觉得表演太多，把少见降到 1 条或权重改成 0.5 即可。

### 3.4 暂不放进 V1 的日常动作：逐条说明

先给判断口径：**氛围动作必须“无因可自启动”**。用户看到它时，不该产生“她为什么突然这样？”的疑问。下面这些动作都缺一个前因，或者前因太强，所以不适合日常氛围池。

#### 反应型：需要一个外部刺激

| 动作 | 画面暗示 | 为什么不适合氛围 | 可能的去处 |
| --- | --- | --- | --- |
| `被吓一跳` | 被突然吓到 | 没有惊吓源时，突然受惊会显得异常，像 bug 或“她是不是出事了” | 异常/错误事件的反应动作，或手动 |
| `偷吃零食被抓住` | 偷吃 + 被另一个人发现 | 两人叙事；没有“抓住她的人”，动作不完整 | 不适合桌宠单人氛围；手动 |
| `玩游戏气急败坏` | 玩游戏输了/卡关 | 需要游戏失败的前因；情绪强，容易被当真 | 未来“游戏事件”的反应，或手动 |
| `打瞌睡被惊醒` | 打瞌睡 + 被惊醒 | 需要惊醒源；单独播像“睡着又突然惊醒”，也会和 rest scene 的“睡觉”语义打架 | 若素材能拆出纯“打瞌睡”段，可做夜间氛围；当前整段不适合 |
| `拆礼物` | 收到并打开礼物 | 需要礼物和场合；随机拆礼物会产生“哪来的礼物”的叙事漏洞 | 生日/节日日期池，或手动 |

#### 对话型：需要有人在场

| 动作 | 画面暗示 | 为什么不适合氛围 | 可能的去处 |
| --- | --- | --- | --- |
| `是啊，吃什么` | 在回应“吃什么”的问题 | 是对话回应；桌宠不生成文本，单独播像对着空气说话 | `speak` cue 的反应变体，或手动 |
| `期待开饭` | 等别人开饭/喂食 | 暗示“饭快来了”，会制造“她在等你喂”的义务感 | 饭点时间槽（V2），或手动 |

#### 动作太重：破坏性、攻击性或强情绪

| 动作 | 画面暗示 | 为什么不适合氛围 | 可能的去处 |
| --- | --- | --- | --- |
| `原地跳跃抓碎头顶物品` | 跳起抓碎东西 | 破坏性/攻击性；视觉冲击大，不适合低强度 idle | 手动 |
| `原地重力下蹲压缩` | 夸张形变/压缩 | 无上下文像故障或身体不适 | 手动 |
| `用鲸鱼尾巴拍打地面` | 反复拍地 | 读作烦躁、发脾气；负面情绪 | 手动 |
| `侧身急躁跑` | 急躁地跑 | “急躁”是情绪状态；无前因像焦虑 | 手动 |

#### 其他不进 V1 的

| 动作 | 原因 |
| --- | --- |
| `深度思考碎碎念`、`写代码` | 和 thinking / 工作稳态重叠，容易让 idle 看起来像在干活 |
| `整体换装试色`、`小幅度原地360度旋转展示`、`女仆屈膝礼仪` | 展示/表演型，不是“自己玩”；可以以后做“偶尔”档 |
| 余额 6 条 | 明确不做状态，保持手动 |
| 点击回应 3 条 | 属于“反应”角色，不是氛围 |

---

## 4. 触发与频率

### 4.1 什么情况下允许

氛围池只在**真正空闲**时参与：

```text
scene == null
activity == null
没有手动动作 / 服务端 action
没有未消费 cue
不在安静时段
presence 模式允许（见 4.3；event 禁止，work / ambient / off 按各自策略）
```

任何一条不满足，本拍不播氛围；等状态回落后再重新武装。

注意：`presence.on` 不再是一刀切禁止 ambient。现在的 `isAmbientState` 只要陪看开着就压住氛围，这正是要拆开的地方：游戏陪玩时应该压住，工作模式长空闲时应该放开。

### 4.2 频率：现状、tick 概率、定时抽样

#### 4.2.1 现状

- 壳每 2 秒轮询一次，`reduceTriggers` 每拍运行一次。
- `ambientConsumed` 在每个空闲段只允许一次 ambient；之后必须等 cue / activity / scene 等非空闲状态才能重新武装。
- `minGapSec` 只约束两次 ambient 的最小间隔，不会让长时间 idle 重复播。

所以现状是“**进入空闲后演一次，然后一直 idle**”。池子再大，长时间 idle 也只看得到一条。

#### 4.2.2 tick 概率触发可行吗

可行，而且实现很简单：每个空闲 tick 掷一次骰子，命中就播。

```text
if (!ambientEligible) return
if (now - lastAmbientAt < minGapMs) return
if (todayCount >= maxPerDay) return
if (rng() < p) {
  playAmbient()
  lastAmbientAt = now
  todayCount++
}
```

在 2 秒 tick 下，平均等待时间 ≈ `tickMs / p`：

| 每 tick 概率 p | 平均等待 | 15 分钟内播的概率 | 60 分钟内播的概率 |
| ---: | ---: | ---: | ---: |
| 0.001 | ≈ 33 分钟 | ≈ 36% | ≈ 84% |
| 0.002 | ≈ 17 分钟 | ≈ 59% | ≈ 97% |
| 0.0022 | ≈ 15 分钟 | ≈ 63% | ≈ 98% |
| 0.003 | ≈ 11 分钟 | ≈ 74% | ≈ 99.6% |
| 0.005 | ≈ 7 分钟 | ≈ 90% | ≈ 100% |

（按几何分布粗算；加上 `minGap` 后，平均等待再加 minGap。）

**优点**：

- 代码最短，不需要“下一次时间”状态。
- 无记忆：只要空闲，任何时候都有同样的“下一秒可能动一下”的感觉。
- 天然适合“氛围”这种没有明确时间表的行为。

**缺点**：

- **频率依赖 tick 间隔**。如果以后轮询从 2 秒改成 5 秒，同样的 p 会让平均等待变成 2.5 倍。必须把 p 和 tick 间隔绑定，或在配置里写成“目标平均分钟数”，由引擎换算。
- **方差大**。p=0.002 时，仍有约 41% 的概率 15 分钟内不播，2.7% 的概率 60 分钟内不播；用户可能觉得“有时很勤，有时半天不动”。
- **测试不直观**。只能测“p=0 永不播、p=1 立即播、minGap/日上限生效”，很难断言具体节奏。
- **仍然需要 minGap、日上限、安静时段、交互后冷静期**；概率不能替代这些约束。

#### 4.2.3 更推荐的做法：进入空闲时抽“下一次时间”

本质上和 tick 概率等价，但把随机性从“每 tick 掷骰子”改成“进入空闲时抽一个等待时长”：

```text
当从非空闲进入空闲：
  nextAmbientAt = now + randomBetween(10min, 25min)

每个 tick：
  if (!ambientEligible) { nextAmbientAt = null; return }
  if (quietHours) { nextAmbientAt = max(nextAmbientAt, quietEnd + random(5–15min)); return }
  if (now < nextAmbientAt) return
  if (todayCount >= maxPerDay) return
  playAmbient()
  nextAmbientAt = now + randomBetween(10min, 25min)
  todayCount++
```

好处：

- **不依赖 tick 间隔**：轮询改成 5 秒也不会改变频率。
- **可测试**：注入 `now` 和 `rng`，能精确断言“10 分钟前不播、25 分钟后必播”。
- **可解释**：用户问“为什么她刚才动了”，答案是“空闲满了一个随机间隔”，而不是“刚好掷中了”。
- **容易加约束**：安静时段、交互后冷静期、每日上限都在同一处处理。
- **仍然有随机感**：每次间隔在 10–25 分钟内抽样，不是固定节拍。

如果一定要“每 tick 概率”的体感，可以用**指数分布**抽下一次时间：`next = now + exponential(mean=15min)`。数学上等价于每 tick 恒定 hazard，但实现是定时抽样，测试和 tick 率解耦。

#### 4.2.4 参数建议

| 参数 | 建议值 | 说明 |
| --- | --- | --- |
| 空闲后最早可播 | 2–3 分钟 | 不要刚停下工作就立刻自己玩 |
| 随机间隔 | 10–25 分钟（均匀）或均值 15 分钟（指数） | 兼顾“有生气”和“不打扰” |
| 两次 ambient 最小间隔 | 5 分钟 | 防止连续播 |
| 每个空闲段上限 | 3 次 | 防止长时间 idle 一直演 |
| 每日上限 | 6–8 次 | 安全阀；不是目标值 |
| 用户交互后冷静期 | 5 分钟 | 点击/聊天/拖动/手动动作后 |
| 安静时段 | 23:00–07:00 | 沿用现状；结束后再加 5–15 分钟随机延迟 |
| 同动作冷却 | 2 小时 | 避免重复 |

#### 4.2.5 持久化与测试

- `TriggerSeen` 增加有界字段：`ambientNextAt`、`ambientDayKey`、`ambientCountToday`、`lastAmbientActionId`、`lastAmbientAt`。
- 跨重启保留“下一次时间”和日计数；用户清 localStorage 时重置是可接受降级。
- 测试：
  - `p=0` / 间隔未到 / 日上限满：不播。
  - `p=1` / 间隔已到：播一次，并推进下一次时间。
  - 安静时段：不播，且下一次时间被推到安静结束后。
  - 用户交互后：冷静期内不播。
  - 同动作冷却：抽到冷却中的动作时重抽或顺延。

#### 4.2.6 分阶段

- **V1（零代码）**：只换池子，沿用“每个空闲段一次”。
- **V1.5（推荐）**：做“进入空闲时抽下一次时间”，加最小间隔、每空闲段上限、每日上限。
- **V2（时间槽）**：把 ambient 拆成 morning / day / evening 三个小池；需要新的 `when` 或 `timeWindow` 字段。
- **V3（节日）**：节日动作走日期池，不混进日常 ambient。

### 4.3 按 presence 模式拆分，策略放在可编辑的 ambient.json

桌宠已经有四种陪看模式（工作台 / 托盘的「陪你看屏幕」）：

| 模式 | 现有含义 | 用户语境 |
| --- | --- | --- |
| `off` | 不看屏幕 | 没在陪看 |
| `event` | 场景突变 / 结算 / 菜单，事件驱动 | 打游戏陪玩 |
| `ambient` | 低频看屏幕，值得说才说 | 氛围陪伴 |
| `work` | 只看前台白名单（Code / 终端），长冷却 | 工作 |

**不再把“工作模式只能演 5 条”写死在引擎里。** 每个模式的池子、频率、上限都放进 `ambient.json`，由你自己调。

#### 4.3.1 文件位置与覆盖

```text
desktop-pet/assets/ambient.json                 默认策略
desktop-pet/assets/skins/<id>/ambient.json      皮肤覆盖
```

- 和 `actions.json` / `triggers.json` 一样属于表现层数据，不进服务端。
- 皮肤同 `mode` 覆盖默认；某个 mode 缺失或非法时，回落到内置默认。
- 不监听文件变化；启动、换皮肤、点「重新载入动作」时重新读取。
- 可以单独加一个「重新载入氛围」菜单项，避免改一个池子还要重载全部动作。

#### 4.3.2 schema：item 列表，不是平行数组

每个模式持有一个 `items` 数组；每个 item 是一个可独立增删改的“表情 + 权重”。

```jsonc
{
  "version": 1,
  "quietHours": { "start": "23:00", "end": "07:00", "afterJitterSec": 600 },
  "modes": {
    "off": {
      "enabled": true,
      "items": [
        { "action": "asset-109", "weight": 3, "enabled": true },
        { "action": "asset-087", "weight": 2, "enabled": true },
        { "action": "asset-070", "weight": 2, "enabled": true }
      ],
      "frequency": {
        "intervalMinSec": 480,
        "intervalMaxSec": 1200,
        "minGapSec": 300,
        "maxPerIdle": 10,
        "maxPerDay": 30,
        "settleSec": 300,
        "actionCooldownSec": 7200
      }
    },
    "event": {
      "enabled": false,
      "items": []
    },
    "ambient": {
      "enabled": true,
      "items": ["…"],
      "frequency": {
        "intervalMinSec": 720,
        "intervalMaxSec": 1500,
        "maxPerIdle": 6,
        "maxPerDay": 20
      }
    },
    "work": {
      "enabled": true,
      "items": ["…"],
      "frequency": {
        "intervalMinSec": 1200,
        "intervalMaxSec": 2400,
        "maxPerIdle": 4,
        "maxPerDay": 16
      }
    }
  }
}
```

**为什么用 `items` 而不是 `pool` + `w`：**

- 增删一个动作就是增删一个对象，不会出现两个数组下标错位。
- 以后可以给单个 item 加字段，不影响其他动作。
- UI / API 都是“一行一个表情 + 权重”，更适合做池子编辑器。

字段：

| 字段 | 必填 | 含义 |
| --- | --- | --- |
| `modes.<mode>.enabled` | 是 | `false` = 该模式完全不播 ambient |
| `modes.<mode>.items` | 是 | item 数组；`enabled:false` 时可为空 |
| `items[].action` | 是 | 动作 id，必须存在于当前动作目录 |
| `items[].weight` | 否 | 非负有限数，默认 1；全 0 视为无效 |
| `items[].enabled` | 否 | 默认 true；可临时关掉某条而不删 |
| `items[].cooldownSec` | 否 | 单条冷却，覆盖全局 `actionCooldownSec` |
| `items[].minIdleSec` | 否 | 至少空闲 N 秒后才可抽到；用于“长空闲专属”动作 |
| `items[].tags` | 否 | 预留：`calm` / `playful` / `performance` 等，供未来按标签选池 |
| `modes.<mode>.frequency.intervalMinSec` / `intervalMaxSec` | 是 | 进入空闲后随机等待的区间；相等即固定间隔 |
| `modes.<mode>.frequency.minGapSec` | 否 | 两次 ambient 的硬最小间隔，默认 300 |
| `modes.<mode>.frequency.maxPerIdle` | 否 | 每个空闲段最多几次 |
| `modes.<mode>.frequency.maxPerDay` | 否 | 每天最多几次 |
| `modes.<mode>.frequency.settleSec` | 否 | 用户交互 / cue 之后的冷静期，默认 300 |
| `modes.<mode>.frequency.actionCooldownSec` | 否 | 同一动作的冷却，默认 7200 |
| `quietHours` | 否 | 全局安静时段；mode 内可覆盖 |

#### 4.3.3 默认策略（工作模式放宽）

| mode | enabled | pool | 间隔 | 每空闲段 | 每日上限 |
| --- | --- | --- | --- | ---: | ---: |
| `off` | true | 19 条完整池 | 8–20 分钟 | 10 | 30 |
| `event` | false | 空 | — | 0 | 0 |
| `ambient` | true | 19 条完整池 | 12–25 分钟 | 6 | 20 |
| `work` | true | 19 条完整池 | 20–40 分钟 | 4 | 16 |

工作模式不再限制成 5–7 条：默认允许完整池，只是间隔更长、每日上限更低。这样她在工作模式的长空闲里也能自己玩，你如果觉得吵，再在 `ambient.json` 里把 `work.pool` 收窄。

`event` 仍然默认关闭；这是“打游戏陪玩时不要跑来跑去”的唯一硬规则。如果你以后想让她在游戏间隙动一下，把 `event.enabled` 改成 true 并给一个很小的池子即可。

#### 4.3.4 想更安静的工作模式：一个可选配置

如果以后觉得工作模式还是太活跃，把 `work` 换成这组即可，不需要改代码：

```jsonc
"work": {
  "enabled": true,
  "items": [
    { "action": "asset-109", "weight": 3 }, // 超大伸懒腰
    { "action": "asset-087", "weight": 3 }, // 照镜子
    { "action": "asset-070", "weight": 3 }, // 撸猫
    { "action": "asset-069", "weight": 2 }, // 摇扇纳凉
    { "action": "asset-112", "weight": 2 }, // 轻快记录
    { "action": "asset-063", "weight": 1 }, // 悠闲哼歌（可选）
    { "action": "asset-014", "weight": 1 }  // 写代码（可选）
  ],
  "frequency": {
    "intervalMinSec": 1800,
    "intervalMaxSec": 2700,
    "maxPerIdle": 2,
    "maxPerDay": 10
  }
}
```

这组就是我之前说的“低干扰工作池”，现在它是**一个可选示例**，不是默认。

#### 4.3.5 增删动作

- **加动作**：webm 放进 `assets/webm/` → 在 `actions.json` 登记 → 在 `ambient.json` 对应 mode 的 `items` 里加一条 `{ action, weight }` → 重新载入。
- **删动作**：从 `items` 移除该项；动作本身仍留在 `actions.json` 里，可以手动演。
- **临时关掉**：把 `items[].enabled` 设为 `false`，不删除配置。
- **调权重**：改 `items[].weight`；不需要和其他项对齐，也不会出现平行数组错位。
- **调频率**：改 `frequency.intervalMinSec` / `intervalMaxSec` / `maxPerIdle` / `maxPerDay`。
- **单条冷却 / 长空闲限定**：用 `items[].cooldownSec` / `items[].minIdleSec`。
- **新 mode**：presence 模式是固定的四种，不新增；需要“更安静”的上下文时，改现有 mode 的 `enabled` 或 `items`。

#### 4.3.6 校验与回退

- `items[].action` 不存在或非法：丢弃该 item，并记日志；其他 item 继续可用。
- `items` 重复 action：后者覆盖前者，保留首次出现的位置，并记日志。
- `weight` 非法/负数/NaN：按 1 处理，并记日志；全部为 0 时该 mode 视为关闭。
- `frequency.intervalMinSec > intervalMaxSec`：交换；负数按 0。
- `enabled:true` 但 `items` 为空：该 mode 视为关闭，并记日志。
- 整个 mode 缺失/非法：回落到内置默认；其他 mode 不受影响。
- 文件缺失：全部用内置默认。
- 皮肤覆盖只替换同名 mode，不整体替换。
- 用户配置覆盖只覆盖显式给出的字段；`items` 是整体替换，不是逐项合并。

#### 4.3.7 管理能力：先不做 UI，但内置 API

**存储位置**

用户策略放在服务端配置 `config.pet.ambient`（`~/.dsh-fish/config.json`），而不是只放在壳的本地文件里。理由：

- 工作台 8788 可以通过 BFF 读写，未来做池子编辑器不需要给壳开监听端口。
- 壳通过 `/pet/state.settings.ambient` 读取，下一次轮询生效。
- 服务端持久化，重启不丢。
- 壳侧的 `assets/ambient.json` / 皮肤文件仍然作为默认值；用户配置覆盖它们。

**读取与合并顺序**

```text
内置默认
  > desktop-pet/assets/ambient.json
  > desktop-pet/assets/skins/<id>/ambient.json
  > config.pet.ambient（用户策略，最高）
```

壳负责合并、校验、丢弃未知 action，并把最终生效的 `revision` / `errors` 放在 hello 里回报；工作台据此显示“当前生效策略”和“被丢弃的条目”。

**数据层函数（纯函数，可单测）**

```text
getAmbientPolicy()                      读取生效策略
addAmbientItem(mode, action, weight?)   加一条表情
removeAmbientItem(mode, action)         删一条表情
setAmbientItem(mode, action, patch)     改权重 / enabled / cooldown / minIdle
setAmbientFrequency(mode, patch)        改间隔 / 上限 / 冷静期
setAmbientEnabled(mode, enabled)        临时开关整个 mode
resetAmbient(mode?)                     重置某个 mode 或全部
validateAmbientPolicy(policy, actions)  校验并返回 { policy, errors }
```

这些函数是“内置可配置”的核心；HTTP / UI 只是薄封装。

**HTTP 路由（BFF 白名单）**

BFF 只支持固定路径（最多一个 `pattern` 段），所以不用 RESTful 的 `:mode/:action`，改成**固定路径 + op 载荷**：

```text
GET  /api/fish/pet/ambient
POST /api/fish/pet/ambient
```

`POST` 的 `op`：

```text
{ op: 'set-enabled',    mode, enabled }
{ op: 'replace-mode',   mode, policy }
{ op: 'set-frequency',  mode, patch }
{ op: 'add-item',       mode, action, weight? }
{ op: 'set-item',       mode, action, patch }   // weight / enabled / cooldownSec / minIdleSec
{ op: 'remove-item',    mode, action }
{ op: 'reset',          mode? }
```

- `GET` 返回：`revision`、`defaults`（壳最近一次 hello 上报的默认策略）、`overrides`（服务端用户策略）、`effective`（合并结果）、当前动作目录（`id / label / group`）、校验错误。
- 每次写入 `revision++`；壳每个 `/pet/state` 轮询都读 `settings.ambient`，不按 revision 判断是否重新载入。
- 服务端用最近一次 hello 上报的动作目录校验 action id；壳还没上报时先接受但不校验（V1 无显式标记），壳端再丢弃未知项。
- `set-frequency` / `add-item` / `set-item` / `remove-item` 需要“当前生效 mode”作为基线：优先用 override，没有就用 defaults；两边都没有时返回 `NO_BASE_POLICY`。
- `replace-mode` 可以不带 defaults，直接把给定 mode 作为完整 override。

**CLI / UI**

- UI 可以后做；先可以用 `curl` 或一个薄 CLI 调这些路由。
- 未来工作台池子编辑器只需要：`GET` 拿数据、勾选/拖权重/改频率、`PATCH` 回写。
- 不需要为 UI 再改壳的配置格式。

#### 4.3.8 状态优先级

```text
scene rest/out
  > activity（thinking / working / waiting / result / success / error）
  > 手动动作 / 服务端 action
  > 未消费 cue
  > presence 模式策略（enabled / interval / caps）
  > ambient
```

- 任何上层存在，ambient 都不播。
- `event` 默认 `enabled:false`，直接禁止。
- `work` / `ambient` / `off` 按各自策略的间隔和上限。
- `presence.on` 不再是一刀切禁止，而是按 mode 查策略。
- `rest` / `out` 场景永远压过 ambient。

#### 4.3.9 入口与扩展

- 切换陪看模式就是切换氛围策略；不新增 `ambientMode` 设置。
- 配置模型是 `items` 列表：表情、权重、单条开关/冷却/空闲门槛都是 item 字段；频率是 mode 字段。
- 新增动作不改 schema；新增字段只影响读它的代码，旧客户端忽略未知字段。
- 工作台后续可以加池子编辑器；V1 先做到“API / JSON 可管理 + 壳下一轮生效”。
- 托盘/菜单可以加「重新载入氛围」，和「重新载入动作」并列。

### 4.4 重复控制

- 同一个动作 2 小时内不重复；如果权重抽到它，重抽一次或顺延到下一个候选。
- 同一个子类不连续出现两次（可选，需要引擎支持）。
- 日期 / 节日池与日常氛围池分开计数，不共享冷却。

### 4.5 用户交互后的安静期

点击、拖动、聊天、手动动作之后，至少 5 分钟内不播氛围；避免“刚跟她说句话，她马上自己玩起来”的突兀感。

---

## 5. 节日池（独立于日常氛围池）

节日 19 条适合走日期触发，而不是日常 ambient：

| 日期 | 候选动作 | 说明 |
| --- | --- | --- |
| 01-01 / 春节 | 写福字、舞狮头、收红包、吃饺子、放烟花 | 春节一组 |
| 01-15 / 元宵 | 吃汤圆、放孔明灯、放河灯 | 元宵一组 |
| 05-05 / 端午 | 吃粽子 | 单条 |
| 08-15 / 中秋 | 中秋赏月吃月饼、插茱萸赏菊 | 中秋 / 重阳可分开 |
| 10-31 | 讨糖南瓜灯、萌化小幽灵 | 万圣（现有） |
| 12-25 | 装点圣诞树、堆雪人 | 圣诞（现有） |
| 其他 | 吃年糕、吃腊八粥、吃重阳糕、吃青团、穿针乞巧、被落叶淹没 | 按真实日期补 |

建议先保留现有 12-25 / 10-31，不急着把 19 条全部排期；节日池的排期需要确认农历日期怎么算，这是另一个设计点。

---

## 6. 与现有 5 类角色的关系

氛围池只使用 **filler** 角色，不新增角色：

| 输入 | 角色 | 是否进氛围池 |
| --- | --- | --- |
| 状态 | 稳态 | 否 |
| 内容事件 | 反应 | 否 |
| 转折事件 | 转折 | 否 |
| 环境事件 | 氛围 | **是** |
| 用户事件 | 手动 | 否（但池里的动作仍可手动演） |

因此 V1 不需要改动作分类，只需要把 `ambient` 的 pool 换掉。

---

## 7. 验收

1. 空闲时能播出池里的动作；有 scene / activity / presence / 手动动作 / cue 时不播。
2. 安静时段不播；点击/聊天/拖动后 5 分钟内不播。
3. 同一动作 2 小时内不重复（V1.5）。
4. 每天不超过上限（V1.5）。
5. 池里某个动作素材缺失时只丢弃该条，其他动作继续可用。
6. 皮肤可以覆盖 ambient 池；皮肤表缺失时回落到默认表。
7. Windows 真机：透明、无闪烁、一次性播完回 idle、不卡在 loop。
8. Node 测试：权重可复现、冷却、空闲门、皮肤覆盖、缺动作裁剪。

---

## 8. 需要拍板

1. **默认工作策略**：`work` 默认用完整 19 条池、20–40 分钟 / 每空闲段 4 / 每日 16，是否符合“过严格”的修正？还是默认就用 4.3.4 的低干扰示例？
2. **配置形态**：用户策略放服务端 `config.pet.ambient`，通过 `GET/PATCH/POST/DELETE /pet/ambient` 管理，壳侧 JSON 只做默认——这个方向可以吗？UI 后做，但 API 和数据层这轮就内置。
3. **上限**：`off` 30/天、每空闲段 10；`ambient` 20/天、每空闲段 6；`work` 16/天、每空闲段 4。这个量级是否合适？
4. **频率**：先按 V1 的“每个空闲段一次”，还是直接做 V1.5 的“空闲满一个随机间隔再播”？
   - 我倾向 V1.5，否则 19 条池子大部分时间看不到。
5. **随机方式**：每 tick 掷概率，还是进入空闲时抽“下一次时间”？
   - 我倾向后者：频率不随轮询间隔漂移，测试也可断言；如果一定要 tick 概率，p 建议按 `2 秒 / 15 分钟 ≈ 0.0022` 起步，并绑定 tick 间隔。
6. **少见档要不要**：小提琴 / 魔术 / 特效 / 宅舞是否只在 `off` 的完整池里出现？
   - 我倾向只放 `off`，权重压到 10–15%。
7. **时间槽是否现在做**：早晨刷牙 / 吃饭类动作很适合时间槽，但需要扩触发层；可以先 V1.5 观察一周再加。
8. **节日池排期**：是否本轮只保留 12-25 / 10-31，其余等农历/节日表设计后再接？
