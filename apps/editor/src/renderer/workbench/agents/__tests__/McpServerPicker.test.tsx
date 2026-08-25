/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  McpServerPicker tests — covers the trigger count, popover interactions
 *  (toggle / reset / default switch / open-settings), the custom-selection
 *  marker, and the absence cases (read-only session, empty pool, no service).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import {
  Emitter,
  Event,
  InstantiationService,
  observableValue,
  ServiceCollection,
  StorageScope,
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
import type { IMcpServerEnablementService } from '../../../services/acp/mcpServerEnablementService.js'
import { IMcpServerEnablementService as IMcpServerEnablementServiceId } from '../../../services/acp/mcpServerEnablementService.js'
import type { McpServerDefinition } from '../../../services/acp/acpMcpServers.js'
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
    suppressReplayToTimeline: () => {},
    setRetractedMessageIds: () => {},
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
    backgroundTaskCount: observableValue<number>('btc', 0),
    imageSupported: observableValue<boolean>('imageSupported', false),
    forkSupported: observableValue<boolean>('forkSupported', false),
    rewindSupported: observableValue<boolean>('rewindSupported', false),
    onDidRequireAuth: Event.None,
    onDidCancelForRestore: Event.None,
    presentPermission: () => {},
    presentElicitation: () => {},
    sendPrompt: vi.fn().mockResolvedValue(undefined) as never,
    cancelTurn: vi.fn().mockResolvedValue(undefined) as never,
    close: () => Promise.resolve(),
    setConfigOption: vi.fn().mockResolvedValue(undefined) as never,
    renameTitle: () => {},
    rewindTo: vi.fn().mockResolvedValue(undefined) as never,
    requestExtMethod: vi.fn().mockResolvedValue(undefined) as never,
    cycleCollapseMode: () => {},
    whenConnected: () => Promise.resolve(),
    recoveryState: observableValue('recovery', undefined),
    cancelRecovery: () => {},
    retryRecovery: () => Promise.resolve(),
    requestProcessRestart: () => {},
  }
}

interface FakeService {
  readonly mcpServerDefinitions: ISettableObservable<readonly McpServerDefinition[]>
  readonly refreshMcpServerDefinitions: ReturnType<typeof vi.fn>
  readonly setSessionMcpServers: ReturnType<typeof vi.fn>
}

class StubEnablement implements IMcpServerEnablementService {
  declare readonly _serviceBrand: undefined
  readonly whenReady = Promise.resolve()
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange = this._onDidChange.event
  readonly records: Record<StorageScope, Record<string, boolean>> = {
    [StorageScope.GLOBAL]: {},
    [StorageScope.WORKSPACE]: {},
  }
  isEnabled(name: string): boolean {
    return (
      this.records[StorageScope.WORKSPACE][name] ?? this.records[StorageScope.GLOBAL][name] ?? true
    )
  }
  getOverride(name: string, scope: StorageScope): boolean | undefined {
    return this.records[scope][name]
  }
  setEnabled(name: string, enabled: boolean, scope: StorageScope): Promise<void> {
    this.records[scope][name] = enabled
    this._onDidChange.fire()
    return Promise.resolve()
  }
  removeOverride(name: string, scope: StorageScope): Promise<void> {
    delete this.records[scope][name]
    this._onDidChange.fire()
    return Promise.resolve()
  }
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
  enablement = new StubEnablement(),
}: {
  session?: FakeSession
  service: FakeService
  open?: boolean
  withService?: boolean
  enablement?: StubEnablement
}) {
  const services = new ServiceCollection()
  if (withService) {
    services.set(IAcpSessionServiceId, service as unknown as IAcpSessionService)
  }
  services.set(IMcpServerEnablementServiceId, enablement)
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
  return { ...utils, onOpen, onClose, enablement }
}

function rowOf(name: string): HTMLElement {
  const row = [...screen.getAllByTestId('acp-mcp-picker-row')].find(
    (n) => n.getAttribute('data-name') === name,
  )
  expect(row).toBeTruthy()
  return row!
}

function checkboxOf(name: string): HTMLInputElement {
  // The session checkbox is the first input in the row (the default toggle
  // carries a data-testid).
  const input = rowOf(name).querySelector('input[type="checkbox"]')
  expect(input).toBeTruthy()
  return input as HTMLInputElement
}

function defaultUserToggleOf(name: string): HTMLInputElement {
  return rowOf(name).querySelector('input[data-testid="mcp-ena-user-toggle"]') as HTMLInputElement
}

