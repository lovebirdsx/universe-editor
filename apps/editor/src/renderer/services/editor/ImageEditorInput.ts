/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ImageEditorInput — a read-only EditorInput backed by a `file:` image URI.
 *  Rendered by ImageEditor (a plain React view, not Monaco), so it carries no
 *  text model. Serialisable so an open image tab survives a window restore.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, type UriComponents } from '@universe-editor/platform'
import { basenameOfResource } from '../../workbench/files/resourceInfo.js'

interface ISerializedImageEditor {
  readonly resource: UriComponents
}

export class ImageEditorInput extends EditorInput {
  static readonly TYPE_ID = 'image'

  constructor(private readonly _resource: URI) {
    super()
  }

  override get typeId(): string {
    return ImageEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return this._resource
  }

  /**
   * Distinct from FileEditorInput's identity (a bare `file:` URI) so the image
   * preview and the text view of the same file can coexist as two tabs, and
   * "Reopen With..." can switch between them. `resource` still returns the real
   * `file:` URI — the tab icon, SCM decorations and `ue-file:` loading all need
   * it — only the editor identity is namespaced. Mirrors how MarkdownPreviewInput
   * / DiffEditorInput namespace their own ids.
   */
  override get id(): string {
    return `image:${this._resource.toString()}`
  }

  override getName(): string {
    return basenameOfResource(this._resource)
  }

  override serialize(): ISerializedImageEditor {
    return { resource: this._resource.toJSON() }
  }

  static deserialize(data: unknown): ImageEditorInput | null {
    const d = data as ISerializedImageEditor | null
    if (!d || !d.resource) return null
    const resource = URI.revive(d.resource) as URI
    return new ImageEditorInput(resource)
  }
}
