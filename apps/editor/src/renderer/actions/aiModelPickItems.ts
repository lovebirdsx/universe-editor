/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared QuickPick item builder for the AI model pickers (chat / inline
 *  completion / commit message). All three group models by `vendor/group`,
 *  show the model family as the description, and mark the current selection
 *  with a check — keeping the picking experience identical everywhere.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelMetadata, IQuickPickItem, QuickPickInput } from '@universe-editor/platform'

export interface ModelPickItem extends IQuickPickItem {
  readonly modelId?: string
}

export function buildModelPickItems(
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
