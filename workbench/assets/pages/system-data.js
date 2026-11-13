// 系统 · 数据：备份与恢复、导入、观测参数、更新检查、数据路径、头像、帧存档。
// 危险操作（重置）放在页面最下面；恢复 / 重置要输入确认词，上游的 confirm 不被绕过。
import {
  el, clear, card, fish, postFish, local, clock, errorText, writeError, hint,
} from '../lib.js'

const PATH_KEYS = [
  ['root', '数据根目录'],
  ['events', '事件流'],
  ['out', '产出目录'],
  ['diary', '日记'],
  ['home', '她的屋子'],
  ['inbox', '信箱'],
  ['log', '运行日志'],
]

const SPEC = {}

function build(root) {
  // ---- 备份与恢复 ----
  SPEC.backup = card('备份与恢复', { note: '恢复是「先封存旧档，再放回备份」，不是删除；要输入 restore。' })
  SPEC.backupMsg = el('span', { class: 'meta' })
  SPEC.restoreFile = el('input', { type: 'file', accept: 'application/json,.json' })
  SPEC.backup.body.append(
    el('div', { class: 'row' },
      // 上游是 JSON（filename 在 body 里，没有 Content-Disposition）；给锚点一个
      // 带 .json 的名字，恢复时的文件选择器才看得到它。
      el('a', {
        class: 'btn', href: '/api/fish/backup',
        download: `大肥鱼-备份-${new Date().toISOString().slice(0, 10)}.json`,
        text: '下载备份（约 47MB，流式）',
      }),
    ),
    el('div', { class: 'row' },
      SPEC.restoreFile,
      el('button', { class: 'small', type: 'button', text: '恢复这份备份', onclick: () => restoreBackup() }),
      SPEC.backupMsg,
    ),
  )

  // ---- 导入 ----
  SPEC.import = card('导入别人养过的大肥鱼', { note: '只认还没有起点的一局；人设会过来，工具白名单要重启 DSH 才生效。' })
  SPEC.importInfo = el('div', { class: 'meta', text: '读取中…' })
  SPEC.importText = el('textarea', { class: 'doc', rows: '8', placeholder: '把交接单三节内容贴在这里…' })
  SPEC.importMsg = el('span', { class: 'meta' })
  SPEC.import.body.append(
    SPEC.importInfo,
    el('details', {},
      el('summary', { text: '什么会过来、什么不会' }),
      el('ul', { class: 'plain' },
        el('li', {}, el('span', { class: 'x', text: '过来：她是谁（人设正文）、她怎么称呼你、她原本能用的工具。' })),
        el('li', {}, el('span', { class: 'x', text: '不过来：过了多少天、长出了哪些判断、身上的疤、拒绝过什么、日记、B 站登录 cookie。这些只属于原来那一局，接过来的人从第 1 天重新长。' })),
        el('li', {}, el('span', { class: 'x', text: '人设正文控制在 1200～1500 字；超过 2000 字插件会整份拒收，太长也会把判断、疤这些会长出来的段落挤掉。' })),
        el('li', {}, el('span', { class: 'x', text: '工具白名单要重启 DSH 才生效——那是在启动时注册的。' })),
      ),
    ),
    SPEC.importText,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '读交接单模板', onclick: () => loadImport() }),
      el('button', { class: 'small', type: 'button', text: '下载模板', onclick: () => downloadTemplate() }),
      el('button', { class: 'primary small', type: 'button', text: '导入', onclick: () => doImport() }),
      SPEC.importMsg,
    ),
  )

  // ---- 观测参数 ----
  SPEC.observe = card('观测参数', { note: '这个键只在数据页编辑；端口 0 = 用宿主 webServer 的端口。' })
  SPEC.observeEnabled = el('input', { type: 'checkbox' })
  SPEC.observePort = el('input', { type: 'number', step: '1' })
  SPEC.observeMsg = el('span', { class: 'meta' })
  SPEC.observe.body.append(
    el('div', { class: 'grid2' },
      el('label', { class: 'chk' }, SPEC.observeEnabled, el('span', { text: '观测台开着' })),
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '端口' }), SPEC.observePort),
    ),
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '保存观测参数', onclick: () => saveObserve() }),
      SPEC.observeMsg,
    ),
  )

  // ---- 更新检查 ----
  SPEC.update = card('更新检查', { note: '只在点按钮时查一次；插件运行期从不自动查。' })
  SPEC.updateMsg = el('span', { class: 'meta' })
  SPEC.update.body.append(
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '检查更新', onclick: () => checkUpdate() }),
      SPEC.updateMsg,
    ),
  )

  // ---- 数据路径 ----
  SPEC.paths = card('数据路径', { note: '不默认把绝对路径上屏；要用时点按钮复制到剪贴板。' })
  SPEC.pathMsg = el('div', { class: 'meta' })
  SPEC.paths.body.append(
    el('div', { class: 'row' }, ...PATH_KEYS.map(([key, label]) => el('button', {
      class: 'small', type: 'button', text: '复制' + label, onclick: (e) => copyPath(key, e.currentTarget),
    }))),
    SPEC.pathMsg,
  )

  // ---- 头像与媒体 ----
  SPEC.avatar = card('头像与媒体')
  SPEC.avatarImg = el('img', { class: 'avatar', alt: '', hidden: '' })
  SPEC.avatarMsg = el('div', { class: 'meta' })
  SPEC.avatarFile = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' })
  SPEC.avatar.body.append(
    SPEC.avatarImg,
    SPEC.avatarMsg,
    el('div', { class: 'row' },
      SPEC.avatarFile,
      el('button', { class: 'small', type: 'button', text: '上传头像', onclick: () => saveAvatar() }),
      el('button', { class: 'small', type: 'button', text: '移除头像', onclick: () => removeAvatar() }),
    ),
    el('div', { class: 'meta', text: '上限 4MB 请求体（base64 前原图 2MB）；原理图在「原理」页，用工作台本地副本。' }),
  )

  // ---- 帧存档 ----
  SPEC.frames = card('帧存档', { note: '工作台自己存的微信画面。清理会删工作台存档，以及 /tmp 里超过一天的 png/jpg 旧截图。' })
  SPEC.framesBox = el('div', { class: 'thumbs' })
  SPEC.framesMsg = el('span', { class: 'meta' })
  SPEC.frames.body.append(
    SPEC.framesBox,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '清理帧存档', onclick: () => gcFrames() }),
      SPEC.framesMsg,
    ),
  )

  // ---- 危险操作（最下面）----
  SPEC.danger = card('重置', { note: '把旧的一切改名封存并重开一局；不删除旧数据，但要输入 reset。' })
  SPEC.resetMsg = el('span', { class: 'meta' })
  SPEC.danger.body.append(
    el('div', { class: 'meta', text: '会封存：状态库（事件、判断、日记、信箱等）与运行日志所在的整个数据目录，然后开一局新的。' }),
    el('div', { class: 'row' },
      el('button', { class: 'small danger', type: 'button', text: '重置成新的一局', onclick: () => doReset() }),
      SPEC.resetMsg,
    ),
  )

  root.append(
    SPEC.backup.root, SPEC.import.root, SPEC.observe.root, SPEC.update.root, SPEC.paths.root,
    SPEC.avatar.root, SPEC.frames.root, SPEC.danger.root,
  )
}

