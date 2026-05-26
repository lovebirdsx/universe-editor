/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DiffEditorInput — a transient, read-only EditorInput that drives the Monaco
 *  diff editor. Holds original and modified text for a single file.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'

export class DiffEditorInput extends EditorInput {
  static readonly TYPE_ID = 'diff'

  constructor(
    private readonly _originalUri: URI,
    private readonly _originalContent: string,
    private readonly _modifiedContent: string,
  ) {
    super()
  }

  override get typeId(): string {
    return DiffEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'diff', path: this._originalUri.path })
  }

  override get id(): string {
    return `diff:${this._originalUri.toString()}`
  }

  override getName(): string {
    return `${basenameOfResource(this._originalUri)} (Diff)`
  }

  get originalUri(): URI {
    return this._originalUri
  }

  get originalContent(): string {
    return this._originalContent
  }

  get modifiedContent(): string {
    return this._modifiedContent
  }
}
