/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ToolCallCard — kind-based body rendering (read collapse, execute
 *  terminal output) and the status icon.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { IEditorService, InstantiationService, ServiceCollection } from '@universe-editor/platform'
import type { IEditorService as IEditorServiceType } from '@universe-editor/platform'
import type { AcpToolCall, AcpToolCallStatus } from '../../../services/acp/acpSessionService.js'
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

function renderCard(call: AcpToolCall) {
  const services = new ServiceCollection()
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEditorServiceType)
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
    fireEvent.click(screen.getByTestId('acp-toolcall-read-toggle'))
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
  })

  it('collapses a search card by default and expands on click', () => {
    renderCard(makeCall({ kind: 'search', blocks: [{ type: 'text', text: 'search results' }] }))
    expect(screen.queryByTestId('acp-markdown')).toBeNull()
    fireEvent.click(screen.getByTestId('acp-toolcall-read-toggle'))
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
  })

  it('renders execute output as ANSI terminal output', () => {
    renderCard(makeCall({ kind: 'execute', text: '\x1b[32mok\x1b[0m' }))
    const out = screen.getByTestId('acp-terminal-output')
    expect(out).toBeTruthy()
    expect(out.textContent).toBe('ok')
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
})
