/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MarkdownPreviewInput — a virtual EditorInput that renders a markdown file as
 *  formatted HTML. It carries the source `file:` URI; the live text is read from
 *  the shared Monaco model (so the preview tracks unsaved edits) or, when the
 *  source is not open, from disk by the MarkdownPreviewEditor component.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, type UriComponents } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'

interface ISerializedMarkdownPreview {
  readonly sourceResource: UriComponents
}

export class MarkdownPreviewInput extends EditorInput {
  static readonly TYPE_ID = 'markdown.preview'

  constructor(private readonly _sourceUri: URI) {
    super()
  }

  override get typeId(): string {
    return MarkdownPreviewInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'markdown-preview', path: this._sourceUri.path })
  }

  /** Unique per source file so the same file never opens two preview tabs. */
  override get id(): string {
    return `markdown-preview:${this._sourceUri.toString()}`
  }

  override getName(): string {
    return `预览 ${basenameOfResource(this._sourceUri)}`
  }

  get sourceUri(): URI {
    return this._sourceUri
  }

  override serialize(): ISerializedMarkdownPreview {
    return { sourceResource: this._sourceUri.toJSON() }
  }

  static deserialize(data: unknown): MarkdownPreviewInput | null {
    const d = data as ISerializedMarkdownPreview | null
    if (!d || !d.sourceResource) return null
    return new MarkdownPreviewInput(URI.revive(d.sourceResource) as URI)
  }
}
