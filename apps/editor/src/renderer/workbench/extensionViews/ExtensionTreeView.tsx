/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Body for extension-contributed tree views (`contributes.views`). Mounting a
 *  view means the user revealed it, so the owning extension is activated first
 *  (idempotent — the host no-ops on an already-active extension); once the
 *  extension's `window.registerTreeDataProvider` lands on TreeViewsService,
 *  the pulled items render through the shared workbench-ui Tree.
 *
 *  Children are pulled lazily from the host: the tree model's data source
 *  answers `getChildren` from the service cache and `loadChildren` triggers
 *  the `extHostTreeViews.$getChildren` RPC. Selection / expansion / visibility
 *  flow back through `$acceptSelection` / `$acceptExpansionState` /
 *  `$acceptTreeViewVisibility`. Right-click surfaces the `view/item/context`
 *  menu contributions, gated on the `view` / `viewItem` context keys.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  ICommandService,
  IContextKeyService,
  localize,
  MenuId,
  MenuRegistry,
  type IScopedContextKeyService,
} from '@universe-editor/platform'
import { viewActivationEvent, type ITreeItemDto } from '@universe-editor/extensions-common'
import {
  ContextMenu,
  Tree,
  TreeModel,
  useOwnedTreeModel,
  type ITreeDataSource,
} from '@universe-editor/workbench-ui'
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import { useOptionalService, useService } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import { ITreeViewsService } from '../../services/extensions/TreeViewsService.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import type { IViewComponentProps } from '../../services/views/ViewComponentRegistry.js'
import styles from './ExtensionTreeView.module.css'

interface IRowMenuState {
  readonly anchor: { x: number; y: number }
  readonly item: ITreeItemDto
  readonly scoped: IScopedContextKeyService
}

