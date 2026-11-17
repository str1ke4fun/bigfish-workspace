import { contextBridge, ipcRenderer } from 'electron'

type Unsubscribe = () => void
type PetActionMessage = { motion: string } | { action: string }

interface PetActionCatalogMetadata {
  id: string
  label: string
  group: string
}

interface PetActionCatalogEntry extends PetActionCatalogMetadata {
  anim?: string
  seq?: string[]
  loop: boolean
}

interface PetActionReloadResult {
  ok: boolean
  actions: PetActionCatalogMetadata[]
  error?: string
  stale?: boolean
}

const bridge = {
  onState(handler: (state: unknown) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => handler(state)
    ipcRenderer.on('pet:state', listener)
    return () => {
      ipcRenderer.removeListener('pet:state', listener)
    }
  },

  /** 新主进程发 union；旧主进程/调用方仍可能发纯 motion 字符串。 */
  onAction(handler: (payload: PetActionMessage | string) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, payload: PetActionMessage | string): void => handler(payload)
    ipcRenderer.on('pet:action', listener)
    return () => {
      ipcRenderer.removeListener('pet:action', listener)
    }
  },

  /** 主进程从磁盘载入/重载后的动作目录；启动早于订阅时用 getActionCatalog 主动拉。 */
  onActionCatalog(handler: (catalog: PetActionCatalogEntry[]) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, catalog: PetActionCatalogEntry[]): void => handler(catalog)
    ipcRenderer.on('pet:action-catalog', listener)
    return () => {
      ipcRenderer.removeListener('pet:action-catalog', listener)
    }
  },

  getActionCatalog(): Promise<PetActionCatalogEntry[]> {
    return ipcRenderer.invoke('pet:get-action-catalog')
  },

  /** 菜单 stop、重新载入或 skin 切换时，主进程要求当前播放 generation 失效。 */
  onActionStop(handler: () => void): Unsubscribe {
    const listener = (): void => handler()
    ipcRenderer.on('pet:action-stop', listener)
    return () => {
      ipcRenderer.removeListener('pet:action-stop', listener)
    }
  },

  onActionError(handler: (error: { why: string }) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, error: { why: string }): void => handler(error)
    ipcRenderer.on('pet:action-error', listener)
    return () => {
      ipcRenderer.removeListener('pet:action-error', listener)
    }
  },

  reloadActions(): Promise<PetActionReloadResult> {
    return ipcRenderer.invoke('pet:actions-reload')
  },

  setIgnoreMouse(ignore: boolean): void {
    ipcRenderer.send('pet:ignore-mouse', Boolean(ignore))
  },

  /** 渲染进程已订阅 pet:state；主进程收到后补发最近一次缓存状态。 */
  ready(): void {
    ipcRenderer.send('pet:ready')
  },

  requestAction(payload: PetActionMessage | string): void {
    ipcRenderer.send('pet:action-request', payload)
  },

  /** 当前宠物尺寸（身体宽度 px），用于首帧渲染。 */
  getSize(): Promise<number> {
    return ipcRenderer.invoke('pet:get-size')
  },

  /** 右键「大小」改了尺寸后，主进程推新值过来。 */
  onSize(handler: (size: number) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, size: number): void => handler(size)
    ipcRenderer.on('pet:size', listener)
    return () => {
      ipcRenderer.removeListener('pet:size', listener)
    }
  },

  /** 气泡外观（透明度/宽度）：首帧主动拉，之后右键或工作台改了会推送。 */
  getLook(): Promise<{ opacity: number; width: number }> {
    return ipcRenderer.invoke('pet:get-look')
  },

  onLook(handler: (look: { opacity: number; width: number }) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, look: { opacity: number; width: number }): void => handler(look)
    ipcRenderer.on('pet:look', listener)
    return () => {
      ipcRenderer.removeListener('pet:look', listener)
    }
  },

  /** 服务端设置里的皮肤变化后，主进程把校验过的 config 与素材基地址推过来。 */
  onSkin(handler: (skin: unknown) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, skin: unknown): void => handler(skin)
    ipcRenderer.on('pet:skin', listener)
    return () => {
      ipcRenderer.removeListener('pet:skin', listener)
    }
  },

  /** 挂载时主动拉取最近皮肤；首推早于订阅时不会丢。 */
  getSkin(): Promise<unknown> {
    return ipcRenderer.invoke('pet:get-skin')
  },

  /** 皮肤被拒绝（坏 JSON、缺动画文件、读盘失败）时推来 { id, why }，渲染进程弹提示。 */
  onSkinError(handler: (error: unknown) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, error: unknown): void => handler(error)
    ipcRenderer.on('pet:skin-error', listener)
    return () => {
      ipcRenderer.removeListener('pet:skin-error', listener)
    }
  },

  /** 在宠物身体上按下/松开时调用，主进程负责跟着光标移动窗口。 */
  startDrag(): void {
    ipcRenderer.send('pet:drag-start')
  },

  endDrag(): void {
    ipcRenderer.send('pet:drag-end')
  },

  /** 把用户的一句话交给主进程请求 /api/fish/say，返回 { ok, herReply, note }。 */
  requestChat(text: string): Promise<{ ok: boolean; herReply: string; note: string }> {
    return ipcRenderer.invoke('pet:chat', text)
  },
}

contextBridge.exposeInMainWorld('petBridge', bridge)
