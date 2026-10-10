/*---------------------------------------------------------------------------------------------
 *  Tests for the MCP replay button on ToolCallCard — the visibility matrix (what
 *  a card must carry for a replay to be possible), the session gates that render
 *  it disabled, and the click path into IMcpDebugService.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  IEditorGroupsService,
  IEditorResolverService,
  IEditorService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type { IAcpSession } from '../../../services/acp/session/acpSessionModel.js'
import type { AcpToolCall } from '../../../services/acp/session/acpSessionService.js'
import { IMcpDebugService } from '../../../services/acp/mcp/mcpDebugService.js'
import { ToolCallCard } from '../ToolCallCard.js'
import { ServicesContext } from '../../useService.js'

vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => new Promise(() => {}) },
}))

afterEach(cleanup)

const TESTID = 'acp-toolcall-mcp-replay'

/**
 * `Partial<AcpToolCall>` cannot express "clear this field" under
 * `exactOptionalPropertyTypes`, and the visibility cases below need exactly that.
 */
type CallPatch = { [K in keyof AcpToolCall]?: AcpToolCall[K] | undefined }

function makeCall(overrides: CallPatch = {}): AcpToolCall {
  return {
    id: 't1',
    title: 'mcp__fs__read_file',
    kind: 'other',
    status: 'completed',
    text: '',
    blocks: [],
    diffs: [],
    mcpServer: 'fs',
    mcpTool: 'read_file',
    rawInput: { path: '/tmp/a' },
    ...overrides,
  } as AcpToolCall
}

function makeSession(overrides: Partial<IAcpSession> = {}): IAcpSession {
  return {
    id: 'session-1',
    agentId: 'claude-code',
    cwd: 'X:/workspace',
    authority: undefined,
    readOnly: false,
    ...overrides,
  } as unknown as IAcpSession
}

function setup(call: AcpToolCall, session?: IAcpSession) {
  const openFromToolCall = vi.fn(async () => undefined)
  const notify = vi.fn()
  const onToggleCollapse = vi.fn()
  const services = new ServiceCollection()
  services.set(IEditorService, { _serviceBrand: undefined, openEditor: vi.fn() } as never)
  services.set(IConfigurationService, { _serviceBrand: undefined, get: () => undefined } as never)
  services.set(IEditorGroupsService, { _serviceBrand: undefined, activeGroup: {} } as never)
  services.set(IEditorResolverService, { _serviceBrand: undefined, openEditor: vi.fn() } as never)
  services.set(IMcpDebugService, { _serviceBrand: undefined, openFromToolCall } as never)
  services.set(INotificationService, { _serviceBrand: undefined, notify } as never)
  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <ul>
        <ToolCallCard
          call={call}
          {...(session !== undefined ? { session } : {})}
          collapsed={false}
          onToggleCollapse={onToggleCollapse}
        />
      </ul>
    </ServicesContext.Provider>,
  )
  return { openFromToolCall, notify, onToggleCollapse }
}

describe('MCP replay button visibility', () => {
  it('shows on an MCP card that still carries its arguments', () => {
    setup(makeCall(), makeSession())
    expect(screen.getByTestId(TESTID)).toBeTruthy()
  })

  it.each([
    ['a built-in (non-MCP) tool', { mcpServer: undefined, mcpTool: undefined }],
    ['a card with no tool segment', { mcpTool: undefined }],
    ['a card whose arguments were released', { rawInput: undefined }],
    ['a card flagged as trimmed', { memoryTrimmed: true as const }],
  ])('stays hidden on %s', (_label, overrides) => {
    setup(makeCall(overrides), makeSession())
    expect(screen.queryByTestId(TESTID)).toBeNull()
  })

  it('stays hidden without a session to resolve the config from', () => {
    setup(makeCall())
    expect(screen.queryByTestId(TESTID)).toBeNull()
  })

  it('renders on a sub-agent child card too', () => {
    // Parent is the Task card itself (no MCP attribution of its own); the replay
    // button on the nested card proves the session is threaded down.
    setup(
      makeCall({
        mcpServer: undefined,
        mcpTool: undefined,
        rawInput: undefined,
        subagent: true,
        children: [{ kind: 'toolCall', id: 'child', call: makeCall({ id: 'child' }) }],
      }),
      makeSession(),
    )
    expect(screen.getAllByTestId(TESTID)).toHaveLength(1)
  })
})

describe('MCP replay click', () => {
  it('reaches the debug service and does not toggle the card', () => {
    // The header is itself a button: without stopPropagation this click would
    // also expand/collapse the card the user is trying to debug.
    const session = makeSession()
    const call = makeCall()
    const { openFromToolCall, onToggleCollapse } = setup(call, session)

    fireEvent.click(screen.getByTestId(TESTID))
    expect(onToggleCollapse).not.toHaveBeenCalled()
    expect(openFromToolCall).toHaveBeenCalledWith(session, call)
  })

  it('fires on Enter and Space', () => {
    const { openFromToolCall, onToggleCollapse } = setup(makeCall(), makeSession())
    const button = screen.getByTestId(TESTID)
    fireEvent.keyDown(button, { key: 'Enter' })
    fireEvent.keyDown(button, { key: ' ' })
    expect(openFromToolCall).toHaveBeenCalledTimes(2)
    expect(onToggleCollapse).not.toHaveBeenCalled()
  })

  it('ignores other keys', () => {
    const { openFromToolCall } = setup(makeCall(), makeSession())
    fireEvent.keyDown(screen.getByTestId(TESTID), { key: 'a' })
    expect(openFromToolCall).not.toHaveBeenCalled()
  })
})

describe('MCP replay session gates', () => {
  it.each([
    ['a remote workspace', { authority: 'ssh-remote+host' }, /remote/i],
    ['a read-only preview session', { readOnly: true }, /read-only/i],
  ])('renders disabled on %s and explains the click', (_label, overrides, expected) => {
    const { openFromToolCall, notify } = setup(makeCall(), makeSession(overrides))
    const button = screen.getByTestId(TESTID)
    expect(button.getAttribute('data-disabled')).toBe('true')
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('data-tooltip')).toMatch(expected)

    fireEvent.click(button)
    expect(openFromToolCall).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(expected) }),
    )
  })

  it('is enabled on an ordinary session', () => {
    setup(makeCall(), makeSession())
    const button = screen.getByTestId(TESTID)
    expect(button.getAttribute('data-disabled')).toBe('false')
    expect(button.getAttribute('aria-disabled')).toBeNull()
    expect(button.getAttribute('data-tooltip')).toMatch(/Replay this MCP tool call/)
  })
})
