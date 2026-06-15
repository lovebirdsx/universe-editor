/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Virtual editor input for the graphical AI model manager (mirrors VSCode's
 *  "Manage Language Models" widget). Carries no state — the editor reads
 *  everything live from IAiModelService.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const AI_MODELS_URI = URI.from({ scheme: 'universe', path: '/aiModels' })

export class AiModelsEditorInput extends EditorInput {
  static readonly TYPE_ID = 'aiModels'

  override serialize(): string {
    return ''
  }

  static deserialize(): AiModelsEditorInput {
    return new AiModelsEditorInput()
  }

  override get typeId(): string {
    return AiModelsEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return AI_MODELS_URI
  }

  override getName(): string {
    return 'AI Models'
  }
}
