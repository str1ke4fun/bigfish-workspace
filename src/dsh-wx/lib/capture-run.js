/**
 * capture-run.js —— 单次后台采集的编排
 *
 * 一次采集 = 读当前树 → 点开目标会话 → OCR 对齐发言人 → 向上回滚补历史 →
 * 按内容去重合并 → 写台账 → 扫描 @ 触发 → 滚回底部 → 恢复原会话。
 *
 * 这里只编排，不直接碰窗口：读屏、点击、滚动、OCR、恢复全部由调用方注入 io，
 * 台账由 contextStore 注入，所以 node --test 可以用假 io 跑完整流程。
 *
 * 失败边界（刻意分层）：
 *   - 树不可用 / 点不开：不写台账，返回 ok:false；
 *   - OCR 抛错或没读到行：不算失败，只是没有发言人；
 *   - 回滚后的 scrollDown / restore 失败：只记日志，已经写下的台账不回滚；
 *   - 其它未预期异常：catch 成 {ok:false, chat, why}，不抛给调用方。
 *
 * 回滚合并的方向：向上滚动读到的是**更早**的一屏，它和已累积的较新一屏
 * 在时间上首尾相接。所以合并时把新滚出来的一屏当「旧屏」（时间在前），
 * 在它末尾与较新一屏开头之间找最长重叠 k，再追加较新一屏的 slice(k)。
 */

import { createHash } from 'node:crypto'

import { chatIdFor } from './ledger.js'
import { samePreviewText } from './speaker.js'
import { alignSpeakers } from './speaker-align.js'
import { sameName } from './tree.js'
import { normalizeMessages } from './transcript.js'

export const DEFAULT_MAX_SCROLL_PAGES = 3

const str = (v) => String(v ?? '').trim()
const messageOf = (err) => String(err?.message ?? err ?? '未知错误').slice(0, 200)

/**
 * 同一屏的稳定指纹：chatId + 每条消息正文。
 * 重复 OCR 同一屏得到同一个 key，换一屏才可能触发第二次确认。
 */
export function captureEvidenceKey(chatId, messages = []) {
  const texts = (Array.isArray(messages) ? messages : []).map((m) => str(m?.text))
  return createHash('sha1').update(str(chatId) + ':' + texts.join('\u0000')).digest('hex')
}

/** 去重只看类型 + 正文：发言人可能只在一屏里对齐出来，不能算成不同消息。 */
const sameContent = (a, b) =>
  (str(a?.kind) || 'text') === (str(b?.kind) || 'text') && str(a?.text) === str(b?.text)

const sameScreen = (a, b) =>
  a.length === b.length && a.every((item, i) => sameContent(item, b[i]))

/**
 * 相邻两屏去重合并，旧屏（时间更早）在前。
 * 找最长 k，使旧屏末尾 k 条与新屏开头 k 条 kind+text 相同，只追加新屏 slice(k)。
 */
function mergeScreens(older, newer) {
  const limit = Math.min(older.length, newer.length)
  for (let k = limit; k > 0; k--) {
    let same = true
    for (let i = 0; i < k; i++) {
      if (!sameContent(older[older.length - k + i], newer[i])) { same = false; break }
    }
    if (same) return [...older, ...newer.slice(k)]
  }
  return [...older, ...newer]
}

/**
 * 单次采集。
 *
 * @param {object} req
 * @param {{chat:string, chatId?:string, reason?:string, unread?:number}} req.job
 * @param {object} req.io 读屏 / 点击 / 滚动 / OCR / 恢复 / @ 回调
 * @param {object} req.contextStore createContextStore 的返回值（capture + ledger）
 * @param {{idFor?:(name:string)=>string, entry?:(name:string)=>object|null}} [req.directory]
 * @param {{resolve?:(raw:string)=>{name:string, matched:boolean}}} [req.people] 人物名册
 * @param {{maxScrollPages?:number}} [req.settings]
 * @param {{trigger?:string[]}} [req.policy]
 * @param {() => number} [req.now]
 * @param {(line:string, err?:unknown) => void} [req.log]
 * @returns {Promise<{ok:boolean, chat:string, added:number, skipped:number, why?:string,
 *   scrolled:number, restored:boolean, records:object[], ocrSenders:string[], ocrEvidenceKey:string}>}
 */
