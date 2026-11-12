// 数据与运维：日志预览/导出、备份下载、更新检查、路径复制、头像与媒体、帧存档。
// 恢复/导入/重置/清日志这些写操作在 P2 —— 这里只给只读入口。
import { $, el, clear, card, fish, local, clock, errorText, hint } from '../lib.js'

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
      el('span', { class: 'meta', id: 'data-log-msg' }),
    ),
    el('pre', { class: 'logbox', id: 'data-log' }),
  )

  const backupCard = card('备份与恢复', { note: '备份是下载；恢复要输入 restore（P2 接入）。' })
  backupCard.body.append(
    el('div', { class: 'row' },
      el('a', { class: 'btn', href: '/api/fish/backup', download: '', text: '下载备份（约 47MB，流式）' }),
      el('span', { class: 'meta', text: '恢复、导入、重置在 P2；都要输入确认词。' }),
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
    el('div', { class: 'meta', text: '上传头像在 P2（上限 4MB）。原理图在「原理」页，用工作台本地副本。' }),
  )

  const framesCard = card('帧存档', { note: '工作台自己存的微信画面；清理在 P2。' })
  framesCard.body.append(el('div', { class: 'thumbs', id: 'data-frames' }))

  root.append(logCard.root, backupCard.root, updateCard.root, pathsCard.root, avatarCard.root, framesCard.root)
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
    loadLog(); loadAvatar(); loadFrames()
  },
  leave() {},
}
