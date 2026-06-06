/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Git Graph editor input.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'

const GIT_GRAPH_URI = URI.from({ scheme: 'universe', path: '/gitGraph' })

export class GitGraphEditorInput extends EditorInput {
  static readonly TYPE_ID = 'gitGraph'

  static deserialize(): GitGraphEditorInput {
    return new GitGraphEditorInput()
  }

  get typeId(): string {
    return GitGraphEditorInput.TYPE_ID
  }

  get resource(): URI {
    return GIT_GRAPH_URI
  }

  getName(): string {
    return 'Git Graph'
  }
}
