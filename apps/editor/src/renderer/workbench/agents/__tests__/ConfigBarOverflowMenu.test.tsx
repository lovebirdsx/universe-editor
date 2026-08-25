/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigBarOverflowMenu tests — the "…" panel collecting the config bar's
 *  low-priority tail when the single line runs out of width:
 *    - greedy packing keeps the high-priority entries (model, sub agent)
 *    - overflowed entries carry data-overflowed/inert/aria-hidden and the ⋯
 *      button shows
 *    - rows expand inline one at a time; picking a value calls setConfigOption
 *    - widening the bar clears the overflow and closes the panel
 *    - Escape closes the panel
 *    - a hidden MCP entry (empty pool) never lights the ⋯ button
 *      (splitConfigBarOverflow pure packing semantics live in
 *      services/acp/__tests__/configBarLayout.test.ts)
 *
 *  happy-dom has no layout: a FakeResizeObserver captures the measurement
 *  observer's callback for manual firing, and offsetWidth/clientWidth are
 *  stubbed per element — otherwise everything measures 0 and the bar always
 *  "fits" (fake green).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  Event,
  IAiModelService,
  IDialogService,
  IFileService,
  INotificationService,
  InstantiationService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
} from '@universe-editor/platform'
import type {
  IDialogService as IDialogServiceType,
  IFileService as IFileServiceType,
  ISettableObservable,
  IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
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
import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk'
import { MCP_ENTRY_KEY, SUBAGENT_ENTRY_KEY } from '../../../services/acp/configBarLayout.js'
import { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import { ServicesContext } from '../../useService.js'
import { ConfigOptionsBar } from '../ConfigOptionsBar.js'
import {
  FakeResizeObserver,
  fireResize,
  stubClientWidth,
  stubWidth,
} from './helpers/resizeObserver.js'

afterEach(() => {
  cleanup()
  globalThis.ResizeObserver = RealResizeObserver
  FakeResizeObserver.instances = []
})

const RealResizeObserver = globalThis.ResizeObserver

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
const stubClaudeConfigService = {
  _serviceBrand: undefined,
  async read() {
    return {}
  },
  async patch() {},
  async configPath() {
    return '/.claude/settings.json'
  },
  async readAuthStatus() {
    return { loggedIn: false, expired: false }
  },
  async readAgentSettings() {
    return {}
  },
  async writeAgentSettings() {},
  async checkGatewayConnectivity() {
    return true
  },
} as unknown as IClaudeConfigService
const stubAiModelService = {
  _serviceBrand: undefined,
  async getProviders() {
    return []
  },
  async getModelKnowledge() {
    return {}
  },
} as unknown as IAiModelService
const stubNotificationService = {
  _serviceBrand: undefined,
  notify: () => ({ dispose: () => {}, update: () => {} }),
} as unknown as INotificationService

const MCP_POOL: readonly McpServerDefinition[] = [
  { name: 'fs', transport: 'stdio', disabled: false, source: 'global' },
  { name: 'docs', transport: 'stdio', disabled: false, source: 'project' },
]

/** Minimal ACP layer: only the MCP definition pool the overflow row reads. */
function makeAcpService(pool: readonly McpServerDefinition[] = MCP_POOL): IAcpSessionService {
  return {
    mcpServerDefinitions: observableValue<readonly McpServerDefinition[]>('mcpDefs', pool),
    async refreshMcpServerDefinitions() {},
    setSessionMcpServers() {},
  } as unknown as IAcpSessionService
}

function renderWithServices(
  node: React.ReactNode,
  opts: { dialogService?: IDialogServiceType; acpService?: IAcpSessionService } = {},
) {
  const services = new ServiceCollection()
  services.set(IFileService, stubFileService)
  services.set(IWorkspaceService, stubWorkspaceService)
  services.set(IClaudeConfigService, stubClaudeConfigService)
  services.set(IAiModelService, stubAiModelService)
  services.set(INotificationService, stubNotificationService)
  services.set(IAcpSessionServiceId, opts.acpService ?? makeAcpService())
  services.set(
    IDialogService,
    opts.dialogService ??
      ({
        _serviceBrand: undefined,
        confirm: vi.fn().mockResolvedValue({ confirmed: true, choice: 'primary' }),
        prompt: vi.fn().mockResolvedValue(undefined),
      } as unknown as IDialogServiceType),
  )
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

function makeSession(
  initial: readonly SessionConfigOption[] = [],
  opts: { agentId?: string; usage?: AcpUsage; readOnly?: boolean } = {},
): FakeSession {
  const configObs = observableValue<readonly SessionConfigOption[]>('cfg', initial)
  const setConfigOption = vi.fn().mockResolvedValue(undefined)
  return {
    id: 's1',
    agentId: opts.agentId ?? 'fake',
    readOnly: opts.readOnly ?? false,
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
    usage: observableValue<AcpUsage | undefined>('u', opts.usage),
    pendingPermission: observableValue<AcpPendingPermission | undefined>('pp', undefined),
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>('pe', undefined),
    configOptions: configObs,
    availableCommands: observableValue<readonly AvailableCommand[]>('c', []),
    mcpServers: observableValue('mcp', []),
    mcpServerSelection: observableValue<readonly string[] | null>('mcpSel', null),
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
    setConfigOption: setConfigOption as never,
    renameTitle: () => {},
    rewindTo: vi.fn().mockResolvedValue(undefined) as never,
    requestExtMethod: vi.fn().mockResolvedValue(undefined) as never,
    cycleCollapseMode: () => {},
    whenConnected: () => Promise.resolve(),
    isDormant: observableValue('dormant', false),
    ensureAwake: () => Promise.resolve('ready' as const),
    recoveryState: observableValue('recovery', undefined),
    cancelRecovery: () => {},
    retryRecovery: () => Promise.resolve(),
    requestProcessRestart: () => {},
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

const THOUGHT_OPTION: SessionConfigOption = {
  id: 'thought_level',
  category: 'thought_level',
  type: 'select',
  name: 'Think',
  currentValue: 'normal',
  options: [{ value: 'normal', name: 'Normal' }],
}

const CUSTOM_OPTION: SessionConfigOption = {
  id: 'temp',
  type: 'select',
  name: 'Temp',
  currentValue: 'low',
  options: [{ value: 'low', name: 'Low' }],
}

const ALL_OPTIONS: readonly SessionConfigOption[] = [
  MODEL_OPTION,
  MODE_OPTION,
  THOUGHT_OPTION,
  CUSTOM_OPTION,
]

/**
 * Render a claude-code bar (model → subagent → mode → thought_level → temp →
 * mcp) with every entry 100px wide and a 26px ⋯ button; with a 230px line the
 * packing keeps model + subagent and overflows the rest (available = 204).
 */
function setupNarrowBar(
  barWidth = 230,
  session = makeSession(ALL_OPTIONS, { agentId: 'claude-code' }),
  acpService = makeAcpService(),
) {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  renderWithServices(<ConfigOptionsBar session={session} />, { acpService })
  const bar = screen.getByTestId('acp-config-options')
  const items = screen.getByTestId('acp-config-options-items')
  stubClientWidth(items, barWidth)
  for (const el of bar.querySelectorAll('[data-entry-key]')) stubWidth(el, 100)
  stubWidth(screen.getByTestId('acp-config-overflow-trigger'), 26)
  return { session, bar, items }
}

function entryEl(container: HTMLElement, key: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-entry-key="${key}"]`)
  expect(el).toBeTruthy()
  return el!
}

function openOverflowMenu() {
  fireEvent.click(screen.getByTestId('acp-config-overflow-trigger'))
}

describe('ConfigBarOverflowMenu — packing and panel', () => {
  it('overflows the low-priority tail and keeps model + sub agent visible when narrow', async () => {
    const { bar } = setupNarrowBar()
    await fireResize()

    const model = entryEl(bar, 'model')
    const subagent = entryEl(bar, SUBAGENT_ENTRY_KEY)
    expect(model.hasAttribute('data-overflowed')).toBe(false)
    expect(subagent.hasAttribute('data-overflowed')).toBe(false)

    for (const key of ['mode', 'thought_level', 'temp', MCP_ENTRY_KEY]) {
      const el = entryEl(bar, key)
      expect(el.getAttribute('data-overflowed')).toBe('true')
      expect(el.hasAttribute('inert')).toBe(true)
      expect(el.getAttribute('aria-hidden')).toBe('true')
    }

    // The ⋯ button has overflow to show, so it stays visible (no data-empty).
    const trigger = screen.getByTestId('acp-config-overflow-trigger')
    expect(trigger.hasAttribute('data-empty')).toBe(false)
  })

  it('opens the panel, expands a row inline and picks a value through setConfigOption', async () => {
    const { session } = setupNarrowBar()
    await fireResize()
    openOverflowMenu()

    const panel = screen.getByTestId('acp-config-overflow-panel')
    expect(panel).toBeTruthy()
    // Rows follow entry priority order: mode, thought_level, temp, mcp.
    const rows = within(panel).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Mode'),
      expect.stringContaining('Think'),
      expect.stringContaining('Temp'),
      expect.stringContaining('MCP servers'),
    ])

    fireEvent.click(rows[0]!)
    const options = [...panel.querySelectorAll('[role="option"]')]
    expect(options.map((o) => o.textContent)).toEqual(['Default', 'Plan'])
    const plan = options.find((o) => o.textContent === 'Plan')!
    fireEvent.mouseDown(plan)
    expect(session.setConfigOption).toHaveBeenCalledWith('mode', 'plan')
  })

  it('expands only one row at a time inside the panel', async () => {
    setupNarrowBar()
    await fireResize()
    openOverflowMenu()

    const panel = screen.getByTestId('acp-config-overflow-panel')
    const rows = () => within(panel).getAllByRole('button')

    fireEvent.click(rows()[0]!)
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true')
    expect([...panel.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'Default',
      'Plan',
    ])

    fireEvent.click(rows()[1]!)
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('false')
    expect(rows()[1]!.getAttribute('aria-expanded')).toBe('true')
    expect([...panel.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual([
      'Normal',
    ])
  })

  it('closes the panel when the bar widens and the overflow clears', async () => {
    const { items } = setupNarrowBar()
    await fireResize()
    openOverflowMenu()
    expect(screen.getByTestId('acp-config-overflow-panel')).toBeTruthy()

    stubClientWidth(items, 1000)
    await fireResize()

    expect(screen.getByTestId('acp-config-overflow-trigger').getAttribute('data-empty')).toBe(
      'true',
    )
    expect(screen.queryByTestId('acp-config-overflow-panel')).toBeNull()
  })

  it('Escape closes the panel', async () => {
    setupNarrowBar()
    await fireResize()
    openOverflowMenu()
    expect(screen.getByTestId('acp-config-overflow-panel')).toBeTruthy()

    // The surface wires Escape on the next animation frame; flush it.
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('acp-config-overflow-panel')).toBeNull()
  })

  it('drops a stale expansion when a row leaves the overflow set and re-enters collapsed', async () => {
    const { items } = setupNarrowBar()
    await fireResize()
    openOverflowMenu()

    const panel = screen.getByTestId('acp-config-overflow-panel')
    const rows = () => within(panel).getAllByRole('button')
    fireEvent.click(rows()[0]!)
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('true')

    // 326px keeps model+subagent+mode (300 <= 300 available), so 'mode' leaves
    // the overflow set while the panel stays open.
    stubClientWidth(items, 326)
    await fireResize()
    expect(rows()[0]!.textContent).toContain('Think')

    // Narrow again: the row returns but must not still be expanded.
    stubClientWidth(items, 230)
    await fireResize()
    expect(rows()[0]!.textContent).toContain('Mode')
    expect(rows()[0]!.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('ConfigBarOverflowMenu — MCP row gating', () => {
  const OPTION_ROWS = [
    expect.stringContaining('Mode'),
    expect.stringContaining('Think'),
    expect.stringContaining('Temp'),
  ]

  it('shows no MCP row in the overflow panel for a read-only session', async () => {
    const session = makeSession(ALL_OPTIONS, { agentId: 'claude-code', readOnly: true })
    setupNarrowBar(230, session)
    await fireResize()
    openOverflowMenu()

    const panel = screen.getByTestId('acp-config-overflow-panel')
    const rows = within(panel).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual(OPTION_ROWS)
  })

  it('shows no MCP row in the overflow panel when the server pool is empty', async () => {
    setupNarrowBar(230, makeSession(ALL_OPTIONS, { agentId: 'claude-code' }), makeAcpService([]))
    await fireResize()
    openOverflowMenu()

    const panel = screen.getByTestId('acp-config-overflow-panel')
    const rows = within(panel).getAllByRole('button')
    expect(rows.map((r) => r.textContent)).toEqual(OPTION_ROWS)
  })
})

describe('ConfigBarOverflowMenu — phantom entry regression', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not light the ⋯ button over a hidden MCP entry when the pool is empty', async () => {
    // happy-dom reports no column-gap, so the flex gap the phantom entry would
    // eat is stubbed here — real CSS would measure it.
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      columnGap: '4px',
    } as unknown as CSSStyleDeclaration)
    // The five real entries (100px each) plus their four gaps take 516 of the
    // 546px line, so nothing overflows once the hidden MCP entry is gone. While
    // it was still rendered it added a sixth 100px slot (620 > 546) and pushed
    // the tail into overflow — lighting the button over an empty panel, since
    // the overflow row self-hides on the same predicate.
    const { bar } = setupNarrowBar(
      546,
      makeSession(ALL_OPTIONS, { agentId: 'claude-code' }),
      makeAcpService([]),
    )
    await fireResize()

    expect(bar.querySelector('[data-entry-key="__mcp__"]')).toBeNull()
    expect(screen.getByTestId('acp-config-overflow-trigger').getAttribute('data-empty')).toBe(
      'true',
    )
  })
})
