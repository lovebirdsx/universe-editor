/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeNode — recursive row renderer for one entry. Directories render
 *  a twisty and (when expanded) their children; files render a label that opens
 *  the editor on click.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import type { URI } from '@universe-editor/platform'
import type { ExplorerTreeService } from './ExplorerTreeService.js'
import { FileIcon } from '../files/fileIconTheme.js'
import styles from './ExplorerView.module.css'

interface Props {
  readonly resource: URI
  readonly name: string
  readonly isDirectory: boolean
  readonly depth: number
  readonly tree: ExplorerTreeService
  readonly onOpenFile: (resource: URI, options?: { preview?: boolean }) => void
  readonly onContextMenu: (
    e: ReactMouseEvent,
    target: { resource: URI; isDirectory: boolean } | null,
  ) => void
}

export function ExplorerTreeNode({
  resource,
  name,
  isDirectory,
  depth,
  tree,
  onOpenFile,
  onContextMenu,
}: Props) {
  const expanded = isDirectory ? tree.isExpanded(resource) : false
  const children = isDirectory && expanded ? tree.getChildren(resource) : null
  const indent = { paddingLeft: `${depth * 12 + 6}px` }
  const key = resource.toString()
  const isActiveEditor = tree.activeEditorResource?.toString() === key
  const isSelected = tree.selection.some((u) => u.toString() === key)
  const isFocused = tree.focused?.toString() === key
  const className = [
    styles['row'],
    isActiveEditor && styles['active'],
    isSelected && styles['selected'],
    isFocused && styles['focused'],
  ]
    .filter(Boolean)
    .join(' ')
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail
      if (detail === key) {
        rowRef.current?.scrollIntoView({ block: 'nearest' })
      }
    }
    document.addEventListener('explorer:reveal', handler)
    return () => document.removeEventListener('explorer:reveal', handler)
  }, [key])

  const onClick = (e: ReactMouseEvent) => {
    // Modifier-keyed clicks toggle / extend the selection without opening files.
    if (e.shiftKey) {
      const anchor = tree.focused ?? resource
      tree.selectRange(anchor, resource)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      tree.toggleInSelection(resource)
      return
    }
    tree.setSelection([resource], resource)
    if (isDirectory) {
      void tree.toggle(resource)
    } else {
      onOpenFile(resource, { preview: true })
    }
  }

  const onDoubleClick = (e: ReactMouseEvent) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return
    if (!isDirectory) onOpenFile(resource, { preview: false })
  }

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        aria-expanded={isDirectory ? expanded : undefined}
        aria-selected={isSelected}
        aria-current={isActiveEditor ? 'page' : undefined}
        className={className}
        style={indent}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => onContextMenu(e, { resource, isDirectory })}
      >
        <span className={styles['twisty']} aria-hidden="true">
          {isDirectory ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className={styles['icon']} aria-hidden="true">
          <FileIcon resource={resource} isDirectory={isDirectory} expanded={expanded} size={15} />
        </span>
        <span className={styles['label']}>{name}</span>
      </div>
      {children?.map((child) => (
        <ExplorerTreeNode
          key={child.resource.toString()}
          resource={child.resource}
          name={child.name}
          isDirectory={child.isDirectory}
          depth={depth + 1}
          tree={tree}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}
