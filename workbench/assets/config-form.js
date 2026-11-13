// 共享配置分组表单：每组只提交自己那几个顶层键，存完由页面重新 GET /config 回读。
// Null-safe：缺失的键显示空值，类型不认识就退回文本框，不抛错。
// `lastShown` / `lastScanAt` 这类运行期状态永远不进表单。
import { el, clear, postFish, writeError, parseList } from './lib.js'

const HIDDEN = new Set(['lastShown', 'lastScanAt'])

function getPath(source, path) {
  let node = source
  for (const key of path.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

function setPath(target, path, value) {
  const keys = path.split('.')
  let node = target
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]
    if (!node[key] || typeof node[key] !== 'object') node[key] = {}
    node = node[key]
  }
  node[keys[keys.length - 1]] = value
  return target
}

function control(key, value, label) {
  const text = label || key
  if (typeof value === 'boolean') {
    const input = el('input', { type: 'checkbox' })
    input.checked = value
    return { node: el('label', { class: 'chk' }, input, el('span', { text })), read: () => input.checked }
  }
  if (typeof value === 'number') {
    const input = el('input', { type: 'number', step: '1', value: String(value) })
    return { node: el('label', { class: 'field' }, el('span', { class: 'meta', text }), input), read: () => Number(input.value) }
  }
  if (Array.isArray(value)) {
    const input = el('input', { type: 'text', value: value.join(', ') })
    return { node: el('label', { class: 'field' }, el('span', { class: 'meta', text }), input), read: () => parseList(input.value, value) }
  }
  const input = el('input', { type: 'text', value: value === null || value === undefined ? '' : String(value) })
  return { node: el('label', { class: 'field' }, el('span', { class: 'meta', text }), input), read: () => input.value }
}

/**
 * 一组配置卡。
 * @param {{ title: string, keys: string[], labels?: Record<string,string>, note?: string, onSaved?: Function }} opts
 * @returns {{ root: HTMLElement, setConfig: Function, setStatus: Function }}
 */
export function configGroup({ title, keys, labels = {}, note = '', onSaved } = {}) {
  const status = el('div', { class: 'meta' })
  const fields = el('div', { class: 'group-body' })
  let readers = []
  let loaded = false

  const save = el('button', {
    class: 'primary small',
    type: 'button',
    text: '保存这一组',
    onclick: async () => {
      save.disabled = true
      setStatus('保存中…')
      try {
        const patch = {}
        for (const { key, read } of readers) setPath(patch, key, read())
        const r = await postFish('config', patch)
        if (!r.ok) { setStatus(writeError(r), 'bad'); return }
        if (r.data?.ok === false) { setStatus(`没存上：${r.data.error || '上游拒绝'}`, 'bad'); return }
        setStatus('已保存。', 'ok')
        await onSaved?.()
      } catch (err) {
        setStatus(`没成：${err?.message || err}`, 'bad')
      } finally {
        // 读不到配置时保持禁用：空表单保存会把这一组写成空值。
        save.disabled = !loaded
      }
    },
  })
  // 首次读到 /config 之前不给保存，避免把空值写回去。
  save.disabled = true

  const root = el('details', { class: 'rule-layer group' },
    el('summary', {}, el('b', { text: title })),
    note ? el('div', { class: 'meta', text: note }) : null,
    fields,
    el('div', { class: 'row' }, save),
    status,
  )

  function setStatus(text, level = '') {
    status.textContent = text || ''
    status.className = 'meta' + (level ? ' ' + level : '')
  }

  function setConfig(config) {
    if (!config || typeof config !== 'object') return
    clear(fields)
    readers = []
    for (const key of keys) {
      if (HIDDEN.has(key)) continue
      const value = getPath(config, key)
      const c = control(key, value, labels[key])
      readers.push({ key, read: c.read })
      fields.append(c.node)
    }
    loaded = true
    save.disabled = false
  }

  return { root, setConfig, setStatus }
}
