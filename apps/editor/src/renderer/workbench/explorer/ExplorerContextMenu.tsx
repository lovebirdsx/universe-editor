/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerContextMenu — lightweight portal-rendered popup. Items dispatch
 *  through ICommandService so the file Actions registered in WP5 are the
 *  single source of truth; we only own positioning and keyboard dismissal.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ICommandService, URI } from '@universe-editor/platform'
import type { ExplorerTreeService } from './ExplorerTreeService.js'
import styles from './ExplorerView.module.css'

export interface ContextMenuState {
  readonly x: number
  readonly y: number
  /** Null when the user right-clicked an empty area; commands fall back to root. */
  readonly target: { resource: URI; isDirectory: boolean } | null
}

interface Props {
  readonly state: ContextMenuState
  readonly rootResource: URI
  readonly tree: ExplorerTreeService
  readonly commandService: ICommandService
  readonly onClose: () => void
}

interface MenuItem {
  readonly id: string
  readonly label: string
  readonly run: () => void
}

export function ExplorerContextMenu({ state, rootResource, tree, commandService, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const target = state.target
  const isDir = target?.isDirectory ?? true
  // For "New File / Folder", commands target the right-clicked directory, or the
  // file's parent (let the action figure that out via the tree), or the root.
  const newParent = target ? (target.isDirectory ? target.resource : rootResource) : rootResource

  const run = (commandId: string, args?: unknown) => {
    onClose()
    void commandService.executeCommand(commandId, args)
  }

  const items: MenuItem[] = []
  items.push({
    id: 'newFile',
    label: 'New File',
    run: () => run('workbench.files.action.newFile', { parent: newParent }),
  })
  items.push({
    id: 'newFolder',
    label: 'New Folder',
    run: () => run('workbench.files.action.newFolder', { parent: newParent }),
  })
  if (target) {
    items.push({
      id: 'rename',
      label: 'Rename',
      run: () => run('workbench.files.action.rename', { target: target.resource }),
    })
    items.push({
      id: 'delete',
      label: 'Delete',
      run: () =>
        run('workbench.files.action.delete', {
          target: target.resource,
          isDirectory: isDir,
        }),
    })
  }
  items.push({
    id: 'refresh',
    label: 'Refresh',
    run: () => {
      onClose()
      void tree.refresh(target?.isDirectory ? target.resource : rootResource)
    },
  })

  return createPortal(
    <ul ref={ref} role="menu" className={styles['menu']} style={{ top: state.y, left: state.x }}>
      {items.map((it) => (
        <li key={it.id} role="menuitem" className={styles['menuItem']} onClick={it.run}>
          {it.label}
        </li>
      ))}
    </ul>,
    document.body,
  )
}
