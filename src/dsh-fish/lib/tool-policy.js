/**
 * tool-policy.js —— 工具可见性的唯一来源（2026-11-09）
 *
 * 这里只回答一件事：**在某个面上，她此刻能看见哪些工具。**
 *
 * 三档可见性：
 *   - always：常驻当前面，每一步都能直接选；
 *   - deferred：不常驻，只在 catalog 里可发现，`her_tools load` 之后才出现；
 *   - hidden：策略表里根本没有这个名字（宿主工具、别的面的工具、未注册名字）。
 *
 * `hidden` 不是第三档 tier，而是“不在这张表里”。本表只引用工具名，不注册、
 * 不执行、不授权：always/deferred 只影响看不看得见，发送闸、频率、permit、
 * 黑名单和 guard 仍在各自的代码里原样执行。策略表**只能收窄**可见性。
 *
 * 宿主工具（shell、读写文件、子代理、技能、工作流、MCP）永远不写进这张表；
 * `read_image` 是唯一例外——它是宿主能力，只给用图的面，且需要图片路由。
 *
 * ## 内置表 + 贡献表（2026-11-10 A1.4）
 *
 * 内置表 `BUILTIN` 是插件启动时就确定的部分：web/wx/qq/bili 四个面的 core
 * 记忆工具，加上 wx/qq 自己注册的常驻与低频工具。它不可变。
 *
 * 别的插件（从 A2 起是 dsh-bili）通过 `contribute()` 往表里加自己的工具。
 * 所有读入口（`resolveAllow` / `catalog` / `loadTargets` / `groupsFor` /
 * `entriesFor` / `describeEntry`）都读同一份**合并视图**：内置表在前，贡献
 * 条目按贡献顺序在后。贡献只影响下一次调用，不重算、不回写已经下发的 allow。
 *
 * ## 校验是整次拒绝
 *
 * `contribute()` 先校验整份 payload（id、面、每条工具的形状、名字冲突、宿主
 * 是否真的注册过这些名字），任何一项不过就整次拒绝，视图**一点不变**。不会
 * 出现“三个名字进去了两个”的半截状态。
 *
 * ## 晚贡献
 *
 * 贡献必须在该面的第一个 agent 创建之前完成。`setAgentProbe()` 让本模块能问
 * “这个面是不是已经有会话了”；如果是，晚到的贡献返回
 * `{ ok:false, why:'LATE_CONTRIBUTION', pending:true }`，不假装已生效。唯一
 * 例外是同一个 id 带着完全相同的名字集合重复贡献——那是幂等重试，直接成功。
 *
 * 纯模块：零依赖，不 import 插件内任何其他文件。
 */

/** 动作语义。只用于分类和测试，不替代权限检查。 */
export const KINDS = Object.freeze(['read', 'write', 'send', 'navigate', 'maintain', 'discover'])

/** 策略表认的面。贡献只能落在这些面里。 */
export const SURFACES = Object.freeze(['web', 'wx', 'qq', 'bili'])

/**
 * 本插件自己注册（内置表里归 dsh-fish 所有）的 7 个工具名。
 * wx/qq 的工具由别的插件注册，不算在内；B 站 3 个从 A1.4 起改为贡献条目。
 */
export const OWN_TOOL_NAMES = Object.freeze([
  'growth_commit',
  'her_recall',
  'her_leave',
  'her_remind',
  'her_reminders',
  'her_remind_cancel',
  'her_inbox',
])

const ALWAYS = 'always'
const DEFERRED = 'deferred'

/**
 * 构造一条策略。`requires` 是能力谓词（不是面 id）：解析时要求 caps 里严格为 true。
 * `safety` 只给发送类标注，方便测试和审计；它本身不是权限。
 */
function tool(name, surface, tier, group, summary, kind, requires = [], safety) {
  const entry = {
    name,
    surface,
    tier,
    group,
    summary,
    kind,
    requires: Object.freeze([...requires]),
  }
  if (safety) entry.safety = safety
  return Object.freeze(entry)
}

/** core 记忆工具 + read_image：四个面都常驻，各一条。 */
function coreEntries(surface) {
  return [
    tool('growth_commit', surface, ALWAYS, '', '记下自己的想法和判断', 'write'),
    tool('her_recall', surface, ALWAYS, '', '翻自己的旧事和记忆', 'read'),
    tool('her_leave', surface, ALWAYS, '', '留一句话给那个人', 'write'),
    tool('her_tools', surface, ALWAYS, '', '查看并打开当前面更多工具', 'discover'),
    tool('read_image', surface, ALWAYS, '', '看一张图', 'read', ['hasImageRoute']),
  ]
}

