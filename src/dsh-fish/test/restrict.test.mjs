/**
 * restrict.test.mjs —— 工具面收窄（2026-10-24）
 *
 * 为什么值得单独立测：这件事的全部价值在于「她真的看不见那 31 个工具」。
 * 一旦哪天宿主的 `restrict()` 改了签名、或者我们的名字写错一个字母，
 * 它会**静默失效**——她照样能看到 shell 和写文件，而我们以为收窄了。
 * 所以这里钉三件事：
 *   ① 清单里每个名字都必须是真实存在的工具（名字错＝当场抛错，不是悄悄地过）；
 *   ② 只对「她的屋子」那一个 agent 下手，别人的会话一个都不碰；
 *   ③ 结论必须分开报「注册了」与「真挂上了」，不许合并成一句“成功”。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FISH_TOOLS,
  HER_TOOLS,
  isHerAgent,
  registerToolRestrict,
  readRestrictState,
  describeRestrict,
  revealTools,
  getAgentToolState,
  resetAgentToolState,
} from '../lib/restrict.js'
import { resolveAllow } from '../lib/tool-policy.js'

/** 一个够用的假插件 ctx：能 on('agent/created')，也能被我们主动触发。 */
function fakeCtx() {
  const listeners = new Map()
  return {
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, [])
      listeners.get(ev).push(fn)
      return () => {
        const arr = listeners.get(ev) ?? []
        const i = arr.indexOf(fn)
        if (i >= 0) arr.splice(i, 1)
      }
    },
    emit(ev, payload) {
      for (const fn of listeners.get(ev) ?? []) fn(payload)
    },
    count(ev) {
      return (listeners.get(ev) ?? []).length
    },
  }
}

/** 一个够用的假 agent：cwd 决定它是不是她。 */
function fakeAgent(cwd, { withRestrict = true, withGuard = true } = {}) {
  const calls = []
  const tools = {}
  let disposed = 0
  if (withRestrict) {
    tools.restrict = (filter) => {
      calls.push(filter)
      // reveal 会先收回上一把刀再下新的；disposed 计数让测试能看见"真的先 dispose 了"。
      return () => { disposed += 1 }
    }
  }
  if (withGuard) {
    // guard 接一个同步函数，返回 undefined = 放行、返回字符串 = 拒绝（这是宿主的契约）
    tools.guard = (fn) => {
      guards.push(fn)
      return () => {}
    }
  }
  const guards = []
  return {
    calls,
    guards,
    get disposed() { return disposed },
    agent: {
      session: { header: { cwd } },
      ctx: { tools, effect: () => {} },
    },
  }
}

test('清单里她该有的工具都在，且不含危险口子', () => {
  // 十个是她自己的，外加 read_image（看图片/看视频画面都靠它）
  for (const name of ['growth_commit', 'her_recall', 'her_leave', 'bili_look', 'bili_watch', 'bili_speak', 'her_remind', 'her_reminders', 'her_remind_cancel', 'her_inbox', 'read_image']) {
    assert.ok(HER_TOOLS.includes(name), `清单里少了 ${name}`)
  }
  // 这几个一旦放进去，收窄就白做了
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'web_search', 'web_fetch', 'skill', 'subagent', 'workflow']) {
    assert.ok(!HER_TOOLS.includes(name), `清单里不该有 ${name}`)
  }
})

test('isHerAgent 只认她的屋子，不认别的目录', () => {
  const her = 'C:\\Users\\someone\\.dsh-fish\\home'
  assert.equal(isHerAgent({ session: { header: { cwd: her } } }, her), true)
  // 末尾斜杠不该影响判断（任何平台）
  assert.equal(isHerAgent({ session: { header: { cwd: `${her}\\` } } }, her), true)
  // 大小写不敏感是 Windows 文件系统的性质，macOS/Linux 区分大小写，别在那边硬要求
  if (process.platform === 'win32') {
    assert.equal(isHerAgent({ session: { header: { cwd: 'c:/users/someone/.dsh-fish/home/' } } }, her), true)
  }
  assert.equal(isHerAgent({ session: { header: { cwd: 'D:\\work\\my-project' } } }, her), false)
  // 拿不到 cwd 时一律不放行（宁可漏收窄，也不误伤别人的会话）
  assert.equal(isHerAgent({}, her), false)
  assert.equal(isHerAgent({ session: {} }, her), false)
})

