import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { registerIpcHandlers } from './ipc.js'
import { IpcChannel } from '../shared/ipc-channels.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createWindow(): void {
  const isMac = process.platform === 'darwin'

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Universe Editor',
    ...(isMac
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 8, y: 8 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.on('maximize', () => win.webContents.send(IpcChannel.WindowMaximizeChange, true))
  win.on('unmaximize', () => win.webContents.send(IpcChannel.WindowMaximizeChange, false))

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