/** wx 面的常用动作（除 core/read_image 外的 9 个常驻）。 */
function wxAlways() {
  const s = 'wx'
  return [
    tool('wx_peek', s, ALWAYS, '', '看微信里有没有新消息', 'read'),
    tool('wx_send', s, ALWAYS, '', '在微信里说一句话', 'send', [], 'send'),
    tool('wx_context', s, ALWAYS, '', '看一段微信对话的上下文', 'read'),
    tool('wx_task_done', s, ALWAYS, '', '把一条微信任务标成完成', 'write'),
    tool('wx_task_snooze', s, ALWAYS, '', '把一条微信任务往后推', 'write'),
    tool('her_inbox', s, ALWAYS, '', '看微信里还没回完的任务', 'read'),
    tool('her_remind', s, ALWAYS, '', '定一条微信定时提醒', 'write'),
    tool('her_reminders', s, ALWAYS, '', '看还没到点的提醒', 'read'),
    tool('her_remind_cancel', s, ALWAYS, '', '取消一条提醒', 'write'),
  ]
}

/** wx 面的低频组：界面原语、表情维护、历史查询。 */
function wxDeferred() {
  const s = 'wx'
  return [
    // wx.ui —— 操作界面的原语，全部需要 GUI；wx_ocr 还需要 OCR。
    tool('wx_see', s, DEFERRED, 'wx.ui', '看屏幕', 'navigate', ['hasGui']),
    tool('wx_click', s, DEFERRED, 'wx.ui', '点一下', 'navigate', ['hasGui']),
    tool('wx_type', s, DEFERRED, 'wx.ui', '输入文字', 'navigate', ['hasGui']),
    tool('wx_key', s, DEFERRED, 'wx.ui', '按一个键', 'navigate', ['hasGui']),
    tool('wx_ocr', s, DEFERRED, 'wx.ui', '读屏幕上的文字', 'read', ['hasGui', 'hasOcr']),

    // wx.stickers —— 表情收藏的读取、维护与发送。
    tool('wx_sticker_scan', s, DEFERRED, 'wx.stickers', '扫一遍表情收藏', 'maintain'),
    tool('wx_sticker_list', s, DEFERRED, 'wx.stickers', '看表情收藏里有什么', 'read'),
    tool('wx_sticker_find', s, DEFERRED, 'wx.stickers', '按条件找一张表情', 'read'),
    tool('wx_sticker_tag', s, DEFERRED, 'wx.stickers', '给表情打标签', 'maintain'),
    tool('wx_sticker_send', s, DEFERRED, 'wx.stickers', '发一个表情', 'send', [], 'send'),
    tool('wx_sticker_collect', s, DEFERRED, 'wx.stickers', '收藏一个表情', 'maintain'),
    tool('wx_sticker_search', s, DEFERRED, 'wx.stickers', '搜表情', 'read'),

    // wx.history —— 翻更早的记录。
    tool('wx_history', s, DEFERRED, 'wx.history', '翻更早的微信记录', 'read'),
  ]
}

/** qq 面只有 core/read_image 常驻，其余全部按需打开。 */
function qqDeferred() {
  const s = 'qq'
  return [
    tool('qq_send_image', s, DEFERRED, 'qq.media', '发一张图', 'send', [], 'send'),
    tool('qq_send_voice', s, DEFERRED, 'qq.media', '发一条语音', 'send', [], 'send'),
    tool('qq_send_video', s, DEFERRED, 'qq.media', '发一段视频', 'send', [], 'send'),
    tool('qq_send_file', s, DEFERRED, 'qq.media', '发一个文件', 'send', [], 'send'),
    tool('qq_send_forward', s, DEFERRED, 'qq.media', '转发一条消息', 'send', [], 'send'),
    tool('qq_napcat_api', s, DEFERRED, 'qq.api', '调用 NapCat 机器接口', 'maintain'),
    tool('qq_group_history', s, DEFERRED, 'qq.history', '看群聊历史', 'read'),
  ]
}

