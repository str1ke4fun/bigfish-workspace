/**
 * ocr-complete.js —— 用消息区 OCR 补全侧栏截断的 @ 预览。
 *
 * 侧栏预览被微信截成「…」，整屏树又慢一拍。这里只做纯文本/几何判断：
 * 从 OCR 行里找到和预览开头对得上的那一行，再按行距把同一条气泡的后续行拼起来。
 * 是否真的用 OCR 结果，由调用方再比一次长度；匹配不上就原样返回。
 */

/** 只留文字和数字，忽略空白、标点、符号，用来判断「开头是不是同一句」。 */
export function compactText(text) {
  return String(text ?? '')
    .replace(/(?:…|\.{3,})/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
}

/** 预览正文是否像 OCR 行的开头；取前 10 个有效字符，允许 OCR 在行首多读一两个符号。 */
export function ocrStartsWith(preview, candidate, chars = 10) {
  const a = compactText(preview)
  const b = compactText(candidate)
  if (!a || !b) return false
  const head = a.slice(0, Math.min(chars, a.length))
  const at = b.indexOf(head)
  return at >= 0 && at <= 6
}

/**
 * 从 `index` 这行开始，把同一条气泡的后续 OCR 行拼起来。
 *
 * 停止条件：与上一行底部间隔超过中位行高的 1.4 倍，或下一行明显左移
 * （例如另一列的时间/系统提示）。返回原始 OCR 文本（保留标点），
 * 行与行之间不加空格；中文 OCR 的分词空格交给调用方再压。
 */
export function joinOcrBubble(lines, index) {
  const list = Array.isArray(lines) ? lines : []
  const start = list[index]
  if (!start) return { text: '', lines: [] }
  const heights = list
    .map((line) => Number(line?.height) || 0)
    .filter((height) => height > 0)
    .sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)] || 16
  const picked = [start]
  let bottom = Number(start.top) + (Number(start.height) || median)
  for (let i = index + 1; i < list.length; i += 1) {
    const line = list[i]
    const top = Number(line?.top)
    const height = Number(line?.height) || median
    if (!Number.isFinite(top)) continue
    // 同一条气泡内的 OCR 行通常紧挨着甚至框重叠；超过 ~10px 就是下一条消息了。
    if (top - bottom > Math.max(9, median * 0.6)) break
    if (Number(line?.left) + (Number(line?.width) || 0) < Number(start.left) - median) break
    picked.push(line)
    bottom = top + height
  }
  const text = picked.map((line) => String(line?.text ?? '').trim()).filter(Boolean).join('')
  return { text, lines: picked }
}

/**
 * 从 OCR 行里挑出最像预览正文的一条，并拼回整条气泡。
 * 优先取最下面的一条（新消息在底部）；拼出来的正文必须比预览长才采用。
 */
export function completeFromOcrLines(preview, lines, { chars = 8 } = {}) {
  const list = Array.isArray(lines) ? lines : []
  const body = String(preview ?? '')
  if (!body) return ''
  let index = -1
  for (let i = 0; i < list.length; i += 1) {
    if (ocrStartsWith(body, list[i]?.text, chars)) index = i
  }
  if (index < 0) return ''
  let joined = joinOcrBubble(list, index).text
  if (!joined) return ''
  // OCR 可能在行首多读一两个符号（`N @…`、`. @…`）；预览以 @ 开头时从 @ 切。
  if (String(body).trim().startsWith('@')) {
    const at = joined.indexOf('@')
    if (at > 0 && at <= 8) joined = joined.slice(at)
  }
  joined = joined
    .replace(/^[^\p{L}\p{N}@]+/u, '')
    .replace(/\s+([，。！？；：、,.!?;:])/g, '$1')
    .trim()
  return compactText(joined).length > compactText(body).length ? joined : ''
}