function readFile(input, as = 'dataURL') {
  return new Promise((resolve) => {
    const file = input?.files?.[0]
    if (!file) { resolve(null); return }
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => resolve(null)
    if (as === 'text') reader.readAsText(file)
    else reader.readAsDataURL(file)
  })
}

async function restoreBackup() {
  const text = await readFile(SPEC.restoreFile, 'text')
  if (!text) { SPEC.backupMsg.textContent = '先选一份备份 JSON。'; return }
  let bundle
  try { bundle = JSON.parse(text) } catch { SPEC.backupMsg.textContent = '这不是合法 JSON。'; return }
  const word = prompt('恢复会先封存旧档再放回这份备份。输入 restore 继续：')
  if (word !== 'restore') { SPEC.backupMsg.textContent = '没输入 restore，已取消。'; return }
  SPEC.backupMsg.textContent = '恢复中…'
  const r = await postFish('backup/restore', bundle)
  if (!r.ok) { SPEC.backupMsg.textContent = writeError(r); return }
  SPEC.backupMsg.textContent = r.data?.note || '恢复完了。重启 DSH 之后她才是这份档的样子。'
}

async function loadImport() {
  const r = await fish('import')
  if (!r.ok) { SPEC.importInfo.textContent = errorText(r); return }
  const d = r.data || {}
  SPEC.importInfo.textContent = d.canImport
    ? `可以导入${d.source ? `（当前人设来自「${d.source}」）` : ''}。`
    : `现在不能导入：${d.reason || '她已经有起点了。'}`
  if (d.template && !SPEC.importText.value) SPEC.importText.value = d.template
  SPEC.importMsg.textContent = ''
}

