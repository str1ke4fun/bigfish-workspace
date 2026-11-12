// 页面共用的小工具。
//
// 规矩：页面只用 DOM 节点 + textContent 拼内容，不拼 HTML 字符串。
// 上游给的所有文本（评论、日记、微信消息、工具返回）都可能是别人写的，
// 一律当文本摆进来，不经过 innerHTML。

export function $(sel, root = document) {
  return root.querySelector(sel)
}

export function setDot(node, level) {
  if (!node) return
  node.className = 'dot' + (level ? ' ' + level : '')
}

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
    else node.setAttribute(key, String(value))
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return node
}

export function clear(node) {
  if (node) node.replaceChildren()
  return node
}

export function hint(text, cls = 'meta') {
  return el('div', { class: cls, text })
}

/** 页面里的卡片：标题 + 一块内容区 + 一块状态行。 */
export function card(title, { note = '', right = null } = {}) {
  const dot = el('span', { class: 'dot' })
  const label = el('span', { class: 'meta' })
  const body = el('div', { class: 'card-body' })
  const status = el('div', { class: 'meta card-status' })
  const head = el('h2', {}, dot, title, label)
  const root = el('section', { class: 'card' }, head, note ? hint(note, 'meta card-note') : null, body, status)
  return {
    root,
    body,
    status,
    dot,
    label,
    right,
    setMeta(text, level = '') {
      label.textContent = text || ''
      setDot(dot, level)
    },
    setStatus(text, level = '') {
      status.textContent = text || ''
      status.className = 'meta card-status' + (level ? ' ' + level : '')
    },
  }
}

/** 用 fail 状态显示一条读不到的原因；上游错误原样透出，不白屏。 */
export function errorText(result) {
  if (!result) return '没读到'
  const code = result.error || `HTTP ${result.status}`
  const up = result.data?.upstreamStatus ? `（上游 ${result.data.upstreamStatus}）` : ''
  return `读不到：${code}${up}`
}

/** 写失败时说「没成」，不说「读不到」——上游 409/400 的正文也带出来。 */
export function writeError(result) {
  if (!result) return '没成：没拿到响应'
  const reason = result.data?.error || result.data?.why || result.data?.note || result.error || `HTTP ${result.status}`
  const up = result.data?.upstreamStatus ? `（上游 ${result.data.upstreamStatus}）` : ''
  return `没成：${reason}${up}`
}

/**
 * 取 `/api/fish/*`。返回 { ok, status, data, error }。
 * `ok` 只表示 HTTP 成功；业务结论在 `data.ok` / `data.code`，别混成一个。
 * JSON 以外的响应（下载类）请直接用 fetch。
 */
export async function fish(path, opts = {}) {
  let r
  try {
    r = await fetch('/api/fish/' + path, {
      headers: { accept: 'application/json' },
      ...opts,
    })
  } catch {
    return { ok: false, status: 0, data: null, error: '工作台连不上' }
  }
  const ct = r.headers.get('content-type') || ''
  if (ct.includes('json')) {
    let data = null
    try { data = await r.json() } catch { data = null }
    return {
      ok: r.ok,
      status: r.status,
      data,
      error: data?.error || (r.ok ? '' : `HTTP ${r.status}`),
    }
  }
  return { ok: r.ok, status: r.status, data: null, error: r.ok ? '' : `HTTP ${r.status}` }
}

export async function postFish(path, body) {
  return fish(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
}

/** 取工作台自己的接口（QQ/微信/她/动作日志）。 */
export async function local(path, opts = {}) {
  try {
    const r = await fetch(path, opts)
    const ct = r.headers.get('content-type') || ''
    if (!ct.includes('json')) return { ok: r.ok, status: r.status, data: null, error: r.ok ? '' : `HTTP ${r.status}` }
    const data = await r.json()
    return { ok: r.ok && data?.error === undefined, status: r.status, data, error: data?.error || '' }
  } catch {
    return { ok: false, status: 0, data: null, error: '工作台连不上' }
  }
}

export function fmtTime(value) {
  if (!value) return '—'
  const t = new Date(value)
  if (!Number.isFinite(t.getTime())) return String(value).slice(0, 16)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

export function clock() {
  return new Date().toLocaleTimeString('zh-CN')
}

/** 把任意值摆成一段可读文本（对象走 JSON，别塞 [object Object]）。 */
export function asText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

/** 一次性填一组统计格。 */
export function fillStats(node, rows) {
  clear(node)
  for (const [k, v, title] of rows) {
    const dd = el('dd', { text: v === undefined || v === null || v === '' ? '—' : String(v) })
    if (title) dd.title = title
    node.append(el('div', {}, el('dt', { text: k }), dd))
  }
  return node
}
