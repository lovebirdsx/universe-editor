/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpQuestionDraftCache — in-memory store for the unsubmitted QuestionCard
 *  answers (per AskUserQuestion carousel), keyed by (sessionId, toolCallId).
 *  Mirrors AcpPromptDraftCache so switching editor tabs or sessions and coming
 *  back restores the in-progress answers instead of clearing them. The toolCallId
 *  half of the key separates successive questions that arrive within one session.
 *--------------------------------------------------------------------------------------------*/

export interface QuestionDraft {
  /** Selected option labels (single-select keeps at most one). */
  readonly selected: Set<string>
  /** Whether the free-form "Other" choice is active. */
  readonly otherChecked: boolean
  readonly otherText: string
  readonly notes: string
  /** Label whose preview is currently shown in the side panel. */
  readonly previewLabel: string | null
}

export function emptyQuestionDraft(): QuestionDraft {
  return { selected: new Set(), otherChecked: false, otherText: '', notes: '', previewLabel: null }
}

class AcpQuestionDraftCacheImpl {
  private readonly _map = new Map<string, readonly QuestionDraft[]>()

  private key(sessionId: string, toolCallId: string): string {
    return `${sessionId} ${toolCallId}`
  }

  save(sessionId: string, toolCallId: string, drafts: readonly QuestionDraft[]): void {
    this._map.set(this.key(sessionId, toolCallId), drafts)
  }

  load(sessionId: string, toolCallId: string): readonly QuestionDraft[] | undefined {
    return this._map.get(this.key(sessionId, toolCallId))
  }

  clear(sessionId: string, toolCallId: string): void {
    this._map.delete(this.key(sessionId, toolCallId))
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId} `
    for (const k of this._map.keys()) {
      if (k.startsWith(prefix)) this._map.delete(k)
    }
  }

  _resetForTests(): void {
    this._map.clear()
  }
}

export const AcpQuestionDraftCache = new AcpQuestionDraftCacheImpl()
