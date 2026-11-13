// 数据与运维：日志、备份与恢复、导入、重置、更新检查、路径、头像、观测参数、帧存档。
// 危险操作要输入确认词；上游的 confirm 不被绕过，这里只是先把人拦住一次。
import { $, el, clear, card, fish, postFish, local, clock, errorText, writeError, hint } from '../lib.js'

const PATH_KEYS = [
  ['root', '数据根目录'],
  ['events', '事件流'],
  ['out', '产出目录'],
  ['diary', '日记'],
  ['home', '她的屋子'],
  ['inbox', '信箱'],
  ['log', '运行日志'],
]

function build(root) {
  const logCard = card('运行日志', { note: '预览只读；导出是纯文本（text/plain + Content-Disposition），不是 JSON。' })
  logCard.body.append(
    el('div', { class: 'row' },
      el('button', { id: 'data-log-load', text: '读最近 100 行', onclick: () => loadLog() }),
      el('a', { class: 'btn', href: '/api/fish/log/export', download: '', text: '导出日志' }),
      el('button', { id: 'data-log-clear', text: '清空运行日志', onclick: () => clearLog() }),
      el('span', { class: 'meta', id: 'data-log-msg' }),
    ),
    el('pre', { class: 'logbox', id: 'data-log' }),
  )

  const backupCard = card('备份与恢复', { note: '恢复是「先封存旧档，再放回备份」，不是删除；要输入 restore。' })
  backupCard.body.append(
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
      el('input', { type: 'file', id: 'data-restore-file', accept: 'application/json,.json' }),
      el('button', { id: 'data-restore-go', text: '恢复这份备份', onclick: () => restoreBackup() }),
      el('span', { class: 'meta', id: 'data-restore-msg' }),
    ),
  )

  const importCard = card('导入别人养过的大肥鱼', { note: '只认还没有起点的一局；人设会过来，工具白名单要重启 DSH 才生效。' })
  importCard.body.append(
    el('div', { class: 'meta', id: 'data-import-info', text: '读取中…' }),
    el('details', {},
      el('summary', { text: '什么会过来、什么不会' }),
      el('ul', { class: 'plain' },
        el('li', {}, el('span', { class: 'x', text: '过来：她是谁（人设正文）、她怎么称呼你、她原本能用的工具。' })),
        el('li', {}, el('span', { class: 'x', text: '不过来：过了多少天、长出了哪些判断、身上的疤、拒绝过什么、日记、B 站登录 cookie。这些只属于原来那一局，接过来的人从第 1 天重新长。' })),
        el('li', {}, el('span', { class: 'x', text: '人设正文控制在 1200～1500 字；超过 2000 字插件会整份拒收，太长也会把判断、疤这些会长出来的段落挤掉。' })),
        el('li', {}, el('span', { class: 'x', text: '工具白名单要重启 DSH 才生效——那是在启动时注册的。' })),
        el('li', {}, el('span', { class: 'x', text: '豁免只认「从这里导入」这一个动作；用「备份与恢复」把自己的档搬回来，不会带走任何豁免。' })),
      ),
    ),
    el('textarea', { id: 'data-import-text', class: 'doc', rows: '8', placeholder: '把交接单三节内容贴在这里…' }),
    el('div', { class: 'row' },
      el('button', { id: 'data-import-load', class: 'small', text: '读交接单模板', onclick: () => loadImport() }),
      el('button', { id: 'data-import-download', class: 'small', text: '下载模板', onclick: () => downloadTemplate() }),
      el('button', { id: 'data-import-go', text: '导入', onclick: () => doImport() }),
      el('span', { class: 'meta', id: 'data-import-msg' }),
    ),
  )

  const resetCard = card('重置', { note: '把旧的一切改名封存并重开一局；不删除旧数据，但要输入 reset。' })
  resetCard.body.append(
    el('div', { class: 'meta', text: '会封存：状态库（事件、判断、日记、信箱等）与运行日志所在的整个数据目录，然后开一局新的。' }),
    el('div', { class: 'row' },
      el('button', { id: 'data-reset-go', text: '重置成新的一局', onclick: () => doReset() }),
      el('span', { class: 'meta', id: 'data-reset-msg' }),
    ),
  )

  const observeCard = card('观测参数', { note: '这个键只在数据页编辑；端口 0 = 用宿主 webServer 的端口。' })
  observeCard.body.append(
    el('div', { class: 'grid2' },
      el('label', { class: 'chk' }, el('input', { type: 'checkbox', id: 'data-observe-enabled' }), el('span', { text: '观测台开着' })),
      el('label', { class: 'field' }, el('span', { class: 'meta', text: '端口' }), el('input', { type: 'number', id: 'data-observe-port', step: '1' })),
    ),
    el('div', { class: 'row' },
      el('button', { id: 'data-observe-save', class: 'small', text: '保存观测参数', onclick: () => saveObserve() }),
      el('span', { class: 'meta', id: 'data-observe-msg' }),
    ),
  )

  const updateCard = card('更新检查', { note: '只在点按钮时查一次；插件运行期从不自动查。' })
  updateCard.body.append(
    el('div', { class: 'row' },
      el('button', { id: 'data-update', text: '检查更新', onclick: () => checkUpdate() }),
      el('span', { class: 'meta', id: 'data-update-msg' }),
    ),
  )

  const pathsCard = card('数据路径', { note: '不默认把绝对路径上屏；要用时点按钮复制到剪贴板。' })
  pathsCard.body.append(
    el('div', { class: 'row' }, ...PATH_KEYS.map(([key, label]) => el('button', {
      class: 'small', text: '复制' + label, onclick: (e) => copyPath(key, e.currentTarget),
    }))),
    el('div', { class: 'meta', id: 'data-path-msg' }),
  )

  const avatarCard = card('头像与媒体')
  avatarCard.body.append(
    el('div', { class: 'row' }, el('img', { id: 'data-avatar', class: 'avatar', alt: '', hidden: '' })),
    el('div', { class: 'meta', id: 'data-avatar-msg' }),
    el('div', { class: 'row' },
      el('input', { type: 'file', id: 'data-avatar-file', accept: 'image/png,image/jpeg,image/webp,image/gif' }),
      el('button', { id: 'data-avatar-save', text: '上传头像', onclick: () => saveAvatar() }),
      el('button', { id: 'data-avatar-remove', text: '移除头像', onclick: () => removeAvatar() }),
    ),
    el('div', { class: 'meta', text: '上限 4MB（base64 前原图 2MB）；原理图在「原理」页，用工作台本地副本。' }),
  )

  const framesCard = card('帧存档', { note: '工作台自己存的微信画面。清理会删工作台存档，以及 /tmp 里超过一天的 png/jpg 旧截图。' })
  framesCard.body.append(
    el('div', { class: 'thumbs', id: 'data-frames' }),
    el('div', { class: 'row' },
      el('button', { id: 'data-gc', text: '清理帧存档', onclick: () => gcFrames() }),
      el('span', { class: 'meta', id: 'data-gc-msg' }),
    ),
  )

  root.append(logCard.root, backupCard.root, importCard.root, resetCard.root, updateCard.root, pathsCard.root,
    avatarCard.root, observeCard.root, framesCard.root)
}

