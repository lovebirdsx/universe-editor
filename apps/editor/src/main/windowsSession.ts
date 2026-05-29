import { basename } from 'node:path'
import { URI, type IWorkspace, type UriComponents } from '@universe-editor/platform'
import type { Storage } from './storage.js'
import { validateWindowState, type IWindowState } from './windowState.js'

export const WINDOWS_SESSION_STORAGE_KEY = 'workbench.windowsState'

interface PersistedWorkspace {
  readonly folder: UriComponents
  readonly name: string
}

// 持久化形态（写入 GLOBAL state.json）
export interface IPersistedWindow {
  readonly workspace: PersistedWorkspace | null
  readonly uiState: IWindowState | null
  readonly devToolsOpen: boolean
}

// 运行时形态（URI 已 revive，几何已校验）
export interface IRestoreWindow {
  readonly workspace: IWorkspace | null
  readonly uiState?: IWindowState
  readonly devToolsOpen: boolean
}

export function serializeWindow(
  workspace: IWorkspace | null,
  uiState: IWindowState | null,
  devToolsOpen: boolean,
): IPersistedWindow {
  return {
    workspace: workspace ? { folder: workspace.folder.toJSON(), name: workspace.name } : null,
    uiState,
    devToolsOpen,
  }
}

function reviveWorkspace(raw: PersistedWorkspace | null): IWorkspace | null {
  if (!raw || !raw.folder) return null
  const folder = URI.revive(raw.folder)
  if (!folder) return null
  return { folder, name: raw.name || basename(folder.fsPath) || folder.fsPath }
}

export async function loadSession(storage: Storage): Promise<IRestoreWindow[]> {
  const raw = await storage.get<IPersistedWindow[]>(WINDOWS_SESSION_STORAGE_KEY)
  if (!Array.isArray(raw)) return []
  return raw.map((entry): IRestoreWindow => {
    const uiState = validateWindowState(entry?.uiState)
    return {
      workspace: reviveWorkspace(entry?.workspace ?? null),
      ...(uiState ? { uiState } : {}),
      devToolsOpen: entry?.devToolsOpen === true,
    }
  })
}
