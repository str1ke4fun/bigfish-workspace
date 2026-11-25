/**
 * host-cua-detail.js —— 宿主 CUA 的纯策略：看多少 / 能不能输入
 *
 * 不碰进程、不碰 I/O；只回答三个问题：
 *   - 这个应用能看多少（full/structure/image/none）；
 *   - 这个应用能不能点/输入（allow/deny）；
 *   - 这个注册路径是不是桌宠落盘的稳定目录。
 *
 * 零依赖，纯函数，便于单测。
 */

export const HOST_CUA_DETAILS = Object.freeze(['full', 'structure', 'image', 'none'])
export const HOST_CUA_INPUTS = Object.freeze(['allow', 'deny'])

/** 进程名归一：trim、去 .exe、小写。 */
export function normalizeAppKey(app) {
  return String(app ?? '').trim().replace(/\.exe$/i, '').toLowerCase()
}

/** 把 { 'Code.exe': 'full' } 归一成 { code: 'full' }。坏值保留给解析层判断。 */
function normalizeMap(map) {
  const out = {}
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out
  for (const [key, value] of Object.entries(map)) {
    const norm = normalizeAppKey(key)
    if (norm) out[norm] = value
  }
  return out
}

/** 这个应用能看多少。未配置/坏值退回 defaultDetail（默认 structure）。 */
export function resolveDetail(app, config = {}) {
  const key = normalizeAppKey(app)
  const detail = normalizeMap(config?.detail)
  const picked = detail[key]
  if (HOST_CUA_DETAILS.includes(picked)) return picked
  const fallback = String(config?.defaultDetail ?? '')
  return HOST_CUA_DETAILS.includes(fallback) ? fallback : 'structure'
}

/** 这个应用能不能输入。未配置/坏值退回 defaultInput（默认 deny）。 */
export function resolveInput(app, config = {}) {
  const key = normalizeAppKey(app)
  const input = normalizeMap(config?.input)
  const picked = input[key]
  if (HOST_CUA_INPUTS.includes(picked)) return picked
  const fallback = String(config?.defaultInput ?? '')
  return HOST_CUA_INPUTS.includes(fallback) ? fallback : 'deny'
}

/** 桌宠上报的路径只认 ...\bigfish\host-cua\<version>\cua-driver.exe。 */
export function isStableDriverPath(winPath) {
  const s = String(winPath ?? '').trim()
  return /(?:^|[\\/])bigfish[\\/]host-cua[\\/][^\\/]+[\\/]cua-driver\.exe$/i.test(s)
}

/** structure 模式下保留 label 的控制角色；其余角色只留结构/位置/token。 */
const CONTROL_ROLES = new Set([
  'button', 'tab', 'menuitem', 'checkbox', 'radio', 'link', 'toolbar', 'list', 'scrollbar',
])

function redactText(text) {
  const s = typeof text === 'string' ? text : ''
  return s ? `[text:${s.length}]` : ''
}

/**
 * structure 脱敏：控制角色的 label 保留；其它 label 与所有 value 换成 [text:N]。
 * frame / element_token 原样保留，因为点击要靠它们。
 */
export function redactElements(elements) {
  if (!Array.isArray(elements)) return []
  const out = []
  for (const el of elements) {
    if (!el || typeof el !== 'object') continue
    const role = String(el.role ?? '')
    const label = typeof el.label === 'string' ? el.label : ''
    const value = typeof el.value === 'string' ? el.value : ''
    const row = {
      role,
      label: CONTROL_ROLES.has(role.toLowerCase()) ? label : redactText(label),
      value: redactText(value),
      frame: el.frame ?? null,
      element_token: String(el.element_token ?? el.elementToken ?? ''),
    }
    if (el.parent_index !== undefined) row.parent_index = el.parent_index
    out.push(row)
  }
  return out
}