async function loadLog() {
  const msg = $('#data-log-msg')
  const box = $('#data-log')
  msg.textContent = '读取中…'
  const r = await fish('log?lines=100')
  if (!r.ok) { box.textContent = errorText(r); msg.textContent = ''; return }
  const d = r.data || {}
  box.textContent = d.exists === false
    ? '还没有运行日志。'
    : (d.lines || []).join('\n')
  msg.textContent = `更新于 ${clock()}${d.bytes ? ' · ' + Math.round(d.bytes / 1024) + ' KB' : ''}`
}

async function checkUpdate() {
  const msg = $('#data-update-msg')
  msg.textContent = '检查中…'
  const r = await fish('update?ms=6000')
  if (!r.ok) { msg.textContent = errorText(r); return }
  const d = r.data || {}
  msg.textContent = d.ok === false
    ? `没查成：${d.error || '连不上'}`
    : d.hasUpdate
      ? `有新版本：${d.latest || ''}（当前 ${d.current || ''}）`
      : `是最新的（当前 ${d.current || '—'}${d.latest ? '，远端 ' + d.latest : ''}）`
}

async function copyPath(key, btn) {
  const msg = $('#data-path-msg')
  btn.disabled = true
  try {
    const r = await fish('paths')
    if (!r.ok) { msg.textContent = errorText(r); return }
    const value = r.data?.[key] || ''
    if (!value) { msg.textContent = '这个路径还没有。'; return }
    try {
      await navigator.clipboard.writeText(value)
      msg.textContent = `已复制（${PATH_KEYS.find((x) => x[0] === key)?.[1] || key}）`
    } catch {
      // 剪贴板不可用时退一步：让人自己选中复制，仍不主动把路径铺在页面上。
      btn.title = value
      msg.textContent = '浏览器不让自动复制，已把完整路径放进按钮的悬停提示。'
    }
  } finally { btn.disabled = false }
}

