# 桌宠边界、工头人话汇报与自然语言工作入口

- 日期：2026-11-24
- 状态：方向已确认，待实现
- 范围：桌宠事件边界、工头汇报来源、陪伴会话的工作处境、工具描述
- 不做：桌宠工作状态视觉（后续桌宠事件设计）、P2 worker 事件查询、P3 工作头子/Agent Teams、按屏幕 OCR 映射 agent

## 1. 要解决什么

用户希望：

1. 桌宠就是桌宠，不显示工头/worker 的工作内容。
2. 工头不能把 worker 的结构化结果直接透传；给用户的必须是工头自己说的人话汇报。
3. 用户不会点名工具，而会说“帮我看下屏幕上那两个 agent 做完没有，有什么可以进一步推进的”。她要从内部工作状态回答，而不是靠 OCR 猜屏幕。

## 2. 决策

- **桌宠边界**：`PET_SURFACES` 只保留 `web` / `screen`；工头 `work` 会话的 assistant 消息不再进入桌宠气泡或活动。工作状态视觉留到后续桌宠事件设计，本轮不做。
- **汇报来源**：`work-sessions.json` 新增 `bossSummary`，在工头 `turn/end` 时从她最后一条 assistant 消息写入。`her_work_status` 和微信只读 `bossSummary`；worker 的 `summary` / `report` 只留在 `work-units.json` 供工头复查，不再作为用户可见汇报。旧记录里的 `lastSummary` 不向用户展示。
- **工头回述**：`her_worker_control.get` 不再返回原始 `report`，改返回由 report 压成的一段人话（摘要、动了几个文件、验证几项、卡在哪）。
- **陪伴处境**：screen 面存在工作会话时，system prompt 增加 `fish:work` 段：目录、worker 标签/状态、最近一次工头汇报。没有工作会话时返回空串。该段只给陪伴会话，不给桌宠 UI。
- **自然语言入口**：不新增工具；改 `her_work` / `her_work_status` / `her_worker` / `her_worker_control` 的描述为场景句，并在 `fish:work` 段里明确“用户说那两个 agent 时先用 her_work_status，不要靠 OCR 猜名字”。
- `look_screen` 保留为可选确认，不作为 agent 身份/状态的真相源。

## 3. 方案与取舍

- **A. 最小改造（选定）**：保留现有 `work` 面和工具，只切桌宠事件、换汇报来源、加 `fish:work` 处境、改描述。改动集中在 `pet-view.js`、`index.js`、`work.js`、`identity.js`、测试与 CHANGELOG。风险低，能直接支持用户的自然语言问法。
- **B. 工作独立前台**：把工作从陪伴会话彻底拆到独立工作 UI/会话，桌宠只回答“在忙/做完了”。边界最干净，但用户失去“在桌宠里直接问”的顺手；留到桌宠事件设计时再评估。
- **C. 屏幕 OCR 映射 agent**：用 `look_screen` 读 DSH UI 再映射 WorkUnit。不可靠、依赖 UI 布局，否决。

## 4. 数据与文案

`work-sessions.json` 记录新增：

```jsonc
{
  "bossSummary": "人话汇报，≤2000 字，来自工头 assistant 文本",
  "lastSummary": "旧字段，保留读取兼容，不再作为用户可见汇报"
}
```

`fish:work` 段示例（只给 screen 面）：

```text
## 手边的工作

目录：/home/str1k3/src/proj
worker：补测试（做完了）、查日志（在做）
最近汇报：两个都跑过一遍，测试补上了，日志那边还在等构建。
用户问“那两个 agent”或“做得怎么样”时，先用 her_work_status 看这里的状态，不要靠屏幕 OCR 猜名字。
```

`her_work_status` 返回新增 `workers: [{ label, mode, status }]`，不返回 worker 的 summary/report。

## 5. 验收

1. 桌宠不再出现工头/worker 的文字；`petSurfaceAllowed('work') === false`。
2. 工头结算后，`her_work_status` 不显示 worker 原文；工头 turn/end 后显示她最后说的人话。
3. `her_worker_control get` 不返回 `report` JSON，只返回人话回述。
4. 陪伴会话存在工作会话时，system prompt 有 `fish:work` 段，含目录、worker 标签/状态、最近汇报；没有工作时不出现。
5. 真机用“帮我看下屏幕上那两个 agent 做完工作了吗？有什么工作你可以进一步让他们推进的”验证：她能查内部状态并给出人话回答；必要时用 `look_screen` 确认。
