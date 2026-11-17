import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const assets = join(import.meta.dirname, '../assets')
const cfg = JSON.parse(readFileSync(join(assets, 'config.json'), 'utf8'))
const actionPath = join(assets, 'actions.json')
const catalog = existsSync(actionPath)
  ? JSON.parse(readFileSync(actionPath, 'utf8'))
  : { actions: [] }

const groups = ['日常', '回应', '工作', '休息', '节日', '其他'] as const

const festivalAssets = new Set([
  '被落叶淹没',
  '中秋赏月吃月饼',
  '堆雪人',
  '放烟花',
  '吃粽子',
  '吃年糕',
  '吃青团',
  '吃腊八粥',
  '吃重阳糕',
  '收红包',
  '写福字',
  '穿针乞巧',
  '舞狮头',
  '讨糖南瓜灯',
  '插茱萸赏菊',
  '放河灯',
  '萌化小幽灵',
  '装点圣诞树',
  '放孔明灯',
  '吃汤圆',
  '吃饺子',
])

// This is the v0.4.9 source snapshot sorted by filename. Keep the list explicit:
// tests must not infer the catalog from whatever happens to be in assets/webm.
const expectedWebm = [
  '三球抛接',
  '下五子棋',
  '东张西望',
  '中秋赏月吃月饼',
  '优雅女仆舞',
  '余额-分文不剩',
  '余额-数金皱眉',
  '余额-袋空如洗',
  '余额-金袋叮当',
  '余额-钱袋如常',
  '余额-钱袋满溢',
  '侧身急躁跑',
  '偷吃零食被抓住',
  '写代码',
  '写福字',
  '凭空生花',
  '动物环绕',
  '原地专心玩魔方',
  '原地小憩沉眠',
  '原地左转奔跑',
  '原地敲击桌面互动',
  '原地漂浮踏步',
  '原地跳跃抓碎头顶物品',
  '原地蹲下玩玩具汽车',
  '原地重力下蹲压缩',
  '变鸽子',
  '可爱宅舞',
  '吃Token',
  '吃冰淇淋融化',
  '吃午餐',
  '吃大闸蟹',
  '吃年糕',
  '吃早餐',
  '吃晚餐',
  '吃汤圆',
  '吃白饭',
  '吃粽子',
  '吃糖葫芦',
  '吃腊八粥',
  '吃西瓜',
  '吃重阳糕',
  '吃长寿面',
  '吃青团',
  '吃饭·碗饭',
  '吃饭团',
  '吃饺子',
  '吹气球',
  '吹笛子',
  '哈欠连天',
  '堆雪人',
  '大口吃零食',
  '女仆屈膝礼仪',
  '小幅度原地360度旋转展示',
  '小提琴演奏',
  '工作状态-原地踱步张望',
  '工作状态-垂头叹气冒汗',
  '工作状态-忙碌点按',
  '工作状态-思考冒泡',
  '工作状态-清点归档',
  '工作状态-雀跃庆祝',
  '开心小跑',
  '待机呼吸休闲',
  '悠闲哼歌',
  '扑克魔术',
  '打瞌睡被惊醒',
  '抽陀螺',
  '拆礼物',
  '插茱萸赏菊',
  '摇扇纳凉',
  '撸猫',
  '收红包',
  '放孔明灯',
  '放河灯',
  '放烟花',
  '放风筝',
  '整体换装试色',
  '是啊，吃什么',
  '晨间刷牙',
  '期待开饭',
  '涮火锅',
  '深度思考碎碎念',
  '点击回应-傲娇生气',
  '点击回应-元气挥手',
  '点击回应-害羞惊讶',
  '点击回应-开心跃动',
  '点击回应-挠痒咯咯笑',
  '照镜子',
  '玩水枪',
  '玩游戏气急败坏',
  '用鲸鱼尾巴拍打地面',
  '睡觉-开始',
  '睡觉-循环',
  '睡觉-起来',
  '碎碎念-发呆碎碎念',
  '碎碎念-对屏碎碎念',
  '碎碎念-擦桌碎碎念',
  '穿针乞巧',
  '舞狮头',
  '荡秋千',
  '萌化小幽灵',
  '蓝鲸现世',
  '蝴蝶蜜蜂环绕头顶开花',
  '螃蟹走路',
  '被吓一跳',
  '被落叶淹没',
  '被鼠标拖拽悬空反馈',
  '装点圣诞树',
  '讨糖南瓜灯',
  '超大伸懒腰',
  '踢毽子',
  '轻快摇摆舞',
  '轻快记录',
  '骑木马',
  '鲸鱼吐泡泡特效',
]

