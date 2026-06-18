/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Commit-message AI commands: pick the model dedicated to commit message generation.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IAiModelService,
  IQuickInputService,
  localize,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { buildModelPickItems } from './aiModelPickItems.js'

const CATEGORY = localize('command.category.ai', 'AI')

export class PickCommitModelAction extends Action2 {
  static readonly ID = 'ai.commitMessage.pickModel'
  constructor() {
    super({
      id: PickCommitModelAction.ID,
      title: localize('action.ai.commitMessage.pickModel', 'Select Commit Message Model'),
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
