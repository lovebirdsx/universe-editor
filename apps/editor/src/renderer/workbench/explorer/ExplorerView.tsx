/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerView — top-level container rendered inside the SideBar's Explorer
 *  view container. Delegates all generic tree concerns (flat visible rows,
 *  keyboard navigation, virtualization, reveal scrolling) to the shared <Tree>
 *  driven by ExplorerTreeService.model. This view only supplies file-specific
 *  row rendering, file-open behaviour and the context menu.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { useService, useObservable, useOptionalService } from '../useService.js'
import {
  combinedDisposable,
  IConfigurationService,
  ICommandService,
  IContextKeyService,
  IDialogService,
  IEditorResolverService,
  IFileService,
  IWorkspaceService,
  localize,
  markAsSingleton,
  observableValue,
  type IObservable,
  type URI,
} from '@universe-editor/platform'
import {
  DragSessionContext,
  DragSessionProvider,
  Tree,
  dragContainsResources,
  type ITreeRowRenderContext,
} from '@universe-editor/workbench-ui'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
  type IExplorerEntry,
  type IExplorerResourceOperation,
} from '../../services/explorer/ExplorerTreeService.js'
import { IExplorerFileOperationService } from '../../services/explorer/ExplorerFileOperationService.js'
import {
  IScmDecorationsService,
  type IScmDecorationsSnapshot,
} from '../../services/scm/ScmDecorationsService.js'
import { IScmBehindHintService } from '../../services/scm/ScmBehindHintService.js'
import { IScmIgnoredResourcesService } from '../../services/scm/ScmIgnoredResourcesService.js'
import { IScmWorkingTreeHintService } from '../../services/scm/ScmWorkingTreeHintService.js'
import { resolveRowDecoration } from '../../services/scm/rowDecoration.js'
import { ExplorerTreeNode } from './ExplorerTreeNode.js'
import { ExplorerContextMenu, type ContextMenuState } from './ExplorerContextMenu.js'
import { confirmOpenFile } from '../../services/editor/largeFileGuard.js'
import { readDroppedResources } from '../../services/dnd/resourceDropTransfer.js'
import { importDroppedResources } from '../../services/dnd/importDroppedFiles.js'
import { useViewFocusable } from '../useViewFocusable.js'
import styles from './ExplorerView.module.css'

const EMPTY_DECORATIONS: IObservable<IScmDecorationsSnapshot> = observableValue(
  'emptyScmDecorations',
  { files: new Map(), folders: new Map(), supplementary: new Map() },
)

const EMPTY_IGNORED_VERSION: IObservable<number> = observableValue('emptyScmIgnoredVersion', 0)

const EMPTY_HINT_VERSION: IObservable<number> = observableValue('emptyScmWorkingTreeHintVersion', 0)

const EMPTY_BEHIND_VERSION: IObservable<number> = observableValue('emptyScmBehindHintVersion', 0)

