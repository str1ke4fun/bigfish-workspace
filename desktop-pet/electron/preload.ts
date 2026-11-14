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
