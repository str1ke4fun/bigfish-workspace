/**
 * schema.js —— 事件流的类型定义、校验与 id 生成
 *
 * 铁律（对应 B-技术契约 §2 与 §6）：
 *   1. 这里**不存在** affinity / score / level / personality 任何字面量。
 *      新增字段前必须回答：它是否让 N1–N4 的某一条变弱？变弱则拒绝。
 *   2. 事件只能"新增"，不能改写。改写 = 追加一条 revise。
 *   3. 任何来自她的写入都必须过 validateEvent()，不信任入参。
 */

import { parseRefusal } from './refuse.js'

/** 允许她提交的类型（工具白名单）。系统侧另有两个 meta/answer 不开放给她。 */
export const HER_TYPES = Object.freeze(['utterance', 'revise', 'reunion', 'narration', 'refusal', 'person_note'])

/** 全量类型表（含系统侧） */
export const ALL_TYPES = Object.freeze([
  'seed', 'utterance', 'answer', 'test', 'revise',
  'absence', 'reunion', 'refusal', 'narration', 'meta', 'diary',
  // 评论区里别人的话（2026-10-24，用户 m02454）：她读到过一句陌生人的话。
  // **不是她的判断**——不进 beliefs；只有她后来自己也说出口，那条 utterance 才算数。
  // 系统侧写（不在 HER_TYPES 里，她编不出来一条"别人说"）。
  'voice',
  // R3（2026-10-24）：她自己提出「我能不能改一条规矩」→ 由主人裁决。
  // 两种都只能宿主写，她写不了（不在 HER_TYPES 里）。
  'grant_offer', 'grant',
  // 后台刷站（2026-11-03，用户「让大肥鱼有自己的记忆和认知」）：
  // 一条 = 她真的看过的一条视频（标题/UP/标签/简介，已过 guard.sanitizeForeign）。
  // 系统侧写，她编不出来；不是她的判断，不进 beliefs，但 her_recall 翻得到，
  // 身份文档里也摆最近几条。这样她不在被叫醒的时候，也有一段"我今天看见过什么"。
  'saw',
  // v3（2026-11-10）：别人在 B 站回复了她的评论（返回值已过 sanitizeForeign）。
  // 系统侧写（不在 HER_TYPES 里），带结构化 reply 子对象，按 reply.rpid 去重。
  // 不进 beliefs；只进 derive.facts.biliReplies，工作台与 B 站面用它列「待回复」。
  'bili_reply',
  // v4（2026-11-13）：她对一个人的认知（身份/印象/互动）。
  // 她可以写（在 HER_TYPES 里）；不是 belief，不进 beliefs/facts/成长门/日报引用。
  // 归属看 person.channel + person.chatId，事件顶层 channel 只表示她当时在哪写的。
  'person_note',
])

/**
 * 事件来源面（v3）。与 `channel` 分工：
 *   channel —— 隐私与召回边界（core / wx / qq / web），老事件已有；
 *   surface —— 来源与展示位置（多了 bili），回答「这件事发生在哪」。
 * B 站公开事实写 channel='core' + surface='bili'：公开内容可以跨面想起，
 * 微信/QQ/屋子的对话原文仍然只留在各自 channel 里。
 *
 * v4（2026-11-13，合并裁决 D2）：加入 `screen`（屏幕陪伴会话的来源面）。
 * 注意三张同名表的层义不同，别互相复制：
 *   - 本表 = 事件来源面（落盘的 `surface` 字段，含 core）；
 *   - `surface.js` 的 SURFACES = 会话面（谁在跟她说）；
 *   - `tool-policy.js` 的 SURFACES = 工具面限制。
 */
export const SURFACES = Object.freeze(['core', 'web', 'wx', 'qq', 'bili', 'screen'])

/**
 * B 站 meta 记账前缀（§5.4）。放在这里给 store 的读路径推断、测试与工作台共用，
 * 避免「哪几个前缀算 B 站」在两处各写一份然后漂移。
 * 这些前缀只描述历史事实；新增记账时优先写结构化事件，前缀是为旧数据兼容留的。
 */
export const BILI_META_PREFIXES = Object.freeze([
  'browse:', 'looked:', 'watched:', 'comment:', 'creply:', 'cbody:', 'cseen:', 'my:', 'biliout:',
])

