/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Editor input for the full-screen Agent session view. One input per Session
 *  in AcpSessionService; the React component looks the session up by id.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

export class AcpSessionEditorInput extends EditorInput {
  static readonly TYPE_ID = 'acp.session'

  constructor(readonly sessionId: string) {
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
    return JSON.stringify({ sessionId: this.sessionId })
  }

  static deserialize(data: unknown): AcpSessionEditorInput | null {
    if (typeof data !== 'string') return null
    try {
      const parsed = JSON.parse(data) as { sessionId?: unknown }
      if (typeof parsed.sessionId !== 'string') return null
      return new AcpSessionEditorInput(parsed.sessionId)
    } catch {
      return null
    }
  }
}
