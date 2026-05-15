import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { installMainProtocolDispatcher } from './ipc/electronProtocol.js'
import { bootstrapWindowIpc, type SharedMainServices } from './ipc/registerMainServices.js'
import { MainStorageService } from './services/storage/storageMainService.js'
import { MainPingService } from './services/ping/pingMainService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Shared singletons created lazily on first window.
let sharedServices: SharedMainServices | null = null

function getSharedServices(): SharedMainServices {
  if (!sharedServices) {
    sharedServices = {
      storage: new MainStorageService(),
      ping: new MainPingService(),
    }
  }
  return sharedServices
}

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

  const ipc = bootstrapWindowIpc(win, getSharedServices())
  win.on('closed', () => ipc.dispose())

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

installMainProtocolDispatcher()

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
