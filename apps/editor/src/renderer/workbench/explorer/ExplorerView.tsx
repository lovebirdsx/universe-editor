/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExplorerView — top-level container rendered inside the SideBar's Explorer
 *  view container. Subscribes to ExplorerTreeService and renders a flat,
 *  pre-computed list of visible rows. Selection / focus / active-editor flags
 *  are passed as per-row boolean props so React.memo can short-circuit unchanged
 *  rows when only the selection changes.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { useService } from '../useService.js'
import {
  IConfigurationService,
  ICommandService,
  IDialogService,
  IEditorResolverService,
  IFileService,
  IWorkspaceService,
  combinedDisposable,
  markAsSingleton,
  type URI,
} from '@universe-editor/platform'
import {
  DragSessionProvider,
  VirtualList,
  type VirtualListHandle,
} from '@universe-editor/workbench-ui'
import { IExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'
import { ExplorerTreeNode } from './ExplorerTreeNode.js'
import { ExplorerContextMenu, type ContextMenuState } from './ExplorerContextMenu.js'
import { confirmLargeFile } from '../../services/editor/largeFileGuard.js'
import { useViewFocusable } from '../useViewFocusable.js'
import styles from './ExplorerView.module.css'

const PAGE_STEP = 10

function computeDepth(resource: URI, root: URI): number {
  const rootSegments = root.path.split('/').length
  return resource.path.split('/').length - rootSegments
}

export function ExplorerView() {
  const editorResolverService = useService(IEditorResolverService)
  const workspaceService = useService(IWorkspaceService)
  const commandService = useService(ICommandService)
  const fileService = useService(IFileService)
  const dialogService = useService(IDialogService)
  const configService = useService(IConfigurationService)
  const tree = useService(IExplorerTreeService)

  // Two counters split structure changes from selection changes. The visible
  // array only re-builds when the structure version bumps; selection updates
  // bump the selection counter and reach rows via their boolean props.
  const [structureVersion, setStructureVersion] = useState(0)
  const [, setSelectionVersion] = useState(0)
  useEffect(() => {
    const ds = tree.onDidChangeStructure(() => setStructureVersion((v) => v + 1))
    const dsel = tree.onDidChangeSelection(() => setSelectionVersion((v) => v + 1))
    const combined = markAsSingleton(combinedDisposable(ds, dsel))
    return () => combined.dispose()
  }, [tree])

  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [hasFocus, setHasFocus] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const virtualRef = useRef<VirtualListHandle>(null)

  useViewFocusable(
    'workbench.view.explorer.tree',
    useCallback(() => containerRef.current, []),
  )

  const root = tree.root
  const visible = useMemo(
    () => tree.getVisibleEntries(),
    // structureVersion intentionally drives this; the cache in the service is
    // keyed by the same counter, so we just need any value that changes when
    // structure mutates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, structureVersion, root],
  )
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // Reveal: defer the scroll to after React commits so the DOM is settled.
  // Prefer scrollIntoView on the row element — it works in both virtual and
  // non-virtual modes and unlike virtualizer.scrollToIndex(align:'auto') it
  // does not depend on the virtualizer's internal scrollOffset being fresh
  // (that state lags during fast key-repeat). Fall back to scrollToIndex
  // only when the target row is outside the virtualizer's overscan window.
  const [revealRequest, setRevealRequest] = useState<{ key: string; tick: number } | null>(null)
  useEffect(() => {
    const d = markAsSingleton(
      tree.onReveal((uri) => {
        const key = uri.toString()
        setRevealRequest((prev) => ({ key, tick: (prev?.tick ?? 0) + 1 }))
      }),
    )
    return () => d.dispose()
  }, [tree])

  useLayoutEffect(() => {
    if (!revealRequest) return
    const { key } = revealRequest
    const root = containerRef.current
    if (!root) return
    const el = root.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
      return
    }
    if (virtualRef.current) {
      const idx = visibleRef.current.findIndex((e) => e.resource.toString() === key)
      if (idx >= 0) virtualRef.current.scrollToIndex(idx, { align: 'start' })
    }
  }, [revealRequest])

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

  const focusContainer = useCallback(() => containerRef.current?.focus(), [])

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const vis = tree.getVisibleEntries()
      if (vis.length === 0) return
      const focusedKey = tree.focused?.toString()
      const currentIndex = focusedKey
        ? vis.findIndex((v) => v.resource.toString() === focusedKey)
        : -1
      const current = currentIndex >= 0 ? vis[currentIndex] : undefined

      const handled = () => {
        e.preventDefault()
        e.stopPropagation()
      }

      const moveTo = (index: number) => {
        const clamped = Math.max(0, Math.min(vis.length - 1, index))
        const target = vis[clamped]
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
          moveTo(vis.length - 1)
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
              const next = vis[currentIndex + 1]
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
    },
    [tree, commandService, openFile],
  )

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
  const focusedKey = tree.focused?.toString() ?? null
  const activeKey = tree.activeEditorResource?.toString() ?? null

  const renderRow = (
    entry: { readonly resource: URI; readonly name: string; readonly isDirectory: boolean },
    style?: React.CSSProperties,
  ) => {
    const key = entry.resource.toString()
    return (
      <ExplorerTreeNode
        key={key}
        {...(style !== undefined ? { style } : {})}
        resource={entry.resource}
        name={key === rootKey ? workspaceName : entry.name}
        isDirectory={entry.isDirectory}
        expanded={entry.isDirectory ? tree.isExpanded(entry.resource) : false}
        depth={computeDepth(entry.resource, root)}
        isSelected={tree.isSelected(entry.resource)}
        isFocused={focusedKey === key}
        isActiveEditor={activeKey === key}
        tree={tree}
        fileService={fileService}
        onOpenFile={openFile}
        onContextMenu={onRowContextMenu}
      />
    )
  }

  return (
    <DragSessionProvider>
      <div
        ref={containerRef}
        className={styles['view']}
        data-focused={hasFocus}
        role="tree"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onMouseDown={focusContainer}
        onFocus={() => setHasFocus(true)}
        onBlur={() => setHasFocus(false)}
        onContextMenu={(e) => onRowContextMenu(e, null)}
      >
        {visible.length > threshold ? (
          <VirtualList
            ref={virtualRef}
            items={visible}
            estimateSize={() => 22}
            className={styles['virtualList'] ?? ''}
            renderItem={(entry, style) => renderRow(entry, style)}
          />
        ) : (
          <>{visible.map((entry) => renderRow(entry))}</>
        )}
        {menu && (
          <ExplorerContextMenu
            state={menu}
            rootResource={root}
            commandService={commandService}
            onClose={() => setMenu(null)}
          />
        )}
      </div>
    </DragSessionProvider>
  )
}
