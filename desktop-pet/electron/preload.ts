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

  requestAction(motion: string): void {
    ipcRenderer.send('pet:action-request', motion)
  },
}

contextBridge.exposeInMainWorld('petBridge', bridge)
