/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Editor input for the full-screen Agent session view. One input per Session
 *  in AcpSessionService; the React component looks the session up by id.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

export class AcpSessionEditorInput extends EditorInput {
  static readonly TYPE_ID = 'acp.session'

  /**
   * `agentId` is captured at construction so a stale serialized input — left
   * over from a previous run after the agent subprocess has died — can offer
   * a reconnect button against the right agent without us guessing.
   *
   * `historyId` ties the input to a row in AcpSessionHistoryService. The local
   * `sessionId` (e.g. `s1`) is regenerated on every editor restart and is
   * therefore useless for resuming — `historyId` is the durable handle the
   * editor uses to call `resumeSession()` after restart.
   */
  constructor(
    readonly sessionId: string,
    readonly agentId?: string,
    readonly historyId?: string,
  ) {
    super()
  }

  override get typeId(): string {
    return AcpSessionEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'universe', path: `/acp/session/${this.sessionId}` })
  }

  override getName(): string {
    return `Agent · ${this.sessionId}`
  }

  override serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      ...(this.agentId !== undefined ? { agentId: this.agentId } : {}),
      ...(this.historyId !== undefined ? { historyId: this.historyId } : {}),
    })
  }

  static deserialize(data: unknown): AcpSessionEditorInput | null {
    if (typeof data !== 'string') return null
    try {
      const parsed = JSON.parse(data) as {
        sessionId?: unknown
        agentId?: unknown
        historyId?: unknown
      }
      if (typeof parsed.sessionId !== 'string') return null
      const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : undefined
      const historyId = typeof parsed.historyId === 'string' ? parsed.historyId : undefined
      return new AcpSessionEditorInput(parsed.sessionId, agentId, historyId)
    } catch {
      return null
    }
  }
}
