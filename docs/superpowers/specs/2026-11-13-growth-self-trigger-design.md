# 大肥鱼成长线自触发事件调整

- 日期：2026-11-13
- 状态：设计稿，待评审；未实施
- 适用代码线：`bigfish-workspace-dev`（线上 8710 实际使用的 worktree，事件格式 v3）
- 关联讨论：第 13 节 `growthDays` 语义（item 11）另开一轮，不在本 spec 内定案

---

## 1. 背景

### 1.1 线上实测

线上配置（`~/.dsh-fish/config.json`）：

```
growthDays: 90         wakesPerDay: 2
window: 09:30–18:50    daily.events: 3, daily.questions: 2
browse: perDay 3, window 08:00–23:00
comment: perDay 3, scanEveryMin 120, window 09:30–23:59
memory: sleepEveryDays 7, docBudget 1800, beliefsShown 3
diary: enabled true, visible true, keepDays 90
```

当前模型（2026-11-13 11:00 左右，基于线上事件流）：

```
day 17 · stage 1(信任) · 11 条 belief
refused 1 · revises 0 · corrected 0 · narrations 0 · tested 1
voices 36（echoed 0）· saw 102
absenceDays 2 · lastSeen 11-13 10:02 · lastWake 11-12 14:33
stageBounds [24, 49, 78, 90] · gateStage 2（trust 已过，autonomy 待过）
```

当天 `plan()` 返回 `quiet`。stage 1 五张卡的状态：

| 卡 | 状态 |
|---|---|
| `why_here` | 10-27 已用掉 |
| `first_bet` | 已用掉；现在 `beliefCount>0`，条件永远不满足 |
| `name_offer` | 她已经叫他“老哥”，`!m.name` 永远不满足 |
| `test_first` | 唯一可重复卡；上次 11-12 14:33，冷却 3 天，下次最早 11-15 |
| `absence_probe` | `absenceDays=2`，门槛 `absenceThreshold(90)=3`，永远差 1 天 |

结果：11-13 到 11-14 基本不会再醒；11-10 / 11-11 / 11-12 分别出现 173 / 316 / 345 条 `quiet`（这些是旧代码写的；当前 dev 已改为一天一条）。

### 1.2 记忆层覆盖

从 10-27 到 11-13 共 18 天：

- 日记 6 天（10-27、10-28、10-31、11-02、11-03、11-12）
- 日报 4 天（10-27、10-28、11-10、11-12）
- 成功唤醒 4 天，其中 11-10、11-12 是 `test_first` 手动测试唤醒，不是日程唤醒

日报只在 `wake()` 里写；日记只在她主动调 `capture(type=diary)` 时写。两者都没有收盘任务。

### 1.3 根因

1. **stage 1 内容在第 2 天就耗尽**：`growthDays=90` 把 stage 1 拉到 24 天，但 stage 1 只有 3 张一次性卡 + 2 张条件卡；`name_offer`、`first_bet`、`absence_probe` 在她当前状态下都是死条件。
2. **`absence_probe` 在 90 天档位下死锁**：冷落在 2 天时被记录，`derive` 优先用记录里的 `days=2`；卡的门槛是 3。记录不会随天数涨，所以永远差 1 天。
3. **没有唤醒时刷站配额被压到 1/3**：`browseBudget` 为“还没发生的唤醒”预留 2 次；唤醒一直不发生，reserve 一直不释放。
4. **刷站第三个槽位永远丢**：`browse.window=08:00–23:00`，三个槽位落在上午/下午/晚上；你 18:30 下线，晚上那个槽位每天用不到。
5. **`sleep` 只认精确取模**：`model.day % 7 == 0` 且当天必须有唤醒；错过一天等 7 天。
6. **日报/日记没有收盘路径**：`flushReport` 只在 `wake()` 里调；日记只靠她主动写。

---

## 2. 目标与非目标

### 2.1 目标

- 不再出现“stage 1 内容耗尽导致整天 quiet”。
- 每天都有日报；日记覆盖率显著上升（验收目标 ≥5/7）。
- 所有时间驱动的活动落在你实际在线的窗口内（默认 09:30–18:20）。
- 冷落、每周反思、刷站配额在“宿主在线但没唤醒”的日子里也能正确推进。
- 不新增常驻定时器；所有后台活动仍然可由 `dispose()` 一次清掉。
- 事件流只追加，不迁移、不改写、不删除历史事件。

### 2.2 非目标

- 不改编写风格、人设、语气、禁令。
- 不由代码替她写日记或替她总结。
- 不新增第五阶段，不改三道成长门的定义。
- 不重构 B 站功能本身。
- 不在本 spec 内决定 `growthDays` 的最终语义（见第 13 节）。

---

## 3. 设计原则

1. **事件流是唯一真相源**：日报、日记、B 站素材都是输出或旁支，不能反过来驱动成长判定。
2. **配置先行**：能通过配置解决的，先改配置；代码只做配置无法表达的行为。
3. **收盘是维护动作，不是成长事件**：收盘唤醒不占 `wakesPerDay` / `daily.events`，不写 `fired:`，不写 `seen:`。
4. **纯函数优先**：到期判断、时间线计算、配额计算都做成可单测的纯函数。
5. **不新建 `setInterval`**：收盘任务挂在现有 60 秒 tick 上，沿用 `dispose()` 语义。
6. **失败不重试**：收盘唤醒失败只写一条 `closingfail:`，不每分钟重试；报告仍然照写。
7. **本地时区**：所有 `HH:MM` 判断走本地时区，与 `inWindow` 同口径。

