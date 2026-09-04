/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AgentSessionButtons tests — the title-bar agent actions:
 *    - renders the new-session / choose-agent buttons
 *    - new-session routes to workbench.action.agent.newSession
 *    - choose-agent routes to selectAgent and its tooltip names the current agent
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import {
  ICommandService,
  InstantiationService,
  ServiceCollection,
  constObservable,
} from '@universe-editor/platform'
import { AgentSessionButtons } from '../AgentSessionButtons.js'
import { IAcpAgentRegistry } from '../../../services/acp/acpAgentRegistry.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

function makeRegistry() {
  return {
    _serviceBrand: undefined,
    defaultAgentIdObs: constObservable('claude-code'),
  }
}

function renderButtons(commands = { executeCommand: vi.fn() }) {
  const services = new ServiceCollection()
  services.set(ICommandService, commands as never)
  services.set(IAcpAgentRegistry, makeRegistry() as never)
  const inst = new InstantiationService(services)
  render(<AgentSessionButtons />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
  return { commands }
}

describe('AgentSessionButtons', () => {
  it('renders the new-session and choose-agent buttons', () => {
    renderButtons()
    expect(screen.getByTestId('titlebar-new-session')).toBeTruthy()
    expect(screen.getByTestId('titlebar-select-agent')).toBeTruthy()
  })

  it('routes new-session to the newSession command', () => {
    const { commands } = renderButtons()
    fireEvent.click(screen.getByTestId('titlebar-new-session'))
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.agent.newSession')
  })

  it('routes choose-agent to the selectAgent command and names the current agent', () => {
    const { commands } = renderButtons()
    const btn = screen.getByTestId('titlebar-select-agent')
    expect(btn.getAttribute('data-tooltip')).toContain('claude-code')
    fireEvent.click(btn)
    expect(commands.executeCommand).toHaveBeenCalledWith('workbench.action.agent.selectAgent')
  })
})
