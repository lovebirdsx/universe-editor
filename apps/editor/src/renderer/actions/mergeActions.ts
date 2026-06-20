/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Merge-editor built-in actions. `_workbench.openMergeEditor` is an internal
 *  command the Git extension invokes with the three already-resolved merge stages
 *  of a conflicted file; the host can't construct an EditorInput, so we build it
 *  here. The navigation/complete actions operate on the active MergeEditorInput.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IInstantiationService,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { MergeEditorInput, type MergeEditorContents } from '../services/editor/MergeEditorInput.js'

export interface OpenMergeEditorPayload extends MergeEditorContents {
  readonly pinned?: boolean
}

export class OpenMergeEditorAction extends Action2 {
  static readonly ID = '_workbench.openMergeEditor'

  constructor() {
    super({ id: OpenMergeEditorAction.ID, title: 'Open Merge Editor' })
  }

  override run(accessor: ServicesAccessor, payload: OpenMergeEditorPayload): void {
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const group = groups.activeGroup
    const id = `merge:${payload.path}`

    const contents: MergeEditorContents = {
      path: payload.path,
      base: payload.base,
      current: payload.current,
      incoming: payload.incoming,
      merged: payload.merged,
      currentLabel: payload.currentLabel,
      incomingLabel: payload.incomingLabel,
    }

    const existing = group.editors.find((e) => e.id === id)
    if (existing instanceof MergeEditorInput) {
      existing.update(contents)
      group.openEditor(existing, { activate: true, pinned: payload.pinned ?? true })
      return
    }

    const input = inst.createInstance(MergeEditorInput, contents)
    group.openEditor(input, { activate: true, pinned: payload.pinned ?? true })
  }
}

export class CompleteMergeAction extends Action2 {
  static readonly ID = 'merge.completeMerge'

  constructor() {
    super({
      id: CompleteMergeAction.ID,
      title: localize2('action.completeMerge.title', 'Complete Merge'),
      category: localize2('command.category.merge', 'Merge Editor'),
      precondition: 'isInMergeEditor',
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const group = accessor.get(IEditorGroupsService).activeGroup
    const active = group.activeEditor
    if (!(active instanceof MergeEditorInput)) return
    const saved = await active.save?.()
    if (saved) group.closeEditor(active)
  }
}
