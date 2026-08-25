/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  modelKnowledgeEdit tests — the editing rules for one knowledge entry: the
 *  always-complete capabilities object, reasoning-effort parsing, the parameters
 *  JSON shape, and knowledge-key naming.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiModelCapabilities } from '@universe-editor/platform'

import {
  formatReasoningEffort,
  isValidKnowledgeKey,
  nextCopyKey,
  parseReasoningEffort,
  toggledCapabilities,
  validateParametersSchema,
} from '../modelKnowledgeEdit.js'

describe('modelKnowledgeEdit — capabilities toggling', () => {
  it('materializes the registry default with all four flags present', () => {
    expect(toggledCapabilities(undefined, 'vision', false)).toEqual({
      streaming: true,
      vision: false,
      promptCaching: false,
      toolCalling: false,
    })
  })

  it('keeps untouched flags from the effective capabilities', () => {
    expect(toggledCapabilities({ streaming: true, vision: true }, 'streaming', false)).toEqual({
      streaming: false,
      vision: true,
      promptCaching: false,
      toolCalling: false,
    })
  })

  it('turns on a flag the effective capabilities never declared', () => {
    expect(toggledCapabilities({ streaming: true }, 'toolCalling', true)).toEqual({
      streaming: true,
      vision: false,
      promptCaching: false,
      toolCalling: true,
    })
  })

  it('returns a complete object, never undefined, even with every flag off', () => {
    let caps: AiModelCapabilities = {
      streaming: true,
      vision: true,
      promptCaching: true,
      toolCalling: true,
    }
    for (const key of ['streaming', 'vision', 'promptCaching', 'toolCalling'] as const) {
      caps = toggledCapabilities(caps, key, false)
    }
    expect(caps).toEqual({
      streaming: false,
      vision: false,
      promptCaching: false,
      toolCalling: false,
    })
  })
})

describe('modelKnowledgeEdit — reasoning effort levels', () => {
  it('parses trimmed, deduped levels in order', () => {
    expect(parseReasoningEffort('low, high, low')).toEqual(['low', 'high'])
  })

  it('drops blanks and trims around commas', () => {
    expect(parseReasoningEffort('')).toEqual([])
    expect(parseReasoningEffort('  ')).toEqual([])
    expect(parseReasoningEffort(' low , , high ')).toEqual(['low', 'high'])
  })

  it('formats levels back into a comma-joined string', () => {
    expect(formatReasoningEffort(['low', 'high'])).toBe('low, high')
    expect(formatReasoningEffort([])).toBe('')
    expect(formatReasoningEffort(undefined)).toBe('')
  })
})

describe('modelKnowledgeEdit — parameters schema validation', () => {
  it('accepts a well-formed schema and passes unknown fields through', () => {
    const result = validateParametersSchema(
      '{"temperature":{"type":"number","default":0.7,"vendorHint":"x"},"effort":{"type":"enum","enum":["low","high"]}}',
    )
    expect(result).toEqual({
      ok: true,
      schema: {
        temperature: { type: 'number', default: 0.7, vendorHint: 'x' },
        effort: { type: 'enum', enum: ['low', 'high'] },
      },
    })
  })

  it('accepts defaults that match the declared type', () => {
    const result = validateParametersSchema(
      '{"seed":{"type":"number","default":0},"reason":{"type":"boolean","default":false},"effort":{"type":"enum","enum":["low"],"default":"low"}}',
    )
    expect(result.ok).toBe(true)
  })

  it('treats empty input as clearing the schema', () => {
    expect(validateParametersSchema('')).toEqual({ ok: true, schema: {} })
    expect(validateParametersSchema('   ')).toEqual({ ok: true, schema: {} })
  })

  it('rejects broken JSON', () => {
    expect(validateParametersSchema('{not json')).toEqual({
      ok: false,
      error: expect.stringContaining('JSON'),
    })
  })

  it('rejects a top-level array', () => {
    expect(validateParametersSchema('[]')).toEqual({
      ok: false,
      error: expect.stringContaining('object'),
    })
  })

  it('rejects a property whose value is not an object, naming the key', () => {
    expect(validateParametersSchema('{"temperature":"hot"}')).toEqual({
      ok: false,
      error: expect.stringContaining('temperature'),
    })
    expect(validateParametersSchema('{"temperature":[]}')).toEqual({
      ok: false,
      error: expect.stringContaining('temperature'),
    })
  })

  it('rejects an invalid type, naming the key', () => {
    expect(validateParametersSchema('{"temperature":{"type":"float"}}')).toEqual({
      ok: false,
      error: expect.stringContaining('temperature'),
    })
  })

  it('rejects a malformed enum list, naming the key', () => {
    expect(validateParametersSchema('{"effort":{"type":"enum","enum":[]}}')).toEqual({
      ok: false,
      error: expect.stringContaining('effort'),
    })
    expect(validateParametersSchema('{"effort":{"type":"enum","enum":[1]}}')).toEqual({
      ok: false,
      error: expect.stringContaining('effort'),
    })
    expect(validateParametersSchema('{"effort":{"type":"enum","enum":"low"}}')).toEqual({
      ok: false,
      error: expect.stringContaining('effort'),
    })
  })

  it('rejects a default whose type does not match, naming the key', () => {
    expect(validateParametersSchema('{"temperature":{"type":"number","default":"hot"}}')).toEqual({
      ok: false,
      error: expect.stringContaining('temperature'),
    })
    expect(validateParametersSchema('{"flag":{"type":"boolean","default":1}}')).toEqual({
      ok: false,
      error: expect.stringContaining('flag'),
    })
    expect(validateParametersSchema('{"effort":{"type":"enum","default":2}}')).toEqual({
      ok: false,
      error: expect.stringContaining('effort'),
    })
  })

  it('reports the first offending key and ignores later ones', () => {
    expect(validateParametersSchema('{"good":{"type":"number"},"bad":{"type":"nope"}}')).toEqual({
      ok: false,
      error: expect.stringContaining('bad'),
    })
  })
})

describe('modelKnowledgeEdit — knowledge key validity', () => {
  it('accepts a plain key', () => {
    expect(isValidKnowledgeKey('kimi-k3')).toBe(true)
  })

  it('rejects empty, slashed, or padded keys', () => {
    expect(isValidKnowledgeKey('')).toBe(false)
    expect(isValidKnowledgeKey('a/b')).toBe(false)
    expect(isValidKnowledgeKey(' a')).toBe(false)
    expect(isValidKnowledgeKey('a ')).toBe(false)
  })
})

describe('modelKnowledgeEdit — copy key naming', () => {
  it('appends -copy when the name is free', () => {
    expect(nextCopyKey('kimi-k3', new Set())).toBe('kimi-k3-copy')
  })

  it('skips a taken copy name', () => {
    expect(nextCopyKey('kimi-k3', new Set(['kimi-k3-copy']))).toBe('kimi-k3-copy-2')
  })

  it('walks past multiple taken names', () => {
    expect(
      nextCopyKey('kimi-k3', new Set(['kimi-k3-copy', 'kimi-k3-copy-2', 'kimi-k3-copy-3'])),
    ).toBe('kimi-k3-copy-4')
  })
})