---

## 4. 配置层（items 1–4）

### 4.1 线上配置变更

这些是**实例配置**，写入 `~/.dsh-fish/config.json`，不一定要改 `DEFAULTS`：

| 键 | 旧值 | 新值 | 目的 |
|---|---|---|---|
| `growthDays` | 90 | **60（暂定）** | 今天进入 stage 2，解锁 6 张卡；冷却系数从 1.73 降到 1.41。最终值见第 13 节 |
| `window` | `["09:30","18:50"]` | `["09:30","18:20"]` | 末端留 10 分钟缓冲 |
| `browse.window` | `["08:00","23:00"]` | `["09:30","18:20"]` | 三个刷站槽位全部落进在线时段 |
| `comment.window` | `["09:30","23:59"]` | `["09:30","18:20"]` | 晚间回复扫描不再空转 |
| `wakesPerDay` | 2 | **1** | 刷站 reserve 从 2 降到 1，free 从 1 升到 2 |

### 4.2 注意事项

- `sched:<dk>` 已经存在时，`ensureSchedule` 会沿用旧落点。今天已经写了 17:38，改窗口不会把今天重抽到新窗口；新窗口从明天生效。要今天验证，只能等到 17:38 或手动唤醒。
- `browseSlots` 每次按当前配置计算；改窗口后今天的槽位会重新分布，但已用掉的 `browse:<dk>` 计数不回退。
- `growthDays` 从 90 改到 60 会立即改变 `stageOf(day)` 和 `scaledEveryDays`；不会改写任何事件。
- `wakesPerDay=1` 只降低唤醒上限和刷站预留；不会删除已有的 `wake:` 记录。
- 这些值不写进 `DEFAULTS`，避免影响新装用户；`DEFAULTS` 只新增 `memory.closing`（见 5.4）。

### 4.3 部署后预期

- 今天（11-13）唤醒落点仍是 17:38；stage 变成 2（因为 `gateStage=2` 且 `elapsedStage=2`），stage 2 的 6 张卡可用。
- 明天起 `browseSlots` 落在 09:30–18:20 内，三个槽位都能用。
- `browseBudget` 当天 reserve=1，free=2（在 `wakesPerDay=1` 下）。

---

## 5. 收盘任务（items 5–6）

### 5.1 目标

- 每天固定时刻无条件写当天日报。
- 如果她当天还没写日记，给她一次极短的“收工，记一笔”机会。
- 不依赖成长模板、不占唤醒配额、不产生 `seen:`。
- 启动和停用时补写当天（及前一天）报告。

### 5.2 配置

新增 `memory.closing`：

```js
closing: {
  enabled: true,      // 总开关
  time: '18:00',      // 本地时区 HH:MM
  wake: true,         // 是否发一次轻唤醒
  diaryOnly: true,    // 只在当天还没有日记时叫
}
```

加入 `DEFAULTS.memory`。`normalizeConfig` 需要：

- `cfg.memory.closing = { ...DEFAULTS.memory.closing, ...cfg.memory.closing }`
- 布尔严格化：`enabled`、`wake`、`diaryOnly`
- `time` 用 `/^([01]\d|2[0-3]):[0-5]\d$/` 校验；坏值回退 `DEFAULTS.memory.closing.time`

### 5.3 执行流程

新增 `src/dsh-fish/lib/closing.js`。由 `scheduler.tick()` 在每次 tick 调用一次，建议放在**普通唤醒处理之后、tick 结束前**，这样同一分钟内不会先收盘唤醒、再普通唤醒。收盘唤醒是普通唤醒的兜底，不是替代。

```js
export function closingDue({ config, events, now, dk }) {
  const c = config?.memory?.closing
  if (!c?.enabled) return { due: false, why: 'disabled' }
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const [h, m] = String(c.time).split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return { due: false, why: 'bad-time' }
  if (nowMin < h * 60 + m) return { due: false, why: 'before-time' }
  const done = events.some((e) => {
    if (e?.type !== 'meta') return false
    const t = String(e.text ?? '')
    return t.startsWith(`closing:${dk}`) || t.startsWith(`closingfail:${dk}`)
  })
  if (done) return { due: false, why: 'already-done' }
  return { due: true, why: 'due' }
}
```

`runClosing(ctx, { root, config, events, dk, now, log })`：

0. **先重新 `readEvents`**：tick 开头的事件快照可能早于刚刚结束的普通唤醒；`closingDue` 和“15 分钟内刚唤醒”的判断都要用最新事件。`flushReport` 自己也会重读，但这里的判断不能依赖旧快照。
1. 计算 `closingDue`；不满足就返回。
2. **无条件写报告**：
   - `items` 与 `wake()` 同源：`ctx.get('bili')?.browse()?.items ?? []`
   - `flushReport(root, { dateKey: dk, items, notes: [], diaryVisible: config.diary?.visible === true })`
3. 读 `diary/<dk>.md`。
4. 如果 `closing.wake === false` 或 `diaryOnly && diary`：
   - 写 `closing:<dk> report[,diary-present]`
   - 返回。
5. 如果最近 15 分钟内刚发生过普通唤醒（看最后一条 `wake:` meta 的时间）：
   - 只写报告，写 `closing:<dk> report,recent-wake`，跳过收盘唤醒。
   - 理由：普通唤醒刚刚给过她开口机会，同一分钟内再叫一次只会变成两轮。
