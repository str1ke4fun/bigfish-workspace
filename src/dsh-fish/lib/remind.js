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
  '## 定时提醒（her_remind）',
  '',
  '这件事你做得到：有人在微信里让你过一会儿提醒，先调 her_remind 定上，别用「我这边没闹钟」这类话回绝。',
  '它只开「过多少分钟」这一种，1 分钟到 7 天；真定不了，它会给出原因，再照实说。',
  '- chat：刚把你叫醒的那个微信会话名，从 [微信] 通知里的「会话名」原样抄；不能填别的会话。',
  '- text：到点要发出去的那句话，按到点时的口气写，不要写「30 分钟后」。不能含换行，500 字以内。',
  '- 到点后宿主会把提醒交回给你，并附一个一次性的 permit。用 wx_send 把同样的 text 发到同样的 chat，permit 原样带上。',
  '- 只发这一次：不改字、不换会话、不带 permit 重发。发不出去就如实说没发出去，不要假装发了。',
  '- 没被叫醒的会话、没让你提醒的事，不要自己定；也不要拿它当定时刷屏。',
  '- her_reminders 看还没到点的提醒，her_remind_cancel 取消其中一条。',
  '- her_inbox 看还有哪些微信任务没回完；没有任务时会如实说没有。',
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

/**
 * 到点交给她的那段话。参数用 JSON.stringify，避免会话名或正文里的引号把指令拆坏。
 */
export function buildReminderPrompt({ chat, text, permit }) {
  return [
    '[提醒到点] 你之前定的提醒到点了。',
    `会话：${JSON.stringify(String(chat ?? ''))}`,
    `要发的话：${JSON.stringify(String(text ?? ''))}`,
    '',
    '现在用 wx_send 发出去，三个参数原样照抄：',
    `  chat: ${JSON.stringify(String(chat ?? ''))}`,
    `  text: ${JSON.stringify(String(text ?? ''))}`,
    `  permit: ${JSON.stringify(String(permit ?? ''))}`,
    '只发这一次：不要改字，不要换会话，不要不带 permit 重发。',
    '发完就停。发不出去就如实说没发出去，不要假装发了。',
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
  if (!session) return { ok: false, note: '不知道是哪条会话发起的提醒。' }

  const wxSvc = wx ?? service(ctx, 'wx')
  if (!wxSvc || typeof wxSvc.grantReminder !== 'function') {
    return { ok: false, note: '微信通道没接上，定不了提醒。' }
  }
  const sch = schedule ?? service(ctx, 'schedule')
  if (!sch || typeof sch.create !== 'function') {
    return { ok: false, note: '宿主没开定时任务，定不了提醒。' }
  }

  const target = normalizeChatName(chat)
  if (!target) return { ok: false, note: '没说是哪个微信会话，定不了。' }

  const mins = parseAfterMinutes(afterMinutes)
  if (!mins.ok) return { ok: false, note: mins.why }

  const clean = cleanReminderText(text)
  if (!clean.ok) return { ok: false, note: clean.why }

  // 名单 / 是否刚被叫醒 / 是不是微信会话，全部由 dsh-wx 判；这里只拿它的结论。
  const can = typeof wxSvc.canSend === 'function' ? wxSvc.canSend(target) : { ok: false, why: '微信通道没接上，定不了提醒。' }
  if (!can.ok) return { ok: false, note: can.why }
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
  if (!granted.ok) return { ok: false, note: granted.why }

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
    const why = String(err?.message ?? err).slice(0, 160)
    return { ok: false, note: `没定上定时任务：${why}` }
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
  if (!session) return { ok: false, note: '不知道是哪条会话。', rows: [] }
  const sch = schedule ?? service(ctx, 'schedule')
  if (!sch || typeof sch.list !== 'function') return { ok: false, note: '宿主没开定时任务。', rows: [] }
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
    return { ok: false, note: '没读到提醒列表。', rows: [] }
  }
}

/** 取消一条她定的提醒。只认列表里带前缀的，不碰别人的定时任务。 */
export async function cancelReminder({ ctx, schedule, sessionId, id, signal, log } = {}) {
  const session = String(sessionId ?? '').trim()
  const want = String(id ?? '').trim()
  if (!session) return { ok: false, note: '不知道是哪条会话。' }
  if (!want) return { ok: false, note: '要取消哪一条？id 从 her_reminders 里抄。' }
  const sch = schedule ?? service(ctx, 'schedule')
  if (!sch || typeof sch.list !== 'function' || typeof sch.delete !== 'function') {
    return { ok: false, note: '宿主没开定时任务。' }
  }
  try {
    const all = await sch.list({ sessionId: session }, signal)
    const hit = (all ?? []).find((r) => String(r?.id ?? '') === want && String(r?.title ?? '').startsWith(REMIND_TITLE_PREFIX))
    if (!hit) return { ok: false, note: '没找到这条提醒。' }
    const r = await sch.delete({ sessionId: session, id: want }, signal)
    if (!r?.deleted) return { ok: false, note: '没取消掉。' }
    return { ok: true, note: '取消了。' }
  } catch (err) {
    log?.('remind cancel failed', err?.message ?? err)
    return { ok: false, note: '没取消掉。' }
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
      description:
        '定一条微信定时提醒，这件事你做得到。只在有人刚在微信里让你过一会儿提醒时用；' +
        '先调它，不要预先回绝。chat 只能是刚把你叫醒的会话，text 是到点要发出去的那句话。',
      parameters: toJsonSchema({
        chat: { type: 'string', required: true, description: '刚把你叫醒的微信会话名，从 [微信] 通知里原样抄。' },
        text: { type: 'string', required: true, description: `到点要发出去的那句话，按到点时的口气写。${REMIND_TEXT_MAX} 字以内，不能含换行。` },
        after_minutes: { type: 'number', required: true, description: `过多少分钟提醒，${REMIND_MIN_MINUTES} 到 ${REMIND_MAX_MINUTES}。` },
        title: { type: 'string', required: false, description: '可选，给这条提醒起个短名字，方便之后找。' },
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
          ? `[已定：${out.text ? String(out.text) : `${nowText(out.dueAt)} 发到「${out.chat}」`}]`
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
      description: '看看还有哪些自己定的提醒没到点。',
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
      // 模型投影：列表原文里已经带了 id（取消要用），正文不再重复编号。
      project: (out) => ({ text: `[提醒] ${out?.text ?? ''}` }),
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
      description: '取消一条还没到点的提醒。id 从 her_reminders 里抄。',
      parameters: toJsonSchema({
        id: { type: 'string', required: true, description: 'her_reminders 列出的那条提醒的 id。' },
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
