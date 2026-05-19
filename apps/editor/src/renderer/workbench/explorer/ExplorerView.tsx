/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerView — top-level container rendered inside the SideBar's Explorer
 *  view container. Subscribes to ExplorerTreeService and renders the workspace
 *  folder root as a recursive tree.
 *--------------------------------------------------------------------------------------------*/

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useService } from '../useService.js'
import {
  ICommandService,
  IDialogService,
  IEditorResolverService,
  IFileService,
  IWorkspaceService,
  type URI,
} from '@universe-editor/platform'
import { IExplorerTreeService } from './ExplorerTreeService.js'
import { ExplorerTreeNode } from './ExplorerTreeNode.js'
import { ExplorerContextMenu, type ContextMenuState } from './ExplorerContextMenu.js'
import { confirmLargeFile } from '../editor/largeFileGuard.js'
import { EXPLORER_FOCUS_VIEW_EVENT } from '../../actions/layoutActions.js'
import styles from './ExplorerView.module.css'

const PAGE_STEP = 10

export function ExplorerView() {
  const editorResolverService = useService(IEditorResolverService)
  const workspaceService = useService(IWorkspaceService)
  const commandService = useService(ICommandService)
  const fileService = useService(IFileService)
  const dialogService = useService(IDialogService)
  const tree = useService(IExplorerTreeService)

  // Force a re-render whenever the tree fires onDidChange. A version counter is
  // enough — node state is read synchronously from the service.
  const [, setVersion] = useState(0)
  useEffect(() => {
    const d = tree.onDidChange(() => setVersion((v) => v + 1))
    return () => d.dispose()
  }, [tree])

  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus the view when the explorer is activated (e.g. via Ctrl+Shift+E) so
  // arrow-key navigation works without an extra mouse click.
  useEffect(() => {
    const onFocus = () => containerRef.current?.focus()
    document.addEventListener(EXPLORER_FOCUS_VIEW_EVENT, onFocus)
    return () => document.removeEventListener(EXPLORER_FOCUS_VIEW_EVENT, onFocus)
  }, [])

  const root = tree.root

  if (!root) {
    return (
      <div className={styles['empty']}>
        <p>You have not yet opened a folder.</p>
        <button
          type="button"
          className={styles['openBtn']}
          onClick={() => void workspaceService.openFolder()}
        >
          Open Folder
        </button>
      </div>
    )
  }

  const openFile = (resource: URI, options?: { preview?: boolean }) => {
    void (async () => {
      if (!(await confirmLargeFile(resource, fileService, dialogService))) return
      await editorResolverService.openEditor(resource, { pinned: options?.preview !== true })
    })()
  }

  const onRowContextMenu = (
    e: ReactMouseEvent,
    target: { resource: URI; isDirectory: boolean } | null,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, target })
  }

  const focusContainer = () => containerRef.current?.focus()

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const visible = tree.getVisibleEntries()
    if (visible.length === 0) return
    const focusedKey = tree.focused?.toString()
    const currentIndex = focusedKey
      ? visible.findIndex((v) => v.resource.toString() === focusedKey)
      : -1
    const current = currentIndex >= 0 ? visible[currentIndex] : undefined

    const handled = () => {
      e.preventDefault()
      e.stopPropagation()
    }

    const moveTo = (index: number) => {
      const clamped = Math.max(0, Math.min(visible.length - 1, index))
      const target = visible[clamped]
      if (!target) return
      if (e.shiftKey && tree.focused) {
        tree.selectRange(tree.focused, target.resource)
      } else {
        tree.setSelection([target.resource], target.resource)
      }
    }

    switch (e.key) {
      case 'ArrowDown':
        handled()
        moveTo(currentIndex < 0 ? 0 : currentIndex + 1)
        return
      case 'ArrowUp':
        handled()
        moveTo(currentIndex < 0 ? 0 : currentIndex - 1)
        return
      case 'Home':
        handled()
        moveTo(0)
        return
      case 'End':
        handled()
        moveTo(visible.length - 1)
        return
      case 'PageDown':
        handled()
        moveTo((currentIndex < 0 ? 0 : currentIndex) + PAGE_STEP)
        return
      case 'PageUp':
        handled()
        moveTo((currentIndex < 0 ? 0 : currentIndex) - PAGE_STEP)
        return
      case 'ArrowRight':
        if (!current) return
        handled()
        if (current.isDirectory) {
          if (tree.isExpanded(current.resource)) {
            const next = visible[currentIndex + 1]
            if (next) tree.setSelection([next.resource], next.resource)
          } else {
            void tree.expand(current.resource)
          }
        }
        return
      case 'ArrowLeft':
        if (!current) return
        handled()
        if (current.isDirectory && tree.isExpanded(current.resource)) {
          tree.collapse(current.resource)
        } else {
          const parent = tree.getParent(current.resource)
          if (parent) tree.setSelection([parent], parent)
        }
        return
      case 'Enter':
        if (!current) return
        handled()
        if (current.isDirectory) {
          void tree.toggle(current.resource)
        } else {
          openFile(current.resource, { preview: false })
        }
        return
      case ' ':
        if (!current) return
        handled()
        if (current.isDirectory) {
          void tree.toggle(current.resource)
        } else {
          openFile(current.resource, { preview: true })
        }
        return
      case 'F2':
        if (!current || currentIndex === 0) return
        handled()
        void commandService.executeCommand('workbench.files.action.rename', {
          target: current.resource,
        })
        return
      case 'Delete':
        if (!current || currentIndex === 0) return
        handled()
        void commandService.executeCommand('workbench.files.action.delete', {
          target: current.resource,
          isDirectory: current.isDirectory,
        })
        return
      default:
        return
    }
  }

  return (
    <div
      ref={containerRef}
      className={styles['view']}
      role="tree"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={focusContainer}
      onContextMenu={(e) => onRowContextMenu(e, null)}
    >
      <ExplorerTreeNode
        resource={root}
        name={workspaceService.current?.name ?? ''}
        isDirectory
        depth={0}
        tree={tree}
        onOpenFile={openFile}
        onContextMenu={onRowContextMenu}
      />
      {menu && (
        <ExplorerContextMenu
          state={menu}
          rootResource={root}
          tree={tree}
          commandService={commandService}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
