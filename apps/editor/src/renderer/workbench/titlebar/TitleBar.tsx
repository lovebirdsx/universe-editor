import { useCallback, useState, useSyncExternalStore } from 'react'
import {
  combinedDisposable,
  IEditorGroupsService,
  IHostService,
  IWorkspaceService,
  markAsSingleton,
  type IEditorGroup,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { LayoutControls } from './LayoutControls.js'
import { MenuBar } from './MenuBar.js'
import { UpdateIndicator } from './UpdateIndicator.js'
import { WindowControls } from './WindowControls.js'
import styles from './TitleBar.module.css'

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

  const current = useSyncExternalStore(
    (onChange) => {
      const d = markAsSingleton(workspace.onDidChangeWorkspace(() => onChange()))
      return () => d.dispose()
    },
    () => workspace.current,
  )

  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscribeGroup = (group: IEditorGroup) => {
        const a = group.onDidChangeModel(() => onChange())
        const b = group.onDidActiveEditorChange(() => onChange())
        const combined = markAsSingleton(combinedDisposable(a, b))
        return () => combined.dispose()
      }
      let unsubGroup = subscribeGroup(groupsService.activeGroup)
      const d = markAsSingleton(
        groupsService.onDidActiveGroupChange((newGroup) => {
          unsubGroup()
          unsubGroup = subscribeGroup(newGroup)
          onChange()
        }),
      )
      return () => {
        d.dispose()
        unsubGroup()
      }
    },
    [groupsService],
  )

  const activeEditorInput = useSyncExternalStore(
    subscribe,
    () => groupsService.activeGroup.activeEditor,
  )

  let title: string
  if (activeEditorInput instanceof FileEditorInput) {
    const fsPath = activeEditorInput.resource.fsPath
    const sepIdx = Math.max(fsPath.lastIndexOf('/'), fsPath.lastIndexOf('\\'))
    const dir = sepIdx > 0 ? fsPath.slice(0, sepIdx) : fsPath
    title = `${activeEditorInput.getName()} — ${dir} — Universe Editor`
  } else if (current) {
    title = `${current.name} — Universe Editor`
  } else {
    title = 'Universe Editor'
  }

  return (
    <header className={styles['titlebar']}>
      {isMac && <div className={styles['traffic-light-spacer']} />}
      <div className={styles['app-icon']} aria-hidden="true">
        <AppIcon />
      </div>
      <MenuBar />
      <UpdateIndicator />
      <div className={styles['title']}>{title}</div>
      <LayoutControls />
      {!isMac && <WindowControls />}
    </header>
  )
}
