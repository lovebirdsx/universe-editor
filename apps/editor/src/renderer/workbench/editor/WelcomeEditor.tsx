/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WelcomeEditor — the default editor shown when no content is open. Surfaces
 *  the recent workspaces list from IWorkspaceService.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import {
  IEditorInput,
  IWorkspaceService,
  localize,
  markAsSingleton,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import styles from './EditorArea.module.css'

const RECENT_LIMIT = 5

export function WelcomeEditor(_props: { input: IEditorInput }) {
  const workspace = useService(IWorkspaceService)
  const recent = useSyncExternalStore(
    (onChange) => {
      const d = markAsSingleton(workspace.onDidChangeRecent(() => onChange()))
      return () => d.dispose()
    },
    () => workspace.recent,
  )
  const visible = recent.slice(0, RECENT_LIMIT)

  return (
    <div className={styles['welcome']}>
      <h1>{localize('app.name', 'Universe Editor')}</h1>
      <p>{localize('app.description', 'A VSCode-paradigm game content editor.')}</p>
      <ul className={styles['shortcutList']}>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+Shift+P</kbd>
          <span>{localize('welcome.commandPalette', 'Open Command Palette')}</span>
        </li>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+`</kbd>
          <span>{localize('welcome.outputPanel', 'Toggle Output Panel')}</span>
        </li>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+\</kbd>
          <span>{localize('welcome.splitEditor', 'Split Editor')}</span>
        </li>
      </ul>
      {visible.length > 0 && (
        <section className={styles['welcome-recent']}>
          <h2>{localize('welcome.recent', 'Recent')}</h2>
          <ul>
            {visible.map((entry) => (
              <li key={entry.folder.toString()}>
                <button
                  type="button"
                  className={styles['welcome-recent-item']}
                  onClick={() => void workspace.openFolder(entry.folder)}
                  title={entry.folder.fsPath}
                >
                  <span className={styles['welcome-recent-name']}>{entry.name}</span>
                  <span className={styles['welcome-recent-path']}>{entry.folder.fsPath}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
