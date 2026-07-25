/*---------------------------------------------------------------------------------------------
 *  Tests for ElicitationCard — field-type rendering, the three protocol exits
 *  (submit=accept / decline / close=cancel), pre-submit validation with inline
 *  errors, and draft persistence across session switches (mirrors the
 *  QuestionCard draft tests).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { AcpPendingElicitation, IAcpSession } from '../../../services/acp/acpSessionService.js'
import {
  AcpElicitationDraftCache,
  elicitationDraftKey,
} from '../../../services/acp/acpElicitationDraftCache.js'
import { ElicitationCard } from '../ElicitationCard.js'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  AcpElicitationDraftCache._resetForTests()
})

function formRequest(overrides?: Partial<CreateElicitationRequest>): CreateElicitationRequest {
  return {
    sessionId: 'agent-1',
    mode: 'form',
    message: 'Configure the thing',
    requestedSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name', minLength: 2 },
        count: { type: 'integer', title: 'Count', minimum: 1, maximum: 10 },
        flag: { type: 'boolean', title: 'Flag' },
        color: {
          type: 'string',
          title: 'Color',
          oneOf: [
            { const: 'red', title: 'Red', description: 'warm' },
            { const: 'blue', title: 'Blue', description: 'cold' },
          ],
        },
        tags: {
          type: 'array',
          title: 'Tags',
          items: {
            anyOf: [
              { const: 'x', title: 'X' },
              { const: 'y', title: 'Y' },
            ],
          },
        },
      },
      required: ['name'],
    },
    ...overrides,
  } as CreateElicitationRequest
}

interface Harness {
  pending: AcpPendingElicitation
  resolved: CreateElicitationResponse[]
  cancelled: boolean
}

function makePending(request: CreateElicitationRequest): Harness {
  const harness = {
    resolved: [] as CreateElicitationResponse[],
    cancelled: false,
  } as Harness
  harness.pending = {
    request,
    resolve: (result) => {
      harness.resolved.push(result)
    },
    cancel: () => {
      harness.cancelled = true
    },
  }
  return harness
}

function makeSession(id: string, pending: AcpPendingElicitation | undefined): IAcpSession {
  return {
    id,
    pendingElicitation: observableValue<AcpPendingElicitation | undefined>(`pe:${id}`, pending),
  } as unknown as IAcpSession
}

function renderCard(session: IAcpSession) {
  return <ElicitationCard key={`elicitation:${session.id}`} session={session} />
}

describe('ElicitationCard', () => {
  it('renders nothing without a pending elicitation', () => {
    render(renderCard(makeSession('A', undefined)))
    expect(screen.queryByTestId('acp-elicitation-card')).toBeNull()
  })

  it('renders every field kind with the request message as title', () => {
    const h = makePending(formRequest())
    render(renderCard(makeSession('A', h.pending)))

    expect(screen.getByTestId('acp-elicitation-card').textContent).toContain('Configure the thing')
    expect(screen.getByTestId('acp-elicitation-input-name').tagName).toBe('INPUT')
    expect(screen.getByTestId('acp-elicitation-input-count').getAttribute('type')).toBe('number')
    expect(screen.getByTestId('acp-elicitation-input-flag').getAttribute('type')).toBe('checkbox')
    // enum → self-drawn Select trigger; enum-multi → checkbox group.
    expect(screen.getByTestId('acp-elicitation-input-color').tagName).toBe('BUTTON')
    expect(screen.getByTestId('acp-elicitation-input-tags-x')).toBeTruthy()
    expect(screen.getByTestId('acp-elicitation-input-tags-y')).toBeTruthy()
  })

  it('submit validates first: shows the inline error and does not resolve', () => {
    const h = makePending(formRequest())
    render(renderCard(makeSession('A', h.pending)))

    // Required "name" missing → inline error, no settle.
    fireEvent.click(screen.getByTestId('acp-elicitation-submit'))
    expect(screen.getByTestId('acp-elicitation-error')).toBeTruthy()
    expect(h.resolved).toHaveLength(0)

    // Fix it, then the submit goes through with converted content.
    fireEvent.change(screen.getByTestId('acp-elicitation-input-name'), { target: { value: 'ok' } })
    fireEvent.change(screen.getByTestId('acp-elicitation-input-count'), { target: { value: '3' } })
    fireEvent.click(screen.getByTestId('acp-elicitation-input-flag'))
    fireEvent.click(screen.getByTestId('acp-elicitation-input-color'))
    fireEvent.click(screen.getByRole('option', { name: /Blue/ }))
    fireEvent.click(screen.getByTestId('acp-elicitation-input-tags-x'))
    fireEvent.click(screen.getByTestId('acp-elicitation-submit'))

    expect(h.resolved).toEqual([
      {
        action: 'accept',
        content: { name: 'ok', count: 3, flag: true, color: 'blue', tags: ['x'] },
      },
    ])
  })

  it('rejects an out-of-range number field with an inline error', () => {
    const h = makePending(formRequest())
    render(renderCard(makeSession('A', h.pending)))

    fireEvent.change(screen.getByTestId('acp-elicitation-input-name'), { target: { value: 'ok' } })
    // maximum is 10.
    fireEvent.change(screen.getByTestId('acp-elicitation-input-count'), {
      target: { value: '99' },
    })
    fireEvent.click(screen.getByTestId('acp-elicitation-submit'))
    expect(screen.getByTestId('acp-elicitation-error')).toBeTruthy()
    expect(h.resolved).toHaveLength(0)
  })

  it('decline settles with the decline action and clears the draft', () => {
    const h = makePending(formRequest({ toolCallId: 'tc-1' }))
    render(renderCard(makeSession('A', h.pending)))

    fireEvent.change(screen.getByTestId('acp-elicitation-input-name'), { target: { value: 'ok' } })
    fireEvent.click(screen.getByTestId('acp-elicitation-decline'))

    expect(h.resolved).toEqual([{ action: 'decline' }])
    expect(AcpElicitationDraftCache.load('A', 'tc-1')).toBeUndefined()
  })

  it('close (×) settles as cancel', () => {
    const h = makePending(formRequest())
    render(renderCard(makeSession('A', h.pending)))

    fireEvent.click(screen.getByTestId('acp-elicitation-close'))
    expect(h.cancelled).toBe(true)
    expect(h.resolved).toHaveLength(0)
  })

  it('Esc inside the card settles as cancel', () => {
    const h = makePending(formRequest())
    render(renderCard(makeSession('A', h.pending)))

    fireEvent.keyDown(screen.getByTestId('acp-elicitation-input-name'), { key: 'Escape' })
    expect(h.cancelled).toBe(true)
  })

  it('restores in-progress input after switching sessions and back', () => {
    const hA = makePending(formRequest({ toolCallId: 'tc-a' }))
    const { rerender } = render(renderCard(makeSession('A', hA.pending)))

    fireEvent.change(screen.getByTestId('acp-elicitation-input-name'), {
      target: { value: 'draft text' },
    })

    // Switch to session B (different key → A unmounts, B mounts).
    const hB = makePending(formRequest({ toolCallId: 'tc-b', message: 'Other question' }))
    rerender(renderCard(makeSession('B', hB.pending)))
    expect((screen.getByTestId('acp-elicitation-input-name') as HTMLInputElement).value).toBe('')

    // Back to A — the draft is restored.
    rerender(renderCard(makeSession('A', makePending(formRequest({ toolCallId: 'tc-a' })).pending)))
    expect((screen.getByTestId('acp-elicitation-input-name') as HTMLInputElement).value).toBe(
      'draft text',
    )
  })

  it('submit clears the draft so a following elicitation starts empty', () => {
    const h = makePending(formRequest({ toolCallId: 'tc-1' }))
    const { rerender } = render(renderCard(makeSession('A', h.pending)))

    fireEvent.change(screen.getByTestId('acp-elicitation-input-name'), { target: { value: 'ok' } })
    fireEvent.click(screen.getByTestId('acp-elicitation-submit'))
    expect(AcpElicitationDraftCache.load('A', 'tc-1')).toBeUndefined()

    const next = makePending(formRequest({ toolCallId: 'tc-2', message: 'Next one' }))
    rerender(renderCard(makeSession('A', next.pending)))
    expect((screen.getByTestId('acp-elicitation-input-name') as HTMLInputElement).value).toBe('')
  })

  it('prefills declared defaults when no draft exists', () => {
    const h = makePending(
      formRequest({
        requestedSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', default: 'preset' },
            flag: { type: 'boolean', default: true },
          },
        },
      } as Partial<CreateElicitationRequest>),
    )
    render(renderCard(makeSession('A', h.pending)))
    expect((screen.getByTestId('acp-elicitation-input-name') as HTMLInputElement).value).toBe(
      'preset',
    )
    expect((screen.getByTestId('acp-elicitation-input-flag') as HTMLInputElement).checked).toBe(
      true,
    )
  })
})

describe('elicitationDraftKey', () => {
  it('prefers the toolCallId, falls back to a message hash', () => {
    expect(elicitationDraftKey('tc-1', 'hello')).toBe('tc-1')
    expect(elicitationDraftKey(undefined, 'hello')).toBe(elicitationDraftKey(null, 'hello'))
    expect(elicitationDraftKey(undefined, 'hello')).not.toBe(elicitationDraftKey(undefined, 'bye'))
  })
})
