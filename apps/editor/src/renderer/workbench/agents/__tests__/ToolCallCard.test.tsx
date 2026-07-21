/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ToolCallCard — kind-based body rendering (read collapse, execute
 *  terminal output) and the status icon.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  IEditorService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type {
  IConfigurationService as IConfigurationServiceType,
  IEditorService as IEditorServiceType,
} from '@universe-editor/platform'
import type {
  AcpMessage,
  AcpToolCall,
  AcpToolCallStatus,
} from '../../../services/acp/acpSessionService.js'
import { ToolCallCard } from '../ToolCallCard.js'
import { ServicesContext } from '../../useService.js'

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => new Promise(() => {}) },
}))

afterEach(() => {
  cleanup()
})

function makeCall(overrides: Partial<AcpToolCall>): AcpToolCall {
  return {
    id: 't1',
    title: 'a tool call',
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    ...overrides,
  }
}

function makeChildMessage(text: string): AcpMessage {
  return {
    id: `cm-${text}`,
    role: 'agent',
    text,
    blocks: [{ type: 'text', text }],
    streaming: false,
  }
}

function renderCard(call: AcpToolCall, config: Record<string, unknown> = {}) {
  const services = new ServiceCollection()
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEditorServiceType)
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (key: string) => config[key],
  } as unknown as IConfigurationServiceType)
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <ul>
        <ToolCallCard call={call} />
      </ul>
    </ServicesContext.Provider>,
  )
}

