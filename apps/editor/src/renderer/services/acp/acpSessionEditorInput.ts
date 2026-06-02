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
  localize,
  URI,
  type IDialogService,
  type IDisposable,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionService } from './acpSessionService.js'
import { IAcpSessionHistoryService } from './acpSessionHistory.js'
import { agentIconId } from './acpAgentRegistry.js'
import { resolveLiveSessionTitle, truncateSessionTitle } from './acpSessionTitle.js'

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
    initialTitle: string | undefined,
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
  ) {
    super()
    this._resource = URI.from({ scheme: 'universe', path: `/acp/session/${sessionId}` })
    this._lastTitle =
      initialTitle !== undefined && initialTitle.length > 0
        ? truncateSessionTitle(initialTitle)
        : this._computeTitle()
    // Watch live session title + history entry title so renames + resumed
    // sessions update the tab label without manual refresh. The autorun fires
    // synchronously once; we only emit onDidChangeLabel on actual changes.
    this._titleSub = autorun((r) => {
      // Subscribe to entries so history-side renames also trigger us.
      this._history.entries.read(r)
      // history.title 优先于 live.title——后者是构造时锁定的死字符串，rename 后并不会更新。
      // 没拿到 title 时不要回落到 sessionId 覆盖构造期写入的 initialTitle / _computeTitle 结果。
      const title = resolveLiveSessionTitle(this._history, this._sessions, this.sessionId)
      if (title === undefined) return
      const truncated = truncateSessionTitle(title)
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

  override getIconId(): string {
    return agentIconId(this.agentId)
  }

  override async confirmClose(dialogService: IDialogService): Promise<boolean> {
    const session = this._sessions.getById(this.sessionId)
    const status = session?.status.get()
    if (status !== 'running' && status !== 'connecting') return true
    const result = await dialogService.confirm({
      message: localize('acp.confirmClose.message', 'Session "{title}" is still running.', {
        title: session?.title ?? this.getName(),
      }),
      detail: localize('acp.confirmClose.detail', 'Closing it will stop the running agent.'),
      primaryButton: localize('acp.confirmClose.close', 'Close'),
      cancelButton: localize('dialog.default.cancel', 'Cancel'),
      type: 'warning',
    })
    return result.confirmed
  }

  private _computeTitle(): string {
    const raw =
      resolveLiveSessionTitle(this._history, this._sessions, this.sessionId) ?? this.sessionId
    return truncateSessionTitle(raw)
  }

  override serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
      title: this._lastTitle,
    })
  }

  static deserialize(data: unknown, accessor?: ServicesAccessor): AcpSessionEditorInput | null {
    if (typeof data !== 'string' || !accessor) return null
    try {
      const parsed = JSON.parse(data) as {
        sessionId?: unknown
        agentId?: unknown
        title?: unknown
      }
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return null
      const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : undefined
      const title = typeof parsed.title === 'string' ? parsed.title : undefined
      const inst = accessor.get(IInstantiationService)
      return inst.createInstance(AcpSessionEditorInput, parsed.sessionId, agentId, title)
    } catch {
      return null
    }
  }
}
