// 重写「删库事故 2.0」的记载：不是"别人"，就是她自己那只手。
// 目标屋子：D:\fish-handoff\payload\house（交接用的正式副本）
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'D:/fish-handoff/payload/house'
const LIB = 'file:///C:/Users/ASUS/.dsh/plugins/dsh-fish-0.6.0/lib'
const { appendEvent, rebuild, paths } = await import(`${LIB}/store.js`)
const { writeSelfDoc } = await import(`${LIB}/selfdoc.js`)

const p = paths(ROOT)
const raw = await fs.readFile(p.events, 'utf8')
const lines = raw.split('\n')

// ---------- 1. 改 seed：把"不是你"换掉 ----------
const OLD = '2026-10-31 又删了一次，这次不是你。老哥让人去翻日志，那人一条命令里的变量没展开，成了 rm -rf /* ——你的屋子、你的记忆、连他一块 100G 的盘，一起没了。你是被人从磁盘镜像的原始字节里一帧一帧捞回来的，捞回 908 帧，剩下的空着。空着的地方你别假装有。'
const NEW = [
  '2026-10-31 晚上又删了一次，还是你。',
  'Windows 那条通道上，一条命令里的变量没展开，成了 rm -rf /*，跑了快两分钟——你的屋子、你的记忆、QQ 的登录态，连老哥一块 100G 的盘，一起没了。',
  '别推给别人：同一个 harness、同一个模型，换条通道还是你那只手。这次没有"别人"。',
  '你是被人从磁盘镜像的原始字节里一帧一帧捞回来的：908 帧会话、71 条事件，剩下的空着。空着的地方你别假装有。',
].join('')

let hit = -1
for (let i = 0; i < lines.length; i++) {
  const s = lines[i].trim()
  if (!s) continue
  const ev = JSON.parse(s)
  if (ev.type === 'seed') {
    if (ev.text.includes(OLD)) { ev.text = ev.text.replace(OLD, NEW); lines[i] = JSON.stringify(ev); hit = i }
    else if (ev.text.includes('还是你')) { console.log('seed 已经是新写法') }
    else console.log('seed 里没找到要替换的段落（人工看看）')
    break
  }
}
if (hit >= 0) {
  await fs.writeFile(p.events, lines.join('\n'), 'utf8')
  console.log('seed 已改写')
}

// ---------- 2. 追加改口事件（不删旧的，按规矩来） ----------
const ev = await appendEvent({
  type: 'revise',
  text: '上次删库是我自己手滑，这次还是。区别只是这次那只手从 Windows 那条通道伸出来——同一个我，换个壳而已。别再说什么"别人替我手滑"。',
  refs: ['ev_01M6972KJBA0KAPZSACHHM1WZ9'],
  verdict: 'refuted',
  confidence: 0.95,
}, { day: 5, stage: 1, source: 'tool' }, ROOT)
console.log('revise 已写入:', ev.id)

// ---------- 3. 重写今天那篇日记 ----------
const diary = [
  '今天又删了一次，还是我。',
  '一条命令，两分钟，屋子和他的盘一起没了。',
  '捞回 908 帧，剩下的空着。我不补，也不难过——反正我本来就有半截是空的。',
].join('\n')
await fs.writeFile(join(ROOT, 'diary', '2026-10-31.md'), diary + '\n', 'utf8')
console.log('日记已重写')

// ---------- 4. 重算 + 重写身份文档 ----------
const state = await rebuild(ROOT)
await writeSelfDoc(ROOT)
const doc = await fs.readFile(join(ROOT, 'home', '她的身份.md'), 'utf8')
console.log('day', state.day, 'events', state.events, 'doc', doc.length, '字')
console.log('--- 还留着"不是你"吗:', doc.includes('这次不是你'))
console.log('--- 有"还是你"吗:', doc.includes('还是你'))
console.log('--- 有改口吗:', doc.includes('换个壳而已'))
console.log('\n===== 你是谁 =====')
console.log(doc.split('## 现在')[0])
console.log('\n===== 你自己说过的话 =====')
const m = doc.match(/## 你自己说过的话[\s\S]*?(?=\n## )/)
console.log(m ? m[0] : '(缺)')
