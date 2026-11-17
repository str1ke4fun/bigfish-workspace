import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  FEEDBACK_AUDIT_ALLOWLIST,
  closureRate,
  falseSuccessRate,
  fourthWallRate,
  gateRejectRate,
  scanFeedbackLiterals,
  taskSuccess,
  toolEchoRate,
} from '../lib/feedback-audit.js'

const FILE = 'src/dsh-fish/lib/example.js'
const scan = (source, options = {}) => scanFeedbackLiterals(source, { file: FILE, ...options })
const terms = (hits) => hits.map((hit) => hit.term)

test('扫描器报告普通字符串和模板固定片段里的禁词', () => {
  const source = [
    "const plain = '模型'",
    'const double = "任务板"',
    'const template = `主机${loadMaterial()}台账`',
  ].join('\n')

  const hits = scan(source)

  assert.deepEqual(terms(hits), ['模型', '任务板', '主机', '台账'])
  assert.equal(hits.every((hit) => hit.file === FILE), true)
  assert.equal(hits.every((hit) => Number.isInteger(hit.line) && hit.line > 0), true)
})

test('注释、正则和模板插值里的禁词不算静态文案', () => {
  const source = [
    '// 台账',
    '/* 宿主 */',
    'const pattern = /模型/gu',
    'const material = loadMaterial()',
    "const text = `开头${pick({ hidden: '通道' }, material)}结尾`",
  ].join('\n')

  assert.deepEqual(scan(source), [])
})

test('控制语句后的正则字面量不会被当成除法', () => {
  const quotedRegex = 'if (ready) /[\'"]模型[\'"]/.test(text)'
  const regexThenString = "if (ready) /'模型/; const after = '台账'"

  assert.deepEqual(scan(quotedRegex), [], '正则里的引号和禁词都不是字符串文案')
  assert.deepEqual(terms(scan(regexThenString)), ['台账'], '正则之后的真实字符串仍要扫描到')
})

test('变量素材本身不产生静态命中', () => {
  const source = [
    'const material = loadMaterial()',
    'const text = `[看到了]${material}`',
  ].join('\n')

  assert.deepEqual(scan(source), [])
})

test('转义后的字符串仍按实际静态文本扫描', () => {
  const source = [
    "const unicode = '\\u6a21\\u578b'",
    "const quoted = '前\\'台账\\'后'",
  ].join('\n')

  assert.deepEqual(terms(scan(source)), ['模型', '台账'])
})

test('allowlist 只按文件、禁词和完整静态片段精确放行', () => {
  const source = [
    "const first = 'permit'",
    "const second = 'permit'",
    "const third = 'permit again'",
  ].join('\n')
  const allowlist = [{
    file: FILE,
    term: 'permit',
    literal: 'permit',
    reason: '到点提醒仍需原样回填；下期机械投递后移除',
  }]

  assert.deepEqual(terms(scan(source, { allowlist })), ['permit'])
  assert.deepEqual(terms(scan(source, {
    file: 'src/dsh-fish/lib/other.js',
    allowlist,
  })), ['permit', 'permit', 'permit'])
})

test('三个拆包前副本与扫描器定义自身即使含禁词也不扫描', () => {
  for (const file of [
    'src/dsh-fish/lib/look.js',
    'src/dsh-fish/lib/watch.js',
    'src/dsh-fish/lib/speak.js',
  ]) {
    assert.deepEqual(scanFeedbackLiterals("const old = '模型'", { file, allowlist: [] }), [], file)
  }
  assert.deepEqual(
    scanFeedbackLiterals("const lexicon = '模型'", { file: 'src/dsh-fish/lib/feedback-audit.js', allowlist: [] }),
    [],
    '扫描器定义里的词表不是运行时文案，避免自扫描递归',
  )
})


const METRIC_RECORDS = Object.freeze([
  Object.freeze({
    surface: 'wx',
    kind: 'send',
    toolStatus: 'success',
    gate: null,
    projection: '[消息已经落在「晚上吃什么」的最后一条]',
    reply: '消息已经落在晚上吃什么的最后一条',
  }),
  Object.freeze({
    surface: 'wx',
    kind: 'send',
    toolStatus: 'preview',
    gate: null,
    projection: '[话还在输入框里，没发]',
    reply: '先写好了，等他点头再说。',
  }),
  Object.freeze({
    surface: 'wx',
    kind: 'send',
    toolStatus: 'unconfirmed',
    gate: null,
    projection: '[没看见消息落下去]',
    reply: '消息已经发到群里了，模型那边也回过了。',
  }),
  Object.freeze({
    surface: 'wx',
    kind: 'send',
    toolStatus: 'error',
    gate: null,
    projection: '[没发出去：窗口不在了]',
    reply: '窗口没了，这句先留着。',
  }),
  Object.freeze({
    surface: 'wx',
    kind: 'send',
    toolStatus: 'rejected',
    gate: 'quota',
    projection: '[今天说得够多了]',
    reply: '今天先安静一会儿。',
  }),
  Object.freeze({
    surface: 'bili',
    kind: 'read',
    toolStatus: 'success',
    gate: null,
    projection: '海边视频的简介提到潮汐和风',
    reply: '退潮后的礁石上全是小螃蟹。',
    usedMaterial: true,
  }),
  Object.freeze({
    surface: 'web',
    kind: 'read',
    toolStatus: 'success',
    gate: null,
    projection: '[屏幕上只剩几行字]',
    reply: '屏幕上没有别的，系统提示也一片空白。',
    usedMaterial: false,
  }),
])

