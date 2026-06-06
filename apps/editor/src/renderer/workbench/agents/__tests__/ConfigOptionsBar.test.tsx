/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionsBar tests — covers icon trigger + popover interaction:
 *    - empty options → renders nothing
 *    - trigger shows current value label
 *    - clicking trigger opens popover, picking item calls setConfigOption
 *    - Escape / outside click dismisses
 *    - mutual exclusivity (only one popover open at a time)
 *    - grouped + flat option lists
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  Event,
  IFileService,
  InstantiationService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
} from '@universe-editor/platform'
import type {
  IFileService as IFileServiceType,
  ISettableObservable,
  IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import type {
  AcpMessage,
  AcpPendingPermission,
  AcpPendingQuestion,
  AcpPlanEntry,
  AcpSessionStatus,
  AcpToolCall,
  AcpUsage,
  IAcpSession,
  TimelineItem,
} from '../../../services/acp/acpSessionService.js'
import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk'
import { ConfigOptionsBar } from '../ConfigOptionsBar.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

const stubFileService = { _serviceBrand: undefined } as unknown as IFileServiceType
const stubWorkspaceService = {
  _serviceBrand: undefined,
  current: null,
  onDidChangeWorkspace: Event.None,
  recent: [],
  onDidChangeRecent: Event.None,
  async openFolder() {},
  async closeFolder() {},
  async clearRecent() {},
  async removeRecent() {},
} as unknown as IWorkspaceServiceType

function renderWithServices(node: React.ReactNode) {
  const services = new ServiceCollection()
  services.set(IFileService, stubFileService)
  services.set(IWorkspaceService, stubWorkspaceService)
  const inst = new InstantiationService(services)
  return render(node, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
}

interface FakeSession extends IAcpSession {
  readonly configObs: ISettableObservable<readonly SessionConfigOption[]>
  readonly setConfigOption: ReturnType<typeof vi.fn> & IAcpSession['setConfigOption']
}

function makeSession(initial: readonly SessionConfigOption[] = []): FakeSession {
  const configObs = observableValue<readonly SessionConfigOption[]>('cfg', initial)
  const setConfigOption = vi.fn().mockResolvedValue(undefined)
  return {
    id: 's1',
    agentId: 'fake',
    title: 'Fake',
    messages: observableValue<readonly AcpMessage[]>('m', []),
    toolCalls: observableValue<readonly AcpToolCall[]>('t', []),
    plan: observableValue<readonly AcpPlanEntry[]>('p', []),
    timeline: observableValue<readonly TimelineItem[]>('tl', []),
    status: observableValue<AcpSessionStatus>('s', 'idle'),
    usage: observableValue<AcpUsage | undefined>('u', undefined),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('pp', undefined),
    pendingQuestion: observableValue<AcpPendingQuestion | undefined>('pq', undefined),
    configOptions: configObs,
    availableCommands: observableValue<readonly AvailableCommand[]>('c', []),
    mcpServers: observableValue('mcp', []),
    collapseMode: observableValue('cm', 'default' as const),
    accumulatedRunningMs: observableValue('arm', 0),
    runningStartedAt: observableValue<number | undefined>('rsa', undefined),
    presentPermission: () => {},
    presentQuestion: () => {},
    sendPrompt: vi.fn().mockResolvedValue(undefined) as never,
    cancelTurn: vi.fn().mockResolvedValue(undefined) as never,
    close: () => Promise.resolve(),
    setConfigOption: setConfigOption as never,
    cycleCollapseMode: () => {},
    configObs,
  } satisfies FakeSession
}

const MODEL_OPTION: SessionConfigOption = {
  id: 'model',
  category: 'model',
  type: 'select',
  name: 'Model',
  description: 'Pick a model',
  currentValue: 'sonnet',
  options: [
    { value: 'sonnet', name: 'Sonnet 4.6' },
    { value: 'opus', name: 'Opus 4.7' },
  ],
}

const MODE_OPTION: SessionConfigOption = {
  id: 'mode',
  category: 'mode',
  type: 'select',
  name: 'Mode',
  currentValue: 'default',
  options: [
    { value: 'default', name: 'Default' },
    { value: 'plan', name: 'Plan' },
  ],
}

describe('ConfigOptionsBar', () => {
  it('renders nothing when there are no options', () => {
    renderWithServices(<ConfigOptionsBar session={makeSession()} />)
    expect(screen.queryByTestId('acp-config-options')).toBeNull()
  })

  it('renders one trigger per option, showing the current value label', () => {
    renderWithServices(<ConfigOptionsBar session={makeSession([MODEL_OPTION, MODE_OPTION])} />)
    const modelTrigger = screen.getByTestId('acp-config-model-trigger')
    const modeTrigger = screen.getByTestId('acp-config-mode-trigger')
    expect(modelTrigger.textContent).toContain('Sonnet 4.6')
    expect(modeTrigger.textContent).toContain('Default')
  })

  it('clicking a trigger opens the popover; picking an item calls setConfigOption', () => {
    const session = makeSession([MODEL_OPTION])
    renderWithServices(<ConfigOptionsBar session={session} />)
    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    const popover = screen.getByTestId('acp-config-model-popover')
    const opus = [...popover.querySelectorAll('[role="option"]')].find(
      (n) => n.textContent === 'Opus 4.7',
    )
    expect(opus).toBeTruthy()
    fireEvent.mouseDown(opus!)
    expect(session.setConfigOption).toHaveBeenCalledWith('model', 'opus')
    expect(screen.queryByTestId('acp-config-model-popover')).toBeNull()
  })

  it('does not call setConfigOption when picking the already-current value', () => {
    const session = makeSession([MODEL_OPTION])
    renderWithServices(<ConfigOptionsBar session={session} />)
    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    const sonnet = [
      ...screen.getByTestId('acp-config-model-popover').querySelectorAll('[role="option"]'),
    ].find((n) => n.textContent === 'Sonnet 4.6')!
    fireEvent.mouseDown(sonnet)
    expect(session.setConfigOption).not.toHaveBeenCalled()
  })

  it('Escape dismisses the popover', async () => {
    renderWithServices(<ConfigOptionsBar session={makeSession([MODEL_OPTION])} />)
    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    expect(screen.getByTestId('acp-config-model-popover')).toBeTruthy()
    // The popover wires Escape on the next animation frame; flush it.
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('acp-config-model-popover')).toBeNull()
  })

  it('outside mousedown dismisses the popover', async () => {
    renderWithServices(
      <div>
        <ConfigOptionsBar session={makeSession([MODEL_OPTION])} />
        <div data-testid="outside">outside</div>
      </div>,
    )
    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    expect(screen.getByTestId('acp-config-model-popover')).toBeTruthy()
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByTestId('acp-config-model-popover')).toBeNull()
  })

  it('only one popover is open at a time across triggers', () => {
    renderWithServices(<ConfigOptionsBar session={makeSession([MODEL_OPTION, MODE_OPTION])} />)
    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    expect(screen.getByTestId('acp-config-model-popover')).toBeTruthy()
    fireEvent.click(screen.getByTestId('acp-config-mode-trigger'))
    expect(screen.queryByTestId('acp-config-model-popover')).toBeNull()
    expect(screen.getByTestId('acp-config-mode-popover')).toBeTruthy()
  })

  it('renders grouped options with group labels', () => {
    const grouped: SessionConfigOption = {
      id: 'model',
      category: 'model',
      type: 'select',
      name: 'Model',
      currentValue: 'b',
      options: [
        {
          group: 'anthropic',
          name: 'Anthropic',
          options: [
            { value: 'a', name: 'Sonnet' },
            { value: 'b', name: 'Opus' },
          ],
        },
        {
          group: 'openai',
          name: 'OpenAI',
          options: [{ value: 'c', name: 'GPT-5' }],
        },
      ],
    }
    renderWithServices(<ConfigOptionsBar session={makeSession([grouped])} />)
    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    const popover = screen.getByTestId('acp-config-model-popover')
    expect(popover.textContent).toContain('Anthropic')
    expect(popover.textContent).toContain('OpenAI')
    expect(popover.querySelectorAll('[role="option"]')).toHaveLength(3)
  })

  it('orders triggers model → mode → thought_level → custom regardless of input order', () => {
    const custom: SessionConfigOption = {
      id: 'temp',
      type: 'select',
      name: 'Temp',
      currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }],
    }
    const thought: SessionConfigOption = {
      id: 'thought_level',
      category: 'thought_level',
      type: 'select',
      name: 'Think',
      currentValue: 'normal',
      options: [{ value: 'normal', name: 'Normal' }],
    }
    renderWithServices(
      <ConfigOptionsBar session={makeSession([custom, thought, MODE_OPTION, MODEL_OPTION])} />,
    )
    const bar = screen.getByTestId('acp-config-options')
    const triggers = [...bar.querySelectorAll('[data-testid$="-trigger"]')].map((t) =>
      t.getAttribute('data-testid'),
    )
    expect(triggers).toEqual([
      'acp-config-model-trigger',
      'acp-config-mode-trigger',
      'acp-config-thought_level-trigger',
      'acp-config-temp-trigger',
    ])
  })
})
