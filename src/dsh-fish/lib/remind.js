/**
 * remind.js —— 她自己的定时提醒：her_remind / her_reminders / her_remind_cancel
 *
 * 为什么包一层，而不是把宿主的 schedule_create 直接放给她：
 *   1. 宿主那组工具能定「每天 / 每周 / cron」，她暂时用不到；这里只开「过多少分钟」，
 *      范围 1 分钟到 7 天，避免她把「提醒我」变成无限循环。
 *   2. 定时任务到点要往微信发话，必须带上 dsh-wx 的一次性许可。许可、会话绑定、
 *      原文绑定都在这一层拼好；她自己拼不出一个能绕过微信发送闸的调用。
 *   3. 提醒的目标只能是「刚把她叫醒的那个会话」：dsh-wx 记着最近投递过哪些会话，
 *      这里把会话名原样交给它校验；对不上就不定。
 *
 * 文本仍然过 guard.js：换行压成一行、冒充系统指令的行不递（整条拒绝），
 * 像凭据的东西不往外发。微信是私聊，隐私红线（手机号、路径）不套用——
 * 提醒里写「给谁打电话」是正常用途。
 */

import { randomUUID } from 'node:crypto'

import { toJsonSchema } from './toolschema.js'
import { rootDir, readEvents, appendEvent } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'
import { sanitizeForeign, looksLikeSecret } from './guard.js'
import { defineTool } from './tool.js'
import { registerTool } from './tool-result.js'

/** 最短 1 分钟。 */
export const REMIND_MIN_MINUTES = 1
/** 最长 7 天。再长就不像「提醒我」了，而且许可也留不了那么久。 */
export const REMIND_MAX_MINUTES = 7 * 24 * 60
/** 一条提醒最多多少字，和 wx_type / wx_send 的上限一致。 */
export const REMIND_TEXT_MAX = 500
/** 标题前缀。列表和取消只认自己定的提醒。 */
export const REMIND_TITLE_PREFIX = '提醒｜'
/** 事件流里的记账标记（仍是 meta，不新增事件类型）。 */
export const REMIND_MARK = 'remind:'
/** 她每轮都能看到的工具说明，固定在 system prompt 里。 */
export const REMIND_PROMPT = [
  '## 过一会儿提醒',
  '',
  '有人在微信里让你过一会儿提醒，你做得到。先定上，别说自己没有闹钟。',
  '只能定「过多少分钟」，最短一会儿，最长七天。会话只能是刚把你叫醒的那个。',
  '到点时把你当时写的那句发出去，一个字不改。发不出去就说没发出去。',
  '没人让你提醒的事，不要自己定。',
].join('\n')

const MINUTE_MS = 60_000

/** 会话名归一：模型常把 `会话名：xxx` 整行抄进来，去掉前缀和成对引号。 */
export function normalizeChatName(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^会话名\s*[:：]\s*/u, '')
    .replace(/^["“](.*)["”]$/u, '$1')
    .trim()
}