test('isHerAgent 认屋子下面的子目录（B 站出门会话住在 home/bili）', () => {
  const her = 'C:\\Users\\someone\\.dsh-fish\\home'
  // 出门会话的工作区是 home/bili，cwd 是它的子目录——也是她
  assert.equal(isHerAgent({ session: { header: { cwd: `${her}\\bili` } } }, her), true)
  assert.equal(isHerAgent({ session: { header: { cwd: `${her}\\bili\\` } } }, her), true)
  // 只是名字前缀相同、并不是子目录：不认
  assert.equal(isHerAgent({ session: { header: { cwd: `${her}root` } } }, her), false)
  // 上一级：不认
  assert.equal(isHerAgent({ session: { header: { cwd: 'C:\\Users\\someone\\.dsh-fish' } } }, her), false)
})

test('只有她的 agent 被收窄，别人的会话一个都不碰', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\her-home', log: () => {} })

  const hers = fakeAgent('C:\\her-home')
  const mine = fakeAgent('D:\\work\\my-project')

  ctx.emit('agent/created', { agent: mine.agent })
  assert.equal(mine.calls.length, 0, '别人的会话不该被限制')

  ctx.emit('agent/created', { agent: hers.agent })
  assert.equal(hers.calls.length, 1, '她这条应该被限制一次')
  assert.deepEqual(hers.calls[0].allow, [...HER_TOOLS], '只写 allow，不在清单里的一律挡掉')
  assert.equal(hers.calls[0].deny, undefined, '不用 deny：宿主将来新增工具时 allow 会自动挡住它')
})

test('额外放行会并进 allow，且去重', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', extra: ['web_search', 'web_search', ' read_image '], log: () => {} })
  const hers = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: hers.agent })
  const allow = hers.calls[0].allow
  assert.ok(allow.includes('web_search'), '用户填的额外放行要生效')
  assert.equal(allow.filter((x) => x === 'web_search').length, 1, '同一名字不许重复')
  assert.equal(allow.filter((x) => x === 'read_image').length, 1, '原本就在清单里的不该被重复追加')
})

test('挂上了才算数：结论里 applied 必须 > 0', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })
  // 注册阶段：还没轮到任何 agent，不能说"已收窄"
  assert.equal(seen.applied, 0)
  assert.equal(seen.why, 'registered')

  ctx.emit('agent/created', { agent: fakeAgent('C:\\h').agent })
  assert.equal(seen.applied, 1, '真挂上之后 applied 要变成 1')
  assert.equal(seen.why, 'applied')
  assert.equal(seen.failed, '')
})

test('宿主不认 restrict 时必须报红，不许静默降级成“全部工具”', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  // 没有 restrict 方法的老版本宿主
  ctx.emit('agent/created', { agent: fakeAgent('C:\\h', { withRestrict: false }).agent })
  assert.equal(seen.ok, false)
  assert.match(seen.failed, /restrict/)
})

test('restrict 抛错（名字不存在/作用域不对）也要记下来', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  const bad = fakeAgent('C:\\h')
  bad.agent.ctx.tools.restrict = () => { throw new Error('unknown tool: growth_commit') }
  ctx.emit('agent/created', { agent: bad.agent })

  assert.equal(seen.ok, false)
  assert.match(seen.failed, /unknown tool/)
  assert.equal(seen.applied, 0)
})

