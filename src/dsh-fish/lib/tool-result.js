/**
 * tool-result.js —— 工具返回契约：完整结果给宿主，投影给模型
 *
 * 一次工具调用会产出两样东西：
 *   1. 完整返回对象：宿主、台账、后续事件流都能看到全貌（大结果不在这里裁剪）；
 *   2. 模型投影：模型真正读进上下文的那一小段话（`PROJECTION`）。
 *
 * 两份必须分离，原因有二：
 *   - 投影里能写「已翻到第 3 条，编号 1=ev_xxx」这种只有模型需要的话；
 *   - 完整结果可以留给宿主审计，不必为了省 token 把数据砍掉。
 *
 * 约束（改这里之前先读）：
 *   - 包装器绝不能往工具路径里抛新错：`execute` 里算投影全部 try/catch；
 *   - `wrapTool` 只处理返回**对象**的工具；返回字符串的旧工具用 `wrapRenderOnly`，
 *     返回值类型不变，投影推迟到 render 时算；
 *   - `Object.defineProperty` 对 null / 原始值 / 冻结对象会抛，挂投影前必须判断。
 *
 * 零依赖：这个文件只用语言内置能力。
 */

/** 模型投影挂在完整结果上的符号（不可枚举，序列化时不会出现）。 */
export const PROJECTION = Symbol('fish.projection')
/** 调用元数据（开始时间等），同样是不可枚举旁路。 */
export const CALL_META = Symbol('fish.callMeta')

const FALLBACK_TEXT = '[结果没能显示出来]'
const UNKNOWN_ERROR_TEXT = '没做成，再试一次'

/**
 * 预期失败（不是程序 bug）。工具抛它时，message 是**给模型看的人话**，
 * 不是内部诊断信息；`projectError` 不认识它也会原样保留。
 */
export class ToolError extends Error {
  constructor(code, modelText, { cause } = {}) {
    super(modelText, cause === undefined ? undefined : { cause })
    this.name = 'ToolError'
    this.code = code
  }
}

const KNOWN_ERROR_TEXT = {
  WX_NOT_ALLOWED: '这个会话不在能说话的名单里',
  WX_UNCONFIRMED: '没看到回执，可能没发出去',
  BILI_COOLDOWN: '今天说得够多了',
  REMIND_EXPIRED: '这条提醒已经过期了',
}

/**
 * 把错误翻成一句能进上下文的人话。
 *
 * 只按 `err.code` 查表，**绝不拼 `err.message`**——底层错误消息里可能夹着
 * cookie、token、文件路径这些不该被模型看见的东西。
 */
export function projectError(err) {
  const code = err?.code
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_ERROR_TEXT, code)) {
    return KNOWN_ERROR_TEXT[code]
  }
  return UNKNOWN_ERROR_TEXT
}

/**
 * 通用返回信封 schema。刻意**不写 `required`**：大量既有工具返回 `{ ok: false }`
 * 之外还带各自字段，甚至有不带 `ok` 的；一旦 required 了 `ok`，宿主会在
 * `project` 运行前就把结果打回，包装器反而弄坏了本来能用的工具。
 */
export function universalOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      code: { type: 'string' },
      message: { type: 'string' },
    },
    additionalProperties: true,
  }
}

function isExtensibleObject(value) {
  return value !== null && typeof value === 'object' && Object.isExtensible(value)
}

/** 算投影；`project` 缺失或抛错都退回一句安全的话。 */
function safeProject(project, result, args, view) {
  try {
    if (typeof project === 'function') {
      const projection = project(result, args, view)
      if (projection && typeof projection === 'object') return projection
    }
  } catch {
    return { text: FALLBACK_TEXT }
  }
  return { text: String(result ?? '') }
}

function viewOf(core, agent) {
  let surface = null
  try {
    surface = core?.surface?.current?.(agent) ?? null
  } catch {
    // 面判定出问题只影响投影措辞，不能让工具调用失败。
    surface = null
  }
  return Object.freeze({
    surface,
    sessionId: agent?.id ?? '',
    now: Date.now(),
    imageRoute: true,
  })
}

