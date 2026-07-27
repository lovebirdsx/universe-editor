/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpServerPicker tests — covers the trigger count, popover interactions
 *  (toggle / reset / save-as-default / open-settings), the custom-selection
 *  marker, and the absence cases (read-only session, empty pool, no service).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  Event,
  InstantiationService,
  observableValue,
  ServiceCollection,
} from '@universe-editor/platform'
import type { ISettableObservable } from '@universe-editor/platform'
import type { AvailableCommand } from '@agentclientprotocol/sdk'
import type {
  AcpMessage,
  AcpPendingPermission,
  AcpPendingElicitation,
  AcpPlanEntry,
  AcpSessionStatus,
  AcpToolCall,
  AcpUsage,
  IAcpSession,
  IAcpSessionService,
  TimelineItem,
} from '../../../services/acp/session/acpSessionService.js'
import { IAcpSessionService as IAcpSessionServiceId } from '../../../services/acp/session/acpSessionService.js'
import type { McpServerDefinition } from '../../../services/acp/acpMcpServers.js'
import { IAcpAgentDefaultsService as IAcpAgentDefaultsServiceId } from '../../../services/acp/session/acpAgentDefaultsService.js'
import type { IAcpAgentDefaultsService } from '../../../services/acp/session/acpAgentDefaultsService.js'
import { McpServerPicker } from '../McpServerPicker.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

interface FakeSession extends IAcpSession {
  readonly mcpServerSelection: ISettableObservable<readonly string[] | null>
}

function makeSession(selection: readonly string[] | null = null, readOnly = false): FakeSession {
  return {
    id: 's1',
    agentId: 'fake',
    readOnly,
    sessionIdOnAgent: observableValue<string | undefined>('sid', 's1'),
    title: 'Fake',
    messages: observableValue<readonly AcpMessage[]>('m', []),
    toolCalls: observableValue<readonly AcpToolCall[]>('t', []),
    plan: observableValue<readonly AcpPlanEntry[]>('p', []),
    timeline: observableValue<readonly TimelineItem[]>('tl', []),
    status: observableValue<AcpSessionStatus>('s', 'idle'),
    isReplayingHistory: observableValue<boolean>('replay', false),
    beginHistoryReplay: () => {},
    endHistoryReplay: () => {},
    usage: observableValue<AcpUsage | undefined>('u', undefined),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('pp', undefined),
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>('pe', undefined),
    configOptions: observableValue('cfg', []),
    availableCommands: observableValue<readonly AvailableCommand[]>('c', []),
    mcpServers: observableValue('mcp', []),
    mcpServerSelection: observableValue<readonly string[] | null>('mcpSel', selection),
    collapseMode: observableValue('cm', 'default' as const),
    accumulatedRunningMs: observableValue('arm', 0),
    runningStartedAt: observableValue<number | undefined>('rsa', undefined),
    imageSupported: observableValue<boolean>('imageSupported', false),
    forkSupported: observableValue<boolean>('forkSupported', false),
    rewindSupported: observableValue<boolean>('rewindSupported', false),
    onDidRequireAuth: Event.None,
    presentPermission: () => {},
    presentElicitation: () => {},
    sendPrompt: vi.fn().mockResolvedValue(undefined) as never,
    cancelTurn: vi.fn().mockResolvedValue(undefined) as never,
    close: () => Promise.resolve(),
    setConfigOption: vi.fn().mockResolvedValue(undefined) as never,
    renameTitle: () => {},
    rewindTo: vi.fn().mockResolvedValue(undefined) as never,
    cycleCollapseMode: () => {},
    whenConnected: () => Promise.resolve(),
    recoveryState: observableValue('recovery', undefined),
    cancelRecovery: () => {},
    retryRecovery: () => Promise.resolve(),
  }
}

interface FakeService {
  readonly mcpServerDefinitions: ISettableObservable<readonly McpServerDefinition[]>
  readonly refreshMcpServerDefinitions: ReturnType<typeof vi.fn>
  readonly setSessionMcpServers: ReturnType<typeof vi.fn>
}

function makeService(pool: readonly McpServerDefinition[]): FakeService {
  return {
    mcpServerDefinitions: observableValue<readonly McpServerDefinition[]>('defs', pool),
    refreshMcpServerDefinitions: vi.fn().mockResolvedValue(undefined),
    setSessionMcpServers: vi.fn(),
  }
}

const POOL: readonly McpServerDefinition[] = [
  { name: 'fs', transport: 'stdio', disabled: false, source: 'global' },
  { name: 'docs', transport: 'stdio', disabled: false, source: 'project' },
  { name: 'web', transport: 'stdio', disabled: true, source: 'global' },
]

function renderPicker({
  session = makeSession(),
  service,
  open = false,
  withService = true,
  agentMcpDefault,
}: {
  session?: FakeSession
  service: FakeService
  open?: boolean
  withService?: boolean
  agentMcpDefault?: readonly string[] | null
}) {
  const services = new ServiceCollection()
  if (withService) {
    services.set(IAcpSessionServiceId, service as unknown as IAcpSessionService)
  }
  if (agentMcpDefault !== undefined) {
    services.set(IAcpAgentDefaultsServiceId, {
      getMcpServerNames: () => agentMcpDefault,
    } as unknown as IAcpAgentDefaultsService)
  }
  const inst = new InstantiationService(services)
  const onOpen = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <McpServerPicker session={session} open={open} onOpen={onOpen} onClose={onClose} />,
    {
      wrapper: ({ children }) => (
        <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
      ),
    },
  )
  return { ...utils, onOpen, onClose }
}

