/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Breadcrumbs — the symbol path of the editor caret, shown above the editor.
 *  Reads the outline of ITS OWN editor group (IOutlineService.forGroup): in a
 *  split view each group follows its own active editor, so a background group
 *  must not mirror the focused one. Falls back to the service itself (the active
 *  group) when rendered outside a group, e.g. in isolation tests.
 *--------------------------------------------------------------------------------------------*/

import { Fragment } from 'react'
import { ChevronRight } from 'lucide-react'
import type { IEditorInput } from '@universe-editor/platform'
import { useService, useObservable } from '../useService.js'
import { IOutlineService } from '../../services/languageFeatures/OutlineService.js'
import { symbolAncestryPath } from '../../services/languageFeatures/symbolTree.js'
import { SymbolIcon } from '../symbols/symbolIcon.js'
import type { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { useEditorGroup } from './EditorGroupContext.js'
import styles from './Breadcrumbs.module.css'

export function Breadcrumbs({ input }: { input: IEditorInput }) {
  const fileInput = input as FileEditorInput
  const group = useEditorGroup()
  const outlineService = useService(IOutlineService)
  const scope = group ? outlineService.forGroup(group.id) : outlineService
  const outline = useObservable(scope.outline)
  const activeSymbol = useObservable(scope.activeSymbol)

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
            onClick={() => scope.revealSymbol(symbol)}
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
