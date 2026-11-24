/**
 * work.js —— 工作委派：工头会话、worker、状态查询与前台通知
 *
 * 分工：
 *   - 工头是鱼本人，跑在 `work` 面会话，cwd = 用户显式给出的工作目录；
 *   - worker 是宿主的 durable 子会话，由 preset 限工具、cwd 继承工头；
 *   - 桌宠/微信只跟工头说话，不接触 worker；
 *   - 状态只写 work-sessions.json / work-units.json；事件流仍走 growth_commit。
 *
 * 这个模块不 import 宿主包；subagents 通过 work-backend 注入。
 */

import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { defineTool } from './tool.js'
import { registerTool } from './tool-result.js'
import { toJsonSchema } from './toolschema.js'
import { assistantTextOf } from './turnend.js'
import { looksLikeSecret } from './guard.js'

const TRUST_TTL_MS = 5 * 60_000
const trustedTurns = new Map()

/** 桌宠受信轮次：say.js 在她把这句话递进去之前调用。 */
export function markTrustedTurn(sessionId, at = Date.now()) {
  const id = String(sessionId ?? '')
  if (id) trustedTurns.set(id, Number(at) || Date.now())
}

export function clearTrustedTurn(sessionId) {
  trustedTurns.delete(String(sessionId ?? ''))
}

export function isTrustedTurn(sessionId, at = Date.now()) {
  const id = String(sessionId ?? '')
  const seen = trustedTurns.get(id)
  if (!seen) return false
  return (Number(at) || Date.now()) - seen <= TRUST_TTL_MS
}

const INSPECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'done'],
  properties: {
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
    done: { type: 'boolean' },
  },
}

const FAIL_TEXT = {
  NOT_SCREEN: '这里不能派活。',
  NOT_TRUSTED: '这句不是在桌宠里直接说的，不能派活。',
  NOT_TRUSTED_CHAT: '这个会话不能派活。',
  NO_DIR: '先告诉我工作目录。',
  BAD_DIR: '这个目录不能当工作区。',
  NO_SESSION: '这会儿接不上工作会话。',
  NOT_BOSS: '这条会话不是工头。',
  BAD_PERMISSION: '先把工作会话的权限切回 workspace-write。',
  NO_GUARD: 'guard 没挂上，不能派活。',
  NO_SUBAGENTS: '这台机器不支持派活。',
  LIMIT: '先等一个做完。',
  EMPTY_TASK: '还没说要做什么。',
}

function whyText(code, why = '') {
  const head = FAIL_TEXT[code] ?? '没做成。'
  return why ? `${head}（${String(why).slice(0, 120)}）` : head
}

function headerOf(agent) {
  return agent?.session?.header ?? agent?.header ?? {}
}

