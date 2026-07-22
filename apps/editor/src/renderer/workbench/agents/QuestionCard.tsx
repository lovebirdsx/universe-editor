/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  QuestionCard — renders the active session's pending `AskUserQuestion`
 *  carousel inline above the prompt input. Supports multiple questions, single
 *  / multi-select, per-option descriptions, side-by-side preview, free-form
 *  "Other" input and per-question notes. Multi-session friendly: a card on one
 *  session never blocks another.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type {
  AskUserQuestion,
  AskUserQuestionResult,
  IAcpSession,
} from '../../services/acp/acpSessionService.js'
import {
  AcpQuestionDraftCache,
  emptyQuestionDraft as emptyDraft,
  type QuestionDraft,
} from '../../services/acp/acpQuestionDraftCache.js'
import styles from './agents.module.css'

// Restore the saved drafts for a (session, question) pair, cloning each Set so a
// restored draft never shares its mutable `selected` with the cached snapshot.
// Falls back to one empty draft per question when nothing is cached.
function loadDrafts(
  sessionId: string,
  toolCallId: string,
  questions: readonly AskUserQuestion[],
): QuestionDraft[] {
  const saved = AcpQuestionDraftCache.load(sessionId, toolCallId)
  if (saved && saved.length === questions.length) {
    return saved.map((d) => ({ ...d, selected: new Set(d.selected) }))
  }
  return questions.map(() => emptyDraft())
}

function isAnswered(q: AskUserQuestion, d: QuestionDraft): boolean {
  if (d.otherChecked) return d.otherText.trim().length > 0
  return d.selected.size > 0
}

/** Comma-joined answer string for one question (selected labels + free-form text). */
function answerOf(d: QuestionDraft): string {
  const parts = [...d.selected]
  if (d.otherChecked && d.otherText.trim().length > 0) parts.push(d.otherText.trim())
  return parts.join(', ')
}

