/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiFeatureModelsPanel tests — the four feature rows and, above all, the rule
 *  that only an empty slot reads "Not set". A configured id whose metadata is
 *  still being enumerated (or can no longer be resolved at all) is decomposed
 *  back into its wire name, because `activeModels.<slot>` really does hold a
 *  value and calling that "Not set" is a lie.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  Emitter,
  IAiModelService,
  ICommandService,
  InstantiationService,
  ServiceCollection,
  type AiModelMetadata,
} from '@universe-editor/platform'
import { AiFeatureModelsPanel } from '../AiFeatureModelsPanel.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const ACME_MODEL: AiModelMetadata = {
  id: 'acme/anthropic-messages/qwen3-coder',
  providerId: 'acme',
  protocol: 'anthropic-messages',
  channelModel: 'qwen3-coder',
  name: 'Qwen3 Coder',
  family: 'qwen3',
  maxInputTokens: 1000,
  maxOutputTokens: 1000,
  capabilities: { streaming: true },
}

interface ActiveSlots {
  chat?: string | undefined
  inline?: string | undefined
  commit?: string | undefined
  sessionTitle?: string | undefined
}

class FakeAiModelService {
  private readonly _onDidChangeModels = new Emitter<void>()
  private readonly _onDidChangeActiveModel = new Emitter<void>()
  private readonly _onDidChangeInlineCompletionModel = new Emitter<void>()
  private readonly _onDidChangeCommitModel = new Emitter<void>()
  private readonly _onDidChangeSessionTitleModel = new Emitter<void>()
  readonly onDidChangeModels = this._onDidChangeModels.event
  readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event
  readonly onDidChangeInlineCompletionModel = this._onDidChangeInlineCompletionModel.event
  readonly onDidChangeCommitModel = this._onDidChangeCommitModel.event
  readonly onDidChangeSessionTitleModel = this._onDidChangeSessionTitleModel.event

  models: readonly AiModelMetadata[] = []
  active: ActiveSlots = {}

  getModels = vi.fn(async () => this.models)
  getActiveModelId = vi.fn(async () => this.active.chat)
  getInlineCompletionModelId = vi.fn(async () => this.active.inline)
  getCommitModelId = vi.fn(async () => this.active.commit)
  getSessionTitleModelId = vi.fn(async () => this.active.sessionTitle)

  fireActiveModelChanged(): void {
    this._onDidChangeActiveModel.fire()
  }
  fireModelsChanged(): void {
    this._onDidChangeModels.fire()
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

function renderPanel(aiModel: FakeAiModelService, commands = { executeCommand: vi.fn() }) {
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as unknown as IAiModelService)
  services.set(ICommandService, commands as unknown as ICommandService)
  const inst = new InstantiationService(services)
  const utils = render(<AiFeatureModelsPanel />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { ...utils, aiModel, commands }
}

/** The value cell of the row whose feature label is `label`. */
function valueOf(label: string): HTMLElement {
  const row = screen.getByText(label).closest('button')
  expect(row, `feature row ${label}`).toBeTruthy()
  const value = row!.querySelector<HTMLElement>('[class*="featureValue"]')
  expect(value, `value cell of ${label}`).toBeTruthy()
  return value!
}

describe('AiFeatureModelsPanel', () => {
  it('shows the wire name, not "Not set", while the enumeration is still in flight', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.active = { chat: ACME_MODEL.id }
    aiModel.getModels = vi.fn(() => new Promise<readonly AiModelMetadata[]>(() => {}))

    renderPanel(aiModel)
    await flushEffects()

    expect(valueOf('Chat').textContent).toContain('qwen3-coder')
    expect(valueOf('Chat').textContent).not.toContain('Not set')
    // Slots that really are empty still say so.
    expect(valueOf('Commit Message').textContent).toContain('Not set')
  })

  it('upgrades to the friendly model name once the enumeration lands', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.active = { chat: ACME_MODEL.id }
    aiModel.models = [ACME_MODEL]

    renderPanel(aiModel)
    await flushEffects()

    const value = valueOf('Chat')
    expect(value.textContent).toContain('Qwen3 Coder')
    expect(value.textContent).toContain('acme')
    expect(value.textContent).not.toContain('Unavailable')
  })

  it('marks a configured id missing from the list as Unavailable, never as unset', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.active = { chat: ACME_MODEL.id }
    aiModel.models = []

    renderPanel(aiModel)
    await flushEffects()

    const value = valueOf('Chat')
    expect(value.textContent).toContain('qwen3-coder')
    expect(value.textContent).toContain('acme')
    expect(value.textContent).toContain('Unavailable')
    expect(value.textContent).not.toContain('Not set')
  })

  it('shows "Not set" for every slot when nothing is configured', async () => {
    const aiModel = new FakeAiModelService()

    renderPanel(aiModel)
    await flushEffects()

    expect(screen.getAllByText('Not set')).toHaveLength(4)
  })

  it('reloads on an active-model change event', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.models = [ACME_MODEL]

    renderPanel(aiModel)
    await flushEffects()
    expect(valueOf('Chat').textContent).toContain('Not set')
    expect(aiModel.getModels).toHaveBeenCalledTimes(1)

    aiModel.active = { chat: ACME_MODEL.id }
    aiModel.fireActiveModelChanged()
    await flushEffects()

    expect(valueOf('Chat').textContent).toContain('Qwen3 Coder')
    expect(aiModel.getModels).toHaveBeenCalledTimes(2)
  })

  it('a stale getModels result does not overwrite a newer reload', async () => {
    const aiModel = new FakeAiModelService()
    aiModel.active = { chat: ACME_MODEL.id }
    const gates: Array<(models: readonly AiModelMetadata[]) => void> = []
    aiModel.getModels = vi.fn(
      () =>
        new Promise<readonly AiModelMetadata[]>((resolve) => {
          gates.push(resolve)
        }),
    )

    renderPanel(aiModel)
    await flushEffects()
    expect(gates).toHaveLength(1)

    aiModel.fireModelsChanged()
    await flushEffects()
    expect(gates).toHaveLength(2)

    // The newer enumeration resolves first and resolves the model…
    gates[1]?.([ACME_MODEL])
    await flushEffects()
    expect(valueOf('Chat').textContent).toContain('Qwen3 Coder')

    // …then the stale mount enumeration answers empty; it must not win, or the
    // row would regress to the degraded "Unavailable" rendering.
    gates[0]?.([])
    await flushEffects()
    expect(valueOf('Chat').textContent).toContain('Qwen3 Coder')
    expect(valueOf('Chat').textContent).not.toContain('Unavailable')
  })
})
