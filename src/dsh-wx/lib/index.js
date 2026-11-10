/**
 * dsh-wx —— 微信通道（大肥鱼）
 *
 * 为什么是插件而不是给她 bash：
 *   微信这条线靠 CU（cua-driver）读无障碍树 + xdotool 点、打字，壳里只有一句 `bash`。
 *   但她的工具面是收窄过的（tools.restrict），给 bash 等于把整台机器给她。
 *   所以把「看、点、打字、按键」包成工具：能做微信里的动作，拿不到 shell。
 *
 * 说话范围（工作台的开关和名单）存 ~/.dsh-wx/policy.json，每次调用现读：
 *   { "enabled": true, "allowChats": ["测试群A"], "watch": true, "trigger": ["@D33p53Ek"] }
 *
 * 三个设计约束（都是踩过的坑）：
 *   1. 会话名只认「会话列表那一行的第一行」与「当前会话」，别处的字不可能是会话名（见 tree.js）。
 *   2. 树坐标 ≠ 屏幕坐标，差一个 dpi/96（见 scale.js），换算在 wx-elements.mjs 里做完了。
 *   3. 无障碍树会落后于屏幕。落后的判断由工具做（对账像素摘要），提醒写在工具的返回值里，
 *      不靠往她的会话里塞提醒。
 *
 * 工具文案刻意写成「日志式的平铺陈述」：不带语气词、不带比喻、不带情绪。
 * 她会模仿手边文字的口气；工具的话越中性，她自己的口气越不被带偏。
 *
 * 底层是 wx.sh（Xvfb :99 + xdotool + import + CU）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { allowedCurrent, contentDigest, mentionHits, ocrMentionHits, parseTree, reconcileChatName, restartEpisode, sameName, sidebarRegion, treeAction, treeHealth, treeMatchesOcr } from './tree.js'
import { ocrSnapshot } from './ocr.js'
import { canSpeak, grant, grantMentioned, parseWindowMinutes, prune as pruneMentions } from './mention.js'
import { freshHits, forgetReadChats, ownEcho, parseSeen, pruneSeen, serializeSeen } from './ear-seen.js'
import { openChatHit } from './ear-open.js'
import { canSendWithPolicy, createPermitStore, findInputBox, provideWxService } from './reminder.js'
import { captureSettings, DEFAULT_IGNORE_CHATS, isIgnoredChat, pauseReason, previewSig, shouldEnqueue } from './capture.js'
import { createCaptureQueue } from './capture-queue.js'
import { captureEvidenceKey, runCapture } from './capture-run.js'
import { createContextStore } from './context.js'
import { createDirectory, mergeScanned, scanSidebar } from './directory.js'
import { createPeople } from './people.js'
import { normalizeMessages } from './transcript.js'
import { createSessionPool } from './sessions.js'
import { parsePreviewSender, requesterOf, samePreviewText } from './speaker.js'
import { alignSpeakers, planSpeakerRepairs } from './speaker-align.js'
import { createVectorProvider } from './vector.js'
import { annotate, loadIndex, saveIndex } from './sticker-index.js'
import { findStickers, formatFind, formatList, listStickers } from './sticker-query.js'
import { scanStickers } from './sticker-scan.js'
import { sendSticker, targetEntry } from './sticker-send.js'
import { collectSticker } from './sticker-collect.js'
import { normalizeKeyword, searchSticker } from './sticker-search.js'
import {
  boundedText,
  clipPeekBody,
  lazyRender,
  projectWxContext,
  projectWxOcr,
  projectWxPeek,
} from './project.js'

export const name = 'dsh-wx'
// ⚠️ 不要 inject 'sessionController'：它要等工作区注册表起来才可用，而工作区是有人打开界面时才起来的。
// 写进 inject 插件整条挂不上，没人看界面时耳朵就是聋的。改成用的时候现取（ctx.get），拿不到下一轮再试。
export const inject = ['tools', 'systemPrompt', 'agents']

// 给自测用
export { parseTree, mentionHits, ocrMentionHits, contentDigest, sameName, allowedCurrent, sidebarRegion, ocrSnapshot, reconcileChatName, treeHealth, treeAction, treeMatchesOcr }
export { resolveLabel, hitTest, createFreshness }

const SH = fileURLToPath(new URL('./wx.sh', import.meta.url))
const SHOT_DIR = '/home/str1k3/.dsh-fish/home/.wx'
const POLICY = '/home/str1k3/.dsh-wx/policy.json'
const HEALTH = '/home/str1k3/.dsh-wx/health.json'
// 耳朵的流水账：看见什么、投没投进去。只追加，排查时不用靠 grep 宿主日志。
const INBOX = '/home/str1k3/.dsh-wx/inbound.jsonl'
const HER_DIR = '/home/str1k3/.dsh-fish/home'
// 说话频率的判定放在两个通道共用的一个文件里（QQ 那边是 vendor 补丁，用的是同一份）
const SPEECH = '/home/str1k3/dsh-plugins/speech/speech.mjs'
const MEM_LIVE = '/home/str1k3/dsh-plugins/dsh-mem/lib/livewx.js'
const KEEP = 20

/**
 * 只有主机亲手打的字才算「主机在说话」。
 * 宿主还会把 runtime-context / time-context / model-selection / skill-catalog 注入成
 * user/message，它们不是主机的话。2026-11-02 22:26 重启后的第一轮就踩过：
 * 运行时快照被记成「主机刚说过话」，微信回复被闸了 30 分钟。
 */
export function isHostChatSource(source) {
  return source?.kind === 'user'
}

function sh(args, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    execFile('/bin/bash', [SH, ...args], {
      timeout,
      maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, WX_DISPLAY: process.env.WX_DISPLAY || ':99' },
    }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message || '').trim().slice(0, 800)
        reject(new Error(why || 'wx.sh 失败'))
        return
      }
      resolve(String(stdout).trim())
    })
  })
}

/** 现读策略：文件不在就当「关着」，宁可开不了口也别乱说话。 */
function policy() {
  try {
    const raw = JSON.parse(readFileSync(POLICY, 'utf8'))
    return {
      enabled: raw.enabled === true,
      allowChats: Array.isArray(raw.allowChats) ? raw.allowChats.map((s) => String(s).trim()).filter(Boolean) : [],
      watch: raw.watch !== false,
      // @ 才回：开着的时候，只有最近被 @ 过的会话她才敢开口
      requireMention: raw.requireMention !== false,
      mentionWindowMinutes: parseWindowMinutes(raw.mentionWindowMinutes),
      // 私聊/自己的文件传输这类：本来就等于在叫她，不受 @ 约束
      noMentionChats: Array.isArray(raw.noMentionChats) ? raw.noMentionChats.map((s) => String(s).trim()).filter(Boolean) : [],
      trigger: Array.isArray(raw.trigger) && raw.trigger.length > 0
        ? raw.trigger.map((s) => String(s))
        : ['@D33p53Ek', 'D33p53Ek'],
      ignoreChats: Array.isArray(raw.ignoreChats)
        ? raw.ignoreChats.map((s) => String(s).trim()).filter(Boolean)
        : DEFAULT_IGNORE_CHATS,
      capture: captureSettings({ capture: raw.capture, ignoreChats: raw.ignoreChats }),
      // 关键词搜索点下去就是发送；用户把“用不用”交给大肥鱼自己决定，
      // 所以默认开着，只受白名单和发送闸约束；工作台可写 false 关掉。
      stickerSearch: raw.stickerSearch !== false,
    }
  } catch {
    return {
      enabled: false, allowChats: [], watch: false, trigger: [], requireMention: true,
      mentionWindowMinutes: 3, noMentionChats: [],
      ignoreChats: DEFAULT_IGNORE_CHATS,
      capture: captureSettings({}),
      stickerSearch: false,
    }
  }
}

/** 耳朵的账本：一行一个事件，只追加。写不进去不影响耳朵。 */
function logInbound(entry) {
  try {
    mkdirSync('/home/str1k3/.dsh-wx', { recursive: true })
    appendFileSync(INBOX, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* 记不下不影响用 */ }
}

/** 只留最近 KEEP 张截图。 */
function prune() {
  try {
    const files = readdirSync(SHOT_DIR)
      .filter((f) => f.endsWith('.png'))
      .map((f) => ({ f, t: statSync(join(SHOT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const { f } of files.slice(KEEP)) rmSync(join(SHOT_DIR, f), { force: true })
  } catch { /* 清不掉不影响用 */ }
}

const hms = (t = Date.now()) => new Date(t).toTimeString().slice(0, 8)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 输出统一是一段文字：宿主只接受 string/object 这类 JSON schema。 */
const textOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v ?? '') }] }
// wx_ocr 的 execute 返回完整 JSON（台账会落 artifact），但 fishCore 缺席时
// 旧渲染路径最多只该给 24k，不能把整段 JSON 塞进上下文。
const ocrOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: boundedText(v) }] }

const OFF = '微信通道已关闭。'