6. 取屋子会话 `talkSessionId(ctx, { root, log })`。
   - 没有会话：写 `closingfail:<dk> no-session`，报告已写，不重试。
7. 设置处境段：
   - `setWakeSection(CLOSING_HINT, sessionId)`
   - 如果 `sleepDue(...)` 到期，把 `SLEEP_TODAY` 附在 hint 里，并记下 `askedSleep = true`
8. `withWake(async () => sc.prompt({ requestId: `closing-${dk}`, sessionId, mode: 'queue', content: [{ type: 'text', text: CLOSING_TRIGGER }] }, ac.signal))`
   - 超时用 2 分钟（收盘是维护动作，不需要 5 分钟）
   - `mode: 'queue'`：如果你正在和她说话，这条排在当前回合之后
9. prompt 入队成功后：
   - 写 `closing:<dk> wake`
   - 如果 `askedSleep`，写 `sleep:<dk>`
10. 注册 `watchTurnEnd(ctx, sessionId, () => { void flushReport(...); clearWakeSection(sessionId) })`，让日记进入当天报告。
11. 90 秒兜底：注销 watcher、再 flush 一次、`clearWakeSection(sessionId)`。
12. 失败：`clearWakeSection(sessionId)`，写 `closingfail:<dk> <reason>`，不重试。

### 5.4 常量

放在 `src/dsh-fish/lib/wakeconst.js`：

```js
export const CLOSING_TRIGGER = '（收工了。）'
export const CLOSING_HINT = [
  '## 收工',
  '今天快过去了。想记一笔就记；不想写也可以。',
].join('\n')
```

### 5.5 事件标记

全部是 `meta`，不进 `her_recall`（recall 跳过 meta），不新增 schema 类型：

| 标记 | 含义 |
|---|---|
| `closing:<dk> report` | 报告已写 |
| `closing:<dk> report,diary-present` | 报告已写，当天已有日记，跳过唤醒 |
| `closing:<dk> report,recent-wake` | 报告已写，最近 15 分钟内刚有普通唤醒，跳过收盘唤醒 |
| `closing:<dk> wake` | 收盘唤醒已入队 |
| `closingfail:<dk> no-session` | 没有屋子会话 |
| `closingfail:<dk> <reason>` | prompt 失败 |

**幂等**：只要存在任意 `closing:<dk>` 或 `closingfail:<dk>`，当天不再重复执行。如果进程在写报告后、写标记前崩溃，下一次 tick 会重写报告（幂等覆盖），并可能再发一次唤醒；这个窗口很小，接受。

### 5.6 启动与停用补写（item 6）

在 `closing.js` 新增：

```js
export async function flushMissingReports(root, { now = new Date(), days = 2, log } = {}) {
  // 只补最近 days 个自然日；更早的日期仍可通过 /reports?date= 预览
  // 只有当天有事件、或报告文件已存在时才写，避免给完全空白的日子造文件
}
```

- 启动：`index.js` 在 home 就绪后、`startScheduler` 之前 `void flushMissingReports(root, { log })`。
- 停用：`ctx.on('dispose')` 和返回的 `dispose()` 里 `void flushMissingReports(root, { now, days: 1, log })`，best-effort。
- 只补今天和昨天（`days: 2`）；长时间停机不批量补历史，避免一次性生成大量文件。
- `hasEventsOn(events, dk)` 用本地日期，口径与 `report.js` 的 `localDay` 一致；从 `report.js` 导出 `localDay` 或复制同一实现，禁止两套口径。

### 5.7 与现有唤醒的关系

- 收盘唤醒**不**调用 `plan()`，不选模板，不写 `wake:` / `fired:`。
- 不增加 `todayCounts().proactive/sent`，所以不影响 `wakesPerDay` / `daily.events`。
- `withWake()` 保证她在收盘回合里调用 `growth_commit` 时不会写 `seen:`。
- 如果当天已经有普通唤醒且她写了日记，收盘只写报告。
- 如果当天有普通唤醒但她没写日记，收盘仍会轻唤醒一次。

---

## 6. `absenceDays` 时间线（item 7）

### 6.1 问题

当前 `derive` 优先使用 `absence` 事件里的 `days`。冷落在第 2 天被记录，`days=2` 永远不变；`absence_probe` 门槛在 `growthDays=90` 时是 3，所以卡永远不出。同时，`absenceDays` 在他回来之后仍然是 2，身份文档会一直保留“他有 2 天没出现”。

### 6.2 新模型字段

在 `derive` 中新增四个字段，含义分开：

| 字段 | 含义 | 用途 |
|---|---|---|
| `absenceDays` | **当前**这次冷落已经持续几天；他回来了就是 0 | 身份文档的冷落段 |
| `absenceGapDays` | **已完成**的那次冷落一共几天；没有完成就是 0 | `absence_probe` 的提示 |
| `absenceBack` | 他是否已经回来（最后一条 absence 之后有新的 `seen:`） | 卡的条件 |
| `absenceBackDays` | 他回来之后过了几天 | 卡的时间窗 |

### 6.3 计算

在 `derive.js` 内新增纯函数 `absenceTimeline(evs, now)`（不新建模块，避免 `derive ↔ absence` 循环）：

