/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionSwitcherMainService — application singleton that aggregates live
 *  sessions across every window for the cross-window Alt+S switcher.
 *
 *  Sessions live in each window's renderer; this service holds, per window, a
 *  reverse proxy to that renderer (IRendererSessionsService) plus thunks to read
 *  its workspace name and to focus it. `getAllSessions` fans out and tags each
 *  reported session with its windowId + workspaceName; `reveal` focuses the
 *  owning window and asks its renderer to open the session.
 *--------------------------------------------------------------------------------------------*/

import type {
  IRendererSessionsService,
  ISessionSwitcherService,
  SessionSummary,
} from '../../../shared/ipc/sessionSwitcher.js'

/** Per-window registration handed in by WindowMainService.createWindow. */
export interface SessionSwitcherWindowEntry {
  readonly rendererSessions: IRendererSessionsService
  /** Workspace folder name, or '' for an untitled window. */
  getWorkspaceName(): string
  focus(): void
}

/** Max wait for a single window's listSessions before it is skipped. */
const LIST_TIMEOUT_MS = 1500

export class SessionSwitcherMainService implements ISessionSwitcherService {
  declare readonly _serviceBrand: undefined

  private readonly _windows = new Map<number, SessionSwitcherWindowEntry>()

  registerWindow(windowId: number, entry: SessionSwitcherWindowEntry): void {
    this._windows.set(windowId, entry)
  }

  unregisterWindow(windowId: number): void {
    this._windows.delete(windowId)
  }

  async getAllSessions(): Promise<readonly SessionSummary[]> {
    const entries = [...this._windows.entries()]
    const settled = await Promise.allSettled(
      entries.map(([, entry]) =>
        withTimeout(entry.rendererSessions.listSessions(), LIST_TIMEOUT_MS),
      ),
    )
    const result: SessionSummary[] = []
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      if (outcome.status !== 'fulfilled') continue
      const [windowId, entry] = entries[i]!
      const workspaceName = entry.getWorkspaceName()
      for (const s of outcome.value) {
        result.push({ ...s, windowId, workspaceName })
      }
    }
    return result
  }

  async reveal(windowId: number, sessionId: string): Promise<void> {
    const entry = this._windows.get(windowId)
    if (!entry) return
    entry.focus()
    try {
      await entry.rendererSessions.reveal(sessionId)
    } catch {
      // Renderer unreachable / closing: focusing the window is still useful.
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('listSessions timed out')), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
