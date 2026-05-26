/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Editor input for the full-screen Agent session view. Keyed by the
 *  agent-issued `sessionId` — durable across editor restarts and identical
 *  to the id used by AcpSessionService / AcpSessionHistoryService.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  EditorInput,
  IInstantiationService,
  URI,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService } from './acpSessionService.js'
import { IAcpSessionHistoryService } from './acpSessionHistory.js'

const MAX_TITLE_LEN = 24

function truncateTitle(s: string): string {
  if (s.length <= MAX_TITLE_LEN) return s
  return `${s.slice(0, MAX_TITLE_LEN - 1)}…`
}

export class AcpSessionEditorInput extends EditorInput {
  static readonly TYPE_ID = 'acp.session'

  private readonly _resource: URI
  private _lastTitle: string
  private _titleSub: IDisposable | undefined

  /**
   * `agentId` is captured at construction so a stale serialized input — left
   * over from a previous run after the agent subprocess has died — can offer
   * a reconnect button against the right agent without us guessing.
   */
  constructor(
    readonly sessionId: string,
    readonly agentId: string | undefined,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
  ) {
    super()
    this._resource = URI.from({ scheme: 'universe', path: `/acp/session/${sessionId}` })
    this._lastTitle = this._computeTitle()
    // Watch live session title + history entry title so renames + resumed
    // sessions update the tab label without manual refresh. The autorun fires
    // synchronously once; we only emit onDidChangeLabel on actual changes.
    this._titleSub = autorun((r) => {
      const live = this._sessions.getById(this.sessionId)
      // Subscribe to entries so history-side renames also trigger us.
      this._history.entries.read(r)
      const title = live ? live.title : (this._history.get(this.sessionId)?.title ?? this.sessionId)
      const truncated = truncateTitle(title)
      if (truncated !== this._lastTitle) {
        this._lastTitle = truncated
        this._onDidChangeLabel.fire()
      }
    })
    this._register(this._titleSub)
  }

  override get typeId(): string {
    return AcpSessionEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  override getName(): string {
    return this._lastTitle
  }

  private _computeTitle(): string {
    const live = this._sessions.getById(this.sessionId)
    const raw = live?.title ?? this._history.get(this.sessionId)?.title ?? this.sessionId
    return truncateTitle(raw)
  }

  override serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
    })
  }

  static deserialize(data: unknown, accessor?: ServicesAccessor): AcpSessionEditorInput | null {
    if (typeof data !== 'string' || !accessor) return null
    try {
      const parsed = JSON.parse(data) as {
        sessionId?: unknown
        agentId?: unknown
      }
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return null
      const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : undefined
      const inst = accessor.get(IInstantiationService)
      return inst.createInstance(AcpSessionEditorInput, parsed.sessionId, agentId)
    } catch {
      return null
    }
  }
}