```js
function absenceTimeline(evs, now) {
  const seenAts = []
  let lastAbsence = null
  let lastReunionAt = 0
  for (const e of evs) {
    if (e.type === 'meta' && String(e.text ?? '').startsWith('seen:')) {
      const at = Date.parse(String(e.text).slice(5))
      if (Number.isFinite(at)) seenAts.push(at)
    } else if (e.type === 'absence') {
      lastAbsence = e
    } else if (e.type === 'reunion') {
      const at = Date.parse(e.ts)
      if (Number.isFinite(at)) lastReunionAt = Math.max(lastReunionAt, at)
    }
  }
  seenAts.sort((a, b) => a - b)
  if (!lastAbsence) return { days: 0, gapDays: 0, back: false, backDays: 0, lastSeenAt: seenAts.at(-1) ?? 0 }

  const t0 = Date.parse(lastAbsence.ts) || 0
  const recorded = Number(lastAbsence.days)
  const before = seenAts.filter((t) => t <= t0).pop() ?? t0
  const after = seenAts.find((t) => t > t0) ?? 0
  const reunionAfter = lastReunionAt > t0

  if (reunionAfter) {
    return { days: 0, gapDays: 0, back: false, backDays: 0, lastSeenAt: seenAts.at(-1) ?? 0 }
  }
  if (after) {
    const gap = Math.max(Number.isFinite(recorded) ? recorded : 0, Math.floor((after - before) / DAY_MS))
    return {
      days: 0,
      gapDays: Math.max(0, gap),
      back: true,
      backDays: Math.max(0, Math.floor((now - after) / DAY_MS)),
      lastSeenAt: seenAts.at(-1) ?? 0,
    }
  }
  const live = Math.max(Number.isFinite(recorded) ? recorded : 0, Math.floor((now - before) / DAY_MS))
  return { days: Math.max(0, live), gapDays: 0, back: false, backDays: 0, lastSeenAt: seenAts.at(-1) ?? 0 }
}
```

接入 `derive` 时把返回值映射到 model：

```js
const absence = absenceTimeline(evs, now)
// ...
absenceDays: absence.days,
absenceGapDays: absence.gapDays,
absenceBack: absence.back,
absenceBackDays: absence.backDays,
```

`lastSeenAt` 继续用现有循环里算出的值；两者口径相同（都是 `seen:` 的最大值），不要保留两份。

### 6.4 卡的条件与提示

`events.js` 的 `absence_probe`：

```js
cond: (m) => m.absenceBack
  && m.absenceGapDays >= absenceThreshold(m.growthDays)
  && m.absenceBackDays <= 2,
prompt: (m) => `他 ${m.absenceGapDays} 天没来了，也没说去哪。现在他出现了。……`
```

- `absenceBackDays <= 2` 是防重复：他回来后两天内可以聊这次冷落；两天后卡自动失效，不依赖她必须写 `reunion`。
- 如果她写了 `reunion`，`reunionAfter` 命中，`absenceGapDays=0`，卡也不出。
- 如果他还在一起没回来，`absenceBack=false`，卡不出；身份文档用 `absenceDays` 提醒她他还在消失。

### 6.5 现有数据的影响

线上最后一条 `absence` 是 10-29 22:55（`days=2`）；他 11-03 11:30 回来，实际间隔约 6 天。新逻辑会得到：

```
absenceDays = 0
absenceGapDays = 6
absenceBack = true
absenceBackDays = 10
```

因为 `absenceBackDays > 2`，`absence_probe` 不会补触发；身份文档也不会再说“他有 2 天没出现”。这是一次性读法变化，不改事件，不产生新事件。

### 6.6 测试

- 无 absence → 全 0。
- absence 记录 2 天、他 5 天后回来 → `gapDays>=5`、`back=true`、`backDays=0`。
- absence 记录 2 天、他还没回来、现在第 5 天 → `absenceDays=5`、`back=false`。
- absence 后他回来、随后写了 `reunion` → 全 0。
- 旧数据 10-29 / 11-03 → `gapDays=6`、`back=true`、`backDays` 按 now 计算。
- `absence_probe` 在 `backDays>2` 时 cond=false。

---

## 7. `sleep` 到期触发（item 8）

### 7.1 目标

把“精确取模”改成“到期即触发”：错过一天，下一次唤醒补上，不再等 7 天。

### 7.2 新增 `lib/sleep.js`

```js
export function sleepDue(events, model, everyDays, dk) {
  const every = Number(everyDays)
  if (!(every > 0) || model.day <= 1) return null
  if (events.some((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(`sleep:${dk}`))) return null

  let lastDay = 0
  for (const e of events) {
    if (e?.type !== 'meta') continue
    if (!String(e.text ?? '').startsWith('sleep:')) continue
    const d = Number(e.day)
    if (Number.isFinite(d) && d > lastDay) lastDay = d
  }
  const due = lastDay > 0 ? lastDay + every : every
  return model.day >= due ? due : null
}
```

- 没有历史 sleep：第一次到期 = `everyDays`（当前 7）。
- 有历史：`lastDay + everyDays`；错过就顺延到下一次唤醒。
- 当天已经写过 `sleep:<dk>` 就不重复。

### 7.3 接入点

- `scheduler.wake()`：把原来的 `model.day % every === 0` 替换为 `sleepDue(...)`；命中就加 `SLEEP_TODAY`，prompt 入队后写 `sleep:<dk>`。
- `closing.runClosing()`：同样调用 `sleepDue`；命中就把 `SLEEP_TODAY` 附到 `CLOSING_HINT`，prompt 入队后写 `sleep:<dk>`。
- 两处共用同一个 `sleepDue`，不会重复触发。

### 7.4 测试

