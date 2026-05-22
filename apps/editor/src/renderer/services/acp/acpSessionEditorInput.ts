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
   */
  constructor(
    readonly sessionId: string,
    readonly agentId?: string,
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
    })
  }

  static deserialize(data: unknown): AcpSessionEditorInput | null {
    if (typeof data !== 'string') return null
    try {
      const parsed = JSON.parse(data) as { sessionId?: unknown; agentId?: unknown }
      if (typeof parsed.sessionId !== 'string') return null
      const agentId = typeof parsed.agentId === 'string' ? parsed.agentId : undefined
      return new AcpSessionEditorInput(parsed.sessionId, agentId)
    } catch {
      return null
    }
  }
}
