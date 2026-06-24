/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Virtual editor input for the graphical Agent settings manager. Carries no
 *  state — the editor reads everything live from IClaudeConfigService
 *  (`~/.claude/settings.json`), shared with the built-in agent and the local CLI.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const AGENT_SETTINGS_URI = URI.from({ scheme: 'universe', path: '/agentSettings' })

export class AgentSettingsEditorInput extends EditorInput {
  static readonly TYPE_ID = 'agentSettings'

  override serialize(): string {
    return ''
  }

  static deserialize(): AgentSettingsEditorInput {
    return new AgentSettingsEditorInput()
  }

  override get typeId(): string {
    return AgentSettingsEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return AGENT_SETTINGS_URI
  }

  override getName(): string {
    return 'Agent Settings'
  }
}
