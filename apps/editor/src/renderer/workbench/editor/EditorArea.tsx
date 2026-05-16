/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorArea — top-level Part container; renders the grid of editor groups.
 *--------------------------------------------------------------------------------------------*/

import { type ComponentType } from 'react'
import { IEditorGroupsService, IEditorInput, type IPart } from '@universe-editor/platform'
import { useService } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { EditorGroupView } from './EditorGroupView.js'
import { GridLayout } from './GridLayout.js'
import { EditorGroupsService } from './EditorGroupsService.js'
import styles from './EditorArea.module.css'

/** Registry of React components keyed by IEditorProvider.componentKey. */
export const editorComponentMap = new Map<string, ComponentType<{ input: IEditorInput }>>()

// Register built-in welcome editor
editorComponentMap.set('welcome', WelcomeEditor)

function WelcomeEditor(_props: { input: IEditorInput }) {
  return (
    <div className={styles['welcome']}>
      <h1>Universe Editor</h1>
      <p>A VSCode-paradigm game content editor.</p>
      <ul className={styles['shortcutList']}>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+Shift+P</kbd>
          <span>Open Command Palette</span>
        </li>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+`</kbd>
          <span>Toggle Output Panel</span>
        </li>
        <li className={styles['shortcutItem']}>
          <kbd className={styles['kbd']}>Ctrl+\</kbd>
          <span>Split Editor</span>
        </li>
      </ul>
    </div>
  )
}

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
