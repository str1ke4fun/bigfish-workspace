/**
 * tools.js —— `her_tools`：先看见常用的，需要时自己找更多（2026-11-09）
 *
 * 她每一轮只常驻一小撮工具（core 那几个 + 当前面的常用动作）。其余工具
 * 不在上下文里，只在策略表的 catalog 里可发现。这个工具就是那扇门：
 *
 *   search   —— 看看当前面还有什么能打开（只列 deferred，已开着的不重复列）；
 *   describe —— 看一两个工具的说明（只给一句人话和参数名，不给 JSON schema）；
 *   load     —— 真的打开一组或几个（走 restrict.js 的 reveal，失败绝不假装成功）。
 *
 * 约束：
 *   - 只认当前面：别的面、宿主工具、不存在的名字一律由 tool-policy 拒绝；
 *   - 不改可见性之外的任何东西：发送闸、频率、permit、guard 原样执行；
 *   - 返回信封固定：成功 `{ok, data}`，失败 `{ok:false, code, message}`；
 *   - 投影不出现 JSON / 代码块，也不出现「他」——这是给她看的话。
 *
 * 零依赖：只用语言内置能力和本插件内的纯模块。
 */

import { toJsonSchema } from './toolschema.js'
import { registerTool } from './tool-result.js'

/** search 一次最多列几条。目录是提示，不是把整张表倒进上下文。 */
const MAX_SEARCH = 5
/** describe 一次最多讲几个。 */
const MAX_DESCRIBE = 2

const CATALOG_FAILED = '这里打不开工具目录'
const LOAD_FAILED_TEXT = '这条路上打不开'

function failure(code, message) {
  return { ok: false, code, message }
}

/** 当前面。判不出来就是 null，绝不默认成任何一个面。 */
function currentSurface(core, agent) {
  try {
    const s = core?.surface?.current?.(agent)
    return typeof s === 'string' && s ? s : null
  } catch {
    return null
  }
}

/** 读 agent 此刻的工具状态；没有 state（还没收窄过 / 未知会话）就是 null。 */
function currentState(core, agent) {
  try {
    return core?.tools?.state?.(agent) ?? null
  } catch {
    return null
  }
}

/** `allow` / `revealed` 现在实际是数组，但宿主版本变化时也可能是 Set。 */
function nameSet(value) {
  try {
    if (typeof value === 'string') return new Set([value])
    if (value && typeof value[Symbol.iterator] === 'function') {
      return new Set([...value].map((n) => String(n)))
    }
  } catch {
    /* 读不了就当空集合：只影响过滤，不影响安全边界 */
  }
  return new Set()
}

function safeCatalog(policy, surface, caps) {
  try {
    const list = policy?.catalog?.({ surface, caps })
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 按名字查策略条目：优先 describeEntry / entriesFor，再退回 catalog。 */
function policyEntry(policy, name, surface, caps) {
  try {
    const hit = policy?.describeEntry?.(name, surface)
    if (hit) return hit
  } catch {
    /* 继续用别的入口 */
  }
  let list = null
  try {
    list = policy?.entriesFor?.(surface)
  } catch {
    list = null
  }
  if (!Array.isArray(list)) {
    try {
      list = policy?.catalog?.({ surface, caps })
    } catch {
      list = null
    }
  }
  return Array.isArray(list) ? (list.find((e) => e?.name === name) ?? null) : null
}

/** 防御式读实时工具定义：`get(name, agent)` 和 `view(agent).visible.get(name)` 都试。 */
function liveTool(exec, name) {
  try {
    const tools = exec?.agent?.ctx?.tools
    if (!tools) return null
    try {
      const viaGet = tools.get?.(name, exec.agent)
      if (viaGet) return viaGet
    } catch {
      /* 换 view 那条路 */
    }
    try {
      const visible = tools.view?.(exec.agent)?.visible
      return visible?.get?.(name) ?? null
    } catch {
      return null
    }
  } catch {
    return null
  }
}

/**
 * JSON Schema 的结构关键字。用来区分「标准 schema 的根键」和「简写 DSL 的
 * 参数名」——`{ required:[...], additionalProperties:false }` 这种没有 properties
 * 的根对象，绝不能把 required / additionalProperties 当成参数名交给她。
 * `required` 单独放行：简写 DSL 里它也可能是一个参数名（值是对象时才算）。
 */
const SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'type', 'properties', 'required',
  'additionalProperties', 'patternProperties', 'propertyNames', 'items', 'prefixItems',
  'contains', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else',
  'title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly',
  'format', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
  'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'uniqueItems', 'minProperties',
  'maxProperties', 'dependencies', 'dependentRequired', 'dependentSchemas',
  'unevaluatedProperties', 'unevaluatedItems',
])

