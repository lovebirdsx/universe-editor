/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for QuestionCard — verifies that in-progress answers survive switching
 *  sessions (the card is keyed per session and remounts), backed by the
 *  AcpQuestionDraftCache, and that they are cleared on submit / dismiss / close.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { observableValue } from '@universe-editor/platform'
import type { AcpPendingQuestion, IAcpSession } from '../../../services/acp/acpSessionService.js'
import {
  AcpQuestionDraftCache,
  emptyQuestionDraft,
} from '../../../services/acp/acpQuestionDraftCache.js'
import { QuestionCard } from '../QuestionCard.js'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  AcpQuestionDraftCache._resetForTests()
})

function pendingQuestion(toolCallId: string): AcpPendingQuestion {
  return {
    toolCallId,
    questions: [
      {
        question: 'Pick a fruit',
        header: 'Fruit',
        multiSelect: false,
        options: [
          { label: 'Apple', description: 'a' },
          { label: 'Banana', description: 'b' },
        ],
      },
    ],
    resolve: () => {},
    cancel: () => {},
  }
}

function makeSession(id: string, pending: AcpPendingQuestion | undefined): IAcpSession {
  return {
    id,
    pendingQuestion: observableValue<AcpPendingQuestion | undefined>(`pq:${id}`, pending),
  } as unknown as IAcpSession
}

// Mirrors ChatBody: the card is keyed by session so switching remounts it.
function renderCard(session: IAcpSession) {
  return <QuestionCard key={`question:${session.id}`} session={session} />
}

describe('QuestionCard draft persistence', () => {
  it('restores answers after switching to another session and back', () => {
    const sessionA = makeSession('A', pendingQuestion('t1'))
    const { rerender } = render(renderCard(sessionA))

    fireEvent.click(screen.getByTestId('acp-question-0-option-Banana'))
    fireEvent.change(screen.getByTestId('acp-question-0-notes'), {
      target: { value: 'my note' },
    })
    expect((screen.getByTestId('acp-question-0-option-Banana') as HTMLInputElement).checked).toBe(
      true,
    )

    // Switch to session B (different key → A unmounts, B mounts).
    const sessionB = makeSession('B', pendingQuestion('t2'))
    rerender(renderCard(sessionB))
    expect((screen.getByTestId('acp-question-0-option-Banana') as HTMLInputElement).checked).toBe(
      false,
    )

    // Switch back to A — answers must be restored from the cache.
    rerender(renderCard(makeSession('A', pendingQuestion('t1'))))
    expect((screen.getByTestId('acp-question-0-option-Banana') as HTMLInputElement).checked).toBe(
      true,
    )
    expect((screen.getByTestId('acp-question-0-notes') as HTMLTextAreaElement).value).toBe(
      'my note',
    )
  })

  it('clears the draft on submit so a following question starts empty', () => {
    const session = makeSession('A', pendingQuestion('t1'))
    const { rerender } = render(renderCard(session))

    fireEvent.click(screen.getByTestId('acp-question-0-option-Apple'))
    fireEvent.click(screen.getByTestId('acp-question-submit'))
    expect(AcpQuestionDraftCache.load('A', 't1')).toBeUndefined()

    // A following question (new toolCallId) in the same session starts fresh.
    rerender(renderCard(makeSession('A', pendingQuestion('t-next'))))
    expect((screen.getByTestId('acp-question-0-option-Apple') as HTMLInputElement).checked).toBe(
      false,
    )
  })

  it('clears the draft on dismiss', () => {
    const session = makeSession('A', pendingQuestion('t1'))
    render(renderCard(session))

    fireEvent.click(screen.getByTestId('acp-question-0-option-Apple'))
    expect(AcpQuestionDraftCache.load('A', 't1')).toBeDefined()
    fireEvent.click(screen.getByTestId('acp-question-dismiss'))
    expect(AcpQuestionDraftCache.load('A', 't1')).toBeUndefined()
  })
})

describe('AcpQuestionDraftCache', () => {
  it('isolates entries by (sessionId, toolCallId)', () => {
    const a1 = [{ ...emptyQuestionDraft(), notes: 'a1' }]
    const a2 = [{ ...emptyQuestionDraft(), notes: 'a2' }]
    const b1 = [{ ...emptyQuestionDraft(), notes: 'b1' }]
    AcpQuestionDraftCache.save('A', 't1', a1)
    AcpQuestionDraftCache.save('A', 't2', a2)
    AcpQuestionDraftCache.save('B', 't1', b1)

    expect(AcpQuestionDraftCache.load('A', 't1')).toBe(a1)
    expect(AcpQuestionDraftCache.load('A', 't2')).toBe(a2)
    expect(AcpQuestionDraftCache.load('B', 't1')).toBe(b1)

    AcpQuestionDraftCache.clear('A', 't1')
    expect(AcpQuestionDraftCache.load('A', 't1')).toBeUndefined()
    expect(AcpQuestionDraftCache.load('A', 't2')).toBe(a2)
  })

  it('clearSession drops every toolCall entry for that session only', () => {
    AcpQuestionDraftCache.save('A', 't1', [emptyQuestionDraft()])
    AcpQuestionDraftCache.save('A', 't2', [emptyQuestionDraft()])
    AcpQuestionDraftCache.save('B', 't1', [emptyQuestionDraft()])

    AcpQuestionDraftCache.clearSession('A')
    expect(AcpQuestionDraftCache.load('A', 't1')).toBeUndefined()
    expect(AcpQuestionDraftCache.load('A', 't2')).toBeUndefined()
    expect(AcpQuestionDraftCache.load('B', 't1')).toBeDefined()
  })
})
