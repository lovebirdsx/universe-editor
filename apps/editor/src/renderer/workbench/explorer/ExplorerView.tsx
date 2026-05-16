/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerView — top-level container rendered inside the SideBar's Explorer
 *  view container. Subscribes to ExplorerTreeService and renders the workspace
 *  folder root as a recursive tree.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useService } from '../useService.js'
import {
  ICommandService,
  IDialogService,
  IEditorService,
  IFileService,
  IInstantiationService,
  IWorkspaceService,
  type URI,
} from '@universe-editor/platform'
import { IExplorerTreeService } from './ExplorerTreeService.js'
import { ExplorerTreeNode } from './ExplorerTreeNode.js'
import { ExplorerContextMenu, type ContextMenuState } from './ExplorerContextMenu.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { confirmLargeFile } from '../editor/largeFileGuard.js'
import styles from './ExplorerView.module.css'

export function ExplorerView() {
  const instantiation = useService(IInstantiationService)
  const workspaceService = useService(IWorkspaceService)
  const editorService = useService(IEditorService)
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

  const openFile = (resource: URI) => {
    void (async () => {
      if (!(await confirmLargeFile(resource, fileService, dialogService))) return
      const input = instantiation.createInstance(FileEditorInput, resource)
      editorService.openEditor(input)
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

  return (
    <div className={styles['view']} onContextMenu={(e) => onRowContextMenu(e, null)}>
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
