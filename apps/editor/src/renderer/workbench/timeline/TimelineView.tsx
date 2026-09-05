/*---------------------------------------------------------------------------------------------
 *  TimelineView — the Explorer-container Timeline view (VSCode `timelinePane`
 *  counterpart). Shows the version history of the active editor's file from
 *  every registered provider (git history, …), merged newest-first via
 *  mergeTimelineItems. Paging is per-provider: the "Load more" row fetches the
 *  next page of every provider that still has a cursor. Clicking an item runs
 *  its command (git opens a diff against the previous version); right-click
 *  surfaces the `timeline/item/context` menu contributions (copy commit id /
 *  message, …). Pin state and the follow-target uri live in TimelineService so
 *  `files.openTimeline` can pin a resource from the Explorer.
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
  IConfigurationService,
  IContextKeyService,
  IEditorService,
  localize,
  MenuId,
  type IScopedContextKeyService,
} from '@universe-editor/platform'
import type { ITimelineItemDto } from '@universe-editor/extensions-common'
import {
  ContextMenu,
  Tree,
  TreeModel,
  useOwnedTreeModel,
  isKeyboardContextMenu,
  type ITreeDataSource,
} from '@universe-editor/workbench-ui'
import { useObservable, useService } from '../useService.js'
import { useViewFocusable } from '../useViewFocusable.js'
import {
  ITimelineService,
  type ITimelineProviderModel,
} from '../../services/timeline/TimelineService.js'
import { timelineFollowTarget } from '../../services/timeline/followTarget.js'
import { mergeTimelineItems } from '../../services/timeline/timelineMerge.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { FileDiff, GitCommitHorizontal, Waypoints, type LucideIcon } from 'lucide-react'
import { timelineViewState } from './timelineViewState.js'
import styles from './TimelineView.module.css'

const DEFAULT_PAGE_SIZE = 50
const LOAD_MORE_ID = '$loadMore'

// Row-level codicon overrides: the header icon map's `git-commit` glyph (a
// check, tuned for SCM action buttons) reads wrong on history rows.
const ROW_ICON_MAP: Record<string, LucideIcon> = {
  'git-commit': GitCommitHorizontal,
}

function resolveRowIcon(themeIcon: string | undefined): LucideIcon | undefined {
  if (!themeIcon) return undefined
  return ROW_ICON_MAP[themeIcon] ?? resolveHeaderIcon(themeIcon)
}

// Inline row actions, keyed by the owning provider's (source, contextValue)
// pair — only commit/revision rows get them, never the working-tree rows.
interface RowActionTarget {
  /** Extension-contributed or `_workbench.*` bridge command. */
  command: string
  tooltip: string
}

function resolveRowGraphTarget(item: ITimelineItemDto): RowActionTarget | undefined {
  if (!item.id) return undefined
  if (item.source === 'git-history' && item.contextValue === 'git:file:commit') {
    return {
      command: '_workbench.openGitGraph',
      tooltip: localize('timeline.openInGitGraph', 'Open in Git Graph'),
    }
  }
  if (item.source === 'perforce-history' && item.contextValue === 'perforce:file:rev') {
    return {
      command: '_workbench.openPerforceGraph',
      tooltip: localize('timeline.openInPerforceGraph', 'Open in Perforce Graph'),
    }
  }
  return undefined
}

// Unlike the graph target (which takes just the hash), the viewCommit handlers
// need the whole item DTO: the repo uri rides in item.command.arguments[0].
function resolveRowCommitDiffTarget(item: ITimelineItemDto): RowActionTarget | undefined {
  if (!item.id) return undefined
  if (item.source === 'git-history' && item.contextValue === 'git:file:commit') {
    return {
      command: 'git.timeline.viewCommit',
      tooltip: localize('timeline.viewCommit', 'Open Commit'),
    }
  }
  if (item.source === 'perforce-history' && item.contextValue === 'perforce:file:rev') {
    return {
      command: 'perforce.timeline.viewCommit',
      tooltip: localize('timeline.viewCommit', 'Open Commit'),
    }
  }
  return undefined
}

