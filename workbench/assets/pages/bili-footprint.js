// B 站 · 足迹：视频足迹按天折叠，评论足迹按时间倒序。全部只读。
// 不提供编辑、删除、代发；正文缺失时现取一条，不批量扫。
import { el, clear, card, fish, fmtTime, errorText, hint, emptyState, segment } from '../lib.js'

const SECTIONS = [
  { id: 'videos', label: '视频足迹' },
  { id: 'comments', label: '评论足迹' },
]

const DAY_OPTIONS = [7, 14, 30]

const SPEC = { days: 14 }

function build(root) {
  SPEC.switch = segment(SECTIONS, { value: 'videos', label: '足迹分段', onChange: (id) => show(id) })

  // ---- 视频足迹 ----
  SPEC.videos = card('视频足迹', { note: '按天分组；封面懒加载，抽帧点开单条才取。' })
  SPEC.videosBody = el('div')
  SPEC.daysPick = el('select', { onchange: () => { SPEC.days = Number(SPEC.daysPick.value) || 14; loadVideos() } },
    ...DAY_OPTIONS.map((n) => el('option', { value: String(n), text: `最近 ${n} 天` })))
  SPEC.videos.body.append(
    el('div', { class: 'row' }, SPEC.daysPick),
    SPEC.videosBody,
  )

  // ---- 评论足迹 ----
  SPEC.comments = card('评论足迹', { note: '她发过的评论与回复；正文缺失时可单条现取。' })
  SPEC.commentsBody = el('div')
  SPEC.commentsMsg = el('span', { class: 'meta' })
  SPEC.comments.body.append(
    SPEC.commentsBody,
    el('div', { class: 'row' },
      el('button', { class: 'small', type: 'button', text: '刷新', onclick: () => loadComments() }),
      SPEC.commentsMsg,
    ),
  )

  SPEC.sections = { videos: SPEC.videos.root, comments: SPEC.comments.root }
  root.append(SPEC.switch.root, ...Object.values(SPEC.sections))
  show('videos')
}

function show(id) {
  for (const [key, node] of Object.entries(SPEC.sections)) node.hidden = key !== id
  SPEC.switch.set(id)
}

function coverImg(bvid, alt) {
  const img = el('img', { class: 'cover', src: '/api/fish/cover/' + encodeURIComponent(bvid), alt: alt || '', loading: 'lazy' })
  img.addEventListener('error', () => { img.hidden = true })
  return img
}

function videoRow(v) {
  const frame = el('div', { class: 'sheet-inline', hidden: '' })
  const frameMsg = el('div', { class: 'meta' })
  const meta = [
    v.up || '—',
    v.duration ? `${Math.round(v.duration / 60)} 分钟` : '',
    v.view ? `${v.view} 播放` : '',
  ].filter(Boolean).join(' · ')
  return el('li', { class: 'video' },
    coverImg(v.bvid, v.title),
    el('div', { class: 'vbody' },
      el('a', { href: v.url || `https://www.bilibili.com/video/${v.bvid}`, target: '_blank', rel: 'noreferrer', text: v.title || v.bvid }),
      el('div', { class: 'meta', text: meta }),
      el('button', { class: 'small', type: 'button', text: '抽帧', onclick: () => loadSheet(v.bvid, frame, frameMsg) }),
      frame,
      frameMsg,
    ),
  )
}

function loadSheet(bvid, frame, msg) {
  frame.hidden = false
  clear(frame)
  msg.textContent = `正在取 ${bvid} 的抽帧…`
  const img = el('img', { class: 'sheet', alt: `${bvid} 的抽帧`, src: '/api/fish/sheet/' + encodeURIComponent(bvid) })
  img.addEventListener('load', () => { msg.textContent = '' })
  img.addEventListener('error', () => {
    img.remove()
    msg.textContent = '这集没有可用的抽帧（可能视频关掉了或抽帧失败）。'
  })
  frame.append(img)
}

async function loadVideos() {
  clear(SPEC.videosBody)
  SPEC.videosBody.append(hint('读取中…'))
  const r = await fish('history?days=' + SPEC.days)
  clear(SPEC.videosBody)
  if (!r.ok) { SPEC.videosBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const groups = r.data?.groups || []
  if (!groups.length) { SPEC.videosBody.append(emptyState('还没看过什么')); return }
  groups.forEach((g, i) => {
    const items = g.items || []
    SPEC.videosBody.append(el('details', i === 0 ? { open: '' } : {},
      el('summary', { text: `${g.date} · ${items.length} 条` }),
      el('ul', { class: 'videos' }, ...items.map(videoRow)),
    ))
  })
}

function commentRow(row) {
  const rpid = row.rpid || row.rootRpid
  const body = el('div', { class: 'quote', text: row.text || '（这条没有存正文，可现取）' })
  const actions = el('div', { class: 'row' })
  if (!row.text) {
    const read = el('button', {
      class: 'small',
      type: 'button',
      text: '读正文',
      onclick: async () => {
        read.disabled = true
        body.textContent = '现取中…'
        const r = await fish('comment-body?bvid=' + encodeURIComponent(row.bvid) + '&rpid=' + encodeURIComponent(rpid))
        if (!r.ok) { body.textContent = errorText(r); body.className = 'quote bad'; read.disabled = false; return }
        const d = r.data || {}
        body.textContent = d.text || d.message || '这条读不到正文'
        body.className = 'quote'
        read.remove()
      },
    })
    actions.append(read)
  }
  return el('li', {},
    el('div', { class: 'meta' },
      `${row.kind === 'reply' ? '回复' : '评论'} · ${fmtTime(row.at)} · `,
      el('a', { href: row.url || `https://www.bilibili.com/video/${row.bvid}`, target: '_blank', rel: 'noreferrer', text: row.bvid }),
    ),
    body,
    actions,
  )
}

async function loadComments() {
  clear(SPEC.commentsBody)
  SPEC.commentsBody.append(hint('读取中…'))
  const r = await fish('footprint?days=30')
  clear(SPEC.commentsBody)
  if (!r.ok) { SPEC.commentsBody.append(el('div', { class: 'bad', text: errorText(r) })); return }
  const c = r.data?.comments || {}
  const rows = c.rows || []
  SPEC.comments.setMeta(c.total ?? rows.length, rows.length ? 'ok' : '')
  SPEC.commentsMsg.textContent = rows.length ? `最近 30 天 ${rows.length} 条` : ''
  if (!rows.length) { SPEC.commentsBody.append(emptyState('她还没在 B 站发过评论')); return }
  // /footprint 的评论已经是新到旧，不要再倒一次。
  SPEC.commentsBody.append(el('ul', { class: 'plain' }, ...rows.map(commentRow)))
}

async function updateBadge(ctx) {
  const r = await fish('bili/status')
  if (!ctx?.setBadge) return
  ctx.setBadge('bili', !r.ok ? 'bad' : (r.data?.installed === false ? 'bad' : r.data?.cooling ? 'warn' : 'ok'))
}

async function load(ctx) {
  await Promise.all([loadVideos(), loadComments(), updateBadge(ctx)])
}

// ---------- 页面契约 ----------

export const biliFootprint = {
  id: 'bili-footprint',
  nav: 'bili',
  slug: 'footprint',
  label: '足迹',
  order: 20,
  readonly: true,

  enter(root, ctx) {
    if (!SPEC.built) { build(root); SPEC.built = true }
    SPEC.daysPick.value = String(SPEC.days)
    load(ctx)
  },

  leave() {},
}