function sessionIdOf(agent) {
  return String(headerOf(agent).id ?? agent?.session?.id ?? '')
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realOrSelf(path) {
  try { return realpathSync(path) } catch { return resolve(path) }
}

function protectedPaths({ root = '', home = '' } = {}) {
  const h = home || (() => { try { return homedir() } catch { return '' } })()
  const narrow = ['/etc', '/proc', '/sys', '/dev', '/root/.ssh', '/root/.aws', '/mnt/c/Windows', '/mnt/c/Program Files', '/mnt/c/ProgramData']
  const wide = []
  if (h) {
    wide.push(h, dirname(h))
    narrow.push(join(h, '.ssh'), join(h, '.aws'), join(h, '.dsh'), join(h, '.dsh-fish'))
  }
  if (root) wide.push(resolve(root))
  return {
    narrow: [...new Set(narrow.map((p) => realOrSelf(p)))],
    wide: [...new Set(wide.map((p) => realOrSelf(p)))],
  }
}

/**
 * 校验工作目录：绝对、存在、可访问、不是受保护路径或它的祖先/子目录。
 * @returns {{ok:true, real:string}|{ok:false, why:string}}
 */
export function validateWorkDir(dir, { root = '', home = '' } = {}) {
  const raw = String(dir ?? '').trim()
  if (!raw) return { ok: false, why: '没给目录' }
  if (!isAbsolute(raw)) return { ok: false, why: '要用绝对路径' }
  let st = null
  try { st = statSync(raw) } catch { return { ok: false, why: '目录不存在' } }
  if (!st.isDirectory()) return { ok: false, why: '这不是目录' }
  try { accessSync(raw, constants.R_OK) } catch { return { ok: false, why: '目录不可读' } }
  const real = realOrSelf(raw)
  const { narrow, wide } = protectedPaths({ root, home })
  if (real === '/') return { ok: false, why: '根目录不能当工作区' }
  // 目录本身就在受保护路径里（或它的子目录）。
  if (narrow.some((p) => real === p || inside(p, real))) {
    return { ok: false, why: '这个目录在受保护路径里，换一个更窄的工作目录' }
  }
  // 目录是用户 home / 状态库 / 系统目录，或者包含了受保护路径：太宽。
  if (wide.some((p) => real === p || inside(p, real)) || narrow.some((p) => inside(real, p))) {
    return { ok: false, why: '这个目录包含了受保护路径，太宽了，换一个更窄的工作目录' }
  }
  return { ok: true, real }
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

function firstText(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim()
    if (s) return s
  }
  return ''
}

/**
 * @param {{
 *   ctx?: object, core?: object, config?: object, getConfig?: Function,
 *   state: object, backend: object, guard?: object, wx?: object,
 *   root?: string, now?: () => number, log?: Function,
 * }} opts
 */
export function createWorkService({
  ctx, core, config = {}, getConfig, state, backend, guard, wx,
  root = '', now = Date.now, log,
} = {}) {
  if (!state) throw new Error('work service requires state')
  if (!backend) throw new Error('work service requires backend')

  const lastAssistant = new Map()
  const pendingSettle = new Map()
  const lastNotified = new Map()
  const requestedSchema = new Map()
  const timers = new Map()

  function cfg() {
    try {
      return (typeof getConfig === 'function' ? getConfig() : config) ?? {}
    } catch {
      return config ?? {}
    }
  }

  function wxService() {
    if (wx) return wx
    try { return ctx?.get?.('wx') ?? null } catch { return null }
  }

  function surfaceOf(agent) {
    try { return core?.surface?.current?.(agent) ?? null } catch { return null }
  }

  function reserve(sessionId) {
    try { core?.surface?.reserve?.(sessionId, 'work') } catch { /* ignore */ }
  }

  function sessions() {
    try { return state.readSessions() ?? {} } catch { return {} }
  }

  function recordForDir(dir) {
    return sessions()[String(dir ?? '')] ?? null
  }

  function recordForSession(sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return null
    return Object.values(sessions()).find((r) => String(r?.sessionId ?? '') === id) ?? null
  }

  function latestRecord() {
    const rows = Object.values(sessions()).filter(Boolean)
    rows.sort((a, b) => Date.parse(b?.lastUsedAt ?? 0) - Date.parse(a?.lastUsedAt ?? 0))
    return rows[0] ?? null
  }

  function isWorkSession(sessionId) {
    return recordForSession(sessionId) !== null
  }

  function reserveKnown() {
    for (const rec of Object.values(sessions())) {
      if (rec?.sessionId) reserve(rec.sessionId)
    }
  }

  async function sessionAlive(sessionId) {
    if (!sessionId) return false
    let rows = null
    try { rows = await core?.sessions?.list?.({}) } catch { rows = null }
    if (!Array.isArray(rows) || rows.length === 0) return true
    return rows.some((row) => String(row?.sessionId ?? row?.id ?? '') === String(sessionId))
  }

  async function ensureBoss({ dir, origin = null }) {
    const existing = recordForDir(dir)
    if (existing?.sessionId) {
      reserve(existing.sessionId)
      if (await sessionAlive(existing.sessionId)) {
        await state.mutateSessions((s) => {
          const rec = s[dir]
          if (!rec) return
          rec.state = 'running'
          rec.waitingQuestion = null
          rec.lastUsedAt = new Date(now()).toISOString()
          if (origin) rec.lastOrigin = origin
        })
        return { ok: true, sessionId: existing.sessionId, reused: true, dir }
      }
    }

    const title = `干活 · ${basename(dir) || '工作'}`
    const created = await core?.sessions?.create?.({
      title,
      cwd: dir,
      preset: 'fish-work-boss',
      surface: 'work',
      requirePreset: true,
    })
    if (!created?.ok) {
      return { ok: false, why: created?.why || '工作会话没起来', dir }
    }
    const sessionId = String(created.sessionId ?? '')
    if (!sessionId) return { ok: false, why: '工作会话没给 id', dir }
    reserve(sessionId)
    const at = new Date(now()).toISOString()
    await state.mutateSessions((s) => {
      s[dir] = {
        sessionId,
        dir,
        bossKind: 'fish',
        title,
        preset: 'fish-work-boss',
        backend: 'subagent',
        state: 'running',
        waitingQuestion: null,
        lastSummary: '',
        lastReport: null,
        createdAt: at,
        lastUsedAt: at,
        lastOrigin: origin,
      }
    })
    return { ok: true, sessionId, reused: false, dir }
  }

  function workPrompt({ dir, task, origin }) {
    const source = origin?.surface === 'wx'
      ? `微信（${origin.chat || '私聊'}）`
      : '桌宠'
    return [
      `[工作] 目录：${dir}`,
      `任务：${task}`,
      `来源：${source}`,
      '完成后汇总；不要自己换目录；worker 不直接找用户。',
    ].join('\n')
  }

  async function notifyOwner(text) {
    const ownerChat = String(getPath(cfg(), 'work.wx.ownerChat') ?? '').trim()
    if (!ownerChat) return { ok: false, why: 'no-owner-chat' }
    let body = String(text ?? '').replace(/\s*\n+\s*/g, ' ').trim()
    if (!body) return { ok: false, why: 'empty' }
    if ([...body].length > 500) body = [...body].slice(0, 500).join('')
    try {
      if (looksLikeSecret(body)?.hit) body = '做完了，详情在电脑上'
    } catch { /* 守门失败不改变发送 */ }
    const svc = wxService()
    if (typeof svc?.notifyOwner !== 'function') return { ok: false, why: 'wx-unavailable' }
    try {
      return await svc.notifyOwner({ text: body, chat: ownerChat })
    } catch (err) {
      log?.(`[dsh-fish] 工作汇总没发出去：${String(err?.message ?? err).slice(0, 160)}`)
      return { ok: false, why: 'send-failed' }
    }
  }

  async function maybeNotify(bossSessionId, text, key) {
    const dedupeKey = `${bossSessionId}:${key}:${text}`
    if (lastNotified.get(bossSessionId) === dedupeKey) return
    lastNotified.set(bossSessionId, dedupeKey)
    await notifyOwner(text)
  }

  async function handleTurnEnd(sessionId, event) {
    const rec = recordForSession(sessionId)
    if (!rec) return
    const active = state.activeCounts(sessionId)
    const waiting = rec.state === 'waiting'
    const pending = pendingSettle.get(sessionId) ?? null
    const said = firstText(lastAssistant.get(sessionId), rec.lastSummary)

    if (waiting) {
      await maybeNotify(sessionId, `在等你：${rec.waitingQuestion || '有个问题'}`, 'waiting')
    } else if (active.active > 0) {
      await maybeNotify(sessionId, `已派出 ${active.active} 个 worker，还在做`, `active:${active.active}`)
      await state.mutateSessions((s) => {
        const row = Object.values(s).find((x) => x?.sessionId === sessionId)
        if (row) row.state = 'running'
      })
    } else if (pending) {
      const text = pending.ok
        ? `做完了：${firstText(pending.summary, said, '没有更多细节')}`
        : `卡住了：${firstText(pending.summary, said, '没有更多细节')}`
      await maybeNotify(sessionId, text, `settle:${pending.unitId}`)
      pendingSettle.delete(sessionId)
      await state.mutateSessions((s) => {
        const row = Object.values(s).find((x) => x?.sessionId === sessionId)
        if (row) row.state = 'idle'
      })
    } else {
      await state.mutateSessions((s) => {
        const row = Object.values(s).find((x) => x?.sessionId === sessionId)
        if (row && row.state !== 'waiting') row.state = 'idle'
      })
    }
    lastAssistant.delete(sessionId)
  }

  function onSessionEvent(session, event) {
    // 宿主给的是 Session；测试和旧调用也可能直接给 Agent（{session:{header}}）。
    const holder = session?.session ? session : { session }
    const sessionId = String(holder?.session?.header?.id ?? holder?.session?.id ?? '')
    if (event?.type === 'turn/end') clearTrustedTurn(sessionId)
    if (!sessionId) return
    let surface = null
    try { surface = surfaceOf(holder) } catch { surface = null }
    if (surface !== 'work') return
    if (event?.type === 'assistant/message') {
      const text = assistantTextOf(event)
      if (text) lastAssistant.set(sessionId, text)
      return
    }
    if (event?.type === 'turn/end') {
      void handleTurnEnd(sessionId, event).catch((err) => {
        log?.(`[dsh-fish] 工作通知状态机失败：${String(err?.message ?? err).slice(0, 160)}`)
      })
    }
  }

  function workerPrompt({ dir, task, mode, reviewOf, followUpOf }) {
    const lines = [
      '你是被派来的执行者，不是用户面前的那个人。',
      `工作目录：${dir}`,
      `任务：${task}`,
    ]
    if (mode === 'inspect') {
      lines.push('你只做只读检查：不要写文件、不要改文件、不要跑会改变工作区的命令。')
      lines.push('完成前必须调用 structured_output 交结构化结果；不要只用纯文本结束。')
    } else {
      lines.push('你可以在工作目录内读写、跑命令、装依赖；出目录、删除、移动、强推、装全局依赖要先停下来回报。')
    }
    if (reviewOf) lines.push(`这是在复查 ${reviewOf} 的结果。`)
    if (followUpOf) lines.push(`这是对 ${followUpOf} 的跟进。`)
    lines.push('只在这个目录内工作。不要派生子 agent，不要安装插件，不要读工作目录之外的路径。')
    lines.push('遇到需要审批、越界、删除、移动、强推、装全局依赖的操作，停下来，在最后说明需要什么；不要重试升权。')
    lines.push('完成后给出简短结果：做了什么、改了哪些文件、怎么验证的、还有什么没做。')
    return lines.join('\n')
  }

  async function finishUnit({ unitId, childId, bossSessionId, settle, mode }) {
    const timer = timers.get(unitId)
    if (timer) { clearTimeout(timer); timers.delete(unitId) }
    try { guard?.flushHits?.(childId, unitId) } catch { /* ignore */ }
    const requested = requestedSchema.get(unitId) === true
    requestedSchema.delete(unitId)
    const unit = await state.settleUnit(unitId, {
      stopReason: settle.stopReason,
      structured: settle.structured ?? null,
      requestedSchema: requested && mode === 'inspect',
      closingText: settle.closingText ?? settle.diagnostic ?? '',
    })
    if (!unit) return
    const ok = unit.status === 'done'
    pendingSettle.set(bossSessionId, {
      unitId, ok,
      summary: firstText(unit.summary, settle.closingText, settle.diagnostic, ''),
    })
    await state.mutateSessions((s) => {
      const row = Object.values(s).find((x) => x?.sessionId === bossSessionId)
      if (row) {
        row.lastSummary = unit.summary || row.lastSummary || ''
        row.state = row.state === 'waiting' ? 'waiting' : 'running'
      }
    })
  }

  // ---- 工具 ----

  const commonOutput = {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ok: { type: 'boolean' },
        code: { type: 'string' },
        why: { type: 'string' },
      },
    },
  }

  const herWork = defineTool({
    name: 'her_work',
    description: '用户给了工作目录和一件要做的事时，去那条工作会话里开始做。目录必须由用户明确给出；不知道就先问。',
    parameters: toJsonSchema({
      dir: { type: 'string', required: false, description: '用户给出的绝对目录。' },
      task: { type: 'string', required: true, description: '要做的事。' },
      continue: { type: 'boolean', required: false, description: '继续最近一次工作，不换目录。' },
    }),
    output: commonOutput,
    project: (out) => ({ text: out?.ok ? `去了：${out.dirBasename || '工作'}。` : `没去成：${out?.note || out?.why || '没接上'}` }),
    async execute(args = {}, exec = {}) {
      const agent = exec.agent
      const surface = surfaceOf(agent)
      const sessionId = sessionIdOf(agent)
      let origin = null
      if (surface === 'screen') {
        if (!isTrustedTurn(sessionId, now())) {
          return { ok: false, code: 'NOT_TRUSTED', note: whyText('NOT_TRUSTED') }
        }
        origin = { surface: 'screen', chat: '' }
      } else if (surface === 'wx') {
        const list = getPath(cfg(), 'work.wx.dispatchChats') ?? []
        const chat = String(wxService()?.currentChat?.(sessionId) ?? '')
        if (!chat || !Array.isArray(list) || !list.includes(chat)) {
          return { ok: false, code: 'NOT_TRUSTED_CHAT', note: whyText('NOT_TRUSTED_CHAT') }
        }
        origin = { surface: 'wx', chat }
      } else {
        return { ok: false, code: 'NOT_SCREEN', note: whyText('NOT_SCREEN') }
      }

      let dir = String(args.dir ?? '').trim()
      if (!dir && args.continue === true) {
        const latest = latestRecord()
        if (!latest) return { ok: false, code: 'NO_DIR', note: whyText('NO_DIR') }
        dir = String(latest.dir ?? Object.entries(sessions()).find(([, v]) => v === latest)?.[0] ?? '')
      }
      if (!dir) return { ok: false, code: 'NO_DIR', note: whyText('NO_DIR') }
      const valid = validateWorkDir(dir, { root })
      if (!valid.ok) {
        return { ok: false, code: 'BAD_DIR', note: `${whyText('BAD_DIR')} ${valid.why}` }
      }
      const task = String(args.task ?? '').trim()
      if (!task) return { ok: false, code: 'EMPTY_TASK', note: whyText('EMPTY_TASK') }

      const boss = await ensureBoss({ dir: valid.real, origin })
      if (!boss.ok) return { ok: false, code: 'NO_SESSION', note: whyText('NO_SESSION', boss.why) }
      const prompt = workPrompt({ dir: valid.real, task, origin })
      const sent = await core?.sessions?.prompt?.(boss.sessionId, prompt)
      if (sent && sent.ok === false) {
        return { ok: false, code: 'NO_SESSION', note: whyText('NO_SESSION', sent.why) }
      }
      return {
        ok: true,
        dir: valid.real,
        dirBasename: basename(valid.real),
        sessionId: boss.sessionId,
        reused: boss.reused,
        note: '去了',
      }
    },
  })

  const herWorkStatus = defineTool({
    name: 'her_work_status',
    description: '看看工作做到哪了。只给状态和最近的汇总，不翻 worker 的原始记录。',
    parameters: toJsonSchema({
      dir: { type: 'string', required: false, description: '想看哪个目录；不填就看最近一次。' },
    }),
    output: commonOutput,
    project: (out) => {
      if (!out?.ok) return { text: `没看到：${out?.note || out?.why || '还没有工作'}` }
      const head = `在 ${out.dirBasename || '工作'}：${out.activity}`
      return { text: out.lastSummary ? `${head}；${out.lastSummary}` : head }
    },
    async execute(args = {}, exec = {}) {
      const agent = exec.agent
      const surface = surfaceOf(agent)
      if (surface !== 'screen' && surface !== 'wx' && surface !== 'work') {
        return { ok: false, code: 'NOT_SCREEN', note: whyText('NOT_SCREEN') }
      }
      let rec = null
      if (args.dir) {
        const valid = validateWorkDir(args.dir, { root })
        if (!valid.ok) return { ok: false, code: 'BAD_DIR', note: `${whyText('BAD_DIR')} ${valid.why}` }
        rec = recordForDir(valid.real)
      } else {
        rec = latestRecord()
      }
      if (!rec) return { ok: false, code: 'NO_SESSION', note: '还没有工作会话。' }
      const counts = state.activeCounts(rec.sessionId)
      return {
        ok: true,
        dir: Object.entries(sessions()).find(([, v]) => v?.sessionId === rec.sessionId)?.[0] ?? '',
        dirBasename: basename(Object.entries(sessions()).find(([, v]) => v?.sessionId === rec.sessionId)?.[0] ?? ''),
        sessionId: rec.sessionId,
        activeWorkers: counts.active,
        activity: rec.state || 'idle',
        lastSummary: rec.lastSummary || '',
        waiting: rec.state === 'waiting',
        at: now(),
      }
    },
  })

  const herWorker = defineTool({
    name: 'her_worker',
    description: '把一件具体的事派给 worker。inspect 只读检查，build 可以改文件、跑命令。不要自己指定目录。',
    parameters: toJsonSchema({
      mode: { type: 'string', required: false, enum: ['inspect', 'build'], description: '缺省 inspect。' },
      task: { type: 'string', required: true, description: '交给 worker 的具体任务。' },
      label: { type: 'string', required: false, description: '一句短标签。' },
      reviewOf: { type: 'string', required: false, description: '复查哪个 unit。' },
      followUpOf: { type: 'string', required: false, description: '跟进哪个 unit。' },
    }),
    output: commonOutput,
    project: (out) => ({ text: out?.ok ? '派出去了。' : `没派出去：${out?.note || out?.why || '没接上'}` }),
    async execute(args = {}, exec = {}) {
      const agent = exec.agent
      const surface = surfaceOf(agent)
      if (surface !== 'work') return { ok: false, code: 'NOT_BOSS', note: whyText('NOT_BOSS') }
      const sessionId = sessionIdOf(agent)
      const rec = recordForSession(sessionId)
      if (!rec) return { ok: false, code: 'NOT_BOSS', note: whyText('NOT_BOSS') }
      const dir = String(headerOf(agent).cwd ?? '')
      if (!dir) return { ok: false, code: 'NO_DIR', note: whyText('NO_DIR') }
      try {
        const pp = ctx?.get?.('permissionPresets')
        if (pp && typeof pp.current === 'function') {
          let current = ''
          try {
            current = pp.current(agent.session)
          } catch {
            // 权限服务在但读不出来：不把“目录内受控”建立在猜测上。
            return { ok: false, code: 'BAD_PERMISSION', note: whyText('BAD_PERMISSION') }
          }
          if (current !== 'workspace-write') {
            return { ok: false, code: 'BAD_PERMISSION', note: whyText('BAD_PERMISSION') }
          }
        }
      } catch { /* 拿不到权限服务时交给 sandbox 兜底 */ }

      if (guard?.status?.().ok !== true) {
        return { ok: false, code: 'NO_GUARD', note: whyText('NO_GUARD') }
      }
      if (backend.available?.() !== true) {
        return { ok: false, code: 'NO_SUBAGENTS', note: whyText('NO_SUBAGENTS') }
      }

      const mode = args.mode === 'build' ? 'build' : 'inspect'
      const task = String(args.task ?? '').trim()
      if (!task) return { ok: false, code: 'EMPTY_TASK', note: whyText('EMPTY_TASK') }
      const counts = state.activeCounts(sessionId)
      const maxActive = Number(getPath(cfg(), 'work.delegation.maxActive') ?? 2)
      const maxBuild = Number(getPath(cfg(), 'work.delegation.maxBuild') ?? 1)
      if (counts.active >= maxActive || (mode === 'build' && counts.build >= maxBuild)) {
        return { ok: false, code: 'LIMIT', note: whyText('LIMIT') }
      }

      const label = String(args.label ?? '').trim()
      const unit = await state.createUnit({
        dir: rec.dir ?? dir,
        bossSessionId: sessionId,
        bossKind: 'fish',
        backend: 'subagent',
        mode,
        label,
        reviewOf: args.reviewOf,
        followUpOf: args.followUpOf,
      })
      const structured = getPath(cfg(), 'work.delegation.structuredOutput') ?? 'inspect-only'
      const wantSchema = mode === 'inspect' && structured !== 'none'
      const spawnInput = {
        parent: agent,
        dir: rec.dir ?? dir,
        preset: mode === 'inspect' ? 'fish-work-inspect' : 'fish-work-build',
        prompt: workerPrompt({ dir: rec.dir ?? dir, task, mode, reviewOf: args.reviewOf, followUpOf: args.followUpOf }),
        label,
        signal: new AbortController().signal,
      }
      if (wantSchema) spawnInput.outputSchema = INSPECT_SCHEMA
      const started = await backend.spawn(spawnInput)
      if (!started.ok) {
        await state.updateUnit(unit.id, {
          status: 'failed',
          failureKind: 'start',
          summary: String(started.why ?? '启动失败').slice(0, 2000),
          settledAt: new Date(now()).toISOString(),
        })
        return { ok: false, code: started.code || 'START_FAILED', unitId: unit.id, note: `没派出去：${started.why ?? '启动失败'}` }
      }

      const childId = String(started.childId)
      await state.updateUnit(unit.id, { status: 'running', backendRef: { childId } })
      if (wantSchema) requestedSchema.set(unit.id, true)
      backend.onSettle(started.result, (settle) => {
        void finishUnit({ unitId: unit.id, childId, bossSessionId: sessionId, settle, mode }).catch((err) => {
          log?.(`[dsh-fish] worker 结算写入失败：${String(err?.message ?? err).slice(0, 160)}`)
        })
      })
      const timeout = Number(getPath(cfg(), 'work.delegation.runTimeoutMs') ?? 1_800_000)
      const timer = setTimeout(() => {
        try { void backend.interrupt({ sender: agent, childId }) } catch { /* ignore */ }
        void state.updateUnit(unit.id, {
          status: 'aborted',
          failureKind: 'timeout',
          summary: '超时了',
          settledAt: new Date(now()).toISOString(),
        }).then(() => {
          pendingSettle.set(sessionId, { unitId: unit.id, ok: false, summary: '超时了' })
        }).catch(() => {})
      }, Math.max(60_000, timeout))
      timer.unref?.()
      timers.set(unit.id, timer)

      return { ok: true, unitId: unit.id, childId, mode, note: 'worker 派出去了' }
    },
  })

  const herWorkerControl = defineTool({
    name: 'her_worker_control',
    description: '看看 worker 在做什么、给还在跑的 worker 带句话，或者叫停它。已经结束的 worker 不能续聊。',
    parameters: toJsonSchema({
      action: { type: 'string', required: true, enum: ['message', 'interrupt', 'list', 'get'], description: '要做什么。' },
      unitId: { type: 'string', required: false, description: 'message / interrupt / get 时必填。' },
      text: { type: 'string', required: false, description: 'message 时要带的话。' },
      scope: { type: 'string', required: false, enum: ['current', 'dir'], description: 'list 的范围，缺省 current。' },
    }),
    output: commonOutput,
    project: (out) => {
      if (!out?.ok) return { text: `没做成：${out?.note || out?.why || '没接上'}` }
      if (out.action === 'list') return { text: `现在有 ${out.units?.length ?? 0} 条 worker 记录。` }
      if (out.action === 'get') return { text: `状态：${out.status}${out.summary ? `；${out.summary}` : ''}` }
      if (out.action === 'interrupt') return { text: '叫停了。' }
      return { text: '带到了。' }
    },
    async execute(args = {}, exec = {}) {
      const agent = exec.agent
      if (surfaceOf(agent) !== 'work') return { ok: false, code: 'NOT_BOSS', note: whyText('NOT_BOSS') }
      const sessionId = sessionIdOf(agent)
      const rec = recordForSession(sessionId)
      if (!rec) return { ok: false, code: 'NOT_BOSS', note: whyText('NOT_BOSS') }
      const action = String(args.action ?? '')
      const unitOf = () => state.unitsForBoss(sessionId).find((u) => u.id === args.unitId) ?? null

      if (action === 'list') {
        const units = args.scope === 'dir' ? state.unitsForDir(rec.dir ?? '') : state.unitsForBoss(sessionId)
        return {
          ok: true,
          action,
          units: units.map((u) => ({
            unitId: u.id,
            childId: u.backendRef?.childId ?? '',
            label: u.label,
            mode: u.mode,
            status: u.status,
            updatedAt: u.updatedAt,
          })),
        }
      }

      const unit = unitOf()
      if (!unit) return { ok: false, code: 'NO_UNIT', note: '没有这条 worker。' }

      if (action === 'get') {
        return {
          ok: true,
          action,
          unitId: unit.id,
          childId: unit.backendRef?.childId ?? '',
          status: unit.status,
          stopReason: unit.stopReason ?? null,
          failureKind: unit.failureKind ?? null,
          summary: unit.summary ?? '',
          report: unit.report ?? null,
          updatedAt: unit.updatedAt,
        }
      }

      if (action === 'message') {
        if (unit.status !== 'queued' && unit.status !== 'running') {
          return { ok: false, code: 'UNIT_SETTLED', why: 'unit-settled', note: '要跟进就新建一个 worker。' }
        }
        const text = String(args.text ?? '').trim()
        if (!text) return { ok: false, code: 'EMPTY_TEXT', note: '还没说要带什么话。' }
        const sent = await backend.message({ sender: agent, childId: unit.backendRef?.childId ?? '', text, signal: new AbortController().signal })
        if (!sent.ok) {
          if (sent.code === 'INPUT_CLOSED') {
            return { ok: false, code: 'INPUT_CLOSED', why: 'input-closed', note: '等它结算，或新建一个 worker。' }
          }
          return { ok: false, code: sent.code || 'MESSAGE_FAILED', note: sent.why || '没带到。' }
        }
        await state.updateUnit(unit.id, { updatedAt: new Date(now()).toISOString() })
        return { ok: true, action, messageId: sent.messageId }
      }

      if (action === 'interrupt') {
        if (unit.status !== 'queued' && unit.status !== 'running') {
          return { ok: true, action, accepted: false, note: '已经结束了。' }
        }
        const stopped = await backend.interrupt({ sender: agent, childId: unit.backendRef?.childId ?? '' })
        if (!stopped.ok) return { ok: false, code: stopped.code || 'INTERRUPT_FAILED', note: stopped.why || '没叫停。' }
        return { ok: true, action, accepted: stopped.accepted === true }
      }

      return { ok: false, code: 'BAD_ACTION', note: '不认识这个动作。' }
    },
  })

  const herAskUser = defineTool({
    name: 'her_ask_user',
    description: '需要用户拍板才能继续时，把问题留下并结束这一轮；用户在桌宠或微信回一句，会再送进来。',
    parameters: toJsonSchema({
      question: { type: 'string', required: true, description: '要问用户什么。' },
    }),
    output: commonOutput,
    project: (out) => ({ text: out?.ok ? `等用户回：${out.question || ''}` : `没问成：${out?.note || ''}` }),
    async execute(args = {}, exec = {}) {
      const agent = exec.agent
      if (surfaceOf(agent) !== 'work') return { ok: false, code: 'NOT_BOSS', note: whyText('NOT_BOSS') }
      const sessionId = sessionIdOf(agent)
      const rec = recordForSession(sessionId)
      if (!rec) return { ok: false, code: 'NOT_BOSS', note: whyText('NOT_BOSS') }
      const question = String(args.question ?? '').trim()
      if (!question) return { ok: false, code: 'EMPTY_QUESTION', note: '还没想好问什么。' }
      await state.mutateSessions((s) => {
        const row = Object.values(s).find((x) => x?.sessionId === sessionId)
        if (row) {
          row.state = 'waiting'
          row.waitingQuestion = question
          row.lastUsedAt = new Date(now()).toISOString()
        }
      })
      return { ok: true, waiting: true, question, note: '等用户回' }
    },
  })

  const tools = { her_work: herWork, her_work_status: herWorkStatus, her_worker: herWorker, her_worker_control: herWorkerControl, her_ask_user: herAskUser }

  function register(ctx2) {
    const disposers = []
    for (const def of Object.values(tools)) {
      try {
        const off = registerTool(ctx2, def)
        if (typeof off === 'function') disposers.push(off)
      } catch (err) {
        log?.(`[dsh-fish] 工作工具注册失败 ${def.name}：${String(err?.message ?? err).slice(0, 160)}`)
      }
    }
    try {
      const off = ctx2?.on?.('session/event', onSessionEvent)
      if (typeof off === 'function') disposers.push(off)
    } catch (err) {
      log?.(`[dsh-fish] 工作事件监听没挂上：${String(err?.message ?? err).slice(0, 160)}`)
    }
    return () => {
      for (const d of disposers) {
        try { d() } catch { /* ignore */ }
      }
    }
  }

  async function reconcile() {
    const changed = await state.reconcileRunning()
    return { ok: true, changed }
  }

  function status() {
    return {
      backend: backend.available?.() === true,
      guard: guard?.status?.() ?? { ok: false },
      work: state.status?.() ?? {},
    }
  }

  return {
    tools,
    register,
    reserveKnown,
    isWorkSession,
    onSessionEvent,
    reconcile,
    status,
    validateWorkDir: (dir) => validateWorkDir(dir, { root }),
  }
}
