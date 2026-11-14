/**
 * 皮肤应用决策的纯逻辑。
 *
 * 这个文件刻意不 import 任何 Node/Electron 模块：主进程、渲染进程和
 * `node --test` 都能直接使用同一份判定，避免渲染进程为了一个函数
 * 把 `node:fs` 打进浏览器包。
 */

/** 判断是否需要应用一份皮肤所需的最小信息。 */
export interface SkinRef {
  id: string
  revision: number
}

/**
 * 渲染进程是否要应用一份皮肤。
 *
 * 运行期失败过的皮肤会记成墓碑 `{ id, revision }`：同一份 revision 的重放
 * （`pet:ready` / `getSkin` 补发）必须忽略，否则回退会被立刻撤销并形成
 * apply → onError → rollback → resend 的循环。只有换成别的皮肤，或用户重新选中
 * 同一皮肤产生的新 revision（`incoming.revision > failed.revision`）才重新应用。
 */
export function resolveSkinApply(
  current: SkinRef | null,
  incoming: SkinRef,
  failed: SkinRef | null,
): 'apply' | 'ignore' {
  if (failed && failed.id === incoming.id && incoming.revision <= failed.revision) return 'ignore'
  if (current && current.id === incoming.id && current.revision === incoming.revision) return 'ignore'
  return 'apply'
}
