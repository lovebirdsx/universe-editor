import type { BrowserWindow } from 'electron'
import type { IDisposable } from '@universe-editor/platform'

// 监听 DevTools 开关，变化时回调 onChange。当前是否打开由调用方实时读
// win.webContents.isDevToolsOpened() 取得。
export function observeDevToolsState(win: BrowserWindow, onChange: () => void): IDisposable {
  const onOpened = (): void => onChange()
  const onClosed = (): void => onChange()
  win.webContents.on('devtools-opened', onOpened)
  win.webContents.on('devtools-closed', onClosed)
  return {
    dispose() {
      if (win.isDestroyed()) return
      win.webContents.removeListener('devtools-opened', onOpened)
      win.webContents.removeListener('devtools-closed', onClosed)
    },
  }
}