async function downloadTemplate() {
  let tpl = ''
  const r = await fish('import')
  if (r.ok) tpl = r.data?.template || ''
  if (!tpl) { SPEC.importMsg.textContent = '没读到模板。'; return }
  const blob = new Blob([tpl], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: '大肥鱼-交接单.md' })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  SPEC.importMsg.textContent = '交接单已下载。'
}

async function doImport() {
  const text = SPEC.importText.value.trim()
  if (!text) { SPEC.importMsg.textContent = '先把交接单内容贴进来。'; return }
  const source = prompt('来源（可留空）：')
  if (source === null) return
  if (!confirm('导入会把这一局的人设换成交接单里的那一位；天数、判断、疤、日记、cookie 都不会过来。继续？')) return
  const r = await postFish('import', { text, source })
  if (!r.ok) { SPEC.importMsg.textContent = writeError(r); return }
  const d = r.data || {}
  if (d.ok === false) { SPEC.importMsg.textContent = `没导成：${d.error || '上游拒绝'}`; return }
  await loadImport()
  // loadImport 会清空状态行；导入结果写在它后面，不然这句看不到。
  SPEC.importMsg.textContent = `接过来了。她现在管你叫「${d.called || '—'}」，从第 ${d.day} 天开始；工具白名单要重启 DSH 才生效。`
}

async function checkUpdate() {
  SPEC.updateMsg.textContent = '检查中…'
  const r = await fish('update?ms=6000')
  if (!r.ok) { SPEC.updateMsg.textContent = errorText(r); return }
  const d = r.data || {}
  SPEC.updateMsg.textContent = d.ok === false
    ? `没查成：${d.error || '连不上'}`
    : d.hasUpdate
      ? `有新版本：${d.latest || ''}（当前 ${d.current || ''}）`
      : `是最新的（当前 ${d.current || '—'}${d.latest ? '，远端 ' + d.latest : ''}）`
}

async function copyPath(key, btn) {
  btn.disabled = true
  try {
    const r = await fish('paths')
    if (!r.ok) { SPEC.pathMsg.textContent = errorText(r); return }
    const value = r.data?.[key] || ''
    if (!value) { SPEC.pathMsg.textContent = '这个路径还没有。'; return }
    try {
      await navigator.clipboard.writeText(value)
      SPEC.pathMsg.textContent = `已复制（${PATH_KEYS.find((x) => x[0] === key)?.[1] || key}）`
    } catch {
      // 剪贴板不可用时退一步：让人自己选中复制，仍不主动把路径铺在页面上。
      btn.title = value
      SPEC.pathMsg.textContent = '浏览器不让自动复制，已把完整路径放进按钮的悬停提示。'
    }
  } finally { btn.disabled = false }
}

async function loadAvatar() {
  const r = await fish('avatar/info')
  if (!r.ok) { SPEC.avatarMsg.textContent = errorText(r); return }
  const info = r.data || {}
  if (!info.present) {
    SPEC.avatarImg.hidden = true
    SPEC.avatarMsg.textContent = '还没上传头像（插件不自带图片）。'
    return
  }
  SPEC.avatarImg.src = '/api/fish/avatar?t=' + Date.now()
  SPEC.avatarImg.hidden = false
  SPEC.avatarMsg.textContent = `${info.mime || '图片'} · ${Math.round((info.bytes || 0) / 1024)} KB · ${info.at || ''}`
}