/** 简写 DSL：每一条的值都是对象（参数规格），且键不是 schema 结构关键字。 */
function looksLikeShorthand(p) {
  const keys = Object.keys(p)
  if (keys.length === 0) return false
  return keys.every((k) => {
    const v = p[k]
    const valueOk = v !== null && typeof v === 'object' && !Array.isArray(v)
    const keyOk = k === 'required' || !SCHEMA_KEYWORDS.has(k)
    return valueOk && keyOk
  })
}

/** 参数名列表：只取 schema 的属性名，绝不把 schema 本身交给她。 */
function paramNames(def) {
  try {
    const p = def?.parameters
    if (!p || typeof p !== 'object' || Array.isArray(p)) return []
    if (p.properties && typeof p.properties === 'object' && !Array.isArray(p.properties)) {
      return Object.keys(p.properties)
    }
    // 没有 properties / type 时才可能是简写 DSL；schema 根键不能当参数名。
    if (!p.type && looksLikeShorthand(p)) return Object.keys(p)
  } catch {
    /* 读不了就当没有参数 */
  }
  return []
}

/** 一句说明：取第一行/第一句，限长，避免把几百字的工具说明塞进投影。 */
function oneLine(text, max = 80) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const i = s.search(/[。！？!?\n]/)
  if (i >= 0) s = s.slice(0, i + 1)
  if (s.length > max) s = s.slice(0, max) + '…'
  return s
}

/** names 既接受数组，也接受用逗号/顿号/空白分开的一串；去重去空。 */
function parseNames(value) {
  let raw = []
  if (Array.isArray(value)) raw = value
  else if (typeof value === 'string') raw = value.split(/[,，、\s]+/)
  return [...new Set(raw.map((n) => String(n ?? '').trim()).filter(Boolean))]
}

/** 投影：模型真正读进上下文的那一小段。绝不抛。 */
function project(result, args) {
  try {
    const action = String(args?.action ?? '')
    if (!result || result.ok !== true) {
      const msg = String(result?.message ?? LOAD_FAILED_TEXT)
      if (action === 'load') return { text: `[没打开：${msg}]` }
      if (action === 'describe') return { text: `[说明] ${msg}` }
      return { text: `[工具] ${msg}` }
    }

    const data = result.data ?? {}
    if (action === 'search') {
      const items = Array.isArray(data.items) ? data.items : []
      if (items.length === 0) return { text: '[工具] 这里没有能打开的工具了。' }
      return {
        text: items
          .map((it, i) => (it.summary
            ? `[工具] ${i + 1}. ${it.name} — ${it.summary}`
            : `[工具] ${i + 1}. ${it.name}`))
          .join('\n'),
      }
    }

    if (action === 'describe') {
      const items = Array.isArray(data.items) ? data.items : []
      if (items.length === 0) {
        // 给了名字却一个都没留下：只回一句，不回显被拒绝的名字。
        const asked = parseNames(args?.names).length > 0
        return { text: asked ? '[说明] 这几样这里没有。' : '[说明] 没有说明要哪个工具。' }
      }
      // 说明来自实时工具定义，理论上可能夹着 schema 片段；投影里绝不出现 `{`。
      const clean = (s) => String(s ?? '').replace(/[{}]/g, '')
      return {
        text: items
          .map((it) => {
            const params = Array.isArray(it.params) && it.params.length
              ? `（参数：${it.params.map(clean).join('、')}）`
              : ''
            return `[说明] ${it.name}：${clean(it.summary) || '没有说明'}${params}`
          })
          .join('\n'),
      }
    }

    if (action === 'load') {
      const opened = Array.isArray(data.opened) ? data.opened.map((n) => String(n)) : []
      const head = data.already ? '[已经开着]' : '[已打开]'
      return { text: `${head} ${opened.length ? opened.join('、') : '好了'}` }
    }

    return { text: String(result?.message ?? '') }
  } catch {
    return { text: '[结果没能显示出来]' }
  }
}

/**
 * 注册 `her_tools`。
 *
 * @param {object} ctx 插件 context（需要 `ctx.tools.register`）
 * @param {{ core?: object, policy?: object, caps?: object }} [deps]
 *   core 是 fishCore；policy 是 tool-policy 的目录函数集合；caps 是当前面的能力。
 *   core 可能为 null（fishCore 没挂上）：这时所有调用都回 NO_SURFACE，不抛。
 * @returns {Function|object|undefined} 宿主给的注销函数，原样透传
 */
