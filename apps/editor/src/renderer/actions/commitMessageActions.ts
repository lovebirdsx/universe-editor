/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Commit-message AI commands: pick the model dedicated to commit message generation.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IAiModelService,
  ILayoutService,
  IQuickInputService,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { scmViewState } from '../workbench/scm/scmViewState.js'
import { buildModelPickItems } from './aiModelPickItems.js'

const CATEGORY = localize2('command.category.ai', 'AI')

/**
 * `_workbench.revealScm` — internal bridge the ai extension invokes before
 * generating a commit message, so the streaming write-back into the SCM commit
 * input is visible even when the command was run from the palette (where the
 * SCM panel may not be up). Never declare this id in an extension manifest —
 * it would shadow the renderer handler. Unlike a plain return to the view, this
 * explicitly asks for the commit input instead of the remembered focus region.
 */
export class RevealScmAction extends Action2 {
  static readonly ID = '_workbench.revealScm'
  constructor() {
    super({
      id: RevealScmAction.ID,
      title: localize2('action.ai.revealScm', 'Reveal Source Control'),
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // The generated message streams into this box; restoring the remembered
    // tree row would hide it. Synchronous so focusView's getter sees the intent
    // even before the reveal effect is flushed.
    scmViewState.requestReveal(null, { focusInput: true })
    await accessor.get(ILayoutService).focusView('workbench.view.scm.main', { source: 'command' })
  }
}

export class PickCommitModelAction extends Action2 {
  static readonly ID = 'ai.commitMessage.pickModel'
  constructor() {
    super({
      id: PickCommitModelAction.ID,
      title: localize2('action.ai.commitMessage.pickModel', 'Select Commit Message Model'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const aiModel = accessor.get(IAiModelService)

    const [models, current] = await Promise.all([aiModel.getModels(), aiModel.getCommitModelId()])
    const picked = await quickInput.pick(buildModelPickItems(models, current), {
      id: 'ai.commitMessage.pickModel',
      placeholder: localize(
        'ai.commitMessage.pickModel.placeholder',
        'Select the model used for commit message generation',
      ),
      matchOnDescription: true,
    })
    if (!picked) return
    await aiModel.setCommitModelId(picked.modelId)
  }
}
