/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorArea — top-level Part container; renders the grid of editor groups.
 *--------------------------------------------------------------------------------------------*/

import { type ComponentType } from 'react'
import {
  EditorRegistry,
  IEditorGroupsService,
  IEditorInput,
  type IPart,
} from '@universe-editor/platform'
import { useService } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { SettingsEditor } from '../preferences/SettingsEditor.js'
import { SettingsEditorInput } from '../preferences/SettingsEditorInput.js'
import { WelcomeEditorInput } from './WelcomeEditorInput.js'
import { WelcomeEditor } from './WelcomeEditor.js'
import { FileEditorInput } from './FileEditorInput.js'
import { FileEditor } from './FileEditor.js'
import { EditorGroupView } from './EditorGroupView.js'
import { GridLayout } from './GridLayout.js'
import { EditorGroupsService } from './EditorGroupsService.js'
import styles from './EditorArea.module.css'

/** Registry of React components keyed by IEditorProvider.componentKey. */
export const editorComponentMap = new Map<string, ComponentType<{ input: IEditorInput }>>()

// Register built-in welcome editor
editorComponentMap.set('welcome', WelcomeEditor)
editorComponentMap.set('settings', SettingsEditor as ComponentType<{ input: IEditorInput }>)
editorComponentMap.set('file', FileEditor)

// Editor providers map typeId → componentKey so EditorGroupView can resolve the
// React component for any IEditorInput. `deserialize` lets the restore pipeline
// hydrate built-in inputs back from persisted state.
EditorRegistry.registerEditorProvider({
  typeId: WelcomeEditorInput.TYPE_ID,
  componentKey: 'welcome',
  deserialize: () => WelcomeEditorInput.deserialize(),
})
EditorRegistry.registerEditorProvider({
  typeId: SettingsEditorInput.TYPE_ID,
  componentKey: 'settings',
  deserialize: () => SettingsEditorInput.deserialize(),
})
EditorRegistry.registerEditorProvider({
  typeId: FileEditorInput.TYPE_ID,
  componentKey: 'file',
  deserialize: (data, accessor) => FileEditorInput.deserialize(data, accessor),
})

export function EditorArea({ part }: { part?: IPart | undefined } = {}) {
  const groupsService = useService(IEditorGroupsService) as EditorGroupsService
  const containerRef = usePartContainer(part)

  const welcomeFallback = (
    <WelcomeEditor input={{ id: '_welcome', type: 'welcome', label: 'Welcome', isDirty: false }} />
  )

  return (
    <div ref={containerRef} className={styles['editorAreaRoot']}>
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
    </div>
  )
}
