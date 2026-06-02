/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocEditorInput — a virtual EditorInput that renders one of the built-in guide
 *  documents (see docRegistry) as formatted markdown. Carries only a `docId`;
 *  the content is resolved from DOCS by the DocEditor component.
 *--------------------------------------------------------------------------------------------*/

import { EditorInput, URI, localize } from '@universe-editor/platform'
import { DOCS, isDocId, type DocId } from './docRegistry.js'

interface ISerializedDoc {
  readonly docId: DocId
}

export class DocEditorInput extends EditorInput {
  static readonly TYPE_ID = 'doc'

  constructor(private readonly _docId: DocId) {
    super()
  }

  override get typeId(): string {
    return DocEditorInput.TYPE_ID
  }

  override get resource(): URI {
    return URI.from({ scheme: 'universe', path: `/doc/${this._docId}` })
  }

  get docId(): DocId {
    return this._docId
  }

  override getName(): string {
    const entry = DOCS[this._docId]
    return localize(entry.titleKey, entry.titleFallback)
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
