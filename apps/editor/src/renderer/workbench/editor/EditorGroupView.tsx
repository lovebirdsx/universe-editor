/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupView — the React component for a single editor group.
 *
 *  Renders a tab bar (one tab per editor) and the active editor's content. The
 *  whole group is click-focusable so the user can switch the active group by
 *  clicking on any of its tabs / content area.
 *--------------------------------------------------------------------------------------------*/

import {
  useEffect,
  useRef,
  useSyncExternalStore,
  useState,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import {
  EditorInput,
  EditorRegistry,
  ICommandService,
  IDialogService,
  type IEditorGroup,
  type IEditorGroupsService,
  type IEditorInput,
  URI,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { closeEditorWithConfirm } from './closeEditorWithConfirm.js'
import { EditorGroupContext } from './EditorGroupContext.js'
import { EditorTabContextMenu, type TabContextMenuState } from './EditorTabContextMenu.js'
import { FileEditorInput } from './FileEditorInput.js'
import { FileEditorRegistry } from './FileEditorRegistry.js'
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
      `${group.editors.length}:${group.activeEditor?.id ?? ''}:${group.previewEditor?.id ?? ''}:${group.editors.map((e) => (e.isDirty ? '1' : '0')).join('')}`,
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
  isPreview,
  onActivate,
  onPin,
  onClose,
  onContextMenu,
}: {
  input: EditorInput
  isActive: boolean
  isPreview: boolean
  onActivate: () => void
  onPin: () => void
  onClose: () => void
  onContextMenu: (e: ReactMouseEvent) => void
}) {
  const resource = input.resource
  const showsFileIcon = resource && (resource.scheme === 'file' || resource.scheme === 'untitled')
  const languageId =
    'language' in input && typeof input.language === 'string' ? input.language : undefined

  return (
    <div
      className={`${styles['tab']} ${isActive ? styles['active'] : ''} ${
        isPreview ? (styles['preview'] ?? '') : ''
      }`}
      onClick={onActivate}
      onDoubleClick={onPin}
      onContextMenu={onContextMenu}
      role="tab"
      aria-selected={isActive}
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
  const [tabMenu, setTabMenu] = useState<TabContextMenuState | null>(null)
  const tabBarRef = useRef<HTMLDivElement>(null)
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)

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
    const ro = new ResizeObserver(update)
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
  useEffect(() => {
    if (!isActiveGroup) return
    if (!(activeEditor instanceof FileEditorInput)) return
    FileEditorRegistry.get(activeEditor)?.focus()
  }, [isActiveGroup, activeEditor])

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
          <div ref={tabBarRef} className={styles['tabBar']} role="tablist">
            {group.editors.map((e) => (
              <EditorTab
                key={e.id}
                input={e}
                isActive={group.activeEditor?.id === e.id}
                isPreview={group.previewEditor === e}
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
      <div className={styles['editorContent']}>{renderContent()}</div>
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
