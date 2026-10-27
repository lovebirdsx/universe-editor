/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Merge-editor built-in actions. `_workbench.openMergeEditor` is an internal
 *  command the Git extension invokes with the three already-resolved merge stages
 *  of a conflicted file; the host can't construct an EditorInput, so we build it
 *  here. The navigation/complete actions operate on the active MergeEditorInput.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IContextKeyService,
  IEditorGroupsService,
  IInstantiationService,
  localize2,
  type IEditorGroup,
  type ServicesAccessor,
} from '@universe-editor/platform'
import {
  activateGroupAndFocus,
  type ActivateGroupFocusContext,
} from '../services/editor/activateGroupAndFocus.js'
import { MergeEditorInput, type MergeEditorContents } from '../services/editor/MergeEditorInput.js'
import { openInLockAwareGroup } from '../services/editor/openInLockAwareGroup.js'
import { ensureSideGroup } from '../services/editor/openToSide.js'
import type { TargetedOpen } from '../services/editor/openTarget.js'
import {
  openFreshInputWithTarget,
  openTargetServicesFrom,
} from '../services/editor/openWithTarget.js'
import { IWindowFocusService } from '../services/windows/windowFocusService.js'

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
    // Snapshot before any async fallback: the accessor dies at the first await,
    // but the new-window failure path reveals through it later.
    const focusContext: ActivateGroupFocusContext = {
      groups,
      contextKeyService: accessor.get(IContextKeyService),
      windowFocus: accessor.get(IWindowFocusService),
    }
    const group = groups.openTargetGroup
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

    // Re-opening an already-active merge tab doesn't bump the activation id, so
    // an explicit open must focus the group itself (and bring its window up).
    const revealExisting = (target: IEditorGroup, existing: MergeEditorInput): void => {
      activateGroupAndFocus(target, focusContext)
      target.openEditor(existing, { activate: true, pinned })
    }

    const openDefault = (): void => {
      const existing = group.editors.find((e) => e.id === id)
      if (existing instanceof MergeEditorInput) {
        existing.update(contents)
        revealExisting(group, existing)
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
        revealExisting(side, existing)
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
