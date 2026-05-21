/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupView — the React component for a single editor group.
 *
 *  Renders a tab bar (one tab per editor) and the active editor's content. The
 *  whole group is click-focusable so the user can switch the active group by
 *  clicking on any of its tabs / content area.
 *--------------------------------------------------------------------------------------------*/

import {
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
  EditorInput,
  EditorRegistry,
  GroupDirection,
  ICommandService,
  IContextKeyService,
  IDialogService,
  type IEditorGroup,
  type IEditorGroupsService,
  type IEditorInput,
  URI,
} from '@universe-editor/platform'
import { DragSessionContext, useDragHandle, useDropTarget } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { closeEditorWithConfirm } from '../../services/editor/closeEditorWithConfirm.js'
import { focusEditorInput } from '../../services/editor/editorFocus.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { EditorTabContextMenu, type TabContextMenuState } from './EditorTabContextMenu.js'
import { FileIcon } from '../files/fileIconTheme.js'
import styles from './EditorArea.module.css'

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
  const dx = (clientX - rect.left) / rect.width
  const dy = (clientY - rect.top) / rect.height
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

/** Subscribes to a group's model + active changes and returns a snapshot string. */
function useGroupVersion(group: IEditorGroup): string {
  return useSyncExternalStore(
    (onChange) => {
      const a = group.onDidChangeModel(() => onChange())
      const b = group.onDidActiveEditorChange(() => onChange())
      const dirtyUnsubs = group.editors.map((e) => e.onDidChangeDirty(() => onChange()))
      return () => {
        a.dispose()
        b.dispose()
        dirtyUnsubs.forEach((d) => d.dispose())
      }
    },
    () =>
      `${group.editors.map((e) => e.id).join(',')}:${group.activeEditor?.id ?? ''}:${group.previewEditor?.id ?? ''}:${group.editors.map((e) => (e.isDirty ? '1' : '0')).join('')}`,
  )
}

/** Subscribes to the groups service's active group change. */
function useActiveGroup(groupsService: IEditorGroupsService): IEditorGroup {
  return useSyncExternalStore(
    (onChange) => {
      const d = groupsService.onDidActiveGroupChange(() => onChange())
      return () => d.dispose()
    },
    () => groupsService.activeGroup,
  )
}

function EditorTab({
  input,
  isActive,
  isGroupActive,
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
  isPreview: boolean
  onActivate: () => void
  onPin: () => void
  onClose: () => void
  onContextMenu: (e: ReactMouseEvent) => void
  groupId: number
  showDropIndicator: boolean
}) {
  const resource = input.resource
  const showsFileIcon = resource && (resource.scheme === 'file' || resource.scheme === 'untitled')
  const languageId =
    'language' in input && typeof input.language === 'string' ? input.language : undefined

  const { dragHandleProps } = useDragHandle<{ editor: EditorInput; sourceGroupId: number }>({
    editor: input,
    sourceGroupId: groupId,
  })

  const tabClass = [
    styles['tab'],
    isActive && isGroupActive ? styles['active'] : '',
    isActive && !isGroupActive ? styles['activeUnfocused'] : '',
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
      {...dragHandleProps}
    >
      {input.isDirty && <span className={styles['dirtyDot']} title="Unsaved changes" />}
      {showsFileIcon && resource && (
        <FileIcon
          resource={resource}
          isDirectory={false}
          languageId={languageId}
          className={styles['tabIcon']}
          size={14}
        />
      )}
      <span className={styles['tabLabel']}>{input.label}</span>
      <button
        className={styles['closeBtn']}
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        aria-label={`Close ${input.label}`}
      >
        ×
      </button>
    </div>
  )
}

export function EditorGroupView({
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
  const dragSession = useContext(DragSessionContext)
  const [tabMenu, setTabMenu] = useState<TabContextMenuState | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const [bodyZone, setBodyZone] = useState<BodyDropZone | null>(null)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** Last pointer position relative to the body — read on drop to recompute zone. */
  const bodyDropPosRef = useRef<{ x: number; y: number } | null>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

  const { dropTargetProps } = useDropTarget<{ editor: EditorInput; sourceGroupId: number }>(
    ({ editor, sourceGroupId }) => {
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
  }>(({ editor, sourceGroupId }) => {
    const rect = bodyRef.current?.getBoundingClientRect()
    const pos = bodyDropPosRef.current
    setBodyZone(null)
    bodyDropPosRef.current = null
    if (!rect || !pos) return
    const sourceGroup = groupsService.getGroup(sourceGroupId)
    if (!sourceGroup) return
    // Dropping a group's only editor back onto itself would split into an empty
    // source group (auto-removed) — guard against the useless churn.
    if (sourceGroupId === group.id && sourceGroup.editors.length === 1) return
    const zone = detectBodyDropZone(rect, pos.x, pos.y)
    if (zone === 'center') {
      // Same group + center = no-op (cross-group drops here behave like a tab-bar drop).
      if (sourceGroupId === group.id) return
      groupsService.moveEditor(editor, group)
      return
    }
    const newGroup = groupsService.addGroup(group, zoneToDirection(zone))
    groupsService.moveEditor(editor, newGroup)
  })

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
    const onlyEditorSelfDrop = payload?.sourceGroupId === group.id && group.editors.length === 1
    if (onlyEditorSelfDrop) {
      if (bodyZone !== null) setBodyZone(null)
      return
    }
    const zone = detectBodyDropZone(rect, e.clientX, e.clientY)
    if (zone !== bodyZone) setBodyZone(zone)
  }

  const handleBodyDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    if (bodyRef.current && !bodyRef.current.contains(e.relatedTarget as Node | null)) {
      setBodyZone(null)
      bodyDropPosRef.current = null
    }
  }

  const handleBodyDrop = (e: ReactDragEvent<HTMLDivElement>) => {
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

  const scrollTabs = (direction: 'left' | 'right') => {
    tabBarRef.current?.scrollBy({ left: direction === 'left' ? -150 : 150, behavior: 'smooth' })
  }

  // When this group becomes active (e.g. user returns from sidebar without changing file),
  // focus the Monaco editor so keyboard input goes to the editor immediately.
  const activeEditor = group.activeEditor
  useLayoutEffect(() => {
    if (!isActiveGroup) return
    if (!activeEditor) return
    focusEditorInput(activeEditor, contextKeyService)
  }, [contextKeyService, isActiveGroup, activeEditor])

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
              aria-label="Scroll tabs left"
              tabIndex={-1}
            >
              ‹
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
              aria-label="Scroll tabs right"
              tabIndex={-1}
            >
              ›
            </button>
          )}
        </div>
      )}
      <div
        ref={bodyRef}
        className={styles['editorContent']}
        data-testid="editor-group-body"
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
        <EditorTabContextMenu
          state={tabMenu}
          commandService={commandService}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  )
}
