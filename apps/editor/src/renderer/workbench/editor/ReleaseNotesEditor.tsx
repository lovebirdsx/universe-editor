/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ReleaseNotesEditor — renders a ReleaseNotesInput's pre-built markdown with a
 *  headline banner. Reuses the shared MarkdownView.
 *--------------------------------------------------------------------------------------------*/

import { IEditorInput } from '@universe-editor/platform'
import { ReleaseNotesInput } from '../../services/editor/ReleaseNotesInput.js'
import { MarkdownView } from '../markdown/MarkdownView.js'
import styles from './ReleaseNotesEditor.module.css'

export function ReleaseNotesEditor({ input }: { input: IEditorInput }) {
  const notes = input as ReleaseNotesInput
  return (
    <div className={styles['root']} data-testid="release-notes">
      <div className={styles['banner'] ?? ''}>{notes.title}</div>
      <MarkdownView text={notes.markdown} className={styles['body'] ?? ''} />
    </div>
  )
}
