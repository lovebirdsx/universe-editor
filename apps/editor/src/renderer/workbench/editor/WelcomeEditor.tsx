/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WelcomeEditor — the default editor shown when no content is open. Leads with
 *  the Agent call-to-action (the editor's core capability) and surfaces the
 *  recent workspaces list from IWorkspaceService.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore } from 'react'
import { Sparkles } from 'lucide-react'
import {
  ICommandService,
  IEditorInput,
  IEditorService,
  IWorkspaceService,
  localize,
  markAsSingleton,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { DocEditorInput } from '../../services/editor/DocEditorInput.js'
import styles from './EditorArea.module.css'

const RECENT_LIMIT = 5

export function WelcomeEditor(_props: { input: IEditorInput }) {
  const workspace = useService(IWorkspaceService)
  const editorService = useService(IEditorService)
  const commands = useService(ICommandService)
  const recent = useSyncExternalStore(
    (onChange) => {
      const d = markAsSingleton(workspace.onDidChangeRecent(() => onChange()))
      return () => d.dispose()
    },
    () => workspace.recent,
  )
  const visible = recent.slice(0, RECENT_LIMIT)

  const run = (commandId: string) => void commands.executeCommand(commandId)

  return (
    <div className={styles['welcome']}>
      <h1>{localize('app.name', 'Universe Editor')}</h1>
      <p>{localize('app.description', 'A VSCode-paradigm game content editor.')}</p>

      <section className={styles['agentHero']}>
        <div className={styles['agentHeroIcon']} aria-hidden="true">
          <Sparkles size={28} />
        </div>
        <h2 className={styles['agentHeroTitle']}>
          {localize('welcome.agent.title', 'Start with an Agent')}
        </h2>
        <p className={styles['agentHeroDesc']}>
          {localize(
            'welcome.agent.desc',
            'Agents are the heart of this editor — describe what you want and let the AI edit, search, and run alongside you.',
          )}
        </p>
        <div className={styles['agentActions']}>
          <button
            type="button"
            className={styles['agentCta']}
            onClick={() => run('workbench.action.agent.newSession')}
          >
            <Sparkles size={16} />
            <span>{localize('welcome.agent.start', 'Start Your First Agent Session')}</span>
          </button>
          <button
            type="button"
            className={styles['agentSecondary']}
            onClick={() => run('workbench.action.agent.selectAgent')}
          >
            {localize('welcome.agent.select', 'Choose Agent…')}
          </button>
          <button
            type="button"
            className={styles['agentSecondary']}
            onClick={() => run('workbench.action.agent.openView')}
          >
            {localize('welcome.agent.openView', 'Open Agents Panel')}
          </button>
        </div>
      </section>

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
      <section className={styles['welcome-docs']}>
        <h2>{localize('welcome.docs.title', 'Documentation')}</h2>
        <ul>
          <li>
            <button
              type="button"
              className={styles['welcome-doc-item']}
              onClick={() => editorService.openEditor(new DocEditorInput('index'))}
            >
              {localize('welcome.docs.center', 'Browse the documentation center')}
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles['welcome-doc-item']}
              onClick={() =>
                editorService.openEditor(new DocEditorInput('getting-started/interface-tour'))
              }
            >
              {localize('welcome.editorGuide', 'Editor Guide')}
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles['welcome-doc-item']}
              onClick={() => editorService.openEditor(new DocEditorInput('ai-agent/overview'))}
            >
              {localize('welcome.agentGuide', 'Agent Guide')}
            </button>
          </li>
        </ul>
      </section>
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
