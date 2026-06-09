/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerView — top-level container rendered inside the SideBar's Explorer
 *  view container. Delegates all generic tree concerns (flat visible rows,
 *  keyboard navigation, virtualization, reveal scrolling) to the shared <Tree>
 *  driven by ExplorerTreeService.model. This view only supplies file-specific
 *  row rendering, file-open behaviour and the context menu.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useService, useObservable, useOptionalService } from '../useService.js'
import {
  IConfigurationService,
  ICommandService,
  IDialogService,
  IEditorResolverService,
  IFileService,
  IWorkspaceService,
  markAsSingleton,
  observableValue,
  type IObservable,
  type URI,
} from '@universe-editor/platform'
import {
  DragSessionProvider,
  Tree,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import {
  IExplorerTreeService,
  type IExplorerEntry,
} from '../../services/explorer/ExplorerTreeService.js'
import {
  IScmDecorationsService,
  scmPathKey,
  type IScmDecorationsSnapshot,
} from '../../services/scm/ScmDecorationsService.js'
import { ExplorerTreeNode } from './ExplorerTreeNode.js'
import { ExplorerContextMenu, type ContextMenuState } from './ExplorerContextMenu.js'
import { confirmLargeFile } from '../../services/editor/largeFileGuard.js'
import { useViewFocusable } from '../useViewFocusable.js'
import styles from './ExplorerView.module.css'

const EMPTY_DECORATIONS: IObservable<IScmDecorationsSnapshot> = observableValue(
  'emptyScmDecorations',
  { files: new Map(), folders: new Map() },
)

export function ExplorerView() {
  const editorResolverService = useService(IEditorResolverService)
  const workspaceService = useService(IWorkspaceService)
  const commandService = useService(ICommandService)
  const fileService = useService(IFileService)
  const dialogService = useService(IDialogService)
  const configService = useService(IConfigurationService)
  const tree = useService(IExplorerTreeService)
  const scmDecorations = useOptionalService(IScmDecorationsService)
  const decorations = useObservable(scmDecorations?.decorations ?? EMPTY_DECORATIONS)

  // Re-render when selection / active-editor change so renderRow closes over a
  // fresh active-editor key. Structure changes are handled inside <Tree>.
  const [, setSelectionVersion] = useState(0)
  useEffect(() => {
    const d = markAsSingleton(tree.onDidChangeSelection(() => setSelectionVersion((v) => v + 1)))
    return () => d.dispose()
  }, [tree])

  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useViewFocusable(
    'workbench.view.explorer.tree',
    useCallback(() => containerRef.current, []),
  )

  const openFile = useCallback(
    (resource: URI, options?: { preview?: boolean }) => {
      void (async () => {
        if (!(await confirmLargeFile(resource, fileService, dialogService))) return
        await editorResolverService.openEditor(resource, { pinned: options?.preview !== true })
      })()
    },
    [editorResolverService, fileService, dialogService],
  )

  const onRowContextMenu = useCallback(
    (e: ReactMouseEvent, target: { resource: URI; isDirectory: boolean } | null) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY, target })
    },
    [],
  )

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

  const threshold = configService.get<number>('workbench.tree.virtualizationThreshold') ?? 200
  const workspaceName = workspaceService.current?.name ?? ''
  const rootKey = root.toString()
  const activeKey = tree.activeEditorResource?.toString() ?? null

  const renderRow = (ctx: ITreeRowRenderContext<IExplorerEntry>) => {
    const entry = ctx.node.element
    const key = ctx.node.id
    const deco = entry.isDirectory
      ? decorations.folders.get(scmPathKey(entry.resource.fsPath))
      : decorations.files.get(scmPathKey(entry.resource.fsPath))
    return (
      <ExplorerTreeNode
        key={key}
        {...(ctx.style !== undefined ? { style: ctx.style } : {})}
        {...(entry.compactRoot !== undefined ? { compactRoot: entry.compactRoot } : {})}
        resource={entry.resource}
        name={key === rootKey ? workspaceName : (entry.compactName ?? entry.name)}
        isDirectory={entry.isDirectory}
        expanded={ctx.node.expanded}
        indentPadding={ctx.indentPadding}
        isSelected={ctx.isSelected}
        isFocused={ctx.isFocused}
        isActiveEditor={activeKey === key}
        {...(deco?.color !== undefined ? { decoColor: deco.color } : {})}
        {...(deco?.letter !== undefined ? { decoLetter: deco.letter } : {})}
        {...(deco?.strikeThrough ? { decoStrike: true } : {})}
        {...(deco?.tooltip !== undefined ? { decoTooltip: deco.tooltip } : {})}
        tree={tree}
        fileService={fileService}
        onOpenFile={openFile}
        onContextMenu={onRowContextMenu}
      />
    )
  }

  return (
    <DragSessionProvider>
      <Tree<IExplorerEntry>
        model={tree.model}
        rootRef={containerRef}
        className={styles['view'] ?? ''}
        virtualListClassName={styles['virtualList'] ?? ''}
        virtualizationThreshold={threshold}
        renderRow={renderRow}
        onActivate={(node, opts) => openFile(node.element.resource, { preview: opts.preview })}
        onRowKeyDown={(e, node) => {
          if (node.id === rootKey) return
          if (e.key === 'F2') {
            e.preventDefault()
            void commandService.executeCommand('workbench.files.action.rename', {
              target: node.element.resource,
            })
          } else if (e.key === 'Delete') {
            e.preventDefault()
            void commandService.executeCommand('workbench.files.action.delete', {
              target: node.element.resource,
              isDirectory: node.element.isDirectory,
            })
          }
        }}
        onContextMenu={(e) => onRowContextMenu(e, null)}
      />
      {menu && (
        <ExplorerContextMenu
          state={menu}
          rootResource={root}
          commandService={commandService}
          onClose={() => setMenu(null)}
        />
      )}
    </DragSessionProvider>
  )
}