export function registerHerTools(ctx, { core, policy, caps = {} } = {}) {
  const def = {
    name: 'her_tools',
    description:
      '看看这里还能打开哪些工具，或者把需要的工具打开。' +
      'search=看看还有什么；describe=看一两个工具的说明；load=按组或按名字打开。' +
      '常用的工具一直在这儿，不用打开；只有目录里列出来的才需要 load。',
    parameters: toJsonSchema({
      action: {
        type: 'string',
        required: true,
        enum: ['search', 'describe', 'load'],
        description: 'search=看目录；describe=看说明；load=打开。',
      },
      query: {
        type: 'string',
        required: false,
        description: 'search 用：按名字、说明或组筛一下。',
      },
      group: {
        type: 'string',
        required: false,
        description: 'load 用：打开一整组。组名从 search 的结果里看。',
      },
      names: {
        type: 'array',
        required: false,
        items: { type: 'string' },
        description: 'describe 用：最多两个名字；load 用：要打开的工具名（只传这一个选择器）。',
      },
    }),
    async execute(args, exec) {
      const action = String(args?.action ?? '').trim()
      const agent = exec?.agent
      const surface = currentSurface(core, agent)
      if (!surface) return failure('NO_SURFACE', CATALOG_FAILED)

      if (action === 'search') {
        const open = nameSet(currentState(core, agent)?.allow)
        const query = String(args?.query ?? '').trim().toLowerCase()
        const items = []
        for (const entry of safeCatalog(policy, surface, caps)) {
          const name = typeof entry?.name === 'string' ? entry.name : ''
          if (!name || open.has(name)) continue
          const summary = String(entry?.summary ?? '')
          const group = String(entry?.group ?? '')
          if (query) {
            const hay = `${name} ${summary} ${group}`.toLowerCase()
            if (!hay.includes(query)) continue
          }
          items.push({ name, summary, group })
          if (items.length >= MAX_SEARCH) break
        }
        return { ok: true, data: { items } }
      }

      if (action === 'describe') {
        // 先按当前面过滤：只认策略表里、属于这个面的名字。宿主工具、别的面、
        // 不存在的名字一律跳过——绝不能拿它们去读实时工具表，否则会把宿主的
        // 说明和参数名带进她的上下文。
        const names = parseNames(args?.names)
          .filter((name) => policyEntry(policy, name, surface, caps) !== null)
          .slice(0, MAX_DESCRIBE)
        const items = names.map((name) => {
          const live = liveTool(exec, name)
          const entry = policyEntry(policy, name, surface, caps)
          const summary = oneLine(live?.description)
            || String(entry?.summary ?? '').trim()
            || '没有说明'
          return { name, summary, params: live ? paramNames(live) : [] }
        })
        return { ok: true, data: { items } }
      }

      if (action === 'load') {
        const open = nameSet(currentState(core, agent)?.allow)
        const group = String(args?.group ?? '').trim()
        const requested = parseNames(args?.names)

        let selector
        let already = []
        if (requested.length) {
          // 拆成「已经开着」和「还没开」：已开的直接回显，未开的照常打开，
          // 不能因为列表里混着一个已开的名字就把其余名字丢掉。
          already = requested.filter((n) => open.has(n))
          const pending = requested.filter((n) => !open.has(n))
          if (pending.length === 0) {
            return { ok: true, data: { opened: already, already: true } }
          }
          selector = { names: pending }
        } else if (group) {
          selector = { group }
        } else {
          return failure('LOAD_FAILED', LOAD_FAILED_TEXT)
        }

        // 先自己解析一遍目标：策略拒绝（别的面 / 宿主工具 / always / 未注册）
        // 就到此为止，绝不把坏名字送进 reveal。
        let targets = null
        try {
          targets = policy?.loadTargets?.({ surface, caps, hostNames: null, ...selector })
        } catch {
          targets = null
        }
        if (targets?.ok !== true) {
          return failure('LOAD_FAILED', targets?.why || LOAD_FAILED_TEXT)
        }

        const targetNames = Array.isArray(targets.names)
          ? targets.names.map((n) => String(n))
          : []

        let resolved = null
        try {
          resolved = core?.tools?.reveal?.(agent, targetNames)
        } catch (err) {
          resolved = { ok: false, why: String(err?.message ?? err).slice(0, 160) }
        }
        if (resolved?.ok !== true) {
          return failure('LOAD_FAILED', resolved?.why || LOAD_FAILED_TEXT)
        }

        const freshlyOpened = targetNames.length
          ? targetNames
          : (Array.isArray(resolved.added) ? resolved.added.map((n) => String(n)) : [])
        const opened = [...new Set([...already, ...freshlyOpened])]
        return {
          ok: true,
          data: already.length ? { opened, already: true } : { opened },
        }
      }

      return failure('LOAD_FAILED', '不认识这个动作')
    },
    project,
  }

  return registerTool(ctx, def, { core })
}
