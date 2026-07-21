/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorArea — top-level Part container; renders the grid of editor groups.
 *--------------------------------------------------------------------------------------------*/

import { IEditorGroupsService, localize, type IPart } from '@universe-editor/platform'
import { DragSessionProvider, GridLayout } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { WelcomeEditor } from './WelcomeEditor.js'
import { EditorComponentRegistry } from '../../services/editor/EditorComponentRegistry.js'
import { EditorGroupView } from './EditorGroupView.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import styles from './EditorArea.module.css'

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
              resolveComponent={(componentKey) => EditorComponentRegistry.get(componentKey)}
              fallback={welcomeFallback}
            />
          )}
        />
      </DragSessionProvider>
    </div>
  )
}
