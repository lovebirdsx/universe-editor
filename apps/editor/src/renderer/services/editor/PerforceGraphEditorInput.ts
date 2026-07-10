/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Perforce Graph editor input.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const PERFORCE_GRAPH_URI = URI.from({ scheme: 'universe', path: '/perforceGraph' })

export class PerforceGraphEditorInput extends EditorInput {
  static readonly TYPE_ID = 'perforceGraph'

  static deserialize(): PerforceGraphEditorInput {
    return new PerforceGraphEditorInput()
  }

  get typeId(): string {
    return PerforceGraphEditorInput.TYPE_ID
  }

  get resource(): URI {
    return PERFORCE_GRAPH_URI
  }

  getName(): string {
    return 'Perforce Graph'
  }
}
