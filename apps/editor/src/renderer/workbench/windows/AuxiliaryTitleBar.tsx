/*---------------------------------------------------------------------------------------------
 *  AuxiliaryTitleBar — the renderer-drawn title bar for frameless auxiliary
 *  windows. Reuses the main title bar's CSS module so the theme variables
 *  mirrored into the auxiliary document (--vscode-titleBar-activeBackground,
 *  foreground, hover backgrounds) drive the chrome exactly like the main window.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  DisposableStore,
  IHostService,
  MutableDisposable,
  localize,
  markAsSingleton,
  type IDisposable,
  type IEditorGroup,
} from '@universe-editor/platform'
import { IAuxiliaryWindowsService } from '../../../shared/ipc/auxiliaryWindowService.js'
import {
  IAuxiliaryEditorWindowService,
  type IAuxiliaryEditorWindow,
} from '../../services/windows/auxiliaryEditorWindowService.js'
import { useService } from '../useService.js'
import { WindowControlsView } from '../titlebar/WindowControls.js'
import styles from '../titlebar/TitleBar.module.css'
import auxStyles from './AuxiliaryWindowHost.module.css'

function useActiveEditorTitle(entry: IAuxiliaryEditorWindow): string {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const store = new DisposableStore()
      const editorSub = store.add(new MutableDisposable<IDisposable>())
      const groupSub = store.add(new MutableDisposable<IDisposable>())
      const bindGroup = (group: IEditorGroup): void => {
        // Save-As renames a buffer without switching editors; keep the title live.
        editorSub.value = group.activeEditor?.onDidChangeLabel(() => onChange())
        groupSub.value = group.onDidActiveEditorChange(() => {
          bindGroup(group)
          onChange()
        })
      }
      bindGroup(entry.part.activeGroup)
      store.add(
        entry.part.onDidActiveGroupChange((group) => {
          bindGroup(group)
          onChange()
        }),
      )
      return () => store.dispose()
    },
    [entry],
  )
  return useSyncExternalStore(subscribe, () => entry.part.activeGroup.activeEditor?.getName() ?? '')
}

export function AuxiliaryTitleBar({ entry }: { entry: IAuxiliaryEditorWindow }) {
  const host = useService(IHostService)
  const aux = useService(IAuxiliaryWindowsService)
  const auxEditor = useService(IAuxiliaryEditorWindowService)
  const [isMaximized, setIsMaximized] = useState(false)
  const editorTitle = useActiveEditorTitle(entry)
  const isMac = host.platform === 'darwin'

  // 原生标题跟随活动编辑器，Alt+Tab/任务栏才能区分各辅助窗口；窗口无边框，
  // 这是唯一的原生标题来源。
  const windowTitle = localize('auxiliaryWindow.windowTitle', 'Editor Window')
  const nativeTitle =
    editorTitle.length > 0
      ? localize('auxiliaryWindow.titleWithEditor', '{editor} — Editor Window', {
          editor: editorTitle,
        })
      : windowTitle
  useEffect(() => {
    entry.window.document.title = nativeTitle
  }, [entry, nativeTitle])

  useEffect(() => {
    let cancelled = false
    void aux
      .getWindowState(entry.token)
      .then((state) => {
        if (!cancelled) setIsMaximized(state?.geometry.isMaximized ?? false)
      })
      // The window (and its token) can be gone by the time this resolves.
      .catch(() => undefined)
    const sub = markAsSingleton(
      aux.onDidChangeWindowState((state) => {
        if (state.token === entry.token) setIsMaximized(state.geometry.isMaximized)
      }),
    )
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [aux, entry.token])

  const toggleMaximize = (): void => {
    void aux.toggleMaximizeWindow(entry.token).catch(() => undefined)
  }

  return (
    <header className={styles['titlebar']} data-testid="auxiliary-titlebar">
      <div className={styles['drag-region']} aria-hidden="true" />
      <div className={auxStyles['titlebar-left']}>
        {isMac && <div className={styles['traffic-light-spacer']} />}
        <span className={styles['title']} data-testid="auxiliary-titlebar-title">
          {editorTitle}
        </span>
      </div>
      <div className={styles['right']}>
        {!isMac && (
          <WindowControlsView
            isMaximized={isMaximized}
            onMinimize={() => void aux.minimizeWindow(entry.token).catch(() => undefined)}
            onToggleMaximize={toggleMaximize}
            onClose={() => void auxEditor.requestClose(entry).catch(() => undefined)}
          />
        )}
      </div>
    </header>
  )
}
