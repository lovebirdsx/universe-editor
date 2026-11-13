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

import { Emitter, type Event, type RunningSessionsShutdownInfo } from '@universe-editor/platform'
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

/**
 * Complete live-session snapshot for the `--agent-sessions` CLI. Unlike
 * {@link SessionSwitcherMainService.getAllSessions}, failures are surfaced:
 * a caller deciding whether it is safe to quit must not treat a timed-out
 * window as "no sessions".
 */
export interface AgentSessionsQueryResult {
  readonly windowCount: number
  readonly failedWindows: readonly number[]
  readonly sessions: readonly SessionSummary[]
}

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
    return (await this.queryAgentSessions()).sessions
  }

  /** Snapshot for the `--agent-sessions` CLI; keeps per-window failures visible. */
  async queryAgentSessions(): Promise<AgentSessionsQueryResult> {
    const entries = [...this._windows.entries()]
    const settled = await Promise.allSettled(
      entries.map(([, entry]) =>
        withTimeout(entry.rendererSessions.listSessions(), LIST_TIMEOUT_MS),
      ),
    )
    const sessions: SessionSummary[] = []
    const failedWindows: number[] = []
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      const [windowId, entry] = entries[i]!
      if (outcome.status !== 'fulfilled') {
        failedWindows.push(windowId)
        continue
      }
      const workspaceName = entry.getWorkspaceName()
      for (const s of outcome.value) {
        sessions.push({ ...s, windowId, workspaceName })
      }
    }
    return { windowCount: entries.length, failedWindows, sessions }
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

  /**
   * Latest reported counts for one window (zeros until its renderer reports).
   * Synchronous because background mode asks inside a synchronous close/quit
   * decision; the value comes from the in-memory map, not a renderer round-trip.
   */
  getWindowSessionCounts(windowId: number): SessionStatusCounts {
    return this._counts.get(windowId) ?? { running: 0, ask: 0 }
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

/**
 * Group running sessions by owning window for the quit confirmation copy. The
 * prompting window gets its own count; every other window with running work is
 * listed so the user can tell which projects the quit would interrupt.
 * `skipSessionIds` exempts sessions the quit initiator explicitly named (CLI
 * `--quit` from the refresh skill) — they belong to the caller and are expected
 * to be interrupted; every other session still counts.
 */
export function summarizeRunningSessionsForPrompt(
  sessions: readonly SessionSummary[],
  promptWindowId: number,
  skipSessionIds: readonly string[] = [],
): RunningSessionsShutdownInfo {
  const skip = new Set(skipSessionIds)
  let promptWindowCount = 0
  const otherWindows = new Map<number, { workspaceName: string; count: number }>()
  for (const session of sessions) {
    // 'background' = turn settled but run_in_background tasks still executing;
    // quitting kills the agent process and that work with it, so count it.
    if (session.status !== 'running' && session.status !== 'background') continue
    if (
      skip.has(session.sessionId) ||
      (session.agentSessionId !== undefined && skip.has(session.agentSessionId))
    ) {
      continue
    }
    if (session.windowId === promptWindowId) {
      promptWindowCount++
      continue
    }
    const entry = otherWindows.get(session.windowId)
    if (entry) entry.count++
    else otherWindows.set(session.windowId, { workspaceName: session.workspaceName, count: 1 })
  }
  return {
    promptWindowCount,
    otherWindows: [...otherWindows.values()].sort((a, b) =>
      a.workspaceName.localeCompare(b.workspaceName),
    ),
  }
}
