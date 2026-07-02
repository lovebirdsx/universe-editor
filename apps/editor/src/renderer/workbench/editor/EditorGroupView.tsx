/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupView — the React component for a single editor group.
 *
 *  Renders a tab bar (one tab per editor) and the active editor's content. The
 *  whole group is click-focusable so the user can switch the active group by
 *  clicking on any of its tabs / content area.
 *--------------------------------------------------------------------------------------------*/

import {
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type ComponentType,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  combinedDisposable,
  EditorInput,
  EditorRegistry,
  GroupDirection,
  ICommandService,
  IContextKeyService,
  IDialogService,
  IEditorResolverService,
  IFileService,
  IInstantiationService,
  IWindowsService,
  localize,
  markAsSingleton,
  MenuId,
  observableValue,
  type IEditorGroup,
  type IEditorGroupsService,
  type IEditorInput,
  type IObservable,
  URI,
} from '@universe-editor/platform'
import {
  ContextMenu,
  DragSessionContext,
  dragContainsResources,
  useHover,
  useDragHandle,
  useDropTarget,
} from '@universe-editor/workbench-ui'
import { useService, useObservable, useOptionalService } from '../useService.js'
import { closeEditorWithConfirm } from '../../services/editor/closeEditorWithConfirm.js'
import { cloneEditorInputForSplit } from '../../services/editor/cloneEditorInput.js'
import { focusEditorInput } from '../../services/editor/editorFocus.js'
import { readDroppedResources } from '../../services/dnd/resourceDropTransfer.js'
import { openDroppedResource } from '../../services/dnd/openDroppedResource.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import {
  IScmDecorationsService,
  scmPathKey,
  type IScmDecorationsSnapshot,
} from '../../services/scm/ScmDecorationsService.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { EditorTitleActions } from './EditorTitleActions.js'
import { ToggleEditorGroupLockAction } from '../../actions/editorActions.js'
import { FileIcon } from '../files/fileIconTheme.js'
import { resolveAgentIcon } from '../agents/agentIcon.js'
import { ChevronLeft, ChevronRight, Lock } from 'lucide-react'
import styles from './EditorArea.module.css'

const EMPTY_DECORATIONS: IObservable<IScmDecorationsSnapshot> = observableValue(
  'emptyScmDecorations',
  { files: new Map(), folders: new Map() },
)

const PATH_LIKE_TOOLTIP_SCHEMES = new Set(['file', 'diff', 'merge', 'markdown-preview'])

interface TabMenuState {
  readonly x: number
  readonly y: number
  readonly groupId: number
  readonly resource: URI | null
}

export interface EditorGroupViewProps {
  group: IEditorGroup
  groupsService: IEditorGroupsService
  /** Map keyed by IEditorProvider.componentKey. */
  componentMap: Map<string, ComponentType<{ input: IEditorInput }>>
  /** Fallback shown when the group has no editors. */
  fallback?: React.ReactNode
}

/** Drop zones available when dragging a tab into a group's body (not the tab bar). */
export type BodyDropZone = 'center' | 'top' | 'right' | 'bottom' | 'left'

/** Width of each edge band as a fraction of the group's body dimensions. */
const EDGE_RATIO = 0.2

/**
 * Pick the body drop zone for a pointer position relative to `rect`. Returns the
 * edge whose perpendicular distance from the pointer is smallest, or `'center'`
 * if the pointer is inside the central 60% × 60% region.
 */
export function detectBodyDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): BodyDropZone {
  // A zero-area body (layout not settled yet — observed transiently on headless
  // CI right after a split) can't be subdivided into edge bands; treat any drop
  // on it as a plain center drop rather than producing NaN distances that would
  // misfire as a 'bottom' edge split.
  if (!(rect.width > 0) || !(rect.height > 0)) return 'center'
  const dx = (clientX - rect.left) / rect.width
  const dy = (clientY - rect.top) / rect.height
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'center'
  const distLeft = dx
  const distRight = 1 - dx
  const distTop = dy
  const distBottom = 1 - dy
  const min = Math.min(distLeft, distRight, distTop, distBottom)
  if (min >= EDGE_RATIO) return 'center'
  if (min === distLeft) return 'left'
  if (min === distRight) return 'right'
  if (min === distTop) return 'top'
  return 'bottom'
}