function rowOf(name: string): HTMLElement {
  const row = [...screen.getAllByTestId('acp-mcp-picker-row')].find(
    (n) => n.getAttribute('data-name') === name,
  )
  expect(row).toBeTruthy()
  return row!
}

function checkboxOf(name: string): HTMLInputElement {
  const input = rowOf(name).querySelector('input[type="checkbox"]')
  expect(input).toBeTruthy()
  return input as HTMLInputElement
}

describe('McpServerPicker', () => {
  it('renders nothing without the ACP session service in the DI container', () => {
    renderPicker({ service: makeService(POOL), withService: false })
    expect(screen.queryByTestId('acp-mcp-picker')).toBeNull()
  })

  it('renders nothing for a read-only session or an empty pool', () => {
    const { unmount } = renderPicker({
      session: makeSession(null, true),
      service: makeService(POOL),
    })
    expect(screen.queryByTestId('acp-mcp-picker')).toBeNull()
    unmount()
    renderPicker({ service: makeService([]) })
    expect(screen.queryByTestId('acp-mcp-picker')).toBeNull()
  })

  it('trigger counts non-disabled servers when inheriting and refreshes the pool on open', () => {
    const service = makeService(POOL)
    const { onOpen } = renderPicker({ service })
    const trigger = screen.getByTestId('acp-mcp-picker-trigger')
    expect(trigger.textContent).toContain('2/3')
    expect(trigger.getAttribute('data-custom')).toBe('false')
    fireEvent.click(trigger)
    expect(service.refreshMcpServerDefinitions).toHaveBeenCalled()
    expect(onOpen).toHaveBeenCalled()
  })

  it('trigger resolves inherit through the per-agent default (disabled entries enabled on demand)', () => {
    const service = makeService(POOL)
    // The previous session pinned ['web'], which stuck as the per-agent
    // default; a new inheriting session must count it, not the non-disabled
    // pool (which would be 2/3).
    renderPicker({ service, open: true, agentMcpDefault: ['web'] })
    const trigger = screen.getByTestId('acp-mcp-picker-trigger')
    expect(trigger.textContent).toContain('1/3')
    expect(trigger.getAttribute('data-custom')).toBe('false')
    expect(checkboxOf('web').checked).toBe(true)
    expect(checkboxOf('fs').checked).toBe(false)
  })

  it('toggling an inheriting session pins the remaining enabled servers', () => {
    const service = makeService(POOL)
    renderPicker({ service, open: true })
    // 'web' is disabled: unchecking 'docs' pins the session to ['fs'].
    fireEvent.click(checkboxOf('docs'))
    expect(service.setSessionMcpServers).toHaveBeenCalledWith('s1', ['fs'])
  })

  it('toggling a server back on appends it to an existing pin', () => {
    const service = makeService(POOL)
    renderPicker({ session: makeSession(['fs']), service, open: true })
    fireEvent.click(checkboxOf('docs'))
    expect(service.setSessionMcpServers).toHaveBeenCalledWith('s1', ['fs', 'docs'])
  })

  it('a custom selection can enable a disabled pool entry on demand', () => {
    const service = makeService(POOL)
    renderPicker({ session: makeSession(['fs']), service, open: true })
    fireEvent.click(checkboxOf('web'))
    expect(service.setSessionMcpServers).toHaveBeenCalledWith('s1', ['fs', 'web'])
  })

  it('shows the inherit header without reset, and marks the trigger non-custom', () => {
    renderPicker({ service: makeService(POOL), open: true })
    expect(screen.getByTestId('acp-mcp-picker-popover').textContent).toContain('Following defaults')
    expect(screen.queryByTestId('acp-mcp-picker-reset')).toBeNull()
    expect(screen.getByTestId('acp-mcp-picker-trigger').getAttribute('data-custom')).toBe('false')
  })

  it('shows the custom header with a reset that clears the pin', () => {
    const service = makeService(POOL)
    renderPicker({ session: makeSession(['fs']), service, open: true })
    expect(screen.getByTestId('acp-mcp-picker-popover').textContent).toContain('Custom selection')
    expect(screen.getByTestId('acp-mcp-picker-trigger').getAttribute('data-custom')).toBe('true')
    fireEvent.click(screen.getByTestId('acp-mcp-picker-reset'))
    expect(service.setSessionMcpServers).toHaveBeenCalledWith('s1', null)
  })

  it('reflects the pin in checkbox state and the trigger count', () => {
    renderPicker({ session: makeSession(['fs']), service: makeService(POOL), open: true })
    expect(checkboxOf('fs').checked).toBe(true)
    expect(checkboxOf('docs').checked).toBe(false)
    expect(checkboxOf('web').checked).toBe(false)
    expect(screen.getByTestId('acp-mcp-picker-trigger').textContent).toContain('1/3')
  })

  it('renders source and disabled metadata per row', () => {
    renderPicker({ service: makeService(POOL), open: true })
    expect(rowOf('fs').textContent).toContain('global')
    expect(rowOf('docs').textContent).toContain('project')
    expect(rowOf('web').textContent).toContain('disabled')
  })

  it('shows the prompt-cache hint in the popover footer', () => {
    renderPicker({ service: makeService(POOL), open: true })
    expect(screen.getByTestId('acp-mcp-picker-popover').textContent).toContain('prompt cache')
  })

  it('Escape dismisses the popover via onClose', async () => {
    const { onClose } = renderPicker({ service: makeService(POOL), open: true })
    expect(screen.getByTestId('acp-mcp-picker-popover')).toBeTruthy()
    // The popover wires Escape on the next animation frame; flush it.
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
