/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorArea — top-level Part container; renders the grid of editor groups.
 *--------------------------------------------------------------------------------------------*/

import { type ComponentType } from 'react'
import { IEditorGroupsService, IEditorInput, localize, type IPart } from '@universe-editor/platform'
import { DragSessionProvider } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { SettingsEditor } from '../preferences/SettingsEditor.js'
import { KeybindingsEditor } from '../keybindings/KeybindingsEditor.js'
import { WelcomeEditor } from './WelcomeEditor.js'
import { FileEditor } from './FileEditor.js'
import { DiffEditor } from './DiffEditor.js'
import { MarkdownPreviewEditor } from './MarkdownPreviewEditor.js'
import { ReleaseNotesEditor } from './ReleaseNotesEditor.js'
import { DocEditor } from './DocEditor.js'
import { AcpSessionEditor } from '../agents/AcpSessionEditor.js'
import { EditorGroupView } from './EditorGroupView.js'
import { GridLayout } from './GridLayout.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import styles from './EditorArea.module.css'

/** Registry of React components keyed by IEditorProvider.componentKey. */
export const editorComponentMap = new Map<string, ComponentType<{ input: IEditorInput }>>()

editorComponentMap.set('welcome', WelcomeEditor)
editorComponentMap.set('settings', SettingsEditor as ComponentType<{ input: IEditorInput }>)
editorComponentMap.set('keybindings', KeybindingsEditor as ComponentType<{ input: IEditorInput }>)
editorComponentMap.set('file', FileEditor)
editorComponentMap.set('diff', DiffEditor)
editorComponentMap.set('markdown.preview', MarkdownPreviewEditor)
editorComponentMap.set('releaseNotes', ReleaseNotesEditor)
editorComponentMap.set('doc', DocEditor)
editorComponentMap.set('agents.session', AcpSessionEditor)

export function EditorArea({ part }: { part?: IPart | undefined } = {}) {
  const groupsService = useService(IEditorGroupsService) as EditorGroupsService
  const containerRef = usePartContainer(part)

  const welcomeFallback = (
    <WelcomeEditor
      input={{
        id: '_welcome',
        type: 'welcome',
        label: localize('app.name', 'Universe Editor'),
        isDirty: false,
      }}
    />
  )

  return (
    <div ref={containerRef} className={styles['editorAreaRoot']} data-testid="part-editorArea">
      <DragSessionProvider>
        <GridLayout
          grid={groupsService.grid}
          viewFactory={(group) => (
            <EditorGroupView
              key={group.id}
              group={group}
              groupsService={groupsService}
              componentMap={editorComponentMap}
              fallback={welcomeFallback}
            />
          )}
        />
      </DragSessionProvider>
    </div>
  )
}