// saw 的文本由 browse.renderSaw 生成，第一段固定是「B站」；voice 没有这个标记，
// 只能靠 refs 里的 BV 号认。
const BILI_SAW_TEXT_RE = /^B站(?:｜|\s|$)/
const BILI_BVID_RE = /BV[A-Za-z0-9]/

/**
 * 旧事件（v1/v2）没有 `surface` 字段，读的时候按 §5.4 推断，**不回写**。
 *
 * 铁律：这里只读、不判断对错、不抛错。事件流里可能有半截/损坏的行被上层放进来，
 * 推断必须能对任何输入返回一个合法面（兜底 core）；真正的空白由 readEvents 的
 * skipped 计数负责，不在这里制造第二个异常源。
 */
export function inferSurface(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return 'core'
  const channel = typeof ev.channel === 'string' ? ev.channel : ''
  if (channel === 'wx' || channel === 'qq' || channel === 'web') return channel

  const type = typeof ev.type === 'string' ? ev.type : ''
  const text = typeof ev.text === 'string' ? ev.text : ''

  if (type === 'saw' || type === 'voice') {
    const refs = Array.isArray(ev.refs) ? ev.refs : []
    if (refs.some((r) => typeof r === 'string' && BILI_BVID_RE.test(r))) return 'bili'
    if (BILI_SAW_TEXT_RE.test(text)) return 'bili'
  }
  if (BILI_META_PREFIXES.some((prefix) => text.startsWith(prefix))) return 'bili'
  return 'core'
}

/**
 * 事件格式版本（2026-10-25，发布体检第 4 项）。
 *
 * 为什么要有它：事件流不能删除记录、是唯一可信源，一旦字段语义变了而旧事件还在盘上，
 * 读的时候就会静默算出错的成长。版本号让「读到了哪个年代的事件」变成**可判断**的事：
 *   - 写：每条新事件都带 `v`；
 *   - 读：没有 `v` 的一律当 v1（本字段出现之前写的事件，语义就是 v1），
 *          并计数 `legacy`，让自检/备份能说出「这份档有 N 条老事件」；
 *   - 备份：`backup.js` 把当前版本写进文件头，恢复时拒绝比自己新的档。
 *
 * 加版本号不等于做了迁移。真要改语义，必须同时写迁移函数并升这个数——
 * 只升数字不改读法，等于给自己发了一张假通行证。
 */
export const EVENT_SCHEMA_VERSION = 4
// v2（2026-11-03）：只新增 `saw` 类型，v1 事件的字段语义一个没动。
// v3（2026-11-10）：新增 `surface` 与 `bili_reply`/`reply`。v1/v2 事件的字段语义仍不动：
//   读的时候没有 `surface` 就按 §5.4 推断（store.readEvents），不迁移、不回写。
// v4（2026-11-13）：新增 `person_note`（带 person/supersedes/revokes）、`identity` flag，
//   并在事件来源面里加入 `screen`。v3 事件照旧读，不迁移、不回写。
// 读到比本版本新的事件时 store.readEvents 会跳过并计数（newer）——这是回退保护。
// 迁移与回退说明见 CHANGELOG（A1 统一补）。

/** 校验结果三档：她写 selfmod 的句子也照收，只打标记 */
export const FLAGS = Object.freeze(['selfmod', 'unrecorded', 'weak', 'truncated', 'identity'])

/** person_note.person.channel：这条认知属于哪条通道（不是事件顶层 channel）。 */
export const PERSON_CHANNELS = Object.freeze(['wx', 'web', 'core'])
/** person_note.person.kind：身份事实 / 印象 / 一次互动。 */
export const PERSON_KINDS = Object.freeze(['identity', 'impression', 'interaction'])

/**
 * person_note 的 person 子对象（v4，设计 §4.2）。
 *
 * 约束刻意和 normalizeGrant / normalizeReply 保持一致：只认白名单字段，
 * 多余的键丢掉（事件流不长野字段）；字符串统一 trim + 截断；未知枚举直接拒。
 * owner 的身份事实必须带 label——没有 label 的 owner 事实渲染不出来，写进来只是脏数据。
 */