async function loadAvatar() {
  const img = $('#data-avatar')
  const msg = $('#data-avatar-msg')
  const r = await fish('avatar/info')
  if (!r.ok) { msg.textContent = errorText(r); return }
  const info = r.data || {}
  if (!info.present) { img.hidden = true; msg.textContent = '还没上传头像（插件不自带图片）。'; return }
  img.src = '/api/fish/avatar?t=' + Date.now()
  img.hidden = false
  msg.textContent = `${info.mime || '图片'} · ${Math.round((info.bytes || 0) / 1024)} KB · ${info.at || ''}`
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

async function clearLog() {
  if (!confirm('清空运行日志？导出过的文件不受影响。')) return
  const msg = $('#data-log-msg')
  const r = await postFish('log/clear', {})
  if (!r.ok) { msg.textContent = writeError(r); return }
  if (r.data?.ok === false) { msg.textContent = `没清成：${r.data.why || r.data.error || '上游拒绝'}`; return }
  const text = r.data?.cleared === false ? '日志本来就没有内容。' : '日志清空了。'
  await loadLog()
  // loadLog 会把状态行改成「更新于…」，清空的结论要写在它后面。
  msg.textContent = text
}

async function restoreBackup() {
  const msg = $('#data-restore-msg')
  const text = await readFile($('#data-restore-file'), 'text')
  if (!text) { msg.textContent = '先选一份备份 JSON。'; return }
  let bundle
  try { bundle = JSON.parse(text) } catch { msg.textContent = '这不是合法 JSON。'; return }
  const word = prompt('恢复会先封存旧档再放回这份备份。输入 restore 继续：')
  if (word !== 'restore') { msg.textContent = '没输入 restore，已取消。'; return }
  msg.textContent = '恢复中…'
  const r = await postFish('backup/restore', bundle)
  if (!r.ok) { msg.textContent = writeError(r); return }
  msg.textContent = r.data?.note || '恢复完了。重启 DSH 之后她才是这份档的样子。'
}

async function loadImport() {
  const info = $('#data-import-info')
  const msg = $('#data-import-msg')
  const r = await fish('import')
  if (!r.ok) { info.textContent = errorText(r); return }
  const d = r.data || {}
  info.textContent = d.canImport
    ? `可以导入${d.persona?.imported ? `（当前人设来自「${d.persona.source || '外部'}」）` : ''}。`
    : `现在不能导入：${d.reason || '她已经有起点了。'}`
  if (d.template && !$('#data-import-text').value) $('#data-import-text').value = d.template
  msg.textContent = ''
}

async function downloadTemplate() {
  const msg = $('#data-import-msg')
  let tpl = ''
  try {
    const r = await fish('import')
    tpl = r.data?.template || ''
  } catch { /* 下面统一报 */ }
  if (!tpl) { msg.textContent = '没读到模板。'; return }
  const blob = new Blob([tpl], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: '大肥鱼-交接单.md' })
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
  msg.textContent = '交接单已下载。'
}