// ---------------------------------------------------------------- 点谁
/** wx_peek 里一行会话常被整行贴回来当 label：先抹掉未读数、角标、时间、坐标再比。 */
function normWant(s) {
  return String(s ?? '')
    .replace(/中心\(\s*-?\d+\s*,\s*-?\d+\s*\)/g, ' ')
    .replace(/\[(?:\d{1,3}|you were mentioned|draft)\]/gi, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * label → 要点的元素。优先级：
 *   会话名（整串）→ 按钮/控件名（整串）→ 会话名作前缀 → 控件名部分匹配 → 会话名部分匹配
 * 消息正文不参与匹配（以前"按标签点"能点到别人说的话）。
 */
function resolveLabel(parsed, want) {
  const raw = String(want ?? '').trim()
  const w = normWant(raw)
  const lw = w.toLowerCase()
  if (!lw) return null
  const chats = parsed.chats
  const ctl = parsed.clickables
  const ctlEq = (r) => ctl.filter((c) => c.label.toLowerCase() === lw && (!r || r.test(c.role)))
  let hit = chats.find((c) => sameName(c.name, raw) || sameName(c.name, w))
  if (hit) return { kind: 'chat', name: hit.name, box: hit.box }
  const btn = ctlEq(/button/)[0] ?? ctlEq()[0]
  if (btn) return { kind: 'control', name: btn.label, box: btn.box }
  hit = chats.filter((c) => c.name && w.startsWith(c.name + ' ')).sort((a, b) => b.name.length - a.name.length)[0]
  if (hit) return { kind: 'chat', name: hit.name, box: hit.box }
  const part = ctl.filter((c) => c.role.includes('button') && c.label.toLowerCase().includes(lw))
  if (part.length === 1) return { kind: 'control', name: part[0].label, box: part[0].box }
  if (lw.length >= 2) {
    const cp = chats.filter((c) => c.name.toLowerCase().includes(lw))
    if (cp.length === 1) return { kind: 'chat', name: cp[0].name, box: cp[0].box }
  }
  return null
}

/** 坐标落在什么上：用来在 wx_click 的返回里告诉她"点到了谁"。 */
function hitTest(parsed, x, y) {
  const inBox = (b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h
  const ctl = parsed.clickables.filter((c) => inBox(c.box)).sort((a, b) => a.box.w * a.box.h - b.box.w * b.box.h)[0]
  if (ctl) return { kind: 'control', name: ctl.label }
  const chat = parsed.chats.find((c) => inBox(c.box))
  if (chat) return { kind: 'chat', name: chat.name }
  const msg = parsed.messages.find((m) => inBox(m.box))
  if (msg) return { kind: 'message', name: msg.text.slice(0, 30) }
  return null
}

// ---------------------------------------------------------------- 树落后的判断
/**
 * 无障碍树会落后于屏幕：今天实测会话列表重排之后，树过了两三分钟才跟上；
 * 更早还出现过整棵树一动不动（点击前后逐字相同，截图却差了 8540 个像素）。
 *
 * 判法是对账：同一时刻取
 *   - 树的内容摘要（会话列表 + 当前会话 + 最后几条消息）
 *   - 会话列表区域的像素摘要
 * 「像素变了、树没变、鼠标没动」= 屏幕上有事发生而树没看见。
 *
 * 防误报：
 *   - 鼠标动过不算（悬停高亮、选中态会改像素）；
 *   - 取树前后各量一次像素，不一致说明读树期间屏幕在变，这次不下结论；
 *   - 要连续两次观察都是"树没变像素变"才算落后（消息刚到、事件还在路上的几十毫秒不误报）。
 */
function createFreshness(log = () => {}) {
  let base = null
  let suspect = null
  let stale = null
  const events = []
  const note = (msg) => {
    events.push(`${hms()} ${msg}`)
    if (events.length > 30) events.shift()
    log(msg)
  }
  return {
    get stale() { return stale },
    get suspect() { return suspect },
    get events() { return events },
    observe(s) {
      if (!s?.parsed?.ok) return 'no-window'
      if (!s.hash || !base) { base = { ...s }; return 'baseline' }
      if (s.hash0 && s.hash0 !== s.hash) return 'unstable'

      // 已判定落后：只有三种情况会解除——树内容变了（跟上了）、屏幕回到树对应的样子、超过 10 分钟放弃判定
      if (stale) {
        if (s.digest !== stale.digest) {
          note(`树已跟上（落后了 ${Math.round((s.at - stale.since) / 1000)} 秒）`)
        } else if (s.hash === stale.origHash) {
          note('屏幕与树重新一致')
        } else if (s.at - stale.since > 10 * 60_000) {
          note('落后判定超过 10 分钟，放弃判定（可能是树不暴露的像素变化）')
        } else {
          return 'stale'
        }
        stale = null; suspect = null; base = { ...s }
        return 'live'
      }

      if (s.digest !== base.digest) { suspect = null; base = { ...s }; return 'live' }
      if (s.hash === base.hash) { suspect = null; base.mouse = s.mouse; return 'ok' }
      // 树没变、像素变了。鼠标动过或区域换了，悬停/选中态足以解释，不下结论
      if (s.mouse !== base.mouse || JSON.stringify(s.region) !== JSON.stringify(base.region)) {
        suspect = null; base = { ...s }
        return 'rebase'
      }
      suspect = suspect ? { ...suspect, n: suspect.n + 1 } : { since: s.at, n: 1 }
      if (suspect.n >= 2) {
        stale = { since: suspect.since, digest: s.digest, origHash: base.hash }
        note('检测到树落后于屏幕：会话列表像素已变，树内容未变')
        return 'stale'
      }
      return 'suspect'
    },
    /** 外部证据（OCR 直接读屏幕）证明树没落后：撤掉判定，下次观察重新立基线。 */
    agree(msg) {
      if (!stale && !suspect) return
      note(msg || '屏幕与树经 OCR 复核一致')
      stale = null; suspect = null; base = null
    },
    /** 我们自己的动作（关浮层、重启微信）改动了屏幕：旧基线作废。 */
    reset(msg) {
      if (stale || suspect) note(msg || '自己的操作改动了屏幕，重新对账')
      stale = null; suspect = null; base = null
    },
    noteNudge(recovered) { note(recovered ? '滚动列表后树已更新' : '滚动列表后树未更新') },
    /** 写进工具返回值的提示。没落后就是空串。 */
    notice(now = Date.now()) {
      if (!stale) return ''
      return `\n[提示] 屏幕上的会话列表已变化，读到的树没有跟上（自 ${hms(stale.since)}，${Math.round((now - stale.since) / 1000)} 秒）。上面的名字、顺序、坐标可能是旧的。`
    },
  }
}

// ---------------------------------------------------------------- 提示词
/** 微信通道说明：只挂在她的会话里。陈述句，列事实和规则，不带语气。 */
function promptText() {
  const p = policy()
  const state = p.enabled
    ? (p.allowChats.length > 0 ? `开启。允许发送的会话：${p.allowChats.join('、')}` : '开启，但允许名单为空，不能发送')
    : '关闭'
  return [
    '## 微信通道（dsh-wx）',
    '',
    '微信里的动作通过 15 个工具完成，没有 shell：',
    '- wx_peek：读界面。输出当前会话、会话列表（名字、未读、@我、预览）、当前聊天最后几条消息、可点击元素。要点击时，把这里看到的名字或按钮名填给 wx_click 的 label。消息列表没有发言人；侧栏只剩截断名的会话，等目录扫到全名再用。',
    '- wx_click：点击。label 填会话名或按钮名，和 wx_peek 里的写法一致；x/y 只作内部回退，正常不用填。返回里会写落点是什么、点完当前会话是什么。',
    '- wx_type：输入文字，enter=true 时回车发送。发送前核对当前会话是否在允许名单内；发送后回报消息是否出现在列表末尾。文本不能含换行。',
    '- wx_key：按键。Return 视同发送，同样核对。',
    '- wx_see：截图存档。当前模型不支持图像输入，读不了截图。',
    '- wx_ocr：只读 OCR。OCR 不证明当前会话，不能当发送授权。',
    '- wx_send：直接发到指定会话。它自己点开会话、点输入框、输入、回车，并核对回执。普通发送仍要过允许名单、@ 和主机闸；带 permit 时只用于到点的定时提醒，一次性、只对指定会话有效。带上 task_id 时，回执确认后会把这次回复记到任务上。',
    '- wx_context：在「当前任务自己的会话」里查上下文。给 task_id，可选 query，或按时间翻页（before/limit）。只返回最多 5 条引用卡片，带发言人（读不出来的写「发言人未识别」）、时间、匹配原因和置信度；原文和每日摘要一起查，不会跨会话查，也不会把查询写进记忆。',
    '- wx_history：只读查询微信台账。不传 chat 时列出有记录的非服务会话；传 chat 时查该会话最近的记录，可选 query 关键词和 hours 时间窗。最多 20 条，带发言人、时间、来源和置信度。不建任务、不写事件流。',
    '- wx_task_snooze：把任务推迟几分钟再提醒。现在回不了、但不是不用回时用；推迟期间不再催。',
    '- wx_task_done：把一条任务标记为完成。发了一条回复不等于完成；确实答完、不用再跟进时才用。',
    '- wx_sticker_scan：扫描微信收藏表情面板，重建或更新本地索引。只点心形页签，不点任何表情格；会打开再关上表情面板。',
    '- wx_sticker_list：列出收藏表情索引里的条目、描述和置信度。返回文字，不含图片。',
    '- wx_sticker_find：按关键词查收藏表情，最多返回 5 个候选，带命中原因和置信度；候选不等于要发。',
    '- wx_sticker_tag：给某张表情补图上文字、描述或标签，只改本地索引，不改微信收藏本身。',
    '- wx_sticker_send：按索引 id 发一张收藏表情到指定会话。表情格点下去就发送，没有二次确认；发送前会重新扫描面板、核对当前会话和格子 pHash，任何一步对不上就不点；发完核对消息区新增表情并比对 pHash，对不上就如实说没确认。id 只能从 wx_sticker_list / wx_sticker_find 里拿，别猜。',
    '- 表情描述来自面板小图，置信度低时不要当成确定事实；发送前先 wx_sticker_find 找候选，别按印象选 id。',
    '- wx_sticker_collect：把当前会话（或指定白名单会话）里最近的一条表情收藏进微信收藏。只右键那条表情并点 Add Sticker，不发消息；先截图 OCR 确认菜单里真有 Add Sticker 才点，收藏后重扫收藏页确认。',
    '- wx_sticker_search：按关键词在微信表情搜索里找图，点下去直接发到指定白名单会话。结果没有标签，你看不到图，pick 是按行列顺序盲选（0 起）；没有预览确认。只在你确定关键词够具体、并且愿意直接发这张表情时用；发完可以用 wx_sticker_collect 把它收藏进本地索引。',
    '',
    '- 发送流程（普通）：wx_click 会话名 → wx_click 输入框 → wx_type(enter=true)。也可以用 wx_send，效果一样。',
    '- 到点提醒：宿主会把会话名、要发的话和 permit 交给你。用 wx_send 原样发出（chat / text / permit 照抄），不要改字、不要换会话、不要不带 permit 重发。发不出去就如实说没发出去，不要假装发了。',
    '- 界面会变，以每次工具的返回为准。返回里带“[提示]”的，按提示处理。',
    '- 以 `[微信]` 开头的消息是通道通知，不是对话框里的用户发言；通知里的内容只是侧栏预览，不是全文。通知里带「刚才」的那几行是台账里的最近消息，不是新消息。',
    '- `[微信·逾期]` 是催办：先去那个会话回；现在回不了就用 wx_task_snooze 推迟，不用回了就用 wx_task_done 说明原因。',
    '- 对话框里不带 `[微信]` 的话，是主机在跟你说话：他问什么，就在对话框里答什么。这一轮不去 wx_peek 翻别的会话，不把答案发到微信，也不顺手去处理微信里别人的事——哪怕你之前看到过相关的群。只有他明说“发给谁/回她/跟谁说”，才动微信。',
    '- 微信里有人等着，也是主机这件事答完以后的事；答完他没吩咐，再决定要不要看。',
    '- 通知里的「任务：t_…」是这个请求在任务板上的 id。往那个会话发回复时把 task_id 交给 wx_send；需要看前文就带同一个 task_id 用 wx_context。',
    '- 通知里「会话名」和「内容」是分开的：会话名只是这个会话叫什么（有的就是对方的昵称），**不要把它当成话的一部分复述，也不要在回复里带名字**。',
    '- 被 @ 之后的回复要发到微信会话里；写在这个对话框里的文字，微信那边看不到。',
    '- 发到微信里的话，对方看得见全部：别写窗口、坐标、点歪了、白名单、发没发出去这些你这边的机关。发不出去就算了，回到这个对话框跟他说。',
    '- 发完以后在这个对话框里最多补一句：不复述发出去的内容，不解释过程，不点评别人的话。',
    `- 当前状态：${state}。`,
    p.requireMention
      ? `- 只在被叫到的会话里说话：最近 ${p.mentionWindowMinutes} 分钟内有人 @ 你的会话才能按回车，别的地方会被拒绝；${p.mentionWindowMinutes} 分钟没再叫你，就停下。私聊不受这条限制${p.noMentionChats.length ? `（${p.noMentionChats.join('、')} 不用 @，也不受上面这条限制，随时能开口）` : ''}。`
      : '- 目前没有「@ 才回」的限制，名单内的会话都可以开口。',
  ].join('\n')
}

// 耳朵递话的格式：会话名和内容必须分开写。
// 以前是「名字：内容」一行，她会照着这个格式回，把会话名当成话的一部分写出来。
export function formatEarNote(hits, allowChats = [], tasks = null, extra = {}) {
  const kindOf = (why) => (why === 'exempt' ? '单聊（免 @ 白名单）' : why === 'dm' ? '单聊' : why === 'name' ? '群里叫了你的名字' : '群里 @ 你')
  const taskOf = (chat) => (tasks instanceof Map ? tasks.get(chat) : null)
  const whoOf = (chat) => (extra?.requester instanceof Map ? extra.requester.get(chat) : null)
  const recentOf = (chat) => (extra?.recent instanceof Map ? extra.recent.get(chat) : null)
  const body = hits.map((h, i) => {
    const lines = [
      `${i + 1}) 会话名：${h.chat}`,
      `   类型：${kindOf(h.why)}`,
      `   未读：${h.unread || 0} 条`,
      `   最后一条内容（侧栏预览，不是全文）：「${h.preview.slice(0, 120)}」`,
    ]
    const who = whoOf(h.chat)
    if (who?.name) {
      const sure = who.confidence === 'low' ? '（不太确定）' : who.confidence === 'medium' ? '（据侧栏预览）' : ''
      lines.push(`   谁：${who.name}${sure}`)
    }
    const task = taskOf(h.chat)
    if (task?.taskId) lines.push(`   任务：${task.taskId}（未回）`)
    const recent = recentOf(h.chat)
    if (Array.isArray(recent) && recent.length) {
      lines.push('   刚才（台账，最近几条）：')
      for (const line of recent.slice(-6)) lines.push(`     - ${String(line).slice(0, 160)}`)
    }
    return lines.join('\n')
  })
  return [
    `[微信] 有人在微信里找你（${hits.length} 处）`,
    ...body,
    '（「会话名」只是这个会话叫什么，不是你该说出口的话；上面的内容才是对方写的。',
    `预览不是全文，要看清楚用 wx_click 点开这个会话名。允许发送的会话：${allowChats.join('、') || '（名单为空）'}。）`,
  ].join('\n')
}

/**
 * 侧栏预览入账器：只读当前列表，不点开、不滚动、不清未读。
 * 返回本轮每一行的 prevSig/sig，供后台轮转在更新快照前做入队判断。
 * capture.preview=false 时仍构建 rows（供轮转），只跳过写台账；指纹照常推进。
 *
 * @param {{policy:()=>object, contextStore:object, directory:object, people:object,
 *   log?:(line:string)=>void, lastSig?:Map<string,string>}} [deps]
 */
export function createPreviewRecorder({
  policy, contextStore, directory, people, log = () => {}, lastSig = new Map(),
} = {}) {
  let previewWarned = false
  return function recordPreviews(parsed) {
    const p = policy()
    const previewOn = p.capture?.preview !== false
    let added = 0
    const rows = []
    for (const row of parsed?.chats ?? []) {
      const chat = String(row?.name ?? '').trim()
      if (!chat) continue
      const sig = previewSig(row)
      const prevSig = lastSig.get(chat) ?? ''
      rows.push({ chat, row, sig, prevSig })
      if (row.draft) continue
      if (isIgnoredChat(chat, p.ignoreChats)) continue
      const preview = String(row.preview ?? '')
      if (!preview || prevSig === sig) continue
      if (!previewOn) {
        // 只跳过写台账；指纹照常推进，避免关闭预览期间每轮都被当成 changed。
        lastSig.set(chat, sig)
        continue
      }
      const pv = parsePreviewSender(preview)
      const entry = directory.entry(chat)
      try {
        const r = contextStore.capturePreview({
          chat,
          chatId: entry?.chatId ?? '',
          preview,
          time: String(row.time ?? ''),
          unread: Number(row.unread) || 0,
          isDM: entry?.kind === 'dm' ? true : undefined,
          ignoreChats: p.ignoreChats,
        })
        if (r.ok) {
          added += r.added
          if (r.sender) {
            people.learn({
              name: r.sender,
              source: entry?.kind === 'dm' ? 'dm' : 'preview',
              chatId: r.chatId,
              requireEvidence: pv.needsEvidence,
            })
          }
        }
        lastSig.set(chat, sig)
      } catch (err) {
        if (!previewWarned) {
          previewWarned = true
          log('预览入账失败（不影响耳朵）：' + String(err?.message ?? err).slice(0, 120))
        }
      }
    }
    if (added > 0) log('采集：预览 +' + added)
    return { added, rows }
  }
}

// ---------------------------------------------------------------- 插件主体
export function apply(ctx, config = {}) {
  const display = String(config.display || ':99')
  // 收藏表情索引是派生缓存：默认落在运行数据目录，测试实例可以用 config 指到别处。
  const stickerDir = String(config.stickerDir || '/home/str1k3/.dsh-wx/stickers')

  // GUI 单写者：微信只有一个窗口、一只手。读屏、点击、打字、目录滚动都串行，
  // 否则两个循环会在「点开会话」和「读当前会话」之间互相插队。
  // AsyncLocalStorage 让同一条调用链内的嵌套加锁直通，不会自己等自己。
  const guiCtx = new AsyncLocalStorage()
  let guiTail = Promise.resolve()
  const withGuiLock = (fn) => {
    if (guiCtx.getStore() === 'gui') return fn()
    const exec = () => guiCtx.run('gui', fn)
    const p = guiTail.then(exec, exec)
    guiTail = p.then(() => {}, () => {})
    return p
  }
  const run = (args, timeout) => withGuiLock(() => {
    process.env.WX_DISPLAY = display
    return sh(args, timeout)
  })

  const disposers = []
  // 预分配的微信会话 id：宿主在 create 期间就触发 agent/created，那时 surface
  // 登记必须已经能命中。本地集合先兜底，fishCore 在场时再写进面注册表。
  const reservedWxSessions = new Set()
  const reserveWxSession = (id) => {
    const s = String(id ?? '')
    if (!s) return
    reservedWxSessions.add(s)
    try {
      ctx.get?.('fishCore')?.surface?.reserve?.(s, 'wx')
    } catch {
      // fishCore 缺席 / 加载顺序没轮到时，本地集合仍然可用。
    }
  }
  const stripProject = ({ project: _project, ...plain }) => plain
  const reg = (tool) => {
    const execute = tool.execute
    const base = { ...tool, execute: (...a) => withGuiLock(() => execute(...a)) }
    // 有投影的工具一律注册成懒投影：fishCore 可能在本插件 apply() 之后才出现
    //（profile 里 dsh-wx 先于 dsh-fish 加载），所以把判断推迟到 render。
    // base 必须保留 project，懒包装器才能算出投影。
    const def = tool.project
      ? { ...stripProject(base), project: tool.project, output: { ...(base.output ?? {}), render: lazyRender(ctx, base) } }
      : stripProject(base)
    disposers.push(ctx.tools.register(def))
  }

  // ---- 定时提醒：一次性许可 + 「最近把谁叫醒过」 ----
  // 许可只管「到点时允许往这一个会话发一次」；它不放宽允许名单，也不改频率。
  const permitStore = createPermitStore({
    log: (m) => console.log('[dsh-wx] 提醒许可：' + m),
  })

  // ---- 会话目录 / 多会话 ----
  // 目录是派生索引：侧栏每见到一次就合并一次；全量滚动扫描每 10 分钟一次。
  // chatId 一旦分配就不换，台账、任务、向量缓存都靠它对齐。
  const directory = createDirectory({
    log: (m) => console.log('[dsh-wx] 会话目录：' + String(m ?? '').slice(0, 160)),
  })
  const sessions = createSessionPool({
    log: (m) => console.log('[dsh-wx] 会话池：' + String(m ?? '').slice(0, 160)),
  })
  const knownNames = () => {
    const p = policy()
    return [...p.allowChats, ...p.noMentionChats]
  }
  const resolveChat = (name) => {
    const e = directory.entry(name)
    if (!e) return null
    return { chatId: e.chatId, isDM: e.kind === 'dm', displayName: e.fullName || e.displayName }
  }
  /** 能当发送目标的规范名：只有 exact / resolved；其余原样返回，交给上层拒绝。 */
  const canonicalName = (name) => {
    const e = directory.entry(name)
    if (e && (e.nameConfidence === 'exact' || e.nameConfidence === 'resolved') && e.fullName) return e.fullName
    return String(name ?? '').trim()
  }
  let lastDirSig = ''
  let lastDirMerge = 0
  /** 合并一页侧栏；内容没变就不写盘。 */
  const mergeDirectory = (parsed, source = 'tree') => {
    const chats = parsed?.chats ?? []
    if (!chats.length) return null
    const sig = JSON.stringify([parsed.current ?? '', chats.map((c) => [c.name, c.unread, c.preview])])
    if (sig === lastDirSig && Date.now() - lastDirMerge < 60_000) return null
    lastDirSig = sig
    lastDirMerge = Date.now()
    try {
      return directory.merge({
        chats, current: String(parsed.current ?? ''), source,
        knownNames: knownNames(), directNames: policy().noMentionChats,
        ignoreChats: policy().ignoreChats,
      })
    } catch (err) {
      console.log('[dsh-wx] 会话目录合并失败：' + String(err?.message ?? err).slice(0, 120))
      return null
    }
  }

  // ---- 任务板 / 会话台账 / 上下文检索 ----
  // 台账只记「看到的原始消息」，不是她的记忆；记忆仍然只由 dsh-fish 的 growth_commit 写。
  // 检索结果必须先过 dsh-fish 的 guard.js；guard 不在就整行拦下，宁可查不到也不放原文。
  let guardWarned = false
  const sanitizeForHer = (text) => {
    let g
    try { g = ctx.get?.('fishGuard') } catch { g = null }
    if (g?.sanitizeForeign) return g.sanitizeForeign(String(text ?? ''))
    if (!guardWarned) {
      guardWarned = true
      console.log('[dsh-wx] fishGuard 没接上，检索结果暂不显示原文')
    }
    return { text: '', dropped: String(text ?? '').trim() ? 1 : 0 }
  }
  const vectorProvider = createVectorProvider({
    log: (m) => console.log('[dsh-wx] 向量检索：' + m),
  })
  const contextStore = createContextStore({
    sanitize: sanitizeForHer,
    vectorProvider: (req) => vectorProvider.provider(req),
    resolveChat,
    log: (m, err) => console.log('[dsh-wx] 上下文：' + String(m ?? '') + (err ? '（' + String(err?.message ?? err).slice(0, 120) + '）' : '')),
  })
  // 人物名册是派生索引：只增不删，写坏了按空名册处理，不影响台账。
  const people = createPeople({
    log: (m) => console.log('[dsh-wx] 人物名册：' + String(m ?? '').slice(0, 160)),
  })
  // 她自己发出去、回执确认过的原文。发言人归因只认这批，绝不从正文猜。
  const outbox = []
  const noteOutbox = (chat, text) => {
    outbox.push({ chat: String(chat ?? ''), text: String(text ?? ''), at: Date.now() })
    if (outbox.length > 40) outbox.splice(0, outbox.length - 40)
  }
  const outboxFor = (chat) => outbox.filter((x) => sameName(x.chat, chat)).slice(-20)

  let captureWarned = false
  /** 把当前打开会话的消息区记进台账。发言人和方向按 speaker.js 的证据分层。 */
  const captureCurrent = (s, p) => {
    try {
      if (!s?.parsed?.ok || s.source === 'ocr') return
      const chat = String(s.parsed.current ?? '').trim()
      if (!chat) return
      // 服务号会话不采集：连引用作者都不学，避免把系统消息里出现的人名当成联系人。
      if (isIgnoredChat(chat, p.ignoreChats)) return
      const entry = directory.entry(chat)
      const row = (s.parsed.chats ?? []).find((c) => sameName(c.name, chat)) ?? null
      const messages = normalizeMessages(s.parsed.messages ?? [], { now: Date.now() })
      for (const m of messages) {
        if (m.quote?.author) people.learn({ name: m.quote.author, source: 'quote', chatId: directory.idFor(chat) })
      }
      if (!messages.length) return
      const captured = contextStore.capture({
        chat,
        messages,
        source: 'tree',
        preview: row?.preview ?? entry?.lastPreview ?? '',
        isDM: entry?.kind === 'dm' ? true : null,
        outbox: outboxFor(chat),
        ignoreChats: p.ignoreChats,
      })
      // 当前会话的最近一屏留给 maybeOcrCurrent 补发言人用。
      if (captured?.ok) lastCurrentCapture = { chat, chatId: directory.idFor(chat), messages }
      // 留给耳朵判断「当前打开的会话有没有新入站消息」：侧栏没有未读也叫得醒。
      return captured
    } catch (err) {
      if (!captureWarned) {
        captureWarned = true
        console.log('[dsh-wx] 台账记不下（不影响收发）：' + String(err?.message ?? err).slice(0, 120))
      }
    }
    return null
  }

  // 侧栏预览入账：只读当前列表，不点开、不滚动、不清未读。
  // 返回本轮每一行的 prevSig/sig，供后台轮转在更新快照前做入队判断。
  const recordPreviews = createPreviewRecorder({
    policy,
    contextStore,
    directory,
    people,
    log: (line) => console.log('[dsh-wx] ' + line),
  })
  const RECENT_FILE = '/home/str1k3/.dsh-wx/recent-chats.json'
  const RECENT_MS = 30 * 60_000
  let recent = []
  try {
    const raw = JSON.parse(readFileSync(RECENT_FILE, 'utf8'))
    if (Array.isArray(raw)) {
      recent = raw
        .map((x) => ({ chat: String(x?.chat ?? '').trim(), at: Number(x?.at) || 0 }))
        .filter((x) => x.chat && Date.now() - x.at <= RECENT_MS)
    }
  } catch { /* 没有就没有：第一次收到微信通知时会写 */ }

  const saveRecent = () => {
    try {
      mkdirSync(dirname(RECENT_FILE), { recursive: true })
      writeFileSync(RECENT_FILE, JSON.stringify(recent), { mode: 0o600 })
    } catch { /* 记不下不影响这一轮；提醒会因为「最近没叫醒过这个会话」被拒，不会乱发 */ }
  }

  /** 记下这一轮把哪些会话递给了她。定时提醒只能定到这些会话。 */
  const noteRecent = (chats, at = Date.now()) => {
    const map = new Map()
    for (const x of recent) if (at - x.at <= RECENT_MS) map.set(x.chat, x)
    for (const c of chats ?? []) {
      const name = String(c ?? '').trim()
      if (name) map.set(name, { chat: name, at })
    }
    recent = [...map.values()].slice(-20)
    saveRecent()
  }

  /** 最近叫醒过她的会话名（去重，最近的在后）。 */
  const recentChats = (withinMs = RECENT_MS) => {
    const now = Date.now()
    return [...new Set(recent.filter((x) => now - x.at <= withinMs).map((x) => x.chat))]
  }

  const isRecentChat = (chat, withinMs = RECENT_MS) => recentChats(withinMs).some((n) => sameName(n, chat))

  // 通道隔离：工具名单是全局的，QQ 会话里也看得到 wx_*。QQ 里的对话不该顺手去操作微信，这里在执行层拦住。
  // （主机自己在 web 界面里和她对话时放行，调试要用。）
  const deny = (exec) => {
    if (String(exec?.agent?.session?.id ?? '').startsWith('onebot-')) throw new Error('微信工具在 QQ 会话里不可用。')
  }

  // ---- 主机优先（2026-10-30）----
  // 主机在对话框里问她事，和微信通知落在同一个会话里。以前她会在答主机的半路被微信通知拽走，
  // 或者主机问“用第一性原理拆这道辩题”，她自己去 wx_peek 找到相关的群，把答案发到群里。
  // 这里记主机最近一句话：它没有提微信/发送的意思时，发送被拒、耳朵也不在这一轮里插话。
  let hostState = null // { at, active, intent }
  const HOST_BLOCK_MS = 30 * 60_000   // 这么久之内、主机没吩咐过微信，就不替他往微信里发
  const HOST_BUSY_MS = 10 * 60_000    // 主机这一轮还没答完的最长等待（防 turn/end 丢失）
  const WX_INTENT = /微信|群|私聊|单聊|发给|发到|发一|发过去|发出去|转发|转告|转达|告诉(她|他|对方|大家)|跟[^，。,.\s]{1,12}(说|讲|聊|问)|对[^，。,.\s]{1,10}说|帮我(跟|给|去|回|问|说)|回(她|他|一下|复|话|消息|信息|人|个|句)|问(一下|下|她|他)|看(下|看|一眼)|有没有(要)?回|待回|@|开解|安慰|劝/
  const hostWantsWx = (text) => {
    const t = String(text ?? '')
    if (WX_INTENT.test(t)) return true
    const low = t.toLowerCase()
    // 点到了允许名单里的会话名（或它的前几个字），也算他在说微信
    return policy().allowChats.some((n) => {
      const k = String(n).toLowerCase()
      return k.length >= 2 && (low.includes(k) || low.includes(k.slice(0, Math.max(2, Math.min(4, k.length)))))
    })
  }
  const hostBlocksSend = () => !!hostState && !hostState.intent && Date.now() - hostState.at < HOST_BLOCK_MS
  const hostBusy = () => !!hostState && hostState.active && Date.now() - hostState.at < HOST_BUSY_MS

  // ---- 后台轮转采集（M2）----
  // 队列只在首次用到时按当时的 policy 创建；之后改配置要等重启才生效。
  let captureQueue = null
  let lastCaptureAttemptAt = 0
  let quietUntil = 0
  let lastCurrentOcrAt = 0
  let lastCurrentCapture = null   // captureCurrent 存下的 { chat, chatId, messages }
  let roundPreview = null         // 本轮 recordPreviews 的返回值，供 captureTick 入队
  const pendingCaptureHits = []   // 采集补扫到的 @，等下一轮投递
  const capturedSinceStart = new Set()
  let captureHealth = { paused: false, pauseReason: '', queued: 0, lastAt: '', lastChat: '', lastResult: '', lastError: '' }
  let lastPauseLog = { reason: '', at: 0 }

  function ensureCaptureQueue(p) {
    if (!captureQueue) {
      captureQueue = createCaptureQueue({
        queueMax: p.capture.queueMax,
        cooldownMs: p.capture.chatCooldownSec * 1000,
      })
    }
    return captureQueue
  }

  // 流水账 + 读气氛：由 dsh-mem 提供。拿不到就当没有，微信照常工作。
  // 依赖方向是 dsh-wx → dsh-mem（和上面的说话频率同一个办法：动态 import 一个固定路径）。
  let feed = null
  import(MEM_LIVE).then((m) => {
    feed = m.createWxFeed({ log: (s) => console.log('[dsh-wx] 流水账：' + s) })
    console.log('[dsh-wx] 流水账已接上（dsh-mem/livewx）')
  }).catch((e) => console.log('[dsh-wx] 没接上流水账（dsh-mem 不可用）：' + String(e?.message ?? e).slice(0, 120)))

  const treeStats = { calls: 0, lastMs: 0, since: Date.now() }
  const fresh = createFreshness((m) => console.log('[dsh-wx] 树：' + m))
  // 树的重试发生在两段：插件刚挂上（init），以及**检测到微信被重启过**（recover）。
  // 微信常常比用户级无障碍总线先启动，Qt 的桥只连一次，总线晚到就永远空树；
  // 重启微信（systemd Restart、工作台按钮、手动）也会重演这件事。
  // 其余使用中掉树只写 health/工作台提醒，绝不自动重启。
  const TREE_RESTART_MAX = 2
  const TREE_RESTART_COOLDOWN_MS = 45_000
  const TREE_RESTART_SETTLE_MS = 45_000
  // 单次 down 采样不下结论：树必须持续掉这么久才允许重启。
  const TREE_DOWN_CONFIRM_MS = 90_000
  // 看到登录页后的保护窗口：登录成功瞬间主窗口先出现、树后挂上，此时重启会踢掉登录。
  const TREE_LOGIN_LATCH_MS = 300_000
  let treePhase = 'init'
  let treeAttempts = 0
  let treeLastRestartAt = 0
  let treeLastLoginAt = 0
  // 上一次看到的微信 MainPID；变了 = 它被重启过（0 = 还没读到基线）。
  let treePid = 0
  // 刚挂上的头 20 秒只观察：微信/宿主可能正在启动，别把正在拉起的进程又杀一遍。
  let treeRetryAfter = Date.now() + 20_000
  let treeAlert = ''
  let treeLast = null
  let treeStatus = ''
  let treeSince = Date.now()

  /**
   * 取一份快照：像素(前) → 树 → 像素(后) → 鼠标。
   * 像素区域来自上一份树里的会话列表位置；第一次没有区域就只取树。
   */
  let lastRegion = null
  async function snapshot({ pixels = true } = {}) {
    const t0 = Date.now()
    let hash0 = ''
    const prevRegion = lastRegion
    if (pixels && prevRegion) hash0 = await run(['pixhash', ...Object.values(prevRegion).map(String)], 15_000).catch(() => '')
    const raw = await run(['tree'], 60_000)
    treeStats.calls++
    treeStats.lastMs = Date.now() - t0
    const parsed = parseTree(raw)
    // 流水账：屏幕上出现的新消息当场记下（耳朵每 5 秒也走这里，所以她没点开的会话里的新话也记得到）
    try { feed?.observe(parsed) } catch { /* 记不下不影响用 */ }
    const region = pixels ? sidebarRegion(parsed) : null
    let hash = ''
    if (region) {
      hash = await run(['pixhash', ...Object.values(region).map(String)], 15_000).catch(() => '')
      lastRegion = region
    }
    const mouse = await run(['mouse'], 5_000).catch(() => '')
    return {
      raw, parsed, region,
      hash0: region && prevRegion && JSON.stringify(region) === JSON.stringify(prevRegion) ? hash0 : '',
      hash, mouse, at: Date.now(), digest: contentDigest(parsed),
      tree: treeHealth(raw, parsed),
    }
  }

  let lastReconciled = ''
  async function ocrRead() {
    const raw = await run(['ocr'], 60_000)
    let data
    try { data = JSON.parse(raw) } catch { throw new Error('OCR 返回了无效 JSON') }
    const parsed = ocrSnapshot(data, { trigger: policy().trigger })
    // 侧栏会把长名字截断（「星晓家园10号楼13...」），OCR 读到的只是前一段。
    // 在名单里能找到唯一全名时改写成全名，免得 @ 戳和发送闸对到两个不同的键。
    const p = policy()
    const names = [...p.allowChats, ...p.noMentionChats]
    parsed.chats = (parsed.chats ?? []).map((chat) => {
      if (chat?.source !== 'ocr') return chat
      const full = reconcileChatName(chat.name, names)
      return full && !sameName(full, chat.name) ? { ...chat, name: full, ocrName: chat.name } : chat
    })
    const fixed = parsed.chats.filter((chat) => chat.ocrName)
    const note = fixed.map((chat) => `${chat.ocrName}→${chat.name}`).join('、')
    if (note && note !== lastReconciled) {
      lastReconciled = note
      console.log('[dsh-wx] OCR 名字对账：' + note)
      logInbound({ type: 'ocr-reconciled', chats: fixed.map((chat) => ({ ocr: chat.ocrName, chat: chat.name })) })
    }
    return { ...data, parsed }
  }

  /** 取快照并对账。疑似落后时，隔一会儿再看一次再下结论。 */
  async function look({ confirm = true, capture = false } = {}) {
    let s
    try {
      s = await snapshot()
    } catch (error) {
      const recovered = await ocrRead()
      if (!recovered?.parsed?.reliable) throw error
      s = {
        raw: '', parsed: recovered.parsed, region: null, hash0: '', hash: '', mouse: '',
        at: Date.now(), digest: contentDigest(recovered.parsed), source: 'ocr',
        tree: treeHealth('', null),
      }
    }
    // 窗口在、会话列表却是空的：这是 AT-SPI 截断的典型样子（树头还在，行没出来）。
    // 直接拿它去点会话名会报「会话列表：（空）」。隔一会儿再看一次；还空就退 OCR。
    const emptySidebar = (x) => x?.parsed?.ok && Number(x?.parsed?.window?.w) >= 400 && (x.parsed.chats?.length ?? 0) === 0
    if (emptySidebar(s)) {
      await sleep(350)
      const again = await snapshot().catch(() => null)
      if (again?.parsed?.ok && (again.parsed.chats?.length ?? 0) > 0) s = again
    }
    if ((!s.parsed?.ok && !s.parsed?.current && !s.parsed?.chats?.length) || emptySidebar(s)) {
      try {
        const recovered = await ocrRead()
        if (recovered?.parsed?.reliable && (recovered.parsed.chats?.length ?? 0) > 0) {
          s = { ...s, parsed: recovered.parsed, source: 'ocr' }
        }
      } catch { /* keep the tree response */ }
    }
    const wasStale = Boolean(fresh.stale)
    let v = fresh.observe(s)
    if (confirm && v === 'suspect') {
      await sleep(1200)
      s = await snapshot()
      v = fresh.observe(s)
    }
    // 刚被判成「落后」：用 OCR（它读的是屏幕）复核一次。像素变了树没变，
    // 也可能是我们自己关了浮层、悬停高亮、主题变化——这些树本来就不体现。
    // OCR 的行和顺序都对得上就撤掉判定；OCR 读不成或对不上（真落后）就保持。
    if (!wasStale && fresh.stale && s.source !== 'ocr') {
      try {
        const ocr = await ocrRead()
        if ((ocr?.parsed?.reliable ?? ocr?.reliable) && treeMatchesOcr(s.parsed, ocr.parsed)) {
          const n = ocr.parsed.chats?.length ?? 0
          fresh.agree(`OCR 复核：屏幕上的 ${n} 行与树内容、顺序一致，撤掉落后判定`)
        }
      } catch { /* OCR 不可用时保持落后判定 */ }
    }
    treeLast = s.tree ?? treeHealth(s.raw, s.parsed)
    if (treeLast.status !== treeStatus) {
      treeStatus = treeLast.status
      treeSince = Date.now()
    }
    writeHealth()
    mergeDirectory(s.parsed, s.source === 'ocr' ? 'ocr' : 'tree')
    if (capture) s.capturedCurrent = captureCurrent(s, policy())
    return s
  }

  function writeHealth() {
    try {
      writeFileSync(HEALTH, JSON.stringify({
        at: new Date().toISOString(),
        stale: fresh.stale ? { since: new Date(fresh.stale.since).toISOString() } : null,
        treeCalls: treeStats.calls,
        lastTreeMs: treeStats.lastMs,
        // 工作台据此显示「树掉了/正在重启」；使用中掉树只写这里，不重启。
        tree: treeLast ? {
          ...treeLast,
          phase: treePhase,
          since: new Date(treeSince).toISOString(),
          attempts: treeAttempts,
          lastRestartAt: treeLastRestartAt ? new Date(treeLastRestartAt).toISOString() : null,
          alert: treeAlert || '',
        } : null,
        capture: captureHealth,
        events: fresh.events.slice(-20),
      }, null, 2))
    } catch { /* 写不了不影响用 */ }
  }

  const jsonLine = (text) => {
    const line = String(text ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop()
    try { return line ? JSON.parse(line) : null } catch { return null }
  }

  /** 微信主进程 PID；读不到就 0（不影响本轮观测）。 */
  async function readTreePid() {
    const r = await run(['pid'], 10_000).then(jsonLine).catch(() => null)
    return Number(r?.pid) > 0 ? Number(r.pid) : 0
  }

  /**
   * 看一次树并推进状态机。只由耳朵调用：工具调用（wx_peek 等）不触发重启。
   * 返回 treeAction 的决定，restart=true 时由调用方执行 recoverTree。
   */
  function observeTree(s) {
    const h = s?.tree ?? treeHealth(s?.raw, s?.parsed)
    treeLast = h
    if (h.status !== treeStatus) {
      treeStatus = h.status
      treeSince = Date.now()
      if (h.status === 'ok') console.log(`[dsh-wx] 树恢复：${h.elements} 个元素、${h.chats} 个会话`)
      else console.log(`[dsh-wx] 树状态：${h.status}（元素 ${h.elements}、会话 ${h.chats}）`)
    }
    if (h.status === 'login' || h.login) treeLastLoginAt = Date.now()
    const act = treeAction({
      health: h,
      phase: treePhase,
      attempts: treeAttempts,
      lastRestartAt: treeLastRestartAt,
      retryAfter: treeRetryAfter,
      now: Date.now(),
      maxAttempts: TREE_RESTART_MAX,
      cooldownMs: TREE_RESTART_COOLDOWN_MS,
      statusSince: treeSince,
      lastLoginAt: treeLastLoginAt,
      confirmMs: TREE_DOWN_CONFIRM_MS,
      loginLatchMs: TREE_LOGIN_LATCH_MS,
    })
    treePhase = act.phase
    const prevAlert = treeAlert
    if (act.healthy) {
      treeAttempts = 0
      treeRetryAfter = 0
      treeAlert = ''
    } else if (act.alert) {
      treeAlert = act.alert
      if (treeAlert !== prevAlert) console.log('[dsh-wx] 树：' + treeAlert)
    }
    writeHealth()
    return act
  }

  /**
   * 只在初始化阶段执行：先确保用户级无障碍总线存在，再重启微信；
   * 次数和冷却由 treeAction 控制，用尽后自动转入 steady，只提醒。
   */
  async function recoverTree(act) {
    fresh.reset('微信在重启，屏幕基线作废') // 重启会换窗口，旧像素基线没有意义
    const when = treePhase === 'recover' ? '微信重启后' : '初始化时'
    treeAttempts = Number(act?.attempt) || treeAttempts + 1
    treeLastRestartAt = Date.now()
    treeAlert = act?.alert || `${when}微信没连上无障碍树，准备重启`
    console.log('[dsh-wx] 树：' + treeAlert)
    logInbound({ type: 'tree-restart', attempt: treeAttempts, status: treeLast?.status, elements: treeLast?.elements, chats: treeLast?.chats })
    writeHealth()
    const bus = await run(['bus-start'], 30_000).then(jsonLine).catch((e) => jsonLine(e?.message))
    if (!bus?.ok) {
      treeRetryAfter = Date.now() + TREE_RESTART_COOLDOWN_MS
      treeAlert = `${when}读不到无障碍树，而且无障碍总线没起来：先不重启微信，等总线恢复`
      console.log('[dsh-wx] 树：' + treeAlert)
      logInbound({ type: 'tree-error', error: treeAlert, bus })
      writeHealth()
      return
    }
    try {
      const r = await run(['restart'], 90_000).then(jsonLine).catch((e) => jsonLine(e?.message))
      if (!r?.ok) throw new Error(r?.error || '重启命令没有返回 ok')
      treeRetryAfter = Date.now() + TREE_RESTART_SETTLE_MS
      treeAlert = `${when}微信没连上无障碍树，已重启微信（${r.oldPid}→${r.pid}），等树恢复`
      console.log('[dsh-wx] 树：' + treeAlert)
      logInbound({ type: 'tree-restarted', attempt: treeAttempts, ...r })
    } catch (error) {
      treeRetryAfter = Date.now() + TREE_RESTART_COOLDOWN_MS
      treeAlert = `${when}微信没连上无障碍树，重启失败：` + String(error?.message ?? error).slice(0, 120)
      console.log('[dsh-wx] 树：' + treeAlert)
      logInbound({ type: 'tree-error', error: treeAlert, attempt: treeAttempts })
    }
    writeHealth()
  }

  // ---- 发送前的闸 ----
  // 以前是 `tree.includes(名单里的名字)`：会话列表里永远有那个群，所以不管当前开着谁都放行。
  // 现在只认「当前会话」这一个字段，并且要求树没落后（落后时当前会话可能是旧的）。
  async function gateSend() {
    const p = policy()
    if (!p.enabled) throw new Error(OFF)
    if (hostBlocksSend()) {
      throw new Error('主机刚在对话框里跟你说话，没有让你发微信：答案写在对话框里，别往微信里发。他真要你发，会明说（比如“发给谁”“回她”）。')
    }
    const s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，无法确认当前会话，不发送。')
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认当前会话，不发送。' + fresh.notice().trim())
    if (!s.parsed.current) throw new Error('读不到当前会话名（可能没打开任何聊天），不发送。')
    // 「这些会话不用 @」是最高权限：既不用等 @，也不用先进允许名单——它自己就是白名单。
    const exempt = p.noMentionChats.find((n) => sameName(n, s.parsed.current)) ?? null
    const hit = allowedCurrent(s.parsed, p.allowChats) || exempt
    if (!hit) {
      if (p.allowChats.length === 0) throw new Error('允许名单为空，不能发送。')
      throw new Error(`当前会话是「${s.parsed.current}」，不在允许名单内（${p.allowChats.join('、')}），不发送。`)
    }
    // @ 才回：只有最近被 @ 过的会话才开口（QQ 那边是同一条规矩，按条判；微信只能按会话判）
    if (p.requireMention && !exempt) {
      const verdict = canSpeak(readMentions(), hit, Date.now(), p.mentionWindowMinutes)
      if (!verdict.ok) throw new Error(`「${hit}」${verdict.reason}，先不发。`)
    }
    return { chat: hit, snap: s }
  }

  // ---- @ 才回：谁最近被 @ 过 ----
  // 耳朵看见侧栏有人 @ 她 → 盖戳；发送前查这里。手动 poke 也会盖。
  const MENTIONS = '/home/str1k3/.dsh-wx/mentions.json'
  const readMentions = () => {
    try { return JSON.parse(readFileSync(MENTIONS, 'utf8')) || {} } catch { return {} }
  }
  const saveMentions = (state) => {
    try {
      mkdirSync(dirname(MENTIONS), { recursive: true })
      writeFileSync(MENTIONS, JSON.stringify(pruneMentions(state, Date.now()), null, 2))
    } catch { /* 记不下就当她没被 @，宁可不说话 */ }
  }
  // ---- 说话频率 ----
  // 工作台里一个开关管两个通道：策略在 /home/str1k3/dsh-plugins/speech/speech.json，每次都现读。
  // 间隔不够就等（等到就说），额度用完就不发（说清楚地说了几条），不静默丢话。
  let speechMod
  let speechTried = false
  async function speech() {
    if (!speechTried) {
      speechTried = true
      try { speechMod = await import(SPEECH) } catch { speechMod = null }
    }
    return speechMod
  }
  async function speechGate(chatName) {
    const mod = await speech()
    if (!mod) return
    const v = await mod.waitAndAdmit('wx:' + chatName, 45_000)
    if (!v.ok) throw new Error('说话频率：' + v.reason + '。')
  }

  // ---- 高层发送：wx_send 与到点提醒共用 ----
  // wx_type 依赖「当前焦点已经在输入框」，那是给逐步操作用的。定时提醒到点时
  // 不能假设窗口正停在哪个会话，所以这里自己点会话、点输入框、核对、再回车。
  // 所有高层发送串行：两个提醒同时到点时，不能一个在打字、另一个来点会话。
  let sendLock = Promise.resolve()
  // 后台采集靠这个计数避开「正在发送」：打字/回车期间不点开会话。
  let sendBusy = 0
  function withSendLock(fn) {
    sendBusy += 1
    const p = sendLock.then(fn, fn)
    sendLock = p.then(() => {}, () => {})
    return p.finally(() => { sendBusy -= 1 })
  }

  /**
   * 把一句话发到指定会话。永不自己吞错：发不出去就抛，让调用方如实说。
   * permit 存在时只绕过 @ / 主机闸；允许名单、说话频率、当前会话核对都照走。
   */
  async function sendToChat({ chat, text, permit = '', taskId = '' } = {}) {
    const p = policy()
    if (!p.enabled) throw new Error(OFF)
    const want = String(chat ?? '').trim()
    const body = String(text ?? '')
    if (!want) throw new Error('wx_send: chat 不能为空。')
    if (!body) throw new Error('wx_send: text 不能为空。')
    if (/[\r\n]/.test(body)) throw new Error('wx_send: 文本含换行，会被拆成多条发送。')
    if ([...body].length > 500) throw new Error('wx_send: 文本超过 500 字。')

    const allowed = canSendWithPolicy(p, want)
    if (!allowed.ok) throw new Error(allowed.why)

    const token = String(permit ?? '').trim()
    if (token) {
      // 到点提醒：许可绑定会话 + 原文 + 一次性。这里只查，不消费。
      const v = permitStore.check({ id: token, chat: allowed.chat, text: body })
      if (!v.ok) throw new Error('提醒许可：' + v.why)
    }

    let s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，无法确认会话，不发送。')
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不发送。' + fresh.notice().trim())

    if (!sameName(s.parsed.current, allowed.chat)) {
      const target = s.parsed.chats.find((c) => sameName(c.name, allowed.chat))
      if (!target) throw new Error(`会话列表里没有「${allowed.chat}」，不发送。`)
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset()
      await run(['click', String(target.box.cx), String(target.box.cy), '1'])
      await sleep(700)
      s = await look({ confirm: false })
      if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不发送。' + fresh.notice().trim())
      if (!sameName(s.parsed.current, allowed.chat)) {
        throw new Error(`点了「${allowed.chat}」，但当前会话是「${s.parsed.current || '读不到'}」，不发送。`)
      }
    }

    if (!token) {
      // 许可只免 @ / 主机两道闸；频率和名单仍然要过（频率在回车前只记一次）。
      const g = await gateSend()
      if (!sameName(g.chat, allowed.chat)) throw new Error(`当前会话变成了「${g.chat}」，不是「${allowed.chat}」，不发送。`)
    }

    // 清浮层再重新读一次坐标：点开会话后布局可能变了。
    await run(['clean'], 30_000).catch(() => '')
    fresh.reset()
    s = await look({ confirm: false })
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认当前会话，不发送。' + fresh.notice().trim())
    if (!sameName(s.parsed.current, allowed.chat)) {
      throw new Error(`当前会话是「${s.parsed.current || '读不到'}」，不是「${allowed.chat}」，不发送。`)
    }
    const focus = findInputBox(s.parsed)
    if (!focus) throw new Error('找不到输入框，不发送。')
    await run(['click', String(focus.box.cx), String(focus.box.cy), '1'])
    await sleep(300)
    await run(['type', body], 60_000)

    // 回车之前再核对一次：打字期间界面可能切走。
    await sleep(300)
    if (token) {
      const again = permitStore.check({ id: token, chat: allowed.chat, text: body })
      if (!again.ok) throw new Error('提醒许可：' + again.why)
      const now = await look({ confirm: false })
      if (!sameName(now.parsed.current, allowed.chat)) {
        throw new Error(`打字期间当前会话变成了「${now.parsed.current || '读不到'}」，不发送。`)
      }
    } else {
      const g = await gateSend()
      if (!sameName(g.chat, allowed.chat)) throw new Error(`当前会话变成了「${g.chat}」，不是「${allowed.chat}」，不发送。`)
    }
    // 频率闸只在这里记一次：前面两次核对都不占额度。
    await speechGate(allowed.chat)
    // 频率闸可能要等，等完再看一眼当前会话，别在等待期间被切走。
    if (token) {
      const still = permitStore.check({ id: token, chat: allowed.chat, text: body })
      if (!still.ok) throw new Error('提醒许可：' + still.why)
      const last = await look({ confirm: false })
      if (!sameName(last.parsed.current, allowed.chat)) {
        throw new Error(`等待发送期间当前会话变成了「${last.parsed.current || '读不到'}」，不发送。`)
      }
    } else {
      const last = await gateSend()
      if (!sameName(last.chat, allowed.chat)) throw new Error(`等待发送期间当前会话变成了「${last.chat}」，不发送。`)
    }

    try { feed?.willSend(allowed.chat, body) } catch { /* ignore */ }
    await run(['key', 'Return'])
    await sleep(900)

    if (token) {
      const used = permitStore.consume({ id: token, chat: allowed.chat, text: body })
      if (!used.ok) console.log('[dsh-wx] 提醒许可作废失败：' + used.why)
    }

    const after = await look({ confirm: false })
    const typed = body.replace(/\s+/g, ' ').replace(/"/g, '＂')
    const head = typed.slice(0, 14)
    const inMsgs = after.parsed.messages.slice(-4).some((m) => m.text.includes(head))
    const chatRow = after.parsed.chats.find((c) => sameName(c.name, allowed.chat))
    const inPreview = !!chatRow && chatRow.preview.includes(head.slice(0, 10))
    const receipt = inMsgs
      ? '回执：消息已出现在列表末尾。'
      : inPreview
        ? '回执：会话列表预览已显示该内容，消息列表末尾未见。'
        : '回执：消息列表末尾和会话预览都没有看到该内容（可能未发出，或树尚未刷新），用 wx_peek 复查。'
    try {
      feed?.noteOut({
        chat: allowed.chat,
        text: body,
        receipt: receipt.replace(/^回执：/, ''),
        sent: inMsgs || inPreview ? true : 'unconfirmed',
      })
    } catch { /* ignore */ }

    // 回执确认了才落台账：没看到就不假装发过。
    let outMsgId = ''
    if (inMsgs || inPreview) {
      noteOutbox(allowed.chat, body)
      try {
        const captured = contextStore.capture({
          chat: allowed.chat,
          source: 'sent',
          taskId,
          ignoreChats: p.ignoreChats,
          messages: [{
            sender: null, senderConfidence: 'unknown', direction: 'out', kind: 'text',
            text: body, at: new Date().toISOString(), atConfidence: 'medium', source: 'sent',
          }],
        })
        outMsgId = captured.records?.at(-1)?.msgId ?? ''
      } catch { /* 台账记不下不影响已经发出的消息 */ }
    }
    // 发送本身也算一次活动：给后台采集留出静默期，别紧接着点开会话。
    quietUntil = Math.max(quietUntil, Date.now() + p.capture.quietMs)
    return { ok: true, chat: allowed.chat, receipt, sent: inMsgs || inPreview ? 'confirmed' : 'unconfirmed', outMsgId }
  }

  /**
   * 按索引 id 发一张收藏表情。与 wx_send 共用同一套闸：允许名单、@、频率、当前会话核对。
   * 表情格点下去就发送、没有二次确认，所以点之前会重新扫描面板并核对 pHash，点之后核对消息区。
   * 不写文本 outbox：表情在预览里都是 "[Sticker]"，写进去会让别人发的同款表情被当成自己的回声。
   */
  async function sendStickerToChat({ chat, id, taskId = '' } = {}) {
    const p = policy()
    if (!p.enabled) throw new Error(OFF)
    const want = String(chat ?? '').trim()
    const sid = String(id ?? '').trim()
    if (!want) throw new Error('wx_sticker_send: chat 不能为空。')
    if (!sid) throw new Error('wx_sticker_send: id 不能为空。')

    const allowed = canSendWithPolicy(p, want)
    if (!allowed.ok) throw new Error(allowed.why)

    // 先把索引核对完再碰界面：id 不存在、旧索引缺 artHash、已从收藏删除，都不打开面板。
    targetEntry(loadIndex(stickerDir).index, sid)

    let s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，无法确认会话，不发送。')
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不发送。' + fresh.notice().trim())

    if (!sameName(s.parsed.current, allowed.chat)) {
      const target = s.parsed.chats.find((c) => sameName(c.name, allowed.chat))
      if (!target) throw new Error(`会话列表里没有「${allowed.chat}」，不发送。`)
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset()
      await run(['click', String(target.box.cx), String(target.box.cy), '1'])
      await sleep(700)
      s = await look({ confirm: false })
      if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不发送。' + fresh.notice().trim())
      if (!sameName(s.parsed.current, allowed.chat)) {
        throw new Error(`点了「${allowed.chat}」，但当前会话是「${s.parsed.current || '读不到'}」，不发送。`)
      }
    }

    const g = await gateSend()
    if (!sameName(g.chat, allowed.chat)) throw new Error(`当前会话变成了「${g.chat}」，不是「${allowed.chat}」，不发送。`)

    // 清浮层再读一屏：回执拿这一屏当“发送前”，之后只认末尾新增的表情行。
    await run(['clean'], 30_000).catch(() => '')
    fresh.reset()
    s = await look({ confirm: false })
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认当前会话，不发送。' + fresh.notice().trim())
    if (!sameName(s.parsed.current, allowed.chat)) {
      throw new Error(`当前会话是「${s.parsed.current || '读不到'}」，不是「${allowed.chat}」，不发送。`)
    }
    const before = s.parsed.messages ?? []

    // 频率闸只记一次；等完再看一眼会话，别在等待期间被切走。
    await speechGate(allowed.chat)
    const last = await gateSend()
    if (!sameName(last.chat, allowed.chat)) throw new Error(`等待发送期间当前会话变成了「${last.chat}」，不发送。`)

    const r = await sendSticker({
      run,
      dir: stickerDir,
      id: sid,
      before,
      look: () => look({ confirm: false }),
      log: (m) => console.log('[dsh-wx] 表情发送：' + m),
    })

    // 回执确认了才落台账：没看到新增表情就不假装发过。
    let outMsgId = ''
    if (r.confirmed) {
      try {
        const captured = contextStore.capture({
          chat: allowed.chat,
          source: 'sent',
          taskId,
          ignoreChats: p.ignoreChats,
          messages: [{
            sender: null, senderConfidence: 'unknown', direction: 'out', kind: 'sticker',
            text: '[Sticker]', at: new Date().toISOString(), atConfidence: 'medium', source: 'sent',
            stickerId: sid,
          }],
        })
        outMsgId = captured.records?.at(-1)?.msgId ?? ''
      } catch { /* 台账记不下不影响已经发出的表情 */ }
    }
    quietUntil = Math.max(quietUntil, Date.now() + p.capture.quietMs)
    return { ok: true, chat: allowed.chat, ...r, outMsgId }
  }

  /**
   * 把聊天里的一条表情收藏进微信收藏。只右键气泡、点 Add Sticker，不发送任何消息。
   * 不指定 chat 时只处理当前打开的会话；指定了就必须在白名单里，不为了收藏去点陌生会话。
   */
  async function collectStickerFromChat({ chat = '', which = 1 } = {}) {
    const p = policy()
    if (!p.enabled) throw new Error(OFF)
    const want = String(chat ?? '').trim()
    let s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，不采集。')
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不采集。' + fresh.notice().trim())

    if (want) {
      const allowed = canSendWithPolicy(p, want)
      if (!allowed.ok) throw new Error(allowed.why)
      if (!sameName(s.parsed.current, allowed.chat)) {
        const target = s.parsed.chats.find((c) => sameName(c.name, allowed.chat))
        if (!target) throw new Error(`会话列表里没有「${allowed.chat}」，不采集。`)
        await run(['clean'], 30_000).catch(() => '')
        fresh.reset()
        await run(['click', String(target.box.cx), String(target.box.cy), '1'])
        await sleep(700)
        s = await look({ confirm: false })
        if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不采集。' + fresh.notice().trim())
        if (!sameName(s.parsed.current, allowed.chat)) {
          throw new Error(`点了「${allowed.chat}」，但当前会话是「${s.parsed.current || '读不到'}」，不采集。`)
        }
      }
    }

    const r = await collectSticker({
      run,
      dir: stickerDir,
      look: () => look({ confirm: false }),
      which,
      log: (m) => console.log('[dsh-wx] 表情收藏：' + m),
    })
    return { ...r, chat: s.parsed.current }
  }

  /**
   * 在表情搜索里按关键词找一张，直接发到白名单会话。
   * 搜索结果没有标签、她看不到图，pick 是盲选；点下去立即发送，没有预览确认。
   * 点之前再确认一次当前会话，避免耳朵在搜索期间把会话切走、表情发错人。
   */
  async function searchStickerInChat({ chat, keyword, pick = 0, taskId = '' } = {}) {
    const p = policy()
    if (!p.enabled) throw new Error(OFF)
    if (!p.stickerSearch) throw new Error('关键词搜索采集已关闭（policy.json 里 stickerSearch=false）。')
    const want = String(chat ?? '').trim()
    if (!want) throw new Error('wx_sticker_search: chat 不能为空。')
    const word = normalizeKeyword(keyword)

    const allowed = canSendWithPolicy(p, want)
    if (!allowed.ok) throw new Error(allowed.why)

    let s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，无法确认会话，不搜索。')
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不搜索。' + fresh.notice().trim())

    if (!sameName(s.parsed.current, allowed.chat)) {
      const target = s.parsed.chats.find((c) => sameName(c.name, allowed.chat))
      if (!target) throw new Error(`会话列表里没有「${allowed.chat}」，不搜索。`)
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset()
      await run(['click', String(target.box.cx), String(target.box.cy), '1'])
      await sleep(700)
      s = await look({ confirm: false })
      if (fresh.stale) throw new Error('树落后于屏幕，无法确认会话，不搜索。' + fresh.notice().trim())
      if (!sameName(s.parsed.current, allowed.chat)) {
        throw new Error(`点了「${allowed.chat}」，但当前会话是「${s.parsed.current || '读不到'}」，不搜索。`)
      }
    }

    const g = await gateSend()
    if (!sameName(g.chat, allowed.chat)) throw new Error(`当前会话变成了「${g.chat}」，不是「${allowed.chat}」，不搜索。`)

    // 频率闸只记一次；等完再确认会话。
    await speechGate(allowed.chat)
    const last = await gateSend()
    if (!sameName(last.chat, allowed.chat)) throw new Error(`等待发送期间当前会话变成了「${last.chat}」，不搜索。`)

    await run(['clean'], 30_000).catch(() => '')
    fresh.reset()
    s = await look({ confirm: false })
    if (fresh.stale) throw new Error('树落后于屏幕，无法确认当前会话，不搜索。' + fresh.notice().trim())
    if (!sameName(s.parsed.current, allowed.chat)) {
      throw new Error(`当前会话是「${s.parsed.current || '读不到'}」，不是「${allowed.chat}」，不搜索。`)
    }
    const before = s.parsed.messages ?? []

    const r = await searchSticker({
      run,
      look: () => look({ confirm: false }),
      keyword: word,
      pick,
      before,
      assertChat: async () => {
        const now = await look({ confirm: false })
        return now.parsed.ok && sameName(now.parsed.current, allowed.chat)
      },
      shot: join(stickerDir, 'search-panel.png'),
      log: (m) => console.log('[dsh-wx] 表情搜索：' + m),
    })

    let outMsgId = ''
    if (r.confirmed) {
      try {
        const captured = contextStore.capture({
          chat: allowed.chat,
          source: 'sent',
          taskId,
          ignoreChats: p.ignoreChats,
          messages: [{
            sender: null, senderConfidence: 'unknown', direction: 'out', kind: 'sticker',
            text: '[Sticker]', at: new Date().toISOString(), atConfidence: 'medium', source: 'sent',
          }],
        })
        outMsgId = captured.records?.at(-1)?.msgId ?? ''
      } catch { /* 台账记不下不影响已经发出的表情 */ }
    }
    quietUntil = Math.max(quietUntil, Date.now() + p.capture.quietMs)
    return { ok: true, chat: allowed.chat, ...r, outMsgId }
  }

  // 说明只挂她一个 agent：会话 cwd 就是她的屋子
  const off = ctx.on?.('agent/created', ({ agent } = {}) => {
    try {
      const cwd = String(agent?.session?.header?.cwd ?? '').replace(/\/+$/, '')
      if (cwd !== HER_DIR) return
      // QQ 会话（onebot-*）不挂微信说明：说明里的内容会被带进 QQ 的话里
      if (String(agent?.session?.id ?? '').startsWith('onebot-')) return
      console.log('[dsh-wx] 拿到她的 agent（' + String(agent?.session?.id ?? '?') + '）')
      agent.ctx?.systemPrompt?.section?.({
        name: 'channel:dsh-wx',
        order: 91,
        text: () => promptText(), // 每次组装时求值：工作台里改了开关，下一轮就是新的
      })
    } catch { /* 挂不上不影响工具 */ }
  })

  // ---------------------------------------------------------------- 耳朵
  // 判「新」：这一轮侧栏里带 @ 的会话，减去已经投递过的。
  // 「已投递」记在盘上不记在内存里：以前用内存基线，每次重启都把当时挂着的 @ 当旧消息吃掉。
  const EAR_STATE = '/home/str1k3/.dsh-wx/ear-state.json'
  const loadSeen = () => {
    try { return parseSeen(JSON.parse(readFileSync(EAR_STATE, 'utf8'))) } catch { return new Map() }
  }
  const seen = loadSeen()
  const saveSeen = () => {
    try {
      pruneSeen(seen)
      writeFileSync(EAR_STATE, JSON.stringify(serializeSeen(seen), null, 2))
    } catch { /* 存不下下次会重投，比丢了强 */ }
  }
  let busy = false
  let lastAt = 0
  let lastSig = null
  let lastNudge = 0
  let lastHeldLog = 0
  let lastFailLog = 0
  let lastRelogin = 0
  let lastScanAt = 0
  let scanning = false

  /**
   * 微信必须有自己的会话（不能借 QQ 的）：通道隔离全靠 session 分开。
   * ⚠️ 必须走宿主的 sessionController.create，不能自己 ctx.agents.create——
   * 后者没有模型接线，deployment persona 前缀里的 {{model}} 变量没人装，组装 system prompt 时直接抛。
   */
  const WX_STATE = '/home/str1k3/.dsh-wx/session.json'
  const readWxSession = () => {
    try { return String(JSON.parse(readFileSync(WX_STATE, 'utf8')).sessionId ?? '') || '' } catch { return '' }
  }
  const saveWxSession = (sessionId) => {
    try { mkdirSync('/home/str1k3/.dsh-wx', { recursive: true }) } catch { /* 有了 */ }
    try { writeFileSync(WX_STATE, JSON.stringify({ sessionId, at: new Date().toISOString() }, null, 2)) } catch { /* 存不下也不致命 */ }
  }
  let wxSessionId = readWxSession()
  // 会话池里记着主会话绑定的群；宿主换过会话 id 时同步一次，别让两本账对不上。
  if (wxSessionId) {
    const st = sessions.stats()
    if (st.mainChatId && st.mainSessionId !== wxSessionId) sessions.assignMain(st.mainChatId, wxSessionId, st.mainChatName)
  }
  {
    const offHost = ctx.on?.('session/event', (session, event) => {
      try {
        const id = session?.header?.id ?? session?.id
        if (!id || !isWxSession(id)) return
        if (event?.type === 'turn/end') { if (hostState) hostState.active = false; return }
        if (event?.type !== 'user/message') return
        if (!isHostChatSource(event?.data?.source)) return
        const text = (event?.data?.content ?? []).map((c) => (c && c.type === 'text' ? c.text : '')).join('')
        // 微信通道的通知（含主机手动 poke 的 [微信·主机]）：说明这一轮本来就是为微信开的
        if (/^\s*\[微信/.test(text)) { hostState = null; return }
        // 一个括号里的叫醒信号 / 空文本：不是主机在说话
        if (!text.trim() || /^\s*[（(][^）)]{0,20}[）)]\s*$/.test(text)) return
        hostState = { at: Date.now(), active: true, intent: hostWantsWx(text) }
      } catch { /* 记不下就当没有这条保护，不影响工具 */ }
    })
    if (typeof offHost === 'function') disposers.push(offHost)
  }
  const controller = () => {
    try { return ctx.get?.('sessionController') } catch { return undefined }
  }
  const ensureWxSession = async () => {
    if (wxSessionId) return wxSessionId
    const sc = controller()
    if (!sc?.create) throw new Error('sessionController 还没起来（等工作区）')
    // 先预分配 id 再建会话：宿主可能在 create 还没返回时就触发 agent/created，
    // 面注册表必须在那之前就认得这个会话。宿主不认 sessionId 时回退旧调用。
    const requested = randomUUID()
    reserveWxSession(requested)
    let created = null
    try {
      created = await sc.create({ cwd: HER_DIR, sessionId: requested })
    } catch {
      created = null
    }
    let id = String(created?.sessionId ?? created?.id ?? '')
    if (!id) {
      created = await sc.create({ cwd: HER_DIR })
      id = String(created?.sessionId ?? created?.id ?? '')
    }
    reserveWxSession(id)
    if (!id) throw new Error('宿主建了会话但没给 id')
    wxSessionId = id
    saveWxSession(id)
    const st = sessions.stats()
    if (st.mainChatId) sessions.assignMain(st.mainChatId, id, st.mainChatName)
    console.log('[dsh-wx] 微信会话：' + id)
    return id
  }

  /** 一个群一个会话：主会话管第一个群，其余按 chatId 分配 worker；满了回落主会话。 */
  const sessionForChat = async (chatName, chatId) => {
    const main = await ensureWxSession()
    const st = sessions.stats()
    if (!st.mainChatId) {
      sessions.assignMain(chatId, main, chatName)
      return main
    }
    if (st.mainChatId === chatId) return main
    const existing = sessions.sessionFor(chatId)
    if (existing) return existing
    const sc = controller()
    if (!sc?.create) return main
    if (sessions.list().length >= sessions.limit - 1) return main
    try {
      const requested = randomUUID()
      reserveWxSession(requested)
      let created = null
      try {
        created = await sc.create({ cwd: HER_DIR, sessionId: requested })
      } catch {
        created = null
      }
      let id = String(created?.sessionId ?? created?.id ?? '')
      if (!id) {
        created = await sc.create({ cwd: HER_DIR })
        id = String(created?.sessionId ?? created?.id ?? '')
      }
      reserveWxSession(id)
      if (!id) return main
      const r = sessions.assign(chatId, id, chatName)
      if (!r.ok) return main
      console.log('[dsh-wx] 会话池：' + chatName + ' → ' + id)
      return id
    } catch (err) {
      console.log('[dsh-wx] 会话池建 worker 失败，回落主会话：' + String(err?.message ?? err).slice(0, 120))
      return main
    }
  }

  /** 投递到指定的群会话；会话没了就清映射、重试主会话。 */
  const deliverToChat = async (chatName, chatId, text) => {
    const sid = await sessionForChat(chatName, chatId)
    try {
      await deliver(sid, text)
      return sid
    } catch (err) {
      if (!/not-found|unknown session|no such session/i.test(String(err?.message ?? err))) throw err
      sessions.remove(chatId)
      if (sid === wxSessionId) {
        wxSessionId = ''
        saveWxSession('')
      }
      const main = await ensureWxSession()
      await deliver(main, text)
      return main
    }
  }
  const early = setTimeout(() => {
    ensureWxSession().catch((e) => console.log('[dsh-wx] 还建不了微信会话（下一轮再试）：' + String(e?.message ?? e).slice(0, 120)))
  }, 12_000)
  early.unref?.()

  /** 第二个参数是 AbortSignal：宿主这个 Remote 方法开头就 signal.throwIfAborted()，不传会抛。 */
  const deliver = (sessionId, text) => controller().prompt({
    sessionId,
    requestId: randomUUID(),
    content: [{ type: 'text', text }],
  }, new AbortController().signal)

  /** chatId → 目录里的全名；目录还没记住就空。 */
  const chatNameOfId = (chatId) => {
    const id = String(chatId ?? '').trim()
    if (!id) return ''
    const e = directory.all().find((x) => x.chatId === id)
    return e?.fullName || e?.displayName || ''
  }

  /**
   * 侧栏跨页扫描：只滚列表，不点开会话。滚完回到顶部，下一轮重新对账。
   * 有草稿时不扫（滚动可能把草稿弄丢）。
   */
  const scanDirectoryNow = async () => {
    if (scanning) return { ok: false, why: 'already-scanning' }
    scanning = true
    try {
      const res = await scanSidebar({
        read: async () => {
          const s = await snapshot({ pixels: false }).catch(() => null)
          return s?.parsed?.ok ? { ok: true, parsed: s.parsed } : { ok: false }
        },
        scroll: ({ x, y, direction, times }) => run(['scroll', String(x), String(y), direction, String(times)], 15_000),
        sleep,
        maxPages: 8,
      })
      if (!res.ok) return res
      const merged = mergeScanned(res.chats)
      directory.merge({
        chats: merged, current: '', source: 'scan',
        knownNames: knownNames(), directNames: policy().noMentionChats,
        ignoreChats: policy().ignoreChats,
      })
      fresh.reset('目录扫描滚动了侧栏，旧基线作废')
      console.log(`[dsh-wx] 目录扫描：${res.pages} 页、${merged.length} 个会话（${res.reason}）`)
      logInbound({ type: 'directory-scan', pages: res.pages, chats: merged.length, reason: res.reason, complete: res.complete })
      return res
    } finally {
      scanning = false
    }
  }

  // 逾期提醒节奏：建任务后 15 分钟第一次，之后 +45 分钟、+3 小时；第三次后卡住等人工。
  const REMIND_NEXT_MS = { 1: 45 * 60_000, 2: 3 * 3600_000, 3: 60_000 }
  let reminderBusy = false
  let lastMaintainAt = 0
  const overdueText = (t, level) => {
    const waited = Math.max(0, Date.now() - Date.parse(String(t.updatedAt || t.createdAt || '')) / 1)
    const mins = Math.round(waited / 60_000)
    const howLong = mins < 60 ? `${mins} 分钟` : `${Math.floor(mins / 60)} 小时`
    return [
      `[微信·逾期] 「${t.chatName || chatNameOfId(t.chatId) || t.chatId}」还有一件事没处理（第 ${level} 次提醒，已等 ${howLong}）`,
      `   任务：${t.taskId}`,
      `   谁：${t.requester?.name || '发言人未识别'}${t.reason ? `（${t.reason}）` : ''}`,
      `   最后一条：「${String(t.lastText ?? '').slice(0, 120)}」`,
      '   要么去回，要么用 wx_task_snooze 推迟，确实不用回就用 wx_task_done 说明原因。',
    ].join('\n')
  }

  /**
   * 逾期泵：每分钟看一次。只催她，不替她发；投递失败不记提醒，下一分钟再来。
   */
  const reminderPump = async () => {
    if (reminderBusy || hostBusy()) return
    const p = policy()
    if (!p.enabled || p.watch === false) return
    const due = contextStore.board.overdueReminders({ maxLevel: 3 })
    if (!due.length) return
    reminderBusy = true
    try {
      for (const t of due) {
        const chat = canonicalName(t.chatName || chatNameOfId(t.chatId))
        if (!chat) continue
        const level = Math.min(3, (Number(t.overdueCount) || 0) + 1)
        try {
          await deliverToChat(chat, t.chatId, overdueText(t, level))
        } catch (err) {
          console.log('[dsh-wx] 逾期提醒投不进去（' + chat + '）：' + String(err?.message ?? err).slice(0, 120))
          continue
        }
        // 提醒本身也算叫了她一次：这个会话的 @ 窗口重新打开，才允许回。
        saveMentions(grant(readMentions(), chat, Date.now()))
        noteRecent([chat])
        const next = new Date(Date.now() + (REMIND_NEXT_MS[level] ?? REMIND_NEXT_MS[3])).toISOString()
        contextStore.board.markReminded(t.taskId, { level, nextCheckAt: next, note: `第 ${level} 次逾期提醒` })
        if (level >= 3) {
          contextStore.board.block(t.taskId, { why: '连续多次逾期提醒后仍未处理', uncertain: true })
        }
        console.log(`[dsh-wx] 逾期提醒 ${level}/3 → ${chat}（${t.taskId}）`)
        logInbound({ type: 'overdue-reminded', taskId: t.taskId, chatId: t.chatId, chat, level })
      }
    } finally {
      reminderBusy = false
    }
  }

  /** 每小时最多一次：台账归档 + 昨天的摘要。失败只记日志。 */
  const maintain = () => {
    if (Date.now() - lastMaintainAt < 3600_000) return
    lastMaintainAt = Date.now()
    try {
      const r = contextStore.maintain()
      if (r.archive.archived.length || r.summaries.written.length) {
        console.log(`[dsh-wx] 维护：归档 ${r.archive.archived.length} 个文件、摘要 ${r.summaries.written.length} 天`)
      }
    } catch (err) {
      console.log('[dsh-wx] 维护失败：' + String(err?.message ?? err).slice(0, 120))
    }
  }

  // ---- 对 dsh-fish 暴露的服务 ----
  // 她自己的插件（dsh-fish）不能直接碰 wx.sh，只能通过这个窄接口拿许可 / 问名单。
  // 发送仍然由 wx_send 走上面的 CUA 流程；fish 拿不到点、打字的原语。
  const isWxSession = (id) => {
    const s = String(id ?? '')
    if (!s) return false
    if (s === wxSessionId || s === readWxSession()) return true
    return sessions.sessionIds().includes(s)
  }
  /** 某个微信会话负责哪个群；主会话负责池里记的那个群，worker 负责自己那个。 */
  const chatNameOfSession = (sessionId) => {
    const sid = String(sessionId ?? '')
    if (!sid) return ''
    const st = sessions.stats()
    if (st.mainSessionId && sid === st.mainSessionId) return st.mainChatName || ''
    return sessions.list().find((w) => w.sessionId === sid)?.chatName || ''
  }
  const canSend = (chat) => canSendWithPolicy(policy(), chat)
  const wxService = {
    policy,
    canSend,
    recentChats,
    inboxSummary: (opts) => contextStore.summary(opts),
    inbox: () => contextStore.inbox(),
    isWxSession: (sessionId) => isWxSession(sessionId),
    // 会话还在创建中 / 尚未落到 wxSessionId 或会话池时也能认出来。
    isReservedSession: (id) => reservedWxSessions.has(String(id ?? '')),
    currentChat: (sessionId) => (isWxSession(sessionId)
      ? (chatNameOfSession(sessionId) || recentChats().at(-1) || '')
      : ''),
    isRecentChat: (sessionId, chat, withinMs) => isWxSession(sessionId) && isRecentChat(chat, withinMs),
    grantReminder: ({ id, chat, text, sessionId, dueAt, ttlMs } = {}) => {
      if (!isWxSession(sessionId)) return { ok: false, why: '定时提醒只能在微信这条会话里定。' }
      const c = canSend(chat)
      if (!c.ok) return c
      if (!isRecentChat(c.chat)) {
        return { ok: false, why: `最近把你叫醒的会话里没有「${c.chat}」，不能往那里定提醒。` }
      }
      return permitStore.grant({ id, chat: c.chat, text, sessionId, dueAt, ttlMs })
    },
    revokeReminder: (id) => permitStore.revoke(id),
    sendReminder: (req) => withSendLock(() => sendToChat(req)),
  }
  const wxProvided = provideWxService(ctx, wxService)
  if (wxProvided.ok) console.log('[dsh-wx] 已向 dsh-fish 暴露 wx 服务')
  else console.log('[dsh-wx] wx 服务没挂上：' + wxProvided.why)
  if (typeof wxProvided.dispose === 'function') disposers.push(wxProvided.dispose)

  // ---- 后台轮转采集（M2）：当前会话 OCR 补发言人 ----
  /** 当前会话最近一屏补发言人：最多每 p.capture.ocrEveryMs 一次；失败只记日志。 */
  async function maybeOcrCurrent(p) {
    const cap = lastCurrentCapture
    if (!cap || !cap.messages?.length) return
    if (isIgnoredChat(cap.chat, p.ignoreChats)) return
    if (Date.now() - lastCurrentOcrAt < p.capture.ocrEveryMs) return
    if ((treeLast?.status ?? 'down') !== 'ok') return
    // 真正尝试之前就记时间：OCR 失败/超时也不要每轮都重跑。
    lastCurrentOcrAt = Date.now()
    try {
      // 重读 + OCR + 写入整段持 GUI 锁：从耳朵起始快照到这里可能已经切换过会话，
      // 只有锁内复核当前会话仍是快照里的那个，OCR 的发言人才能归到它名下。
      await withGuiLock(async () => {
        const s = await look({ confirm: false })
        if (!sameName(s?.parsed?.current, cap.chat)) return
        // 必须用锁内这一屏的新 box 对齐：旧快照的 box 可能已被新消息/滚动挤错位。
        const messages = normalizeMessages(s.parsed.messages ?? [], { now: Date.now() })
        if (!messages.length) return
        const d = JSON.parse(await run(['speakers'], 90_000))
        if (!d.ok) return
        const aligned = alignSpeakers(messages, d.lines, { roster: people })
        const evidenceKey = captureEvidenceKey(cap.chatId, aligned)
        for (const name of new Set(aligned.map((a) => a.sender).filter(Boolean))) {
          people.learn({ name, source: 'ocr', chatId: cap.chatId, evidenceKey })
        }
        // 只追加 repair，不改已有记录；对不上就什么都不写。
        const docs = contextStore.ledger.recent(cap.chatId, 30)
        for (const fix of planSpeakerRepairs(aligned, docs)) {
          contextStore.ledger.repair(cap.chatId, { ...fix, why: 'OCR 补发言人' })
        }
      })
    } catch (err) {
      console.log('[dsh-wx] 采集：当前会话 OCR 失败（' + String(err?.message ?? err).slice(0, 120) + '）')
    }
  }

  /** 聊天区的滚动锚点：最后一条消息的中心；没有消息就取窗口右下区域。 */
  const scrollAnchor = (parsed) => {
    const last = [...(parsed?.messages ?? [])].reverse().find((m) => m?.box)
    if (last) return { x: Math.round(last.box.cx), y: Math.round(last.box.cy) }
    const win = parsed?.window ?? {}
    return {
      x: Math.round((Number(win.ox) || 0) + (Number(win.w) || 0) * 0.6),
      y: Math.round((Number(win.oy) || 0) + (Number(win.h) || 0) * 0.55),
    }
  }

  /**
   * 后台采集用的窗口原语。点击/滚动都走 run()（自带 GUI 锁，同链可重入）。
   * 坐标取整即可：parseTree 的 box 已经是屏幕绝对坐标，不再乘 window.scale。
   */
  const makeCaptureIo = () => {
    const findRow = (parsed, chat) => (parsed?.chats ?? []).find(
      (c) => sameName(c.name, chat) || canonicalName(c.name) === canonicalName(chat),
    ) ?? null
    const clickRow = async (box) => {
      await run(['clean'])
      fresh.reset()
      await run(['click', String(Math.round(box.cx)), String(Math.round(box.cy))])
      await sleep(700)
      return look({ confirm: false })
    }
    return {
      read: () => look({ confirm: false }),
      open: async (chat, before) => {
        const row = findRow(before?.parsed, chat)
        if (!row?.box) return null
        let s = await clickRow(row.box)
        if (sameName(s.parsed?.current, chat)) return s
        // 点一次没对上：同样的点击+核对再来一次，仍不对就放弃（不写台账）。
        s = await clickRow(row.box)
        return sameName(s.parsed?.current, chat) ? s : null
      },
      scrollUp: async (parsed) => {
        const { x, y } = scrollAnchor(parsed)
        await run(['scroll', String(x), String(y), 'up', '5'])
        await sleep(600)
        return look({ confirm: false })
      },
      scrollDown: async (parsed, times) => {
        const { x, y } = scrollAnchor(parsed)
        await run(['scroll', String(x), String(y), 'down', String(Math.max(1, Number(times) || 1))])
        await sleep(600)
      },
      ocrSpeakers: async () => {
        const d = JSON.parse(await run(['speakers'], 90_000))
        if (!d.ok) throw new Error(d.why || 'speakers 失败')
        return d
      },
      restore: async (chat) => {
        const s0 = await look({ confirm: false })
        const row = findRow(s0.parsed, chat)
        if (!row?.box) return false
        await run(['click', String(Math.round(row.box.cx)), String(Math.round(row.box.cy))])
        await sleep(700)
        const s = await look({ confirm: false })
        return sameName(s.parsed?.current, chat)
      },
      onMention: (hit) => {
        saveMentions(grant(readMentions(), hit.chat, Date.now()))
        pendingCaptureHits.push(hit)
        if (pendingCaptureHits.length > 20) pendingCaptureHits.shift() // 上限 20，超出丢最旧
        logInbound({ type: 'capture-mention', chat: hit.chat, msgId: hit.msgId })
      },
      outboxFor: (chat) => outboxFor(chat),
    }
  }

  /**
   * 后台轮转采集的一拍：先按本轮预览入队（暂停期间也要排队），再决定是否让路；
   * 空闲且冷却到了就采一个会话。失败只影响这一个会话，不阻塞下一轮。
   */
  async function captureTick({ parsed, p, pendingHits }) {
    const queue = ensureCaptureQueue(p)
    if (!p.capture.rotate) {
      captureHealth = { ...captureHealth, queued: queue.size() }
      writeHealth()
      return
    }
    for (const { chat, row, sig, prevSig } of roundPreview?.rows ?? []) {
      const name = canonicalName(chat) || chat
      const r = shouldEnqueue({
        row, sig, prevSig,
        allowChats: p.allowChats, ignoreChats: p.ignoreChats,
        capturedSinceStart: capturedSinceStart.has(name),
        lastCaptureAt: queue.lastDoneAt(name),
        now: Date.now(), cooldownMs: p.capture.chatCooldownSec * 1000,
      })
      if (r.enqueue) queue.offer({ chat: name, reason: r.reason, unread: row.unread, dueAt: r.dueAt })
    }
    roundPreview = null
    // 每 5 秒最多采一个，避免启动初期把队列一次点完。
    if (Date.now() - lastCaptureAttemptAt < 5000) {
      captureHealth = { ...captureHealth, queued: queue.size() }
      writeHealth()
      return
    }
    const reason = pauseReason({
      policy: p,
      hostBusy: hostBusy(),
      sending: sendBusy > 0,
      pendingHits,
      treeStatus: treeLast?.status ?? 'down',
      stale: !!fresh.stale,
      login: treeLast?.status === 'login',
      quietUntil,
      now: Date.now(),
    })
    captureHealth = { ...captureHealth, paused: !!reason, pauseReason: reason, queued: queue.size() }
    if (reason) {
      if (lastPauseLog.reason !== reason || Date.now() - lastPauseLog.at > 30_000) {
        lastPauseLog = { reason, at: Date.now() }
        console.log('[dsh-wx] 采集：暂停（' + reason + '）')
      }
      writeHealth()
      return
    }
    const job = queue.due(Date.now())
    if (!job) { writeHealth(); return }
    lastCaptureAttemptAt = Date.now()
    const settings = p.capture
    const jobChatId = directory.idFor(job.chat)
    const io = makeCaptureIo()
    try {
      const r = await withGuiLock(() => runCapture({
        job: { ...job, chatId: jobChatId }, io, contextStore, directory, people, settings, policy: p,
        log: (m) => console.log('[dsh-wx] 采集：' + String(m ?? '').slice(0, 160)),
      }))
      if (r.ok) {
        for (const name of r.ocrSenders ?? []) {
          people.learn({ name, source: 'ocr', chatId: jobChatId, evidenceKey: r.ocrEvidenceKey })
        }
        queue.done(job.chat)
        capturedSinceStart.add(job.chat)
        quietUntil = Date.now() + settings.quietMs
        captureHealth = { ...captureHealth, lastAt: new Date().toISOString(), lastChat: job.chat, lastResult: `added:${r.added} skipped:${r.skipped}`, lastError: '' }
        if (r.added > 0) console.log(`[dsh-wx] 采集：${job.chat} +${r.added}（回滚 ${r.scrolled} 屏）`)
      } else {
        queue.fail(job.chat)
        captureHealth = { ...captureHealth, lastError: r.why ?? 'failed' }
        console.log('[dsh-wx] 采集：' + job.chat + ' 失败（' + (r.why ?? '') + '）')
      }
    } catch (err) {
      queue.fail(job.chat)
      captureHealth = { ...captureHealth, lastError: String(err?.message ?? err).slice(0, 160) }
    }
    // done/fail 都会改队列长度，收尾时重算一次再写盘。
    captureHealth = { ...captureHealth, queued: queue.size() }
    writeHealth()
  }

  const ear = async () => {
    if (busy) return
    const p = policy()
    if (!p.enabled || p.watch === false) return
    busy = true
    let roundParsed = null
    let heldHits = 0
    try {
      const s = await look({ confirm: false, capture: true }).catch(() => null)
      if (!s) return
      const tree = s.tree ?? treeHealth(s.raw, s.parsed)
      // 微信被重启过（systemd Restart、工作台按钮、手动）且树没回来：
      // 「使用中只提醒」不适用——开启一轮有界的「重启后恢复」，由 treeAction 控制次数/冷却。
      const prevPid = treePid
      const pid = await readTreePid()
      const ep = restartEpisode({ prevPid, pid, treeOk: tree.ok, phase: treePhase })
      if (pid) treePid = pid
      if (ep.recover) {
        treePhase = 'recover'
        treeAttempts = 0
        treeRetryAfter = Date.now() + TREE_RESTART_SETTLE_MS
        treeAlert = `微信重启过（${prevPid}→${pid}），等无障碍树恢复`
        console.log('[dsh-wx] 树：' + treeAlert)
        logInbound({ type: 'tree-pid-change', from: prevPid, to: pid, status: tree.status })
        writeHealth()
      }
      // 初始化（刚挂上、还没见过健康的树）：总线不在就先拉起总线，再把微信重启一次。
      // 使用中掉树（pid 没变）：observeTree 只写 health/提醒，不返回 restart。
      const act = observeTree(s)
      if (act.restart) {
        await recoverTree(act)
        return
      }
      let parsed = s.parsed
      let ocrRecovered = s.source === 'ocr'

      // Linux WeChat can expose a live window while its AT-SPI tree is empty.
      // Recover only the sidebar @ badge via OCR; never infer the active chat.
      if (!tree.ok && !ocrRecovered) {
        try {
          const ocr = await ocrRead()
          if (ocr?.reliable) {
            parsed = { ...ocr.parsed, window: ocr.parsed.window ?? parsed.window }
            ocrRecovered = true
          }
        } catch (error) {
          console.log('[dsh-wx] OCR 回退失败: ' + String(error?.message ?? error).slice(0, 120))
        }
      }

      // 手机端一上线，PC 微信常被踢回登录页：窗口缩成 291x396，侧栏读不到任何会话，
      // 耳朵从此聋掉（日志只写「侧栏 @ 行 0 条」，看着像没人说话）。
      // 2026-10-29 夜里实测：替她点 Log In 会让手机端一直弹登录确认，人被烦死。
      // 所以只记账、不动手——登不登由人决定；treeAction 也明确不重启登录页。
      if (tree.status === 'login') {
        if (Date.now() - lastRelogin > 10 * 60_000) {
          lastRelogin = Date.now()
          console.log(`[dsh-wx] 微信在登录页（窗口 ${tree.window?.w}x${tree.window?.h}），等人工登录`)
        }
        return
      }

      // 树没连上、OCR 也没读到会话行：这一轮没有可看的东西，等树恢复/下一轮。
      if (!tree.ok && !ocrRecovered) return
      roundParsed = parsed
      // 只有树健康时才写预览台账：partial/down/login 没有可信数据。
      // OCR 回退只用于识别 @，不拿它写预览。
      // 返回值（每行 prevSig/sig）留给 finally 的 captureTick 在更新快照前入队。
      if (tree.ok && !ocrRecovered) roundPreview = recordPreviews(parsed)
      // 当前会话的发言人补全：失败只记日志，不阻塞本轮。
      await maybeOcrCurrent(p)
      // 每 10 分钟把侧栏从头滚到尾一次，补齐当前页看不到的会话和全名。
      if (!ocrRecovered && Date.now() - lastScanAt > 10 * 60_000) {
        lastScanAt = Date.now()
        await scanDirectoryNow().catch((err) => {
          console.log('[dsh-wx] 目录扫描失败：' + String(err?.message ?? err).slice(0, 120))
        })
      }
      // 树落后时试一次无副作用的"滚一下"逼它刷新；最多一分钟一次
      if (fresh.stale && Date.now() - lastNudge > 60_000 && parsed.chats.length >= 3) {
        lastNudge = Date.now()
        const row = parsed.chats[Math.min(2, parsed.chats.length - 1)].box
        await run(['nudge', String(row.cx), String(row.cy)], 10_000).catch(() => '')
        await sleep(800)
        const s2 = await snapshot()
        fresh.observe(s2)
        fresh.noteNudge(!fresh.stale)
        writeHealth()
      }

      const trigger = p.trigger.length > 0 ? p.trigger : ['D33p53Ek']
      // 免 @ 名单和允许名单一起交给它：单聊没有「@我」标记，不靠这两条就永远叫不醒她
      const baseMentions = (ocrRecovered
        ? ocrMentionHits(parsed)
        : mentionHits(parsed, trigger, p.noMentionChats, p.allowChats))
        .filter((m) => !isIgnoredChat(m.chat, p.ignoreChats))
      // 当前打开的会话没有未读角标时，侧栏判据看不到它新收到的消息。
      // captureCurrent 这一轮新记下的入站正文如果和侧栏 preview 对得上，就补一条命中；
      // 先进 pendingCaptureHits，hostBusy / 15 秒节流 / 投递失败时下一轮还能重试。
      if (tree.ok && !ocrRecovered) {
        const openRow = (parsed.chats ?? []).find((c) => sameName(c.name, parsed.current)) ?? null
        const openHit = openChatHit({
          chat: parsed.current, row: openRow, captured: s.capturedCurrent, policy: p,
        })
        if (openHit && !pendingCaptureHits.some((h) => h.key === openHit.key)) {
          pendingCaptureHits.push(openHit)
          if (pendingCaptureHits.length > 20) pendingCaptureHits.shift()
        }
      }
      // 后台采集补扫到的 @ / 当前会话补的命中参与投递：采集可能已经清掉未读，侧栏会看不到。
      // 服务号即使在旧队列里残留了命中，也不投递。
      const deliverableCaptureHits = pendingCaptureHits.filter((m) => !isIgnoredChat(m.chat, p.ignoreChats))
      const mergedHits = new Map()
      for (const m of [...baseMentions, ...deliverableCaptureHits]) mergedHits.set(m.key, m)
      const mentionsRaw = [...mergedHits.values()]
      // 截断名解析到全名后再记 @ 窗口和任务，否则发送闸会拿两个不同的键互相比。
      const mentions = mentionsRaw.map((m) => ({ ...m, chat: canonicalName(m.chat) }))
      // 有人 @ 她 → 这个会话在窗口内可以开口（@ 才回）。挂着的未读 @ 会一直续窗口。
      if (mentions.length > 0) {
        let st = readMentions()
        for (const m of mentions) st = grant(st, m.chat, Date.now())
        saveMentions(st)
      }
      const now = new Map(mentions.map((m) => [m.key, m]))
      const sig = [...now.keys()].sort().join('‖')
      if (sig !== lastSig) {
        lastSig = sig
        console.log(`[dsh-wx] 耳朵：侧栏 @ 行 ${now.size} 条${now.size ? ' → ' + [...now.values()].map((m) => m.chat).join('、') : ''}`)
        logInbound({ type: 'detected', chats: [...now.values()].map((m) => ({ chat: m.chat, why: m.why, unread: m.unread, preview: m.preview, key: m.key })) })
      }

      // 调试用：往 ~/.dsh-wx/poke 写一句话，原样递给她，然后删掉。
      const POKE = '/home/str1k3/.dsh-wx/poke'
      let poke = ''
      try { poke = readFileSync(POKE, 'utf8').trim() } catch { poke = '' }
      if (poke) {
        rmSync(POKE, { force: true })
        // 手动叫醒也算一次 @：poke 里点到的会话照样可以开口
        saveMentions(grantMentioned(readMentions(), poke, p.allowChats, Date.now()))
        // poke 里点到的允许会话，同样算「最近叫醒过」；她随后说「提醒我」时才有目标。
        noteRecent(p.allowChats.filter((n) => String(poke).includes(n)))
        await deliver(await ensureWxSession(), `[微信·主机] ${poke}`)
        console.log('[dsh-wx] 耳朵：主机塞了一句进去 → ' + poke.slice(0, 60))
        return
      }

      // 防自激：她一回复，侧栏预览就变成她自己那句话。
      // 两条闸：① 预览对得上她自己刚发出去的原文（outbox 回执）才算回声 ② 已经投过的 key 不再投。
      // 以前用「同一个会话 45 秒内只叫一次」一刀切，把她答完话后真人马上接的第二句也吞了
      // （2026-11-05 09:53 的「这么高冷」：离上次投递 23 秒，被压到红点被采集清掉）。
      const ECHO_MS = 45_000
      // key 是「会话 + 预览文字」，只在一个未读回合里有效：会话被读到（未读归零）就把记录清掉，
      // 否则「早」「在吗」这种重复的话过几天再发一遍会撞上旧 key，被静默当成回声吃掉。
      // 只认还在侧栏里的行，没看见的会话不当成已读；OCR 的未读字段不可信，不参与。
      if (tree.ok && !ocrRecovered) {
        const readChats = (parsed.chats ?? []).map((c) => ({ ...c, name: canonicalName(c.name) }))
        if (forgetReadChats(seen, readChats)) saveSeen()
      }
      // 只有真的 @ 才能穿过回声判断：同一个人在群里连 @ 她两次，第二次也是要找她。
      const fresh1 = freshHits([...now.values()], seen, {
        isEcho: (m) => ownEcho(m.chat, m.preview, outbox, { echoMs: ECHO_MS }),
      })
      const hits = fresh1
      // 压着没投出去的 @：本轮采集让路（投递循环后按实际成功数重算）。
      heldHits = hits.length
      if (hits.length === 0) {
        // 压住的时候留一行日志，否则「她没被叫醒」和「她听到了不想说」在日志里长得一样
        const held = [...now.values()].filter((m) => !seen.has(m.key))
        if (held.length > 0 && Date.now() - lastHeldLog > 30_000) {
          lastHeldLog = Date.now()
          console.log('[dsh-wx] 耳朵：压着 ' + held.length + ' 条（回声保护 ' + Math.round(ECHO_MS / 1000) + 's）→ ' + held.map((m) => m.chat).join('、'))
        }
        return
      }
      // 主机正在对话框里等她答：不插话，等这一轮答完再投（没记账，下一轮自然会再来）
      if (hostBusy()) {
        if (Date.now() - lastHeldLog > 30_000) {
          lastHeldLog = Date.now()
          console.log('[dsh-wx] 耳朵：主机这一轮还没答完，微信通知先压着（' + hits.map((h) => h.chat).join('、') + '）')
        }
        return
      }
      // 投不进微信自己的会话就不投、不记账，下一轮再试：宁可晚，也不串通道
      await ensureWxSession()
      if (Date.now() - lastAt < 15_000) return
      lastAt = Date.now()
      // 先入池、再叫醒：投递失败下一轮还会重投，任务按预览去重，不会越积越多。
      // 每个群各自投到自己那个会话；主会话管第一个群，其余按 chatId 分配 worker。
      const tasks = new Map()
      const reqs = new Map()
      const recents = new Map()
      const ids = new Map()
      for (const h of hits) {
        const chat = canonicalName(h.chat)
        const chatId = directory.idFor(chat)
        ids.set(h.key, chatId)
        const entry = directory.entry(chat)
        const isDM = entry?.kind === 'dm' ? true : null
        const who = requesterOf({ chat, isDM: isDM === true, preview: h.preview })
        if (who?.name) reqs.set(chat, who)
        try {
          const r = contextStore.ingest({ chat, chatId, preview: h.preview, why: h.why, isDM, ignoreChats: p.ignoreChats })
          if (r.ok && r.task) tasks.set(chat, r.task)
        } catch (err) {
          console.log('[dsh-wx] 入池失败（不影响这次投递）：' + String(err?.message ?? err).slice(0, 120))
        }
        try {
          const rec = contextStore.recentContext({ chat, chatId, limit: 6, hours: 6, ignoreChats: p.ignoreChats })
          if (rec.ok && rec.lines.length) recents.set(chat, rec.lines)
        } catch { /* 前文读不到就只发预览 */ }
      }

      const sentChats = []
      for (const h of hits) {
        const chat = canonicalName(h.chat)
        const chatId = ids.get(h.key)
        const note = formatEarNote([{ ...h, chat }], p.allowChats, tasks, { requester: reqs, recent: recents })
        try {
          const sid = await deliverToChat(chat, chatId, note)
          sentChats.push(chat)
          // 投成功才记账：失败下一轮还投，不会丢这条 @
          seen.set(h.key, { at: Date.now(), chat })
          // 每个会话投完都给采集留一段静默期（取较大值，不会无限延长）。
          quietUntil = Math.max(quietUntil, Date.now() + p.capture.quietMs)
          console.log('[dsh-wx] 耳朵：已投递（' + sid + '）→ ' + chat)
          logInbound({ type: 'delivered', session: sid, chatId, chat, why: h.why, preview: h.preview, key: h.key })
        } catch (err) {
          console.log('[dsh-wx] 耳朵：投递失败（' + chat + '）：' + String(err?.message ?? err).slice(0, 160))
          logInbound({ type: 'deliver-failed', chatId, chat, why: h.why, error: String(err?.message ?? err).slice(0, 160) })
        }
      }
      heldHits = Math.max(0, hits.length - sentChats.length)
      // 采集补扫到的 @：投过的清掉；压着的（例如 hostBusy）留到下一轮，别被采集清未读后弄丢。
      for (let i = pendingCaptureHits.length - 1; i >= 0; i--) {
        if (seen.has(pendingCaptureHits[i].key)) pendingCaptureHits.splice(i, 1)
      }
      if (!sentChats.length) return
      saveSeen()
      noteRecent(sentChats)
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 160)
      console.log('[dsh-wx] 耳朵出错: ' + msg)
      // 同一个错误每 30 秒记一次，别让账本被重试刷屏
      if (Date.now() - lastFailLog > 30_000) {
        lastFailLog = Date.now()
        logInbound({ type: 'error', error: msg })
      }
    } finally {
      // 不管这一轮为什么结束（返回/抛错），都按当前状态决定要不要采一次。
      try {
        await captureTick({ parsed: roundParsed, p, pendingHits: pendingCaptureHits.length + heldHits })
      } catch (err) {
        console.log('[dsh-wx] 采集：本轮出错（' + String(err?.message ?? err).slice(0, 120) + '）')
      }
      busy = false
    }
  }

  const timer = setInterval(ear, Math.max(3, Number(config.pollSeconds) || 5) * 1000)
  timer.unref?.()
  const remindTimer = setInterval(() => {
    reminderPump().catch((err) => console.log('[dsh-wx] 逾期泵出错：' + String(err?.message ?? err).slice(0, 120)))
  }, 60_000)
  remindTimer.unref?.()
  const maintainTimer = setInterval(maintain, 15 * 60_000)
  maintainTimer.unref?.()
  const maintainEarly = setTimeout(maintain, 120_000)
  maintainEarly.unref?.()

  console.log(`[dsh-wx] mounted (display=${display}, tools=${disposers.length}, policy=${POLICY}, stickers=${stickerDir})`)

  // ---------------------------------------------------------------- 工具
  reg({
    name: 'wx_see',
    description: '截取微信窗口，保存为 PNG，返回文件路径和窗口尺寸。当前模型不支持图像输入，无法用 read_image 读取；需要界面信息时用 wx_peek。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      mkdirSync(SHOT_DIR, { recursive: true })
      const path = join(SHOT_DIR, `shot-${Date.now()}.png`)
      const out = await run(['shot', path])
      const [, w, h] = out.split(/\s+/)
      prune()
      return `已截图：${path}（窗口 ${w}x${h}）`
    },
  })

  reg({
    name: 'wx_peek',
    description: '读取微信当前界面：当前会话、会话列表（名字、未读、@我、预览）、当前聊天最后几条消息（无发言人）、可点击元素。要操作界面时用 wx_click 的 label 填这里看到的名字或按钮名。树落后于屏幕时，返回末尾带 [提示]。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    project: (out) => ({ text: projectWxPeek(out) }),
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const s = await look()
      if (s.source === 'ocr') return JSON.stringify({ source: 'ocr', current: '', currentVerified: false, chats: s.parsed.chats.map(({ name, unread, mention, preview, box, nameConfidence }) => ({ name, unread, mention, preview, box, nameConfidence })), messages: s.parsed.messages.map(({ text, confidence }) => ({ text, confidence, verified: false })), note: 'OCR cannot verify the active conversation or authorize sending.' }, null, 2)
      // 当前会话的气氛粗判 + 她自己记下的关于这个人的话（没有就是空串）
      let mood = ''
      try { mood = feed?.hint(s.parsed.current) ?? '' } catch { /* ignore */ }
      // 尾巴（[提示] / 气氛）比正文更重要：先给它们留位置，再截正文。
      return clipPeekBody(s.raw, fresh.notice() + mood)
    },
  })

  reg({
    name: 'wx_click',
    description: '点击微信窗口里的一个位置。首选 label：填 wx_peek 里看到的会话名或按钮名（会话列表里的名字、Contacts、Chat Info 等）。x/y 只作内部回退，正常不用填。返回落点是什么、点击后的当前会话。',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '会话名或按钮名，与 x/y 二选一' },
        x: { type: 'number', description: '屏幕绝对横坐标' },
        y: { type: 'number', description: '屏幕绝对纵坐标' },
        button: { type: 'number', description: '1=左键（默认），3=右键' },
      },
      required: [],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const label = String(a.label ?? '').trim()
      if (!policy().enabled) throw new Error(OFF)
      await run(['clean'], 30_000).catch(() => '') // 挡住点击的 Qt 浮层先清掉
      fresh.reset() // 关浮层会改像素但树不变，旧基线不能再拿来判"落后"

      let x, y, target = null
      const before = await look()
      if (!before.parsed.ok && before.source !== 'ocr') throw new Error('读不到微信窗口。')
      if (label) {
        target = resolveLabel(before.parsed, label)
        if (!target) {
          if (/^(send|发送)$/i.test(label)) {
            // 树里没有"发送"按钮（截图上有）；发送等价于回车，走同一道闸
            const g = await gateSend()
            await speechGate(g.chat)
            await run(['key', 'Return'])
            return '树里没有“发送”按钮，已按回车发送。' + fresh.notice()
          }
          const names = before.parsed.chats.map((c) => c.name).slice(0, 12).join('、')
          throw new Error(`没找到「${label}」。会话列表：${names || '（空）'}。按钮名见 wx_peek 的“能点的”。` + fresh.notice())
        }
        x = target.box.cx; y = target.box.cy
      } else {
        x = Math.round(Number(a.x)); y = Math.round(Number(a.y))
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('wx_click: 需要 label，或数字 x/y。')
        target = hitTest(before.parsed, x, y)
      }
      await run(['click', String(x), String(y), String(Number(a.button) === 3 ? 3 : 1)])
      await sleep(700)
      const after = await look({ confirm: false })

      const parts = [`已点击 (${x},${y})`]
      parts.push(target ? `落点：${target.kind === 'chat' ? '会话' : target.kind === 'control' ? '控件' : '消息'}“${target.name}”` : '落点：无可点击元素')
      const cur = after.parsed.current
      if (target?.kind === 'chat' && !fresh.stale) {
        parts.push(after.source === 'ocr' ? `Selected conversation: ${target.name}; OCR cannot verify the active conversation.` : sameName(cur, target.name) ? `当前会话：“${cur}”` : `当前会话：“${cur || '读不到'}”，与目标“${target.name}”不一致`)
      } else {
        parts.push(`当前会话：“${cur || '读不到'}”`)
      }
      return parts.join('；') + '。' + fresh.notice()
    },
  })

  reg({
    name: 'wx_type',
    description: '往当前焦点输入框打字（支持中文）。enter=true 时打完回车发送。需要当前会话在允许名单内，否则拒绝（包括 enter=false）。文本不能含换行。发送后返回消息是否出现在列表末尾。输入前先用 wx_click 点输入框。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要输入的文字' },
        enter: { type: 'boolean', description: '输入后是否回车发送，默认 false' },
      },
      required: ['text'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const a = args || {}
      const text = String(a.text ?? '')
      if (!text) throw new Error('wx_type: text 不能为空。')
      if (/[\r\n]/.test(text)) throw new Error('wx_type: 文本含换行，会被拆成多条发送。请去掉换行或分多次发送。')
      if ([...text].length > 500) throw new Error('wx_type: 文本超过 500 字。')
      const enter = a.enter === true

      // 输入也要过闸：在名单外的会话里打字，会在对方输入框里留下草稿
      const first = await gateSend()
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset() // 关浮层会改像素但树不变，旧基线不能再拿来判"落后"
      await run(['type', text], 60_000)
      if (!enter) return `已输入 ${[...text].length} 字，未发送。当前会话：“${first.chat}”。` + fresh.notice()

      // 回车之前再核对一次：打字期间界面可能切走
      await sleep(300)
      const second = await gateSend()
      await speechGate(second.chat)
      // 回车之前先登记「这句是她的」：回车后第一次读屏就能把它认成她说的，而不是对方说的
      try { feed?.willSend(second.chat, text) } catch { /* ignore */ }
      await run(['key', 'Return'])
      await sleep(900)
      const after = await look({ confirm: false })

      // 回执：只信树里看得到的。看不到就如实说看不到。
      const typed = text.replace(/\s+/g, ' ').replace(/"/g, '＂')
      const head = typed.slice(0, 14)
      const inMsgs = after.parsed.messages.slice(-4).some((m) => m.text.includes(head))
      const chatRow = after.parsed.chats.find((c) => sameName(c.name, second.chat))
      const inPreview = !!chatRow && chatRow.preview.includes(head.slice(0, 10))
      const receipt = inMsgs
        ? '回执：消息已出现在列表末尾。'
        : inPreview
          ? '回执：会话列表预览已显示该内容，消息列表末尾未见。'
          : '回执：消息列表末尾和会话预览都没有看到该内容（可能未发出，或树尚未刷新），用 wx_peek 复查。'
      try { feed?.noteOut({ chat: second.chat, text, receipt: receipt.replace(/^回执：/, ''), sent: inMsgs || inPreview ? true : 'unconfirmed' }) } catch { /* ignore */ }
      if (inMsgs || inPreview) {
        noteOutbox(second.chat, text)
        try {
          contextStore.capture({
            chat: second.chat,
            source: 'sent',
            ignoreChats: policy().ignoreChats,
            messages: [{
              sender: null, senderConfidence: 'unknown', direction: 'out', kind: 'text',
              text, at: new Date().toISOString(), atConfidence: 'medium', source: 'sent',
            }],
          })
        } catch { /* 台账记不下不影响已经发出的消息 */ }
      }
      return `已输入 ${[...text].length} 字并回车。当前会话：“${second.chat}”。${receipt}` + fresh.notice()
    },
  })

  reg({
    name: 'wx_send',
    description: '把一条文字发到指定的微信会话：自动点开会话、点输入框、输入并回车，再核对回执。普通发送仍要过允许名单、@ 和主机闸；带 permit 时只用于到点的定时提醒，一次性、只对指定会话和原文有效。文本不能含换行，500 字以内。带 task_id 时，发送成功后把这次回复记到该任务上（只记为“回了一半”，不会自动完成）。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '会话名，与会话列表里的名字完全一致。' },
        text: { type: 'string', description: '要发送的文字，不能含换行，500 字以内。' },
        permit: { type: 'string', description: '到点提醒带的一次性许可；普通发送不填。' },
        task_id: { type: 'string', description: '可选。任务 id；发送成功后把这次回复挂到任务上。' },
      },
      required: ['chat', 'text'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const a = args || {}
      const taskId = String(a.task_id ?? '').trim()
      let task = null
      if (taskId) {
        task = contextStore.board.get(taskId)
        if (!task) throw new Error('没有这个任务：' + taskId)
        if (!sameName(task.chatName, a.chat)) {
          throw new Error(`任务「${taskId}」的会话是「${task.chatName}」，不是「${String(a.chat ?? '')}」，不发送。`)
        }
      }
      const r = await withSendLock(() => sendToChat({
        chat: a.chat,
        text: a.text,
        permit: String(a.permit ?? '').trim(),
        taskId,
      }))
      let taskLine = ''
      if (task) {
        if (r.sent !== 'confirmed') {
          taskLine = `任务「${taskId}」没有记：回执没确认，不假装发过。`
        } else {
          const rep = contextStore.recordReply({ taskId, msgId: r.outMsgId })
          taskLine = rep.ok ? `任务「${taskId}」已记为回了一半。` : `任务「${taskId}」没记上：${rep.why}`
        }
      }
      return `已发到「${r.chat}」。${r.receipt}${taskLine ? ' ' + taskLine : ''}` + fresh.notice()
    },
  })

  reg({
    name: 'wx_context',
    description: '在「当前任务自己的会话」里查上下文：给 task_id，可选关键词 query，或只按时间翻页（before/limit）。结果最多 5 条，带来源、发言人、时间、匹配原因和置信度。不能跨会话查；查不到就如实说没有。查询本身不是记忆，不会写进她的事件流。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id，来自 [微信] 通知里的「任务：」。' },
        query: { type: 'string', description: '可选。要找的关键词或短句；不填就按时间取最近几条。' },
        before: { type: 'string', description: '可选。只取这个时间之前的消息，ISO 时间；用于往前翻页。' },
        limit: { type: 'number', description: '可选。条数，默认 5，最多 5。' },
      },
      required: ['task_id'],
    },
    output: textOut,
    project: (out) => ({ text: projectWxContext(out) }),
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const taskId = String(a.task_id ?? '').trim()
      if (!taskId) throw new Error('wx_context: 需要 task_id。')
      const r = await contextStore.contextForTask({
        taskId,
        query: String(a.query ?? ''),
        before: String(a.before ?? ''),
        limit: Number(a.limit) || undefined,
        ignoreChats: policy().ignoreChats,
      })
      if (!r.ok) throw new Error(r.why)
      return r.text + '\n（只查这个任务自己的会话；查询不写进记忆。）'
    },
  })

  reg({
    name: 'wx_history',
    description: '只读查询微信台账：不传 chat 列出有记录的非服务会话；传 chat 按会话名查最近记录，可选 query 关键词和 hours 时间窗。最多 20 条，带发言人、时间、来源和置信度。不建任务、不写事件流。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '可选。会话名；不填则列出有记录的会话。' },
        query: { type: 'string', description: '可选。要找的关键词或短句。' },
        hours: { type: 'number', description: '可选。只保留最近多少小时内的记录。' },
        limit: { type: 'number', description: '可选。最多返回条数，最多 20。' },
      },
    },
    output: textOut,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const ignoreChats = policy().ignoreChats
      const chat = String(a.chat ?? '').trim()
      const limit = Number(a.limit) || undefined
      const r = chat
        ? contextStore.historyForChat({ chat, query: String(a.query ?? ''), hours: Number(a.hours) || 0, limit, ignoreChats })
        : contextStore.listRecordedChats({ limit, ignoreChats })
      if (!r.ok) throw new Error(r.why)
      return r.text
    },
  })

  reg({
    name: 'wx_task_snooze',
    description: '把一条微信任务推迟一段时间再提醒。用于现在回不了、但不是不用回的情况。推迟期间不再催；到点会重新提醒。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id。' },
        minutes: { type: 'number', description: '推迟多少分钟，默认 15。' },
      },
      required: ['task_id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const taskId = String(a.task_id ?? '').trim()
      if (!taskId) throw new Error('wx_task_snooze: 需要 task_id。')
      const minutes = Math.max(1, Math.min(24 * 60, Number(a.minutes) || 15))
      const r = contextStore.snooze({ taskId, minutes })
      if (!r?.ok) throw new Error(r?.why || '任务没记上。')
      return `任务「${taskId}」推迟 ${minutes} 分钟，到点再提醒。`
    },
  })

  reg({
    name: 'wx_task_done',
    description: '把一条微信任务标记为完成。只有确实答完、不需要再跟进时才用；发了一条回复不等于完成。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id。' },
        note: { type: 'string', description: '可选。一句话说明怎么处理的。' },
      },
      required: ['task_id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const taskId = String(a.task_id ?? '').trim()
      if (!taskId) throw new Error('wx_task_done: 需要 task_id。')
      const r = contextStore.done({ taskId, note: String(a.note ?? '') })
      if (!r?.ok) throw new Error(r?.why || '任务没记上。')
      return `任务「${taskId}」已完成。`
    },
  })

  reg({
    name: 'wx_ocr',
    description: '只读 OCR 观察微信窗口，返回侧栏识别行和消息区文字。OCR 不证明当前会话，不能用作发送授权。',
    parameters: { type: 'object', properties: {} },
    output: ocrOut,
    project: (out) => ({ text: projectWxOcr(out) }),
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const data = await ocrRead()
      // 完整返回：台账会把大字段落 artifact（审计副本）。模型看到的由
      // projectWxOcr 投影；fishCore 缺席时由 ocrOut 限长，不把整段 JSON 塞进上下文。
      return JSON.stringify(data, null, 2)
    },
  })

  reg({
    name: 'wx_key',
    description: '向微信窗口发送按键或组合键，写法为 xdotool 键名：Return、Escape、Tab、ctrl+a、ctrl+v 等。Return 视同发送，需要当前会话在允许名单内。',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: '如 Return、Escape、ctrl+a' } },
      required: ['keys'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const keys = String((args || {}).keys ?? '').trim()
      if (!keys) throw new Error('wx_key: keys 不能为空。')
      if (!policy().enabled) throw new Error(OFF)
      let where = ''
      if (/(^|\+)(return|kp_enter|enter)$/i.test(keys)) {
        const g = await gateSend()
        await speechGate(g.chat)
        where = `当前会话：“${g.chat}”。`
      }
      await run(['key', keys])
      return `已按 ${keys}。${where}` + fresh.notice()
    },
  })

  // ---- 收藏表情（阶段一：只读扫描 + 检索）----
  // 索引是派生缓存，不进事件流；扫描只点心形页签，不点任何表情格。
  const stickerWarnings = (r) => {
    const out = []
    if (r.warnings?.includes('thumb-failed')) out.push('有缩略图写入失败，下次扫描会重试')
    if (r.warnings?.includes('index-recovered')) out.push('索引文件损坏，已按本次扫描重建')
    if (r.warnings?.includes('grid-full')) out.push('收藏首屏已满，可能还有更多未索引；分页扫描尚未实现')
    if (!r.closed) out.push('面板没能确认关闭，请人工看一眼')
    return out
  }

  reg({
    name: 'wx_sticker_scan',
    description: '扫描微信收藏表情面板并更新本地索引。只点底部心形页签，不点任何表情格；会打开再关上面板。返回新增/认回/未见数量和警告。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      let r
      try {
        r = await scanStickers({ run, dir: stickerDir, log: (m) => console.log('[dsh-wx] 表情扫描：' + m) })
      } catch (err) {
        const extra = []
        if (err?.panelShot) extra.push(`截图：${err.panelShot}`)
        if (err?.closed === false) extra.push('面板可能还开着，请人工看一眼')
        throw new Error([String(err?.message ?? err), ...extra].filter(Boolean).join('；'))
      }
      const warn = stickerWarnings(r)
      return [
        `收藏表情扫描完成：共 ${r.total} 张（新增 ${r.added}，认回 ${r.matched}，本轮没看到 ${r.stale}）。`,
        r.closed ? '面板已关闭。' : '',
        ...warn.map((x) => `注意：${x}。`),
      ].filter(Boolean).join('\n')
    },
  })

  reg({
    name: 'wx_sticker_list',
    description: '列出收藏表情索引。返回 id、标签/图上文字/描述、置信度、位置和上次看到时间；不含图片。索引为空时提示先扫描。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多返回几张，1-50，默认 20' } },
    },
    output: textOut,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const limit = Number((args || {}).limit ?? 20)
      const { index, recovered } = loadIndex(stickerDir)
      const note = recovered ? '索引文件有损坏，无法解析的条目已跳过；建议重新运行 wx_sticker_scan。\n' : ''
      return note + formatList(index, listStickers(index, { limit }))
    },
  })

  reg({
    name: 'wx_sticker_find',
    description: '按关键词检索收藏表情，最多返回 5 个候选，带命中原因和置信度。结果只是候选，不等于要发送；描述置信度低时不要当成确定事实。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如“牛 收到”“打劫”“猫 无语”' },
        limit: { type: 'number', description: '最多返回几个候选，1-10，默认 5' },
      },
      required: ['query'],
    },
    output: textOut,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const query = String((args || {}).query ?? '').trim()
      if (!query) throw new Error('wx_sticker_find: query 不能为空。')
      const { index, recovered } = loadIndex(stickerDir)
      const rows = findStickers(index, query, { limit: (args || {}).limit ?? 5 })
      const note = recovered ? '索引文件有损坏，无法解析的条目已跳过；建议重新运行 wx_sticker_scan。\n' : ''
      return note + formatFind(index, query, rows)
    },
  })

  reg({
    name: 'wx_sticker_tag',
    description: '给收藏表情补图上文字、描述或标签（人工或代理标注）。只写本地派生索引，不改微信收藏本身；id 来自 wx_sticker_list 或 wx_sticker_find。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '表情 id，如 st_9edec4f0c8b4a4cc' },
        text: { type: 'string', description: '图上文字；看不清就不要填' },
        desc: { type: 'string', description: '画面描述，只写确定的内容' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签；传了就整组替换' },
        textConf: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
        descConf: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
      },
      required: ['id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const a = args || {}
      const id = String(a.id ?? '').trim()
      if (!id) throw new Error('wx_sticker_tag: id 不能为空。')
      const patch = {}
      if (a.text != null) patch.text = String(a.text)
      if (a.desc != null) patch.desc = String(a.desc)
      if (a.tags != null) patch.tags = a.tags
      if (a.textConf != null) patch.textConf = String(a.textConf)
      if (a.descConf != null) patch.descConf = String(a.descConf)
      if (a.text == null && a.desc == null && a.tags == null) {
        throw new Error('wx_sticker_tag: 至少要提供 text、desc、tags 之一。')
      }
      patch.source = 'manual'
      if (patch.text != null && patch.textConf == null) patch.textConf = 'high'
      if (patch.desc != null && patch.descConf == null) patch.descConf = 'high'
      const { index } = loadIndex(stickerDir)
      const { index: next, entry } = annotate(index, id, patch)
      saveIndex(stickerDir, next)
      const bits = []
      if (entry.tags.length) bits.push(`标签：${entry.tags.join('、')}`)
      if (entry.text) bits.push(`图上文字：${entry.text}`)
      if (entry.desc) bits.push(`描述：${entry.desc}`)
      return `已更新 ${entry.id}${bits.length ? '｜' + bits.join('｜') : ''}。`
    },
  })

  reg({
    name: 'wx_sticker_send',
    description: '按索引 id 发一张收藏表情到指定会话。表情格点下去就发送、没有二次确认：发送前会重新扫描面板、确认当前会话和格子 pHash，发送后核对聊天区新增表情并比对 pHash；任何一步不确定都不点，或如实报告未确认。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '会话全名，与 wx_send 的 chat 相同' },
        id: { type: 'string', description: '表情 id，只能来自 wx_sticker_list / wx_sticker_find' },
        task_id: { type: 'string', description: '可选：这条表情属于哪个任务，写进台账' },
      },
      required: ['chat', 'id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const r = await withSendLock(() => sendStickerToChat({
        chat: args?.chat,
        id: args?.id,
        taskId: String(args?.task_id ?? ''),
      }))
      return r.confirmed
        ? `已把表情 ${r.id} 发到「${r.chat}」。${r.receipt}${r.outMsgId ? ` 台账：${r.outMsgId}` : ''}`
        : `表情点击已执行，但没有确认发对了：${r.receipt}先用 wx_peek 看当前会话，别重复点。`
    },
  })

  reg({
    name: 'wx_sticker_collect',
    description: '把当前会话（或指定白名单会话）里最近的一条表情收藏进微信收藏。只右键那条表情并点 Add Sticker，不发消息；先截图 OCR 确认菜单里真有 Add Sticker 才点，收藏后重扫收藏页确认。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '可选：白名单里的会话全名；不传就用当前打开的会话' },
        which: { type: 'number', description: '从最新往前数第几条表情，默认 1（最近一条）' },
      },
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const r = await withSendLock(() => collectStickerFromChat({
        chat: args?.chat,
        which: args?.which,
      }))
      return r.confirmed
        ? `已收藏「${r.chat}」里的这张表情（索引 ${r.id}）。${r.receipt}`
        : `点了 Add Sticker，但没有确认收藏成功：${r.receipt}`
    },
  })

  reg({
    name: 'wx_sticker_search',
    description: '按关键词在微信表情搜索里找一张，直接发到指定白名单会话。结果是匿名网格、没有标签，调用方看不到图，pick 是按行列顺序的盲选（0 起）；点下去立即发送、没有预览和二次确认。只在你愿意直接发这张表情时用；发完可以用 wx_sticker_collect 收藏。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '会话全名，必须在发送白名单里' },
        keyword: { type: 'string', description: '搜索关键词，单行，最多 24 个字' },
        pick: { type: 'number', description: '搜索结果里的第几个，0 起、按行列顺序，默认 0（第一张）' },
        task_id: { type: 'string', description: '可选：这条表情属于哪个任务，写进台账' },
      },
      required: ['chat', 'keyword'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new Error(OFF)
      const r = await withSendLock(() => searchStickerInChat({
        chat: args?.chat,
        keyword: args?.keyword,
        pick: args?.pick,
        taskId: String(args?.task_id ?? ''),
      }))
      return r.confirmed
        ? `已把搜索「${r.keyword}」的第 ${r.pick + 1} 个结果发到「${r.chat}」。${r.receipt}${r.outMsgId ? ` 台账：${r.outMsgId}` : ''}`
        : `点了搜索结果，但没有确认发出去：${r.receipt}`
    },
  })

  return () => {
    try { clearInterval(timer) } catch { /* ignore */ }
    try { clearInterval(remindTimer) } catch { /* ignore */ }
    try { clearInterval(maintainTimer) } catch { /* ignore */ }
    try { clearTimeout(maintainEarly) } catch { /* ignore */ }
    try { clearTimeout(early) } catch { /* ignore */ }
    try { off?.() } catch { /* ignore */ }
    for (const d of disposers) {
      try { d?.() } catch { /* ignore */ }
    }
  }
}
