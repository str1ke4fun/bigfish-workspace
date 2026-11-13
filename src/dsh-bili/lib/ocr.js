/**
 * ocr.js —— 让不支持图像的模型也能「读」视频画面里的字
 *
 * 她的模型读不了图，bili_watch 以前给她一张拼图，对她等于白板。
 * 这里在工具里把字认出来，她拿到的是文字，不是图。
 *
 * 取舍（折中档）：
 *   - 每帧识别两遍：底部字幕带（--psm 6，放大 1.5 倍）+ 整帧（--psm 11，稀疏文字）。
 *     字幕带读字幕，整帧读标题/弹窗/幻灯片。
 *   - 多帧并发（默认 4 路），每个 tesseract 只用 1 个线程，免得 24 核互相抢。
 *   - 只留置信度够高、像人话的行；跨帧去重，同一句字幕只记第一次出现的时间。
 *   - 总量封顶。宁可少给，不给一屏乱码。
 *
 * 依赖：tesseract（含 chi_sim 语言包）+ ffmpeg。都是可选的——没有就退回旧行为。
 * 升级路线：识别率不够时，把 recognize() 换成 RapidOCR，其余不动。
 */

import { spawn, spawnSync } from 'node:child_process'

const CJK = /[\u3400-\u9fff]/
const WORD = /[\u3400-\u9fffA-Za-z0-9]/g

/** 探测 tesseract 和语言包。只读。 */
export function detectTesseract(env = process.env) {
  const bin = String(env.DSH_FISH_TESSERACT ?? 'tesseract')
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true })
  if (v.error || v.status !== 0) return { ok: false, bin, lang: '', why: '没找到 tesseract' }
  const l = spawnSync(bin, ['--list-langs'], { encoding: 'utf8', windowsHide: true })
  const langs = String(l.stdout ?? '').split(/\r?\n/).map((s) => s.trim())
  const has = (x) => langs.includes(x)
  if (has('chi_sim') && has('eng')) return { ok: true, bin, lang: 'chi_sim+eng', why: '' }
  if (has('chi_sim')) return { ok: true, bin, lang: 'chi_sim', why: '' }
  if (has('eng')) return { ok: true, bin, lang: 'eng', why: '只有英文语言包，中文认不出来' }
  return { ok: false, bin, lang: '', why: 'tesseract 没有可用的语言包' }
}

function run(cmd, args, { timeout = 30_000, env } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...env } })
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { p.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ code: -1, out })
    }, timeout)
    p.stdout.on('data', (c) => { if (out.length < 400_000) out += String(c) })
    p.stderr.on('data', () => {})
    p.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -2, out }) } })
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -3, out }) } })
  })
}

/** 相邻两个词之间要不要补空格：只有两边都是拉丁/数字时才补，中文之间不补。 */
function joinWords(words) {
  let s = ''
  for (const w of words) {
    if (!s) { s = w; continue }
    const a = s[s.length - 1]
    const b = w[0]
    s += /[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b) ? ' ' + w : w
  }
  return s
}

/**
 * 解析 tesseract 的 tsv 输出，按行归并，返回 [{text, conf}]。
 * conf 取一行里各词置信度的均值。
 */
export function parseTsv(tsv) {
  const lines = new Map()
  for (const row of String(tsv ?? '').split(/\r?\n/).slice(1)) {
    const c = row.split('\t')
    if (c.length < 12 || c[0] !== '5') continue
    const conf = Number(c[10])
    const text = String(c.slice(11).join('\t')).trim()
    // 单个词置信度太低的多半是背景纹理认出来的垃圾，别让它们拖低整行均值、也别混进句子里
    if (!text || !(conf >= 30)) continue
    const key = `${c[2]}-${c[3]}-${c[4]}`
    if (!lines.has(key)) lines.set(key, [])
    lines.get(key).push({ text, conf })
  }
  return [...lines.values()].map((ws) => ({
    text: joinWords(ws.map((w) => w.text)),
    conf: ws.reduce((a, w) => a + w.conf, 0) / ws.length,
  }))
}

/** 这一行像不像人话：够长、有效字符占比够高、不是一串符号。 */
export function plausible(text, conf, minConf, latinMin = 75) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (conf < minConf) return false
  // 纯拉丁文的噪声最多（背景纹理会被认成 JOUQLAN 之类），所以门槛更高
  if (!CJK.test(t) && conf < latinMin) return false
  const valid = (t.match(WORD) ?? []).length
  if (valid < (CJK.test(t) ? 2 : 4)) return false
  if (valid / t.replace(/\s/g, '').length < 0.6) return false
  // 全是同一个字符 / 单个字母拼出来的噪声
  if (new Set(t.replace(/\s/g, '')).size <= 2 && valid > 3) return false
  return true
}

const norm = (s) => String(s).replace(/[^\u3400-\u9fffA-Za-z0-9]/g, '').toLowerCase()

