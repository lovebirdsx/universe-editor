import { useCallback, useSyncExternalStore } from 'react'
import {
  IEditorGroupsService,
  IHostService,
  IWorkspaceService,
  type IEditorGroup,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { FileEditorInput } from '../editor/FileEditorInput.js'
import { MenuBar } from './MenuBar.js'
import { WindowControls } from './WindowControls.js'
import styles from './TitleBar.module.css'

export function TitleBar() {
  const host = useService(IHostService)
  const workspace = useService(IWorkspaceService)
  const groupsService = useService(IEditorGroupsService)
  const isMac = host.platform === 'darwin'

  const current = useSyncExternalStore(
    (onChange) => {
      const d = workspace.onDidChangeWorkspace(() => onChange())
      return () => d.dispose()
    },
    () => workspace.current,
  )

  const subscribe = useCallback(
    (onChange: () => void) => {
      const subscribeGroup = (group: IEditorGroup) => {
        const a = group.onDidChangeModel(() => onChange())
        const b = group.onDidActiveEditorChange(() => onChange())
        return () => {
          a.dispose()
          b.dispose()
        }
      }
      let unsubGroup = subscribeGroup(groupsService.activeGroup)
      const d = groupsService.onDidActiveGroupChange((newGroup) => {
        unsubGroup()
        unsubGroup = subscribeGroup(newGroup)
        onChange()
      })
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
      <MenuBar />
      <div className={styles['title']}>{title}</div>
      {!isMac && <WindowControls />}
    </header>
  )
}
