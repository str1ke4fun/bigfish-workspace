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

/** 逗号 / 空白分隔的输入转数组；空数组样本靠输入本身判断数字。 */
export function parseList(text, sample) {
  const parts = String(text || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  // 空数组合法（默认 keywords / upMids 都是 []），不能靠 sample.every 判类型：
  // 空数组的 every 恒真，会把关键词全变成 NaN。退一步看这一次输入本身像不像数字。
  const sampleNumeric = Array.isArray(sample) && sample.length > 0 && sample.every((x) => typeof x === 'number')
  const numeric = sampleNumeric || (parts.length > 0 && parts.every((x) => /^-?\d+(\.\d+)?$/.test(x)))
  return numeric ? parts.map(Number) : parts
}

/** 状态点 + 可选文字；文字始终在 `status-text` 里，不单独靠颜色表意。 */
export function statusDot(level = '', text = '') {
  const dot = el('span', { class: 'dot' + (level ? ' ' + level : '') })
  if (text) dot.append(el('span', { class: 'status-text', text }))
  return dot
}

/** “人工代操作”标记。 */
export function humanChip() {
  return el('span', { class: 'chip human', text: '人工' })
}

/**
 * 分段控件。`set(id)` 只切选中态，不触发 onChange；
 * 用户点击才回调，避免程序化切换时重复请求。
 */
export function segment(items, { value, onChange, label = '' } = {}) {
  const root = el('div', { class: 'segment', role: 'tablist', 'aria-label': label })
  const buttons = new Map()
  const set = (id) => {
    for (const [key, btn] of buttons) {
      const on = key === id
      btn.className = 'tab' + (on ? ' on' : '')
      btn.setAttribute('aria-selected', on ? 'true' : 'false')
    }
  }
  for (const item of items) {
    const btn = el('button', {
      class: 'tab',
      type: 'button',
      role: 'tab',
      text: item.label,
      onclick: () => {
        set(item.id)
        onChange?.(item.id)
      },
    })
    buttons.set(item.id, btn)
    root.append(btn)
  }
  set(value ?? items[0]?.id)
  return { root, set }
}

/** 空态：一句话说明“还没有 / 这是起点，不是故障”。 */
export function emptyState(text) {
  return el('div', { class: 'empty-state', text })
}

/** 打开 8710 她的界面；成功返回地址，失败把原因交回页面。 */
export async function openHer() {
  const r = await local('/api/her/open')
  if (!r.ok || !r.data?.url) {
    return { ok: false, error: r.error || r.data?.error || '没拿到地址' }
  }
  window.open(r.data.url, '_blank')
  return { ok: true, url: r.data.url }
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
