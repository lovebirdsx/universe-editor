/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  AddProviderDialog tests — the "pick a type first" flow: selecting an existing
 *  type reuses its models/rates (no model/rate form, reuse hint shown), the
 *  "new type" branch writes the type before the instance, and duplicate names
 *  within a type are rejected.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  IAiModelService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  type AiProviderInstance,
  type AiProviderType,
  type AiProviderTypeDescriptor,
} from '@universe-editor/platform'
import { AddProviderDialog } from '../AddProviderDialog.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

class FakeDialogAiModel {
  descriptors: readonly AiProviderTypeDescriptor[] = []
  getProviderTypeDescriptors = vi.fn(async () => this.descriptors)
  verifyProvider = vi.fn(async () => ({ ok: true, modelCount: 1 }))
  updateProviderTypes = vi.fn(async () => {})
  updateProviders = vi.fn(async () => {})
}

class FakeStorage {
  private readonly map = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  get = vi.fn(async (key: string) => this.map.get(key))
  set = vi.fn(async (key: string, value: unknown) => {
    this.map.set(key, value)
  })
  remove = vi.fn(async (key: string) => {
    this.map.delete(key)
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {})
}

function renderDialog(
  aiModel: FakeDialogAiModel,
  {
    existingInstances = [],
    existingTypes = {},
  }: {
    existingInstances?: readonly AiProviderInstance[]
    existingTypes?: Readonly<Record<string, AiProviderType>>
  } = {},
) {
  const services = new ServiceCollection()
  services.set(IAiModelService, aiModel as unknown as IAiModelService)
  services.set(IStorageService, new FakeStorage() as unknown as IStorageService)
  const inst = new InstantiationService(services)
  const utils = render(
    <AddProviderDialog
      existingInstances={existingInstances}
      existingTypes={existingTypes}
      onClose={vi.fn()}
      onCreated={vi.fn()}
    />,
    {
      wrapper: ({ children }) => (
        <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
      ),
    },
  )
  return { ...utils, aiModel }
}

const ANTHROPIC_DESCRIPTOR: AiProviderTypeDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  protocol: 'anthropic-messages',
  requiresApiKey: true,
  builtin: true,
}
const KURO_DESCRIPTOR: AiProviderTypeDescriptor = {
  id: 'kuro',
  label: 'Kuro',
  protocol: 'anthropic-messages',
  requiresApiKey: true,
  builtin: false,
}

describe('AddProviderDialog', () => {
  it('reuses an existing type: no model/rate form and the reuse hint is shown', async () => {
    const aiModel = new FakeDialogAiModel()
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR, KURO_DESCRIPTOR]
    const kuro: AiProviderType = {
      label: 'Kuro',
      protocol: 'anthropic-messages',
      models: [{ id: 'm1' }, { id: 'm2' }],
    }
    renderDialog(aiModel, { existingTypes: { kuro } })
    await flushEffects()

    const select = screen.getByLabelText('Provider type') as HTMLSelectElement
    expect(select.value).toBe('anthropic')
    fireEvent.change(select, { target: { value: 'kuro' } })

    expect(screen.getByText('Will reuse the 2 models and rates of Kuro.')).toBeTruthy()
    expect(screen.queryByText('per 1M tokens')).toBeNull()
    expect(screen.queryByLabelText('Protocol')).toBeNull()
  })

  it('writes the new type before the instance in the "new type" branch', async () => {
    const aiModel = new FakeDialogAiModel()
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR]
    renderDialog(aiModel)
    await flushEffects()

    fireEvent.change(screen.getByLabelText('Provider type'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByPlaceholderText('my-gateway'), { target: { value: 'kuro' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await flushEffects()

    expect(aiModel.updateProviderTypes).toHaveBeenCalledTimes(1)
    expect(aiModel.updateProviders).toHaveBeenCalledTimes(1)
    expect(aiModel.updateProviderTypes.mock.invocationCallOrder[0]).toBeLessThan(
      aiModel.updateProviders.mock.invocationCallOrder[0]!,
    )
    expect(aiModel.updateProviderTypes).toHaveBeenCalledWith({
      kuro: expect.objectContaining({ protocol: 'openai-chat' }),
    })
    expect(aiModel.updateProviders).toHaveBeenCalledWith([{ type: 'kuro', name: 'default' }])
  })

  it('rejects a duplicate instance name within the selected type', async () => {
    const aiModel = new FakeDialogAiModel()
    aiModel.descriptors = [ANTHROPIC_DESCRIPTOR]
    renderDialog(aiModel, {
      existingInstances: [{ name: 'default', type: 'anthropic' }],
    })
    await flushEffects()

    expect(screen.getByText('That provider already exists for this type.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
