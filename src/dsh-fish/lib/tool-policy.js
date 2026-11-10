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
 * 纯模块：零依赖，不 import 插件内任何其他文件。
 */

/** 动作语义。只用于分类和测试，不替代权限检查。 */
export const KINDS = Object.freeze(['read', 'write', 'send', 'navigate', 'maintain', 'discover'])

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

/** bili 面只有 3 个对话工具，第一版全部常驻，不设 deferred。 */
function biliAlways() {
  const s = 'bili'
  return [
    tool('bili_look', s, ALWAYS, '', '看 B 站列表', 'read'),
    tool('bili_watch', s, ALWAYS, '', '看一条视频的画面', 'read'),
    tool('bili_speak', s, ALWAYS, '', '在评论区说话', 'send', [], 'send'),
  ]
}

/**
 * 策略表。一个工具只有一个 surface；deferred 一定有 group；
 * always 的 group 为空串（`groupsFor` 会跳过）。
 */
export const POLICY = Object.freeze([
  ...coreEntries('web'),

  ...coreEntries('wx'),
  ...wxAlways(),
  ...wxDeferred(),

  ...coreEntries('qq'),
  ...qqDeferred(),

  ...coreEntries('bili'),
  ...biliAlways(),
])

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
  return POLICY
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
  return POLICY
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

/** 当前面的 deferred 组（去重，保持策略表顺序；always 的空组不算）。 */
export function groupsFor(surface) {
  const out = []
  for (const e of POLICY) {
    if (e.surface === surface && e.group !== '' && !out.includes(e.group)) out.push(e.group)
  }
  return out
}

/** 当前面的全部策略条目（always + deferred），顺序同 POLICY。 */
export function entriesFor(surface) {
  return POLICY.filter((e) => e.surface === surface)
}

/** 按名字和面查一条策略；别的面的同名工具不算，找不到返回 null。 */
export function describeEntry(name, surface) {
  return POLICY.find((e) => e.name === name && e.surface === surface) ?? null
}