function defaultWsToggleOf(name: string): HTMLInputElement {
  return rowOf(name).querySelector('input[data-testid="mcp-ena-ws-toggle"]') as HTMLInputElement
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

  it('an inheriting session follows the pool defaults, never a previous picker choice', () => {
    const service = makeService(POOL)
    // Inherit resolves to every non-disabled pool entry — there is no sticky
    // per-agent default anymore.
    renderPicker({ service, open: true })
    const trigger = screen.getByTestId('acp-mcp-picker-trigger')
    expect(trigger.textContent).toContain('2/3')
    expect(trigger.getAttribute('data-custom')).toBe('false')
    expect(checkboxOf('web').checked).toBe(false)
    expect(checkboxOf('fs').checked).toBe(true)
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

  it('renders source metadata per row', () => {
    renderPicker({ service: makeService(POOL), open: true })
    expect(rowOf('fs').textContent).toContain('global')
    expect(rowOf('docs').textContent).toContain('project')
  })

  it('shows the user-level switch only for names with a user-level definition', () => {
    const pool: readonly McpServerDefinition[] = [
      {
        name: 'fs',
        transport: 'stdio',
        disabled: false,
        source: 'global',
        hasUserLevelDefinition: true,
      },
      { name: 'local', transport: 'stdio', disabled: false, source: 'project' },
    ]
    renderPicker({ service: makeService(pool), open: true })
    expect(defaultUserToggleOf('fs')).toBeTruthy()
    expect(defaultWsToggleOf('fs')).toBeTruthy()
    expect(defaultWsToggleOf('local')).toBeTruthy()
    expect(rowOf('local').querySelector('input[data-testid="mcp-ena-user-toggle"]')).toBeNull()
  })

  it('the two default switches write the matching enablement scope', () => {
    const pool: readonly McpServerDefinition[] = [
      {
        name: 'fs',
        transport: 'stdio',
        disabled: false,
        source: 'global',
        hasUserLevelDefinition: true,
      },
    ]
    const service = makeService(pool)
    const { enablement } = renderPicker({ service, open: true })
    fireEvent.click(defaultUserToggleOf('fs'))
    expect(enablement.getOverride('fs', StorageScope.GLOBAL)).toBe(false)
    fireEvent.click(defaultWsToggleOf('fs'))
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBe(true)
    // The session pin is untouched.
    expect(service.setSessionMcpServers).not.toHaveBeenCalled()
  })

  it('the workspace switch cycles back to inheriting', () => {
    const pool: readonly McpServerDefinition[] = [
      {
        name: 'fs',
        transport: 'stdio',
        disabled: false,
        source: 'global',
        hasUserLevelDefinition: true,
      },
    ]
    const { enablement } = renderPicker({ service: makeService(pool), open: true })
    fireEvent.click(defaultWsToggleOf('fs'))
    fireEvent.click(defaultWsToggleOf('fs'))
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBe(false)
    fireEvent.click(defaultWsToggleOf('fs'))
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBeUndefined()
  })

  it('both switches are writable for .mcp.json and extension entries (enablement lives in storage)', () => {
    const pool: readonly McpServerDefinition[] = [
      {
        name: 'local',
        transport: 'stdio',
        disabled: false,
        source: 'project',
        fromMcpJson: true,
        hasUserLevelDefinition: true,
      },
      {
        name: 'bridge',
        transport: 'stdio',
        disabled: false,
        source: 'extension',
        hasUserLevelDefinition: true,
      },
    ]
    const { enablement } = renderPicker({ service: makeService(pool), open: true })
    expect(rowOf('local').textContent).toContain('.mcp.json')
    expect(rowOf('bridge').textContent).toContain('extension')
    fireEvent.click(defaultWsToggleOf('local'))
    expect(enablement.getOverride('local', StorageScope.WORKSPACE)).toBe(true)
    fireEvent.click(defaultWsToggleOf('local'))
    expect(enablement.getOverride('local', StorageScope.WORKSPACE)).toBe(false)
    fireEvent.click(defaultUserToggleOf('bridge'))
    expect(enablement.getOverride('bridge', StorageScope.GLOBAL)).toBe(false)
  })

  it('names with an effective disabled default render dimmed', () => {
    renderPicker({ service: makeService(POOL), open: true })
    const name = rowOf('web').querySelector('[data-default-disabled]')
    expect(name).toBeTruthy()
    expect(rowOf('fs').querySelector('[data-default-disabled]')).toBeNull()
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