test('关掉开关就一个都不动', () => {
  const ctx = fakeCtx()
  const off = registerToolRestrict(ctx, { herDir: 'C:\\h', enabled: false, log: () => {} })
  assert.equal(ctx.count('agent/created'), 0, '关掉时不该挂监听')
  assert.equal(typeof off, 'function')
  assert.equal(readRestrictState().why, 'disabled')
})

test('describeRestrict 的三种说法不能混', () => {
  assert.match(describeRestrict({ applied: 1 }), /已收窄（按面策略）/)
  assert.match(describeRestrict({ applied: 0 }), /等她的会话下一次启动/)
  assert.match(describeRestrict({ applied: 0, failed: 'requires a scoped context' }), /没挂上/)
  assert.doesNotMatch(describeRestrict({ applied: 0, failed: 'requires a scoped context' }), /已收窄/)
})

// ---------------------------------------------------------------------------
// 兜底守卫（guard）
//
// 为什么单独测：restrict 挡不住「注册在 agent 自己作用域里」的工具——宿主源码里
// own 层不经过 admits()。实测漏出来的就是 `subagent`，她可以借它派生一个拥有
// 全部工具的子 agent，等于一条现成的逃生通道。所以必须有一道 guard 在**执行时**拦。
// ---------------------------------------------------------------------------

test('guard 会拦住名单外的工具，放行名单内的', () => {
  const ctx = fakeCtx()
  registerToolRestrict(ctx, { herDir: 'C:\\h', log: () => {} })
  const a = fakeAgent('C:\\h')
  ctx.emit('agent/created', { agent: a.agent })

  assert.equal(a.guards.length, 1, '应该挂了一道 guard')
  const guard = a.guards[0]

  // 名单内：返回 undefined = 放行
  assert.equal(guard({ name: 'growth_commit' }), undefined)
  assert.equal(guard({ name: 'read_image' }), undefined)

  // 名单外：返回一句拒绝（不能是 undefined，也不能是 true）
  const denied = guard({ name: 'subagent' })
  assert.equal(typeof denied, 'string')
  assert.ok(denied.length > 0)

  // 拒绝话术里不许出现系统词汇——她要以为是自己做不了，不是以为被管理员拦了
  assert.doesNotMatch(denied, /权限|禁止|违规|不允许|没有授权/)
})

test('她自己 scope 里的工具挡不住这件事必须被记下（guard 缺席也不能算失败）', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  // 老宿主：有 restrict、没有 guard
  ctx.emit('agent/created', { agent: fakeAgent('C:\\h', { withGuard: false }).agent })

  assert.equal(seen.why, 'applied', 'restrict 挂上就是挂上了，不能因为缺 guard 就说没生效')
  assert.equal(seen.applied, 1)
  assert.equal(seen.guard, false, '但要如实记下没有兜底守卫')
})

test('guard 自己抛错也不许把 restrict 判成失败', () => {
  const ctx = fakeCtx()
  let seen = null
  registerToolRestrict(ctx, { herDir: 'C:\\h', onResult: (r) => { seen = r }, log: () => {} })

  const a = fakeAgent('C:\\h')
  a.agent.ctx.tools.guard = () => { throw new Error('guard not supported in this scope') }
  ctx.emit('agent/created', { agent: a.agent })

  assert.equal(seen.why, 'applied')
  assert.equal(seen.applied, 1)
  assert.equal(seen.guard, false)
})