export function ExtensionTreeView({ viewId }: IViewComponentProps) {
  const extensionHost = useOptionalService(IExtensionHostClientService)
  const treeViews = useService(ITreeViewsService)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)

  const [registered, setRegistered] = useState(() =>
    viewId !== undefined ? treeViews.hasProvider(viewId) : false,
  )
  const [menu, setMenu] = useState<IRowMenuState | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (viewId === undefined) return
    void extensionHost?.activateByEvent(viewActivationEvent(viewId))
  }, [extensionHost, viewId])

  const model = useOwnedTreeModel<ITreeItemDto>(() => {
    const dataSource: ITreeDataSource<ITreeItemDto> = {
      getId: (item) => String(item.handle),
      hasChildren: (item) => item.collapsibleState !== 0,
      getChildren: (item) =>
        viewId === undefined ? [] : treeViews.getChildren(viewId, item.handle),
      loadChildren: async (item) => {
        if (viewId === undefined) return
        await treeViews.loadChildren(viewId, item.handle)
      },
      getRoots: () => (viewId === undefined ? [] : (treeViews.getRoots(viewId) ?? [])),
    }
    return new TreeModel<ITreeItemDto>({
      dataSource,
      defaultExpanded: (item) => item.collapsibleState === 2,
    })
  })

  useViewFocusable(
    viewId ?? 'extension.treeView.unknown',
    useCallback(() => containerRef.current, []),
  )

  // Provider registration / invalidation / landed pulls → re-read the cache.
  // A $refresh lands here with the invalidated pages already dropped, so
  // re-pull whatever the user still has open: the roots when the whole view
  // was invalidated, plus any expanded row whose children page went away
  // (expand() on an already-expanded row only pulls, it fires no event).
  useEffect(() => {
    const d = treeViews.onDidChangeView((changedViewId) => {
      if (changedViewId !== viewId) return
      const nowRegistered = treeViews.hasProvider(changedViewId)
      setRegistered(nowRegistered)
      if (!nowRegistered) {
        model.reset()
        return
      }
      if (treeViews.getRoots(changedViewId) === null) {
        void treeViews.loadChildren(changedViewId)
      }
      model.refresh()
      for (const node of model.getVisibleNodes()) {
        if (!node.expanded) continue
        if (treeViews.getChildren(changedViewId, node.element.handle) !== null) continue
        void model.expand(node.element)
      }
    })
    return () => d.dispose()
  }, [treeViews, viewId, model])

  // Pull the roots once the provider is registered.
  useEffect(() => {
    if (viewId === undefined || !registered) return
    void treeViews.loadChildren(viewId)
  }, [treeViews, viewId, registered])

  // Visibility callbacks (initial + unmount). Host-side `TreeView.visible`
  // tracks the view being mounted, which is the first cut's visibility proxy.
  useEffect(() => {
    if (viewId === undefined || !registered) return
    treeViews.setViewVisibility(viewId, true)
    return () => treeViews.setViewVisibility(viewId, false)
  }, [treeViews, viewId, registered])

  // Selection / expansion → host. Expansion rides the model's toggle entry
  // points (onDidChangeExpansion) rather than a diff of rendered rows, so a
  // $refresh or a parent collapse never synthesizes expand/collapse events —
  // matching vscode, where the callbacks fire on user interaction only.
  useEffect(() => {
    if (viewId === undefined) return
    const pushSelection = () => {
      const handles = model.selection
        .map((id) => Number(id))
        .filter((handle) => Number.isInteger(handle))
      treeViews.setSelection(viewId, handles)
    }
    const d1 = model.onDidChangeSelection(pushSelection)
    const d2 = model.onDidChangeExpansion(({ element, expanded }) =>
      treeViews.setExpansionState(viewId, element.handle, expanded),
    )
    return () => {
      d1.dispose()
      d2.dispose()
    }
  }, [model, treeViews, viewId])

  // Command execution is delegated to the host with the element handle: the
  // extension handler receives the provider's original TreeItem.command
  // arguments (live Uri instances, custom objects), which a renderer-side
  // executeCommand would have wire-flattened.
  const runItem = useCallback(
    (item: ITreeItemDto) => {
      const command = item.command
      if (!command || command.disabled || viewId === undefined) return
      treeViews.executeTreeItemCommand(viewId, item.handle)
    },
    [treeViews, viewId],
  )

  // Focus landing in the tree without a focused row selects the first row.
  const onTreeFocus = useCallback(() => {
    const visible = model.getVisibleNodes()
    const focusedId = model.focused
    if (focusedId != null && visible.some((n) => n.id === focusedId)) return
    const targetId = visible[0]?.id
    if (targetId != null) model.setSelection([targetId], targetId)
  }, [model])

  const openRowMenu = useCallback(
    (e: ReactMouseEvent, item: ITreeItemDto) => {
      e.preventDefault()
      e.stopPropagation()
      model.setSelection([String(item.handle)], String(item.handle))
      const scoped = contextKeyService.createScoped({
        view: viewId ?? '',
        viewItem: item.contextValue ?? '',
      })
      // An all-gated-out menu renders nothing and never fires onClose — the
      // scoped key service would leak. Skip the popover entirely instead.
      if (MenuRegistry.getMenuItems(MenuId.ViewItemContext, scoped).length === 0) {
        scoped.dispose()
        return
      }
      setMenu({
        anchor: { x: e.clientX, y: e.clientY },
        item,
        scoped,
      })
    },
    [model, contextKeyService, viewId],
  )

  const closeMenu = useCallback(() => {
    setMenu((prev) => {
      prev?.scoped.dispose()
      return null
    })
  }, [])

  const ariaLabel = useMemo(
    () => localize('extensionTreeView.label', 'Extension view: {viewId}', { viewId: viewId ?? '' }),
    [viewId],
  )

  if (!registered) {
    return (
      <div className={styles['empty']} data-testid="extension-tree-view" data-view-id={viewId}>
        {localize(
          'extensionTreeView.placeholder',
          'This view is provided by an extension. Loading…',
        )}
      </div>
    )
  }

  return (
    <div className={styles['wrapper']} data-testid={`extension-tree-view-${viewId ?? ''}`}>
      <Tree<ITreeItemDto>
        model={model}
        rootRef={containerRef}
        className={styles['view'] ?? ''}
        virtualListClassName={styles['virtualList'] ?? ''}
        ariaLabel={ariaLabel}
        renderRow={(ctx) => {
          const item = ctx.node.element
          const RowIcon: LucideIcon | undefined = resolveHeaderIcon(item.iconId)
          const className = [
            styles['row'],
            ctx.isSelected && styles['selected'],
            ctx.isFocused && styles['focused'],
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={ctx.node.id}
              data-row-key={ctx.node.id}
              data-testid="extension-tree-item"
              role="treeitem"
              aria-expanded={ctx.node.hasChildren ? ctx.node.expanded : undefined}
              aria-selected={ctx.isSelected}
              className={className}
              style={
                ctx.style
                  ? { paddingLeft: ctx.indentPadding, ...ctx.style }
                  : { paddingLeft: ctx.indentPadding }
              }
              data-tooltip={item.tooltip}
              // Plain click = select (+ toggle / activate leaf, inside
              // onClickRow); the command runs solely via onActivate so a leaf
              // click executes it exactly once.
              onClick={ctx.onClickRow}
              onContextMenu={(e) => openRowMenu(e, item)}
            >
              <span
                className={styles['chevron']}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation()
                  ctx.onToggle()
                }}
              >
                {ctx.node.hasChildren &&
                  (ctx.node.expanded ? (
                    <ChevronDown size={16} strokeWidth={1.75} />
                  ) : (
                    <ChevronRight size={16} strokeWidth={1.75} />
                  ))}
              </span>
              {RowIcon && (
                <span className={styles['icon']} aria-hidden="true">
                  <RowIcon size={14} strokeWidth={1.6} />
                </span>
              )}
              <span className={styles['label']}>{item.label}</span>
              {item.description !== undefined && item.description !== '' && (
                <span className={styles['description']}>{item.description}</span>
              )}
            </div>
          )
        }}
        onActivate={(node) => runItem(node.element)}
        onFocus={onTreeFocus}
        onContextMenu={(e, node) => {
          if (node) openRowMenu(e, node.element)
        }}
      />
      {menu && viewId !== undefined && (
        <ContextMenu
          menuId={MenuId.ViewItemContext}
          anchor={menu.anchor}
          commandService={commandService}
          // vscode contract: the menu command handler receives the tree
          // element, resolved host-side from the handle — not the wire DTO.
          executeCommand={(commandId) =>
            treeViews.executeTreeItemCommand(viewId, menu.item.handle, commandId)
          }
          contextKeyService={menu.scoped}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
