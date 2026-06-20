/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AI session-title commands: pick the model dedicated to generating friendly
 *  titles for ACP sessions.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IAiModelService,
  IQuickInputService,
  localize,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { buildModelPickItems } from './aiModelPickItems.js'

const CATEGORY = localize2('command.category.ai', 'AI')

export class PickSessionTitleModelAction extends Action2 {
  static readonly ID = 'ai.sessionTitle.pickModel'
  constructor() {
    super({
      id: PickSessionTitleModelAction.ID,
      title: localize2('action.ai.sessionTitle.pickModel', 'Select Session Title Model'),
      category: CATEGORY,
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const quickInput = accessor.get(IQuickInputService)
    const aiModel = accessor.get(IAiModelService)

    const [models, current] = await Promise.all([
      aiModel.getModels(),
      aiModel.getSessionTitleModelId(),
    ])
    const picked = await quickInput.pick(buildModelPickItems(models, current), {
      id: 'ai.sessionTitle.pickModel',
      placeholder: localize(
        'ai.sessionTitle.pickModel.placeholder',
        'Select the model used for session title generation',
      ),
      matchOnDescription: true,
    })
    if (!picked) return
    await aiModel.setSessionTitleModelId(picked.modelId)
  }
}