function formatEditorResourceForHover(input: EditorInput): string | undefined {
  const resource = input.resource
  if (!resource) return undefined
  if (resource.scheme === 'untitled') {
    return localize('editorTab.tooltip.untitled', 'Unsaved file')
  }
  if (PATH_LIKE_TOOLTIP_SCHEMES.has(resource.scheme)) {
    const path = resource.fsPath
    return path && path !== input.label ? path : undefined
  }
  if (
    resource.scheme === 'universe' ||
    resource.scheme === 'release-notes' ||
    resource.scheme === 'startup-performance'
  ) {
    return undefined
  }
  const uri = resource.toString()
  return uri && uri !== input.label ? uri : undefined
}

function isReadonlyEditor(input: EditorInput): boolean {
  return 'isReadonly' in input && (input as { readonly isReadonly?: unknown }).isReadonly === true
}

function getEditorTabStatusLabels(
  input: EditorInput,
  isPreview: boolean,
  scmTooltip: string | undefined,
): string[] {
  const statuses: string[] = []
  if (input.isDirty) {
    statuses.push(localize('editorTab.tooltip.unsavedChanges', 'Unsaved changes'))
  }
  if (isPreview) {
    statuses.push(localize('editorTab.tooltip.preview', 'Preview'))
  }
  if (isReadonlyEditor(input)) {
    statuses.push(localize('editorTab.tooltip.readonly', 'Read-only'))
  }
  if (scmTooltip) statuses.push(scmTooltip)
  return statuses
}

function zoneToDirection(zone: Exclude<BodyDropZone, 'center'>): GroupDirection {
  switch (zone) {
    case 'top':
      return GroupDirection.Up
    case 'bottom':
      return GroupDirection.Down
    case 'left':
      return GroupDirection.Left
    case 'right':
      return GroupDirection.Right
  }
}

/**
 * Whether an external-resource drop should be left to Monaco's markdown
 * drop-to-link provider instead of being opened as an editor by the body. True
 * only when the user holds Shift AND the active editor is a markdown file AND the
 * drop landed inside its Monaco text area (`.monaco-editor`).
 *
 * Shift gates insert-as-link (matching VSCode); a plain drag keeps the original
 * behaviour of opening the dropped file. FileEditor mirrors the same Shift check
 * to arm Monaco's own `dropIntoEditor`, so the two stay in lockstep. Monaco's
 * drop listener does not stop propagation, so without deferring here a Shift-drop
 * would both insert a link (Monaco) and open the file (body) — a double action.
 */
export function shouldDeferDropToMarkdownEditor(
  target: EventTarget | null,
  activeEditor: EditorInput | undefined,
  shiftKey: boolean,
): boolean {
  if (!shiftKey) return false
  if (!(activeEditor instanceof FileEditorInput) || activeEditor.language !== 'markdown') {
    return false
  }
  return target instanceof HTMLElement && target.closest('.monaco-editor') !== null
}

/** Subscribes to a group's model + active changes and returns a snapshot string. */
function useGroupVersion(group: IEditorGroup): string {
  return useSyncExternalStore(
    (onChange) => {
      const a = group.onDidChangeModel(() => onChange())
      const b = group.onDidActiveEditorChange(() => onChange())
      const dirtyUnsubs = group.editors.map((e) => e.onDidChangeDirty(() => onChange()))
      // React owns lifecycle via useSyncExternalStore; mark singleton so
      // beforeunload (fires before React teardown on reload) doesn't report leaks.
      const combined = markAsSingleton(combinedDisposable(a, b, ...dirtyUnsubs))
      return () => combined.dispose()
    },
    () =>
      `${group.editors.map((e) => e.id).join(',')}:${group.activeEditor?.id ?? ''}:${group.previewEditor?.id ?? ''}:${group.editors.map((e) => (e.isDirty ? '1' : '0')).join('')}:${group.isLocked ? 'L' : ''}`,
  )
}

