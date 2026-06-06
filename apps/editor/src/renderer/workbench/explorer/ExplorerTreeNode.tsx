/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerTreeNode — single flat row. Selection / focus / active-editor flags
 *  arrive as props so React.memo can skip rows whose visible state didn't
 *  actually change. The parent (ExplorerView) is responsible for the flat
 *  visible-rows enumeration; this component never recurses into children.
 *--------------------------------------------------------------------------------------------*/

import {
  Fragment,
  memo,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react'
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
  readonly indentPadding: number
  readonly isSelected: boolean
  readonly isFocused: boolean
  readonly isActiveEditor: boolean
  /** Topmost dir of the compact chain — drag source when set. */
  readonly compactRoot?: URI
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
  indentPadding,
  isSelected,
  isFocused,
  isActiveEditor,
  compactRoot,
  tree,
  onOpenFile,
  onContextMenu,
  fileService,
  style,
}: Props) {
  const indent = { paddingLeft: `${indentPadding}px` }
  const key = resource.toString()
  const className = [
    styles['row'],
    isActiveEditor && styles['active'],
    isSelected && styles['selected'],
    isFocused && styles['focused'],
  ]
    .filter(Boolean)
    .join(' ')

  // For a compact folder ("a/b/c") each path segment maps to its own directory
  // URI. Hovering / right-clicking / dropping onto a segment must target THAT
  // directory, mirroring VSCode's compact-folder behaviour.
  const segments = useMemo(() => {
    if (!compactRoot) return null
    const names = name.split('/')
    if (names.length < 2) return null
    const uris: URI[] = [compactRoot]
    for (let i = 1; i < names.length; i++) {
      const prev = uris[i - 1]!
      uris.push(prev.with({ path: `${prev.path}/${names[i]}` }))
    }
    return names.map((segName, i) => ({ name: segName, uri: uris[i]! }))
  }, [compactRoot, name])

  const [activeSeg, setActiveSeg] = useState<number | null>(null)
  // Drop destination for this row: the compact segment under the drag cursor,
  // defaulting to the leaf (= `resource`) when no segment is hovered.
  const dropDirRef = useRef<URI>(resource)

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
    resource: compactRoot ?? resource,
    isDirectory,
  })

  const { dropTargetProps } = useDropTarget<{ resource: URI; isDirectory: boolean }>(
    ({ resource: src }) => {
      if (!fileService || !isDirectory) return
      const srcName = src.path.split('/').pop()
      if (!srcName) return
      const destDir = dropDirRef.current
      const dest = destDir.with({ path: `${destDir.path}/${srcName}` })
      void fileService.rename(src, dest)
    },
  )

  return (
    <div
      data-row-key={key}
      data-drag-source={(compactRoot ?? resource).toString()}
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
      {segments ? (
        <span className={styles['label']}>
          {segments.map((s, i) => (
            <Fragment key={i}>
              {i > 0 && (
                <span className={styles['segmentSep']} aria-hidden="true">
                  /
                </span>
              )}
              <span
                className={[styles['segment'], activeSeg === i && styles['segmentActive']]
                  .filter(Boolean)
                  .join(' ')}
                data-segment-uri={s.uri.toString()}
                {...(activeSeg === i ? { 'data-segment-active': 'true' } : {})}
                onMouseEnter={() => setActiveSeg(i)}
                onMouseLeave={() => setActiveSeg((cur) => (cur === i ? null : cur))}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenu(e, { resource: s.uri, isDirectory: true })
                }}
                onDragEnter={() => {
                  dropDirRef.current = s.uri
                  setActiveSeg(i)
                }}
                onDragOver={() => {
                  dropDirRef.current = s.uri
                }}
                onDragLeave={() => setActiveSeg((cur) => (cur === i ? null : cur))}
              >
                {s.name}
              </span>
            </Fragment>
          ))}
        </span>
      ) : (
        <span className={styles['label']}>{name}</span>
      )}
    </div>
  )
}

export const ExplorerTreeNode = memo(ExplorerTreeNodeImpl)
