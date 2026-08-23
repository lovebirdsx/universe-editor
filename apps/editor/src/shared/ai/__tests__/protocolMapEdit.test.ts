/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  protocolMapEdit tests — the grammar the UI must not break: three protocol
 *  states, and the string/object duality of a model ref. The normalisation cases
 *  matter most: round-tripping a plain name through the editor must leave the
 *  file unchanged.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiProtocolMap } from '@universe-editor/platform'
import {
  appendModelNames,
  declaredProtocols,
  draftFromRef,
  mergeProbedSelection,
  refFromDraft,
  refKnowledgeKey,
  refWireName,
  removeProtocol,
  setProtocolRefs,
} from '../protocolMapEdit.js'

describe('protocolMapEdit — protocol states', () => {
  it('declares a protocol as discover with an empty array', () => {
    const next = setProtocolRefs(undefined, 'openai-chat', [])
    expect(next).toEqual({ 'openai-chat': [] })
  })

  it('removes the key entirely rather than leaving an empty array behind', () => {
    const map: AiProtocolMap = { 'openai-chat': [], ollama: ['llama3'] }
    expect(removeProtocol(map, 'openai-chat')).toEqual({ ollama: ['llama3'] })
  })

  it('lists declared protocols in a stable order', () => {
    const map: AiProtocolMap = { ollama: [], 'anthropic-messages': [] }
    expect(declaredProtocols(map)).toEqual(['anthropic-messages', 'ollama'])
    expect(declaredProtocols(undefined)).toEqual([])
  })
})

describe('protocolMapEdit — model ref normalisation', () => {
  it('keeps a plain name plain through a full edit round-trip', () => {
    expect(refFromDraft(draftFromRef('gpt-4o'))).toBe('gpt-4o')
  })

  it('collapses an object that says nothing beyond the name', () => {
    expect(refFromDraft(draftFromRef({ id: 'gpt-4o' }))).toBe('gpt-4o')
    expect(refFromDraft(draftFromRef({ ref: 'gpt-4o' }))).toBe('gpt-4o')
    expect(refFromDraft(draftFromRef({ id: 'gpt-4o', ref: 'gpt-4o' }))).toBe('gpt-4o')
  })

  it('keeps the object form when the wire name differs from the knowledge key', () => {
    const out = refFromDraft(draftFromRef({ id: 'claude-3', ref: 'claude-sonnet-4' }))
    expect(out).toEqual({ id: 'claude-3', ref: 'claude-sonnet-4' })
  })

  it('writes capabilities only as false — a narrowing, never a grant', () => {
    const draft = { ...draftFromRef('gpt-4o'), disabled: ['vision'] as const }
    expect(refFromDraft(draft)).toEqual({ id: 'gpt-4o', capabilities: { vision: false } })
  })

  it('preserves knowledge overrides the form does not expose', () => {
    const draft = draftFromRef({ id: 'gpt-4o', maxInputTokens: 42 })
    expect(draft.rest).toEqual({ maxInputTokens: 42 })
    expect(refFromDraft(draft)).toEqual({ maxInputTokens: 42, id: 'gpt-4o' })
  })

  it('returns undefined when the draft names no model', () => {
    expect(refFromDraft({ id: '  ', ref: '', disabled: [], rest: {} })).toBeUndefined()
  })

  it('reads the wire name and knowledge key off either form', () => {
    expect(refWireName('gpt-4o')).toBe('gpt-4o')
    expect(refWireName({ ref: 'gpt-4o' })).toBe('gpt-4o')
    expect(refKnowledgeKey({ id: 'claude-3', ref: 'claude-sonnet-4' })).toBe('claude-sonnet-4')
    expect(refKnowledgeKey({ id: 'claude-3' })).toBe('claude-3')
  })
})

describe('protocolMapEdit — appending probed names', () => {
  it('skips names already declared and returns the same array when nothing is added', () => {
    const refs = ['gpt-4o', { id: 'o3' }]
    expect(appendModelNames(refs, ['gpt-4o', ' ', 'o3'])).toBe(refs)
  })

  it('appends new names in order', () => {
    expect(appendModelNames(['gpt-4o'], ['o3', 'gpt-4o', 'o4-mini'])).toEqual([
      'gpt-4o',
      'o3',
      'o4-mini',
    ])
  })
})

describe('protocolMapEdit — folding a probe selection back in', () => {
  it('keeps the object form of a ref the user re-selected', () => {
    const existing = [{ id: 'house-sonnet', ref: 'claude-sonnet-5' }]
    expect(mergeProbedSelection(existing, ['house-sonnet', 'other'], ['house-sonnet'])).toEqual([
      { id: 'house-sonnet', ref: 'claude-sonnet-5' },
    ])
  })

  it('drops an offered ref the user unticked', () => {
    const existing = ['gpt-4o', 'o3']
    expect(mergeProbedSelection(existing, ['gpt-4o', 'o3'], ['o3'])).toEqual(['o3'])
  })

  // The dialog never showed it, so no checkbox state is an answer about it.
  it('keeps a declared ref the endpoint did not offer', () => {
    const existing = ['legacy-model', 'gpt-4o']
    expect(mergeProbedSelection(existing, ['gpt-4o'], ['gpt-4o'])).toEqual([
      'legacy-model',
      'gpt-4o',
    ])
  })

  it('appends newly ticked names after the survivors', () => {
    const existing = [{ id: 'house-sonnet', ref: 'claude-sonnet-5' }, 'legacy-model']
    expect(mergeProbedSelection(existing, ['house-sonnet', 'o3'], ['house-sonnet', 'o3'])).toEqual([
      { id: 'house-sonnet', ref: 'claude-sonnet-5' },
      'legacy-model',
      'o3',
    ])
  })

  it('unticking everything offered leaves only what was never offered', () => {
    expect(mergeProbedSelection(['gpt-4o', 'legacy'], ['gpt-4o'], [])).toEqual(['legacy'])
  })
})
