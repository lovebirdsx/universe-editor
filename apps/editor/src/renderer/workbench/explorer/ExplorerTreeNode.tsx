/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeNode — recursive row renderer for one entry. Directories render
 *  a twisty and (when expanded) their children; files render a label that opens
 *  the editor on click.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { type IFileService, type URI } from '@universe-editor/platform'
import { useDragHandle, useDropTarget } from '@universe-editor/workbench-ui'
import type { ExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
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
  /** When true, skip rendering children (used in virtual-scroll mode where VirtualList controls rows). */
  readonly omitChildren?: boolean
  /** Provided when DnD file-move is active. */
  readonly fileService?: IFileService
  /** Passed through from VirtualList's absolute-positioning style. */
  readonly style?: CSSProperties
}

export function ExplorerTreeNode({
  resource,
  name,
  isDirectory,
  depth,
  tree,
  onOpenFile,
  onContextMenu,
  omitChildren,
  fileService,
  style,
}: Props) {
  const expanded = isDirectory ? tree.isExpanded(resource) : false
  const children = isDirectory && expanded && !omitChildren ? tree.getChildren(resource) : null
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

  const { dragHandleProps } = useDragHandle<{ resource: URI; isDirectory: boolean }>({
    resource,
    isDirectory,
  })

  const { dropTargetProps } = useDropTarget<{ resource: URI; isDirectory: boolean }>(
    ({ resource: src }) => {
      if (!fileService || !isDirectory) return
      const srcName = src.path.split('/').pop()
      if (!srcName) return
      const dest = resource.with({ path: `${resource.path}/${srcName}` })
      void fileService.rename(src, dest)
    },
  )

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        aria-expanded={isDirectory ? expanded : undefined}
        aria-selected={isSelected}
        aria-current={isActiveEditor ? 'page' : undefined}
        className={className}
        style={style ? { ...indent, ...style } : indent}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={(e) => onContextMenu(e, { resource, isDirectory })}
        {...dragHandleProps}
        {...(isDirectory ? dropTargetProps : {})}
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
          {...(fileService !== undefined ? { fileService } : {})}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}
