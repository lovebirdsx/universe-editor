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
 *
 *  It also aggregates live running/ask session counts: each window's renderer
 *  reports its local counts (via the window-scoped facade from
 *  `createWindowScopedSessionSwitcher`, which injects the windowId), and every
 *  change rebroadcasts the cross-window aggregate over `onDidChangeCounts` —
 *  that's what the title-bar agent pill shows.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from '@universe-editor/platform'
import type {
  IRendererSessionsService,
  ISessionSwitcherService,
  SessionStatusCounts,
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
  private readonly _counts = new Map<number, SessionStatusCounts>()
  private readonly _onDidChangeCounts = new Emitter<SessionStatusCounts>()
  readonly onDidChangeCounts: Event<SessionStatusCounts> = this._onDidChangeCounts.event

  registerWindow(windowId: number, entry: SessionSwitcherWindowEntry): void {
    this._windows.set(windowId, entry)
  }

  unregisterWindow(windowId: number): void {
    this._windows.delete(windowId)
    if (this._counts.delete(windowId)) this._broadcastCounts()
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

  /**
   * Record one window's live counts and rebroadcast the aggregate. `windowId`
   * is injected by the window-scoped facade (the wire signature only carries
   * `counts`); a call without it is a no-op.
   */
  reportSessionCounts(counts: SessionStatusCounts, windowId?: number): Promise<void> {
    if (windowId === undefined) return Promise.resolve()
    const prev = this._counts.get(windowId)
    if (prev && prev.running === counts.running && prev.ask === counts.ask) {
      return Promise.resolve()
    }
    this._counts.set(windowId, counts)
    this._broadcastCounts()
    return Promise.resolve()
  }

  getSessionCounts(): Promise<SessionStatusCounts> {
    return Promise.resolve(this._aggregateCounts())
  }

  private _broadcastCounts(): void {
    this._onDidChangeCounts.fire(this._aggregateCounts())
  }

  private _aggregateCounts(): SessionStatusCounts {
    let running = 0
    let ask = 0
    for (const counts of this._counts.values()) {
      running += counts.running
      ask += counts.ask
    }
    return { running, ask }
  }
}

/**
 * Bind the application singleton to the BrowserWindow serving one IPC channel,
 * injecting its windowId into reportSessionCounts (mirrors
 * createWindowScopedUpdateService).
 */
export function createWindowScopedSessionSwitcher(
  switcher: SessionSwitcherMainService,
  windowId: number,
): ISessionSwitcherService {
  return {
    _serviceBrand: undefined,
    onDidChangeCounts: switcher.onDidChangeCounts,
    getAllSessions: () => switcher.getAllSessions(),
    reveal: (targetWindowId, sessionId) => switcher.reveal(targetWindowId, sessionId),
    getSessionCounts: () => switcher.getSessionCounts(),
    reportSessionCounts: (counts) => switcher.reportSessionCounts(counts, windowId),
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
