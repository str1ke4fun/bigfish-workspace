import { contextBridge, ipcRenderer } from 'electron'

type Unsubscribe = () => void

const bridge = {
  onState(handler: (state: unknown) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown): void => handler(state)
    ipcRenderer.on('pet:state', listener)
    return () => {
      ipcRenderer.removeListener('pet:state', listener)
    }
  },

  onAction(handler: (motion: string) => void): Unsubscribe {
    const listener = (_event: Electron.IpcRendererEvent, motion: string): void => handler(motion)
    ipcRenderer.on('pet:action', listener)
    return () => {
      ipcRenderer.removeListener('pet:action', listener)
    }
  },

  setIgnoreMouse(ignore: boolean): void {
    ipcRenderer.send('pet:ignore-mouse', Boolean(ignore))
  },

  /** 渲染进程已订阅 pet:state；主进程收到后补发最近一次缓存状态。 */
  ready(): void {
    ipcRenderer.send('pet:ready')
  },

  requestAction(motion: string): void {
    ipcRenderer.send('pet:action-request', motion)
  },

  /** 把用户的一句话交给主进程请求 /api/fish/say，返回 { ok, herReply, note }。 */
  requestChat(text: string): Promise<{ ok: boolean; herReply: string; note: string }> {
    return ipcRenderer.invoke('pet:chat', text)
  },
}

contextBridge.exposeInMainWorld('petBridge', bridge)
