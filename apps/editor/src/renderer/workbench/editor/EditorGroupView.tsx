/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorGroupView — the React component for a single editor group.
 *
 *  Renders a tab bar (one tab per editor) and the active editor's content. The
 *  whole group is click-focusable so the user can switch the active group by
 *  clicking on any of its tabs / content area.
 *--------------------------------------------------------------------------------------------*/

import {
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
import { EditorTabContextMenu, type TabContextMenuState } from './EditorTabContextMenu.js'
import styles from './EditorArea.module.css'

export interface EditorGroupViewProps {
  group: IEditorGroup
  groupsService: IEditorGroupsService
  /** Map keyed by IEditorProvider.componentKey. */
  componentMap: Map<string, ComponentType<{ input: IEditorInput }>>
  /** Fallback shown when the group has no editors. */
  fallback?: React.ReactNode
}

/** Subscribes to a group's model + active changes and returns a tick value. */
function useGroupVersion(group: IEditorGroup): number {
  return useSyncExternalStore(
    (onChange) => {
      const a = group.onDidChangeModel(() => onChange())
      const b = group.onDidActiveEditorChange(() => onChange())
      return () => {
        a.dispose()
        b.dispose()
      }
    },
    () => group.editors.length * 31 + (group.activeEditor ? 1 : 0),
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
  useGroupVersion(group)
  const activeGroup = useActiveGroup(groupsService)
  const isActiveGroup = activeGroup === group
  const dialogService = useService(IDialogService)
  const commandService = useService(ICommandService)
  const [tabMenu, setTabMenu] = useState<TabContextMenuState | null>(null)

  const handleFocus = () => {
    if (!isActiveGroup) groupsService.activateGroup(group)
  }

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
    return <Component input={active} />
  }

  return (
    <div
      className={`${styles['editorArea']} ${isActiveGroup ? (styles['groupActive'] ?? '') : ''}`}
      onMouseDown={handleFocus}
      data-group-id={group.id}
    >
      {group.editors.length > 0 && (
        <div className={styles['tabBar']} role="tablist">
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
