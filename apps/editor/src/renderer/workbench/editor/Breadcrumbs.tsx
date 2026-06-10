/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Breadcrumbs — the symbol path of the editor caret, shown above the editor.
 *  Consumes IOutlineService (shared with the Outline view): the file name plus
 *  the ancestry of the symbol under the cursor. Clicking a segment jumps to it.
 *--------------------------------------------------------------------------------------------*/

import { Fragment } from 'react'
import { ChevronRight } from 'lucide-react'
import type { IEditorInput } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { IOutlineService } from '../../services/languageFeatures/OutlineService.js'
import { symbolAncestryPath } from '../../services/languageFeatures/symbolTree.js'
import { SymbolIcon } from '../symbols/symbolIcon.js'
import type { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import styles from './Breadcrumbs.module.css'

export function Breadcrumbs({ input }: { input: IEditorInput }) {
  const fileInput = input as FileEditorInput
  const outlineService = useService(IOutlineService)
  const outline = useObservable(outlineService.outline)
  const activeSymbol = useObservable(outlineService.activeSymbol)

  const path = outline ? symbolAncestryPath(outline.roots, activeSymbol) : []

  return (
    <div className={styles['breadcrumbs']} data-testid="editor-breadcrumbs">
      <span className={styles['segment']}>{fileInput.getName()}</span>
      {path.map((symbol, i) => (
        <Fragment key={i}>
          <span className={styles['separator']} aria-hidden="true">
            <ChevronRight size={14} />
          </span>
          <button
            type="button"
            className={styles['segment']}
            onClick={() => outlineService.revealSymbol(symbol)}
          >
            <span className={styles['segmentIcon']} aria-hidden="true">
              <SymbolIcon kind={symbol.kind} languageId={outline?.languageId} size={14} />
            </span>
            {symbol.name}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