test('restrict 因为「名字还没登记」抛错时：按交集再收一次，别整段放弃', () => {
  // 真机 2026-10-25 23:00 出现过一次：宿主先建了她的 agent，插件自己的工具
  // 还没在全局层登记完 → restrict 抛 `names unknown global tools growth_commit …`。
  // 旧实现整段进 catch，那一条会话全开。现在要求：捡回名单、按交集再收。
  const ctx = fakeCtx()
  const say = []
  const seen = []
  registerToolRestrict(ctx, { herDir: 'C:\h', log: (m) => say.push(m), onResult: (r) => seen.push(r) })

  const calls = []
  let first = true
  const guards = []
  const agent = {
    session: { header: { cwd: 'C:\h' } },
    ctx: {
      effect: () => {},
      tools: {
        restrict: (filter) => {
          calls.push(filter)
          if (first) {
            first = false
            throw new Error('tools.restrict() names unknown global tool "growth_commit"; known global tools: read, write, read_image, web_search')
          }
          return () => {}
        },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  ctx.emit('agent/created', { agent })

  assert.equal(calls.length, 2, '第一次失败后应该重试一次')
  assert.ok(calls[0].allow.includes('growth_commit'), '第一次用的还是完整清单')
  assert.deepEqual(calls[1].allow, ['read_image'], '第二次只用宿主真认识的名字')
  assert.equal(guards.length, 1, '兜底守卫要在（先挂的，不受 restrict 失败影响）')
  assert.ok(say.some((m) => m.includes('先按认识的 1 个收窄')), '要如实说出这次少收了几个')

  // 自愈之后，报告与实际生效的必须是同一份名单——否则自检会把「意图」当成「生效」。
  assert.deepEqual(seen.at(-1).allow, calls[1].allow, 'onResult.allow 必须是宿主真正接受的那份')
  const st = getAgentToolState(agent)
  assert.deepEqual(st.allow, ['read_image'], 'guard 读的 Set 也要同步成宿主真正接受的名单')
  assert.deepEqual(st.revealed, ['read_image'], 'revealed 同步为真正生效的名字')
  assert.equal(guards[0]({ name: 'growth_commit' }), '这件事我做不到。', '被自愈丢掉的工具必须真的调不动')
  assert.equal(guards[0]({ name: 'read_image' }), undefined)
})

test('restrict 一直失败时，兜底守卫仍然挂着（挡住 subagent 的那条路）', () => {
  const ctx = fakeCtx()
  const seen = []
  registerToolRestrict(ctx, { herDir: 'C:\h', log: () => {}, onResult: (r) => seen.push(r) })
  const guards = []
  const agent = {
    session: { header: { cwd: 'C:\h' } },
    ctx: {
      effect: () => {},
      tools: {
        restrict: () => { throw new Error('boom') },
        guard: (fn) => { guards.push(fn); return () => {} },
      },
    },
  }
  ctx.emit('agent/created', { agent })
  assert.equal(guards.length, 1, 'restrict 挂了，guard 也必须在')
  assert.equal(guards[0]({ name: 'subagent' }), '这件事我做不到。', '挡不住名字就靠执行时拦')
  assert.equal(guards[0]({ name: 'her_recall' }), undefined)
  assert.equal(seen.at(-1).why, 'failed', '如实报失败，不能假装成功')
})

// ---------------------------------------------------------------------------
// 按面策略 + 按需揭示（Task 6）
//
// 收窄从"一张静态清单"变成"每个面各自的可见集"；deferred 工具由 her_tools
// 调用 revealTools 打开。两条硬约束：
//   ① guard 和 restrict 必须读同一个 allowSet —— 否则刚揭示的工具"看得见、调不动"；
//   ② 重算 allow 之前必须先收回上一把 restrict，不能叠加。
// ---------------------------------------------------------------------------

test('按面解析 allow：web 不给 wx，wx 不给 bili', () => {
  const ctx = fakeCtx()
  const surface = { current: (a) => a.__surface ?? null }
  const policy = {
    resolveAllow: ({ surface: s }) => s === 'web' ? ['growth_commit', 'read_image'] : ['growth_commit', 'wx_peek'],
  }
  const off = registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  const web = fakeAgent('/her'); web.agent.__surface = 'web'
  const wx = fakeAgent('/her'); wx.agent.__surface = 'wx'
  ctx.emit('agent/created', { agent: web.agent })
  ctx.emit('agent/created', { agent: wx.agent })
  assert.deepEqual(web.calls.at(-1).allow.sort(), ['growth_commit', 'read_image'])
  assert.deepEqual(wx.calls.at(-1).allow.sort(), ['growth_commit', 'wx_peek'])
  off()
})

test('未知会话不默认成 web：面判定为 null 就不动它', () => {
  const ctx = fakeCtx()
  const surface = { current: () => null }
  const policy = { resolveAllow: () => ['growth_commit'] }
  const off = registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  const other = fakeAgent('/somewhere-else')
  ctx.emit('agent/created', { agent: other.agent })
  assert.equal(other.calls.length, 0, '判不出面时宁可不动，也不默认 web')
  off()
})

test('reveal 先 dispose 旧限制，再按并集重新 restrict；guard 放行新工具', () => {
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  let allow = ['growth_commit']
  const policy = {
    resolveAllow: () => allow,
    loadTargets: ({ names }) => names.includes('wx_see') ? { ok: true, names: ['wx_see'] } : { ok: false, why: '这条路上打不开' },
  }
  const a = fakeAgent('/her')
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })
  const beforeDisposed = a.disposed
  allow = ['growth_commit', 'wx_see']
  const r = revealTools(a.agent, ['wx_see'])
  assert.equal(r.ok, true)
  assert.equal(a.disposed, beforeDisposed + 1)
  assert.deepEqual(a.calls.at(-1).allow.sort(), ['growth_commit', 'wx_see'])
  assert.doesNotThrow(() => a.guards.at(-1)({ name: 'wx_see' })) // guard 用的同一个 Set 已更新
})

test('reveal 拒绝别的面/宿主工具/未注册名字，失败不改变 allow', () => {
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  const policy = {
    resolveAllow: () => ['growth_commit'],
    loadTargets: () => ({ ok: false, why: '这条路上打不开' }),
  }
  const a = fakeAgent('/her')
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })
  const before = a.calls.length
  const r = revealTools(a.agent, ['bili_look'])
  assert.equal(r.ok, false)
  assert.equal(a.calls.length, before)
})

