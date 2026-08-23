/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  buildModelPickItems tests — the picker groups by providerId, degrades the group
 *  label to providerId/protocol when a provider spans several protocols, filters
 *  out the agent-only openai-responses stub, and marks the active model.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type {
  AiModelMetadata,
  AiWireProtocol,
  IQuickPickSeparator,
  QuickPickInput,
} from '@universe-editor/platform'
import { buildModelPickItems, type ModelPickItem } from '../aiModelPickItems.js'

function model(
  providerId: string,
  protocol: AiWireProtocol,
  channelModel: string,
): AiModelMetadata {
  return {
    id: `${providerId}/${protocol}/${channelModel}`,
    providerId,
    protocol,
    channelModel,
    name: channelModel,
    family: 'f',
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    capabilities: { streaming: true },
  }
}

function isSeparator(item: QuickPickInput<ModelPickItem>): item is IQuickPickSeparator {
  return (item as IQuickPickSeparator).type === 'separator'
}

function separators(items: QuickPickInput<ModelPickItem>[]): readonly (string | undefined)[] {
  return items.filter(isSeparator).map((i) => i.label)
}

function modelIds(items: QuickPickInput<ModelPickItem>[]): readonly (string | undefined)[] {
  return items.filter((i): i is ModelPickItem => !isSeparator(i)).map((i) => i.modelId)
}

describe('buildModelPickItems', () => {
  it('groups models by providerId', () => {
    const models = [
      model('kuro', 'openai-chat', 'a'),
      model('kuro', 'openai-chat', 'b'),
      model('ollama', 'ollama', 'c'),
    ]
    expect(separators(buildModelPickItems(models, undefined))).toEqual(['kuro', 'ollama'])
  })

  it('degrades the group label to providerId/protocol when a provider spans protocols', () => {
    const models = [model('kuro', 'openai-chat', 'a'), model('kuro', 'anthropic-messages', 'b')]
    expect(separators(buildModelPickItems(models, undefined))).toEqual([
      'kuro/openai-chat',
      'kuro/anthropic-messages',
    ])
  })

  it('filters out the agent-only openai-responses models', () => {
    const models = [
      model('openai', 'openai-responses', 'stub'),
      model('openai', 'openai-chat', 'gpt-4o'),
    ]
    expect(modelIds(buildModelPickItems(models, undefined))).toEqual(['openai/openai-chat/gpt-4o'])
  })

  it('marks the active model with a check', () => {
    const models = [model('kuro', 'openai-chat', 'a'), model('kuro', 'openai-chat', 'b')]
    const items = buildModelPickItems(models, 'kuro/openai-chat/b')
    const active = items
      .filter((i): i is ModelPickItem => !isSeparator(i))
      .find((i) => i.id === 'kuro/openai-chat/b')
    expect(active?.statusIconId).toBe('check')
  })
})
