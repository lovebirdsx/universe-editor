/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocEditorInput — a virtual EditorInput that renders one of the built-in guide
 *  documents (see docRegistry) as formatted markdown. Carries a path-style `docId`
 *  (e.g. "getting-started/interface-tour"); the title is extracted from the document's
 *  first H1 heading.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'
import type { DocCategory } from '../../../shared/ipc/docsService.js'
import { getDocTitle, isDocId } from './docRegistry.js'
import { MarkdownPreviewRegistry } from './MarkdownPreviewRegistry.js'

interface ISerializedDoc {
  readonly docId: string
  /** Absent in pre-category serializations; those tabs were user-guide docs. */
  readonly category?: DocCategory
}

export class DocEditorInput extends EditorInput {
  static readonly TYPE_ID = 'doc'

  constructor(
    private readonly _docId: string,
    readonly category: DocCategory = 'user',
    /** Anchor to scroll to when the document first renders (not persisted). */
    readonly initialAnchor?: string,
  ) {
    super()
  }

  override get typeId(): string {
    return DocEditorInput.TYPE_ID
  }

  override get resource(): URI {
    // The user guide keeps the original flat path so already-serialized tabs
    // keep restoring; other categories nest under their own segment to keep
    // docIds collision-free across categories.
    const path =
      this.category === 'user' ? `/doc/${this._docId}` : `/doc/${this.category}/${this._docId}`
    return URI.from({ scheme: 'universe', path })
  }

  get docId(): string {
    return this._docId
  }

  override getName(): string {
    return getDocTitle(this._docId, this.category)
  }

  /**
   * Move keyboard focus back into the live doc's scroll container (not the
   * editor-group body). The doc center is a plain div with no Monaco
   * registration, so `focusEditorInput` would otherwise fall back to focusing
   * the group body — which sits *outside* the doc container and fires its
   * `focusout`, dropping the `markdownPreviewFocused` context key and silently
   * disabling f / Ctrl+F / link hints. Mirrors MarkdownPreviewInput.focus(); the
   * shared useMarkdownReaderNav registers the controller keyed on `resource`.
   */
  override focus(): boolean {
    const controller = MarkdownPreviewRegistry.get(this.resource)
    if (!controller) return false
    controller.focus()
    return true
  }

  override serialize(): ISerializedDoc {
    return { docId: this._docId, category: this.category }
  }

  static deserialize(data: unknown): DocEditorInput | null {
    const d = data as ISerializedDoc | null
    const category = d?.category ?? 'user'
    if (!d || !isDocId(d.docId, category)) return null
    return new DocEditorInput(d.docId, category)
  }
}
