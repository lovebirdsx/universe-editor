/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ToolCallCard — kind-based body rendering (read collapse, execute
 *  terminal output) and the status icon.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import {
  IConfigurationService,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type {
  IConfigurationService as IConfigurationServiceType,
  IEditorGroupsService as IEditorGroupsServiceType,
  IEditorResolverService as IEditorResolverServiceType,
  IEditorService as IEditorServiceType,
} from '@universe-editor/platform'
import type {
  AcpMessage,
  AcpToolCall,
  AcpToolCallStatus,
} from '../../../services/acp/session/acpSessionService.js'
import { ToolCallCard } from '../ToolCallCard.js'
import { ServicesContext } from '../../useService.js'

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => new Promise(() => {}) },
}))

afterEach(() => {
  cleanup()
  openedInGroup.length = 0
  resolvedOpens.length = 0
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

/** Captures editors opened through the group service (the preview button's route). */
const openedInGroup: unknown[] = []

/** Captures files opened through the resolver (the "Open File" button's route). */
const resolvedOpens: { resource: unknown; options: unknown }[] = []

function makeGroupsService(): IEditorGroupsServiceType {
  const group = {
    // No preview is ever already open in these tests, so the dedupe lookup that
    // openPreviewInGroup performs always misses.
    findEditor: () => undefined,
    openEditor: vi.fn((input: unknown) => {
      openedInGroup.push(input)
      return Promise.resolve(undefined)
    }),
  }
  const groups = {
    _serviceBrand: undefined,
    activeGroup: group,
    getGroups: () => [group],
    activateGroup: vi.fn(),
  }
  return groups as unknown as IEditorGroupsServiceType
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
  services.set(IEditorGroupsService, makeGroupsService())
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    openEditor: vi.fn((resource: unknown, options: unknown) => {
      resolvedOpens.push({ resource, options })
      return Promise.resolve(undefined)
    }),
  } as unknown as IEditorResolverServiceType)
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

  it('tags sub-agent children with composite data-sticky-key when collapse is controlled', () => {
    const services = new ServiceCollection()
    services.set(IEditorService, {
      _serviceBrand: undefined,
      openEditor: vi.fn().mockResolvedValue(undefined),
    } as unknown as IEditorServiceType)
    services.set(IConfigurationService, {
      _serviceBrand: undefined,
      get: () => undefined,
    } as unknown as IConfigurationServiceType)
    const inst = new InstantiationService(services)
    const { container } = render(
      <ServicesContext.Provider value={inst}>
        <ul>
          <ToolCallCard
            call={makeCall({
              kind: 'other',
              children: [
                { kind: 'message', id: 'sm1', message: makeChildMessage('sub thinking') },
                {
                  kind: 'toolCall',
                  id: 'sc1',
                  call: makeCall({ id: 'sc1', kind: 'read', title: 'Read' }),
                },
              ],
            })}
            collapsed={false}
            onToggleCollapse={() => {}}
            subtreeCollapse={{
              stickyKey: 't:t1',
              depth: 0,
              collapse: { mode: 'default', overrides: new Map() },
              toggle: () => {},
            }}
          />
        </ul>
      </ServicesContext.Provider>,
    )
    expect(container.querySelector('[data-sticky-key="t:t1/m:sm1"]')).not.toBeNull()
    expect(container.querySelector('[data-sticky-key="t:t1/t:sc1"]')).not.toBeNull()
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

  it('renders a sub-agent message as a card shell (role + collapsible header)', () => {
    renderCard(
      makeCall({
        kind: 'other',
        children: [{ kind: 'message', id: 'sm1', message: makeChildMessage('sub thinking') }],
      }),
    )
    const msg = screen.getByTestId('acp-subagent-message')
    expect(msg.getAttribute('data-role')).toBe('agent')
    expect(msg.querySelector('[data-testid="acp-collapsible-toggle"]')).not.toBeNull()
  })

  it('marks a sub-agent thought message with data-role=thought', () => {
    renderCard(
      makeCall({
        kind: 'other',
        children: [
          {
            kind: 'message',
            id: 'sm1',
            message: { ...makeChildMessage('reasoning'), role: 'thought' },
          },
        ],
      }),
    )
    expect(screen.getByTestId('acp-subagent-message').getAttribute('data-role')).toBe('thought')
  })

  it('folds a sub-agent message on click in standalone usage', () => {
    renderCard(
      makeCall({
        kind: 'other',
        children: [{ kind: 'message', id: 'sm1', message: makeChildMessage('sub thinking') }],
      }),
    )
    // kind 'other' renders expanded → the child message body is visible.
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
    const msg = screen.getByTestId('acp-subagent-message')
    const childToggle = within(msg).getByTestId('acp-collapsible-toggle')
    fireEvent.click(childToggle)
    expect(screen.queryByTestId('acp-markdown')).toBeNull()
    fireEvent.click(childToggle)
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
  })

  it('folds a sub-agent message via the shared collapse store', () => {
    const services = new ServiceCollection()
    services.set(IEditorService, {
      _serviceBrand: undefined,
      openEditor: vi.fn().mockResolvedValue(undefined),
    } as unknown as IEditorServiceType)
    services.set(IConfigurationService, {
      _serviceBrand: undefined,
      get: () => undefined,
    } as unknown as IConfigurationServiceType)
    const inst = new InstantiationService(services)
    const toggle = vi.fn()
    render(
      <ServicesContext.Provider value={inst}>
        <ul>
          <ToolCallCard
            call={makeCall({
              kind: 'other',
              children: [{ kind: 'message', id: 'sm1', message: makeChildMessage('sub thinking') }],
            })}
            collapsed={false}
            onToggleCollapse={() => {}}
            subtreeCollapse={{
              stickyKey: 't:t1',
              depth: 0,
              collapse: { mode: 'default', overrides: new Map([['t:t1/m:sm1', true]]) },
              toggle,
            }}
          />
        </ul>
      </ServicesContext.Provider>,
    )
    // The override pins the child message collapsed → its body is not mounted.
    expect(screen.queryByTestId('acp-markdown')).toBeNull()
    // Clicking the child toggle dispatches its composite key through the store.
    fireEvent.click(
      within(screen.getByTestId('acp-subagent-message')).getByTestId('acp-collapsible-toggle'),
    )
    expect(toggle).toHaveBeenCalledWith('t:t1/m:sm1')
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
    expect(screen.getByText('Continued planning')).toBeTruthy()
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
    expect(screen.getByText('Continued planning')).toBeTruthy()
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

  it('renders tokens without model or cost when the stats carry neither', () => {
    renderCard(
      makeCall({
        kind: 'other',
        title: 'Explore the codebase',
        status: 'completed',
        durationMs: 12_000,
        // Codex-shaped tally: tokens + duration, no model / no costUSD.
        subagentStats: {
          inputTokens: 12_000,
          outputTokens: 3_000,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        },
      }),
    )
    const stats = screen.getByTestId('acp-subagent-stats')
    expect(stats.textContent).toContain('↑')
    expect(stats.textContent).toContain('↓')
    // No model badge and no estimated-cost badge.
    expect(stats.textContent).not.toContain('sonnet-5')
    expect(stats.textContent).not.toContain('¥')
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
    expect(link.getAttribute('data-tooltip')).toBe('/repo/src/foo.ts:42')
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

  describe('created-file card', () => {
    const RESULT_PATH = '/repo/.claude/explore-results/20260829-sess-agent.md'

    function makeResultCall(path = RESULT_PATH): AcpToolCall {
      return makeCall({
        kind: 'edit',
        title: 'Saved Explore result: 20260829-sess-agent.md',
        diffs: [{ path, oldText: '', newText: '# Explore subagent result\n' }],
      })
    }

    function makeSourceCreateCall(path = '/repo/src/newModule.ts'): AcpToolCall {
      return makeCall({
        kind: 'edit',
        title: 'Write newModule.ts',
        diffs: [{ path, oldText: '', newText: 'export const a = 1\n' }],
      })
    }

    it('starts collapsed and expands on click', () => {
      renderCard(makeResultCall())
      expect(screen.queryByTestId('acp-inline-diff')).toBeNull()
      fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
      expect(screen.getByTestId('acp-inline-diff')).toBeTruthy()
    })

    it('starts a non-previewable create collapsed too', () => {
      renderCard(makeSourceCreateCall())
      expect(screen.queryByTestId('acp-inline-diff')).toBeNull()
    })

    it('renders the read action inside the header, never as a nested button', () => {
      renderCard(makeResultCall())
      const preview = screen.getByTestId('acp-toolcall-open-preview')
      // It lives in the header (inline, so it does not shift the trailing
      // elapsed-time / status columns), which makes the header's own <button>
      // its ancestor — hence a role="button" span: nesting real buttons is
      // invalid HTML that the browser silently re-parents.
      const toggle = screen.getByTestId('acp-collapsible-toggle')
      expect(toggle.contains(preview)).toBe(true)
      expect(preview.tagName).toBe('SPAN')
      expect(preview.getAttribute('role')).toBe('button')
      expect(preview.closest('button')).toBe(toggle)
    })

    it('places the read action before the stats badge', () => {
      // `durationMs` is what makes SubagentStatsBadge render at all — without it
      // there is no trailing column to order against.
      renderCard({ ...makeResultCall(), durationMs: 1200 })
      const preview = screen.getByTestId('acp-toolcall-open-preview')
      const stats = screen.getByTestId('acp-subagent-stats')
      // Left of the elapsed time, per the header's trailing-column order.
      expect(preview.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('opens a markdown preview (not the source) when the button is clicked', () => {
      renderCard(makeResultCall())
      fireEvent.click(screen.getByTestId('acp-toolcall-open-preview'))
      expect(openedInGroup).toHaveLength(1)
      expect((openedInGroup[0] as { typeId: string }).typeId).toBe('markdown.preview')
      // Clicking the action must not also toggle the card open.
      expect(screen.queryByTestId('acp-inline-diff')).toBeNull()
    })

    it('keeps the preview button available once expanded', () => {
      renderCard(makeResultCall())
      fireEvent.click(screen.getByTestId('acp-collapsible-toggle'))
      expect(screen.getByTestId('acp-toolcall-open-preview')).toBeTruthy()
    })

    it('offers "open file" instead of a preview for a non-previewable document', () => {
      renderCard(makeSourceCreateCall())
      expect(screen.queryByTestId('acp-toolcall-open-preview')).toBeNull()
      expect(screen.getByTestId('acp-toolcall-open-file')).toBeTruthy()
    })

    it('opens the file itself (pinned) when the open button is clicked', () => {
      renderCard(makeSourceCreateCall())
      fireEvent.click(screen.getByTestId('acp-toolcall-open-file'))
      expect(resolvedOpens).toHaveLength(1)
      expect((resolvedOpens[0]?.resource as { path: string }).path).toBe('/repo/src/newModule.ts')
      expect(resolvedOpens[0]?.options).toEqual({ pinned: true })
      // The click must not also toggle the card open.
      expect(screen.queryByTestId('acp-inline-diff')).toBeNull()
    })

    it('leaves an ordinary edit card expanded and without any header action', () => {
      renderCard(
        makeCall({
          kind: 'edit',
          title: 'Edit foo.ts',
          diffs: [{ path: '/repo/src/foo.ts', oldText: 'a', newText: 'b' }],
        }),
      )
      expect(screen.getByTestId('acp-inline-diff')).toBeTruthy()
      expect(screen.queryByTestId('acp-toolcall-open-preview')).toBeNull()
      expect(screen.queryByTestId('acp-toolcall-open-file')).toBeNull()
    })
  })
})