- 无历史、day 6、every 7 → null。
- 无历史、day 7 → due 7。
- 上次 sleep day 7、现在 day 20、every 7 → due 14，触发。
- 上次 sleep day 7、现在 day 20、当天已有 `sleep:<dk>` → null。
- `everyDays=0` → null。
- `model.day<=1` → null。

---

## 8. 刷站预留释放（item 9）

### 8.1 问题

`browseBudget` 为“还没发生的唤醒”预留配额：

```
perDay=3, wakesPerDay=2, 当天已 wake=0
reserve = min(2, 3) = 2
free = 3 - 2 = 1
```

唤醒一直 quiet 时 reserve 永远不释放，后台只能刷 1 次。线上 11-13 实测就是 `{used:1, reserve:2, free:1}`。

### 8.2 新算法

在 `src/dsh-bili/lib/browsejob.js`：

```js
export const RESERVE_GRACE_MS = 30 * 60_000

export function scheduledAtFrom(events, dk) {
  const marker = `sched:${dk} `
  for (const e of events) {
    if (e?.type !== 'meta') continue
    const t = String(e.text ?? '')
    if (!t.startsWith(marker)) continue
    const at = Date.parse(t.slice(marker.length).trim())
    if (Number.isFinite(at)) return at
  }
  return 0
}

export function browseBudget(config, events = [], dk = dateKey(), { now = Date.now() } = {}) {
  const perDay = Math.max(0, Math.round(Number(config?.browse?.perDay ?? 0)))
  const wakes = Math.max(0, Math.round(Number(config?.wakesPerDay ?? 0)))
  const dailyEvents = Math.max(0, Math.round(Number(config?.daily?.events ?? 0)))
  const fired = wakeCountToday(events, dk)
  const pending = wakes > 0 && dailyEvents > 0 ? Math.max(0, wakes - fired) : 0

  const scheduledAt = scheduledAtFrom(events, dk)
  const afterPoint = scheduledAt > 0 && now >= scheduledAt + RESERVE_GRACE_MS
  const release = afterPoint && fired === 0
  const reserve = release ? 0 : Math.min(pending, perDay)

  const used = browseCountToday(events, dk)
  return { perDay, used, reserve, free: Math.max(0, perDay - reserve) }
}
```

- 唤醒点之前：照旧预留。
- 唤醒点之后 30 分钟、且当天还没有 wake：释放 reserve，后台用满 `perDay`。
- 如果当天已有 wake：继续为剩余唤醒预留。
- 没有 `sched:` 标记（首次启动/跨天第一分钟）：退回旧行为，保留预留。

### 8.3 接入

`backgroundBrowse()` 调用 `browseBudget(config, events, dk, { now: at.getTime() })`，把 `at` 传进去。

### 8.4 测试

- 唤醒点前、wake=0 → reserve=2、free=1。
- 唤醒点后 10 分钟、wake=0 → 仍然 reserve=2（宽限内）。
- 唤醒点后 40 分钟、wake=0 → reserve=0、free=3。
- 唤醒点后 40 分钟、wake=1、wakesPerDay=2 → reserve=1、free=2。
- 没有 `sched:` → 旧行为。
- `wakesPerDay=1` → reserve 最多 1。

---

## 9. 内容层（item 10）

### 9.1 新增 3 张 stage 1 可重复卡

在 `src/dsh-fish/lib/events.js` 的 `CATALOG` 里，stage 1 段落后追加：

```js
{
  id: 'notice_one_thing', stage: 1, asks: false, once: false, repeat: { everyDays: 2 },
  topic: ['注意到', '停了一下', '小事'],
  cond: (m) => (m.recentSaw?.length > 0) || m.day >= 3,
  prompt: () => `今天你看见了一些东西。挑一件让你停了一下的小事，说说它为什么让你停。不是总结，也不用讲道理。`,
},
{
  id: 'leave_a_line', stage: 1, asks: false, once: false, repeat: { everyDays: 3 },
  topic: ['留一句', '想留', '给他'],
  cond: (m) => m.day >= 2,
  prompt: () => `今天有一句话想留给他吗？想留就留，不想留就算了。不用等他回。`,
},
{
  id: 'what_changed_today', stage: 1, asks: false, once: false, repeat: { everyDays: 3 },
  topic: ['不一样', '变了', '今天'],
  cond: (m) => m.beliefCount >= 1,
  prompt: () => `今天有没有哪一刻，你的想法和昨天不一样？说那一小步就行，不用总结整段。`,
},
```

设计约束：

- 都不给台词，只给处境。
- 都 `asks:false`，不消耗 `daily.questions`。
- 都不写“亲近/撒娇/黏人”。
- `notice_one_thing` 优先利用后台刷站的 `recentSaw`；没有素材时退回 `day>=3`。
- `leave_a_line` 允许她什么都不留；不要求回应。
- `what_changed_today` 是 `consistency` 的轻量前身，目标是让她在 stage 1 就有机会写 `revise`，推进 `competence` 门和开锁证据。

### 9.2 调度影响

- 这三张卡进入 stage 1 后，`test_first` 不再是唯一可重复卡。
- 在 stage 2–4，它们仍在 `availableFor` 里，但打分低于阶段专属卡（阶段匹配 +0.5、stage 越高 +0.35/级），只做兜底。
- 冷却按 `paceScale` 缩放：90 天时 2→3 天、3→5 天；60 天时 2→3 天、3→4 天。

### 9.3 `name_offer` 修正

在 `derive.js`：