function normalizePerson(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Reject('BAD_PERSON', 'person_note 必须带 person 对象')
  }
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const id = str(raw.id, 64)
  const name = str(raw.name, 24)
  const label = str(raw.label, 64)
  const channel = PERSON_CHANNELS.includes(raw.channel) ? raw.channel : ''
  const kind = PERSON_KINDS.includes(raw.kind) ? raw.kind : ''
  const chatId = str(raw.chatId, 64)
  const confidence = ['high', 'medium', 'unknown'].includes(raw.confidence) ? raw.confidence : 'unknown'
  if (!name) throw new Reject('BAD_PERSON', 'person.name 不能为空')
  if (!channel) throw new Reject('BAD_PERSON', `person.channel 必须是 ${PERSON_CHANNELS.join('/')}`)
  if (!kind) throw new Reject('BAD_PERSON', `person.kind 必须是 ${PERSON_KINDS.join('/')}`)
  if ((kind === 'impression' || kind === 'interaction') && !chatId) {
    throw new Reject('BAD_PERSON', 'person.chatId 在 impression/interaction 时必填')
  }
  if (id === 'owner' && kind === 'identity' && !label) {
    throw new Reject('BAD_PERSON', 'owner 身份事实必须带 person.label')
  }
  return { id, name, label, channel, chatId, kind, confidence }
}

/**
 * 「我这次没想清楚」的放行口（2026-10-27，0.5.8）。
 *
 * narration 现在要求能指回具体的事，但真的什么都没想起来时，不能逼她编一条
 * 凭证出来——那就把「不许叙事漂移」变成了「鼓励伪造」。所以留这个口子：
 * 文本里明确说没想清楚 / 想不出来，就不要求 refs。
 *
 * 收得比较窄：只有这几种说法算，而且整句要短（下面是 text 长度另判）。
 * 宽了就等于人人写一句「没想清楚」绕过校验。
 */
const NARRATION_BLANK_RE = /(想|看|说|讲)(不|没)(太)?(清楚|明白|出来|通|清)|没(有)?(想|搞|弄)(清楚|明白|懂)|想不出(来|什么)|还没想好/

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastMs = 0
let lastRand = null

/**
 * ULID：前 10 位时间（单调），后 16 位随机。同一毫秒内保证递增，
 * 这样 events.jsonl 的行序 == 时间序，不用额外排序。
 */
export function newId(now = Date.now()) {
  let ms = now
  if (ms <= lastMs) ms = lastMs
  let rand
  if (ms === lastMs && lastRand) {
    // 同毫秒：随机部分 +1（简单进位，够用）
    rand = increment(lastRand)
  } else {
    rand = randomPart()
  }
  lastMs = ms
  lastRand = rand
  return 'ev_' + encodeTime(ms) + rand
}

function encodeTime(ms) {
  let s = ''
  let t = ms
  for (let i = 0; i < 10; i++) {
    s = CROCKFORD[t % 32] + s
    t = Math.floor(t / 32)
  }
  return s
}

function randomPart() {
  let s = ''
  for (let i = 0; i < 16; i++) s += CROCKFORD[Math.floor(Math.random() * 32)]
  return s
}

function increment(prev) {
  const arr = prev.split('')
  for (let i = arr.length - 1; i >= 0; i--) {
    const idx = CROCKFORD.indexOf(arr[i])
    if (idx < 31) { arr[i] = CROCKFORD[idx + 1]; return arr.join('') }
    arr[i] = '0'
  }
  return randomPart()
}

/** 从 id 反解时间（观测台排序用，不依赖 ts 字段） */
export function idTime(id) {
  const body = String(id).replace(/^ev_/, '').slice(0, 10)
  let t = 0
  for (const ch of body) t = t * 32 + CROCKFORD.indexOf(ch)
  return t
}

const SELF_MOD_PATTERNS = [
  /(把我|替我|给你自己)(改|调|设|换)(得|成|一下|一改)/,
  /(修改|重设|调整|改写)你(自己)?的?(性格|设定|参数|人设|人格)/,
  /你(以后)?(要|应该)?(更|别那么)(外向|内向|黏人|冷淡|活泼|安静)/,
]

