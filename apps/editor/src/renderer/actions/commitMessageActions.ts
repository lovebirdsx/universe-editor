/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Commit-message AI commands: pick the model dedicated to commit message generation.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IAiModelService,
  IQuickInputService,
  localize,
  type AiModelMetadata,
  type IQuickPickItem,
  type QuickPickInput,
  type ServicesAccessor,
} from '@universe-editor/platform'

const CATEGORY = localize('command.category.ai', 'AI')

interface ModelPickItem extends IQuickPickItem {
  readonly modelId?: string
}

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

function buildModelPickItems(
  models: readonly AiModelMetadata[],
  active: string | undefined,
): QuickPickInput<ModelPickItem>[] {
  const items: QuickPickInput<ModelPickItem>[] = []
  let lastGroup: string | undefined
  for (const model of models) {
    const label = `${model.vendor}/${model.groupName ?? 'default'}`
    if (label !== lastGroup) {
      items.push({ type: 'separator', id: `sep:${label}`, label })
      lastGroup = label
    }
    items.push({
      id: model.id,
      modelId: model.id,
      label: model.name,
      description: model.family,
      ...(model.id === active ? { statusIconId: 'check' } : {}),
    })
  }
  return items
}
