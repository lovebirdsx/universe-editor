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
import { useLayoutEffect } from 'react'
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

  // The open target follows the last-used editor surface, not window focus: the
  // main window also hosts the sidebar/panel, so only interaction inside this
  // area makes its part the target. Window focus itself (Alt+Tab) changes only
  // `activePart`, which drives commands/context keys/highlight. Activation here
  // is not an editor focus intent.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const activate = (): void => {
      if (groupsService.activePart === layoutPart && groupsService.openTargetPart === layoutPart) {
        return
      }
      groupsService.activatePart(layoutPart, { preserveFocus: true, updateOpenTarget: true })
    }
    el.addEventListener('pointerdown', activate, true)
    el.addEventListener('focusin', activate, true)
    return () => {
      el.removeEventListener('pointerdown', activate, true)
      el.removeEventListener('focusin', activate, true)
    }
  }, [containerRef, groupsService, layoutPart])

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