/**
 * 内置表。一个工具只有一个 surface；deferred 一定有 group；
 * always 的 group 为空串（`groupsFor` 会跳过）。
 *
 * 注意：这里**没有** bili 的对话工具。B 站 3 个工具从 A1.4 起由贡献方
 * （本任务的 index.js，A2 起是 dsh-bili）在首个 bili agent 创建之前贡献进来；
 * 贡献缺席时 bili 面只剩 coreEntries，和 web 面同构。
 */
const BUILTIN = Object.freeze([
  ...coreEntries('web'),

  ...coreEntries('wx'),
  ...wxAlways(),
  ...wxDeferred(),

  ...coreEntries('qq'),
  ...qqDeferred(),

  ...coreEntries('bili'),
])

// ---------------------------------------------------------------------------
// 贡献表：模块级单例。
//
// 为什么是模块级：tool-policy 是“当前进程里策略表长什么样”的唯一来源，策略
// 解析随时会从任意模块被调用（restrict / her_tools / 观测台），没有一个大家都
// 拿得到的 ctx。同一进程里也只会有一份策略表。
// ---------------------------------------------------------------------------

/** id -> { id, surface, entries, groups, revoke }，Map 保留贡献顺序。 */
const contributions = new Map()

/** 默认不做晚贡献探测（老宿主 / 单测里没有 agent 生命周期）。 */
let agentProbe = () => false

/** 默认拿不到宿主全局名单（贡献方必须自己给 hostNames）。 */
let hostNamesProvider = () => null

/** 合并视图：内置表在前，贡献条目按贡献顺序在后。每次都现拼。 */
function mergedView() {
  const out = [...BUILTIN]
  for (const rec of contributions.values()) out.push(...rec.entries)
  return out
}

function badTool(index, field) {
  return { ok: false, why: 'BAD_TOOL', detail: `tools[${index}].${field}` }
}

/** 把 Set / 数组 / 其它可迭代对象归一成 Set；null / 不可迭代 → null。 */
function toNameSet(value) {
  if (value == null) return null
  try {
    if (typeof value === 'string') return new Set([value])
    if (typeof value[Symbol.iterator] !== 'function') return null
    return new Set([...value].map((n) => String(n)))
  } catch {
    return null
  }
}

function providerNames() {
  try {
    return hostNamesProvider?.() ?? null
  } catch {
    return null
  }
}

function probeSaysLate(surface) {
  try {
    return agentProbe?.(surface) === true
  } catch {
    return false
  }
}

function sameNames(entries, nextEntries) {
  if (entries.length !== nextEntries.length) return false
  const a = new Set(entries.map((e) => e.name))
  return nextEntries.every((e) => a.has(e.name))
}

/**
 * 贡献一批工具到策略表。
 *
 * 整次校验、整次生效或整次拒绝：
 *   - `id` 非空字符串，否则 `BAD_ID`；
 *   - `surface` 必须在 SURFACES 里，否则 `BAD_SURFACE`；
 *   - `tools` 非空数组，每条形状合格（deferred 必须有 group），否则 `BAD_TOOL`；
 *   - 名字不能与同一 payload、内置表、别的 id 的贡献重名，否则 `NAME_TAKEN`；
 *     同 id 的重复贡献是替换，不算冲突；
 *   - 名字必须在宿主真实注册过的集合里，否则 `NOT_REGISTERED`。
 *     有效集合 = `opts.hostNames` 与 `setHostNamesProvider()` 的交集；只给了一个
 *     就只用那一个；两个都没有 → `HOST_NAMES_UNKNOWN`；
 *   - 该面已经有 agent 时晚贡献 → `LATE_CONTRIBUTION`（幂等重试除外）。
 *
 * 成功返回 `{ ok:true, off }`；`off()` 撤销这个 id 的贡献，可重复调用。同 id
 * 重复贡献时旧条目的 `off()` 变成空操作（以最后一次为准）。
 *
 * @param {{ id: string, tools: Array<{name,summary,tier,kind,group?,requires?,safety?}>, groups?: string[] }} def
 * @param {{ hostNames?: Iterable<string>|null, surface?: string }} [opts]
 * @returns {{ ok: true, off: () => void } | { ok: false, why: string, detail?: string, pending?: boolean }}
 */