function bigrams(s) {
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** 两句是不是同一句（字幕逐帧重复、OCR 偶尔错一两个字）。 */
export function sameLine(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true
  // 短句被噪声字符粘在前后（「gw你好」vs「你好」）：包含，且多出来的不超过 2 个字符
  if (Math.min(x.length, y.length) >= 2 && Math.abs(x.length - y.length) <= 2 && (x.includes(y) || y.includes(x))) return true
  const A = bigrams(x)
  const B = bigrams(y)
  if (!A.size || !B.size) return false
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return (2 * inter) / (A.size + B.size) >= 0.7
}

/**
 * 把逐帧结果并成一份：字幕优先，整帧里与字幕重复的丢掉，跨帧去重。
 * @param {Array<{t:number, band:Array<{text:string,conf:number}>, full:Array<{text:string,conf:number}>}>} perFrame
 * @returns {Array<{t:number, kind:'字幕'|'画面文字', text:string}>}
 */
export function mergeFrames(perFrame) {
  const kept = []
  // 同一句被不同预处理 / 不同帧读到多次：保留最早的时间，文字取置信度最高的那一版。
  const add = (t, kind, l) => {
    const text = l.text.replace(/\s+/g, ' ').trim()
    const hit = kept.find((k) => sameLine(k.text, text))
    if (!hit) { kept.push({ t, kind, text, conf: l.conf }); return }
    if (l.conf > hit.conf + 3) { hit.text = text; hit.conf = l.conf }
  }
  const frames = [...perFrame].sort((a, b) => a.t - b.t)
  for (const f of frames) {
    for (const l of f.band) add(f.t, '字幕', l)
    for (const l of f.full) add(f.t, '画面文字', l)
  }
  return kept.map(({ t, kind, text }) => ({ t, kind, text }))
}

function mmss(t) {
  const s = Math.max(0, Math.round(t))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** 排成给模型读的文字。封顶：行数、总字数。 */
export function formatOcr(items, { maxLines = 40, maxChars = 1500 } = {}) {
  const out = []
  let n = 0
  for (const it of items) {
    const line = `${mmss(it.t)} ${it.kind}：${it.text.slice(0, 80)}`
    if (out.length >= maxLines || n + line.length > maxChars) break
    out.push(line)
    n += line.length + 1
  }
  return { text: out.join('\n'), shown: out.length, total: items.length }
}

async function tess(det, file, psm, minConf, latinMin = 75) {
  const r = await run(det.bin, [file, 'stdout', '-l', det.lang, '--psm', psm, 'tsv'], {
    timeout: 40_000,
    env: { OMP_THREAD_LIMIT: '1' },
  })
  if (r.code !== 0) return []
  return parseTsv(r.out).filter((l) => plausible(l.text, l.conf, minConf, latinMin))
}

/** 用 ffmpeg 把一帧处理成更好认的图，成功返回输出路径。 */
async function prep(ffmpeg, file, tag, vf) {
  const out = `${file}.${tag}.png`
  const r = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', vf, out], { timeout: 20_000 })
  return r.code === 0 ? out : null
}

// 字幕几乎都是白字（或亮字）压在杂乱的画面上。直接认，背景的纹理会把字吃掉；
// 先只保留足够亮的像素、变成「白底黑字」再认，实测（Apex 预告片）字幕从全是噪声变成基本整句。
// 两个阈值各来一遍：高的干净、低的保细笔画，同一句由 mergeFrames 取置信度高的一版。
const BAND_THRESHOLDS = [225, 200]

/** 单帧：字幕带（亮字提取）+ 整帧（灰度拉对比）。 */
export async function ocrFrame({ file, t }, { det, ffmpeg }) {
  const jobs = BAND_THRESHOLDS.map(async (th) => {
    const img = await prep(ffmpeg, file, `b${th}`,
      `crop=iw:ih*0.24:0:ih*0.76,scale=iw*2:-2,format=gray,lut=y='if(gt(val,${th}),0,255)'`)
    return img ? tess(det, img, '6', 60) : []
  })
  const fullJob = (async () => {
    const img = await prep(ffmpeg, file, 'g', 'scale=iw*1.5:-2,format=gray,eq=contrast=1.4')
    return img ? tess(det, img, '11', 65, 60) : []
  })()
  const [bands, full] = await Promise.all([Promise.all(jobs), fullJob])
  return { t, band: bands.flat(), full }
}

/**
 * 对一批已经取好的帧做 OCR。
 * @param {Array<{file:string, t:number}>} frames
 * @param {{ffmpeg:string, det?:object, concurrency?:number}} o
 */
export async function ocrFrames(frames, o = {}) {
  const det = o.det ?? detectTesseract()
  if (!det.ok) return { ok: false, why: det.why, text: '', shown: 0, total: 0, frames: 0 }
  const conc = Math.max(1, Math.min(8, Number(o.concurrency ?? 4)))
  const queue = frames.map((f, i) => ({ ...f, i }))
  const results = new Array(frames.length)
  await Promise.all(
    Array.from({ length: Math.min(conc, queue.length) }, async () => {
      while (queue.length) {
        const f = queue.shift()
        try {
          results[f.i] = await ocrFrame(f, { det, ffmpeg: o.ffmpeg ?? 'ffmpeg' })
        } catch {
          results[f.i] = { t: f.t, band: [], full: [] }
        }
      }
    }),
  )
  const merged = mergeFrames(results.filter(Boolean))
  const fmt = formatOcr(merged, o)
  return { ok: true, why: det.why, ...fmt, frames: frames.length }
}
