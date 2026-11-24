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
 * 她读到的文案只写世界里发生了什么：谁、在哪、成没成、为什么做不了。
 * 运维字段留在返回值和台账里，模型投影只给可感知的事实与下一步要抄的记号。
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
import { isContactWhy } from './contact.js'
import { canSpeak, grant, grantMentioned, parseWindowMinutes, prune as pruneMentions } from './mention.js'
import { consume as consumeProactive, decideProactive, loadState, normalizeProactive, saveState } from './proactive.js'
import { dropRecentContent, freshHits, forgetReadChats, noteContent, ownEcho, parseSeen, pruneSeen, serializeSeen } from './ear-seen.js'
import { openChatHit } from './ear-open.js'
import {
  canSendWithPolicy,
  createPermitStore,
  createReminderDeliveryWorker,
  createReminderJobStore,
  findInputBox,
  mechanicalReminderDeliveryEnabled,
  pressReturnThenMark,
  provideWxService,
} from './reminder.js'
import { captureSettings, DEFAULT_IGNORE_CHATS, isIgnoredChat, pauseReason, previewSig, shouldEnqueue } from './capture.js'
import { createCaptureQueue } from './capture-queue.js'
import { captureEvidenceKey, runCapture } from './capture-run.js'
import { createContextStore } from './context.js'
import { overdueVisibilityEnabled } from './tasks.js'
import { createReminderBackoff, runOverdueReminderPass } from './overdue.js'
import { createDirectory, mergeScanned, scanSidebar } from './directory.js'
import { createPeople } from './people.js'
import { normalizeMessages } from './transcript.js'
import { createSessionPool } from './sessions.js'
import { logLine } from './log.mjs'
import { parsePreviewSender, previewTruncated, requesterOf, samePreviewText } from './speaker.js'
import { alignSpeakers, planSpeakerRepairs } from './speaker-align.js'
import { createVectorProvider } from './vector.js'
import { annotate, loadIndex, saveIndex } from './sticker-index.js'
import { findStickers, formatFind, formatList, listStickers } from './sticker-query.js'
import { scanStickers } from './sticker-scan.js'
import { sendSticker, targetEntry } from './sticker-send.js'
import { collectSticker } from './sticker-collect.js'
import { normalizeKeyword, searchSticker } from './sticker-search.js'
import { completeFromOcrLines } from './ocr-complete.js'
import { WxToolError, registerWxToolErrorAdapter, wrapWxTool, wxFailure, wxWithText } from './tool-error.js'
import { createSendGate } from './send-gate.js'
import { ownerNoticeText } from './notify-owner.js'
import {
  applyWxSendBookkeeping,
  boundedText,
  classifyWxSend,
  clipPeekBody,
  lazyRender,
  projectWxContext,
  projectWxOcr,
  projectWxPeek,
  projectWxResult,
  projectWxSend,
  projectWxStickerCollect,
  projectWxStickerSearch,
  projectWxStickerSend,
  projectWxTaskDone,
  projectWxTaskSnooze,
  resolveSendKeys,
  shouldBookWxSend,
} from './project.js'
import { createWxSendTool } from './wx-send-tool.js'

export const name = 'dsh-wx'
// ⚠️ 不要 inject 'sessionController'：它要等工作区注册表起来才可用，而工作区是有人打开界面时才起来的。
// 写进 inject 插件整条挂不上，没人看界面时耳朵就是聋的。改成用的时候现取（ctx.get），拿不到下一轮再试。
export const inject = ['tools', 'systemPrompt', 'agents']

// 给自测用
export { parseTree, mentionHits, ocrMentionHits, contentDigest, sameName, allowedCurrent, sidebarRegion, ocrSnapshot, reconcileChatName, treeHealth, treeAction, treeMatchesOcr }
export { resolveLabel, hitTest, createFreshness }

/** QQ 等别的面看得见全局工具名单，但执行层必须拒绝微信动作。 */
export function denyWxSurface(exec) {
  const sessionId = String(exec?.agent?.session?.id ?? '')
  if (sessionId.startsWith('onebot-')) {
    throw new WxToolError('WX_WRONG_SURFACE', '[这儿动不了微信]', `cross-surface deny: session=${sessionId}`)
  }
}

const SH = fileURLToPath(new URL('./wx.sh', import.meta.url))
const SHOT_DIR = '/home/str1k3/.dsh-fish/home/.wx'
const POLICY = '/home/str1k3/.dsh-wx/policy.json'
const HEALTH = '/home/str1k3/.dsh-wx/health.json'
// 耳朵的流水账：看见什么、投没投进去。只追加，排查时不用靠 grep 宿主日志。
const INBOX = '/home/str1k3/.dsh-wx/inbound.jsonl'
const HER_DIR = '/home/str1k3/.dsh-fish/home'
// 说话频率的判定放在两个通道共用的一个文件里（QQ 那边是 vendor 补丁，用的是同一份）
const SPEECH = '/home/str1k3/dsh-plugins/speech/speech.mjs'
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
      // 主动软上限 + 硬熔断；没被 @ 时显式 0 仍表示这个群不主动。
      ...normalizeProactive(raw),
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
      // 旧调用仍可显式带 task_id；显式 false 时不再按会话名自动绑定。
      implicitTaskBinding: raw.implicitTaskBinding !== false,
      overdueVisibility: overdueVisibilityEnabled(raw),
      mechanicalReminderDelivery: mechanicalReminderDeliveryEnabled(raw),
      returnEnvelopes: raw.returnEnvelopes !== false,
    }
  } catch {
    return {
      enabled: false, allowChats: [], watch: false, trigger: [], requireMention: true,
      mentionWindowMinutes: 3, proactivePerDay: 0, proactiveChats: {}, softLimit: 0, hardBreaker: 50, noMentionChats: [],
      ignoreChats: DEFAULT_IGNORE_CHATS,
      capture: captureSettings({}),
      stickerSearch: false,
      implicitTaskBinding: true,
      overdueVisibility: true,
      mechanicalReminderDelivery: true,
      returnEnvelopes: true,
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
      return `\n[提示] 屏幕上的会话列表已变化，眼前看到的可能不是最新的（自 ${hms(stale.since)}，${Math.round((now - stale.since) / 1000)} 秒）。上面的名字和顺序可能已经变了。`
    },
  }
}

// ---------------------------------------------------------------- 提示词
/** 微信常驻段只说世界里的判断依据，名单、余额和操作手册都留在代码里。 */
export function channelRulesText(_policy = null) {
  return [
    '## 微信',
    '有人找你时，你会看见是哪个会话、谁说的、最后那句。那句多半是预览，不是全文。要看全，先点开那个会话。',
    '只在被叫到的地方说话。私聊、以及他跟你说过不用等 @ 的地方，可以自己开口。别的群，等他们叫你。',
    '对话框里他问的事，在这儿答。他没让你发去微信，就别发。',
    '发不出去就在这儿说一声。群里只说事，不说你这边怎么操作的。',
    '屏幕可能慢半拍。没看见落下去，就别说发出去了。',
  ].join('\n')
}

const requesterName = (who) => {
  const confidence = String(who?.confidence ?? 'unknown').toLowerCase()
  return who?.name && confidence !== 'low' && confidence !== 'unknown' ? String(who.name) : '有人'
}

const earPreview = (preview, who) => {
  let text = String(preview ?? '')
  const name = String(who?.name ?? '').trim()
  if (name) {
    for (const prefix of [`${name}:`, `${name}：`]) {
      if (text.trimStart().startsWith(prefix)) {
        text = text.trimStart().slice(prefix.length).trimStart()
        break
      }
    }
  }
  return text.slice(0, 120)
}

// 耳朵只递会话、谁和预览；任务由机械侧按会话绑定。
export function formatEarNote(hits, _allowChats = [], _tasks = null, extra = {}) {
  const whoOf = (chat) => (extra?.requester instanceof Map ? extra.requester.get(chat) : null)
  const body = hits.map((h) => {
    const who = whoOf(h.chat)
    return [
      `「${h.chat}」里，${requesterName(who)}说：${earPreview(h.preview, who)}`,
      '这句是侧栏上的预览，不一定是全文。',
    ].join('\n')
  })
  return ['[有人找你]', body.join('\n\n')].join('\n')
}

