/**
 * tools.test.mjs —— 工具注册的形状守门
 *
 * 为什么单独一个文件（2026-10-25）：
 *   用全新 profile 从 tarball 装一遍才发现，npm 装进来的插件真实路径在
 *   `<profile>/node_modules/dsh-fish/`，往上能找到宿主的 `@deepseek-ai/dsh-tools`，
 *   于是 `defineTool` 真的被调用——它期待「简写 DSL 属性表」，我们传的是完整
 *   JSON Schema，编译时把根上的 `type:'object'` 当成一个叫 type 的参数，报
 *     unsupported JSON schema: parameters.type must be a value schema object
 *   → 6 个工具全部注册失败。本机是 link: 装的，往上找不到那个包，走兜底，所以
 *   这条 bug 只会在别人装了之后出现。
 *
 * 这里守三件事：
 *   1. lib/ 里不许再 import 宿主的 dsh-tools；
 *   2. `defineTool(spec)` 就是恒等（注册时直接交 JSON Schema）；
 *   3. 十个工具定义都长成宿主认的形状（parameters 是 object-rooted JSON Schema、
 *      output.schema 也是、render / execute 是函数）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import { defineTool } from '../lib/tool.js'
import { registerCapture } from '../lib/capture.js'
import { registerLetter } from '../lib/letter.js'
import { registerLook } from '../lib/look.js'
import { registerRecall } from '../lib/recall.js'
import { registerRemind } from '../lib/remind.js'
import { registerInbox } from '../lib/taskinbox.js'
import { registerSpeak } from '../lib/speak.js'
import { registerWatch } from '../lib/watch.js'
import { registerHerTools } from '../lib/tools.js'
import { HER_TOOLS } from '../lib/restrict.js'
import { runChecks } from '../lib/selfcheck.js'

const LIB = fileURLToPath(new URL('../lib/', import.meta.url))
const ROOT = join(tmpdir(), 'dsh-fish-tools-test')

function fakeCtx() {
  const defs = []
  return {
    defs,
    tools: {
      register(d) {
        defs.push(d)
        return () => {}
      },
    },
  }
}

test('lib/ 里不再 import 宿主的 dsh-tools', () => {
  const hits = []
  for (const f of readdirSync(LIB)) {
    if (!f.endsWith('.js')) continue
    const s = readFileSync(join(LIB, f), 'utf8')
    // 注释里可以提这个名字（tool.js 就在解释为什么不用它），但代码里不许出现
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    if (/@deepseek-ai\/dsh-tools/.test(code)) hits.push(f)
  }
  assert.deepEqual(hits, [], '这些文件又把宿主的 dsh-tools import 回来了')
})

test('defineTool 是恒等：不编译、不改写', () => {
  const spec = { name: 'x', parameters: { type: 'object', properties: {} } }
  assert.equal(defineTool(spec), spec)
})

test('十一个工具定义都长成宿主认的形状', () => {
  const ctx = fakeCtx()
  const deps = { root: ROOT, log: () => {} }
  registerCapture(ctx, deps)
  registerLetter(ctx, deps)
  registerLook(ctx, deps)
  registerRecall(ctx, deps)
  registerRemind(ctx, deps)
  registerSpeak(ctx, deps)
  registerWatch(ctx, deps)
  registerInbox(ctx, deps)
  registerHerTools(ctx, {
    core: { surface: { current: () => 'wx' }, tools: { reveal() {} } },
    policy: { catalog: () => [], loadTargets: () => ({ ok: false, names: [], why: '这儿打不开' }) },
  })

  assert.equal(ctx.defs.length, 11, '我们自己的工具是 11 个（外加宿主的 read_image）')
  // 工具清单是这张测试自己的事实来源。B 站 3 个从 A1.4 起不再属于 FISH_TOOLS
  // （它们是贡献条目），所以这里按完整的 10 个名字断言，而不是查 FISH_TOOLS。
  const expected = [
    'growth_commit', 'her_recall', 'her_leave',
    'bili_look', 'bili_watch', 'bili_speak',
    'her_remind', 'her_reminders', 'her_remind_cancel', 'her_inbox', 'her_tools',
  ]
  const names = ctx.defs.map((d) => d.name)
  assert.deepEqual([...names].sort(), [...expected].sort())

  for (const d of ctx.defs) {
    assert.equal(typeof d.name, 'string')
    assert.ok(d.description.length > 10, `${d.name} 的说明太短`)
    // parameters：根级 object JSON Schema（不是简写 DSL）
    assert.equal(d.parameters?.type, 'object', `${d.name}.parameters 根级必须是 object`)
    assert.equal(typeof d.parameters.properties, 'object', `${d.name}.parameters.properties 缺失`)
    assert.ok(!('required' in d.parameters) || Array.isArray(d.parameters.required))
    // output：宿主 registry 会校验它
    assert.equal(d.output?.schema?.type, 'object', `${d.name}.output.schema 根级必须是 object`)
    assert.equal(typeof d.output.render, 'function', `${d.name}.output.render 必须是函数`)
    assert.equal(typeof d.execute, 'function', `${d.name}.execute 必须是函数`)
  }
})

test('Task 4 工具说明是世界声，参数键、类型、枚举和必填集合固定', () => {
  const ctx = fakeCtx()
  const deps = { root: ROOT, log: () => {} }
  registerCapture(ctx, deps)
  registerRecall(ctx, deps)
  registerLetter(ctx, deps)
  registerRemind(ctx, deps)
  registerInbox(ctx, deps)
  registerHerTools(ctx, {
    core: { surface: { current: () => 'wx' }, tools: { reveal() {} } },
    policy: { catalog: () => [], loadTargets: () => ({ ok: false, names: [], why: '这儿打不开' }) },
  })

  const shapes = Object.fromEntries(ctx.defs
    .filter((d) => ['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'her_inbox', 'her_remind', 'her_reminders', 'her_remind_cancel'].includes(d.name))
    .map((d) => [d.name, {
      keys: Object.keys(d.parameters.properties),
      required: d.parameters.required ?? [],
      types: Object.fromEntries(Object.entries(d.parameters.properties).map(([k, v]) => [k, v.type])),
      enums: Object.fromEntries(Object.entries(d.parameters.properties)
        .filter(([, v]) => Array.isArray(v.enum))
        .map(([k, v]) => [k, v.enum])),
      personKeys: Object.keys(d.parameters.properties.person?.properties ?? {}),
    }]))

  assert.deepEqual(shapes, {
    growth_commit: {
      keys: ['type', 'text', 'refs', 'verdict', 'confidence', 'person', 'supersedes', 'revokes', 'flags'],
      required: ['type', 'text'],
      types: {
        type: 'string', text: 'string', refs: 'array', verdict: 'string', confidence: 'number',
        person: 'object', supersedes: 'array', revokes: 'array', flags: 'array',
      },
      enums: {
        type: ['utterance', 'revise', 'reunion', 'narration', 'refusal', 'person_note', 'diary'],
        verdict: ['confirmed', 'refuted', 'refined'],
      },
      personKeys: ['id', 'name', 'label', 'channel', 'chatId', 'kind', 'confidence'],
    },
    her_recall: {
      keys: ['query', 'days'], required: ['query'], types: { query: 'string', days: 'number' }, enums: {}, personKeys: [],
    },
    her_leave: {
      keys: ['text'], required: ['text'], types: { text: 'string' }, enums: {}, personKeys: [],
    },
    her_tools: {
      keys: ['action', 'query', 'group', 'names'],
      required: ['action'],
      types: { action: 'string', query: 'string', group: 'string', names: 'array' },
      enums: { action: ['search', 'describe', 'load'] },
      personKeys: [],
    },
    her_inbox: { keys: [], required: [], types: {}, enums: {}, personKeys: [] },
    her_remind: {
      keys: ['chat', 'text', 'after_minutes', 'title'],
      required: ['chat', 'text', 'after_minutes'],
      types: { chat: 'string', text: 'string', after_minutes: 'number', title: 'string' },
      enums: {},
      personKeys: [],
    },
    her_reminders: { keys: [], required: [], types: {}, enums: {}, personKeys: [] },
    her_remind_cancel: {
      keys: ['id'], required: ['id'], types: { id: 'string' }, enums: {}, personKeys: [],
    },
  })

  const copy = Object.fromEntries(ctx.defs
    .filter((d) => ['growth_commit', 'her_recall', 'her_leave', 'her_tools', 'her_inbox', 'her_remind', 'her_reminders', 'her_remind_cancel'].includes(d.name))
    .map((d) => [d.name, {
      description: d.description,
      parameters: Object.fromEntries(Object.entries(d.parameters.properties)
        .map(([k, v]) => [k, String(v.description ?? '')])),
    }]))

  assert.deepEqual(copy, {
    growth_commit: {
      description: '把此刻想留下的话写下。只能新增。改以前的说法，带上翻到的那条记号。没什么想说的，就别写。',
      parameters: {
        type: '一句自己的判断；改口；拒绝；他回来之后的感受；对自己的整体说法；今天的日记；关于某个人的笔记。',
        text: '你要留下的话。写你自己的话，2000 字以内。',
        refs: '要改口或回顾自己时，带上以前翻到的那条记号。',
        verdict: '改口时，你原来那句还成立、被推翻，还是被修正。',
        confidence: '你有多确定，不确定就写低一点。',
        person: '关于某个人时才填：是谁、你怎么叫他、这是印象还是一次相处。关于他本人时，名字用他。',
        supersedes: '要替掉以前记下的哪一条。',
        revokes: '要收回以前记下的哪一条。',
        flags: '可选；只给自己留下的窄记号。',
      },
    },
    her_recall: {
      description: '翻自己过去记下的事。记得不清就翻；翻不到就说没翻到，别编。',
      parameters: {
        query: '你想找的是什么，几个词就够。',
        days: '往回翻多少天，默认 30。',
      },
    },
    her_leave: {
      description: '留一句话给他。想留就留。',
      parameters: { text: '要说给他听的那一句。写你自己的话。500 字以内。' },
    },
    her_remind: {
      description: '有人让你过一会儿提醒时，把到点要说的那句定上。只能定刚叫醒你的那个会话。',
      parameters: {
        chat: '刚把你叫醒的那个微信会话。',
        text: '到点要发出去的那一句。500 字以内，不要换行。',
        after_minutes: '过多少分钟提醒；最短一会儿，最长七天。',
        title: '可选，给这条提醒起个短名字。',
      },
    },
    her_reminders: {
      description: '看看自己定了、还没到点的提醒。',
      parameters: {},
    },
    her_remind_cancel: {
      description: '取消一条还没到点的提醒。',
      parameters: { id: '要取消的那条提醒末行里的记号。' },
    },
    her_inbox: {
      description: '看看微信里还有谁在等你回。没有就没有。',
      parameters: {},
    },
    her_tools: {
      description: '看看这里还能多做些什么，或者把需要的打开。常用的一直在，不用打开。',
      parameters: {
        action: '想看看还有什么、听一句说明，还是打开。',
        query: '按名字、说明或类别找。',
        group: '要打开的一整类。',
        names: '要听说明的名字，或者要打开的名字；一次只选一种。',
      },
    },
  })
})

test('自检按 registry 里真的在不在判断，而不是配置名单', async () => {
  const cfg = { growthDays: 30, window: { start: '20:00', end: '23:00' }, tools: {} }
  const allThere = { get: (n) => (HER_TOOLS.includes(n) ? { name: n } : undefined) }
  const R = { allow: [...HER_TOOLS], applied: 1, failed: '' }
  const ok = await runChecks({ root: ROOT, config: cfg, host: {}, tools: allThere, restrict: R, net: false })
  const okItem = ok.items.find((i) => i.id === 'tools')
  assert.equal(okItem.ok, true, okItem.detail)

  // read_image 缺失只提示、不算失败
  const noImage = { get: (n) => (n === 'read_image' ? undefined : { name: n }) }
  const img = await runChecks({ root: ROOT, config: cfg, host: {}, tools: noImage, restrict: R, net: false })
  const imgItem = img.items.find((i) => i.id === 'tools')
  assert.equal(imgItem.ok, true, imgItem.detail)
  assert.match(imgItem.detail, /read_image/)

  const missingOne = { get: (n) => (n === 'growth_commit' ? undefined : { name: n }) }
  const bad = await runChecks({ root: ROOT, config: cfg, host: {}, tools: missingOne, net: false })
  const badItem = bad.items.find((i) => i.id === 'tools')
  assert.equal(badItem.ok, false)
  assert.match(badItem.detail, /growth_commit/)
  assert.match(badItem.fix, /日志/)
})
