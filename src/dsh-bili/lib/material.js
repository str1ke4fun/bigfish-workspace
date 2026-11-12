/**
 * material.js —— 醒来前的素材（原 core scheduler.lookBeforeWake）
 *
 * 设计 §6 A2：B 站素材属于 B 站面，跟着 dsh-bili 走。core 的 scheduler 只负责
 * 在自己的串行 tick 里问钩子要一段处境，不再 import 任何 B 站模块。
 *
 * 三个刻意的取舍保持原样：
 *   1. 刷站失败不算唤醒失败；
 *   2. 配额单独算（browse.perDay），与每日事件数无关；
 *   3. 只给素材，不给结论——网络文本在 browse.renderMaterial 里统一包成「素材」。
 */
import { gather, browseCountToday, recordBrowse } from './browse.js'
import { createClient } from './bili.js'
import { browsePlan, noteRisk, riskState } from './risk.js'
import { refreshSelfDoc, readEvents } from './core.js'
import { dateKey, inWindow } from './support.js'

/**
 * @param {{events?: object[], now?: Date, memory?: object, client?: object, forceBrowse?: boolean}} deps
 * @returns {Promise<{text:string, intro:string, picks:object[], riskNote?:string}>}
 */
export async function lookBeforeWake(model, config, dk, deps = {}, log) {
  const empty = { text: '', intro: '', picks: [] }
  if (!config?.browse?.enabled) return empty
  const perDay = Number(config?.browse?.perDay ?? 0)
  // forceBrowse（2026-10-26）：设置页那个「让她去刷 B 站」按钮专用。
  // 绕过当日上限与上网时段，别的什么都不改。
  const forced = deps.forceBrowse === true
  if (!forced && !(perDay > 0)) return empty

  const bw = Array.isArray(config?.browse?.window) ? config.browse.window
    : Array.isArray(config?.window) ? config.window
      : ['00:00', '23:59']
  if (!forced && !inWindow({ window: bw }, deps.now ?? new Date())) return empty

  const st = riskState(deps.root, deps.now ?? new Date())
  if (st.cooling) {
    log?.('risk cooldown', `还有 ${st.remainMin} 分钟`)
    return { ...empty, riskNote: '今天网络不太顺，什么都没翻到。过一阵再看。' }
  }

  try {
    const events = deps.events ?? (await readEvents()).events
    if (!forced && browseCountToday(events, dk) >= perDay) return empty

    const bp = browsePlan(config, st)
    const cfg2 = (bp.topN === Number(config?.browse?.topN) && bp.deepRead === Number(config?.browse?.deepRead))
      ? config
      : { ...config, browse: { ...config.browse, topN: bp.topN, deepRead: bp.deepRead } }

    const client = deps.client ?? createClient({ log: (...a) => log?.('bili', ...a) })
    const r = await gather(client, model, cfg2, { root: deps.root, dk, events, memory: deps.memory })
    if (!r.ok || !r.text) {
      if (/COOLDOWN|-352|-412|-509|风控/.test(String(r.code ?? r.note ?? ''))) noteRisk(deps.root, r.code ?? 'COOLDOWN', deps.now ?? new Date())
      if (r.note) log?.('browse empty', r.note)
      return empty
    }
    await recordBrowse(deps.root, dk, r.picks, model)
    // gather 已经把看过的每一条写成 `saw`；身份文件要跟着更新。
    await refreshSelfDoc()
    return {
      text: r.text,
      intro: '## 你刚醒，屏幕上有人在说话\n这是平台此刻推到你面前的东西。你可以看，也可以不看。',
      picks: r.picks,
    }
  } catch (err) {
    if (/COOLDOWN|-352|-412|-509|风控/.test(String(err?.code ?? err?.message ?? ''))) {
      noteRisk(deps.root, err?.code ?? 'COOLDOWN', deps.now ?? new Date())
    }
    log?.('browse failed', err?.message ?? err)
    return empty
  }
}

export { dateKey }