// 逾期只说那件事还搁着；第三次之后不再催，也不再教下一步。
export function formatOverdueNote(task, level = 1, fallbackChat = '') {
  const chat = task?.chatName || fallbackChat || task?.chatId || '那个会话'
  const who = requesterName(task?.requester)
  const preview = earPreview(task?.lastText, task?.requester).replace(/^\s*(?:@\S+\s+)+/, '')
  const lines = [
    level >= 3 ? '[这件事先放着]' : '[还没回]',
    `「${chat}」里，${who}的那句还在：${preview}`,
    '搁了有一会儿了。',
  ]
  return lines.join('\n')
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
  // 一个注册级回滚开关：默认所有微信工具走 wrapTool 对象信封；显式 false 时
  // 回到旧字符串返回与宿主错误投影适配器。中途改 policy 需要重载插件才生效。
  const toolEnvelopesEnabled = policy().returnEnvelopes !== false
  if (!toolEnvelopesEnabled) {
    disposers.push(registerWxToolErrorAdapter(ctx, { log: (m) => logLine(m) }))
  }
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
    const project = tool.project ?? ((result) => ({ text: projectWxResult(result) }))
    let core
    try { core = ctx.get?.('fishCore') } catch { core = undefined }
    if (toolEnvelopesEnabled) {
      const def = wrapWxTool({ ...base, project }, { core })
      disposers.push(ctx.tools.register(def))
      return
    }
    // 有投影的工具一律注册成懒投影：fishCore 可能在本插件 apply() 之后才出现
    //（profile 里 dsh-wx 先于 dsh-fish 加载），所以把判断推迟到 render。
    // base 必须保留 project，懒包装器才能算出投影。
    const legacy = wrapWxTool({ ...base, project }, { envelopes: false })
    const def = tool.project
      ? { ...stripProject(legacy), project, output: { ...(legacy.output ?? {}), render: lazyRender(ctx, legacy) } }
      : { ...stripProject(legacy), output: textOut }
    disposers.push(ctx.tools.register(def))
  }

  // ---- 定时提醒：一次性许可 + 「最近把谁叫醒过」 ----
  // 许可只管「到点时允许往这一个会话发一次」；它不放宽允许名单，也不改频率。
  const permitStore = createPermitStore({
    log: (m) => logLine('[dsh-wx] 提醒许可：' + m),
  })
  const reminderJobs = createReminderJobStore({
    log: (m) => logLine('[dsh-wx] 机械提醒：' + m),
  })

  // ---- 会话目录 / 多会话 ----
  // 目录是派生索引：侧栏每见到一次就合并一次；全量滚动扫描只在启动/登录后和工作台按钮点的时候做。
  // chatId 一旦分配就不换，台账、任务、向量缓存都靠它对齐。
  const directory = createDirectory({
    log: (m) => logLine('[dsh-wx] 会话目录：' + String(m ?? '').slice(0, 160)),
  })
  const sessions = createSessionPool({
    log: (m) => logLine('[dsh-wx] 会话池：' + String(m ?? '').slice(0, 160)),
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
      logLine('[dsh-wx] 会话目录合并失败：' + String(err?.message ?? err).slice(0, 120))
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
      logLine('[dsh-wx] fishGuard 没接上，检索结果暂不显示原文')
    }
    return { text: '', dropped: String(text ?? '').trim() ? 1 : 0 }
  }
  const vectorProvider = createVectorProvider({
    log: (m) => logLine('[dsh-wx] 向量检索：' + m),
  })
  const contextStore = createContextStore({
    sanitize: sanitizeForHer,
    vectorProvider: (req) => vectorProvider.provider(req),
    resolveChat,
    log: (m, err) => logLine('[dsh-wx] 上下文：' + String(m ?? '') + (err ? '（' + String(err?.message ?? err).slice(0, 120) + '）' : '')),
  })
  // 人物名册是派生索引：只增不删，写坏了按空名册处理，不影响台账。
  const people = createPeople({
    log: (m) => logLine('[dsh-wx] 人物名册：' + String(m ?? '').slice(0, 160)),
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
        logLine('[dsh-wx] 台账记不下（不影响收发）：' + String(err?.message ?? err).slice(0, 120))
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
    log: (line) => logLine('[dsh-wx] ' + line),
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
  const deny = (exec) => denyWxSurface(exec)

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
  // 本进程里已经整屏采过的会话：第一次整屏时旧消息全是「新记录」，
  // 不能拿台账当新消息的证据；之后才按台账驱动通知。
  const openChatSeen = new Set()
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

  const treeStats = { calls: 0, lastMs: 0, since: Date.now() }
  const fresh = createFreshness((m) => logLine('[dsh-wx] 树：' + m))
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
      // 工具信封要过宿主的 lossless JSON 检查：source 不能留 undefined。
      source: 'tree',
      tree: treeHealth(raw, parsed),
    }
  }

  let lastReconciled = ''
  async function ocrRead() {
    const raw = await run(['ocr'], 60_000)
    let data
    try { data = JSON.parse(raw) } catch { throw new Error('屏幕上的字没读明白。') }
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
      logLine('[dsh-wx] OCR 名字对账：' + note)
      logInbound({ type: 'ocr-reconciled', chats: fixed.map((chat) => ({ ocr: chat.ocrName, chat: chat.name })) })
    }
    return { ...data, parsed }
  }

  /**
   * 当前会话有 @ 时，用消息区 OCR 把侧栏预览的「…」补全。
   * 只在预览和整屏记录都对不上时调用；OCR 失败/更短就返回空，调用方保留原预览。
   */
  async function ocrCompleteCurrent(preview) {
    const body = parsePreviewSender(String(preview ?? '')).text || String(preview ?? '')
    if (!body) return ''
    const data = jsonLine(await run(['ocr-messages'], 60_000))
    if (!data?.ok || !Array.isArray(data.lines) || data.lines.length === 0) return ''
    return completeFromOcrLines(body, data.lines)
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
      if (h.status === 'ok') logLine(`[dsh-wx] 树恢复：${h.elements} 个元素、${h.chats} 个会话`)
      else logLine(`[dsh-wx] 树状态：${h.status}（元素 ${h.elements}、会话 ${h.chats}）`)
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
      if (treeAlert !== prevAlert) logLine('[dsh-wx] 树：' + treeAlert)
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
    logLine('[dsh-wx] 树：' + treeAlert)
    logInbound({ type: 'tree-restart', attempt: treeAttempts, status: treeLast?.status, elements: treeLast?.elements, chats: treeLast?.chats })
    writeHealth()
    const bus = await run(['bus-start'], 30_000).then(jsonLine).catch((e) => jsonLine(e?.message))
    if (!bus?.ok) {
      treeRetryAfter = Date.now() + TREE_RESTART_COOLDOWN_MS
      treeAlert = `${when}读不到无障碍树，而且无障碍总线没起来：先不重启微信，等总线恢复`
      logLine('[dsh-wx] 树：' + treeAlert)
      logInbound({ type: 'tree-error', error: treeAlert, bus })
      writeHealth()
      return
    }
    try {
      const r = await run(['restart'], 90_000).then(jsonLine).catch((e) => jsonLine(e?.message))
      if (!r?.ok) throw new Error(r?.error || '重启命令没有返回 ok')
      treeRetryAfter = Date.now() + TREE_RESTART_SETTLE_MS
      treeAlert = `${when}微信没连上无障碍树，已重启微信（${r.oldPid}→${r.pid}），等树恢复`
      logLine('[dsh-wx] 树：' + treeAlert)
      logInbound({ type: 'tree-restarted', attempt: treeAttempts, ...r })
    } catch (error) {
      treeRetryAfter = Date.now() + TREE_RESTART_COOLDOWN_MS
      treeAlert = `${when}微信没连上无障碍树，重启失败：` + String(error?.message ?? error).slice(0, 120)
      logLine('[dsh-wx] 树：' + treeAlert)
      logInbound({ type: 'tree-error', error: treeAlert, attempt: treeAttempts })
    }
    writeHealth()
  }

  // ---- @ 才回：谁最近被 @ 过 ----
  // 耳朵看见侧栏有人 @ 她 → 盖戳；发送前查这里。手动 poke 也会盖。
  // 必须在发送闸之前声明：createSendGate 立刻读这个函数引用，放在后面会触发 TDZ。
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

  // ---- 发送前的闸 ----
  // 以前是 `tree.includes(名单里的名字)`：会话列表里永远有那个群，所以不管当前开着谁都放行。
  // 现在只认「当前会话」这一个字段，并且要求树没落后（落后时当前会话可能是旧的）。
  const gateSend = createSendGate({
    policy,
    hostBlocksSend,
    look,
    isStale: () => Boolean(fresh.stale),
    staleDetail: () => fresh.notice(),
    allowedCurrent,
    sameName,
    canSpeak,
    readMentions,
    loadState,
    decideProactive,
    consumeProactive,
    saveState,
    logInbound,
    now: Date.now,
  })

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
    if (!v.ok) throw new WxToolError('WX_RATE_LIMIT', '[说得太密了，等一下]')
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
   * 把一句话发到指定会话。预期失败返回 ok:false；意外异常仍抛出，让调用方如实说。
   * permit 存在时只绕过 @ / 主机闸；允许名单、说话频率、当前会话核对都照走。
   */
  async function sendToChat(args = {}) {
    try {
      return await sendToChatUnsafe(args)
    } catch (error) {
      if (error instanceof WxToolError) {
        return wxFailure(error.code, error.modelText, error.rawDetail)
      }
      throw error
    }
  }

  async function sendToChatUnsafe({
    chat, targetChat = '', targetChatId = '', text, permit = '', taskId = '', replyTask = null, onReturn = null,
  } = {}) {
    const p = policy()
    if (!p.enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]', '微信通道已关闭。')
    const want = String(chat ?? '').trim()
    const navigateTo = String(targetChat ?? '').trim() || want
    const body = String(text ?? '')
    if (!want) throw new WxToolError('WX_MISSING_CHAT', '[没做成，过会儿再试]', '没有指定要发到哪个会话。')
    if (!body) throw new WxToolError('WX_INVALID_TEXT', '[这句话发不出去]', '要发送的正文为空。')
    if (/[\r\n]/.test(body)) throw new WxToolError('WX_INVALID_TEXT', '[这句话发不出去]', '要发送的正文含换行。')
    if ([...body].length > 500) throw new WxToolError('WX_INVALID_TEXT', '[这句话发不出去]', `要发送的正文过长：${[...body].length} 字。`)

    const allowed = canSendWithPolicy(p, want)
    if (!allowed.ok) throw new WxToolError('WX_NOT_ALLOWED', '[这个会话现在说不了]', allowed.why)
    const gateTarget = { chat: allowed.chat, canonicalChat: navigateTo, chatId: String(targetChatId ?? '').trim() }

    const token = String(permit ?? '').trim()
    if (token) {
      // 到点提醒：许可绑定会话 + 原文 + 一次性。这里只查，不消费。
      const v = permitStore.check({ id: token, chat: allowed.chat, text: body })
      if (!v.ok) throw new WxToolError('WX_PERMIT_INVALID', '[这句和你当时定的不一样，没发出去]', v.why)
    }

    let s = await look()
    if (!s.parsed.ok) throw new WxToolError('WX_WINDOW_UNAVAILABLE', '[没看清。屏幕可能慢半拍]')
    if (fresh.stale) throw new WxToolError('WX_TREE_STALE', '[没看清。屏幕可能慢半拍]')

    if (!sameName(s.parsed.current, navigateTo)) {
      const target = s.parsed.chats.find((c) => sameName(c.name, navigateTo))
      if (!target) throw new WxToolError('WX_CHAT_NOT_FOUND', '[这个会话现在说不了]')
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset()
      await run(['click', String(target.box.cx), String(target.box.cy), '1'])
      await sleep(700)
      s = await look({ confirm: false })
      if (fresh.stale) throw new WxToolError('WX_TREE_STALE', '[没看清。屏幕可能慢半拍]')
      if (!sameName(s.parsed.current, navigateTo)) {
        throw new WxToolError(
          'WX_CHAT_CHANGED',
          '[没做成，过会儿再试]',
          `切到目标会话后 expected=${navigateTo}；actual=${s.parsed.current || '读不到'}`,
        )
      }
    }

    if (!token) {
      // 许可只免 @ / 主机两道闸；频率和名单仍然要过（频率在回车前只记一次）。
      const g = await gateSend({ target: gateTarget })
      if (!sameName(g.chat, allowed.chat)) {
        throw new WxToolError(
          'WX_CHAT_CHANGED',
          '[没做成，过会儿再试]',
          `发送闸复核 expected=${allowed.chat}；actual=${g.chat}`,
        )
      }
    }

    // 清浮层再重新读一次坐标：点开会话后布局可能变了。
    await run(['clean'], 30_000).catch(() => '')
    fresh.reset()
    s = await look({ confirm: false })
    if (fresh.stale) throw new WxToolError('WX_TREE_STALE', '[没看清。屏幕可能慢半拍]')
    if (!sameName(s.parsed.current, navigateTo)) {
      throw new WxToolError(
        'WX_CHAT_CHANGED',
        '[没做成，过会儿再试]',
        `清浮层后 expected=${navigateTo}；actual=${s.parsed.current || '读不到'}`,
      )
    }
    const focus = findInputBox(s.parsed)
    if (!focus) throw new WxToolError('WX_INPUT_NOT_FOUND', '[没做成，过会儿再试]')
    await run(['click', String(focus.box.cx), String(focus.box.cy), '1'])
    await sleep(300)
    await run(['type', body], 60_000)

    // 回车之前再核对一次：打字期间界面可能切走。
    await sleep(300)
    if (token) {
      const again = permitStore.check({ id: token, chat: allowed.chat, text: body })
      if (!again.ok) throw new WxToolError('WX_PERMIT_INVALID', '[这句和你当时定的不一样，没发出去]')
      const now = await look({ confirm: false })
      if (!sameName(now.parsed.current, navigateTo)) {
        throw new WxToolError(
          'WX_CHAT_CHANGED',
          '[没做成，过会儿再试]',
          `回车前许可复核 expected=${navigateTo}；actual=${now.parsed.current || '读不到'}`,
        )
      }
    } else {
      const g = await gateSend({ target: gateTarget })
      if (!sameName(g.chat, allowed.chat)) {
        throw new WxToolError(
          'WX_CHAT_CHANGED',
          '[没做成，过会儿再试]',
          `回车前发送闸复核 expected=${allowed.chat}；actual=${g.chat}`,
        )
      }
    }
    // 频率闸只在这里记一次：前面两次核对都不占额度。
    await speechGate(resolveSendKeys({
      chat: allowed.chat, canonicalChat: navigateTo, chatId: gateTarget.chatId,
    }).speech)
    // 频率闸可能要等，等完再看一眼当前会话，别在等待期间被切走。
    let proactive = false
    let proactiveLeft = 0
    if (token) {
      const still = permitStore.check({ id: token, chat: allowed.chat, text: body })
      if (!still.ok) throw new WxToolError('WX_PERMIT_INVALID', '[这句和你当时定的不一样，没发出去]')
      const last = await look({ confirm: false })
      if (!sameName(last.parsed.current, navigateTo)) {
        throw new WxToolError(
          'WX_CHAT_CHANGED',
          '[没做成，过会儿再试]',
          `频率闸后许可复核 expected=${navigateTo}；actual=${last.parsed.current || '读不到'}`,
        )
      }
    } else {
      // 最后一道闸：真正回车前才扣主动额度，一次发送只扣一次。
      const last = await gateSend({ consume: true, target: gateTarget })
      proactive = last.proactive
      proactiveLeft = last.proactiveLeft
      if (!sameName(last.chat, allowed.chat)) {
        throw new WxToolError(
          'WX_CHAT_CHANGED',
          '[没做成，过会儿再试]',
          `扣主动额度后 expected=${allowed.chat}；actual=${last.chat}`,
        )
      }
    }

    await pressReturnThenMark({
      pressReturn: () => run(['key', 'Return']),
      onReturn,
      log: (m) => logLine('[dsh-wx] ' + m),
    })
    await sleep(900)

    if (token) {
      const used = permitStore.consume({ id: token, chat: allowed.chat, text: body })
      if (!used.ok) logLine('[dsh-wx] 提醒许可作废失败：' + used.why)
    }

    const after = await look({ confirm: false })
    const typed = body.replace(/\s+/g, ' ').replace(/"/g, '＂')
    const head = typed.slice(0, 14)
    const inMsgs = after.parsed.messages.slice(-4).some((m) => m.text.includes(head))
    const chatRow = after.parsed.chats.find((c) => sameName(c.name, navigateTo))
    const inPreview = !!chatRow && chatRow.preview.includes(head.slice(0, 10))
    const receipt = inMsgs
      ? '末尾那儿已经出现了。'
      : inPreview
        ? '侧栏里能看到，最后那条消息里还没看见。'
        : '末尾和侧栏都还没看见；先别当它发出去了。'
    const sent = classifyWxSend({ inMsgs, inPreview })
    // 侧栏预览也要进回声保护；只有末尾真看见才写历史、任务回复。
    const booked = applyWxSendBookkeeping({
      sent,
      chat: navigateTo,
      text: body,
      noteOutbox,
      capture: () => contextStore.capture({
          chat: navigateTo,
          source: 'sent',
          taskId,
          ignoreChats: p.ignoreChats,
          messages: [{
            sender: null, senderConfidence: 'unknown', direction: 'out', kind: 'text',
            text: body, at: new Date().toISOString(), atConfidence: 'medium', source: 'sent',
          }],
      }),
      replyTask,
    })
    // 发送本身也算一次活动：给后台采集留出静默期，别紧接着点开会话。
    quietUntil = Math.max(quietUntil, Date.now() + p.capture.quietMs)
    return {
      ok: true,
      chat: allowed.chat,
      targetChat: navigateTo,
      receipt,
      sent,
      outMsgId: booked.outMsgId,
      booking: booked,
      proactive,
      proactiveLeft,
    }
  }

  /**
   * 按索引 id 发一张收藏表情。与 wx_send 共用同一套闸：允许名单、@、频率、当前会话核对。
   * 表情格点下去就发送、没有二次确认，所以点之前会重新扫描面板并核对 pHash，点之后核对消息区。
   * 不写文本 outbox：表情在预览里都是 "[Sticker]"，写进去会让别人发的同款表情被当成自己的回声。
   */
  function stickerOperationalFailure(error, code, message) {
    if (error instanceof WxToolError) return wxFailure(error.code, error.modelText, error.rawDetail)
    if (error instanceof TypeError) return null
    const detail = String(error?.message ?? error ?? '')
    if (/缺少\s*run\(\)|缺少\s*look\(\)/.test(detail)) return null
    return wxFailure(code, message, detail)
  }

  async function sendStickerToChat(args = {}) {
    try {
      return await sendStickerToChatUnsafe(args)
    } catch (error) {
      const failure = stickerOperationalFailure(error, 'WX_STICKER_SEND_FAILED', '[表情没发出去]')
      if (failure) return failure
      throw error
    }
  }

  async function sendStickerToChatUnsafe({ chat, id, taskId = '' } = {}) {
    const p = policy()
    if (!p.enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
    const want = String(chat ?? '').trim()
    const sid = String(id ?? '').trim()
    if (!want) throw new Error('wx_sticker_send: chat 不能为空。')
    if (!sid) throw new Error('还没说是哪张表情。')

    const allowed = canSendWithPolicy(p, want)
    if (!allowed.ok) throw new Error(allowed.why)

    // 先把索引核对完再碰界面：id 不存在、旧索引缺 artHash、已从收藏删除，都不打开面板。
    targetEntry(loadIndex(stickerDir).index, sid)

    let s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，无法确认会话，不发送。')
    if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了会话，先不发。' + fresh.notice().trim())

    if (!sameName(s.parsed.current, allowed.chat)) {
      const target = s.parsed.chats.find((c) => sameName(c.name, allowed.chat))
      if (!target) throw new Error(`会话列表里没有「${allowed.chat}」，不发送。`)
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset()
      await run(['click', String(target.box.cx), String(target.box.cy), '1'])
      await sleep(700)
      s = await look({ confirm: false })
      if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了会话，先不发。' + fresh.notice().trim())
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
    if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了现在停在哪儿，先不发。' + fresh.notice().trim())
    if (!sameName(s.parsed.current, allowed.chat)) {
      throw new Error(`当前会话是「${s.parsed.current || '读不到'}」，不是「${allowed.chat}」，不发送。`)
    }
    const before = s.parsed.messages ?? []

    // 频率闸只记一次；等完再看一眼会话，别在等待期间被切走。
    await speechGate(allowed.chat)
    // 最后一道闸：表情点下去就发送，主动额度也在这里扣。
    const last = await gateSend({ consume: true, expected: allowed.chat })
    if (!sameName(last.chat, allowed.chat)) throw new Error(`等待发送期间当前会话变成了「${last.chat}」，不发送。`)

    const r = await sendSticker({
      run,
      dir: stickerDir,
      id: sid,
      before,
      look: () => look({ confirm: false }),
      log: (m) => logLine('[dsh-wx] 表情发送：' + m),
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
    return { ok: true, chat: allowed.chat, ...r, outMsgId, proactive: last.proactive, proactiveLeft: last.proactiveLeft }
  }

  /**
   * 把聊天里的一条表情收藏进微信收藏。只右键气泡、点 Add Sticker，不发送任何消息。
   * 不指定 chat 时只处理当前打开的会话；指定了就必须在白名单里，不为了收藏去点陌生会话。
   */
  async function collectStickerFromChat(args = {}) {
    try {
      return await collectStickerFromChatUnsafe(args)
    } catch (error) {
      const failure = stickerOperationalFailure(error, 'WX_STICKER_COLLECT_FAILED', '[没收藏下来]')
      if (failure) return failure
      throw error
    }
  }

  async function collectStickerFromChatUnsafe({ chat = '', which = 1 } = {}) {
    const p = policy()
    if (!p.enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
    const want = String(chat ?? '').trim()
    let s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，不采集。')
    if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了会话，先不收。' + fresh.notice().trim())

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
        if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了会话，先不收。' + fresh.notice().trim())
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
      log: (m) => logLine('[dsh-wx] 表情收藏：' + m),
    })
    return { ...r, chat: s.parsed.current }
  }

  /**
   * 在表情搜索里按关键词找一张，直接发到白名单会话。
   * 搜索结果没有标签、她看不到图，pick 是盲选；点下去立即发送，没有预览确认。
   * 点之前再确认一次当前会话，避免耳朵在搜索期间把会话切走、表情发错人。
   */
  async function searchStickerInChat(args = {}) {
    try {
      return await searchStickerInChatUnsafe(args)
    } catch (error) {
      const failure = stickerOperationalFailure(error, 'WX_STICKER_SEARCH_FAILED', '[表情没发出去]')
      if (failure) return failure
      throw error
    }
  }

  async function searchStickerInChatUnsafe({ chat, keyword, pick = 0, taskId = '' } = {}) {
    const p = policy()
    if (!p.enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
    if (!p.stickerSearch) throw new Error('关键词搜索采集已关闭（policy.json 里 stickerSearch=false）。')
    const want = String(chat ?? '').trim()
    if (!want) throw new Error('wx_sticker_search: chat 不能为空。')
    const word = normalizeKeyword(keyword)

    const allowed = canSendWithPolicy(p, want)
    if (!allowed.ok) throw new Error(allowed.why)

    let s = await look()
    if (!s.parsed.ok) throw new Error('读不到微信窗口，无法确认会话，不搜索。')
    if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了会话，先不找。' + fresh.notice().trim())

    if (!sameName(s.parsed.current, allowed.chat)) {
      const target = s.parsed.chats.find((c) => sameName(c.name, allowed.chat))
      if (!target) throw new Error(`会话列表里没有「${allowed.chat}」，不搜索。`)
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset()
      await run(['click', String(target.box.cx), String(target.box.cy), '1'])
      await sleep(700)
      s = await look({ confirm: false })
      if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了会话，先不找。' + fresh.notice().trim())
      if (!sameName(s.parsed.current, allowed.chat)) {
        throw new Error(`点了「${allowed.chat}」，但当前会话是「${s.parsed.current || '读不到'}」，不搜索。`)
      }
    }

    const g = await gateSend()
    if (!sameName(g.chat, allowed.chat)) throw new Error(`当前会话变成了「${g.chat}」，不是「${allowed.chat}」，不搜索。`)

    // 频率闸只记一次；等完再确认会话。
    await speechGate(allowed.chat)
    // 最后一道闸：搜索结果点下去就发送，主动额度也在这里扣。
    const last = await gateSend({ consume: true, expected: allowed.chat })
    if (!sameName(last.chat, allowed.chat)) throw new Error(`等待发送期间当前会话变成了「${last.chat}」，不搜索。`)

    await run(['clean'], 30_000).catch(() => '')
    fresh.reset()
    s = await look({ confirm: false })
    if (fresh.stale) throw new Error('屏幕可能慢半拍，确认不了现在停在哪儿，先不找。' + fresh.notice().trim())
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
      log: (m) => logLine('[dsh-wx] 表情搜索：' + m),
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
    return { ok: true, chat: allowed.chat, ...r, outMsgId, proactive: last.proactive, proactiveLeft: last.proactiveLeft }
  }

  // 说明只挂她一个 agent：会话 cwd 就是她的屋子
  const off = ctx.on?.('agent/created', ({ agent } = {}) => {
    try {
      const cwd = String(agent?.session?.header?.cwd ?? '').replace(/\/+$/, '')
      if (cwd !== HER_DIR) return
      // QQ 会话（onebot-*）不挂微信说明：说明里的内容会被带进 QQ 的话里
      if (String(agent?.session?.id ?? '').startsWith('onebot-')) return
      logLine('[dsh-wx] 拿到她的 agent（' + String(agent?.session?.id ?? '?') + '）')
      // 只挂一段会改变下一句判断的现实规则；具体动作由当时可见的说明负责。
      agent.ctx?.systemPrompt?.section?.({
        name: 'channel:dsh-wx',
        order: 92,
        text: () => channelRulesText(policy()),
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
  // 近期投过的「会话 + 正文」，按内容拦同一句话换 key 重投（不随会话已读清空）
  const recentContent = []
  let lastFailLog = 0
  let lastRelogin = 0
  let scanning = false
  // 全量目录扫描只在两个时候做：启动后/登录后的第一轮，和工作台按钮。
  // 每轮快照本来就会合并侧栏可见行，全量扫描只补当前页看不到的会话和截断名；
  // 它不产生台账，也不产生通知，没必要每 10 分钟滚一次侧栏。
  let directoryScanArmed = true
  let loginWasSeen = false
  // 工作台按钮排进来的扫描请求：等耳朵这一轮空下来再做，返回结果给按钮。
  let scanRequests = []
  /** 排队请求一次全量目录扫描。耳朵不跑（没启动/被关掉）时按超时给一句人话。 */
  const requestDirectoryScan = (timeoutMs = 30_000) => new Promise((resolve) => {
    scanRequests.push(resolve)
    const t = setTimeout(() => resolve({ ok: false, why: '耳朵没响应，过一会儿再试' }), timeoutMs)
    t.unref?.()
  })

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
    logLine('[dsh-wx] 微信会话：' + id)
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
      logLine('[dsh-wx] 会话池：' + chatName + ' → ' + id)
      return id
    } catch (err) {
      logLine('[dsh-wx] 会话池建 worker 失败，回落主会话：' + String(err?.message ?? err).slice(0, 120))
      return main
    }
  }

  /** 投递成功后记一次 contact：惰性取 fishCore，拿不到就当没这回事，不影响投递。 */
  const markContact = () => {
    try {
      const core = ctx.get?.('fishCore')
      const p = core?.memory?.markSeen?.({ source: 'wx' })
      if (p?.catch) p.catch(() => {})
    } catch { /* 记忆写失败不影响投递 */ }
  }

  /** 投递到指定的群会话；会话没了就清映射、重试主会话。 */
  const deliverToChat = async (chatName, chatId, text, opts = {}) => {
    const sid = await sessionForChat(chatName, chatId)
    try {
      await deliver(sid, text, opts)
      return sid
    } catch (err) {
      if (!/not-found|unknown session|no such session/i.test(String(err?.message ?? err))) throw err
      sessions.remove(chatId)
      if (sid === wxSessionId) {
        wxSessionId = ''
        saveWxSession('')
      }
      const main = await ensureWxSession()
      await deliver(main, text, opts)
      return main
    }
  }
  const early = setTimeout(() => {
    ensureWxSession().catch((e) => logLine('[dsh-wx] 还建不了微信会话（下一轮再试）：' + String(e?.message ?? e).slice(0, 120)))
  }, 12_000)
  early.unref?.()

  /** 第二个参数是 AbortSignal：宿主这个 Remote 方法开头就 signal.throwIfAborted()，不传会抛。 */
  const deliver = (sessionId, text, { contact = false } = {}) => {
    const p = controller().prompt({
      sessionId,
      requestId: randomUUID(),
      content: [{ type: 'text', text }],
    }, new AbortController().signal)
    if (contact) p.then(markContact, () => {})
    return p
  }

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
        // 只有滚到底的完整扫描才有资格洗掉重复名临时记录：没扫全就不能断定只剩一个。
        reconcile: res.complete === true,
      })
      fresh.reset('目录扫描滚动了侧栏，旧基线作废')
      logLine(`[dsh-wx] 目录扫描：${res.pages} 页、${merged.length} 个会话（${res.reason}）`)
      logInbound({ type: 'directory-scan', pages: res.pages, chats: merged.length, reason: res.reason, complete: res.complete })
      return res
    } finally {
      scanning = false
    }
  }

  // 逾期提醒节奏：建任务后 15 分钟第一次，之后 +45 分钟、+3 小时；第三次后卡住等人工。
  const REMIND_NEXT_MS = { 1: 45 * 60_000, 2: 3 * 3600_000, 3: 60_000 }
  let reminderBusy = false
  const reminderBackoff = createReminderBackoff()
  let lastMaintainAt = 0
  const overdueText = (t, level) => formatOverdueNote(t, level, chatNameOfId(t.chatId))

  /**
   * 逾期泵：每分钟看一次。只催她，不替她发；投递失败不记提醒。
   * 任务板写不进去时先探测可写性并按任务退避，避免同一句话重复投递。
   */
  const reminderPump = async () => {
    if (reminderBusy || hostBusy()) return
    const p = policy()
    if (!p.enabled || p.watch === false) return
    reminderBusy = true
    try {
      await runOverdueReminderPass({
        board: contextStore.board,
        at: Date.now(),
        maxLevel: 3,
        finalBlock: p.overdueVisibility,
        backoff: reminderBackoff,
        log: (m) => logLine('[dsh-wx] 逾期：' + String(m ?? '').slice(0, 300)),
        deliver: async (t, level) => {
          const chat = canonicalName(t.chatName || chatNameOfId(t.chatId))
          if (!chat) throw new Error('会话名当前解析不到')
          const sessionId = await deliverToChat(chat, t.chatId, overdueText(t, level))
          // 提醒本身也算叫了她一次：这个会话的 @ 窗口重新打开，才允许回。
          saveMentions(grant(readMentions(), chat, Date.now()))
          noteRecent([chat])
          return { ok: true, chat, sessionId }
        },
        nextCheckAt: (_t, level) => new Date(Date.now() + (REMIND_NEXT_MS[level] ?? REMIND_NEXT_MS[3])).toISOString(),
        note: (_t, level) => `第 ${level} 次逾期提醒`,
        onPersisted: ({ task, level, chat }) => {
          logLine(`[dsh-wx] 逾期提醒 ${level}/3 → ${chat}（${task.taskId}）`)
          logInbound({ type: 'overdue-reminded', taskId: task.taskId, chatId: task.chatId, chat, level })
        },
      })
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
        logLine(`[dsh-wx] 维护：归档 ${r.archive.archived.length} 个文件、摘要 ${r.summaries.written.length} 天`)
      }
    } catch (err) {
      logLine('[dsh-wx] 维护失败：' + String(err?.message ?? err).slice(0, 120))
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
  const reminderDelivery = createReminderDeliveryWorker({
    jobs: reminderJobs,
    permits: permitStore,
    getEnabled: () => policy().mechanicalReminderDelivery,
    now: Date.now,
    log: (m) => logLine('[dsh-wx] 机械提醒：' + String(m ?? '').slice(0, 300)),
    sendReminder: (req) => withSendLock(() => sendToChat(req)),
  })
  reminderDelivery.recover()
  const wxService = {
    policy,
    canSend,
    // 工作台按钮（dsh-fish 的 /wx/scan 路由）：补扫一次侧栏目录。
    // 目录只是派生索引，扫它不改台账、不发通知。
    scanDirectory: () => (policy().enabled
      ? requestDirectoryScan()
      : Promise.resolve({ ok: false, why: '微信通道已关闭' })),
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
    // 工作汇总回到固定的主人私聊：走正常发送闸和串行锁，不跟随派活来源。
    notifyOwner: async ({ text, chat } = {}) => {
      const target = String(chat ?? '').trim()
      if (!target) return { ok: false, why: 'no-chat' }
      let guard = null
      try { guard = ctx.get?.('fishGuard') ?? null } catch { guard = null }
      const prepared = ownerNoticeText(text, { looksLikeSecret: guard?.looksLikeSecret })
      if (!prepared.ok) return { ok: false, why: prepared.why }
      try {
        return await withSendLock(() => sendToChat({ chat: target, text: prepared.text }))
      } catch (err) {
        return { ok: false, why: String(err?.message ?? err).slice(0, 160) }
      }
    },
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
    reminderDelivery: {
      enabled: reminderDelivery.enabled,
      create: (req = {}) => {
        const sessionId = String(req.sessionId ?? '').trim()
        if (!isWxSession(sessionId)) return { ok: false, why: '定时提醒只能在微信这条会话里定。' }
        const c = canSend(req.chat)
        if (!c.ok) return c
        if (!isRecentChat(c.chat)) {
          return { ok: false, why: `最近把你叫醒的会话里没有「${c.chat}」，不能往那里定提醒。` }
        }
        return reminderDelivery.create({ ...req, sessionId, chat: c.chat })
      },
      list: ({ sessionId = '' } = {}) => (isWxSession(sessionId)
        ? reminderDelivery.list({ sessionId })
        : []),
      cancel: (req = {}) => (isWxSession(req.sessionId)
        ? reminderDelivery.cancel(req.id, { sessionId: req.sessionId })
        : { ok: false, why: '定时提醒只能在微信这条会话里取消。' }),
      deliverDue: (req) => reminderDelivery.deliverDue(req),
      peekNotices: (req) => reminderDelivery.peekNotices(req),
      ackNotices: (req) => reminderDelivery.ackNotices(req),
      takeNotices: (req) => reminderDelivery.takeNotices(req),
    },
  }
  const wxProvided = provideWxService(ctx, wxService)
  if (wxProvided.ok) logLine('[dsh-wx] 已向 dsh-fish 暴露 wx 服务')
  else logLine('[dsh-wx] wx 服务没挂上：' + wxProvided.why)
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
      logLine('[dsh-wx] 采集：当前会话 OCR 失败（' + String(err?.message ?? err).slice(0, 120) + '）')
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
        logLine('[dsh-wx] 采集：暂停（' + reason + '）')
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
        log: (m) => logLine('[dsh-wx] 采集：' + String(m ?? '').slice(0, 160)),
      }))
      if (r.ok) {
        for (const name of r.ocrSenders ?? []) {
          people.learn({ name, source: 'ocr', chatId: jobChatId, evidenceKey: r.ocrEvidenceKey })
        }
        queue.done(job.chat)
        capturedSinceStart.add(job.chat)
        quietUntil = Date.now() + settings.quietMs
        captureHealth = { ...captureHealth, lastAt: new Date().toISOString(), lastChat: job.chat, lastResult: `added:${r.added} skipped:${r.skipped}`, lastError: '' }
        if (r.added > 0) logLine(`[dsh-wx] 采集：${job.chat} +${r.added}（回滚 ${r.scrolled} 屏）`)
      } else {
        queue.fail(job.chat)
        captureHealth = { ...captureHealth, lastError: r.why ?? 'failed' }
        logLine('[dsh-wx] 采集：' + job.chat + ' 失败（' + (r.why ?? '') + '）')
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
        logLine('[dsh-wx] 树：' + treeAlert)
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
          logLine('[dsh-wx] OCR 回退失败: ' + String(error?.message ?? error).slice(0, 120))
        }
      }

      // 手机端一上线，PC 微信常被踢回登录页：窗口缩成 291x396，侧栏读不到任何会话，
      // 耳朵从此聋掉（日志只写「侧栏 @ 行 0 条」，看着像没人说话）。
      // 2026-10-29 夜里实测：替她点 Log In 会让手机端一直弹登录确认，人被烦死。
      // 所以只记账、不动手——登不登由人决定；treeAction 也明确不重启登录页。
      if (tree.status === 'login') {
        loginWasSeen = true
        // 登录页读不到侧栏，排队的扫描做不了；先把工作台那颗按钮的等待结掉。
        if (scanRequests.length) {
          const waiters = scanRequests.splice(0)
          for (const done of waiters) done({ ok: false, why: '微信在登录页，登录后再扫' })
        }
        if (Date.now() - lastRelogin > 10 * 60_000) {
          lastRelogin = Date.now()
          logLine(`[dsh-wx] 微信在登录页（窗口 ${tree.window?.w}x${tree.window?.h}），等人工登录`)
        }
        return
      }

      // 树没连上、OCR 也没读到会话行：这一轮没有可看的东西，等树恢复/下一轮。
      if (!tree.ok && !ocrRecovered) return
      // 刚从登录页回来：补一次全量目录扫描（登录后第一轮，目录可能落后了很久）。
      if (loginWasSeen) {
        loginWasSeen = false
        directoryScanArmed = true
      }
      // 工作台按钮请求的扫描：在耳朵这一轮里做，和快照/滚动的单写者串行。
      // 扫完就结束这一轮——侧栏被滚动过，旧快照不再适合做投递判断，下一轮重新对账。
      if (scanRequests.length) {
        const waiters = scanRequests.splice(0)
        const res = await scanDirectoryNow().catch((err) => ({ ok: false, why: String(err?.message ?? err).slice(0, 160) }))
        for (const done of waiters) done(res)
        return
      }
      roundParsed = parsed
      // 只有树健康时才写预览台账：partial/down/login 没有可信数据。
      // OCR 回退只用于识别 @，不拿它写预览。
      // 返回值（每行 prevSig/sig）留给 finally 的 captureTick 在更新快照前入队。
      if (tree.ok && !ocrRecovered) roundPreview = recordPreviews(parsed)
      // 当前会话的发言人补全：失败只记日志，不阻塞本轮。
      await maybeOcrCurrent(p)
      // 启动 / 登录后的首轮补一次全量扫描；之后只在工作台按钮点的时候扫。
      if (!ocrRecovered && directoryScanArmed) {
        directoryScanArmed = false
        await scanDirectoryNow().catch((err) => {
          logLine('[dsh-wx] 目录扫描失败：' + String(err?.message ?? err).slice(0, 120))
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
      // 第一次看见这个会话，靠「这一轮新记的入站正文和侧栏 preview 对得上」认；
      // 之后台账只追加新记录，新记下的入站就是证据（preview 没刷新也认）。
      // 先进 pendingCaptureHits，hostBusy / 15 秒节流 / 投递失败时下一轮还能重试。
      if (tree.ok && !ocrRecovered) {
        const openRow = (parsed.chats ?? []).find((c) => sameName(c.name, parsed.current)) ?? null
        const openEntry = directory.entry(parsed.current)
        const openHit = openChatHit({
          chat: parsed.current, row: openRow, captured: s.capturedCurrent, policy: p,
          // 第一次看见这个会话时整屏都是「新记录」，只能靠侧栏预览认出新消息；
          // 之后台账只追加这一轮新记下的入站记录，台账本身就是新消息的证据。
          requirePreviewMatch: !openChatSeen.has(String(parsed.current ?? '')),
          isDM: openEntry?.kind === 'dm' ? true : (openEntry?.kind === 'group' ? false : null),
          outbox: outboxFor(parsed.current),
        })
        if (s.capturedCurrent?.ok) openChatSeen.add(String(parsed.current ?? ''))
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
      // 当前会话被 @：侧栏预览可能被微信截成「…」。先看整屏这一轮有没有全文；
      // 没有就立刻 OCR 右侧消息区补全，再交给她。已经投过/刚投过的不用再 OCR。
      if (tree.ok && !ocrRecovered && parsed.current) {
        for (const m of mentions) {
          if (!sameName(m.chat, parsed.current)) continue
          if (m.why !== '@' && m.why !== 'name') continue
          if (seen.has(m.key)) continue
          if (dropRecentContent([m], recentContent).length === 0) continue
          const pv = parsePreviewSender(String(m.preview ?? ''))
          const body = pv.text || String(m.preview ?? '')
          // 预览没被截断就是完整一句，别让 OCR 的噪声把它换掉。
          if (!body || !previewTruncated(body)) continue
          const prefix = pv.sender ? `${pv.sender}: ` : ''
          const rec = (s.capturedCurrent?.records ?? [])
            .filter((r) => r && r.direction === 'in' && r.text && samePreviewText(body, r.text))
            .at(-1)
          if (rec?.text && [...String(rec.text)].length > [...body].length) {
            m.preview = prefix + String(rec.text)
            continue
          }
          try {
            const full = await ocrCompleteCurrent(m.preview)
            if (full && [...full].length > [...body].length) {
              m.preview = prefix + full
              logInbound({ type: 'ocr-complete', chat: m.chat, preview: m.preview.slice(0, 160) })
            }
          } catch { /* OCR 补不全就用原预览，不阻塞投递 */ }
        }
      }
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
        logLine(`[dsh-wx] 耳朵：侧栏 @ 行 ${now.size} 条${now.size ? ' → ' + [...now.values()].map((m) => m.chat).join('、') : ''}`)
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
        await deliver(await ensureWxSession(), `[微信·叫你] ${poke}`)
        logLine('[dsh-wx] 耳朵：主机塞了一句进去 → ' + poke.slice(0, 60))
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
      const suppressed = []
      const fresh1 = freshHits([...now.values()], seen, {
        isEcho: (m) => ownEcho(m.chat, m.preview, outbox, { echoMs: ECHO_MS }),
        onDuplicate: (m) => suppressed.push(m),
      })
      // freshHits 按正文拦下的命中（例如预览键和 capture 键是同一句）也要记账：
      // capture:<msgId> 是稳定消息号，预览换掉后后台采集还会再读到它，不能重投。
      // 只记正文重复；被回声判断拦下的不记，等回声窗口过去还能重新考虑。
      if (suppressed.length) {
        for (const m of suppressed) {
          seen.set(m.key, { at: Date.now(), chat: canonicalName(m.chat), text: String(m.preview ?? '') })
        }
        saveSeen()
      }
      const hits = dropRecentContent(fresh1, recentContent)
      if (hits.length < fresh1.length) {
        // 内容重复的命中记账，不再每轮重试：key 记进 seen，之后同 key 也不会再来。
        for (const m of fresh1) if (!hits.includes(m)) seen.set(m.key, { at: Date.now(), chat: canonicalName(m.chat), text: String(m.preview ?? '') })
        saveSeen()
        logLine('[dsh-wx] 耳朵：内容近期已投过，跳过 ' + (fresh1.length - hits.length) + ' 条')
      }
      // 压着没投出去的 @：本轮采集让路（投递循环后按实际成功数重算）。
      heldHits = hits.length
      if (hits.length === 0) {
        // 压住的时候留一行日志，否则「她没被叫醒」和「她听到了不想说」在日志里长得一样
        const held = [...now.values()].filter((m) => !seen.has(m.key))
        if (held.length > 0 && Date.now() - lastHeldLog > 30_000) {
          lastHeldLog = Date.now()
          logLine('[dsh-wx] 耳朵：压着 ' + held.length + ' 条（回声保护 ' + Math.round(ECHO_MS / 1000) + 's）→ ' + held.map((m) => m.chat).join('、'))
        }
        return
      }
      // 主机正在对话框里等她答：不插话，等这一轮答完再投（没记账，下一轮自然会再来）
      if (hostBusy()) {
        if (Date.now() - lastHeldLog > 30_000) {
          lastHeldLog = Date.now()
          logLine('[dsh-wx] 耳朵：主机这一轮还没答完，微信通知先压着（' + hits.map((h) => h.chat).join('、') + '）')
        }
        return
      }
      // 投不进微信自己的会话就不投、不记账，下一轮再试：宁可晚，也不串通道
      await ensureWxSession()
      if (Date.now() - lastAt < 15_000) return
      lastAt = Date.now()
      // 先入池、再叫醒：投递失败下一轮还会重投，任务按预览去重，不会越积越多。
      // 每个群各自投到自己那个会话；主会话管第一个群，其余按 chatId 分配 worker。
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
          contextStore.ingest({ chat, chatId, preview: h.preview, why: h.why, isDM, ignoreChats: p.ignoreChats })
        } catch (err) {
          logLine('[dsh-wx] 入池失败（不影响这次投递）：' + String(err?.message ?? err).slice(0, 120))
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
        const note = formatEarNote([{ ...h, chat }], p.allowChats, null, { requester: reqs, recent: recents })
        try {
          const sid = await deliverToChat(chat, chatId, note, { contact: isContactWhy(h.why) })
          sentChats.push(chat)
          // 投成功才记账：失败下一轮还投，不会丢这条 @
          seen.set(h.key, { at: Date.now(), chat, text: String(h.preview ?? '') })
          noteContent(recentContent, h)
          // 每个会话投完都给采集留一段静默期（取较大值，不会无限延长）。
          quietUntil = Math.max(quietUntil, Date.now() + p.capture.quietMs)
          logLine('[dsh-wx] 耳朵：已投递（' + sid + '）→ ' + chat)
          logInbound({ type: 'delivered', session: sid, chatId, chat, why: h.why, preview: h.preview, key: h.key })
        } catch (err) {
          logLine('[dsh-wx] 耳朵：投递失败（' + chat + '）：' + String(err?.message ?? err).slice(0, 160))
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
      logLine('[dsh-wx] 耳朵出错: ' + msg)
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
        logLine('[dsh-wx] 采集：本轮出错（' + String(err?.message ?? err).slice(0, 120) + '）')
      }
      busy = false
    }
  }

  const timer = setInterval(ear, Math.max(3, Number(config.pollSeconds) || 5) * 1000)
  timer.unref?.()
  const remindTimer = setInterval(() => {
    reminderPump().catch((err) => logLine('[dsh-wx] 逾期泵出错：' + String(err?.message ?? err).slice(0, 120)))
  }, 60_000)
  remindTimer.unref?.()
  const maintainTimer = setInterval(maintain, 15 * 60_000)
  maintainTimer.unref?.()
  const maintainEarly = setTimeout(maintain, 120_000)
  maintainEarly.unref?.()

  logLine(`[dsh-wx] mounted (display=${display}, tools=${disposers.length}, policy=${POLICY}, stickers=${stickerDir})`)

  // ---------------------------------------------------------------- 工具
  const wxSendTool = createWxSendTool({
    getPolicy: policy,
    directory,
    board: contextStore.board,
    deny,
    sendToChat: (req) => withSendLock(() => sendToChat(req)),
    recordReply: ({ taskId, msgId }) => {
      const rep = contextStore.recordReply({ taskId, msgId })
      if (!rep.ok) logLine('[dsh-wx] 回复已发出，任务没记上：' + String(rep.why ?? 'unknown'))
      return rep
    },
  })

  reg({
    name: 'wx_see',
    description: '看一眼微信窗口。这里看不见图，想知道屏幕上的文字就换个办法。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      mkdirSync(SHOT_DIR, { recursive: true })
      const path = join(SHOT_DIR, `shot-${Date.now()}.png`)
      const out = await run(['shot', path])
      const [, w, h] = out.split(/\s+/)
      prune()
      return {
        ok: true,
        path,
        width: Number(w) || w || '',
        height: Number(h) || h || '',
        text: `已截图：${path}（窗口 ${w}x${h}）`,
      }
    },
  })

  reg({
    name: 'wx_peek',
    description: '看微信现在停在哪、侧栏有哪些会话、当前对话最后几句。屏幕可能慢半拍。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    project: (out) => ({ text: projectWxPeek(out) }),
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const s = await look()
      if (s.source === 'ocr') {
        return {
          ok: true,
          source: 'ocr',
          text: JSON.stringify({ source: 'ocr', current: '', currentVerified: false, chats: s.parsed.chats.map(({ name, unread, mention, preview, box, nameConfidence }) => ({ name, unread, mention, preview, box, nameConfidence })), messages: s.parsed.messages.map(({ text, confidence }) => ({ text, confidence, verified: false })), note: '屏幕上的字不足以确认当前会话，也不能据此发送。' }, null, 2),
        }
      }
      // 尾巴（[提示]）比正文更重要：先给它留位置，再截正文。
      return { ok: true, source: s.source, text: clipPeekBody(s.raw, fresh.notice()) }
    },
  })

  reg({
    name: 'wx_click',
    description: '点刚看见的会话名或按钮名。找不到那个名字，就别猜位置。',
    parameters: {
      type: 'object',
      properties: {
        label: { type: 'string', description: '会话名或按钮名' },
        x: { type: 'number', description: '横向位置；不知道点哪里就别填' },
        y: { type: 'number', description: '纵向位置；不知道点哪里就别填' },
        button: { type: 'number', description: '鼠标键；一般不用填' },
      },
      required: [],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const label = String(a.label ?? '').trim()
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      await run(['clean'], 30_000).catch(() => '') // 挡住点击的 Qt 浮层先清掉
      fresh.reset() // 关浮层会改像素但树不变，旧基线不能再拿来判"落后"

      let x, y, target = null
      const before = await look()
      if (!before.parsed.ok && before.source !== 'ocr') {
        throw new WxToolError('WX_WINDOW_UNAVAILABLE', '[没看清。屏幕可能慢半拍]')
      }
      if (label) {
        target = resolveLabel(before.parsed, label)
        if (!target) {
          if (/^(send|发送)$/i.test(label)) {
            // 树里没有"发送"按钮（截图上有）；发送等价于回车，走同一道闸，扣一次主动额度。
            // 先过频率闸，再扣额度：频率拒绝时不能白扣一条。
            const g = await gateSend()
            await speechGate(g.chat)
            await gateSend({ consume: true, expected: g.chat })
            await run(['key', 'Return'])
            return { ok: true, text: '已经按下回车发送了。' + fresh.notice() }
          }
          throw new WxToolError('WX_CLICK_TARGET_NOT_FOUND', '[没做成，过会儿再试]')
        }
        x = target.box.cx; y = target.box.cy
      } else {
        x = Math.round(Number(a.x)); y = Math.round(Number(a.y))
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new WxToolError('WX_INVALID_COORDINATES', '[没做成，过会儿再试]')
        }
        target = hitTest(before.parsed, x, y)
      }
      await run(['click', String(x), String(y), String(Number(a.button) === 3 ? 3 : 1)])
      await sleep(700)
      const after = await look({ confirm: false })

      const parts = [`已点击 (${x},${y})`]
      parts.push(target ? `落点：${target.kind === 'chat' ? '会话' : target.kind === 'control' ? '控件' : '消息'}“${target.name}”` : '落点：无可点击元素')
      const cur = after.parsed.current
      if (target?.kind === 'chat' && !fresh.stale) {
        parts.push(after.source === 'ocr' ? `眼前像是「${target.name}」，但还没认准` : sameName(cur, target.name) ? `当前会话：“${cur}”` : `当前会话：“${cur || '读不到'}”，与目标“${target.name}”不一致`)
      } else {
        parts.push(`当前会话：“${cur || '读不到'}”`)
      }
      return {
        ok: true,
        x,
        y,
        target: target ? { kind: target.kind, name: target.name } : null,
        current: cur,
        text: parts.join('；') + '。' + fresh.notice(),
      }
    },
  })

  reg({
    name: 'wx_type',
    description: '往当前输入框里打字。回车会直接发出去，先看清停在哪个会话。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要打进去的话' },
        enter: { type: 'boolean', description: '要不要直接发出去' },
      },
      required: ['text'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const a = args || {}
      const text = String(a.text ?? '')
      if (!text) throw new WxToolError('WX_INVALID_TEXT', '[这句话发不出去]')
      if (/[\r\n]/.test(text)) throw new WxToolError('WX_INVALID_TEXT', '[这句话发不出去]')
      if ([...text].length > 500) throw new WxToolError('WX_INVALID_TEXT', '[这句话发不出去]')
      const enter = a.enter === true

      // 输入也要过闸：在名单外的会话里打字，会在对方输入框里留下草稿
      await gateSend()
      await run(['clean'], 30_000).catch(() => '')
      fresh.reset() // 关浮层会改像素但树不变，旧基线不能再拿来判"落后"
      await run(['type', text], 60_000)
      if (!enter) return { ok: true, sent: 'draft', text: '[字打好了，还没发]' }

      // 回车之前再核对一次：打字期间界面可能切走
      await sleep(300)
      // enter=true 是真正发送。先过频率闸，再扣主动额度：
      // 频率拒绝 / 等完切走时，这条话没发出去，不能白扣。
      const second = await gateSend()
      await speechGate(second.chat)
      await gateSend({ consume: true, expected: second.chat })
      await run(['key', 'Return'])
      await sleep(900)
      const after = await look({ confirm: false })

      // 回执：只信树里看得到的。看不到就如实说看不到。
      const typed = text.replace(/\s+/g, ' ').replace(/"/g, '＂')
      const head = typed.slice(0, 14)
      const inMsgs = after.parsed.messages.slice(-4).some((m) => m.text.includes(head))
      const chatRow = after.parsed.chats.find((c) => sameName(c.name, second.chat))
      const inPreview = !!chatRow && chatRow.preview.includes(head.slice(0, 10))
      const sent = classifyWxSend({ inMsgs, inPreview })
      const booking = applyWxSendBookkeeping({
        sent,
        chat: second.chat,
        text,
        noteOutbox,
        capture: () => contextStore.capture({
            chat: second.chat,
            source: 'sent',
            ignoreChats: policy().ignoreChats,
            messages: [{
              sender: null, senderConfidence: 'unknown', direction: 'out', kind: 'text',
              text, at: new Date().toISOString(), atConfidence: 'medium', source: 'sent',
            }],
        }),
      })
      return {
        ok: true,
        chat: second.chat,
        sent,
        booking,
        text: projectWxSend({ chat: second.chat, sent }),
      }
    },
  })

  reg({
    name: 'wx_send',
    description: '把一句话发到某个微信会话。一个字里不要换行。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '会话名' },
        text: { type: 'string', description: '要发的话，不要换行' },
        permit: { type: 'string', description: '到点提醒带来的那串记号；平时不填' },
        task_id: { type: 'string', description: '接着哪件事，就带上那件事的记号' },
      },
      required: ['chat', 'text'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: wxSendTool.execute,
  })

  reg({
    name: 'wx_context',
    description: '翻这个会话更早的话。给不出全文就说没有。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '接着哪件事，就带上那件事的记号' },
        query: { type: 'string', description: '想找的词或短句' },
        before: { type: 'string', description: '从哪个时间往前翻' },
        limit: { type: 'number', description: '最多看几条，最多五条' },
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
      if (!taskId) return wxFailure('WX_TASK_ID_REQUIRED', '[没做成，过会儿再试]', 'wx_context: task_id missing')
      const r = await contextStore.contextForTask({
        taskId,
        query: String(a.query ?? ''),
        before: String(a.before ?? ''),
        limit: Number(a.limit) || undefined,
        ignoreChats: policy().ignoreChats,
      })
      if (!r.ok) return wxFailure('WX_CONTEXT_FAILED', '[没翻到]', r.why)
      return { ...r, ok: true, text: r.text }
    },
  })

  reg({
    name: 'wx_history',
    description: '翻微信里以前记下的话。没翻到就说没翻到，别编。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '只看哪个会话；不填就都看看' },
        query: { type: 'string', description: '想找的词或短句' },
        hours: { type: 'number', description: '只看最近多少小时' },
        limit: { type: 'number', description: '最多看几条，最多二十条' },
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
      if (!r.ok) return wxFailure('WX_HISTORY_FAILED', '[没翻到]', r.why)
      return { ...r, ok: true, text: r.text }
    },
  })

  reg({
    name: 'wx_task_snooze',
    description: '这会儿回不了，但还得回，就先搁一会儿。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '哪件事的记号' },
        minutes: { type: 'number', description: '先搁多少分钟' },
      },
      required: ['task_id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const taskId = String(a.task_id ?? '').trim()
      if (!taskId) return wxFailure('WX_TASK_ID_REQUIRED', '[没做成，过会儿再试]', 'wx_task_snooze: task_id missing')
      const minutes = Math.max(1, Math.min(24 * 60, Number(a.minutes) || 15))
      const r = contextStore.snooze({ taskId, minutes })
      if (!r?.ok) return wxFailure('WX_TASK_SNOOZE_FAILED', '[没做成，过会儿再试]', r?.why || 'task snooze failed')
      return { ...r, ok: true, text: projectWxTaskSnooze() }
    },
  })

  reg({
    name: 'wx_task_done',
    description: '这件事不用再跟了，就放下。发了一句不等于放下。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '哪件事的记号' },
        note: { type: 'string', description: '一句话说清怎么处理了' },
      },
      required: ['task_id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const a = args || {}
      const taskId = String(a.task_id ?? '').trim()
      if (!taskId) return wxFailure('WX_TASK_ID_REQUIRED', '[没做成，过会儿再试]', 'wx_task_done: task_id missing')
      const r = contextStore.done({ taskId, note: String(a.note ?? '') })
      if (!r?.ok) return wxFailure('WX_TASK_DONE_FAILED', '[没做成，过会儿再试]', r?.why || 'task done failed')
      return { ...r, ok: true, text: projectWxTaskDone() }
    },
  })

  reg({
    name: 'wx_ocr',
    description: '读屏幕上的字。认不全就说认不全，别拿它证明停在哪个会话。',
    parameters: { type: 'object', properties: {} },
    output: ocrOut,
    project: (out) => ({ text: projectWxOcr(out) }),
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const data = await ocrRead()
      // 完整返回：台账会把大字段落 artifact（审计副本）。模型看到的由
      // projectWxOcr 投影；fishCore 缺席时由 ocrOut 限长，不把整段 JSON 塞进上下文。
      return { ok: true, data, text: JSON.stringify(data, null, 2) }
    },
  })

  reg({
    name: 'wx_key',
    description: '按一个键或组合键。回车会直接发出去，先看清停在哪个会话。',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: '按哪个键或哪组键' } },
      required: ['keys'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      const keys = String((args || {}).keys ?? '').trim()
      if (!keys) return wxFailure('WX_KEY_REQUIRED', '[没做成，过会儿再试]', 'wx_key: keys missing')
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      let where = ''
      if (/(^|\+)(return|kp_enter|enter)$/i.test(keys)) {
        // 回车视同发送：先过频率闸，再扣一次主动额度，频率拒绝时不白扣。
        const g = await gateSend()
        await speechGate(g.chat)
        await gateSend({ consume: true, expected: g.chat })
        where = `当前会话：“${g.chat}”。`
      }
      await run(['key', keys])
      return {
        ok: true,
        keys,
        chat: where ? where.match(/当前会话：“([^”]*)”/)?.[1] ?? '' : '',
        text: `已按 ${keys}。${where}` + fresh.notice(),
      }
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
    description: '看看收藏里现在有哪些表情。扫的时候会打开面板，再把它关上。',
    parameters: { type: 'object', properties: {} },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (_args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      let r
      try {
        r = await scanStickers({ run, dir: stickerDir, log: (m) => logLine('[dsh-wx] 表情扫描：' + m) })
      } catch (err) {
        const extra = []
        if (err?.panelShot) extra.push(`截图：${err.panelShot}`)
        if (err?.closed === false) extra.push('面板可能还开着，请人工看一眼')
        const failure = stickerOperationalFailure(
          err,
          'WX_STICKER_SCAN_FAILED',
          '[表情没扫成]',
        )
        if (failure) {
          failure.detail = [failure.detail, ...extra].filter(Boolean).join('；')
          return failure
        }
        throw err
      }
      const warn = stickerWarnings(r)
      const text = [
        `收藏表情扫描完成：共 ${r.total} 张（新增 ${r.added}，认回 ${r.matched}，本轮没看到 ${r.stale}）。`,
        r.closed ? '面板已关闭。' : '',
        ...warn.map((x) => `注意：${x}。`),
      ].filter(Boolean).join('\n')
      return { ...r, ok: true, text }
    },
  })

  reg({
    name: 'wx_sticker_list',
    description: '看看收藏里有哪些表情。什么也没看到时，先扫一遍再说。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '最多看几张' } },
    },
    output: textOut,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const limit = Number((args || {}).limit ?? 20)
      const { index, recovered } = loadIndex(stickerDir)
      const note = recovered ? '索引文件有损坏，无法解析的条目已跳过；建议重新运行 wx_sticker_scan。\n' : ''
      return {
        ok: true,
        index,
        recovered,
        text: note + formatList(index, listStickers(index, { limit })),
      }
    },
  })

  reg({
    name: 'wx_sticker_find',
    description: '按词找收藏里的表情。找到的只是候选，没把握就别挑。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '想找的词' },
        limit: { type: 'number', description: '最多看几个候选' },
      },
      required: ['query'],
    },
    output: textOut,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const query = String((args || {}).query ?? '').trim()
      if (!query) return wxFailure('WX_STICKER_QUERY_REQUIRED', '[没做成，过会儿再试]', 'wx_sticker_find: query missing')
      const { index, recovered } = loadIndex(stickerDir)
      const rows = findStickers(index, query, { limit: (args || {}).limit ?? 5 })
      const note = recovered ? '索引文件有损坏，无法解析的条目已跳过；建议重新运行 wx_sticker_scan。\n' : ''
      return {
        ok: true,
        query,
        rows,
        recovered,
        text: note + formatFind(index, query, rows),
      }
    },
  })

  reg({
    name: 'wx_sticker_tag',
    description: '给收藏里的那张表情补上字、描述或标签。看不清就不要猜。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '哪张表情的记号' },
        text: { type: 'string', description: '图上真有的字；看不清就别填' },
        desc: { type: 'string', description: '图里确定能看见什么' },
        tags: { type: 'array', items: { type: 'string' }, description: '给这张表情的标签' },
        textConf: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
        descConf: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
      },
      required: ['id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const a = args || {}
      const id = String(a.id ?? '').trim()
      if (!id) return wxFailure('WX_STICKER_ID_REQUIRED', '[还没说是哪张表情]', 'wx_sticker_tag: id missing')
      const patch = {}
      if (a.text != null) patch.text = String(a.text)
      if (a.desc != null) patch.desc = String(a.desc)
      if (a.tags != null) patch.tags = a.tags
      if (a.textConf != null) patch.textConf = String(a.textConf)
      if (a.descConf != null) patch.descConf = String(a.descConf)
      if (a.text == null && a.desc == null && a.tags == null) {
        return wxFailure('WX_STICKER_PATCH_REQUIRED', '[没做成，过会儿再试]', 'wx_sticker_tag: empty patch')
      }
      patch.source = 'manual'
      if (patch.text != null && patch.textConf == null) patch.textConf = 'high'
      if (patch.desc != null && patch.descConf == null) patch.descConf = 'high'
      let index, next, entry
      try {
        const loaded = loadIndex(stickerDir)
        index = loaded.index
        const annotated = annotate(index, id, patch)
        next = annotated.index
        entry = annotated.entry
        saveIndex(stickerDir, next)
      } catch (err) {
        const failure = stickerOperationalFailure(err, 'WX_STICKER_TAG_FAILED', '[没改成]')
        if (failure) return failure
        throw err
      }
      const bits = []
      if (entry.tags.length) bits.push(`标签：${entry.tags.join('、')}`)
      if (entry.text) bits.push(`图上文字：${entry.text}`)
      if (entry.desc) bits.push(`描述：${entry.desc}`)
      return {
        ok: true,
        id: entry.id,
        entry,
        index,
        text: `已更新 ${entry.id}${bits.length ? '｜' + bits.join('｜') : ''}。`,
      }
    },
  })

  reg({
    name: 'wx_sticker_send',
    description: '发一张收藏里的表情。你看不见图，点下去就出去了，没把握就别用。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '发到哪个会话' },
        id: { type: 'string', description: '哪张表情的记号' },
        task_id: { type: 'string', description: '接着哪件事，就带上那件事的记号' },
      },
      required: ['chat', 'id'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const r = await withSendLock(() => sendStickerToChat({
        chat: args?.chat,
        id: args?.id,
        taskId: String(args?.task_id ?? ''),
      }))
      if (!r?.ok) return r
      return wxWithText(r, projectWxStickerSend)
    },
  })

  reg({
    name: 'wx_sticker_collect',
    description: '把聊天里的一张表情收进收藏。菜单里没有那一项，就别点。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '从哪个会话收；不填就看眼前这个' },
        which: { type: 'number', description: '从最新往前数第几张' },
      },
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const r = await withSendLock(() => collectStickerFromChat({
        chat: args?.chat,
        which: args?.which,
      }))
      if (!r?.ok) return r
      return wxWithText(r, projectWxStickerCollect)
    },
  })

  reg({
    name: 'wx_sticker_search',
    description: '按词直接发一张表情，你看不见图，点下去就出去了。没把握就别用。',
    parameters: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: '发到哪个会话' },
        keyword: { type: 'string', description: '用来找图的词，单行' },
        pick: { type: 'number', description: '从第几个开始挑' },
        task_id: { type: 'string', description: '接着哪件事，就带上那件事的记号' },
      },
      required: ['chat', 'keyword'],
    },
    output: textOut,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      deny(exec)
      if (!policy().enabled) throw new WxToolError('WX_DISABLED', '[微信现在没开]')
      const r = await withSendLock(() => searchStickerInChat({
        chat: args?.chat,
        keyword: args?.keyword,
        pick: args?.pick,
        taskId: String(args?.task_id ?? ''),
      }))
      if (!r?.ok) return r
      return wxWithText(r, projectWxStickerSearch)
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