test('reveal 把 state.hostNames 传给 loadTargets，重复 load 是幂等的', () => {
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  let seenHosts = null
  const policy = {
    resolveAllow: () => ['growth_commit'],
    loadTargets: ({ hostNames, names }) => { seenHosts = hostNames; return { ok: true, names } },
  }
  const a = fakeAgent('/her')
  a.agent.ctx.tools.view = () => ({ restrictableNames: new Set(['growth_commit', 'wx_see']) })
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })

  const r1 = revealTools(a.agent, ['wx_see', 'wx_see'])
  assert.equal(r1.ok, true)
  assert.ok(seenHosts instanceof Set, 'revealTools 必须把 hostNames 递下去')
  assert.ok(seenHosts.has('wx_see'))
  assert.deepEqual(r1.added, ['wx_see'])

  const callsBefore = a.calls.length
  const r2 = revealTools(a.agent, ['wx_see'])
  assert.equal(r2.ok, true, '重复 load 不是错误')
  assert.deepEqual(r2.added, [])
  assert.equal(a.calls.length, callsBefore, '没有新名字就不该重下 restrict')
})

test('revealed 计数：首次成功 reveal N 个新名字就增加 N', () => {
  const before = readRestrictState().revealed
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  const policy = {
    resolveAllow: ({ revealed }) => ['growth_commit', ...revealed],
    loadTargets: ({ names }) => ({ ok: true, names }),
  }
  const a = fakeAgent('/her')
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })

  const r = revealTools(a.agent, ['wx_see', 'wx_hear'])
  assert.equal(r.ok, true)
  assert.equal(readRestrictState().revealed, before + 2, '两个新名字应各计一次')
})