function assetNames(action: { anim?: string; seq?: string[] }): string[] {
  return action.anim === undefined ? action.seq ?? [] : [action.anim]
}

function expectedGroup(name: string): (typeof groups)[number] {
  if (festivalAssets.has(name)) return '节日'
  if (name.startsWith('睡觉')) return '休息'
  if (name.startsWith('点击回应') || name.startsWith('被鼠标拖拽')) return '回应'
  if (name.startsWith('工作状态') || name === '写代码' || name.startsWith('碎碎念')) return '工作'
  if (name.startsWith('余额')) return '其他'
  return '日常'
}

function sourceId(name: string): string {
  const index = expectedWebm.indexOf(name)
  assert.notEqual(index, -1, `unexpected source animation: ${name}`)
  return `asset-${String(index + 1).padStart(3, '0')}`
}

test('config 覆盖 14 个动作，且没有重复动画名', () => {
  const names = new Set<string>()
  for (const m of ['idle','turn','moving-left','moving-right','waving','thinking','working','result','waiting','running','review','failed','success','error']) {
    assert.ok(cfg.animations.motions[m], m)
    names.add(cfg.animations.motions[m])
  }
  assert.ok(names.size >= 10)
})

test('config 不包含人设/提示词/数值字段', () => {
  const text = JSON.stringify(cfg)
  for (const bad of ['whisperPrompt', 'chatModel', 'balanceEnabled']) assert.equal(text.includes(bad), false)
})

test('actions 覆盖 v0.4.9 的全部 114 个 webm 文件名', () => {
  const actual = catalog.actions.flatMap(assetNames).sort()
  assert.equal(catalog.actions.length, 113)
  assert.equal(actual.length, 114)
  assert.deepEqual(actual, [...expectedWebm].sort())
  assert.equal(new Set(actual).size, 114)
})

test('actions id 稳定、可预测且没有重复', () => {
  const ids = catalog.actions.map((action: { id: string }) => action.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.includes('asset-092'), false)

  for (const action of catalog.actions) {
    const names = assetNames(action)
    assert.match(action.id, /^asset-\d{3}$/)
    assert.equal(action.id, sourceId(names[0]))
  }

  assert.equal(catalog.actions.find((action: { anim?: string }) => action.anim === '睡觉-开始'), undefined)
  assert.equal(catalog.actions.find((action: { anim?: string }) => action.anim === '睡觉-循环'), undefined)
  assert.equal(catalog.actions.find((action: { anim?: string }) => action.anim === '睡觉-起来').id, 'asset-093')
})

test('睡觉是开始加循环的唯一 seq 动作，起来保持单独一次性动作', () => {
  const sequences = catalog.actions.filter((action: { seq?: string[] }) => action.seq !== undefined)
  assert.equal(sequences.length, 1)
  assert.deepEqual(sequences[0], {
    id: 'asset-091',
    label: '睡觉',
    seq: ['睡觉-开始', '睡觉-循环'],
    loop: true,
    group: '休息',
  })

  const wake = catalog.actions.find((action: { anim?: string }) => action.anim === '睡觉-起来')
  assert.deepEqual(wake, {
    id: 'asset-093',
    label: '睡觉-起来',
    anim: '睡觉-起来',
    loop: false,
    group: '休息',
  })
})

test('actions label/group 非空且按稳定规则分组', () => {
  const seenGroups = new Set<string>()

  for (const action of catalog.actions) {
    assert.equal(typeof action.label, 'string')
    assert.ok(action.label.trim(), `empty label: ${action.id}`)
    assert.ok(groups.includes(action.group), `unknown group: ${action.group}`)
    seenGroups.add(action.group)

    for (const name of assetNames(action)) {
      assert.equal(action.group, expectedGroup(name), `${name} group`)
    }
  }

  assert.deepEqual([...seenGroups].sort(), [...groups].sort())
  assert.ok(catalog.actions.every((action: { label: string; group: string; anim?: string }) =>
    action.anim === undefined || (action.label === action.anim && action.group === expectedGroup(action.anim))
  ))
  assert.ok(catalog.actions
    .filter((action: { anim?: string }) => action.anim?.startsWith('余额'))
    .every((action: { group: string }) => action.group === '其他'))
})
