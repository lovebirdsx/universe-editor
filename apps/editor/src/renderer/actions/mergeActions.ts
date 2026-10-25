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
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { ensureSideGroup } from '../services/editor/openToSide.js'
import type { TargetedOpen } from '../services/editor/openTarget.js'
import {
  openFreshInputWithTarget,
  openTargetServicesFrom,
} from '../services/editor/openWithTarget.js'

export interface OpenMergeEditorPayload extends MergeEditorContents {
  readonly pinned?: boolean
  /** Where to open: omitted = the existing active-group path. */
  readonly openTarget?: TargetedOpen
}

export class OpenMergeEditorAction extends Action2 {
  static readonly ID = '_workbench.openMergeEditor'

  constructor() {
    super({
      id: OpenMergeEditorAction.ID,
      title: localize2('action.merge.openMergeEditor', 'Open Merge Editor'),
    })
  }

  override run(accessor: ServicesAccessor, payload: OpenMergeEditorPayload): void {
    const groups = accessor.get(IEditorGroupsService)
    const inst = accessor.get(IInstantiationService)
    const group = groups.activeGroup
    const id = `merge:${payload.path}`
    const pinned = payload.pinned ?? true

    const contents: MergeEditorContents = {
      path: payload.path,
      base: payload.base,
      current: payload.current,
      incoming: payload.incoming,
      merged: payload.merged,
      currentLabel: payload.currentLabel,
      incomingLabel: payload.incomingLabel,
      ...(payload.saveCommand ? { saveCommand: payload.saveCommand } : {}),
    }

    const createInput = (): MergeEditorInput => inst.createInstance(MergeEditorInput, contents)

    const openDefault = (): void => {
      const existing = group.editors.find((e) => e.id === id)
      if (existing instanceof MergeEditorInput) {
        existing.update(contents)
        group.openEditor(existing, { activate: true, pinned })
        return
      }
      group.openEditor(createInput(), { activate: true, pinned })
    }

    const target = payload.openTarget
    if (target === undefined) {
      openDefault()
      return
    }

    if (target === 'side') {
      const side = ensureSideGroup(groups)
      const existing = side.editors.find((e) => e.id === id)
      if (existing instanceof MergeEditorInput) {
        existing.update(contents)
        side.openEditor(existing, { activate: true, pinned })
        return
      }
      openInLockAwareGroup(groups, createInput(), { activate: true, pinned }, side)
      return
    }

    const services = openTargetServicesFrom(accessor)
    const input = createInput()
    void openFreshInputWithTarget(services, input, target, { pinned }).then((result) => {
      if (result.handled) return
      if (!input.isDisposed) input.dispose()
      openDefault()
    })
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