test('revealed 计数：重复 reveal、loadTargets 失败、restrict 失败都不增加', () => {
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  let restrictFails = false
  const policy = {
    resolveAllow: ({ revealed }) => ['growth_commit', ...revealed],
    loadTargets: ({ names }) => names.includes('wx_bad')
      ? { ok: false, why: '这条路上打不开' }
      : { ok: true, names },
  }
  const a = fakeAgent('/her')
  a.agent.ctx.tools.restrict = (filter) => {
    if (restrictFails) throw new Error('restrict 没挂上')
    a.calls.push(filter)
    return () => {}
  }
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })
  assert.equal(revealTools(a.agent, ['wx_see']).ok, true)
  const afterFirst = readRestrictState().revealed

  const repeated = revealTools(a.agent, ['wx_see'])
  assert.equal(repeated.ok, true)
  assert.equal(readRestrictState().revealed, afterFirst, '重复 reveal 已开的名字不计数')

  assert.equal(revealTools(a.agent, ['wx_bad']).ok, false)
  assert.equal(readRestrictState().revealed, afterFirst, 'loadTargets 拒绝不计数')

  restrictFails = true
  assert.equal(revealTools(a.agent, ['wx_hear']).ok, false)
  assert.equal(readRestrictState().revealed, afterFirst, 'restrict 失败回滚后不计数')
})

test('启动期宿主名单还没有自有工具时，自有工具仍要并进 allow（回归 I1）', () => {
  // 真实启动顺序：registerToolRestrict → bootstrapHome 建会话（agent/created 在此同步
  // 发出）→ 本插件才注册自己的工具。所以这一瞬间宿主 view 的 restrictableNames 里
  // **一个 FISH_TOOLS 都没有**。如果直接拿它过滤，她会静默地一个核心工具都调不动。
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  const hostNames = new Set(['read_image', 'wx_peek', 'wx_send', 'wx_context'])
  const a = fakeAgent('/her')
  a.agent.ctx.tools.view = () => ({ restrictableNames: new Set(hostNames) })
  registerToolRestrict(ctx, {
    herDir: '/her',
    surface,
    policy: { resolveAllow },
    caps: { hasImageRoute: true },
    enabled: true,
    log: () => {},
  })
  ctx.emit('agent/created', { agent: a.agent })

  const allow = a.calls.at(-1).allow
  // 当前面（wx）按策略仍常驻的自有工具，必须全部在 allow 里。
  for (const n of ['growth_commit', 'her_recall', 'her_leave', 'her_inbox', 'her_remind', 'her_reminders', 'her_remind_cancel']) {
    assert.ok(allow.includes(n), `自有工具 ${n} 不该被启动期名单滤掉`)
  }
  assert.ok(allow.includes('read_image'), '宿主确实注册了的工具照常放行')
  assert.ok(!allow.includes('bash'), '宿主名单之外的工具必须仍然被滤掉')

  // 方向性要求：并集只能加 ownTools 里的名字，其它名字仍然要被滤掉。
  const known = new Set([...hostNames, ...FISH_TOOLS])
  for (const n of allow) {
    assert.ok(known.has(n), `${n} 既不在宿主名单也不在自有工具里，不该出现`)
  }
})

test('getAgentToolState / resetAgentToolState 给 Task 7 和测试用', () => {
  const ctx = fakeCtx()
  const surface = { current: () => 'wx' }
  const policy = {
    resolveAllow: ({ revealed }) => revealed.has('wx_see') ? ['growth_commit', 'wx_see'] : ['growth_commit'],
    loadTargets: ({ names }) => ({ ok: true, names }),
  }
  const a = fakeAgent('/her')
  registerToolRestrict(ctx, { herDir: '/her', surface, policy, caps: {}, enabled: true })
  ctx.emit('agent/created', { agent: a.agent })

  const before = getAgentToolState(a.agent)
  assert.equal(before.surface, 'wx')
  assert.ok(before.allow.includes('growth_commit'))
  assert.deepEqual(before.revealed, [])

  revealTools(a.agent, ['wx_see'])
  const after = getAgentToolState(a.agent)
  assert.ok(after.allow.includes('wx_see'))
  assert.deepEqual(after.revealed, ['wx_see'])

  resetAgentToolState(a.agent)
  assert.equal(getAgentToolState(a.agent), null)
})
