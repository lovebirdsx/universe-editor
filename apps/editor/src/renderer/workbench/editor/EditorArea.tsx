/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorArea — top-level Part container; renders the grid of editor groups.
 *--------------------------------------------------------------------------------------------*/

import {
  IEditorGroupsService,
  localize,
  type IEditorPart,
  type IPart,
} from '@universe-editor/platform'
import { GridLayout } from '@universe-editor/workbench-ui'
import { useService } from '../useService.js'
import { usePartContainer } from '../usePartContainer.js'
import { WelcomeEditor } from './WelcomeEditor.js'
import { EditorComponentRegistry } from '../../services/editor/EditorComponentRegistry.js'
import { EditorGroupView } from './EditorGroupView.js'
import type { EditorGroup } from '../../services/editor/EditorGroup.js'
import styles from './EditorArea.module.css'

export function EditorArea({
  part,
  editorPart,
}: { part?: IPart | undefined; editorPart?: IEditorPart | undefined } = {}) {
  const groupsService = useService(IEditorGroupsService)
  const containerRef = usePartContainer(part)
  // A workbench window renders its own part's layout; global group enumeration
  // (Save All, dirty checks) deliberately stays on `groupsService.groups`.
  const layoutPart = editorPart ?? groupsService.mainPart

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
      <GridLayout
        grid={layoutPart.grid}
        viewFactory={(group) => (
          <EditorGroupView
            key={group.id}
            group={group as EditorGroup}
            groupsService={groupsService}
            resolveComponent={(componentKey) => EditorComponentRegistry.get(componentKey)}
            fallback={welcomeFallback}
          />
        )}
      />
    </div>
  )
}
