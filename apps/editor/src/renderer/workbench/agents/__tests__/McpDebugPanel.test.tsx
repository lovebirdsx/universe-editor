/*---------------------------------------------------------------------------------------------
 *  Tests for McpDebugPanel — the panel is a pure projection of the debug service's
 *  state plus a set of callbacks, so these tests drive it with a fake service and
 *  assert both directions: what the state renders, and which method a click reaches.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  observableValue,
  type ISettableObservable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { IMcpDebugService } from '../../../services/acp/mcp/mcpDebugService.js'
import { McpDebugEditorInput } from '../../../services/acp/mcp/mcpDebugEditorInput.js'
import type { McpDebugPanelState } from '../../../services/acp/mcp/mcpDebugModel.js'
import { McpDebugPanel } from '../McpDebugPanel.js'

const KEY = 'session-1::fs'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

class FakeDebugService {
  declare readonly _serviceBrand: undefined
  readonly key: string
  readonly state: ISettableObservable<McpDebugPanelState>
  readonly openFromToolCall = vi.fn(async () => undefined)
  readonly selectTool = vi.fn()
  readonly setParamsText = vi.fn()
  readonly runTool = vi.fn(async () => undefined)
  readonly refreshTools = vi.fn(async () => undefined)
  readonly disconnect = vi.fn(async () => undefined)
  readonly restore = vi.fn()
  readonly clearHistory = vi.fn()

  constructor(key: string, state: McpDebugPanelState) {
    this.key = key
    this.state = observableValue('test.mcpDebug', state)
  }

  getState(key: string) {
    return key === this.key ? this.state : undefined
  }

  update(patch: Partial<McpDebugPanelState>): void {
    act(() => this.state.set({ ...this.state.get(), ...patch }, undefined))
  }
}

function makeState(overrides: Partial<McpDebugPanelState> = {}): McpDebugPanelState {
  return {
    key: KEY,
    sessionId: 'session-1',
    serverName: 'fs',
    transport: 'stdio',
    targetSummary: 'stdio: node (1 arg)',
    connection: 'connected',
    connectionError: undefined,
    serverVersion: '1.0.0',
    instructions: undefined,
    tools: [{ name: 'read_file', title: 'Read File' }],
    toolsError: undefined,
    selectedTool: 'read_file',
    paramsDirty: false,
    paramsText: '{\n  "path": "/tmp/a"\n}',
    running: false,
    lastResult: undefined,
    lastError: undefined,
    history: [],
    warning: 'Calls here skip the agent’s permission prompts.',
    ...overrides,
  }
}

function setup(state: McpDebugPanelState = makeState(), input?: McpDebugEditorInput) {
  const service = new FakeDebugService(state.key, state)
  const services = new ServiceCollection()
  services.set(IMcpDebugService, service as never)
  const inst = new InstantiationService(services)
  const editorInput = input ?? new McpDebugEditorInput(KEY, 'fs')
  const view = render(
    <ServicesContext.Provider value={inst}>
      <McpDebugPanel input={editorInput} />
    </ServicesContext.Provider>,
  )
  return { service, view }
}

describe('McpDebugPanel', () => {
  it('shows the tab identity and connection state', () => {
    const { service } = setup()
    expect(screen.getByTestId('mcp-debug-panel')).toBeTruthy()
    const status = screen.getByTestId('mcp-debug-panel-connection-state')
    expect(status.textContent).toBe('Connected')
    expect(status.getAttribute('data-state')).toBe('connected')
    expect(screen.getByText('fs')).toBeTruthy()
    expect(screen.getByText('stdio')).toBeTruthy()
    expect(screen.getByText('1.0.0')).toBeTruthy()

    service.update({ connection: 'failed', connectionError: 'ENOENT' })
    expect(screen.getByTestId('mcp-debug-panel-connection-state').textContent).toBe(
      'Connection failed',
    )
    expect(screen.getByTestId('mcp-debug-panel-connect-error').textContent).toContain('ENOENT')
  })

  it('renders the standing warning only when there is one', () => {
    const { service } = setup()
    expect(screen.getByTestId('mcp-debug-panel-warning-banner')).toBeTruthy()
    service.update({ warning: undefined })
    expect(screen.queryByTestId('mcp-debug-panel-warning-banner')).toBeNull()
  })

  it('lists the server’s tools and reports clicks', () => {
    const { service } = setup(
      makeState({
        tools: [{ name: 'read_file', title: 'Read File' }, { name: 'write_file' }],
      }),
    )
    const rows = screen.getAllByTestId('mcp-debug-panel-tool-row')
    expect(rows.map((row) => row.textContent)).toEqual(['Read File', 'write_file'])
    expect(rows[0]!.getAttribute('data-active')).toBe('true')
    expect(rows[1]!.getAttribute('data-active')).toBe('false')

    fireEvent.click(rows[1]!)
    expect(service.selectTool).toHaveBeenCalledWith(KEY, 'write_file')
  })

  it('renders the selected tool’s schema', () => {
    setup(
      makeState({
        tools: [
          {
            name: 'read_file',
            title: 'Read File',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    )
    expect(screen.getByTestId('mcp-debug-panel-tool-schema').textContent).toContain('"path": {')
  })

  it('edits the params box through the service', () => {
    const { service } = setup()
    const box = screen.getByTestId('mcp-debug-panel-params-input') as HTMLTextAreaElement
    expect(box.value).toBe('{\n  "path": "/tmp/a"\n}')
    fireEvent.change(box, { target: { value: '{"path": "/tmp/b"}' } })
    expect(service.setParamsText).toHaveBeenCalledWith(KEY, '{"path": "/tmp/b"}')
  })

  it('disables Run and explains why while the JSON is broken', () => {
    const { service } = setup(makeState({ paramsText: '{' }))
    const run = screen.getByTestId('mcp-debug-panel-call') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(screen.getByTestId('mcp-debug-panel-params-error').textContent?.length).toBeGreaterThan(
      0,
    )

    service.update({ paramsText: '{}' })
    expect((screen.getByTestId('mcp-debug-panel-call') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByTestId('mcp-debug-panel-params-error')).toBeNull()
  })

  it('runs the tool on demand', () => {
    const { service } = setup()
    fireEvent.click(screen.getByTestId('mcp-debug-panel-call'))
    expect(service.runTool).toHaveBeenCalledWith(KEY)
  })

  it('marks a server-reported error as a reply, not an editor failure', () => {
    setup(
      makeState({
        lastResult: { isError: true, content: [{ type: 'text', text: 'boom' }], durationMs: 7 },
      }),
    )
    const response = screen.getByTestId('mcp-debug-panel-response')
    expect(response.getAttribute('data-is-error')).toBe('true')
    expect(within(response).getByText(/server’s own reply/)).toBeTruthy()
    expect(response.textContent).toContain('boom')
    expect(response.textContent).toContain('7 ms')
    expect(screen.queryByTestId('mcp-debug-panel-error')).toBeNull()
  })

  it('shows structured content alongside the content blocks', () => {
    setup(
      makeState({
        lastResult: {
          isError: false,
          content: [],
          structuredContent: { ok: true },
          durationMs: 1,
        },
      }),
    )
    expect(screen.getByTestId('mcp-debug-panel-response').textContent).toContain('"ok": true')
  })

  it('shows a call failure with a copy-details escape hatch', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    setup(makeState({ lastError: 'spawn ENOENT' }))

    const banner = screen.getByTestId('mcp-debug-panel-error')
    expect(banner.textContent).toContain('spawn ENOENT')
    fireEvent.click(within(banner).getByText('Copy details'))
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('spawn ENOENT'))
  })

  it('flags a running call', () => {
    setup(makeState({ running: true }))
    const run = screen.getByTestId('mcp-debug-panel-call') as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.getAttribute('aria-busy')).toBe('true')
  })

  it('lists the call history with restore and clear', () => {
    const { service } = setup(
      makeState({
        history: [
          {
            id: 'e1',
            tool: 'read_file',
            paramsText: '{"path": "/tmp/a"}',
            startedAt: 1_700_000_000_000,
            durationMs: 4,
            isError: false,
            result: { isError: false, content: [], durationMs: 4 },
            error: undefined,
          },
        ],
      }),
    )
    const row = screen.getByTestId('mcp-debug-panel-history-row')
    expect(row.textContent).toContain('read_file')
    fireEvent.click(within(row).getByText('Put back in the editor'))
    expect(service.restore).toHaveBeenCalledWith(KEY, 'e1')

    fireEvent.click(screen.getByTestId('mcp-debug-panel-history-clear'))
    expect(service.clearHistory).toHaveBeenCalledWith(KEY)
  })

  it('reconnects / refreshes / disconnects from the header', () => {
    const { service } = setup()
    fireEvent.click(screen.getByTestId('mcp-debug-panel-refresh-tools'))
    expect(service.refreshTools).toHaveBeenCalledWith(KEY)
    fireEvent.click(screen.getByTestId('mcp-debug-panel-disconnect'))
    expect(service.disconnect).toHaveBeenCalledWith(KEY)

    service.update({ connection: 'idle' })
    expect(
      (screen.getByTestId('mcp-debug-panel-refresh-tools') as HTMLButtonElement).disabled,
    ).toBe(true)
    expect((screen.getByTestId('mcp-debug-panel-disconnect') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('says so when the tab outlived its state', () => {
    setup(makeState(), new McpDebugEditorInput('some-other-key', 'fs'))
    expect(screen.getByTestId('mcp-debug-panel').textContent).toContain('no live session')
  })

  it('renders nothing for a foreign editor input', () => {
    const services = new ServiceCollection()
    services.set(IMcpDebugService, new FakeDebugService(KEY, makeState()) as never)
    const { container } = render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <McpDebugPanel input={{ id: 'other', typeId: 'other', getName: () => 'other' } as never} />
      </ServicesContext.Provider>,
    )
    expect(container.innerHTML).toBe('')
  })
})
