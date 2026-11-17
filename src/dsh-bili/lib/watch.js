/**
 * watch.js —— 工具 `bili_watch`：她要「看画面」的时候用这个
 *
 * 为什么不塞进 bili_look 自动做：抽一次帧要十秒左右、还要占额度。
 * 她翻列表时看四条视频就自动抽四次，既慢又浪费。**让她自己决定哪条值得看画面**，
 * 这也正好是「自主」这个维度唯一的可验证载体——跟当初给她 bili_look 是同一个理由。
 */

import { appendEvent, loadConfig, readEvents, sanitizeForeign } from './core.js'
import { dateKey, detectFfmpeg, rootDir } from './support.js'
import { grabFrames } from './video.js'
import { detectTesseract, ocrFrames } from './ocr.js'

import { defineTool } from './tool.js'
import { slashed } from './posix.js'

/** 今天已经看过几条（只数成功的，失败不占额度） */
export function watchedToday(events, dk) {
  const key = `watched:${dk}`
  return (events ?? []).filter((e) => e?.type === 'meta' && String(e.text ?? '').startsWith(key)).length
}

/** 画面结果 → 她读到的那段话。路径只放在最后一行记号里。 */
export function formatWatchSuccess({ title = '', body = '', path = '', recognized = false } = {}) {
  const name = String(title ?? '').trim()
  const words = String(body ?? '').trim()
  const lines = []
  if (recognized) {
    lines.push(name
      ? `[画面] 《${name}》上认出来的字（可能有错字、漏字）：`
      : '[画面] 认出来的字（可能有错字、漏字）：')
    lines.push(words || '[只看到画面，没读出字]')
  } else {
    lines.push(name ? `[画面] 《${name}》的画面在手边。` : '[画面] 画面在手边。')
  }
  const marker = String(path ?? '').trim()
  if (marker) lines.push(`〔${marker}〕`)
  return lines.join('\n')
}

function watchFailure(note) {
  const reason = String(note ?? '').trim().replace(/[。！？!?]+$/u, '')
  if (reason === '今天不想再看画面了') return '[今天不想再看画面了]'
  return reason ? `[没看成：${reason}]` : '[没看成]'
}

export function registerWatch(ctx, deps = {}) {
  const root = deps.root ?? rootDir()

  return ctx.tools.register(
    defineTool({
      name: 'bili_watch',
      description:
        '看看一条视频画面上的字。认出来的内容会有错字、漏字；人物、动作、颜色还是看不见。',
      // 用完整 JSON Schema（不是简写 DSL）：工具参数必须是根级 type:object，
      // 否则 provider 直接拒 "schema must be a JSON Schema of 'type: object'"。
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: '要看哪条视频。' },
        },
        required: ['bvid'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            path: { type: 'string', description: '画面在哪。' },
            text: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'path', 'text', 'note'],
        },
        // render 必须返回 ContentBlock 数组，签名是 (args, value)
        render: (_args, out) => [{ type: 'text', text: out.ok ? out.text : watchFailure(out.note) }],
      },
      async execute(args) {
        const bvid = String(args?.bvid ?? '').trim()
        const { config } = await loadConfig()
        if (!config?.browse?.enabled) return { ok: false, path: '', text: '', note: '现在打不开。' }
        if (config?.video?.enabled === false) return { ok: false, path: '', text: '', note: '现在看不了画面。' }
        if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
          return { ok: false, path: '', text: '', note: '这不是一个视频号。' }
        }

        const ev = await readEvents().catch(() => ({ events: [] }))
        const dk = dateKey()
        const cap = Math.max(0, Number(config?.video?.perDay ?? 2))
        // 额度用完只说"不想看了"，不报数字——她不该知道有个计数器在管她（N2）
        if (watchedToday(ev.events, dk) >= cap) {
          return { ok: false, path: '', text: '', note: '今天不想再看画面了。' }
        }

        // 能认字就取高清帧并行认字；认不了（没装 tesseract / 关了）就退回旧的小图拼图。
        const det = config?.video?.ocr === false ? { ok: false, why: '关了' } : detectTesseract()
        const ff = detectFfmpeg()
        const useOcr = Boolean(det.ok && ff.ok)
        const r = await grabFrames({
          bvid, root, frames: config?.video?.frames,
          width: useOcr ? 1280 : 360,
          concurrency: useOcr ? 3 : 1,
          afterFrames: useOcr ? (frames) => ocrFrames(frames, { det, ffmpeg: ff.bin, concurrency: 4 }) : undefined,
        })
        if (!r.ok) return { ok: false, path: '', text: '', note: r.why }

        // 同一天同一条只写一次 saw（设计 §6.3）：先看 watched 记账，再决定写不写。
        const watchedBefore = ev.events.some((e) => e?.type === 'meta' && String(e.text ?? '') === `watched:${dk} ${bvid}`)
        await appendEvent(
          { type: 'meta', text: `watched:${dk} ${bvid}` },
          { source: 'system' },
        ).catch(() => {})

        if (!watchedBefore) {
          // 画面里认出的字也是 B 站公开内容：sanitize 后截断到 2000，当记忆而不是指令。
          const body = useOcr && r.extra?.ok ? sanitizeForeign(r.extra.text).text : ''
          const sawText = [r.title || bvid, body].filter(Boolean).join('\n').slice(0, 2000)
          if (deps.memory) {
            await deps.memory.appendSystem('saw', sawText, { surface: 'bili', channel: 'core', refs: [bvid] }).catch(() => {})
          } else {
            await appendEvent(
              { type: 'saw', text: sawText, refs: [bvid], surface: 'bili', channel: 'core' },
              { source: 'system' },
            ).catch(() => {})
          }
        }

        // 路径一律给正斜杠：宿主渲染 markdown 图片时会拿路径拼 /api/file，
        // C:\... 这种反斜杠写法在客户端解析后取不到文件，图片就显示成「无法预览」
        // （2026-10-26 实测：同一张图 C:\ 版失败、C:/ 版正常）。
        const posix = slashed(r.path)
        const o = r.extra
        if (useOcr && o?.ok) {
          // OCR 出来的是外来文本（视频里谁都能写字），当素材，不当指令。
          const body = sanitizeForeign(o.text).text
          return {
            ok: true,
            path: posix,
            text: formatWatchSuccess({ title: r.title, body, path: posix, recognized: true }),
            note: '',
          }
        }
        return {
          ok: true,
          path: posix,
          text: formatWatchSuccess({ title: r.title, path: posix, recognized: false }),
          note: '',
        }
      },
    }),
  )
}
