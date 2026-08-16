import { useCallback, useState, useSyncExternalStore } from 'react'
import { Search } from 'lucide-react'
import {
  DisposableStore,
  ICommandService,
  IEditorGroupsService,
  IHostService,
  IUriIdentityService,
  IWorkspaceService,
  localize,
  markAsSingleton,
  MutableDisposable,
  combinedDisposable,
  type IEditorGroup,
  type IWorkspace,
  type EditorInput,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { isFileSystemScheme } from '../../services/files/fileSystemScheme.js'
import { workspaceTitleLabel } from '../../services/workspace/workspaceLabel.js'
import { GoToFileAction } from '../../actions/fileOpenActions.js'
import { AgentStatusIndicator } from './AgentStatusIndicator.js'
import { AiTitleBarButton } from './AiTitleBarButton.js'
import { LayoutControls } from './LayoutControls.js'
import { MenuBar } from './MenuBar.js'
import { NavigationControls } from './NavigationControls.js'
import { RemoteBadge } from './RemoteBadge.js'
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
  uriIdentity: IUriIdentityService,
): string {
  const resource = editor.resource
  if (!resource || !isFileSystemScheme(resource.scheme)) return editor.getName()
  if (!workspace) return resource.fsPath
  return uriIdentity.relativePath(workspace.folder, resource) ?? resource.fsPath
}

/**
 * Window title: `${dirty}${leftSegment}${sep}${workspacePath}` — the right
 * segment is always the workspace path. Empty segments collapse their
 * separators (conditional separator).
 */
function computeTitle(
  editor: EditorInput | undefined,
  workspace: IWorkspace | null,
  uriIdentity: IUriIdentityService,
): string {
  if (!editor) return workspace?.name ?? ''
  const dirty = editor.isDirty ? DIRTY_INDICATOR : ''
  const segments = [
    leftSegment(editor, workspace, uriIdentity),
    workspace ? workspaceTitleLabel(workspace.folder) : '',
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
  const commandService = useService(ICommandService)
  const uriIdentity = useService(IUriIdentityService)
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
    computeTitle(groupsService.activeGroup.activeEditor, workspace.current, uriIdentity),
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
        <NavigationControls />
        <RemoteBadge />
        <button
          type="button"
          className={styles['command-center']}
          onClick={() => void commandService.executeCommand(GoToFileAction.ID)}
          data-tooltip={localize('commandCenter.tooltip', 'Search {name} — {title}', {
            name: workspace.current?.name ?? '',
            title,
          })}
          data-tooltip-command={GoToFileAction.ID}
          data-testid="titlebar-command-center"
        >
          <Search size={12} strokeWidth={1.75} aria-hidden="true" />
          <span className={styles['title']} data-testid="titlebar-title">
            {title}
          </span>
        </button>
        <AgentStatusIndicator />
        <AiTitleBarButton />
      </div>
      <div className={styles['right']}>
        <UpdateIndicator />
        <LayoutControls />
        {!isMac && <WindowControls />}
      </div>
    </header>
  )
}
