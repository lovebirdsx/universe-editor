/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ConfigOptionsBar tests — covers icon trigger + popover interaction:
 *    - empty options → empty bar container (pickers self-hide without the ACP layer)
 *    - trigger shows current value label
 *    - clicking trigger opens popover, picking item calls setConfigOption
 *    - Escape / outside click dismisses
 *    - mutual exclusivity (only one popover open at a time)
 *    - grouped + flat option lists
 *    - entry order incl. the claude-code sub-agent slot right after the model
 *    - overflow packing: narrow bars mark the low-priority tail with
 *      data-overflowed/inert, widening clears it, an overflowed entry's open
 *      popover is closed
 *    - the imperative handle behind Alt+<n>: index → entry mapping (overflow
 *      included), the cursor landing inside whichever host opened, and the
 *      out-of-range notice naming the real entry count
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
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
  IConfirmResult,
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
  TimelineItem,
} from '../../../services/acp/session/acpSessionService.js'
import type { AvailableCommand, SessionConfigOption } from '@agentclientprotocol/sdk'
import { IClaudeConfigService } from '../../../../shared/ipc/claudeConfigService.js'
import { ConfigOptionsBar, type ConfigOptionsBarHandle } from '../ConfigOptionsBar.js'
import { ServicesContext } from '../../useService.js'
import {
  FakeResizeObserver,
  fireResize,
  stubClientWidth,
  stubWidth,
} from './helpers/resizeObserver.js'

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
// The sub-agent picker (claude-code sessions) pulls the claude config through
// useClaudeConfig — stubbed here so bar-level tests stay focused.
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
  onDidChangeConfig: Event.None,
  async resolveActiveAuth() {
    return { kind: 'none' as const }
  },
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