export function QuestionCard({ session }: { session: IAcpSession }) {
  const pending = useObservable(session.pendingQuestion)
  const key = pending?.toolCallId ?? ''
  const questions = pending?.questions ?? []

  // Reset the drafts whenever a new question carousel arrives. Setting state
  // during render of the same component (keyed by toolCallId) is the canonical
  // "reset state on prop change" pattern — no effect needed. Drafts come from the
  // per-session cache so switching tabs / sessions and coming back restores them.
  const [stateKey, setStateKey] = useState(key)
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    loadDrafts(session.id, key, questions),
  )
  if (key !== stateKey) {
    setStateKey(key)
    setDrafts(loadDrafts(session.id, key, questions))
  }

  // Persist the in-progress answers per (session, question) so switching tabs /
  // sessions and coming back restores them (mirrors AcpPromptDraftCache).
  useEffect(() => {
    if (pending) AcpQuestionDraftCache.save(session.id, key, drafts)
  }, [drafts, session.id, key, pending])

  if (!pending) return null

  const patch = (qi: number, next: Partial<QuestionDraft>): void => {
    setDrafts((prev) => prev.map((d, i) => (i === qi ? { ...d, ...next } : d)))
  }

  const toggleOption = (qi: number, q: AskUserQuestion, label: string): void => {
    const d = drafts[qi] ?? emptyDraft()
    if (q.multiSelect) {
      const selected = new Set(d.selected)
      if (selected.has(label)) selected.delete(label)
      else selected.add(label)
      patch(qi, { selected, previewLabel: label })
    } else {
      patch(qi, { selected: new Set([label]), otherChecked: false, previewLabel: label })
    }
  }

  const allAnswered = questions.every((q, i) => isAnswered(q, drafts[i] ?? emptyDraft()))

  const submit = (): void => {
    const answers: Record<string, string> = {}
    const annotations: Record<string, { preview?: string; notes?: string }> = {}
    questions.forEach((q, i) => {
      const d = drafts[i] ?? emptyDraft()
      const value = answerOf(d)
      if (value.length > 0) answers[q.question] = value
      const ann: { preview?: string; notes?: string } = {}
      const previewOpt = q.options.find((o) => d.selected.has(o.label) && o.preview)
      if (previewOpt?.preview) ann.preview = previewOpt.preview
      if (d.notes.trim().length > 0) ann.notes = d.notes.trim()
      if (ann.preview || ann.notes) annotations[q.question] = ann
    })
    const result: AskUserQuestionResult =
      Object.keys(annotations).length > 0 ? { answers, annotations } : { answers }
    AcpQuestionDraftCache.clear(session.id, key)
    pending.resolve(result)
  }

  return (
    <section className={styles['questionCard']} data-testid="acp-question-card">
      {questions.map((q, qi) => {
        const d = drafts[qi] ?? emptyDraft()
        const hasPreview = q.options.some((o) => o.preview)
        const previewText =
          (d.previewLabel != null
            ? q.options.find((o) => o.label === d.previewLabel)?.preview
            : undefined) ?? ''
        return (
          <div className={styles['questionBlock']} key={qi} data-testid={`acp-question-${qi}`}>
            <header className={styles['questionHeader']}>
              {q.header && <span className={styles['questionChip']}>{q.header}</span>}
              <span className={styles['questionText']}>{q.question}</span>
            </header>
            <div className={hasPreview ? styles['questionSplit'] : undefined}>
              <ul className={styles['questionOptions']}>
                {q.options.map((o) => {
                  const checked = d.selected.has(o.label)
                  const chipClass = checked
                    ? `${styles['questionOptionChip']} ${styles['questionOptionChipActive']}`
                    : styles['questionOptionChip']
                  return (
                    <li key={o.label}>
                      <label
                        className={chipClass}
                        {...(o.description ? { title: o.description } : {})}
                        onMouseEnter={
                          hasPreview ? () => patch(qi, { previewLabel: o.label }) : undefined
                        }
                      >
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={`acp-q-${qi}`}
                          className={styles['questionChipInput']}
                          checked={checked}
                          onChange={() => toggleOption(qi, q, o.label)}
                          data-testid={`acp-question-${qi}-option-${o.label}`}
                        />
                        <span className={styles['questionOptionLabel']}>{o.label}</span>
                      </label>
                    </li>
                  )
                })}
                <li>
                  <label
                    className={
                      d.otherChecked
                        ? `${styles['questionOptionChip']} ${styles['questionOptionChipActive']}`
                        : styles['questionOptionChip']
                    }
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`acp-q-${qi}`}
                      className={styles['questionChipInput']}
                      checked={d.otherChecked}
                      onChange={() =>
                        patch(qi, {
                          otherChecked: !d.otherChecked,
                          ...(q.multiSelect ? {} : { selected: new Set() }),
                        })
                      }
                    />
                    <span className={styles['questionOptionLabel']}>
                      {localize('acp.question.other', 'Other…')}
                    </span>
                  </label>
                </li>
              </ul>
              {hasPreview && (
                <pre
                  className={styles['questionPreview']}
                  data-testid={`acp-question-${qi}-preview`}
                >
                  {previewText}
                </pre>
              )}
            </div>
            {d.otherChecked && (
              <input
                type="text"
                className={styles['questionFreeform']}
                value={d.otherText}
                spellCheck={false}
                placeholder={localize('acp.question.answer.placeholder', 'Type your answer')}
                onChange={(e) => patch(qi, { otherText: e.target.value })}
                data-testid={`acp-question-${qi}-other`}
              />
            )}
            <textarea
              className={styles['questionNotes']}
              value={d.notes}
              spellCheck={false}
              placeholder={localize('acp.question.notes.placeholder', 'Notes (optional)')}
              rows={1}
              onChange={(e) => patch(qi, { notes: e.target.value })}
              data-testid={`acp-question-${qi}-notes`}
            />
          </div>
        )
      })}
      <div className={styles['questionActions']}>
        <button
          type="button"
          className={styles['permissionAllow']}
          disabled={!allAnswered}
          onClick={submit}
          data-testid="acp-question-submit"
        >
          {localize('acp.question.submit', 'Submit')}
        </button>
        <button
          type="button"
          className={styles['permissionDeny']}
          onClick={() => {
            AcpQuestionDraftCache.clear(session.id, key)
            pending.cancel()
          }}
          data-testid="acp-question-dismiss"
        >
          {localize('acp.question.dismiss', 'Dismiss')}
        </button>
      </div>
    </section>
  )
}
