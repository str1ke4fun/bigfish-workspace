/**
 * owner-fact.js —— 把旧的「他说过某个名字是他」事件补写成 person_note。
 *
 * 背景（2026-11-13）：11-12 那条 utterance 里明确写了「cat不到flag的cat」是他，
 * 但全局身份文档会把引号内容去引用化，微信又按 channel 过滤召回，于是这条事实
 * 在微信里失效。旧事件不能改写，所以只追加一条 person_note，用 refs 指回原事件。
 *
 * 边界：
 *   - 只追加，不删除/不改写旧事件；
 *   - 默认 dry-run，只有 apply=true 才写；
 *   - 幂等：已经有一条 owner person_note 的 refs 包含源事件 id 就跳过；
 *   - label 必须显式给，或能从源文本的「…」里提取；提取不到就 abort，
 *     绝不写一条会被 BAD_PERSON 拒的 note。
 */

import { appendEvent, readEvents } from './store.js'
import { loadConfig } from './settings.js'
import { deriveSelf } from './derive.js'

/** 取第一个「…」里的别名。没有就返回空串。 */
export function extractQuotedLabel(text) {
  const m = /「([^」]{1,64})」/.exec(String(text ?? ''))
  return m ? m[1].trim() : ''
}

/**
 * 构造一条 owner person_note。
 * @returns {{ok:true,note:object}|{ok:false,why:string}}
 */
export function buildOwnerNote({ sourceEvent, name = '老哥', label = '', channel = 'wx', text = '' } = {}) {
  if (!sourceEvent?.id) return { ok: false, why: 'source event 不存在' }
  const resolved = String(label ?? '').trim() || extractQuotedLabel(sourceEvent.text)
  if (!resolved) return { ok: false, why: '找不到别名 label；请用 --label 指定' }
  const body = String(text ?? '').trim() || String(sourceEvent.text ?? '').trim()
  return {
    ok: true,
    note: {
      type: 'person_note',
      text: body.slice(0, 2000),
      person: {
        id: 'owner',
        name: String(name ?? '').trim() || '老哥',
        label: resolved.slice(0, 64),
        channel: channel === 'web' || channel === 'core' ? channel : 'wx',
        chatId: '',
        kind: 'identity',
        confidence: 'high',
      },
      refs: [sourceEvent.id],
      flags: ['identity'],
    },
  }
}

/** 事件流里是否已经有一条指向 sourceId 的 owner note。 */
export function hasOwnerNote(events, sourceId) {
  for (const e of Array.isArray(events) ? events : []) {
    if (e?.type !== 'person_note' || e?.person?.id !== 'owner') continue
    if ((e.refs ?? []).includes(sourceId)) return e
  }
  return null
}

/**
 * 运行迁移。默认 dry-run；apply=true 才追加。
 * @returns {Promise<{ok:boolean,wrote:boolean,note?:object,why?:string}>}
 */
export async function run({ root, eventId, label = '', name = '老哥', text = '', apply = false, log } = {}) {
  const { events } = await readEvents(root)
  const source = events.find((e) => e.id === eventId)
  if (!source) return { ok: false, wrote: false, why: '源事件不存在' }

  const existing = hasOwnerNote(events, eventId)
  if (existing) return { ok: true, wrote: false, note: existing, why: '已存在' }

  const built = buildOwnerNote({ sourceEvent: source, label, name, text })
  if (!built.ok) return { ok: false, wrote: false, why: built.why }
  if (!apply) return { ok: true, wrote: false, note: built.note }

  const { config } = await loadConfig(root)
  const model = deriveSelf(events, { growthDays: config.growthDays })
  await appendEvent(built.note, { day: model.day, stage: model.stage, source: 'system' }, root)
  log?.('owner-fact applied', eventId)
  return { ok: true, wrote: true, note: built.note }
}