/** 把多行压成一行：微信一条消息里不能带换行。 */
export function normalizeReminderText(raw) {
  return String(raw ?? '')
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 解析 after_minutes。返回的是整数分钟。 */
export function parseAfterMinutes(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return { ok: false, why: 'after_minutes 要填一个数字。' }
  const minutes = Math.round(n)
  if (minutes < REMIND_MIN_MINUTES) return { ok: false, why: `至少 ${REMIND_MIN_MINUTES} 分钟。` }
  if (minutes > REMIND_MAX_MINUTES) return { ok: false, why: `最多 ${REMIND_MAX_MINUTES} 分钟（7 天）。` }
  return { ok: true, minutes }
}

/**
 * 清洗要发出去的提醒正文。
 * 外来文本（这里是模型替用户拟的话）先按 guard.js 的行规则过一遍；
 * 只要有一行被判定成冒充系统指令，就整条拒绝——不把删剩下的半句话发出去。
 */
export function cleanReminderText(raw) {
  const source = String(raw ?? '').trim()
  if (!source) return { ok: false, why: '要提醒的话是空的。' }
  const { text: kept, dropped } = sanitizeForeign(source)
  if (dropped > 0) return { ok: false, why: '这段话里有读不懂的行，没定。' }
  const text = normalizeReminderText(kept)
  if (!text) return { ok: false, why: '要提醒的话是空的。' }
  if ([...text].length > REMIND_TEXT_MAX) return { ok: false, why: `太长了，压到 ${REMIND_TEXT_MAX} 字以内。` }
  if (looksLikeSecret(text).hit) return { ok: false, why: '这句话里有像凭据的东西，不能发出去。' }
  return { ok: true, text }
}

/** 标题：列表和取消靠这个前缀认「是她自己定的提醒」。 */
export function reminderTitle(chat, title) {
  const body = normalizeReminderText(title) || String(chat ?? '').trim()
  return (REMIND_TITLE_PREFIX + body).slice(0, 80)
}

/** 到点交给她的固定三行：一句场面话、逐字原文、末行一次性记号。 */
export function buildReminderPrompt({ chat, text, permit }) {
  return [
    `[时间到了。把下面这句发到「${String(chat ?? '')}」，一个字都不要改]`,
    `「${String(text ?? '')}」`,
    `〔${String(permit ?? '')}〕`,
  ].join('\n')
}

/** 从 meta 事件里认出定时提醒的记账（给观测台 / 排查用）。 */
export function reminderMarks(events) {
  const rows = []
  for (const e of events ?? []) {
    if (e?.type !== 'meta') continue
    const text = String(e.text ?? '')
    if (!text.startsWith(REMIND_MARK)) continue
    const rest = text.slice(REMIND_MARK.length)
    const sp = rest.indexOf(' ')
    if (sp < 0) continue
    const id = rest.slice(0, sp)
    try {
      const data = JSON.parse(rest.slice(sp + 1))
      rows.push({ id, chat: String(data?.chat ?? ''), text: String(data?.text ?? ''), dueAt: String(data?.dueAt ?? '') })
    } catch { /* 坏行跳过，不影响别的 */ }
  }
  return rows
}

const service = (ctx, name) => {
  try { return ctx?.get?.(name) } catch { return undefined }
}

const nowText = (iso) => {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return String(iso ?? '')
  return new Date(t).toLocaleString('zh-CN', {
    hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * 定一条提醒。永不抛，失败只回 note。
 *
 * @param {object} opts
 * @param {object} [opts.ctx]
 * @param {string} [opts.root]
 * @param {object} [opts.wx]       测试注入；默认 ctx.get('wx')
 * @param {object} [opts.schedule] 测试注入；默认 ctx.get('schedule')
 * @param {string} opts.sessionId
 * @param {string} opts.chat
 * @param {string} opts.text
 * @param {number} opts.afterMinutes
 * @param {string} [opts.title]
 * @param {AbortSignal} [opts.signal]
 * @param {(msg:string, err?:unknown)=>void} [opts.log]
 */
export async function createReminder({
  ctx, root = rootDir(), wx, schedule, sessionId, chat, text, afterMinutes, title, signal, log,
} = {}) {
  const session = String(sessionId ?? '').trim()
  if (!session) return { ok: false, note: '这会儿不知道提醒该跟着哪条会话。' }

  const wxSvc = wx ?? service(ctx, 'wx')
  if (!wxSvc || typeof wxSvc.grantReminder !== 'function') {
    return { ok: false, note: '这会儿没法往微信发提醒。' }
  }
  const sch = schedule ?? service(ctx, 'schedule')
  if (!sch || typeof sch.create !== 'function') {
    return { ok: false, note: '这会儿定不了提醒。' }
  }

  const target = normalizeChatName(chat)
  if (!target) return { ok: false, note: '还没说是发到哪个会话。' }

  const mins = parseAfterMinutes(afterMinutes)
  if (!mins.ok) return { ok: false, note: mins.why }

  const clean = cleanReminderText(text)
  if (!clean.ok) return { ok: false, note: clean.why }

  // 名单 / 是否刚被叫醒 / 是不是微信会话，全部由 dsh-wx 判；这里只拿它的结论。
  const can = typeof wxSvc.canSend === 'function' ? wxSvc.canSend(target) : { ok: false, why: 'canSend unavailable' }
  if (!can.ok) {
    log?.('remind canSend failed', can.why)
    return { ok: false, note: '这会儿不能发到那个会话。' }
  }
  const targetChat = String(can.chat ?? target)

  const permit = randomUUID()
  const dueAt = Date.now() + mins.minutes * MINUTE_MS
  const granted = wxSvc.grantReminder({
    id: permit,
    chat: targetChat,
    text: clean.text,
    sessionId: session,
    dueAt,
  })
  if (!granted.ok) {
    log?.('remind grant failed', granted.why)
    return { ok: false, note: '这会儿定不了这条提醒。' }
  }

  const recordTitle = reminderTitle(targetChat, title)
  const prompt = buildReminderPrompt({ chat: targetChat, text: clean.text, permit })
  let record
  try {
    record = await sch.create(session, {
      title: recordTitle,
      prompt,
      after_seconds: mins.minutes * 60,
    }, signal)
  } catch (err) {
    // 定时任务没定上，许可作废，免得留一张没有对应提醒的通行证。
    try { wxSvc.revokeReminder?.(permit) } catch { /* ignore */ }
    log?.('remind schedule failed', err?.message ?? err)
    return { ok: false, note: '这会儿没定上。' }
  }

  const scheduleId = String(record?.id ?? '')
  const scheduledAt = String(record?.scheduledAt ?? new Date(dueAt).toISOString())

  // 记账（meta，不新增事件类型）。写不进去不影响已经定好的提醒。
  try {
    const { events } = await readEvents(root)
    const { config } = await loadConfig(root)
    const model = deriveSelf(events, { growthDays: config.growthDays })
    await appendEvent(
      {
        type: 'meta',
        text: `${REMIND_MARK}${scheduleId} ${JSON.stringify({ chat: targetChat, text: clean.text, dueAt: scheduledAt })}`,
      },
      { day: model.day, stage: model.stage, source: 'system' },
      root,
    )
  } catch (err) {
    log?.('remind mark failed', err?.message ?? err)
  }

  return {
    ok: true,
    id: scheduleId,
    chat: targetChat,
    dueAt: scheduledAt,
    note: `到点会发到「${targetChat}」。`,
  }
}

/** 列出她定的、还没到点的提醒。 */
export async function listReminders({ ctx, schedule, sessionId, signal, log } = {}) {
  const session = String(sessionId ?? '').trim()
  if (!session) return { ok: false, note: '这会儿不知道要翻哪条会话。', rows: [] }
  const sch = schedule ?? service(ctx, 'schedule')
  if (!sch || typeof sch.list !== 'function') return { ok: false, note: '这会儿看不到有哪些提醒。', rows: [] }
  try {
    const all = await sch.list({ sessionId: session }, signal)
    const rows = (all ?? [])
      .filter((r) => String(r?.title ?? '').startsWith(REMIND_TITLE_PREFIX))
      .map((r) => ({
        id: String(r.id ?? ''),
        chat: String(r.title ?? '').slice(REMIND_TITLE_PREFIX.length),
        dueAt: String(r.scheduledAt ?? ''),
      }))
    return { ok: true, note: '', rows }
  } catch (err) {
    log?.('remind list failed', err?.message ?? err)
    return { ok: false, note: '这会儿看不到有哪些提醒。', rows: [] }
  }
}

/** 取消一条她定的提醒。只认列表里带前缀的，不碰别人的定时任务。 */
export async function cancelReminder({ ctx, schedule, sessionId, id, signal, log } = {}) {
  const session = String(sessionId ?? '').trim()
  const want = String(id ?? '').trim()
  if (!session) return { ok: false, note: '这会儿不知道是哪条会话。' }
  if (!want) return { ok: false, note: '还没说要放下哪一条。' }
  const sch = schedule ?? service(ctx, 'schedule')
  if (!sch || typeof sch.list !== 'function' || typeof sch.delete !== 'function') {
    return { ok: false, note: '这会儿取消不了。' }
  }
  try {
    const all = await sch.list({ sessionId: session }, signal)
    const hit = (all ?? []).find((r) => String(r?.id ?? '') === want && String(r?.title ?? '').startsWith(REMIND_TITLE_PREFIX))
    if (!hit) return { ok: false, note: '没找到这条提醒。' }
    const r = await sch.delete({ sessionId: session, id: want }, signal)
    if (!r?.deleted) return { ok: false, note: '这会儿取消不了。' }
    return { ok: true, note: '取消了。' }
  } catch (err) {
    log?.('remind cancel failed', err?.message ?? err)
    return { ok: false, note: '这会儿取消不了。' }
  }
}

/**
 * 注册三个工具。返回一个卸载函数。
 */
export function registerRemind(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  const regs = []

  regs.push(registerTool(
    ctx,
    defineTool({
      name: 'her_remind',
      description: '有人让你过一会儿提醒时，把到点要说的那句定上。只能定刚叫醒你的那个会话。',
      parameters: toJsonSchema({
        chat: { type: 'string', required: true, description: '刚把你叫醒的那个微信会话。' },
        text: { type: 'string', required: true, description: `到点要发出去的那一句。${REMIND_TEXT_MAX} 字以内，不要换行。` },
        after_minutes: { type: 'number', required: true, description: '过多少分钟提醒；最短一会儿，最长七天。' },
        title: { type: 'string', required: false, description: '可选，给这条提醒起个短名字。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            chat: { type: 'string' },
            dueAt: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
      },
      // 模型投影：定上了只说到点会发到哪，不重复她填的原话；没定上照实给原因。
      project: (out) => ({
        text: out?.ok
          ? `[已定：${nowText(out.dueAt)} 发到「${out.chat}」]`
          : `[没定：${out?.note ?? ''}]`,
      }),
      async execute(args, exec) {
        const r = await createReminder({
          ctx,
          root,
          wx: deps.wx,
          schedule: deps.schedule,
          sessionId: exec?.agent?.session?.id,
          chat: args?.chat,
          text: args?.text,
          afterMinutes: args?.after_minutes,
          title: args?.title,
          signal: exec?.signal,
          log: deps.log,
        })
        return r
      },
    }),
    { core: deps.core },
  ))

  regs.push(registerTool(
    ctx,
    defineTool({
      name: 'her_reminders',
      description: '看看自己定了、还没到点的提醒。',
      parameters: toJsonSchema({}),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['ok', 'text'],
        },
      },
      // 模型投影：列表原文里已经带了 id（取消要用），正文不再重复编号；失败不能伪装成正常列表。
      project: (out) => ({
        text: out?.ok ? `[提醒] ${out?.text ?? ''}` : `[没看到：${out?.text ?? ''}]`,
      }),
      async execute(_args, exec) {
        const r = await listReminders({
          ctx,
          schedule: deps.schedule,
          sessionId: exec?.agent?.session?.id,
          signal: exec?.signal,
          log: deps.log,
        })
        if (!r.ok) return { ok: false, text: r.note }
        if (!r.rows.length) return { ok: true, text: '现在没有定时提醒。' }
        return {
          ok: true,
          text: ['现在还有这些提醒：', ...r.rows.map((x) => `- ${nowText(x.dueAt)}｜${x.chat}（${x.id}）`)].join('\n'),
        }
      },
    }),
    { core: deps.core },
  ))

  regs.push(registerTool(
    ctx,
    defineTool({
      name: 'her_remind_cancel',
      description: '取消一条还没到点的提醒。',
      parameters: toJsonSchema({
        id: { type: 'string', required: true, description: '要取消的那条提醒末行里的记号。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
      },
      project: (out) => ({ text: out?.ok ? '[已取消]' : `[没取消：${out?.note ?? ''}]` }),
      async execute(args, exec) {
        return cancelReminder({
          ctx,
          schedule: deps.schedule,
          sessionId: exec?.agent?.session?.id,
          id: args?.id,
          signal: exec?.signal,
          log: deps.log,
        })
      },
    }),
    { core: deps.core },
  ))

  return () => {
    for (const d of regs) {
      try { d?.() } catch { /* ignore */ }
    }
  }
}
