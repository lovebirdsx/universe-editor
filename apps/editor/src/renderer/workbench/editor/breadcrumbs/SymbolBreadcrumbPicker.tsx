/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Symbol breadcrumb picker: the whole outline tree of the current editor. Moving
 *  the selection previews the symbol in the editor; confirming reveals it.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, type FocusEvent, type HTMLAttributes } from 'react'
import { ChevronRight } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import {
  AnchoredSurface,
  Tree,
  TreeModel,
  useOwnedTreeModel,
  useOwnerDocument,
} from '@universe-editor/workbench-ui'
import type { IOutlineScope } from '../../../services/languageFeatures/OutlineService.js'
import { displaySymbolName, type OutlineNode } from '../../outline/outlineTree.js'
import { SymbolIcon } from '../../symbols/symbolIcon.js'
import {
  BREADCRUMB_PICKER_ATTRIBUTE,
  computeBreadcrumbPickerLayout,
  type BreadcrumbPickerAnchor,
} from './breadcrumbPickerLayout.js'
import { createSymbolPickerDataSource, type SymbolPickerSnapshot } from './symbolPickerModel.js'
import styles from './BreadcrumbsPicker.module.css'

interface SymbolBreadcrumbPickerProps {
  readonly anchor: BreadcrumbPickerAnchor
  readonly snapshot: SymbolPickerSnapshot
  readonly scope: IOutlineScope
  readonly onConfirm: (node: OutlineNode) => void
  readonly onClose: () => void
  readonly onFocus?: () => void
  readonly onBlur?: (event: FocusEvent<HTMLDivElement>) => void
}

export function SymbolBreadcrumbPicker({
  anchor,
  snapshot,
  scope,
  onConfirm,
  onClose,
  onFocus,
  onBlur,
}: SymbolBreadcrumbPickerProps) {
  const ownerDocument = useOwnerDocument()
  const model = useOwnedTreeModel<OutlineNode>(() => {
    const dataSource = createSymbolPickerDataSource(snapshot)
    return new TreeModel<OutlineNode>({ dataSource, defaultExpanded: () => false })
  })

  useEffect(() => {
    const subscription = model.onDidChangeSelection(() => {
      const focused = model.focused
      if (focused === null) return
      const node = snapshot.nodeById.get(focused)
      if (node) scope.previewSymbol(node.symbol)
    })
    return () => subscription.dispose()
  }, [model, snapshot, scope])

  useEffect(() => {
    const updates: [string, boolean][] = snapshot.ancestorIds.map((id) => [id, true])
    if (snapshot.initialId !== undefined) updates.push([snapshot.initialId, true])
    model.setExpansionAndRefresh(updates)
    if (snapshot.initialId !== undefined) {
      model.setSelection([snapshot.initialId], snapshot.initialId)
    }
  }, [model, snapshot])

  // FloatingPortal mounts its children after the first commit, so an effect here
  // would run before the tree exists. Focus from the ref callback instead.
  const focusTree = useCallback((element: HTMLDivElement | null) => {
    element?.focus({ preventScroll: true })
  }, [])

  const layout = computeBreadcrumbPickerLayout(anchor, {
    width: ownerDocument?.defaultView?.innerWidth ?? window.innerWidth,
    height: ownerDocument?.defaultView?.innerHeight ?? window.innerHeight,
  })

  return (
    <AnchoredSurface
      x={layout.x}
      y={layout.y}
      placement="bottom-start"
      onClose={onClose}
      surfaceProps={
        {
          className: styles['surface'],
          style: { width: layout.width },
          [BREADCRUMB_PICKER_ATTRIBUTE]: '',
          'data-testid': 'breadcrumbs-symbol-picker',
          role: 'dialog',
          'aria-label': localize('breadcrumbs.symbolPicker.ariaLabel', 'Select a symbol'),
          ...(onFocus ? { onFocusCapture: onFocus } : {}),
          ...(onBlur ? { onBlurCapture: onBlur } : {}),
        } as HTMLAttributes<HTMLDivElement>
      }
    >
      <div className={styles['body']} style={{ maxHeight: layout.maxHeight }}>
        {snapshot.roots.length === 0 ? (
          <div className={styles['status']}>
            {localize('breadcrumbs.symbolPicker.empty', 'No symbols found.')}
          </div>
        ) : (
          <Tree
            model={model}
            rootRef={focusTree}
            className={styles['tree'] ?? ''}
            ariaLabel={localize('breadcrumbs.symbolPicker.ariaLabel', 'Select a symbol')}
            rowHeight={22}
            activateNonLeafOnEnter
            renderRow={({ node, isSelected, indentPadding, onToggle, style }) => {
              const symbol = node.element.symbol
              return (
                <div
                  className={styles['row']}
                  style={{ ...style, paddingLeft: indentPadding }}
                  role="treeitem"
                  aria-selected={isSelected}
                  {...(node.hasChildren ? { 'aria-expanded': node.expanded } : {})}
                  data-selected={isSelected}
                  onClick={(e) => {
                    e.stopPropagation()
                    model.setSelection([node.id], node.id, { reveal: false })
                    onConfirm(node.element)
                  }}
                >
                  {node.hasChildren ? (
                    <button
                      type="button"
                      className={styles['twistie']}
                      tabIndex={-1}
                      aria-label={
                        node.expanded
                          ? localize('breadcrumbs.symbolPicker.collapse', 'Collapse symbol')
                          : localize('breadcrumbs.symbolPicker.expand', 'Expand symbol')
                      }
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggle()
                      }}
                    >
                      <ChevronRight
                        size={14}
                        style={{ transform: node.expanded ? 'rotate(90deg)' : undefined }}
                      />
                    </button>
                  ) : (
                    <span className={styles['twistieSpacer']} aria-hidden="true" />
                  )}
                  <span className={styles['icon']} aria-hidden="true">
                    <SymbolIcon kind={symbol.kind} languageId={snapshot.languageId} size={14} />
                  </span>
                  <span className={styles['label']}>
                    {displaySymbolName(symbol.name, snapshot.languageId)}
                  </span>
                </div>
              )
            }}
            onActivate={(node) => onConfirm(node.element)}
          />
        )}
      </div>
    </AnchoredSurface>
  )
}
