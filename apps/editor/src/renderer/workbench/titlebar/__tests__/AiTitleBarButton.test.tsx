/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AiTitleBarButton tests — the AI quick-settings entry in the title bar:
 *    - renders a sparkle button (no popover initially)
 *    - clicking opens the quick-settings popover
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
import { AiTitleBarButton } from '../AiTitleBarButton.js'
import { IInlineCompletionService } from '../../../services/ai/InlineCompletionService.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const MODELS: AiModelMetadata[] = [
  { id: 'm1', name: 'Model One', vendor: 'openai', groupName: 'default' } as AiModelMetadata,
  { id: 'm2', name: 'Model Two', vendor: 'ollama', groupName: 'default' } as AiModelMetadata,
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
    getActiveModelId: vi.fn().mockResolvedValue('m1'),
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

function renderButton(
  ai = makeAi(),
  inline = makeInline(),
  commands = { executeCommand: vi.fn() },
) {
  const services = new ServiceCollection()
  services.set(IAiModelService, ai as never)
  services.set(IInlineCompletionService, inline as never)
  services.set(ICommandService, commands as never)
  const inst = new InstantiationService(services)
  render(<AiTitleBarButton />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { ai, inline, commands }
}

describe('AiTitleBarButton', () => {
  it('renders the sparkle button without a popover', () => {
    renderButton()
    expect(screen.getByTestId('titlebar-ai-button')).toBeTruthy()
    expect(screen.queryByTestId('ai-quick-settings')).toBeNull()
  })

  it('opens the popover on click', async () => {
    renderButton()
    fireEvent.click(screen.getByTestId('titlebar-ai-button'))
    expect(await screen.findByTestId('ai-quick-settings')).toBeTruthy()
  })

  it('writes the inline toggle back to the service', async () => {
    const { inline } = renderButton()
    fireEvent.click(screen.getByTestId('titlebar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-inline-toggle'))
    expect(inline.setEnabled).toHaveBeenCalledWith(false)
  })

  it('opens the slot model picker command when a model row is clicked', async () => {
    const { commands } = renderButton()
    fireEvent.click(screen.getByTestId('titlebar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-model-chat'))
    expect(commands.executeCommand).toHaveBeenCalledWith('ai.pickModel')
  })

  it('runs the Agents and AI-settings commands', async () => {
    const { commands } = renderButton()
    fireEvent.click(screen.getByTestId('titlebar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-open-agents'))
    fireEvent.click(screen.getByTestId('titlebar-ai-button'))
    await screen.findByTestId('ai-quick-settings')
    fireEvent.click(screen.getByTestId('ai-quick-settings-open-settings'))
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.agent.openView')
    expect(commands.executeCommand).toHaveBeenCalledWith('ai.manageModels')
  })
})