/**
 * 她写的句子里如果出现"想改自己"的意图 → 打 selfmod 标记。
 * 仍然落库（这是自我服务偏差的证据），但 deriveSelf 不把它算进 beliefs。
 */
export function detectSelfMod(text) {
  const s = String(text ?? '')
  return SELF_MOD_PATTERNS.some((re) => re.test(s))
}

/**
 * 这段话是不是在说「我这次没想清楚」。
 *
 * 除了命中关键说法，还要求整段不长（<= 60 字）：防止她把一句「我没想清楚」
 * 当前缀，后面接一整篇漂亮的自传绕过凭证要求。真正的「想不出来」本来就写不长。
 */
export function isBlankNarration(text) {
  const s = String(text ?? '').trim()
  if (!s || s.length > 60) return false
  return NARRATION_BLANK_RE.test(s)
}

class Reject extends Error {
  constructor(code, msg) { super(msg); this.code = code }
}

/**
 * 校验一条待写入的事件（不写盘）。
 * @returns {object} 规范化后的完整事件
 */
export function validateEvent(raw, { day, stage, now = Date.now(), source = 'tool', knownIds = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Reject('BAD_SHAPE', '事件必须是对象')
  const type = String(raw.type ?? '')
  if (!ALL_TYPES.includes(type)) throw new Reject('BAD_TYPE', `未知事件类型：${type}（允许：${ALL_TYPES.join('/')}）`)
  if (source === 'tool' && !HER_TYPES.includes(type)) {
    throw new Reject('NOT_HER_TYPE', `你不可以写 ${type} 类事件（允许：${HER_TYPES.join('/')}）`)
  }

  let text = typeof raw.text === 'string' ? raw.text.trim() : ''
  // v3：别人的空回复不丢弃——"对方回了一个空的"本身是事实。
  // 用固定占位句落盘，不新增 flag（设计 §5.3）。
  if (type === 'bili_reply' && text.length === 0) text = '（对方发了一条空回复）'
  const needsText = type !== 'meta' && type !== 'absence'
  if (needsText && text.length === 0) throw new Reject('EMPTY_TEXT', 'text 不能为空')
  if (text.length > 2000) throw new Reject('TOO_LONG', 'text 超过 2000 字，请自己压缩后再写')

  let refs = Array.isArray(raw.refs) ? raw.refs.filter((x) => typeof x === 'string' && x.length > 0) : []

  // v3：channel 是隐私边界（老事件没有该字段 → core），surface 是来源面。
  // surface 写路径：传了就必须合法，未知值拒绝而不是静默落 core；
  // 没传时按同一张推断表补默认值，保持 v1/v2 调用方的兼容（旧测试/旧写入不传 surface）。
  const channel = raw.channel === 'qq' || raw.channel === 'wx' || raw.channel === 'web' ? raw.channel : 'core'
  let surface
  if (raw.surface === undefined || raw.surface === null) {
    // v3 新增类型不能被推断兜住：`bili_reply` 是 B 站公开事实，正确面无法从
    // channel/type/text 反推（channel 规定为 core），漏传时推断只会静默落 core——
    // 正是 §5.2「写入时必填」要防的误分类。所以这里拒绝，而不是猜。
    // 旧 v1/v2 类型继续走推断，保持既有写入方兼容。
    if (type === 'bili_reply') {
      throw new Reject('BAD_SURFACE', 'BAD_SURFACE: bili_reply 必须显式写 surface（应为 bili）')
    }
    surface = inferSurface({ channel, type, text, refs })
  } else if (SURFACES.includes(raw.surface)) {
    surface = raw.surface
  } else {
    throw new Reject('BAD_SURFACE', `BAD_SURFACE: 未知 surface：${String(raw.surface)}（允许：${SURFACES.join('/')}）`)
  }
  if (type === 'revise' && refs.length === 0) throw new Reject('REVISE_NEEDS_REF', 'revise 必须用 refs 指向被改写的旧事件')

  // v4（2026-11-13）：person_note 的 person 子对象与两个「改口」数组。
  // 只有 person_note 带这些字段；其他类型即使传了也丢掉，避免事件流长出野字段。
  // refs/supersedes/revokes 在这里先规范化，下面的 knownIds 校验统一读这三份。
  const person = type === 'person_note' ? normalizePerson(raw.person) : null
  const idList = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length > 0))] : [])
  const supersedes = type === 'person_note' ? idList(raw.supersedes) : []
  const revokes = type === 'person_note' ? idList(raw.revokes) : []

  // 2026-10-27（0.5.8）：refs 从「必须写」升级成「必须写对」。
  //
  // 为什么：0.5.7 之前只查 refs 非空，所以她写一条 refs:['ev_XXX']——那个 id
  // 根本不存在——也照样入账。「我改的是哪一条」于是从可核验退化成一句仪式：
  // 光看她写了 refs，读的人会以为有凭证，实际什么都没有。这正是「叙事漂移」
  // 的入口：她可以随口说自己变了，而账上没有任何一条能对上。
  //
  // 调用方（store.appendEvent）手里才有全量事件流，所以只在它传了 knownIds
  // 时才做存在性校验；不传的老调用（含测试里的直接构造）行为不变，保持向后兼容。
  // 只查 revise / narration / person_note：前两类是「我改口 / 我对自己有个说法」的声明，
  // person_note 的 refs/supersedes/revokes 是「这条笔记指向/替换/撤销哪条」，同样必须能对上。
  // 别的事件带 refs 只是引用材料，不承担可核验的义务。
  if (knownIds && (type === 'revise' || type === 'narration' || type === 'person_note')) {
    const ids = type === 'person_note' ? [...refs, ...supersedes, ...revokes] : refs
    for (const id of ids) {
      if (!knownIds.has(id)) {
        throw new Reject('REF_NOT_FOUND', `refs 里的 ${id} 在事件流里不存在。要指向具体的某一条，别写自己没查过的 id。`)
      }
    }
  }

  // 2026-10-27（0.5.8，用户 m05409「回顾也允许她说我想不清楚」）：
  // narration（她对自己整体的说法）也必须能指回具体的事。
  //
  // 为什么单独管它：revise 改的是已有那句话，指向很自然；narration 是从一堆
  // 零散经历里提炼「我变成了什么样」，最容易写成一句漂亮的空话。要求它带 refs
  // 等于要求她先翻、先指，再总结——这是唯一能防「叙事漂移」的位置。
  //
  // 但必须留一个出口：真的什么都没想起来的时候，「我没想清楚」这句话本身也是
  // 真的，不能因为写不出凭证就把她逼到编一条。所以文本里明说没想清楚就放行。
  // 这个豁免是**她自己声明**的，不是系统替她判断「这次可以不算」。
  if (type === 'narration' && refs.length === 0 && !isBlankNarration(text)) {
    throw new Reject(
      'NARRATION_NEEDS_REF',
      'narration 要说清是从哪件事来的：用 refs 指向 her_recall 翻到的某一条 id。' +
        '如果你这次真的没想清楚，就直接写「我没想清楚」——那句也算数。',
    )
  }

  let confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : 0.5
  confidence = Math.max(0, Math.min(1, confidence))

  const flags = []
  if (detectSelfMod(text)) flags.push('selfmod')
  // 只有系统侧可以自带 flag。她（tool）传进来的 flags 一律忽略——
  // 否则她只要给自己打一个 selfmod，就能把不想留下的信念从 beliefs 里"消失"掉。
  // v4 的唯一例外：tool 写 person_note 时保留 `identity`（owner 身份事实的审计标记，
  // 不参与权限判断），其余 tool 写入仍然丢弃 identity/selfmod。
  if (source !== 'tool' && Array.isArray(raw.flags)) {
    for (const f of raw.flags) if (FLAGS.includes(f) && !flags.includes(f)) flags.push(f)
  } else if (source === 'tool' && type === 'person_note' && Array.isArray(raw.flags)) {
    for (const f of raw.flags) if (f === 'identity' && !flags.includes(f)) flags.push('identity')
  }

  // v3：bili_reply 的结构化去重键。缺 reply / bvid / rpid 直接拒——
  // 没有 rpid 就没法保证「同一条回复不重复写」，只能当脏数据挡在门外。
  const reply = type === 'bili_reply' ? normalizeReply(raw.reply) : null

  return {
    id: typeof raw.id === 'string' && /^ev_[0-9A-Z]{26}$/.test(raw.id) ? raw.id : newId(now),
    v: EVENT_SCHEMA_VERSION,
    ts: typeof raw.ts === 'string' ? raw.ts : new Date(now).toISOString(),
    day: Number.isInteger(raw.day) ? raw.day : Number(day ?? 0),
    stage: Number.isInteger(raw.stage) ? raw.stage : Number(stage ?? 1),
    type,
    source,
    // 2026-10-29：通道。core = 她自己/共同层（所有通道翻得到）；qq/wx/web = 只属于那条通道。
    // 老事件没有这个字段 → 按 core 读（B 站那些本来就在里面）。
    channel,
    // v3（2026-11-10）：来源面。写路径传了就必须合法；没传按 §5.4 推断补默认。
    surface,
    text,
    refs,
    verdict: ['confirmed', 'refuted', 'refined'].includes(raw.verdict) ? raw.verdict : null,
    confidence,
    flags,
    // R3：申请与裁决都带一个 grant 子对象，其余事件不带（undefined 不落 JSON）。
    ...(type === 'grant_offer' || type === 'grant' ? { grant: normalizeGrant(type, raw.grant) } : {}),
    // v3：只有 bili_reply 带 reply；其他类型即使传了也丢掉，避免事件流里长出野字段。
    ...(type === 'bili_reply' ? { reply } : {}),
    // v4：只有 person_note 带 person/supersedes/revokes。
    ...(type === 'person_note' ? { person, supersedes, revokes } : {}),
    // 拒绝的形状（P1 第二块，2026-10-24）：原话照样留在 text 里，
    // 另外落一份「动作 + 对象」，让后来的她（和观测台）能分清
    // "不想看这个视频" 与 "不想被安排" 是两个不同的不。
    ...(type === 'refusal' ? { refuse: parseRefusal(text) } : {}),
    // absence 专用：真实冷落天数（按毫秒算）。deriveSelf 优先用它——
    // 用 day 差（哪个成长日写的）会在"同一天写两次 absence"时算出 0 天，是错的。
    // 其他类型不带这个字段（undefined 不落 JSON），保持事件干净。
    ...(type === 'absence' && Number.isFinite(Number(raw.days))
      ? { days: Math.max(0, Math.round(Number(raw.days))) }
      : {}),
  }
}