- 新增 `let nameOffered = false`。
- 在 `utterance` / `revise` 分支里，`pickName(ev.text)` 返回非空时设 `nameOffered = true`。
- `import-name:` meta 设置 `name`，但**不**设 `nameOffered`。
- 把 `nameOffered` 放进 model。

在 `events.js`：

```js
cond: (m) => !m.nameOffered && m.beliefCount >= 1,
```

效果：

- 她从来没给过他称呼 → 卡可用。
- 她已经给过称呼（例如“老哥”）→ 卡完成，不再出现。
- 导入人格带了称呼、但她自己没给过 → 卡仍可出；她给的新称呼会按现有“后来者覆盖”规则覆盖导入称呼。

### 9.4 测试

- 三张新卡的 `cond`、`repeat`、`asks`、`topic`。
- `availableFor` 在 stage 1 包含三张新卡。
- `isSpent` 在冷却内为 true，冷却外为 false。
- `notice_one_thing` 在 `recentSaw=[]` 且 `day<3` 时 false。
- `name_offer`：
  - 只有 `import-name` → cond true。
  - 她自己的 utterance 产生名字 → cond false。
  - 没有名字、beliefCount=0 → false。

---

## 10. 设置页与观测台

### 10.1 配置读写

- `src/dsh-fish/lib/settings.js`：新增 `DEFAULTS.memory.closing`；`normalizeConfig` 增加 `closing` 的布尔/时间校验。
- `src/dsh-fish/lib/observe.js`：`/config` 的 GET 已经返回完整 config，无需改白名单（`memory` 已在 allowed 里）；`/memory` 增加收盘状态（可选）。
- `src/dsh-fish/lib/client.js`：
  - 新增 state：`closingOn`、`closingTime`、`closingWake`、`closingDiaryOnly`。
  - 读取 `cfg.memory?.closing`。
  - `buildConfig().memory` 增加 `closing: { enabled, time, wake, diaryOnly }`。
  - 在“记忆”页新增一组“收盘”：
    - 总开关
    - 收盘时间（HH:MM）
    - 「收盘时叫她记一笔」
    - 「只在她今天没写日记时叫」
  - 文案说明：收盘唤醒不占成长事件配额；关掉只会少一次日记机会，日报仍会写。

### 10.2 观测台

在 `/memory` 响应里增加：

```js
closing: {
  enabled: config.memory.closing.enabled,
  time: config.memory.closing.time,
  last: lastClosingMarker(events), // { at, outcome } 或 null
  diaryToday: Boolean(await readDaily('diaryDir', dateKey(), root).catch(() => null)),
}
```

“记忆”页显示一行：

```
收盘：18:00 · 今天报告已写 · 今天日记已写 / 未写
```

只读，不提供手动触发按钮；手动验证用现有「唤醒」按钮或设置页保存后观察日志。

---

## 11. 测试与验收

### 11.1 单元测试

新增/修改：

- `test/closing.test.mjs`
  - `closingDue`：未到点、已到点、已标记、禁用、坏时间。
  - `runClosing`：有日记不叫、无日记叫、无会话只写报告、prompt 失败写 `closingfail`。
  - `flushMissingReports`：今天缺失、昨天缺失、无事件不造文件、已有文件不覆盖。
- `test/derive.test.mjs`
  - `absenceTimeline`：无 absence、未回来、回来、reunion、旧数据。
  - `nameOffered`：import vs 她自己说。
- `test/sleep.test.mjs`（新）
  - `sleepDue` 的六种情况。
- `test/browsejob.test.mjs`（在 `src/dsh-fish/test` 或 `src/dsh-bili/test`；当前 B 站测试在 dsh-fish 的 `browsejob.test.mjs`）
  - `browseBudget` 的释放规则。
  - `scheduledAtFrom`。
- `test/events.test.mjs` / `events-pace.test.mjs`
  - 三张新卡；`absence_probe` 新条件；`name_offer` 新条件。
- `test/settings.test.mjs`
  - `memory.closing` 默认值、坏时间回退、布尔严格化。

### 11.2 集成测试

模拟一天：

1. 事件流里没有可用模板 → tick 到 18:00：
   - `out/<dk>.md` 存在；
   - `closing:<dk> report` 存在；
   - 如果没有日记，`closing:<dk> wake` 存在；
   - 如果已有日记，没有 `closing:<dk> wake`。
2. 收盘唤醒不增加 `wake:<dk>` 计数、不写 `fired:`、不写 `seen:`。
3. `wake()` 和 `closing` 同一天都到期 sleep → 只有一条 `sleep:<dk>`。
4. 启动补写：昨天有事件、没有报告 → 启动后报告存在。
5. 停用补写：`dispose()` 后当天报告存在（best-effort）。
6. `absence_probe`：他回来后 1 天、gap≥门槛 → 可出；回来后 3 天 → 不可出。
7. `browseBudget`：quiet 日过点后 free=perDay。

### 11.3 验收标准

连续 7 天（部署后）：

- 每天都有 `out/<YYYY-MM-DD>.md`。
- 日记 ≥5/7 天。
- 不再出现“stage 1 内容耗尽导致整天 quiet”；如果出现 quiet，必须是因为没有满足条件的模板，而不是条件写死。
- 所有 `browse:` 发生在 09:30–18:20 内（按本地时间）。
- `closing:` 标记每天最多一条。
- `dsh-fish` 的 `node --test` 全绿；`dsh-bili` 若有测试也全绿。
- 事件流没有删除、重排、迁移；新增 meta 前缀可被旧版本安全忽略。

