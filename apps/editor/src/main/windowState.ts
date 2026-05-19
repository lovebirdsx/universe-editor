import { screen, type BrowserWindow } from 'electron'
import type { Storage } from './storage.js'

const STORAGE_KEY = 'window.state'
const SAVE_DEBOUNCE_MS = 500

interface IWindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
  isFullscreen: boolean
  displayId: number
}

function isVisibleOnDisplays(state: IWindowState): boolean {
  const displays = screen.getAllDisplays()
  return displays.some(({ workArea: wa }) => {
    const visibleLeft = Math.max(state.x, wa.x)
    const visibleTop = Math.max(state.y, wa.y)
    const visibleRight = Math.min(state.x + state.width, wa.x + wa.width)
    const visibleBottom = Math.min(state.y + state.height, wa.y + wa.height)
    return (
      visibleRight - visibleLeft >= 64 &&
      visibleBottom - visibleTop >= 64 &&
      visibleTop < wa.y + wa.height - 8
    )
  })
}

export async function loadWindowState(storage: Storage): Promise<IWindowState | undefined> {
  const raw = await storage.get<IWindowState>(STORAGE_KEY)
  if (!raw || typeof raw !== 'object') return undefined

  const { x, y, width, height, isMaximized, isFullscreen, displayId } = raw
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    width < 200 ||
    height < 100
  ) {
    return undefined
  }

  const state: IWindowState = {
    x,
    y,
    width,
    height,
    isMaximized: !!isMaximized,
    isFullscreen: !!isFullscreen,
    displayId,
  }

  // 最大化/全屏时跳过边界校验，由 displayId 负责恢复到正确显示器
  if (!state.isMaximized && !state.isFullscreen && !isVisibleOnDisplays(state)) {
    return undefined
  }

  return state
}

// 在 ready-to-show 中调用：把最大化/全屏状态应用到窗口
export function applyWindowState(win: BrowserWindow, state: IWindowState): void {
  if (state.isFullscreen) {
    win.setFullScreen(true)
    return
  }

  if (state.isMaximized) {
    // 如果保存了 displayId，且正常还原位置不在目标显示器上，先移过去再最大化
    if (state.displayId !== undefined) {
      const targetDisplay = screen.getAllDisplays().find((d) => d.id === state.displayId)
      if (targetDisplay) {
        const normalCenter = { x: state.x + state.width / 2, y: state.y + state.height / 2 }
        const normalDisplay = screen.getDisplayNearestPoint(normalCenter)
        if (normalDisplay.id !== targetDisplay.id) {
          win.setPosition(
            Math.round(targetDisplay.bounds.x + (targetDisplay.bounds.width - state.width) / 2),
            Math.round(targetDisplay.bounds.y + (targetDisplay.bounds.height - state.height) / 2),
          )
        }
      }
    }
    win.maximize()
  }
}

export function trackWindowState(win: BrowserWindow, storage: Storage): void {
  const initial = win.getNormalBounds()
  let savedState: IWindowState = {
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    isMaximized: win.isMaximized(),
    isFullscreen: win.isFullScreen(),
    displayId: screen.getDisplayNearestPoint({
      x: Math.round(initial.x + initial.width / 2),
      y: Math.round(initial.y + initial.height / 2),
    }).id,
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const saveNow = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    void storage.set(STORAGE_KEY, savedState)
  }

  const scheduleSave = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS)
  }

  const getDisplayId = (): number => {
    const b = win.getBounds()
    return screen.getDisplayNearestPoint({
      x: Math.round(b.x + b.width / 2),
      y: Math.round(b.y + b.height / 2),
    }).id
  }

  // 始终用 getNormalBounds() 拿还原尺寸，即使当前是最大化状态也能正确追踪位置
  const updateBoundsAndDisplay = (): void => {
    const normal = win.getNormalBounds()
    savedState = {
      ...savedState,
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      displayId: getDisplayId(),
    }
  }

  win.on('resize', () => {
    updateBoundsAndDisplay()
    scheduleSave()
  })

  win.on('move', () => {
    updateBoundsAndDisplay()
    scheduleSave()
  })

  win.on('maximize', () => {
    savedState = { ...savedState, isMaximized: true, displayId: getDisplayId() }
    scheduleSave()
  })

  win.on('unmaximize', () => {
    const normal = win.getNormalBounds()
    savedState = {
      ...savedState,
      isMaximized: false,
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      displayId: getDisplayId(),
    }
    scheduleSave()
  })

  win.on('enter-full-screen', () => {
    savedState = { ...savedState, isFullscreen: true, displayId: getDisplayId() }
    scheduleSave()
  })

  win.on('leave-full-screen', () => {
    const normal = win.getNormalBounds()
    savedState = {
      ...savedState,
      isFullscreen: false,
      x: normal.x,
      y: normal.y,
      width: normal.width,
      height: normal.height,
      displayId: getDisplayId(),
    }
    scheduleSave()
  })

  win.on('close', saveNow)
}