export async function runCapture({
  job = {}, io, contextStore, directory, people, settings, policy, now, log,
} = {}) {
  const chat = str(job.chat)
  const nowFn = typeof now === 'function'
    ? now
    : () => (Number.isFinite(Number(now)) ? Number(now) : Date.now())
  const logFn = typeof log === 'function' ? log : () => {}
  const maxPages = Number.isFinite(Number(settings?.maxScrollPages))
    ? Math.max(0, Number(settings.maxScrollPages))
    : DEFAULT_MAX_SCROLL_PAGES
  const triggers = (Array.isArray(policy?.trigger) ? policy.trigger : []).map(str).filter(Boolean)

  try {
    // 1. 先看树：树本身不可用就别点，OCR 回退的侧栏也不能拿来采集聊天区。
    const before = await io.read()
    if (!before?.parsed?.ok || before.source === 'ocr') {
      return { ok: false, chat, why: 'tree-not-ok' }
    }

    // 2. 当前已经是目标会话就直接用这份快照；否则点开，点不开不写台账。
    const prev = str(before.parsed.current)
    let opened = before
    if (!sameName(prev, chat)) {
      opened = await io.open(chat, before)
      if (!opened?.parsed?.ok) return { ok: false, chat, why: 'open-failed' }
    }

    // 3. 归一当前屏；chatId 以任务 / 目录 / 名字哈希为序。
    let messages = normalizeMessages(opened.parsed.messages, { now: nowFn() })
    const chatId = str(job.chatId) || str(directory?.idFor?.(chat)) || chatIdFor(chat)

    // 4. OCR 只是补充发言人：失败、没行都照常入账。
    let ocrSenders = []
    let ocrEvidenceKey = ''
    let ocr = null
    try { ocr = await io.ocrSpeakers?.() } catch { ocr = null }
    const lines = Array.isArray(ocr?.lines) ? ocr.lines : []
    if (lines.length) {
      const aligned = alignSpeakers(messages, lines, { roster: people })
      messages = messages.map((m, i) => {
        const a = aligned[i]
        return a
          ? { ...m, sender: a.sender, senderConfidence: a.senderConfidence, direction: a.direction }
          : m
      })
      ocrSenders = [...new Set(aligned.map((a) => a.sender).filter(Boolean))]
      ocrEvidenceKey = captureEvidenceKey(chatId, aligned)
    }

    // 5. 与台账末尾没有重叠才向上补历史；出现重叠、屏没变化、读不到就停。
    const lastDoc = contextStore.ledger.window(chatId, { limit: 1 })[0] ?? null
    const hasOverlap = (list) => Boolean(lastDoc) && list.some((m) => samePreviewText(lastDoc.text, m.text))

    let merged = messages
    let screen = messages
    let scrolled = 0
    if (!hasOverlap(merged)) {
      for (let i = 0; i < maxPages; i++) {
        const shot = await io.scrollUp(opened.parsed)
        if (!shot?.parsed?.ok) break
        const older = normalizeMessages(shot.parsed.messages, { now: nowFn() })
        if (!older.length || sameScreen(screen, older)) break
        merged = mergeScreens(older, merged)
        screen = older
        scrolled += 1
        if (hasOverlap(older)) break
      }
    }

    // 6. 回滚过就滚回底部；失败只记日志，台账照写。
    if (scrolled > 0) {
      try {
        await io.scrollDown(opened.parsed, scrolled)
      } catch (err) {
        logFn('回滚后恢复位置失败：' + messageOf(err))
      }
    }

    // 7. 入账：未读数按 job 快照写给每条消息，目录只用来判断私聊。
    const row = (opened.parsed.chats ?? []).find((c) => sameName(c?.name, chat)) ?? null
    const unreadBefore = Math.max(0, Number(job.unread) || 0)
    const captured = contextStore.capture({
      chat,
      chatId,
      messages: merged.map((m) => ({ ...m, unreadBefore })),
      source: 'capture',
      preview: row?.preview ?? '',
      isDM: directory?.entry?.(chat)?.kind === 'dm' ? true : null,
      outbox: io.outboxFor?.(chat) ?? [],
    })

    // 8. 扫描这次真正新入账的记录，以及被整屏采集代表的预览记录；
    //    同一条消息只叫一次，避免预览和正文重复触发。
    if (captured.ok && triggers.length) {
      const seenMentions = new Set()
      for (const record of [...(captured.records ?? []), ...(captured.dropped ?? [])]) {
        const text = str(record?.text)
        const key = 'capture:' + record?.msgId
        if (!text || !record?.msgId || seenMentions.has(key)) continue
        seenMentions.add(key)
        if (!triggers.some((t) => text.includes(t))) continue
        await io.onMention({
          chat,
          chatId,
          preview: text,
          msgId: record.msgId,
          key,
          why: '@',
        })
      }
    }

    // 9. 确实点开过别的会话才恢复；失败不重试、不影响本次采集结果。
    let restored = false
    if (prev && !sameName(prev, chat)) {
      try {
        const okRestore = await io.restore(prev)
        if (okRestore === false) logFn('恢复原会话失败：' + prev)
        else restored = true
      } catch (err) {
        logFn('恢复原会话失败：' + prev + '（' + messageOf(err) + '）')
      }
    }

    // 10. 汇总。capture 失败时把原因带出去，但仍是同一个返回形状。
    return {
      ok: captured.ok,
      chat,
      added: captured.added ?? 0,
      skipped: captured.skipped ?? 0,
      ...(captured.ok ? {} : { why: captured.why }),
      scrolled,
      restored,
      records: captured.records ?? [],
      ocrSenders,
      ocrEvidenceKey,
    }
  } catch (err) {
    return { ok: false, chat, why: messageOf(err) }
  }
}