describe('ToolCallCard', () => {
  it('collapses a read card by default and expands on click', () => {
    renderCard(makeCall({ kind: 'read', blocks: [{ type: 'text', text: 'file contents here' }] }))
    expect(screen.queryByTestId('acp-markdown')).toBeNull()
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
  })

  it('collapses a search card by default and expands on click', () => {
    renderCard(makeCall({ kind: 'search', blocks: [{ type: 'text', text: 'search results' }] }))
    expect(screen.queryByTestId('acp-markdown')).toBeNull()
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
  })

  it('renders execute output as ANSI terminal output', () => {
    renderCard(makeCall({ kind: 'execute', text: '\x1b[32mok\x1b[0m' }))
    const out = screen.getByTestId('acp-terminal-output')
    expect(out).toBeTruthy()
    expect(out.textContent).toBe('ok')
  })

  it('shows a Bash description as the title and moves the command into the body', () => {
    renderCard(
      makeCall({
        kind: 'execute',
        title: 'git status',
        rawInput: { command: 'git status', description: '查看工作区状态' },
      }),
    )
    // Title shows only the friendly description, not the raw command.
    const title = screen.getByText('查看工作区状态')
    expect(title.querySelector('code')).toBeNull()
    // The raw command is demoted into the (expanded) card body.
    expect(screen.getByText('git status')).toBeTruthy()
  })

  it('falls back to the command as title when execute has no description', () => {
    renderCard(makeCall({ kind: 'execute', title: 'ls -la', rawInput: { command: 'ls -la' } }))
    const title = screen.getByText('ls -la')
    expect(title.querySelector('code')).toBeNull()
  })

  it('renders non-read/execute bodies eagerly (no collapse)', () => {
    renderCard(makeCall({ kind: 'fetch', blocks: [{ type: 'text', text: 'visible' }] }))
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
  })

  it.each<AcpToolCallStatus>(['pending', 'in_progress', 'completed', 'failed'])(
    'renders a status icon labelled %s',
    (status) => {
      renderCard(makeCall({ status }))
      expect(screen.getByLabelText(status)).toBeTruthy()
    },
  )

  it('renders a sub-agent timeline (message + nested tool call) inside the parent card', () => {
    // kind 'other' renders expanded standalone, so the folded children show.
    renderCard(
      makeCall({
        kind: 'other',
        children: [
          { kind: 'message', id: 'sm1', message: makeChildMessage('sub thinking') },
          {
            kind: 'toolCall',
            id: 'sc1',
            call: makeCall({ id: 'sc1', kind: 'read', title: 'Read' }),
          },
        ],
      }),
    )
    expect(screen.getByTestId('acp-subagent-timeline')).toBeTruthy()
    expect(screen.getByTestId('acp-subagent-message')).toBeTruthy()
    // The nested tool call renders its own card (a second collapsible toggle).
    expect(screen.getAllByTestId('acp-collapsible-toggle').length).toBeGreaterThanOrEqual(2)
  })

  it('hides the sub-agent timeline while the parent card is collapsed', () => {
    renderCard(
      makeCall({
        kind: 'read',
        children: [{ kind: 'message', id: 'sm1', message: makeChildMessage('hidden') }],
      }),
    )
    // read cards start collapsed → nested timeline not mounted.
    expect(screen.queryByTestId('acp-subagent-timeline')).toBeNull()
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    expect(screen.getByTestId('acp-subagent-timeline')).toBeTruthy()
  })

  it('humanizes an MCP tool title and shows a server badge', () => {
    renderCard(
      makeCall({
        kind: 'read',
        title: 'mcp_universe-editor_ue_create_session',
        mcpServer: 'universe-editor',
        mcpTool: 'ue_create_session',
      }),
    )
    expect(screen.getByText('Create Session')).toBeTruthy()
    expect(screen.getByText('MCP · universe-editor')).toBeTruthy()
  })

  it('renders MCP input (pretty JSON) and output sections expanded by default', () => {
    renderCard(
      makeCall({
        kind: 'read',
        mcpServer: 'fs',
        mcpTool: 'read_file',
        rawInput: { path: '/tmp/a.txt' },
        text: '{"ok":true}',
        blocks: [],
      }),
    )
    expect(screen.getByTestId('acp-mcp-input')).toBeTruthy()
    expect(screen.getByTestId('acp-mcp-output')).toBeTruthy()
  })

  it('collapses MCP sections when configured to none', () => {
    renderCard(
      makeCall({
        kind: 'read',
        mcpServer: 'fs',
        mcpTool: 'read_file',
        rawInput: { path: '/tmp/a.txt' },
        text: '{"ok":true}',
      }),
      { 'acp.mcpCard.defaultExpanded': 'none' },
    )
    // Section headers still render; their toggle buttons report collapsed.
    const input = screen.getByTestId('acp-mcp-input')
    expect(input.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    const output = screen.getByTestId('acp-mcp-output')
    expect(output.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('omits the MCP input section when there is no rawInput', () => {
    renderCard(
      makeCall({
        kind: 'read',
        mcpServer: 'fs',
        mcpTool: 'ping',
        text: '{"ok":true}',
      }),
    )
    expect(screen.queryByTestId('acp-mcp-input')).toBeNull()
    expect(screen.getByTestId('acp-mcp-output')).toBeTruthy()
  })

  it('renders a rejected ExitPlanMode as a neutral "kept planning" card', () => {
    renderCard(
      makeCall({
        kind: 'switch_mode',
        title: 'Ready to code?',
        status: 'failed',
        text: 'User rejected request to exit plan mode.',
        blocks: [{ type: 'text', text: 'User rejected request to exit plan mode.' }],
      }),
    )
    // Friendly title, not the raw "Ready to code?".
    expect(screen.getByText('已继续规划')).toBeTruthy()
    // The internal (default, no-note) rejection text is suppressed from the body.
    expect(screen.queryByText(/User rejected request to exit plan mode/)).toBeNull()
    expect(screen.queryByTestId('acp-keep-planning-feedback')).toBeNull()
    // Status is downgraded from the red failed icon to a neutral completed one.
    expect(screen.getByLabelText('completed')).toBeTruthy()
    expect(screen.queryByLabelText('failed')).toBeNull()
  })

  it('surfaces the user steering note on a kept-planning card', () => {
    renderCard(
      makeCall({
        kind: 'switch_mode',
        title: 'Ready to code?',
        status: 'failed',
        text: '先不做了',
        blocks: [{ type: 'text', text: '先不做了' }],
      }),
    )
    expect(screen.getByText('已继续规划')).toBeTruthy()
    const feedback = screen.getByTestId('acp-keep-planning-feedback')
    expect(feedback.textContent).toContain('先不做了')
    expect(screen.getByLabelText('completed')).toBeTruthy()
  })

  it('renders the sub-agent stats line (model + tokens + estimated cost)', () => {
    renderCard(
      makeCall({
        kind: 'other',
        title: 'Explore the codebase',
        status: 'completed',
        durationMs: 12_000,
        subagentStats: {
          model: 'claude-sonnet-5',
          inputTokens: 12_000,
          outputTokens: 3_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          costUSD: 0.081,
        },
      }),
    )
    const stats = screen.getByTestId('acp-subagent-stats')
    expect(stats.textContent).toContain('sonnet-5')
    // duration frozen at 12s, token summary, and an estimated (≈¥) cost.
    expect(stats.textContent).toContain('12s')
    expect(stats.textContent).toContain('↑')
    expect(stats.textContent).toContain('≈¥')
  })

  it('omits the stats line entirely when there is nothing to show', () => {
    renderCard(makeCall({ kind: 'other', title: 'plain tool' }))
    expect(screen.queryByTestId('acp-subagent-stats')).toBeNull()
  })

  it('renders clickable location links on a read card and opens on click', () => {
    renderCard(
      makeCall({
        kind: 'read',
        title: 'Read foo.ts',
        locations: [{ path: '/repo/src/foo.ts', line: 42 }],
      }),
    )
    // read cards start collapsed → expand to reveal the body.
    fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
    const link = screen.getByTestId('acp-toolcall-location')
    // Basename label + line suffix; full path lives in the tooltip.
    expect(link.textContent).toContain('foo.ts')
    expect(link.textContent).toContain(':42')
    expect(link.getAttribute('title')).toBe('/repo/src/foo.ts:42')
    // Clicking is wired to the file opener (a no-op without file services here,
    // but must not throw).
    fireEvent.click(link)
  })

  it('does not render a location row on a card with a diff (path shown in the diff header)', () => {
    renderCard(
      makeCall({
        kind: 'edit',
        title: 'Edit foo.ts',
        locations: [{ path: '/repo/src/foo.ts' }],
        diffs: [{ path: '/repo/src/foo.ts', oldText: 'a', newText: 'b' }],
      }),
    )
    expect(screen.queryByTestId('acp-toolcall-locations')).toBeNull()
    // The diff header path is itself clickable.
    expect(screen.getByTestId('acp-inline-diff-path')).toBeTruthy()
  })
})