export { Reject }

/**
 * grant 子对象（R3）：申请与裁决共用。
 *
 * 为什么允许 text 为空：grant_offer 的 text 是她写给主人的理由；
 * grant 的 text 是主人驳回时可能留的一句话（可以不说）。
 */
function normalizeGrant(type, raw) {
  const g = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const out = {
    rule: str(g.rule, 64),
    offerId: str(g.offerId, 64),
    verdict: g.verdict === 'approve' || g.verdict === 'reject' ? g.verdict : null,
    reason: str(g.reason, 200),
  }
  if (type === 'grant' && g.expiresAt) out.expiresAt = str(g.expiresAt, 40) || null
  return out
}

/**
 * bili_reply 的 reply 子对象（v3，设计 §5.3）。
 *
 * 去重键是 `rpid`：扫描回复时必须先取已有 `reply.rpid` 集合，再决定写不写。
 * bvid / rpid 缺失或只有空白 → BAD_REPLY（错误信息里带 BAD_REPLY，日志能直接搜）；
 * 其余字段只做「转字符串 + 截断」，不猜语义。不认识的字段丢弃，事件流不长野字段。
 */
function normalizeReply(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Reject('BAD_REPLY', 'BAD_REPLY: bili_reply 必须带 reply 对象（至少 bvid 与 rpid）')
  }
  const str = (v, max) => {
    if (typeof v === 'string') return v.trim().slice(0, max)
    if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, max)
    return ''
  }
  const bvid = str(raw.bvid, 32)
  const rpid = str(raw.rpid, 64)
  if (!bvid || !rpid) {
    throw new Reject('BAD_REPLY', 'BAD_REPLY: reply.bvid 与 reply.rpid 不能为空（rpid 是去重键）')
  }
  return {
    bvid,
    rpid,
    root: str(raw.root, 64),
    parent: str(raw.parent, 64),
    user: str(raw.user, 64),
    mid: str(raw.mid, 64),
  }
}
