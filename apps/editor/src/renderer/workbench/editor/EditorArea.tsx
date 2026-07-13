/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorArea — top-level Part container; renders the grid of editor groups.
 *--------------------------------------------------------------------------------------------*/

import { type ComponentType } from 'react'
import { IEditorGroupsService, IEditorInput, localize, type IPart } from '@universe-editor/platform'
import { DragSessionProvider, GridLayout } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { SettingsEditor } from '../preferences/SettingsEditor.js'
import { AiSettingsEditor } from '../ai/AiSettingsEditor.js'
import { KeybindingsEditor } from '../keybindings/KeybindingsEditor.js'
import { WelcomeEditor } from './WelcomeEditor.js'
import { FileEditor } from './FileEditor.js'
import { DiffEditor } from './DiffEditor.js'
import { MergeEditor } from './MergeEditor.js'
import { MarkdownPreviewEditor } from './MarkdownPreviewEditor.js'
import { ImageEditor } from './ImageEditor.js'
import { ReleaseNotesEditor } from './ReleaseNotesEditor.js'
import { StartupPerformanceEditor } from './StartupPerformanceEditor.js'
import { DocEditor } from './DocEditor.js'
import { AcpSessionEditor } from '../agents/AcpSessionEditor.js'
import { TerminalEditorView } from './TerminalEditorView.js'
import { GitGraphEditor } from '../gitGraph/GitGraphEditor.js'
import { PerforceGraphEditor } from '../perforceGraph/PerforceGraphEditor.js'
import { SwarmReviewEditor } from '../swarm/SwarmReviewEditor.js'
import { SwarmDiffEditor } from '../swarm/SwarmDiffEditor.js'
import { ExtensionEditor } from '../extensions/ExtensionEditor.js'
import { CustomEditorHost } from './CustomEditorHost.js'
import { EditorGroupView } from './EditorGroupView.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import styles from './EditorArea.module.css'

/** Registry of React components keyed by IEditorProvider.componentKey. */
export const editorComponentMap = new Map<string, ComponentType<{ input: IEditorInput }>>()

editorComponentMap.set('welcome', WelcomeEditor)
editorComponentMap.set('settings', SettingsEditor as ComponentType<{ input: IEditorInput }>)
editorComponentMap.set('aiSettings', AiSettingsEditor as ComponentType<{ input: IEditorInput }>)
editorComponentMap.set('keybindings', KeybindingsEditor as ComponentType<{ input: IEditorInput }>)
editorComponentMap.set('file', FileEditor)
editorComponentMap.set('diff', DiffEditor)
editorComponentMap.set('merge', MergeEditor)
editorComponentMap.set('markdown.preview', MarkdownPreviewEditor)
editorComponentMap.set('image', ImageEditor)
editorComponentMap.set('releaseNotes', ReleaseNotesEditor)
editorComponentMap.set('startupPerformance', StartupPerformanceEditor)
editorComponentMap.set('doc', DocEditor)
editorComponentMap.set('agents.session', AcpSessionEditor)
editorComponentMap.set('gitGraph', GitGraphEditor)
editorComponentMap.set('perforceGraph', PerforceGraphEditor)
editorComponentMap.set('swarmReview', SwarmReviewEditor)
editorComponentMap.set('swarmDiff', SwarmDiffEditor)
editorComponentMap.set('extensionDetail', ExtensionEditor)
editorComponentMap.set('customEditor', CustomEditorHost)
editorComponentMap.set(
  'terminal.editor',
  TerminalEditorView as ComponentType<{ input: IEditorInput }>,
)

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
