/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared QuickPick item builder for the AI model pickers (chat / inline
 *  completion / commit message). All three group models by `providerId`, show the
 *  model family as the description, and mark the current selection with a check —
 *  keeping the picking experience identical everywhere. `openai-responses` is an
 *  agent-only stub and is filtered out; when one provider spans several protocols
 *  the group label degrades to `providerId/protocol` so two same-named rows stay
 *  distinguishable.
 *--------------------------------------------------------------------------------------------*/

import {
  isEditorSelectable,
  type AiModelMetadata,
  type IQuickPickItem,
  type QuickPickInput,
} from '@universe-editor/platform'

export interface ModelPickItem extends IQuickPickItem {
  readonly modelId?: string
}

export function buildModelPickItems(
  models: readonly AiModelMetadata[],
  active: string | undefined,
): QuickPickInput<ModelPickItem>[] {
  const selectable = models.filter(isEditorSelectable)
  // Count distinct protocols: a provider with two models under one protocol still
  // groups under the bare provider id, while one spanning several protocols gets
  // the `providerId/protocol` label so same-named rows stay distinguishable.
  const protocols = new Map<string, Set<string>>()
  for (const model of selectable) {
    let set = protocols.get(model.providerId)
    if (set === undefined) {
      set = new Set()
      protocols.set(model.providerId, set)
    }
    set.add(model.protocol)
  }

  const items: QuickPickInput<ModelPickItem>[] = []
  let lastGroup: string | undefined
  for (const model of selectable) {
    const multiProtocol = (protocols.get(model.providerId)?.size ?? 0) > 1
    const label = multiProtocol ? `${model.providerId}/${model.protocol}` : model.providerId
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
