// P0 临时：把旧页面模块适配成统一的 page 契约。
// 同一份旧模块被多个页签复用时，靠同一个 host 共用挂载点，
// 旧模块内部的 `built` 标记才不会各建一份或落空。
export function legacyPage({ id, nav, slug, label, order, source, host }) {
  return {
    id,
    nav,
    slug,
    label,
    order,
    ...(host ? { host } : {}),
    enter(root) { source.enter(root) },
    leave() { source.leave?.() },
  }
}