export function contribute(def, { hostNames = null, surface = 'bili' } = {}) {
  const id = def?.id
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, why: 'BAD_ID' }
  if (!SURFACES.includes(surface)) return { ok: false, why: 'BAD_SURFACE', detail: String(surface) }

  const tools = def?.tools
  if (!Array.isArray(tools) || tools.length === 0) {
    return { ok: false, why: 'BAD_TOOL', detail: 'tools 必须是非空数组' }
  }

  const entries = []
  const names = new Set()
  for (let i = 0; i < tools.length; i += 1) {
    const t = tools[i] ?? {}
    if (typeof t.name !== 'string' || t.name.trim() === '') return badTool(i, 'name')
    if (t.tier !== ALWAYS && t.tier !== DEFERRED) return badTool(i, 'tier')
    if (!KINDS.includes(t.kind)) return badTool(i, 'kind')
    if (typeof t.summary !== 'string') return badTool(i, 'summary')
    if (t.requires !== undefined && !Array.isArray(t.requires)) return badTool(i, 'requires')
    if (t.safety !== undefined && typeof t.safety !== 'string') return badTool(i, 'safety')
    if (t.tier === DEFERRED && (typeof t.group !== 'string' || t.group.trim() === '')) {
      return badTool(i, 'group')
    }
    // always 的 group 归一成空串：groupsFor 只认 deferred 的组。
    const group = t.tier === DEFERRED ? t.group : ''
    if (names.has(t.name)) return { ok: false, why: 'NAME_TAKEN', detail: t.name }
    names.add(t.name)
    entries.push(tool(t.name, surface, t.tier, group, t.summary, t.kind, t.requires ?? [], t.safety))
  }

  // 与内置表重名（任何面）
  const builtinNames = new Set(BUILTIN.map((e) => e.name))
  for (const n of names) {
    if (builtinNames.has(n)) return { ok: false, why: 'NAME_TAKEN', detail: n }
  }
  // 与别的 id 的贡献重名；同 id 是替换，跳过自己
  for (const [otherId, rec] of contributions) {
    if (otherId === id) continue
    for (const e of rec.entries) {
      if (names.has(e.name)) return { ok: false, why: 'NAME_TAKEN', detail: e.name }
    }
  }

  // 宿主名字校验：两个来源求交集；只给一个就只用那一个。
  const given = toNameSet(hostNames)
  const provided = toNameSet(providerNames())
  let effective = null
  if (given && provided) effective = new Set([...given].filter((n) => provided.has(n)))
  else effective = given ?? provided
  if (!effective) return { ok: false, why: 'HOST_NAMES_UNKNOWN' }
  for (const n of names) {
    if (!effective.has(n)) return { ok: false, why: 'NOT_REGISTERED', detail: n }
  }

  // 晚贡献：该面已经有 agent 了。同 id 同名字集合的重复贡献按幂等成功处理，
  // 视图一点不动；其余一律拒绝，让调用方知道要重建会话。
  const existing = contributions.get(id)
  if (probeSaysLate(surface)) {
    if (existing && existing.surface === surface && sameNames(existing.entries, entries)) {
      return { ok: true, off: existing.revoke }
    }
    return { ok: false, why: 'LATE_CONTRIBUTION', pending: true }
  }

  const groups = Object.freeze(
    (Array.isArray(def?.groups) ? def.groups : []).map((g) => String(g)).filter(Boolean),
  )

  const record = { id, surface, entries: Object.freeze(entries), groups, revoke: null }
  let live = true
  record.revoke = () => {
    if (!live) return
    live = false
    // 已被同 id 的后来者替换时什么都不做——以最后一次为准。
    if (contributions.get(id) === record) contributions.delete(id)
  }
  contributions.set(id, record)

  return { ok: true, off: record.revoke }
}

/** 本插件内置的自有工具名 + 当前全部贡献名，按出现顺序去重。 */
export function ownTools() {
  const out = []
  const seen = new Set()
  for (const n of OWN_TOOL_NAMES) {
    if (!seen.has(n)) { seen.add(n); out.push(n) }
  }
  for (const rec of contributions.values()) {
    for (const e of rec.entries) {
      if (!seen.has(e.name)) { seen.add(e.name); out.push(e.name) }
    }
  }
  return out
}

/** 当前策略贡献的快照（观测 / 测试用）。 */
export function status() {
  return {
    surfaces: [...SURFACES],
    contributions: [...contributions.values()].map((rec) => ({
      id: rec.id,
      surface: rec.surface,
      names: rec.entries.map((e) => e.name),
      groups: [...rec.groups],
    })),
  }
}

