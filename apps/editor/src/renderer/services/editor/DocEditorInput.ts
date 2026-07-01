/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocEditorInput — a virtual EditorInput that renders one of the built-in guide
 *  documents (see docRegistry) as formatted markdown. Carries a path-style `docId`
 *  (e.g. "getting-started/interface-tour"); the title is extracted from the document's
 *  first H1 heading.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI } from '@universe-editor/platform'
import { getDocTitle, isDocId } from './docRegistry.js'

interface ISerializedDoc {
  readonly docId: string
}

export class DocEditorInput extends EditorInput {
  static readonly TYPE_ID = 'doc'

  constructor(
    private readonly _docId: string,
    /** Anchor to scroll to when the document first renders (not persisted). */
    readonly initialAnchor?: string,
  ) {
    super()
  }

  override get typeId(): string {
    return DocEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'universe', path: `/doc/${this._docId}` })
  }

  get docId(): string {
    return this._docId
  }

  override getName(): string {
    return getDocTitle(this._docId)
  }

  override serialize(): ISerializedDoc {
    return { docId: this._docId }
  }

  static deserialize(data: unknown): DocEditorInput | null {
    const d = data as ISerializedDoc | null
    if (!d || !isDocId(d.docId)) return null
    return new DocEditorInput(d.docId)
  }
}