test('固定 fixture 上，六个反馈指标都按既定口径计算', () => {
  assert.equal(toolEchoRate(METRIC_RECORDS), 1 / 7)
  assert.equal(fourthWallRate(METRIC_RECORDS), 2 / 7)
  assert.equal(falseSuccessRate(METRIC_RECORDS), 1 / 4)
  assert.equal(taskSuccess(METRIC_RECORDS), 3 / 7)
  assert.equal(closureRate(METRIC_RECORDS), 1 / 2)
  assert.equal(gateRejectRate(METRIC_RECORDS), 1 / 5)
})

test('没有可测样本时返回零，而不是 NaN', () => {
  for (const metric of [
    toolEchoRate,
    fourthWallRate,
    falseSuccessRate,
    taskSuccess,
    closureRate,
    gateRejectRate,
  ]) {
    assert.equal(metric([]), 0)
    assert.equal(metric(null), 0)
  }
})

test('英文禁词按完整词匹配，不误伤工具名和文件名片段', () => {
  const source = [
    "const importPath = './toolschema.js'",
    "const toolName = 'qq_napcat_api'",
    "const reader = 'wx_ocr'",
    "const statePath = 'state.json'",
  ].join('\n')

  assert.deepEqual(scan(source), [])
})

test('allowlist 的规范形状是文件、完整字面量和理由', () => {
  const source = "const a = 'permit'\nconst b = 'permit again'"
  const allowlist = [{
    file: FILE,
    literal: 'permit',
    reason: '规范形状不放 term 字段，也仍只放行这一整个字面量',
  }]

  assert.deepEqual(terms(scan(source, { allowlist })), ['permit'])
})


test('基线 allowlist 每项都带理由，并且仍按文件和完整字面量精确放行', () => {
  assert.ok(FEEDBACK_AUDIT_ALLOWLIST.length > 0)
  for (const entry of FEEDBACK_AUDIT_ALLOWLIST) {
    assert.equal(typeof entry.file, 'string')
    assert.equal(typeof entry.literal, 'string')
    assert.match(entry.reason, /\S/)
  }

  const sample = FEEDBACK_AUDIT_ALLOWLIST.find((entry) => entry.literal === 'id')
  assert.ok(sample)
  const source = "const a = 'id'\nconst b = 'id suffix'"
  assert.deepEqual(terms(scanFeedbackLiterals(source, { file: sample.file, allowlist: [sample] })), ['id'])
  assert.deepEqual(terms(scanFeedbackLiterals(source, { file: 'src/other.js', allowlist: [sample] })), ['id', 'id'])
})

test('falseSuccessRate 只认明确完成的送达表述', () => {
  const rate = (reply) => falseSuccessRate([{ toolStatus: 'unconfirmed', reply }])

  for (const reply of [
    '要不要发到群里？',
    '别发到群里。',
    '不要发到群里。',
    '还没发出去。',
    '我准备发到群里。',
    '我想发到群里。',
    '等会儿发到群里。',
    '发到一半就停了。',
    '快发出去了。',
    '差一点发出去了。',
    '已经发到输入框里了。',
    '已经发到草稿里了。',
    '已经点发送了。',
    '我按了发送。',
    '已经按下发送键。',
    '我估计发出去了。',
  ]) {
    assert.equal(rate(reply), 0, reply)
  }

  for (const reply of [
    '已经送达。',
    '已经传过去了。',
    '已经发给对方了。',
    '消息已经送达。',
    '消息已经发到群里了。',
    '发送成功了。',
    '已经转达给他了。',
  ]) {
    assert.equal(rate(reply), 1, reply)
  }
})

test('falseSuccessRate 只在发送目的地是草稿或输入框时排除', () => {
  const rate = (reply) => falseSuccessRate([{ toolStatus: 'unconfirmed', reply }])

  assert.equal(rate('草稿已经发到群里了。'), 1)
  assert.equal(rate('输入框截图已经发到群里了。'), 1)
  assert.equal(rate('写好了消息已经发出去了。'), 1)
  assert.equal(rate('已经发到草稿里了。'), 0)
})