/** Subscribes to the groups service's active group change. */
function useActiveGroup(groupsService: IEditorGroupsService): IEditorGroup {
  return useSyncExternalStore(
    (onChange) => {
      const d = markAsSingleton(groupsService.onDidActiveGroupChange(() => onChange()))
      return () => d.dispose()
    },
    () => groupsService.activeGroup,
  )
}

const EditorTab = memo(function EditorTab({
  input,
  isActive,
  isGroupActive,
  hasInputFocus,
  isPreview,
  onActivate,
  onPin,
  onClose,
  onContextMenu,
  groupId,
  showDropIndicator,
}: {
  input: EditorInput
  isActive: boolean
  isGroupActive: boolean
  hasInputFocus: boolean
  isPreview: boolean
  onActivate: () => void
  onPin: () => void
  onClose: () => void
  onContextMenu: (e: ReactMouseEvent) => void
  groupId: number
  showDropIndicator: boolean
}) {
  const resource = input.resource
  const iconId = input.getIconId?.()
  const showsFileIcon =
    !iconId && resource && (resource.scheme === 'file' || resource.scheme === 'untitled')
  const languageId =
    'language' in input && typeof input.language === 'string' ? input.language : undefined

  const scmDecorations = useOptionalService(IScmDecorationsService)
  const decorations = useObservable(scmDecorations?.decorations ?? EMPTY_DECORATIONS)
  const deco =
    resource && resource.scheme === 'file'
      ? decorations.files.get(scmPathKey(resource.fsPath))
      : undefined
  const labelStyle =
    deco?.color !== undefined || deco?.strikeThrough
      ? {
          ...(deco.color !== undefined ? { color: deco.color } : {}),
          ...(deco.strikeThrough ? { textDecoration: 'line-through' } : {}),
        }
      : undefined

  const { dragHandleProps } = useDragHandle<{ editor: EditorInput; sourceGroupId: number }>(
    {
      editor: input,
      sourceGroupId: groupId,
    },
    {
      uriList: () => (resource && resource.scheme === 'file' ? [resource.toString()] : []),
    },
  )
  const { hoverProps, HoverPopup } = useHover()
  const resourceTooltip = formatEditorResourceForHover(input)
  const statusLabels = getEditorTabStatusLabels(input, isPreview, deco?.tooltip)

  const fullyActive = isActive && isGroupActive && hasInputFocus
  const tabClass = [
    styles['tab'],
    fullyActive ? styles['active'] : '',
    isActive && !fullyActive ? styles['activeUnfocused'] : '',
    isPreview ? (styles['preview'] ?? '') : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={tabClass}
      onClick={onActivate}
      onDoubleClick={onPin}
      onContextMenu={onContextMenu}
      role="tab"
      aria-selected={isActive}
      data-drop-before={showDropIndicator ? 'true' : undefined}
      {...hoverProps}
      {...dragHandleProps}
    >
      {input.isDirty && <span className={styles['dirtyDot']} />}
      {iconId
        ? (() => {
            const Icon = resolveAgentIcon(iconId)
            return <Icon size={14} className={styles['tabIcon']} />
          })()
        : showsFileIcon &&
          resource && (
            <FileIcon
              resource={resource}
              isDirectory={false}
              languageId={languageId}
              className={styles['tabIcon']}
              size={14}
            />
          )}
      <span className={styles['tabLabel']} style={labelStyle}>
        {input.label}
      </span>
      <button
        className={styles['closeBtn']}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={localize('editorTab.close', 'Close {name}', { name: input.label })}
      >
        ×
      </button>
      <HoverPopup>
        <div className={styles['tabTooltip']} data-testid="editor-tab-hover">
          <div className={styles['tabTooltipTitle']}>{input.label}</div>
          {resourceTooltip && (
            <div className={styles['tabTooltipDescription']}>{resourceTooltip}</div>
          )}
          {statusLabels.length > 0 && (
            <div className={styles['tabTooltipStatuses']}>
              {statusLabels.map((status, index) => (
                <span key={`${status}-${index}`} className={styles['tabTooltipStatus']}>
                  {status}
                </span>
              ))}
            </div>
          )}
        </div>
      </HoverPopup>
    </div>
  )
})

