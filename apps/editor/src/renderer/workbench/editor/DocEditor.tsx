/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocEditor — renders a built-in guide document (DocEditorInput) as formatted
 *  markdown. Content is bundled at build time (see docRegistry).
 *--------------------------------------------------------------------------------------------*/

import { IEditorInput } from '@universe-editor/platform'
import { DocEditorInput } from '../../services/editor/DocEditorInput.js'
import { DOCS } from '../../services/editor/docRegistry.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import styles from './MarkdownPreviewEditor.module.css'

export function DocEditor({ input }: { input: IEditorInput }) {
  const docId = (input as DocEditorInput).docId
  const content = DOCS[docId].content

  return (
    <div className={styles['previewRoot']} data-testid="doc-editor">
      <MarkdownView text={content} className={styles['previewBody'] ?? ''} />
    </div>
  )
}