/**
 * 安装“这个面是不是已经有 agent 了”的探针。默认永远返回 false。
 * 传 null / 非函数即复位成默认。
 * @param {((surfaceId: string) => boolean) | null} fn
 */
export function setAgentProbe(fn) {
  agentProbe = typeof fn === 'function' ? fn : () => false
}

/**
 * 安装“宿主全局认得的工具名”的提供者。默认返回 null（贡献方必须自己给）。
 * 传 null / 非函数即复位成默认。
 * @param {(() => Iterable<string>|null) | null} fn
 */
export function setHostNamesProvider(fn) {
  hostNamesProvider = typeof fn === 'function' ? fn : () => null
}

/** 能力谓词：caps 里必须严格为 true。 */
function capsOk(entry, caps) {
  return entry.requires.every((c) => caps[c] === true)
}

/** 宿主真的注册了这个名字才显示；hostNames 为 null 表示不做这层过滤。 */
function hostOk(entry, hostNames) {
  return !hostNames || hostNames.has(entry.name)
}

function isVisible(entry, revealed) {
  return entry.tier === ALWAYS || revealed.has(entry.name) || (entry.group !== '' && revealed.has(entry.group))
}

/**
 * 解析当前面此刻的可见集合。
 *
 * 顺序（与设计 §6.3 一致）：
 *   surface 过滤 → always || revealed(name/group) → requires 全部满足 → 宿主已注册。
 *
 * @param {{ surface: string, caps?: object, revealed?: Set<string>, hostNames?: Set<string>|null }} opts
 * @returns {string[]} 可见工具名
 */
export function resolveAllow({ surface, caps = {}, revealed = new Set(), hostNames = null } = {}) {
  return mergedView()
    .filter((e) => e.surface === surface)
    .filter((e) => isVisible(e, revealed))
    .filter((e) => capsOk(e, caps))
    .filter((e) => hostOk(e, hostNames))
    .map((e) => e.name)
}

/**
 * 当前面可发现的 deferred 工具（给 her_tools 的目录用）。
 * 只列本面、只列宿主已注册且能力满足的条目；宿主工具和别的面永不出现。
 */
export function catalog({ surface, caps = {}, hostNames = null } = {}) {
  return mergedView()
    .filter((e) => e.surface === surface && e.tier === DEFERRED)
    .filter((e) => capsOk(e, caps))
    .filter((e) => hostOk(e, hostNames))
}

/**
 * 把 `her_tools load` 的入参解析成当前面真正能打开的 deferred 工具名。
 *
 * `group` 与 `names` 二选一（group 优先）；只认 catalog 里的组/名字。
 * 任何未知、跨面、未注册、能力不满足的目标都整体拒绝，返回
 * `{ ok:false, names:[], why:'这条路上打不开' }`，不改变任何状态。
 */
export function loadTargets({ surface, caps = {}, hostNames = null, group = '', names = [] } = {}) {
  const cat = catalog({ surface, caps, hostNames })

  if (group) {
    const hit = cat.filter((e) => e.group === group)
    if (hit.length === 0) return loadFailed(group)
    return { ok: true, names: hit.map((e) => e.name), group, why: '' }
  }

  const wanted = Array.isArray(names) ? names : []
  if (wanted.length === 0) return loadFailed('')

  const available = new Set(cat.map((e) => e.name))
  if (!wanted.every((n) => available.has(n))) return loadFailed('')

  return { ok: true, names: [...new Set(wanted)], group: '', why: '' }
}

function loadFailed(group) {
  return { ok: false, names: [], group, why: '这条路上打不开' }
}

/** 当前面的 deferred 组（去重，保持合并视图顺序；always 的空组不算）。 */
export function groupsFor(surface) {
  const out = []
  for (const e of mergedView()) {
    if (e.surface === surface && e.group !== '' && !out.includes(e.group)) out.push(e.group)
  }
  return out
}

/** 当前面的全部策略条目（always + deferred），顺序同合并视图。 */
export function entriesFor(surface) {
  return mergedView().filter((e) => e.surface === surface)
}

/** 按名字和面查一条策略；别的面的同名工具不算，找不到返回 null。 */
export function describeEntry(name, surface) {
  return mergedView().find((e) => e.name === name && e.surface === surface) ?? null
}
