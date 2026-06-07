/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineView — sidebar tree of the active editor's document symbols. Data comes
 *  from IOutlineService (which pulls from the language features facade); the
 *  generic <Tree> handles virtualization / keyboard nav. Clicking a row jumps to
 *  the symbol; the symbol under the cursor is highlighted (follow-cursor).
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { Hash } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { Tree, TreeModel, type ITreeDataSource } from '@universe-editor/workbench-ui'
import { useService, useObservable } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import { type monaco } from '../editor/monaco/MonacoLoader.js'
import { IOutlineService } from '../../services/languageFeatures/OutlineService.js'
import styles from './OutlineView.module.css'

interface OutlineNode {
  readonly id: string
  readonly symbol: monaco.languages.DocumentSymbol
  readonly children: OutlineNode[]
}

interface BuiltOutline {
  readonly roots: OutlineNode[]
  readonly idBySymbol: Map<monaco.languages.DocumentSymbol, string>
}

function buildOutlineNodes(roots: readonly monaco.languages.DocumentSymbol[]): BuiltOutline {
  const idBySymbol = new Map<monaco.languages.DocumentSymbol, string>()
  const build = (
    symbols: readonly monaco.languages.DocumentSymbol[],
    prefix: string,
  ): OutlineNode[] =>
    symbols.map((symbol, i) => {
      const id = prefix === '' ? `${i}` : `${prefix}/${i}`
      idBySymbol.set(symbol, id)
      return { id, symbol, children: build(symbol.children ?? [], id) }
    })
  return { roots: build(roots, ''), idBySymbol }
}

export function OutlineView() {
  const outlineService = useService(IOutlineService)
  const outline = useObservable(outlineService.outline)
  const activeSymbol = useObservable(outlineService.activeSymbol)

  const containerRef = useRef<HTMLDivElement>(null)
  const rootsRef = useRef<OutlineNode[]>([])
  const idBySymbolRef = useRef<Map<monaco.languages.DocumentSymbol, string>>(new Map())

  const modelRef = useRef<TreeModel<OutlineNode> | null>(null)
  if (!modelRef.current) {
    const dataSource: ITreeDataSource<OutlineNode> = {
      getId: (n) => n.id,
      hasChildren: (n) => n.children.length > 0,
      getChildren: (n) => n.children,
      getRoots: () => rootsRef.current,
    }
    modelRef.current = new TreeModel<OutlineNode>({ dataSource, defaultExpanded: () => true })
  }
  const model = modelRef.current

  useEffect(() => () => model.dispose(), [model])

  useViewFocusable(
    'workbench.view.outline.main',
    useCallback(() => containerRef.current, []),
  )

  // Rebuild the node tree whenever the symbol set changes; keep folding state by
  // reusing stable path ids across rebuilds.
  useEffect(() => {
    const built = buildOutlineNodes(outline?.roots ?? [])
    rootsRef.current = built.roots
    idBySymbolRef.current = built.idBySymbol
    model.refresh()
  }, [outline, model])

  const activeId = activeSymbol ? idBySymbolRef.current.get(activeSymbol) : undefined

  if (!outline || outline.roots.length === 0) {
    return <div className={styles['empty']}>{localize('outline.empty', 'No symbols found.')}</div>
  }

  return (
    <Tree<OutlineNode>
      model={model}
      rootRef={containerRef}
      className={styles['view'] ?? ''}
      virtualListClassName={styles['virtualList'] ?? ''}
      ariaLabel={localize('outline.label', 'Outline')}
      renderRow={(ctx) => {
        const node = ctx.node
        const className = [
          styles['row'],
          node.id === activeId && styles['active'],
          ctx.isSelected && styles['selected'],
          ctx.isFocused && styles['focused'],
        ]
          .filter(Boolean)
          .join(' ')
        const onClick = (e: ReactMouseEvent) => {
          ctx.onClickRow(e)
          outlineService.revealSymbol(node.element.symbol)
        }
        return (
          <div
            key={node.id}
            data-row-key={node.id}
            role="treeitem"
            aria-expanded={node.hasChildren ? node.expanded : undefined}
            aria-selected={ctx.isSelected}
            className={className}
            style={
              ctx.style
                ? { paddingLeft: ctx.indentPadding, ...ctx.style }
                : { paddingLeft: ctx.indentPadding }
            }
            onClick={onClick}
          >
            <span
              className={styles['twisty']}
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation()
                ctx.onToggle()
              }}
            >
              {node.hasChildren ? (node.expanded ? '▾' : '▸') : ''}
            </span>
            <span className={styles['icon']} aria-hidden="true">
              <Hash size={14} />
            </span>
            <span className={styles['label']}>{node.element.symbol.name}</span>
          </div>
        )
      }}
      onActivate={(node) => outlineService.revealSymbol(node.element.symbol)}
    />
  )
}