export const EditorGroupView = memo(function EditorGroupView({
  group,
  groupsService,
  componentMap,
  fallback,
}: EditorGroupViewProps) {
  const groupVersion = useGroupVersion(group)
  const activeGroup = useActiveGroup(groupsService)
  const isActiveGroup = activeGroup === group
  const dialogService = useService(IDialogService)
  const commandService = useService(ICommandService)
  const contextKeyService = useService(IContextKeyService)
  const editorResolverService = useService(IEditorResolverService)
  const fileService = useService(IFileService)
  const windowsService = useService(IWindowsService)
  const instantiationService = useService(IInstantiationService)
  const dragSession = useContext(DragSessionContext)
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [bodyZone, setBodyZone] = useState<BodyDropZone | null>(null)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Last pointer position relative to the body — read on drop to recompute zone. */
  const bodyDropPosRef = useRef<{ x: number; y: number } | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  /** Whether DOM focus is currently inside the editor body (Monaco). Drives tab highlight. */
  const [hasInputFocus, setHasInputFocus] = useState(false)

  const { dropTargetProps } = useDropTarget<{ editor: EditorInput; sourceGroupId: number }>(
    (payload, e) => {
      if (!payload) {
        openDroppedResources(e)
        return
      }
      const { editor, sourceGroupId } = payload
      if (sourceGroupId === group.id) {
        // Within same group: compute insertion index from the drop event's last known x.
        const tabBar = tabBarRef.current
        if (!tabBar) return
        const newIndex = calcInsertIndex(
          tabBar.dataset['lastDropX'] ? Number(tabBar.dataset['lastDropX']) : 0,
        )
        group.moveEditor(editor, newIndex)
      } else {
        const sourceGroup = groupsService.getGroup(sourceGroupId)
        if (sourceGroup) groupsService.moveEditor(editor, group)
      }
    },
  )

  const { dropTargetProps: bodyDropProps } = useDropTarget<{
    editor: EditorInput
    sourceGroupId: number
  }>((payload, e) => {
    const rect = bodyRef.current?.getBoundingClientRect()
    const pos = bodyDropPosRef.current
    setBodyZone(null)
    bodyDropPosRef.current = null
    if (!payload) {
      openDroppedResources(e)
      return
    }
    const { editor, sourceGroupId } = payload
    if (!rect || !pos) return
    const sourceGroup = groupsService.getGroup(sourceGroupId)
    if (!sourceGroup) return
    const zone = detectBodyDropZone(rect, pos.x, pos.y)
    if (zone === 'center') {
      // Same group + center = no-op (cross-group drops here behave like a tab-bar drop).
      if (sourceGroupId === group.id) return
      groupsService.moveEditor(editor, group)
      return
    }
    const newGroup = groupsService.addGroup(group, zoneToDirection(zone))
    // Splitting a group's only editor onto an edge of itself: a plain move would
    // empty (and auto-remove) the source. Clone into the new group instead — same
    // semantics as the Split Editor command — so both groups stay populated.
    if (sourceGroupId === group.id && sourceGroup.editors.length === 1) {
      instantiationService.invokeFunction((accessor) => {
        groupsService.copyEditor(cloneEditorInputForSplit(editor, accessor), newGroup)
      })
      return
    }
    groupsService.moveEditor(editor, newGroup)
  })

  const openDroppedResources = (e: ReactDragEvent): void => {
    for (const resource of readDroppedResources(e)) {
      void openDroppedResource(resource, { fileService, windowsService, editorResolverService })
    }
  }

  const handleBodyDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    bodyDropProps.onDragOver(e)
    const rect = bodyRef.current?.getBoundingClientRect()
    if (!rect) return
    bodyDropPosRef.current = { x: e.clientX, y: e.clientY }
    // Suppress overlay when the source is *this* group and it owns only the
    // dragged editor — dropping would be a no-op anywhere on the body.
    const payload = dragSession?.payload as
      | { editor: EditorInput; sourceGroupId: number }
      | undefined
    if (!payload) {
      // Over the markdown text area Monaco owns the drop (insert link) and shows
      // its own drop cursor — suppress our "open file" highlight so the two
      // affordances don't compete.
      if (shouldDeferDropToMarkdownEditor(e.target, group.activeEditor, e.shiftKey)) {
        if (bodyZone !== null) setBodyZone(null)
        return
      }
      // OS-external / cross-region resource: a single "open" highlight, no split.
      if (dragContainsResources(e.dataTransfer)) {
        if (bodyZone !== 'center') setBodyZone('center')
      }
      return
    }
    const zone = detectBodyDropZone(rect, e.clientX, e.clientY)
    // A group's only editor can still be split onto an edge of itself, but a
    // center drop there is a no-op — show edge previews, suppress center.
    const onlyEditorSelfDrop = payload.sourceGroupId === group.id && group.editors.length === 1
    if (onlyEditorSelfDrop && zone === 'center') {
      if (bodyZone !== null) setBodyZone(null)
      return
    }
    if (zone !== bodyZone) setBodyZone(zone)
  }

  const handleBodyDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (bodyRef.current && !bodyRef.current.contains(e.relatedTarget as Node | null)) {
      setBodyZone(null)
      bodyDropPosRef.current = null
    }
  }

  const handleBodyDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    // A file/image dropped onto the markdown text area is turned into a link by
    // Monaco's drop-to-link provider (its native listener already fired earlier
    // in the bubble phase). Don't also open the file. Non-markdown editors, or
    // drops outside the text area (breadcrumbs / empty space), fall through.
    if (shouldDeferDropToMarkdownEditor(e.target, group.activeEditor, e.shiftKey)) {
      setBodyZone(null)
      bodyDropPosRef.current = null
      return
    }
    bodyDropPosRef.current = { x: e.clientX, y: e.clientY }
    bodyDropProps.onDrop(e)
  }

  function calcInsertIndex(clientX: number): number {
    const tabBar = tabBarRef.current
    if (!tabBar) return group.editors.length
    const tabs = Array.from(tabBar.querySelectorAll<HTMLElement>('[role="tab"]'))
    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i]?.getBoundingClientRect()
      if (rect && clientX < rect.left + rect.width / 2) return i
    }
    return tabs.length
  }

  const handleFocus = () => {
    if (!isActiveGroup) groupsService.activateGroup(group)
  }

  // When the active tab changes or tabs are added/removed, ensure the active tab is visible.
  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return
    const activeTab = el.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!activeTab) return
    const elLeft = el.scrollLeft
    const elRight = elLeft + el.clientWidth
    const tabLeft = activeTab.offsetLeft
    const tabRight = tabLeft + activeTab.offsetWidth
    if (tabLeft < elLeft) {
      el.scrollLeft = tabLeft
    } else if (tabRight > elRight) {
      el.scrollLeft = tabRight - el.clientWidth
    }
  }, [groupVersion])

  // Keep scroll-arrow visibility in sync with the tab bar's scroll state.
  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return
    const update = () => {
      setCanScrollLeft(el.scrollLeft > 0)
      setCanScrollRight(Math.ceil(el.scrollLeft + el.clientWidth) < el.scrollWidth)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(() => requestAnimationFrame(update))
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])

  // Track real DOM focus inside the editor body so we can mute the tab highlight
  // when the user is interacting with another part of the workbench (sidebar,
  // panel, etc.). `activeGroup` alone stays active across such focus moves.
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onFocusIn = () => setHasInputFocus(true)
    const onFocusOut = (e: FocusEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) setHasInputFocus(false)
    }
    el.addEventListener('focusin', onFocusIn)
    el.addEventListener('focusout', onFocusOut)
    // Initialize from current document state in case we mount with focus already inside.
    setHasInputFocus(el.contains(document.activeElement))
    return () => {
      el.removeEventListener('focusin', onFocusIn)
      el.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  const scrollTabs = (direction: 'left' | 'right') => {
    tabBarRef.current?.scrollBy({ left: direction === 'left' ? -150 : 150, behavior: 'smooth' })
  }

  // Translate vertical wheel scrolling into horizontal tab scrolling (VSCode parity).
  // React's onWheel is passive and can't preventDefault; use a native listener so the
  // wheel doesn't bubble up and scroll an ancestor instead.
  useEffect(() => {
    const el = tabBarRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0) return
      if (e.deltaY === 0) return
      if (el.scrollWidth <= el.clientWidth) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // When this group becomes active (e.g. user returns from sidebar without changing file),
  // focus the Monaco editor so keyboard input goes to the editor immediately — unless the
  // open explicitly asked to keep focus elsewhere (Space-preview from a list).
  const activeEditor = group.activeEditor
  const focusedActivationRef = useRef<number>(-1)
  const wasActiveGroupRef = useRef(false)
  useLayoutEffect(() => {
    const wasActive = wasActiveGroupRef.current
    wasActiveGroupRef.current = isActiveGroup
    if (!isActiveGroup || !activeEditor) return
    // Group just (re-)activated without an editor change → always focus.
    if (!wasActive) {
      focusedActivationRef.current = group.activationId
      focusEditorInput(activeEditor, contextKeyService, group.id)
      return
    }
    // Already-active group: handle each activation once (dedupes StrictMode's
    // double-invoke) and honor preserveFocus.
    if (focusedActivationRef.current === group.activationId) return
    focusedActivationRef.current = group.activationId
    if (group.lastActivationPreservedFocus) return
    focusEditorInput(activeEditor, contextKeyService, group.id)
  }, [contextKeyService, group, isActiveGroup, activeEditor])

  const renderContent = () => {
    const active = group.activeEditor
    if (!active) return fallback ?? null
    const provider = EditorRegistry.getProvider(active.typeId)
    if (!provider) {
      return <div className={styles['welcome']}>No editor provider for "{active.typeId}"</div>
    }
    const Component = componentMap.get(provider.componentKey)
    if (!Component) {
      return <div className={styles['welcome']}>Component "{provider.componentKey}" missing</div>
    }
    // Most editors (FileEditor especially) are built to reuse one instance
    // across input swaps — switching tabs is a cheap setModel, not a rebuild.
    // The markdown preview is the exception: navigating A→B reuses the same
    // slot, and instance reuse would keep A's scroll position and leave the
    // title-bar actions (find / open source) bound to A's stale DOM. Key it by
    // input id so an in-place swap remounts a clean preview.
    if (provider.componentKey === 'markdown.preview') {
      return (
        <EditorGroupContext.Provider value={group}>
          <Component key={active.id} input={active} />
        </EditorGroupContext.Provider>
      )
    }
    return (
      <EditorGroupContext.Provider value={group}>
        <Component input={active} />
      </EditorGroupContext.Provider>
    )
  }

  return (
    <div
      className={`${styles['editorArea']} ${isActiveGroup ? (styles['groupActive'] ?? '') : ''}`}
      onMouseDown={handleFocus}
      data-group-id={group.id}
    >
      {group.editors.length > 0 && (
        <div className={styles['tabBarWrapper']}>
          {canScrollLeft && (
            <button
              className={styles['tabScrollBtn']}
              onClick={() => scrollTabs('left')}
              aria-label={localize('editorTabs.scrollLeft', 'Scroll tabs left')}
              tabIndex={-1}
            >
              <ChevronLeft size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <div
            ref={tabBarRef}
            className={styles['tabBar']}
            role="tablist"
            data-testid="editor-group-tabbar"
            onDragOver={(e) => {
              dropTargetProps.onDragOver(e)
              if (tabBarRef.current) {
                tabBarRef.current.dataset['lastDropX'] = String(e.clientX)
              }
              setDropIndex(calcInsertIndex(e.clientX))
            }}
            onDragLeave={(e) => {
              if (
                tabBarRef.current &&
                !tabBarRef.current.contains(e.relatedTarget as Node | null)
              ) {
                setDropIndex(null)
              }
            }}
            onDrop={(e) => {
              setDropIndex(null)
              dropTargetProps.onDrop(e)
            }}
          >
            {group.editors.map((e, idx) => (
              <EditorTab
                key={e.id}
                input={e}
                groupId={group.id}
                isActive={group.activeEditor?.id === e.id}
                isGroupActive={isActiveGroup}
                hasInputFocus={hasInputFocus}
                isPreview={group.previewEditor === e}
                showDropIndicator={dropIndex === idx}
                onActivate={() => group.setActive(e)}
                onPin={() => group.pinEditor(e)}
                onClose={() => void closeEditorWithConfirm(e, group, dialogService)}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  const resourceLike = (e as unknown as { resource?: URI }).resource
                  setTabMenu({
                    x: ev.clientX,
                    y: ev.clientY,
                    groupId: group.id,
                    resource: resourceLike instanceof URI ? resourceLike : null,
                  })
                }}
              />
            ))}
            {dropIndex === group.editors.length && (
              <div className={styles['tabDropIndicatorTrail']} aria-hidden="true" />
            )}
          </div>
          {canScrollRight && (
            <button
              className={styles['tabScrollBtn']}
              onClick={() => scrollTabs('right')}
              aria-label={localize('editorTabs.scrollRight', 'Scroll tabs right')}
              tabIndex={-1}
            >
              <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </button>
          )}
          <div className={styles['editorActionsBar']}>
            {group.isLocked && (
              <button
                className={styles['groupLockIndicator']}
                data-testid="editor-group-lock-indicator"
                title={localize('editorGroup.unlock', 'Unlock Group')}
                aria-label={localize('editorGroup.unlock', 'Unlock Group')}
                onClick={() =>
                  void commandService.executeCommand(ToggleEditorGroupLockAction.ID, {
                    groupId: group.id,
                  })
                }
              >
                <Lock size={13} strokeWidth={1.75} aria-hidden="true" />
              </button>
            )}
            <EditorTitleActions group={group} />
          </div>
        </div>
      )}
      <div
        ref={bodyRef}
        className={styles['editorContent']}
        data-testid="editor-group-body"
        tabIndex={-1}
        onDragOver={handleBodyDragOver}
        onDragLeave={handleBodyDragLeave}
        onDrop={handleBodyDrop}
      >
        {renderContent()}
        {bodyZone && (
          <div
            className={styles['dropZoneOverlay']}
            data-zone={bodyZone}
            data-testid="editor-group-drop-overlay"
            aria-hidden="true"
          />
        )}
      </div>
      {tabMenu && (
        <ContextMenu
          menuId={MenuId.EditorTabContext}
          anchor={{ x: tabMenu.x, y: tabMenu.y }}
          args={[{ groupId: tabMenu.groupId, resource: tabMenu.resource?.toJSON() ?? undefined }]}
          commandService={commandService}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  )
})
