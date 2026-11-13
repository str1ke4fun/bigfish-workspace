// 通道页共用的小东西：人工代操作确认、可勾的范围 chip。
// 动作日志由服务端 note() 写，前端不新增日志接口。
import { el } from '../lib.js'

/** 人工代操作前的二次确认。detail 只截 120 字，避免把长文塞进对话框。 */
export function confirmHuman(action, detail) {
  return confirm(`人工代操作：${action}${detail ? `\n\n${String(detail).slice(0, 120)}` : ''}`)
}

/** 说话范围里的 chip：复选框 + 标签 + id，勾选后回调。 */
export function scopeChip({ id, label, checked, onToggle }) {
  const root = el('label', { class: 'chip' + (checked ? ' on' : '') })
  const box = el('input', { type: 'checkbox' })
  box.checked = !!checked
  box.addEventListener('change', () => {
    root.classList.toggle('on', box.checked)
    onToggle?.(box.checked)
  })
  root.append(
    box,
    el('span', { text: label === undefined || label === null ? '' : String(label) }),
    el('span', { class: 'id', text: id === undefined || id === null ? '' : String(id) }),
  )
  return root
}

/** 从一块 chip 容器里读出勾中的 id。 */
export function picked(container) {
  return [...container.querySelectorAll('label.chip')]
    .filter((chip) => chip.querySelector('input')?.checked)
    .map((chip) => chip.querySelector('.id')?.textContent || '')
    .filter(Boolean)
}
