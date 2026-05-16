/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeNode — recursive row renderer for one entry. Directories render
 *  a twisty and (when expanded) their children; files render a label that opens
 *  the editor on click.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import type { URI } from '@universe-editor/platform'
import type { ExplorerTreeService } from './ExplorerTreeService.js'
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
  const isSelected = tree.selectedResource?.toString() === resource.toString()
  const rowRef = useRef<HTMLDivElement>(null)
  const key = resource.toString()

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

  const onClick = () => {
    tree.setSelection(resource)
    if (isDirectory) {
      void tree.toggle(resource)
    } else {
      onOpenFile(resource, { preview: true })
    }
  }

  const onDoubleClick = () => {
    if (!isDirectory) onOpenFile(resource, { preview: false })
  }

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        aria-expanded={isDirectory ? expanded : undefined}
        aria-selected={isSelected}
        className={`${styles['row']} ${isSelected ? (styles['selected'] ?? '') : ''}`}
        style={indent}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => onContextMenu(e, { resource, isDirectory })}
      >
        <span className={styles['twisty']} aria-hidden="true">
          {isDirectory ? (expanded ? '▾' : '▸') : ''}
        </span>
        <span className={styles['icon']} aria-hidden="true">
          {isDirectory ? '📁' : '📄'}
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