/**
 * 把投影渲染成 content blocks。
 *
 * `handles` 是「模型可以翻回去的编号」：正文里只写一次内容，末尾附一行
 * `（编号：1=ev_1）`。空投影也要给一句兜底文本，绝不能返回空数组——
 * 空 content 会让宿主把一次成功调用显示成空消息。
 */
export function renderProjection(projection) {
  try {
    const source = projection && typeof projection === 'object' ? projection : {}
    const blocks = Array.isArray(source.blocks) ? source.blocks : []
    const handles = Array.isArray(source.handles) ? source.handles : []
    const text = source.text == null ? '' : String(source.text)
    const footer = handles.length
      ? '\n（编号：' + handles.map((h) => `${h?.label}=${h?.value}`).join('，') + '）'
      : ''
    if (blocks.length === 0 && handles.length === 0 && text === '') {
      return [{ type: 'text', text: FALLBACK_TEXT }]
    }
    return [...blocks, { type: 'text', text: text + footer }]
  } catch {
    return [{ type: 'text', text: FALLBACK_TEXT }]
  }
}

/**
 * 包装返回**对象**的工具：
 *   - `execute` 在拿到完整结果后算一次投影，挂在 `PROJECTION` 上；
 *   - `output.render` 只读那份投影，不再调用 `project`；
 *   - 出错统一翻成 `ToolError`（原始 `err.message` 不外泄）。
 *
 * 不修改入参 `def`。`def.project` 收到的是原始返回值（不是包装后的信封）。
 */
export function wrapTool(def, { core } = {}) {
  const base = def ?? {}
  const output = base.output ?? {}
  const schema = base.outputSchema ?? output.schema ?? universalOutputSchema()

  const wrapped = {
    ...base,
    output: {
      ...output,
      schema,
      render: (args, result) => {
        // 结果不是可扩展对象时 execute 挂不上符号，这里现算一次。
        const projection = result?.[PROJECTION] ?? safeProject(base.project, result, args, viewOf(core))
        return renderProjection(projection)
      },
    },
    execute: async (args, exec) => {
      const startedAt = Date.now()
      let result
      try {
        result = await base.execute?.(args, exec)
      } catch (err) {
        if (err instanceof ToolError) throw err
        throw new ToolError('TOOL_FAILED', projectError(err), { cause: err })
      }

      let projection
      try {
        projection = safeProject(base.project, result, args, viewOf(core, exec?.agent))
      } catch {
        projection = { text: FALLBACK_TEXT }
      }

      // null / 原始值 / 冻结对象上 defineProperty 会抛；工具路径抛错是这里最不能引入的事。
      if (isExtensibleObject(result)) {
        try {
          Object.defineProperty(result, PROJECTION, { value: projection, enumerable: false })
          Object.defineProperty(result, CALL_META, { value: { startedAt }, enumerable: false })
        } catch {
          // 代理对象之类拒绝挂属性：保持返回原样，render 会现算。
        }
      }
      return result
    },
  }

  return wrapped
}

/**
 * 包装返回字符串（或任意原始值）的旧工具：
 *   - `execute` 与返回值类型原样保留；
 *   - `output.schema` 不改；
 *   - 只替换 `render`，投影在 render 时算一次。
 */
export function wrapRenderOnly(def, { core } = {}) {
  // core 目前用不上：旧工具的 render 拿不到 agent，面信息固定为空。
  void core
  const base = def ?? {}
  const output = base.output ?? {}
  const wrapped = {
    ...base,
    output: {
      ...output,
      // 旧工具没有 exec 元数据可用，面信息固定为空：投影只该用到返回值本身。
      render: (args, result) =>
        renderProjection(safeProject(base.project, result, args, {
          surface: null,
          sessionId: '',
          now: Date.now(),
          imageRoute: true,
        })),
    },
  }
  return wrapped
}

/** 注册工具：包装后交给宿主，返回的注销函数原样透传。 */
export function registerTool(ctx, def, { core } = {}) {
  const wrapped = wrapTool(def, { core })
  return ctx.tools.register(wrapped)
}
