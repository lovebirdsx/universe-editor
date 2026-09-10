import { screen, type BrowserWindow, type Display } from 'electron'
import type { IDisposable } from '@universe-editor/platform'

const SAVE_DEBOUNCE_MS = 500

export interface IWindowState {
  x: number
  y: number
  width: number
  height: number
  isMaximized: boolean
  isFullscreen: boolean
  /** @deprecated 历史上用 Electron displayId 作显示器身份，但 id 会随会话漂移
   * (WSLg 下尤其明显)，改用 displayBounds 作身份。仍读取旧值向后兼容，
   * 但仅当 displayBounds 缺失时兜底。 */
  displayId: number
  /** 窗口所在显示器在保存时的 bounds(用作跨会话的显示器身份)。
   * 恢复时按"bounds 完全相等"在当前 displays 里找匹配；找不到就回退到
   * displayId,再找不到就按 (x,y) 中心点就近。 */
  displayBounds?: { x: number; y: number; width: number; height: number }
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

// 校验一份（可能来自持久化、未必可信的）窗口几何：尺寸下限 + 可见性。
// 最大化/全屏时跳过边界校验，由 displayBounds/displayId 负责恢复到正确显示器。
export function validateWindowState(raw: unknown): IWindowState | undefined {
  if (!raw || typeof raw !== 'object') return undefined

  const { x, y, width, height, isMaximized, isFullscreen, displayId, displayBounds } =
    raw as Record<string, unknown>
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
    displayId: typeof displayId === 'number' ? displayId : 0,
  }

  if (
    displayBounds &&
    typeof displayBounds === 'object' &&
    typeof (displayBounds as Record<string, unknown>).x === 'number' &&
    typeof (displayBounds as Record<string, unknown>).y === 'number' &&
    typeof (displayBounds as Record<string, unknown>).width === 'number' &&
    typeof (displayBounds as Record<string, unknown>).height === 'number'
  ) {
    const b = displayBounds as { x: number; y: number; width: number; height: number }
    state.displayBounds = { x: b.x, y: b.y, width: b.width, height: b.height }
  }

  if (!state.isMaximized && !state.isFullscreen && !isVisibleOnDisplays(state)) {
    return undefined
  }

  return state
}

function displayForBounds(win: BrowserWindow): Display {
  const b = win.getBounds()
  return screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  })
}

// 实时快照当前窗口几何。始终用 getNormalBounds() 拿还原尺寸，即使当前是最大化状态。
export function captureWindowState(win: BrowserWindow): IWindowState {
  const normal = win.getNormalBounds()
  const display = displayForBounds(win)
  return {
    x: normal.x,
    y: normal.y,
    width: normal.width,
    height: normal.height,
    isMaximized: win.isMaximized(),
    isFullscreen: win.isFullScreen(),
    displayId: display.id,
    displayBounds: { ...display.bounds },
  }
}

// 跨会话的显示器身份:优先按 displayBounds 精确匹配当前 displays(displayId 会漂移),
// 兜底再用旧 displayId。两者都失败返回 undefined,调用方按 state.x/y 就近。
function findTargetDisplay(state: IWindowState): Display | undefined {
  const all = screen.getAllDisplays()
  if (state.displayBounds) {
    const b = state.displayBounds
    const byBounds = all.find(
      (d) =>
        d.bounds.x === b.x &&
        d.bounds.y === b.y &&
        d.bounds.width === b.width &&
        d.bounds.height === b.height,
    )
    if (byBounds) return byBounds
  }
  return all.find((d) => d.id === state.displayId)
}

// 在 ready-to-show 中调用：把最大化/全屏状态应用到窗口
export function applyWindowState(win: BrowserWindow, state: IWindowState): void {
  if (state.isFullscreen) {
    win.setFullScreen(true)
    return
  }

  if (state.isMaximized) {
    // 找到目标显示器,若还原几何中心不在它上面,先 setPosition 居中过去再 maximize,
    // 否则 maximize 会落在 (state.x, state.y) 当前碰巧所在的显示器上。
    const targetDisplay = findTargetDisplay(state)
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
    win.maximize()
  }
}

// 监听窗口几何变化，debounce 后回调 onChange。返回 IDisposable 以解除监听与清理 timer。
export function trackWindowState(win: BrowserWindow, onChange: () => void): IDisposable {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleSave = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      onChange()
    }, SAVE_DEBOUNCE_MS)
  }

  // All listeners ignore their args, so the per-event handler signatures don't
  // matter — narrow to one literal to satisfy the overloaded on/removeListener.
  const events = [
    'resize',
    'move',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
  ] as const
  for (const e of events) win.on(e as 'resize', scheduleSave)

  // 关窗前立即落一笔（debounce 可能还没触发）
  const saveNow = (): void => {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    onChange()
  }
  win.on('close', saveNow)

  return {
    dispose() {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      if (win.isDestroyed()) return
      for (const e of events) win.removeListener(e as 'resize', scheduleSave)
      win.removeListener('close', saveNow)
    },
  }
}