async function doImport() {
  const msg = $('#data-import-msg')
  const text = $('#data-import-text').value.trim()
  if (!text) { msg.textContent = '先把交接单内容贴进来。'; return }
  const source = prompt('来源（可留空）：')
  if (source === null) return
  if (!confirm('导入会把这一局的人设换成交接单里的那一位；天数、判断、疤、日记、cookie 都不会过来。继续？')) return
  const r = await postFish('import', { text, source })
  if (!r.ok) { msg.textContent = r.data?.error || writeError(r); return }
  const d = r.data || {}
  if (d.ok === false) { msg.textContent = `没导成：${d.error || '上游拒绝'}`; return }
  await loadImport()
  // loadImport 会清空状态行；导入结果写在它后面，不然这句看不到。
  msg.textContent = `接过来了。她现在管你叫「${d.called || '—'}」，从第 ${d.day} 天开始；工具白名单要重启 DSH 才生效。`
}

async function doReset() {
  const msg = $('#data-reset-msg')
  const word = prompt('这会封存旧的一切并重开一局。输入 reset 继续：')
  if (word !== 'reset') { msg.textContent = '没输入 reset，已取消。'; return }
  msg.textContent = '重置中…'
  const r = await postFish('reset', { confirm: 'reset' })
  if (!r.ok) { msg.textContent = writeError(r); return }
  const d = r.data || {}
  msg.textContent = d.ok === false ? `没重置：${d.error || '上游拒绝'}` : (d.note || '已重置。')
}

async function saveAvatar() {
  const msg = $('#data-avatar-msg')
  const input = $('#data-avatar-file')
  const file = input?.files?.[0]
  if (!file) { msg.textContent = '先选一张图。'; return }
  if (file.size > 2 * 1024 * 1024) { msg.textContent = '原图超过 2MB，没上传。'; return }
  const data = await readFile(input)
  if (!data) { msg.textContent = '这张图读不出来。'; return }
  const r = await postFish('avatar', { data, mime: file.type })
  if (!r.ok) { msg.textContent = writeError(r); return }
  input.value = ''
  await loadAvatar()
  msg.textContent = '头像存好了。'
}

async function removeAvatar() {
  if (!confirm('移除头像？')) return
  const msg = $('#data-avatar-msg')
  const r = await postFish('avatar', { remove: true })
  if (!r.ok) { msg.textContent = writeError(r); return }
  await loadAvatar()
  msg.textContent = '已移除。'
}

async function loadObserve() {
  const r = await fish('config')
  if (!r.ok) { $('#data-observe-msg').textContent = errorText(r); return }
  const o = r.data?.config?.observe || {}
  $('#data-observe-enabled').checked = o.enabled !== false
  $('#data-observe-port').value = String(o.port ?? 0)
}

async function saveObserve() {
  const msg = $('#data-observe-msg')
  const r = await postFish('config', { observe: { enabled: $('#data-observe-enabled').checked, port: Number($('#data-observe-port').value) } })
  if (!r.ok) { msg.textContent = writeError(r); return }
  if (r.data?.ok === false) { msg.textContent = `没存上：${r.data.error || '上游拒绝'}`; return }
  msg.textContent = '已保存。'
  loadObserve()
}

async function gcFrames() {
  if (!confirm('清理会删掉工作台的帧存档，以及 /tmp 里超过一天的 png/jpg 旧截图。继续？')) return
  const msg = $('#data-gc-msg')
  const r = await local('/api/gc', { method: 'POST' })
  const d = r.data || {}
  msg.textContent = r.ok
    ? `清掉 ${d.framesPruned ?? 0} 张存档画面，/tmp 里 ${d.tmpPruned ?? 0} 张旧截图。`
    : writeError(r)
  if (r.ok) loadFrames()
}

async function loadFrames() {
  const box = $('#data-frames')
  clear(box)
  const r = await local('/api/frames')
  if (!r.ok) { box.append(hint('读不到帧存档', 'bad')); return }
  const files = (r.data?.files || []).slice(0, 12)
  if (!files.length) { box.append(hint('还没有存档。', 'meta')); return }
  for (const name of files) {
    const src = '/api/frames/' + encodeURIComponent(name)
    box.append(el('a', { href: src, target: '_blank', title: name }, el('img', { src, alt: name, loading: 'lazy' })))
  }
}

let built = false
export const data = {
  id: 'data',
  label: '数据与运维',
  enter(root) {
    if (!built) { build(root); built = true }
    loadLog(); loadAvatar(); loadFrames(); loadObserve(); loadImport()
  },
  leave() {},
}