interface TimelineRow {
  readonly id: string
  readonly item: ITimelineItemDto | undefined
}

interface TimelineMenuState {
  readonly anchor: { x: number; y: number }
  readonly item: ITimelineItemDto
  readonly scoped: IScopedContextKeyService
  /** Raised with the ContextMenu key — the menu opens on its first entry. */
  readonly keyboard: boolean
}

export function TimelineView() {
  const timelineService = useService(ITimelineService)
  const editorService = useService(IEditorService)
  const commandService = useService(ICommandService)
  const configService = useService(IConfigurationService)
  const contextKeyService = useService(IContextKeyService)

  const uri = useObservable(timelineService.uri)
  const pinnedUri = useObservable(timelineService.pinnedUri)
  const providers = useObservable(timelineService.providers)
  const excluded = useObservable(timelineViewState.excludedSources)
  const activeEditor = useObservable(editorService.activeEditor)

  const [items, setItems] = useState<ITimelineItemDto[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<TimelineMenuState | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<TimelineRow[]>([])
  // Providers with a next-page cursor, handle → cursor. Cleared per reload.
  const cursorsRef = useRef(new Map<number, string>())
  // Dropped responses from a superseded load (uri / providers changed mid-flight).
  const loadGenerationRef = useRef(0)

  // Follow the active editor unless pinned. Depending on pinnedUri re-points the
  // view at the active editor right after an unpin. timelineFollowTarget keeps the
  // view on the last file while a diff/merge or a virtual editor (graph, settings)
  // is active (VSCode parity), so opening a timeline entry's diff or jumping to a
  // commit in the graph doesn't blank the view.
  useEffect(() => {
    if (pinnedUri !== undefined) return
    const target = timelineFollowTarget(activeEditor)
    if (target !== 'keep') timelineService.followUri(target)
  }, [activeEditor, pinnedUri, timelineService])

  const activeProviders = useMemo<readonly ITimelineProviderModel[]>(() => {
    if (!uri) return []
    return providers.filter((p) => p.schemes.includes(uri.scheme) && !excluded.includes(p.id))
  }, [uri, providers, excluded])

  /** Providers matching the current uri's scheme, ignoring the source filter. */
  const schemeProviders = useMemo<readonly ITimelineProviderModel[]>(() => {
    if (!uri) return []
    return providers.filter((p) => p.schemes.includes(uri.scheme))
  }, [uri, providers])

  const loadFirstPage = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    const target = uri
    if (!target || activeProviders.length === 0) {
      cursorsRef.current = new Map()
      setItems([])
      setHasMore(false)
      setLoading(false)
      return
    }
    setLoading(true)
    const limit = configService.get<number>('timeline.pageSize') ?? DEFAULT_PAGE_SIZE
    const pages = await Promise.all(
      activeProviders.map((p) => timelineService.getTimeline(p.handle, target, { limit })),
    )
    if (generation !== loadGenerationRef.current) return
    const cursors = new Map<number, string>()
    const pageItems: ITimelineItemDto[][] = []
    pages.forEach((dto, i) => {
      const provider = activeProviders[i]
      if (!dto || !provider) return
      pageItems.push(dto.items)
      if (dto.cursor !== undefined) cursors.set(provider.handle, dto.cursor)
    })
    cursorsRef.current = cursors
    setItems(mergeTimelineItems(pageItems))
    setHasMore(cursors.size > 0)
    setLoading(false)
  }, [uri, activeProviders, timelineService, configService])

  const loadMore = useCallback(async () => {
    const target = uri
    if (!target) return
    const pending = activeProviders.filter((p) => cursorsRef.current.has(p.handle))
    if (pending.length === 0) return
    const generation = loadGenerationRef.current
    const limit = configService.get<number>('timeline.pageSize') ?? DEFAULT_PAGE_SIZE
    const pages = await Promise.all(
      pending.map((p) => {
        const cursor = cursorsRef.current.get(p.handle)
        return timelineService.getTimeline(p.handle, target, {
          ...(cursor !== undefined ? { cursor } : {}),
          limit,
        })
      }),
    )
    if (generation !== loadGenerationRef.current) return
    const pageItems: ITimelineItemDto[][] = []
    pages.forEach((dto, i) => {
      const provider = pending[i]
      if (!provider) return
      if (!dto || dto.cursor === undefined) cursorsRef.current.delete(provider.handle)
      else cursorsRef.current.set(provider.handle, dto.cursor)
      if (dto) pageItems.push(dto.items)
    })
    setItems((prev) => mergeTimelineItems([prev, ...pageItems]))
    setHasMore(cursorsRef.current.size > 0)
  }, [uri, activeProviders, timelineService, configService])

  // (Re)load whenever the follow target or the provider set changes.
  useEffect(() => {
    void loadFirstPage()
  }, [loadFirstPage])

  // Provider change events: a matching uri (or a provider-wide reset) reloads.
  useEffect(() => {
    const d = timelineService.onDidChangeTimeline((e) => {
      if (e.reset || e.uri === undefined || (uri && e.uri.toString() === uri.toString())) {
        void loadFirstPage()
      }
    })
    return () => d.dispose()
  }, [timelineService, uri, loadFirstPage])

  const model = useOwnedTreeModel<TimelineRow>(() => {
    const dataSource: ITreeDataSource<TimelineRow> = {
      getId: (r) => r.id,
      hasChildren: () => false,
      getChildren: () => [],
      getRoots: () => rowsRef.current,
    }
    return new TreeModel<TimelineRow>({ dataSource, defaultExpanded: () => false })
  })

  useViewFocusable(
    'workbench.view.timeline.main',
    useCallback(() => containerRef.current, []),
  )

  // Push the loaded items (+ trailing Load-more row) into the tree model.
  useEffect(() => {
    const rows: TimelineRow[] = items.map((item) => ({ id: item.handle, item }))
    if (hasMore) rows.push({ id: LOAD_MORE_ID, item: undefined })
    rowsRef.current = rows
    model.refresh()
  }, [items, hasMore, model])

  const runItem = useCallback(
    (item: ITimelineItemDto) => {
      const command = item.command
      if (!command) return
      void commandService.executeCommand(command.command, ...(command.arguments ?? []))
    },
    [commandService],
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
    (e: ReactMouseEvent, row: TimelineRow) => {
      e.preventDefault()
      e.stopPropagation()
      if (!row.item) return
      model.setSelection([row.id], row.id)
      setMenu({
        anchor: { x: e.clientX, y: e.clientY },
        item: row.item,
        scoped: contextKeyService.createScoped({ timelineItem: row.item.contextValue ?? '' }),
        keyboard: isKeyboardContextMenu(e),
      })
    },
    [model, contextKeyService],
  )

  const closeMenu = useCallback(() => {
    setMenu((prev) => {
      prev?.scoped.dispose()
      return null
    })
  }, [])

  if (!uri || schemeProviders.length === 0) {
    return (
      <div className={styles['empty']}>
        {localize('timeline.noProvider', 'The active editor cannot provide timeline information.')}
      </div>
    )
  }

  return (
    <div className={styles['wrapper']}>
      {items.length > 0 || hasMore ? (
        <Tree<TimelineRow>
          model={model}
          rootRef={containerRef}
          scrollStateKey="timeline"
          className={styles['view'] ?? ''}
          ariaLabel={localize('timeline.label', 'Timeline')}
          renderRow={(ctx) => {
            const row = ctx.node.element
            const className = [
              styles['row'],
              row.item === undefined && styles['loadMore'],
              ctx.isSelected && styles['selected'],
              ctx.isFocused && styles['focused'],
            ]
              .filter(Boolean)
              .join(' ')
            if (row.item === undefined) {
              return (
                <div
                  key={row.id}
                  data-row-key={row.id}
                  role="treeitem"
                  aria-selected={ctx.isSelected}
                  className={className}
                  style={
                    ctx.style
                      ? { paddingLeft: ctx.indentPadding, ...ctx.style }
                      : { paddingLeft: ctx.indentPadding }
                  }
                  onClick={(e) => {
                    ctx.onClickRow(e)
                    void loadMore()
                  }}
                >
                  {localize('timeline.loadMore', 'Load more')}
                </div>
              )
            }
            const item = row.item
            const ItemIcon = resolveRowIcon(item.themeIcon)
            const commitDiffTarget = resolveRowCommitDiffTarget(item)
            const graphTarget = resolveRowGraphTarget(item)
            return (
              <div
                key={row.id}
                data-row-key={row.id}
                role="treeitem"
                aria-selected={ctx.isSelected}
                className={className}
                style={
                  ctx.style
                    ? { paddingLeft: ctx.indentPadding, ...ctx.style }
                    : { paddingLeft: ctx.indentPadding }
                }
                data-tooltip={item.tooltip}
                onClick={(e) => {
                  ctx.onClickRow(e)
                  runItem(item)
                }}
                onContextMenu={(e) => openRowMenu(e, row)}
              >
                <span className={styles['icon']} aria-hidden="true">
                  {ItemIcon ? (
                    <ItemIcon size={14} strokeWidth={1.6} />
                  ) : (
                    <FileIcon resource={uri} className="" isDirectory={false} size={14} />
                  )}
                </span>
                <span className={styles['label']}>{item.label}</span>
                {item.description && (
                  <span className={styles['description']}>{item.description}</span>
                )}
                {(commitDiffTarget || graphTarget) && (
                  <span className={styles['rowActions']}>
                    {commitDiffTarget && (
                      <button
                        type="button"
                        className={styles['rowAction']}
                        data-tooltip={commitDiffTarget.tooltip}
                        aria-label={commitDiffTarget.tooltip}
                        onClick={(e) => {
                          e.stopPropagation()
                          // Act on the row under the mouse, so it becomes the selected
                          // one (same as openRowMenu) — without firing runItem's diff.
                          model.setSelection([row.id], row.id)
                          void commandService.executeCommand(commitDiffTarget.command, item)
                        }}
                      >
                        <FileDiff size={14} strokeWidth={1.6} />
                      </button>
                    )}
                    {graphTarget && (
                      <button
                        type="button"
                        className={styles['rowAction']}
                        data-tooltip={graphTarget.tooltip}
                        aria-label={graphTarget.tooltip}
                        onClick={(e) => {
                          e.stopPropagation()
                          // Act on the row under the mouse, so it becomes the selected
                          // one (same as openRowMenu) — without firing runItem's diff.
                          model.setSelection([row.id], row.id)
                          void commandService.executeCommand(graphTarget.command, item.id)
                        }}
                      >
                        <Waypoints size={14} strokeWidth={1.6} />
                      </button>
                    )}
                  </span>
                )}
              </div>
            )
          }}
          onActivate={(node) => {
            const row = node.element
            if (row.item) runItem(row.item)
            else void loadMore()
          }}
          onFocus={onTreeFocus}
          onContextMenu={(e, node) => {
            if (node) openRowMenu(e, node.element)
          }}
        />
      ) : (
        !loading && (
          <div className={styles['empty']}>
            {localize('timeline.noItems', 'No timeline information was provided.')}
          </div>
        )
      )}
      {menu && (
        <ContextMenu
          menuId={MenuId.TimelineItemContext}
          anchor={menu.anchor}
          args={[menu.item]}
          commandService={commandService}
          contextKeyService={menu.scoped}
          autoFocusFirst={menu.keyboard}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}