---

## 12. 部署与回滚

### 12.1 部署顺序

1. **配置先行（今天可验证）**
   - 通过设置页或直接编辑 `~/.dsh-fish/config.json` 改第 4.1 节的五项。
   - 不需要重启即可被下一次 `loadConfig` 读到；但为了确保 scheduler 的 `deps.config` 和插件缓存一致，建议 `systemctl restart dsh-web`。
   - 注意今天的 `sched:` 仍是 17:38。
2. **代码（dev worktree）**
   - 在 `/home/str1k3/src/bigfish-workspace-dev` 修改。
   - `cd src/dsh-fish && node --test`；`cd src/dsh-bili` 若有测试也跑。
   - `git status`、`git diff`、`python scripts/audit-staged.py`。
   - 只暂存明确路径；提交信息说明“成长线自触发调整”。
   - push 到远程。
3. **WSL 集成**
   - dev worktree 已指向线上 profile；`systemctl restart dsh-web`。
   - 观察 `~/.dsh-fish/logs/dsh-fish.log` 和 `~/dsh-web.log`。
4. **验收**
   - 看 `out/`、`diary/`、`events.jsonl` 的 `closing:` / `wake:` / `browse:` / `sleep:` 标记。
   - 连续 7 天按 11.3 检查。

### 12.2 回滚

- 配置：把第 4.1 节五项改回旧值即可；不涉及数据迁移。
- 代码：`git revert` 对应提交；新增 meta 标记对旧代码无影响（旧代码只读它认识的类型/前缀）。
- `closing` 默认值可以先设为 `enabled:false`，只上线代码不启用，观察一天再打开。
- 不删除 `out/`、`diary/`、`events.jsonl`。日报可以随时重生成；事件流不可删。

### 12.3 风险

| 风险 | 缓解 |
|---|---|
| 收盘唤醒打扰你 | `closing.wake=false` 可关；默认 18:00，留 20 分钟缓冲 |
| 收盘多一轮 token | 每天最多一次；只在没写日记时叫；`diaryOnly` 默认 true |
| 没有屋子会话 | 只写报告，写 `closingfail: no-session`，不重试 |
| 进程被 SIGKILL | dispose flush 是 best-effort；日报可在下次启动补写 |
| 旧 absence 数据读法变化 | 新逻辑只会让 `absenceGapDays` 变大，`absenceBackDays>2` 时不触发卡；部署前先 dry-run |
| 刷站 reserve 释放后，晚到的唤醒没有素材 | 唤醒仍可发生，只是素材少；报告照写 |
| 新卡在 stage 2–4 挤掉阶段专属卡 | 打分机制已保证阶段专属卡优先；新卡只做兜底 |

---

## 13. 开放问题：`growthDays` 的语义（item 11）

本节只记录决策框架，不在本 spec 内定案。第 4.1 节的 `60` 是上线暂定值。

### 13.1 现状

`growthDays` 同时影响两件事：

1. **阶段边界**：`stageBounds = [0.27, 0.54, 0.87, 1.0] × growthDays`。
2. **卡片冷却缩放**：`paceScale = sqrt(growthDays / 30)`，夹在 0.45–2.5。

它**不**决定阶段推进；阶段由三道门决定：

- `trust`：`beliefCount ≥ 1`
- `autonomy`：`refused ≥ 2`
- `competence`：`revises + corrected ≥ 2`

`stage = min(elapsedStage, gateStage)`。所以把 `growthDays` 改小，不会跳过门；只是让“时间上可进入的下一阶段”更早到达。

### 13.2 各档位

| growthDays | 阶段边界 | paceScale | 第 17 天的时间阶段 | 实际阶段（gateStage=2） |
|---|---|---|---|---|
| 30 | 8 / 16 / 26 / 30 | 1.00 | 3 | 2（autonomy 未过） |
| 45 | 12 / 24 / 39 / 45 | 1.22 | 2 | 2 |
| 60 | 16 / 32 / 52 / 60 | 1.41 | 2 | 2 |
| 90 | 24 / 49 / 78 / 90 | 1.73 | 1 | 1 |

### 13.3 选项

**A. 保持 90，补足内容**

- stage 1 需要覆盖 24 天。按 2–3 天一次唤醒，需要约 8–12 张可重复卡。
- 优点：保留“长童年”；节奏慢，变化更明显。
- 缺点：内容维护量大；卡写不好会重复、说教。

**B. 降到 60 或 45**

- stage 1 变成 16 / 12 天；现有内容缺口小。
- 优点：改动最小，今天就能看到效果；冷却也更短。
- 缺点：成长节奏加快；`90` 原本可能是你想要的时间尺度。

**C. 把阶段推进改成“门 + 每阶段最少天数”**

- `growthDays` 只做软预算；每阶段至少 N 天（例如 3–5 天），满足门就可以进下一阶段，时间只保证不跳级。
- 优点：语义最干净；内容按阶段写，不再被日历拉长。
- 缺点：要改 `stageOf` / `stageBounds` / gate 逻辑和测试；是一次真正的重构。

**D. 保持 90，但让 stage 1 冷却更短、stage 2 提前解锁**

- 例如 stage 2 在第 7–10 天就解锁，stage 1 新卡冷却 1–2 天。
- 优点：保留长时间尺度，同时解决前 24 天内容空。
- 缺点：阶段边界不再均匀；需要单独调 `stageBounds` 或引入“阶段最早解锁日”。