async function saveAvatar() {
  const file = SPEC.avatarFile?.files?.[0]
  if (!file) { SPEC.avatarMsg.textContent = '先选一张图。'; return }
  if (file.size > 2 * 1024 * 1024) { SPEC.avatarMsg.textContent = '原图超过 2MB，没上传。'; return }
  const data = await readFile(SPEC.avatarFile)
  if (!data) { SPEC.avatarMsg.textContent = '这张图读不出来。'; return }
  const r = await postFish('avatar', { data, mime: file.type })
  if (!r.ok) { SPEC.avatarMsg.textContent = writeError(r); return }
  SPEC.avatarFile.value = ''
  await loadAvatar()
  SPEC.avatarMsg.textContent = '头像存好了。'
}

async function removeAvatar() {
  if (!confirm('移除头像？')) return
  const r = await postFish('avatar', { remove: true })
  if (!r.ok) { SPEC.avatarMsg.textContent = writeError(r); return }
  await loadAvatar()
  SPEC.avatarMsg.textContent = '已移除。'
}

async function loadObserve() {
  const r = await fish('config')
  if (!r.ok) { SPEC.observeMsg.textContent = errorText(r); return }
  // 观测配置整组读写：observe.enabled / observe.port。
  const o = r.data?.config?.observe || {}
  SPEC.observeEnabled.checked = o.enabled !== false
  SPEC.observePort.value = String(o.port ?? 0)
}

async function saveObserve() {
  const r = await postFish('config', {
    observe: { enabled: SPEC.observeEnabled.checked, port: Number(SPEC.observePort.value) },
  })
  if (!r.ok) { SPEC.observeMsg.textContent = writeError(r); return }
  if (r.data?.ok === false) { SPEC.observeMsg.textContent = `没存上：${r.data.error || '上游拒绝'}`; return }
  SPEC.observeMsg.textContent = `已保存 · ${clock()}`
  loadObserve()
}

async function loadFrames() {
  clear(SPEC.framesBox)
  const r = await local('/api/frames')
  if (!r.ok) { SPEC.framesBox.append(hint('读不到帧存档', 'bad')); return }
  const files = (r.data?.files || []).slice(0, 12)
  if (!files.length) { SPEC.framesBox.append(hint('还没有存档。', 'meta')); return }
  for (const name of files) {
    const src = '/api/frames/' + encodeURIComponent(name)
    SPEC.framesBox.append(el('a', { href: src, target: '_blank', title: name },
      el('img', { src, alt: name, loading: 'lazy' })))
  }
}

async function gcFrames() {
  if (!confirm('清理会删掉工作台的帧存档，以及 /tmp 里超过一天的 png/jpg 旧截图。继续？')) return
  const r = await local('/api/gc', { method: 'POST' })
  const d = r.data || {}
  SPEC.framesMsg.textContent = r.ok
    ? `清掉 ${d.framesPruned ?? 0} 张存档画面，/tmp 里 ${d.tmpPruned ?? 0} 张旧截图。`
    : writeError(r)
  if (r.ok) loadFrames()
}

async function doReset() {
  const word = prompt('这会封存旧的一切并重开一局。输入 reset 继续：')
  if (word !== 'reset') { SPEC.resetMsg.textContent = '没输入 reset，已取消。'; return }
  SPEC.resetMsg.textContent = '重置中…'
  const r = await postFish('reset', { confirm: 'reset' })
  if (!r.ok) { SPEC.resetMsg.textContent = writeError(r); return }
  const d = r.data || {}
  SPEC.resetMsg.textContent = d.ok === false ? `没重置：${d.error || '上游拒绝'}` : (d.note || '已重置。')
}

export const systemData = {
  id: 'system-data',
  nav: 'system',
  slug: 'data',
  label: '数据',
  order: 40,

  enter(root) {
    if (!SPEC.built) { build(root); SPEC.built = true }
    loadImport()
    loadObserve()
    loadAvatar()
    loadFrames()
  },

  leave() {},
}
