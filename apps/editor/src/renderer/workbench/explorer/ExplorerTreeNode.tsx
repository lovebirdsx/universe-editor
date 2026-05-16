/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeNode — recursive row renderer for one entry. Directories render
 *  a twisty and (when expanded) their children; files render a label that opens
 *  the editor on click.
 *--------------------------------------------------------------------------------------------*/

import type { MouseEvent as ReactMouseEvent } from 'react'
import type { URI } from '@universe-editor/platform'
import type { ExplorerTreeService } from './ExplorerTreeService.js'
import styles from './ExplorerView.module.css'

interface Props {
  readonly resource: URI
  readonly name: string
  readonly isDirectory: boolean
  readonly depth: number
  readonly tree: ExplorerTreeService
  readonly onOpenFile: (resource: URI) => void
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

  const onClick = () => {
    if (isDirectory) {
      void tree.toggle(resource)
    } else {
      onOpenFile(resource)
    }
  }

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={isDirectory ? expanded : undefined}
        className={styles['row']}
        style={indent}
        onClick={onClick}
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
