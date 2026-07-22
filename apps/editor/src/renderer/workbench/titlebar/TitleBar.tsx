import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  DisposableStore,
  IEditorGroupsService,
  IHostService,
  IWorkspaceService,
  markAsSingleton,
  MutableDisposable,
  combinedDisposable,
  relativePathUnder,
  type HostPlatform,
  type IEditorGroup,
  type IWorkspace,
  type EditorInput,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { LayoutControls } from './LayoutControls.js'
import { MenuBar } from './MenuBar.js'
import { UpdateIndicator } from './UpdateIndicator.js'
import { WindowControls } from './WindowControls.js'
import styles from './TitleBar.module.css'

const SEPARATOR = ' — '
/** Leading dot marking unsaved changes, mirroring VSCode's `${dirty}`. */
const DIRTY_INDICATOR = '● '

/**
 * Left title segment: the file's workspace-relative path for in-workspace
 * files, the full path for external files, or the editor name for non-file
 * (virtual) editors.
 */
function leftSegment(
  editor: EditorInput,
  workspace: IWorkspace | null,
  platform: HostPlatform,
): string {
  const resource = editor.resource
  if (!resource || resource.scheme !== 'file') return editor.getName()
  const fsPath = resource.fsPath
  const rel = workspace ? relativePathUnder(workspace.folder.fsPath, fsPath, platform) : null
  return rel || fsPath
}

/**
 * Window title: `${dirty}${leftSegment}${sep}${workspacePath}` — the right
 * segment is always the workspace path. Empty segments collapse their
 * separators (conditional separator).
 */
function computeTitle(
  editor: EditorInput | undefined,
  workspace: IWorkspace | null,
  platform: HostPlatform,
): string {
  if (!editor) return workspace?.name ?? ''
  const dirty = editor.isDirty ? DIRTY_INDICATOR : ''
  const segments = [
    leftSegment(editor, workspace, platform),
    workspace?.folder.fsPath ?? '',
  ].filter((s) => s.length > 0)
  return dirty + segments.join(SEPARATOR)
}

const ICON_SRC = import.meta.env.DEV ? './icon-dev.ico' : './icon.ico'

function AppIcon() {
  const [error, setError] = useState(false)
  if (!error) {
    return (
      <img
        src={ICON_SRC}
        width={16}
        height={16}
        style={{ display: 'block' }}
        alt="app icon"
        aria-hidden="true"
        onError={() => setError(true)}
      />
    )
  }

  // 降级方案
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" role="presentation">
      <rect x="1" y="1" width="14" height="14" rx="3" fill="#1f6feb" />
      <path d="M4.2 4.5V11.5H6.2V8.7H9.8V11.5H11.8V4.5H9.8V6.9H6.2V4.5H4.2Z" fill="#ffffff" />
    </svg>
  )
}

export function TitleBar() {
  const host = useService(IHostService)
  const workspace = useService(IWorkspaceService)
  const groupsService = useService(IEditorGroupsService)
  const isMac = host.platform === 'darwin'

  const subscribe = useCallback(
    (onChange: () => void) => {
      const store = markAsSingleton(new DisposableStore())
      // Tracks the active editor's dirty/label listeners; swapped on editor change
      // so the dirty dot (●) and name stay live without a stale subscription.
      const activeEditorSub = store.add(new MutableDisposable())
      const bindActiveEditor = (editor: EditorInput | undefined) => {
        activeEditorSub.value = editor
          ? combinedDisposable(
              editor.onDidChangeDirty(() => onChange()),
              editor.onDidChangeLabel(() => onChange()),
            )
          : undefined
      }

      const groupSub = store.add(new MutableDisposable())
      const bindGroup = (group: IEditorGroup) => {
        bindActiveEditor(group.activeEditor)
        groupSub.value = combinedDisposable(
          group.onDidChangeModel(() => onChange()),
          group.onDidActiveEditorChange(() => {
            bindActiveEditor(group.activeEditor)
            onChange()
          }),
        )
      }

      bindGroup(groupsService.activeGroup)
      store.add(
        groupsService.onDidActiveGroupChange((newGroup) => {
          bindGroup(newGroup)
          onChange()
        }),
      )
      store.add(workspace.onDidChangeWorkspace(() => onChange()))
      return () => store.dispose()
    },
    [groupsService, workspace],
  )

  const title = useSyncExternalStore(subscribe, () =>
    computeTitle(groupsService.activeGroup.activeEditor, workspace.current, host.platform),
  )

  return (
    <header className={styles['titlebar']}>
      <div className={styles['drag-region']} aria-hidden="true" />
      <div className={styles['left']}>
        {isMac && <div className={styles['traffic-light-spacer']} />}
        <div className={styles['app-icon']} aria-hidden="true">
          <AppIcon />
        </div>
        <MenuBar />
      </div>
      <div className={styles['center']}>
        <div className={styles['title']} data-testid="titlebar-title">
          {title}
        </div>
      </div>
      <div className={styles['right']}>
        <UpdateIndicator />
        <LayoutControls />
        {!isMac && <WindowControls />}
      </div>
    </header>
  )
}