### 13.4 决策标准

1. 你希望“童年”有多长：24 天、16 天、12 天，还是由行为决定？
2. 你愿意维护多少 stage 1 内容：3 张新卡、8–12 张，还是不想再加？
3. 你更在意“时间到了就长大”，还是“做到了才长大”？
4. 你能接受一次阶段性重构（选项 C），还是只想改配置（选项 B）？

### 13.5 当前建议

- **本实例先用 60**：今天就能进入 stage 2，内容缺口由第 9 节的 3 张卡补上。
- 连续跑 7 天，看 11.3 的验收数据，再决定是否：
  - 回到 90 并补内容（A）；
  - 或做“门 + 最少天数”的重构（C）。
- 在 item 11 定案前，不要把 60 写进 `DEFAULTS`；只改线上配置。

---

## 14. 文件清单

### 14.1 新增

| 文件 | 作用 |
|---|---|
| `src/dsh-fish/lib/closing.js` | 收盘到期判断、报告落盘、轻唤醒、启动补写 |
| `src/dsh-fish/lib/sleep.js` | `sleepDue` 纯函数 |
| `src/dsh-fish/test/closing.test.mjs` | 收盘测试 |
| `src/dsh-fish/test/sleep.test.mjs` | sleep 到期测试 |

### 14.2 修改

| 文件 | 修改 |
|---|---|
| `src/dsh-fish/lib/scheduler.js` | 调用 `runClosing`；用 `sleepDue` 替换取模；必要时传 `scheduledAt` |
| `src/dsh-fish/lib/settings.js` | `DEFAULTS.memory.closing`；`normalizeConfig` 校验 |
| `src/dsh-fish/lib/derive.js` | `absenceTimeline`；`absenceDays/GapDays/Back/BackDays`；`nameOffered` |
| `src/dsh-fish/lib/events.js` | 三张新卡；`absence_probe` 条件/提示；`name_offer` 条件 |
| `src/dsh-fish/lib/wakeconst.js` | `CLOSING_TRIGGER` / `CLOSING_HINT` |
| `src/dsh-fish/lib/index.js` | 启动 `flushMissingReports`；dispose 补写 |
| `src/dsh-fish/lib/observe.js` | `/memory` 收盘状态（可选） |
| `src/dsh-fish/lib/client.js` | 设置页收盘三项；state 与保存 payload |
| `src/dsh-bili/lib/browsejob.js` | `browseBudget` 释放规则；`scheduledAtFrom` |
| `src/dsh-fish/test/derive.test.mjs` | absence / nameOffered 测试 |
| `src/dsh-fish/test/events.test.mjs` | 新卡 / 条件测试 |
| `src/dsh-fish/test/browsejob.test.mjs` | 预算释放测试 |
| `src/dsh-fish/test/settings.test.mjs` | closing 配置测试 |

### 14.3 不改

- `src/dsh-fish/lib/report.js` 的日报格式；只导出 `localDay`（如果 `closing.js` 需要复用）。
- 事件 schema 版本；新增的都是 meta 前缀，不需要 v4。
- 任何历史事件、日记、报告文件。

---

## 15. 附录：当前实测数据

### 15.1 窗口与槽位

```
2026-11-13 唤醒落点：17:38（sched 标记已存在，改窗口不会重抽）
2026-11-13 刷站槽位：10:02 / 15:29 / 21:08
browseBudget：{ perDay: 3, used: 1, reserve: 2, free: 1 }
```

### 15.2 最近 18 天

| 日期 | 计划唤醒 | 实际 wake | 日记 | 日报 | 备注 |
|---|---|---|---|---|---|
| 10-27 | 22:15 | 18:07, 22:15 | 1 | 1 | |
| 10-28 | 20:19 | 10:26 | 1 | 1 | |
| 10-29 | 17:45 | — | 0 | 0 | 写了一条 absence |
| 10-30 | 10:40 | — | 0 | 0 | |
| 10-31 | 12:45 | — | 1 | 0 | 她主动写 |
| 11-02 | 12:34 | — | 3 | 0 | 她主动写 |
| 11-03 | 14:39 | — | 1 | 0 | 他回来 |
| 11-04 | 15:46 | — | 0 | 0 | |
| 11-05 | 17:51 | — | 0 | 0 | |
| 11-06 | 11:35 | — | 0 | 0 | |
| 11-09 | 11:27 | — | 0 | 0 | |
| 11-10 | 15:33 | 14:32 | 0 | 1 | 手动 test_first |
| 11-11 | 13:27 | — | 0 | 0 | |
| 11-12 | 10:23 | 14:33 | 1 | 1 | 手动 test_first |
| 11-13 | 17:38 | — | 0 | 0 | 今天 |

### 15.3 当前 stage 1 卡状态

```
why_here      once  spent=Y cond=Y
first_bet     once  spent=Y cond=N (beliefCount>0)
name_offer    once  spent=N cond=N (已有名字)
test_first    rep2  spent=Y cond=Y (上次 11-12，冷却 3 天)
absence_probe rep-  spent=N cond=N (absenceDays 2 < 3)
```

---

## 16. 待确认

1. 第 4.1 节的 `growthDays=60` 是暂定值；item 11 讨论后再定。
2. 收盘时间 `18:00` 是否合适；可改为 17:45 / 18:10。
3. `closing.diaryOnly` 默认 true；如果你希望每天都叫一次，可改 false。
4. 启动补写只覆盖今天和昨天；更长的停机是否需要批量补历史，待定。