function renderWithServices(
  node: React.ReactNode,
  dialogService?: IDialogServiceType,
  notificationService: INotificationService = stubNotificationService,
) {
  const services = new ServiceCollection()
  services.set(IFileService, stubFileService)
  services.set(IWorkspaceService, stubWorkspaceService)
  services.set(IClaudeConfigService, stubClaudeConfigService)
  services.set(IAiModelService, stubAiModelService)
  services.set(INotificationService, notificationService)
  services.set(
    IDialogService,
    dialogService ??
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
  opts: { agentId?: string; usage?: AcpUsage } = {},
): FakeSession {
  const configObs = observableValue<readonly SessionConfigOption[]>('cfg', initial)
  const setConfigOption = vi.fn().mockResolvedValue(undefined)
  return {
    id: 's1',
    agentId: opts.agentId ?? 'fake',
    authority: undefined,
    cwd: undefined,
    readOnly: false,
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

describe('ConfigOptionsBar', () => {
  it('renders the bar container without any triggers when there are no options', () => {
    // The test DI has no ACP layer, so the MCP picker self-hides — the bar is
    // an empty container, but still locatable via its testid. The overflow ⋯
    // button always renders (its testid also ends in "-trigger"), so it is
    // excluded from the picker-trigger count.
    renderWithServices(<ConfigOptionsBar session={makeSession()} />)
    const bar = screen.getByTestId('acp-config-options')
    expect(bar).toBeTruthy()
    const pickerTriggers = [...bar.querySelectorAll('[data-testid$="-trigger"]')].filter(
      (t) => t.getAttribute('data-testid') !== 'acp-config-overflow-trigger',
    )
    expect(pickerTriggers).toHaveLength(0)
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

  it('surfaces a rejected apply — a failed wake must not look like a no-op', async () => {
    // setConfigOption rejects when waking a session the idle reaper stopped
    // fails. The popover has already closed and the bar still shows the old
    // value, so without a notification the click reads as "nothing happened".
    const session = makeSession([MODEL_OPTION])
    session.setConfigOption.mockRejectedValue(new Error('wake failed'))
    const notify = vi.fn((_notification: { message: string }) => ({
      dispose: () => {},
      update: () => {},
    }))
    renderWithServices(<ConfigOptionsBar session={session} />, undefined, {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService)

    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    const opus = [
      ...screen.getByTestId('acp-config-model-popover').querySelectorAll('[role="option"]'),
    ].find((n) => n.textContent === 'Opus 4.7')!
    await act(async () => {
      fireEvent.mouseDown(opus)
    })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0].message).toContain('wake failed')
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

  it('orders triggers model → mode → thought_level → custom regardless of input order (non claude-code)', () => {
    renderWithServices(
      <ConfigOptionsBar
        session={makeSession([CUSTOM_OPTION, THOUGHT_OPTION, MODE_OPTION, MODEL_OPTION])}
      />,
    )
    const bar = screen.getByTestId('acp-config-options')
    // The always-mounted overflow ⋯ button shares the "-trigger" suffix and
    // sits last in the DOM; it is not a config trigger.
    const triggers = [...bar.querySelectorAll('[data-testid$="-trigger"]')]
      .filter((t) => t.getAttribute('data-testid') !== 'acp-config-overflow-trigger')
      .map((t) => t.getAttribute('data-testid'))
    expect(triggers).toEqual([
      'acp-config-model-trigger',
      'acp-config-mode-trigger',
      'acp-config-thought_level-trigger',
      'acp-config-temp-trigger',
    ])
  })

  it('orders claude-code triggers model → subagent → mode → thought_level → custom', () => {
    // The sub-agent picker glues right after the last model option — both pick
    // a model, one semantic family.
    renderWithServices(
      <ConfigOptionsBar
        session={makeSession([CUSTOM_OPTION, THOUGHT_OPTION, MODE_OPTION, MODEL_OPTION], {
          agentId: 'claude-code',
        })}
      />,
    )
    const bar = screen.getByTestId('acp-config-options')
    const triggers = [...bar.querySelectorAll('[data-testid$="-trigger"]')]
      .filter((t) => t.getAttribute('data-testid') !== 'acp-config-overflow-trigger')
      .map((t) => t.getAttribute('data-testid'))
    expect(triggers).toEqual([
      'acp-config-model-trigger',
      'acp-subagent-picker-trigger',
      'acp-config-mode-trigger',
      'acp-config-thought_level-trigger',
      'acp-config-temp-trigger',
    ])
  })
})

describe('ConfigOptionsBar — sub-agent picker gate', () => {
  it('shows the sub-agent picker trigger on claude-code sessions', () => {
    renderWithServices(
      <ConfigOptionsBar session={makeSession([MODEL_OPTION], { agentId: 'claude-code' })} />,
    )
    expect(screen.getByTestId('acp-subagent-picker-trigger')).toBeTruthy()
  })

  it('hides the sub-agent picker for other agents', () => {
    renderWithServices(
      <ConfigOptionsBar session={makeSession([MODEL_OPTION], { agentId: 'codex' })} />,
    )
    expect(screen.queryByTestId('acp-subagent-picker-trigger')).toBeNull()
  })

  it('still shows the sub-agent picker on claude-code when the session advertises no options', () => {
    renderWithServices(<ConfigOptionsBar session={makeSession([], { agentId: 'claude-code' })} />)
    expect(screen.getByTestId('acp-subagent-picker-trigger')).toBeTruthy()
  })
})

describe('ConfigOptionsBar — model switch context guard', () => {
  // The incident shape: a claude-code session at 172k tokens (300k window,
  // "[1m]" lane) offered both the bare "sonnet" row and the 1M lane row.
  const LANE_MODEL_OPTION: SessionConfigOption = {
    id: 'model',
    category: 'model',
    type: 'select',
    name: 'Model',
    currentValue: 'claude-fable-5[1m]',
    options: [
      { value: 'claude-fable-5[1m]', name: 'Fable 5' },
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'sonnet[1m]', name: 'Sonnet 5 (1M context)' },
    ],
  }
  const INCIDENT_USAGE: AcpUsage = { used: 172_224, size: 300_000 }

  function makeDialog(confirmed: boolean) {
    const confirm = vi.fn().mockResolvedValue({
      confirmed,
      choice: confirmed ? 'primary' : 'cancel',
    } satisfies IConfirmResult)
    return {
      dialog: {
        _serviceBrand: undefined,
        confirm,
        prompt: vi.fn().mockResolvedValue(undefined),
      } as unknown as IDialogServiceType,
      confirm,
    }
  }

  async function pickModel(name: string) {
    fireEvent.click(screen.getByTestId('acp-config-model-trigger'))
    const item = [
      ...screen.getByTestId('acp-config-model-popover').querySelectorAll('[role="option"]'),
    ].find((n) => n.textContent === name)!
    fireEvent.mouseDown(item)
    await act(async () => {})
  }

  it('asks for confirmation before switching a large session onto a bare 200k row', async () => {
    const session = makeSession([LANE_MODEL_OPTION], {
      agentId: 'claude-code',
      usage: INCIDENT_USAGE,
    })
    const { dialog, confirm } = makeDialog(true)
    renderWithServices(<ConfigOptionsBar session={session} />, dialog)
    await pickModel('Sonnet')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(session.setConfigOption).toHaveBeenCalledWith('model', 'sonnet')
  })

  it('does not switch when the user cancels the confirmation', async () => {
    const session = makeSession([LANE_MODEL_OPTION], {
      agentId: 'claude-code',
      usage: INCIDENT_USAGE,
    })
    const { dialog, confirm } = makeDialog(false)
    renderWithServices(<ConfigOptionsBar session={session} />, dialog)
    await pickModel('Sonnet')
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(session.setConfigOption).not.toHaveBeenCalled()
  })

  it('switches lane-preserving picks without confirmation', async () => {
    const session = makeSession([LANE_MODEL_OPTION], {
      agentId: 'claude-code',
      usage: INCIDENT_USAGE,
    })
    const { dialog, confirm } = makeDialog(false)
    renderWithServices(<ConfigOptionsBar session={session} />, dialog)
    await pickModel('Sonnet 5 (1M context)')
    expect(confirm).not.toHaveBeenCalled()
    expect(session.setConfigOption).toHaveBeenCalledWith('model', 'sonnet[1m]')
  })

  it('does not guard non-claude sessions', async () => {
    const session = makeSession([LANE_MODEL_OPTION], { agentId: 'codex', usage: INCIDENT_USAGE })
    const { dialog, confirm } = makeDialog(false)
    renderWithServices(<ConfigOptionsBar session={session} />, dialog)
    await pickModel('Sonnet')
    expect(confirm).not.toHaveBeenCalled()
    expect(session.setConfigOption).toHaveBeenCalledWith('model', 'sonnet')
  })
})

describe('ConfigOptionsBar — overflow', () => {
  const RealRO = globalThis.ResizeObserver
  afterEach(() => {
    globalThis.ResizeObserver = RealRO
    FakeResizeObserver.instances = []
  })

  // Every entry 100px, ⋯ button 26px, so a 230px line keeps model + subagent
  // (200 <= 204 available) and overflows mode/thought/temp/mcp.
  function renderNarrow(
    barWidth: number,
    session: ReturnType<typeof makeSession> = makeSession(
      [MODEL_OPTION, MODE_OPTION, THOUGHT_OPTION, CUSTOM_OPTION],
      { agentId: 'claude-code' },
    ),
  ) {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    renderWithServices(<ConfigOptionsBar session={session} />)
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

  it('marks the low-priority tail as overflowed when the bar is too narrow', async () => {
    const { bar } = renderNarrow(230)
    await fireResize()

    expect(entryEl(bar, 'model').hasAttribute('data-overflowed')).toBe(false)
    expect(entryEl(bar, 'mode').getAttribute('data-overflowed')).toBe('true')
    expect(entryEl(bar, 'mode').hasAttribute('inert')).toBe(true)
    expect(entryEl(bar, 'mode').getAttribute('aria-hidden')).toBe('true')
    // The ⋯ button has overflow to show, so it stays visible (no data-empty).
    expect(screen.getByTestId('acp-config-overflow-trigger').hasAttribute('data-empty')).toBe(false)
  })

  it('clears the overflow when the bar widens', async () => {
    const { bar, items } = renderNarrow(230)
    await fireResize()
    expect(entryEl(bar, 'mode').getAttribute('data-overflowed')).toBe('true')

    stubClientWidth(items, 1000)
    await fireResize()

    expect(entryEl(bar, 'mode').hasAttribute('data-overflowed')).toBe(false)
    expect(screen.getByTestId('acp-config-overflow-trigger').getAttribute('data-empty')).toBe(
      'true',
    )
  })

  it('closes the inline popover when its entry overflows', async () => {
    // 430px keeps model+subagent+mode+thought (400 <= 404 available).
    const { items } = renderNarrow(430)
    await fireResize()
    expect(
      entryEl(screen.getByTestId('acp-config-options'), 'mode').hasAttribute('data-overflowed'),
    ).toBe(false)
    fireEvent.click(screen.getByTestId('acp-config-mode-trigger'))
    expect(screen.getByTestId('acp-config-mode-popover')).toBeTruthy()

    stubClientWidth(items, 230)
    await fireResize()

    expect(screen.queryByTestId('acp-config-mode-popover')).toBeNull()
  })
})

/**
 * The imperative handle is what the Alt+<n> command drives: it arrives with no
 * click event, so it must open exactly like a mouse click does — and for an
 * entry the bar folded away, it must land in the "…" panel instead.
 */
describe('ConfigOptionsBar — entry activation (Alt+<n>)', () => {
  function renderWithHandle(
    session: FakeSession,
    notificationService: INotificationService = stubNotificationService,
  ): { current: ConfigOptionsBarHandle | null } {
    const handle: { current: ConfigOptionsBarHandle | null } = { current: null }
    renderWithServices(
      <ConfigOptionsBar session={session} handleRef={handle} />,
      undefined,
      notificationService,
    )
    return handle
  }

  /** The command path has no event to wrap the update, so drive it through act. */
  function activate(handle: { current: ConfigOptionsBarHandle | null }, index: number): boolean {
    let opened = false
    act(() => {
      opened = handle.current!.activateEntry(index)
    })
    return opened
  }

  it('opens the entry at the index and drops the cursor on its current value', () => {
    const handle = renderWithHandle(makeSession([MODEL_OPTION, MODE_OPTION]))
    expect(activate(handle, 0)).toBe(true)
    const popover = screen.getByTestId('acp-config-model-popover')
    expect(popover.querySelector('[data-active="true"]')?.textContent).toBe('Sonnet 4.6')
    // Focus moved into the overlay, so arrows and typeahead work without the
    // user having to click into it first.
    expect(popover.contains(document.activeElement)).toBe(true)
  })

  it('numbers entries by bar order, so the sub-agent slot is index 1 on claude-code', () => {
    const handle = renderWithHandle(makeSession([MODEL_OPTION], { agentId: 'claude-code' }))
    expect(activate(handle, 1)).toBe(true)
    expect(screen.getByTestId('acp-subagent-panel')).toBeTruthy()
  })

  it('opens a folded-away entry inside the "…" panel with its row already expanded', async () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    // 230px keeps model + subagent inline (200 <= 204) and folds mode away.
    const session = makeSession([MODEL_OPTION, MODE_OPTION], { agentId: 'claude-code' })
    const handle: { current: ConfigOptionsBarHandle | null } = { current: null }
    renderWithServices(<ConfigOptionsBar session={session} handleRef={handle} />)
    const bar = screen.getByTestId('acp-config-options')
    const items = screen.getByTestId('acp-config-options-items')
    stubClientWidth(items, 230)
    for (const el of bar.querySelectorAll('[data-entry-key]')) stubWidth(el, 100)
    stubWidth(screen.getByTestId('acp-config-overflow-trigger'), 26)
    await fireResize()
    expect(bar.querySelector('[data-entry-key="mode"]')?.getAttribute('data-overflowed')).toBe(
      'true',
    )

    expect(activate(handle, 2)).toBe(true)

    const panel = screen.getByTestId('acp-config-overflow-panel')
    const row = within(panel).getByText('Mode').closest('[data-entry-key]')
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    // No inline popover: its trigger is inert (hidden from the flex line), so
    // anchoring one there would put it where the user cannot see the trigger.
    expect(screen.queryByTestId('acp-config-mode-popover')).toBeNull()
    // Focus lands inside the expanded body, not merely somewhere in the panel:
    // the point of Alt+<n> is to be able to pick a value straight away.
    const body = row!.parentElement!.querySelector('[role="listbox"]')
    expect(body?.contains(document.activeElement)).toBe(true)
  })

  it('reopens the "…" panel with every row collapsed', async () => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    // 230px keeps model + subagent inline (200 <= 204) and folds mode away.
    const session = makeSession([MODEL_OPTION, MODE_OPTION], { agentId: 'claude-code' })
    renderWithServices(<ConfigOptionsBar session={session} />)
    const bar = screen.getByTestId('acp-config-options')
    const items = screen.getByTestId('acp-config-options-items')
    stubClientWidth(items, 230)
    for (const el of bar.querySelectorAll('[data-entry-key]')) stubWidth(el, 100)
    stubWidth(screen.getByTestId('acp-config-overflow-trigger'), 26)
    await fireResize()

    const trigger = screen.getByTestId('acp-config-overflow-trigger')
    const rowFor = (key: string): HTMLElement =>
      screen.getByTestId('acp-config-overflow-panel').querySelector(`[data-entry-key="${key}"]`)!

    fireEvent.click(trigger)
    fireEvent.click(rowFor('mode'))
    expect(rowFor('mode').getAttribute('aria-expanded')).toBe('true')

    // Dismiss through the "…" toggle — a path that never runs the collapse
    // handler, unlike the two-level Escape. Reopening must not resurrect the
    // expansion: focus would be on the "…" button with the arrows pointing into
    // a body that is already open, and the first Escape would only collapse it.
    fireEvent.click(trigger)
    expect(screen.queryByTestId('acp-config-overflow-panel')).toBeNull()
    fireEvent.click(trigger)
    expect(rowFor('mode').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the current-value marker on the value in effect while the cursor moves', () => {
    const handle = renderWithHandle(makeSession([MODEL_OPTION]))
    activate(handle, 0)
    const popover = screen.getByTestId('acp-config-model-popover')
    const list = popover.querySelector('[role="listbox"]') as HTMLElement
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    const rows = [...popover.querySelectorAll('[role="option"]')]
    const moved = rows.find((r) => r.textContent === 'Opus 4.7')!
    const current = rows.find((r) => r.textContent === 'Sonnet 4.6')!
    expect(moved.getAttribute('data-active')).toBe('true')
    expect(moved.getAttribute('aria-selected')).toBe('true')
    expect(current.getAttribute('data-active')).toBe('false')
    expect(current.getAttribute('aria-selected')).toBe('false')
    // ... and the value in effect is still marked, so the user can see both
    // where the cursor is and what is actually selected.
    expect(current.getAttribute('data-current')).toBe('true')
  })

  it('reports the real entry count when the index is past the end', () => {
    const notify = vi.fn((_notification: { message: string }) => ({
      dispose: () => {},
      update: () => {},
    }))
    const handle = renderWithHandle(makeSession([MODEL_OPTION, MODE_OPTION]), {
      _serviceBrand: undefined,
      notify,
    } as unknown as INotificationService)
    expect(activate(handle, 2)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]?.[0].message).toContain('2')
    expect(screen.queryByTestId('acp-config-model-popover')).toBeNull()
  })
})
