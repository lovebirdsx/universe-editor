/*---------------------------------------------------------------------------------------------
 *  Tests for ElicitationCard — form mode (field-type rendering, the three
 *  protocol exits submit=accept / decline / close=cancel, pre-submit validation
 *  with inline errors, draft persistence across session switches) and url mode
 *  (consent card → opener + accept → waiting → done, dismiss).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  InstantiationService,
  IOpenerService,
  observableValue,
  ServiceCollection,
  type ISettableObservable,
} from '@universe-editor/platform'
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type {
  AcpPendingElicitation,
  AcpUrlElicitationState,
  IAcpSession,
} from '../../../services/acp/acpSessionService.js'
import {
  AcpElicitationDraftCache,
  elicitationDraftKey,
} from '../../../services/acp/acpElicitationDraftCache.js'
import { ElicitationCard } from '../ElicitationCard.js'
import { ServicesContext } from '../../useService.js'

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

describe('ElicitationCard — AskUserQuestion folding', () => {
  function askRequest(): CreateElicitationRequest {
    return {
      sessionId: 'agent-1',
      mode: 'form',
      message: 'Please answer the following questions.',
      requestedSchema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            title: 'Pick one',
            oneOf: [
              { const: 'opt-a', title: 'Option A', description: 'detail A' },
              { const: 'opt-b', title: 'Option B', description: 'detail B' },
            ],
          },
          question_0_custom: {
            type: 'string',
            title: 'Other',
            description: 'Type your own answer instead of choosing an option above (optional).',
          },
        },
      },
    } as CreateElicitationRequest
  }

  it('shows the selected option description only once — in the footer, not the trigger', () => {
    const h = makePending(askRequest())
    render(renderCard(makeSession('A', h.pending)))

    fireEvent.click(screen.getByTestId('acp-elicitation-input-question_0'))
    fireEvent.click(screen.getByRole('option', { name: /Option A/ }))

    const trigger = screen.getByTestId('acp-elicitation-input-question_0')
    expect(trigger.textContent).toBe('Option A')
    const card = screen.getByTestId('acp-elicitation-card')
    expect(card.textContent?.match(/detail A/g)).toHaveLength(1)
  })

  it('renders the paired custom field as an inline input beside the select, not its own row', () => {
    const h = makePending(askRequest())
    render(renderCard(makeSession('A', h.pending)))

    // No standalone field row for the custom answer…
    expect(screen.queryByTestId('acp-elicitation-field-question_0_custom')).toBeNull()
    // …but its input is always visible next to the select, no "Other" pick needed.
    const input = screen.getByTestId('acp-elicitation-input-question_0_custom')
    expect(input.tagName).toBe('INPUT')
  })

  it('a typed Other answer clears the enum selection and wins in the submitted content', () => {
    const h = makePending(askRequest())
    render(renderCard(makeSession('A', h.pending)))

    // Select an option first, then type a custom answer — the select resets.
    fireEvent.click(screen.getByTestId('acp-elicitation-input-question_0'))
    fireEvent.click(screen.getByRole('option', { name: /Option A/ }))
    fireEvent.change(screen.getByTestId('acp-elicitation-input-question_0_custom'), {
      target: { value: 'my own answer' },
    })
    expect(screen.getByTestId('acp-elicitation-input-question_0').textContent).toBe('Select…')

    fireEvent.click(screen.getByTestId('acp-elicitation-submit'))
    expect(h.resolved).toEqual([
      { action: 'accept', content: { question_0_custom: 'my own answer' } },
    ])
  })

  it('picking a concrete option clears the typed custom answer', () => {
    const h = makePending(askRequest())
    render(renderCard(makeSession('A', h.pending)))

    fireEvent.change(screen.getByTestId('acp-elicitation-input-question_0_custom'), {
      target: { value: 'stale' },
    })
    fireEvent.click(screen.getByTestId('acp-elicitation-input-question_0'))
    fireEvent.click(screen.getByRole('option', { name: /Option B/ }))
    expect(
      (screen.getByTestId('acp-elicitation-input-question_0_custom') as HTMLInputElement).value,
    ).toBe('')

    fireEvent.click(screen.getByTestId('acp-elicitation-submit'))
    expect(h.resolved).toEqual([{ action: 'accept', content: { question_0: 'opt-b' } }])
  })

  it('leaving both the select and the Other input empty submits neither value', () => {
    const h = makePending(askRequest())
    render(renderCard(makeSession('A', h.pending)))

    fireEvent.click(screen.getByTestId('acp-elicitation-submit'))
    expect(h.resolved).toEqual([{ action: 'accept', content: {} }])
  })
})

describe('elicitationDraftKey', () => {
  it('prefers the toolCallId, falls back to a message hash', () => {
    expect(elicitationDraftKey('tc-1', 'hello')).toBe('tc-1')
    expect(elicitationDraftKey(undefined, 'hello')).toBe(elicitationDraftKey(null, 'hello'))
    expect(elicitationDraftKey(undefined, 'hello')).not.toBe(elicitationDraftKey(undefined, 'bye'))
  })
})

describe('ElicitationCard — url mode', () => {
  interface UrlHarness extends Harness {
    opener: { open: ReturnType<typeof vi.fn> }
    urlState: ISettableObservable<AcpUrlElicitationState>
    dismissed: boolean
  }

  function makeUrlPending(): UrlHarness {
    const harness = {
      resolved: [] as CreateElicitationResponse[],
      cancelled: false,
      dismissed: false,
      opener: { open: vi.fn().mockResolvedValue(true) },
      urlState: observableValue<AcpUrlElicitationState>('test.urlState', 'consent'),
    } as UrlHarness
    harness.pending = {
      request: {
        sessionId: 'agent-1',
        mode: 'url',
        message: 'Authorize the thing',
        url: 'https://auth.example.com/flow?token=abc',
        elicitationId: 'el-1',
      } as CreateElicitationRequest,
      urlState: harness.urlState,
      resolve: (result) => {
        harness.resolved.push(result)
        if (result.action === 'accept') harness.urlState.set('waiting', undefined)
      },
      cancel: () => {
        harness.cancelled = true
      },
      dismiss: () => {
        harness.dismissed = true
      },
    }
    return harness
  }

  function renderUrlCard(session: IAcpSession, opener: UrlHarness['opener']) {
    const services = new ServiceCollection()
    services.set(IOpenerService, { _serviceBrand: undefined, open: opener.open } as never)
    return (
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <ElicitationCard key={`elicitation:${session.id}`} session={session} />
      </ServicesContext.Provider>
    )
  }

  it('renders the consent card with the full URL and a highlighted domain', () => {
    const h = makeUrlPending()
    render(renderUrlCard(makeSession('A', h.pending), h.opener))

    const url = screen.getByTestId('acp-elicitation-url')
    expect(url.textContent).toBe('https://auth.example.com/flow?token=abc')
    expect(url.querySelector('strong')?.textContent).toBe('auth.example.com')
    expect(h.opener.open).not.toHaveBeenCalled()
  })

  it('confirm opens the link via the opener and settles accept', () => {
    const h = makeUrlPending()
    render(renderUrlCard(makeSession('A', h.pending), h.opener))

    fireEvent.click(screen.getByTestId('acp-elicitation-url-open'))
    expect(h.opener.open).toHaveBeenCalledWith('https://auth.example.com/flow?token=abc')
    expect(h.resolved).toEqual([{ action: 'accept' }])
    // accept → the card flips to the waiting state.
    expect(screen.getByTestId('acp-elicitation-url-waiting')).toBeTruthy()
  })

  it('done state renders after the urlState flips', () => {
    const h = makeUrlPending()
    h.urlState.set('waiting', undefined)
    const { rerender } = render(renderUrlCard(makeSession('A', h.pending), h.opener))
    expect(screen.getByTestId('acp-elicitation-url-waiting')).toBeTruthy()

    h.urlState.set('done', undefined)
    rerender(renderUrlCard(makeSession('A', h.pending), h.opener))
    expect(screen.getByTestId('acp-elicitation-url-done')).toBeTruthy()
  })

  it('decline settles decline; close in consent cancels; close while waiting dismisses', () => {
    const h = makeUrlPending()
    const { unmount } = render(renderUrlCard(makeSession('A', h.pending), h.opener))

    fireEvent.click(screen.getByTestId('acp-elicitation-decline'))
    expect(h.resolved).toEqual([{ action: 'decline' }])
    expect(h.opener.open).not.toHaveBeenCalled()
    unmount()

    const h2 = makeUrlPending()
    const { unmount: unmount2 } = render(renderUrlCard(makeSession('A', h2.pending), h2.opener))
    fireEvent.click(screen.getByTestId('acp-elicitation-close'))
    expect(h2.cancelled).toBe(true)
    unmount2()

    const h3 = makeUrlPending()
    h3.urlState.set('waiting', undefined)
    render(renderUrlCard(makeSession('A', h3.pending), h3.opener))
    fireEvent.click(screen.getByTestId('acp-elicitation-close'))
    expect(h3.dismissed).toBe(true)
    expect(h3.cancelled).toBe(false)
  })
})
