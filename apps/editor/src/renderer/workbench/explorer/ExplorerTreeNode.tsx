/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeNode — single flat row. Selection / focus / active-editor flags
 *  arrive as props so React.memo can skip rows whose visible state didn't
 *  actually change. The parent (ExplorerView) is responsible for the flat
 *  visible-rows enumeration; this component never recurses into children.
 *--------------------------------------------------------------------------------------------*/

import { memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { type IFileService, type URI } from '@universe-editor/platform'
import { useDragHandle, useDropTarget } from '@universe-editor/workbench-ui'
import type { ExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import { FileIcon } from '../files/fileIconTheme.js'
import styles from './ExplorerView.module.css'

interface Props {
  readonly resource: URI
  readonly name: string
  readonly isDirectory: boolean
  readonly expanded: boolean
  readonly depth: number
  readonly isSelected: boolean
  readonly isFocused: boolean
  readonly isActiveEditor: boolean
  readonly tree: ExplorerTreeService
  readonly onOpenFile: (resource: URI, options?: { preview?: boolean }) => void
  readonly onContextMenu: (
    e: ReactMouseEvent,
    target: { resource: URI; isDirectory: boolean } | null,
  ) => void
  readonly fileService?: IFileService
  readonly style?: CSSProperties
}

function ExplorerTreeNodeImpl({
  resource,
  name,
  isDirectory,
  expanded,
  depth,
  isSelected,
  isFocused,
  isActiveEditor,
  tree,
  onOpenFile,
  onContextMenu,
  fileService,
  style,
}: Props) {
  const indent = { paddingLeft: `${depth * 12 + 6}px` }
  const key = resource.toString()
  const className = [
    styles['row'],
    isActiveEditor && styles['active'],
    isSelected && styles['selected'],
    isFocused && styles['focused'],
  ]
    .filter(Boolean)
    .join(' ')

  const onClick = (e: ReactMouseEvent) => {
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
    <div
      data-row-key={key}
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
  )
}

export const ExplorerTreeNode = memo(ExplorerTreeNodeImpl)
