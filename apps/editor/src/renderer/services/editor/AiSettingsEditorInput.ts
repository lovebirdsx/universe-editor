/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Virtual editor input for the graphical AI settings manager (mirrors VSCode's
 *  "Manage Language Models" widget). Carries no state — the editor reads
 *  everything live from IAiModelService.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const AI_SETTINGS_URI = URI.from({ scheme: 'universe', path: '/aiSettings' })

export class AiSettingsEditorInput extends EditorInput {
  static readonly TYPE_ID = 'aiSettings'

  override serialize(): string {
    return ''
  }

  static deserialize(): AiSettingsEditorInput {
    return new AiSettingsEditorInput()
  }

  override get typeId(): string {
    return AiSettingsEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return AI_SETTINGS_URI
  }

  override getName(): string {
    return 'AI Settings'
  }
}