export function ExplorerView() {
  const editorResolverService = useService(IEditorResolverService)
  const workspaceService = useService(IWorkspaceService)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const fileService = useService(IFileService)
  const dialogService = useService(IDialogService)
  const configService = useService(IConfigurationService)
  const tree = useService(IExplorerTreeService)
  const fileOps = useService(IExplorerFileOperationService)
  const scmDecorations = useOptionalService(IScmDecorationsService)
  // Re-render rows when the SCM model changes; renderRow reads via getFile/getFolder.
  useObservable(scmDecorations?.decorations ?? EMPTY_DECORATIONS)
  const scmIgnoredResources = useOptionalService(IScmIgnoredResourcesService)
  // Re-render rows once a check-ignore batch resolves so cached answers re-apply.
  useObservable(scmIgnoredResources?.version ?? EMPTY_IGNORED_VERSION)
  const scmWorkingTreeHints = useOptionalService(IScmWorkingTreeHintService)
  // Same for the on-demand working-tree hints (see renderRow).
  useObservable(scmWorkingTreeHints?.version ?? EMPTY_HINT_VERSION)
  const scmBehindHints = useOptionalService(IScmBehindHintService)
  // Same for the on-demand behind-head probe (see renderRow).
  useObservable(scmBehindHints?.version ?? EMPTY_BEHIND_VERSION)

  // Re-render when selection / active-editor change so renderRow closes over a
  // fresh active-editor key. Structure changes are handled inside <Tree>.
  const [, setSelectionVersion] = useState(0)
  useEffect(() => {
    const d = markAsSingleton(
      combinedDisposable(
        tree.onDidChangeSelection(() => setSelectionVersion((v) => v + 1)),
        tree.onDidChangeClipboard(() => setSelectionVersion((v) => v + 1)),
      ),
    )
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
        if (!(await confirmOpenFile(resource, fileService, dialogService, editorResolverService)))
          return
        const preview = options?.preview === true
        // Single-click / Space preview keeps focus in the Explorer so the
        // selected row stays highlighted; double-click (pinned) hands focus to
        // the editor as usual.
        await editorResolverService.openEditor(resource, {
          pinned: !preview,
          ...(preview ? { preserveFocus: true } : {}),
        })
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

  const onDropResources = useCallback(
    (destDir: URI, e: ReactDragEvent) => {
      const sources = readDroppedResources(e)
      if (sources.length === 0) return
      void importDroppedResources(sources, destDir, fileService, dialogService)
    },
    [fileService, dialogService],
  )

  const onMoveResources = useCallback(
    (resources: readonly IExplorerResourceOperation[], destDir: URI) => {
      void (async () => {
        try {
          await fileOps.moveResources(resources, destDir)
        } catch (err) {
          await dialogService.confirm({
            message: localize('dialog.file.move.error', 'Failed to move'),
            detail: err instanceof Error ? err.message : String(err),
            type: 'error',
          })
        }
      })()
    },
    [fileOps, dialogService],
  )

  const root = tree.root
  if (!root) {
    return (
      <div className={styles['empty']}>
        <p>{localize('explorer.empty.noFolder', 'You have not yet opened a folder.')}</p>
        <button
          type="button"
          className={styles['openBtn']}
          onClick={() => void commandService.executeCommand('workbench.action.files.openFolder')}
        >
          {localize('action.openFolder.title', 'Open Folder…')}
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
    // getFile/getFolder resolve the row host-scopedly, so a remote workspace's
    // rows decorate from the remote git state while stray local editors don't.
    const deco = entry.isDirectory
      ? scmDecorations?.getFolder(entry.resource)
      : scmDecorations?.getFile(entry.resource)
    // 无 SCM 状态装饰时，被 ignore 规则忽略的文件/文件夹变暗（VSCode 对标，git / p4 通用）。
    const ignored = deco === undefined && scmIgnoredResources?.isIgnored(entry.resource) === true
    // 按需软信号：文件在磁盘上改了但 provider 还没发现它（p4 未收集的改动）。文件行
    // 出 RC 徽标；文件夹行只要有已发现的 RC 后代就染色（无字母徽章）——那是已发现
    // 改动的下界，未展开的子树查不到，展开/缓存逐出都可能让颜色增减（已接受的权衡）。
    const hint =
      deco === undefined && !ignored
        ? entry.isDirectory
          ? scmWorkingTreeHints?.getFolderHint(entry.resource)
          : scmWorkingTreeHints?.getHint(entry.resource)
        : undefined
    const row = resolveRowDecoration(deco, ignored, hint)
    // 服务器侧状态（落后 / 他人占用）只给文件行，与上面的组派生装饰各占一套字段。
    const supp = !entry.isDirectory ? scmDecorations?.getSupplementary(entry.resource) : undefined
    // Visible-row behind probe: enqueue a checkBehind for every file row on screen.
    // The returned boolean is NOT rendered — the actual ↓ marker arrives through the
    // provider's supplementary-decoration push; this only feeds the ask-once cache.
    // Not gated on `deco === undefined`: an opened file can also be behind.
    if (!entry.isDirectory) scmBehindHints?.isBehind(entry.resource)
    return (
      <ExplorerTreeNode
        key={key}
        {...(ctx.style !== undefined ? { style: ctx.style } : {})}
        {...(entry.compactRoot !== undefined ? { compactRoot: entry.compactRoot } : {})}
        resource={entry.resource}
        name={key === rootKey ? workspaceName : (entry.compactName ?? entry.name)}
        isDirectory={entry.isDirectory}
        {...(entry.isSymbolicLink ? { isSymbolicLink: true } : {})}
        expanded={ctx.node.expanded}
        indentPadding={ctx.indentPadding}
        isSelected={ctx.isSelected}
        isFocused={ctx.isFocused}
        isActiveEditor={activeKey === key}
        isCut={
          tree.isCut(entry.resource) || (entry.compactRoot ? tree.isCut(entry.compactRoot) : false)
        }
        {...(row.color !== undefined ? { decoColor: row.color } : {})}
        {...(row.letter !== undefined ? { decoLetter: row.letter } : {})}
        {...(row.strikeThrough ? { decoStrike: true } : {})}
        {...(row.tooltip !== undefined ? { decoTooltip: row.tooltip } : {})}
        {...(supp !== undefined ? { decoDescription: supp.description } : {})}
        {...(supp?.tooltip !== undefined ? { decoDescriptionTooltip: supp.tooltip } : {})}
        tree={tree}
        onOpenFile={openFile}
        onContextMenu={onRowContextMenu}
        onDropResources={onDropResources}
        onMoveResources={onMoveResources}
      />
    )
  }

  return (
    <DragSessionProvider>
      <RootDropZone
        root={root}
        tree={tree}
        onDropResources={onDropResources}
        onMoveResources={onMoveResources}
      >
        <Tree<IExplorerEntry>
          model={tree.model}
          rootRef={containerRef}
          scrollStateKey="explorer"
          className={styles['view'] ?? ''}
          virtualListClassName={styles['virtualList'] ?? ''}
          virtualizationThreshold={threshold}
          renderRow={renderRow}
          onActivate={(node, opts) => openFile(node.element.resource, { preview: opts.preview })}
          onFocus={() => {
            if (!tree.focused && root) tree.setSelection(root, root)
          }}
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
      </RootDropZone>
      {menu && (
        <ExplorerContextMenu
          state={menu}
          rootResource={root}
          commandService={commandService}
          contextKeyService={contextKeyService}
          tree={tree}
          onClose={() => setMenu(null)}
        />
      )}
    </DragSessionProvider>
  )
}

/**
 * Wraps the tree in a drop zone covering the whole Explorer body (including the
 * empty area below the last row). Dropping here targets the workspace root and,
 * crucially, distinguishes an Explorer-internal drag (a `DragSession` payload is
 * present → move/rename) from an OS-external / cross-panel drag (no payload →
 * copy-import), mirroring what row targets do in `ExplorerTreeNode`. Rendered
 * inside `DragSessionProvider` so it can read that payload — the outer
 * `ExplorerView` cannot, as the provider lives in its returned tree.
 */
function RootDropZone({
  root,
  tree,
  onDropResources,
  onMoveResources,
  children,
}: {
  readonly root: URI
  readonly tree: ExplorerTreeService
  readonly onDropResources: (destDir: URI, e: ReactDragEvent) => void
  readonly onMoveResources: (resources: readonly IExplorerResourceOperation[], destDir: URI) => void
  readonly children: ReactNode
}) {
  const dragSession = useContext(DragSessionContext)
  return (
    <div
      style={{ display: 'contents' }}
      onDragOver={(e) => {
        if (dragSession?.payload !== undefined || dragContainsResources(e.dataTransfer)) {
          e.preventDefault()
        }
      }}
      onDrop={(e) => {
        // Skip when a row already handled the drop (e.g. move/import onto a folder).
        if (e.defaultPrevented) return
        e.preventDefault()
        const payload = dragSession?.payload as { resource: URI } | undefined
        if (payload) {
          onMoveResources(tree.getContextResourceOperations(payload.resource), root)
          return
        }
        onDropResources(root, e)
      }}
    >
      {children}
    </div>
  )
}
