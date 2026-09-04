/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiStatusBarButtons tests — the status-bar (bottom-right) AI button:
 *    - renders the AI button (no popover initially)
 *    - clicking the AI button opens the quick-settings popover
 *    - the inline toggle reflects service state and writes back via setEnabled
 *    - picking a model routes to the matching slot picker command
 *    - the Agents / AI-settings shortcuts execute their commands
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import {
  Emitter,
  IAiModelService,
  ICommandService,
  InstantiationService,
  ServiceCollection,
  type AiModelMetadata,
} from '@universe-editor/platform'
import { AiStatusBarButtons } from '../AiStatusBarButtons.js'
import { IInlineCompletionService } from '../../../services/ai/InlineCompletionService.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const MODELS: AiModelMetadata[] = [
  {
    id: 'acme/openai-chat/m1',
    providerId: 'acme',
    protocol: 'openai-chat',
    channelModel: 'm1',
    name: 'Model One',
    family: 'one',
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    capabilities: { streaming: true },
  },
  {
    id: 'ollama/ollama/m2',
    providerId: 'ollama',
    protocol: 'ollama',
    channelModel: 'm2',
    name: 'Model Two',
    family: 'two',
    maxInputTokens: 1000,
    maxOutputTokens: 1000,
    capabilities: { streaming: true },
  },
]

function makeAi() {
  return {
    _serviceBrand: undefined,
    onDidChangeModels: new Emitter<void>().event,
    onDidChangeActiveModel: new Emitter<void>().event,
    onDidChangeInlineCompletionModel: new Emitter<void>().event,
    onDidChangeCommitModel: new Emitter<void>().event,
    onDidChangeSessionTitleModel: new Emitter<void>().event,
    getModels: vi.fn().mockResolvedValue(MODELS),
    getActiveModelId: vi.fn().mockResolvedValue(MODELS[0]!.id),
    getInlineCompletionModelId: vi.fn().mockResolvedValue(undefined),
    getCommitModelId: vi.fn().mockResolvedValue(undefined),
    getSessionTitleModelId: vi.fn().mockResolvedValue(undefined),
    setActiveModelId: vi.fn().mockResolvedValue(undefined),
    setInlineCompletionModelId: vi.fn().mockResolvedValue(undefined),
    setCommitModelId: vi.fn().mockResolvedValue(undefined),
    setSessionTitleModelId: vi.fn().mockResolvedValue(undefined),
  }
}

function makeInline() {
  return {
    _serviceBrand: undefined,
    onDidChange: new Emitter<void>().event,
    enabled: true,
    requesting: false,
    getModelId: vi.fn().mockResolvedValue(undefined),
    setModelId: vi.fn(),
    toggleEnabled: vi.fn(),
    setEnabled: vi.fn(),
  }
}

function renderButtons(
  ai = makeAi(),
  inline = makeInline(),
  commands = { executeCommand: vi.fn() },
) {
  const services = new ServiceCollection()
  services.set(IAiModelService, ai as never)
  services.set(IInlineCompletionService, inline as never)
  services.set(ICommandService, commands as never)
  const inst = new InstantiationService(services)
  render(<AiStatusBarButtons />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { ai, inline, commands }
}

describe('AiStatusBarButtons', () => {
  it('renders the AI button without a popover', () => {
    renderButtons()
    expect(screen.getByTestId('statusbar-entry-ai')).toBeTruthy()
    expect(screen.getByTestId('statusbar-ai-button')).toBeTruthy()
    expect(screen.queryByTestId('ai-quick-settings')).toBeNull()
  })

  it('opens the popover on click', async () => {
    renderButtons()
    fireEvent.click(screen.getByTestId('statusbar-ai-button'))
    expect(await screen.findByTestId('ai-quick-settings')).toBeTruthy()
  })

  it('writes the inline toggle back to the service', async () => {
    const { inline } = renderButtons()
    fireEvent.click(screen.getByTestId('statusbar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-inline-toggle'))
    expect(inline.setEnabled).toHaveBeenCalledWith(false)
  })

  it('opens the slot model picker command when a model row is clicked', async () => {
    const { commands } = renderButtons()
    fireEvent.click(screen.getByTestId('statusbar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-model-chat'))
    expect(commands.executeCommand).toHaveBeenCalledWith('ai.pickModel')
  })

  it('runs the Agents and AI-settings commands', async () => {
    const { commands } = renderButtons()
    fireEvent.click(screen.getByTestId('statusbar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-open-agents'))
    fireEvent.click(screen.getByTestId('statusbar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-open-settings'))
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.agent.openView')
    expect(commands.executeCommand).toHaveBeenCalledWith('ai.manageModels')
  })

  it('names a configured slot from its id while the enumeration is still in flight', async () => {
    const ai = makeAi()
    // A hung /v1/models must not make a configured slot read "Select model…".
    ai.getModels = vi.fn(() => new Promise<AiModelMetadata[]>(() => {}))
    renderButtons(ai)
    fireEvent.click(screen.getByTestId('statusbar-ai-button'))
    await screen.findByTestId('ai-quick-settings')

    expect(screen.getByTestId('ai-quick-settings-model-chat').textContent).toBe('m1')
    expect(screen.getByTestId('ai-quick-settings-model-commit').textContent).toBe('Select model…')
  })
})
