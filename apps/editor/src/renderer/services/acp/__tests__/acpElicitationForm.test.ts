/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/acpElicitationForm.ts —
 *  schema normalization into the flat field model, default prefill, and
 *  pre-submit validation. Malformed schemas degrade (skip + warn), never throw.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { ElicitationSchema } from '@agentclientprotocol/sdk'
import {
  defaultElicitationValues,
  normalizeElicitationForm,
  validateElicitationValues,
  type ElicitationEnumField,
  type ElicitationEnumMultiField,
  type ElicitationNumberField,
  type ElicitationStringField,
} from '../acpElicitationForm.js'

describe('normalizeElicitationForm', () => {
  it('normalizes a plain string field with constraints', () => {
    const schema: ElicitationSchema = {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          title: 'Name',
          description: 'Your name',
          minLength: 2,
          maxLength: 10,
          pattern: '^[a-z]+$',
          format: 'email',
          default: 'abc',
        },
      },
      required: ['name'],
    }
    const fields = normalizeElicitationForm(schema)
    expect(fields).toHaveLength(1)
    const f = fields[0] as ElicitationStringField
    expect(f).toMatchObject({
      kind: 'string',
      name: 'name',
      title: 'Name',
      description: 'Your name',
      required: true,
      minLength: 2,
      maxLength: 10,
      pattern: '^[a-z]+$',
      format: 'email',
      default: 'abc',
    })
  })

  it('normalizes number and integer fields', () => {
    const schema: ElicitationSchema = {
      type: 'object',
      properties: {
        ratio: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
        count: { type: 'integer', minimum: 1 },
      },
    }
    const fields = normalizeElicitationForm(schema)
    const ratio = fields[0] as ElicitationNumberField
    const count = fields[1] as ElicitationNumberField
    expect(ratio).toMatchObject({ kind: 'number', integer: false, minimum: 0, maximum: 1 })
    expect(count).toMatchObject({ kind: 'number', integer: true, minimum: 1 })
    expect(count.required).toBe(false)
  })

  it('normalizes boolean fields', () => {
    const fields = normalizeElicitationForm({
      type: 'object',
      properties: { ok: { type: 'boolean', default: true } },
    })
    expect(fields[0]).toMatchObject({ kind: 'boolean', name: 'ok', default: true })
  })

  it('normalizes oneOf string enums with titled options (description + preview)', () => {
    const fields = normalizeElicitationForm({
      type: 'object',
      properties: {
        choice: {
          type: 'string',
          oneOf: [
            { const: 'a', title: 'Option A', description: 'first' },
            {
              const: 'b',
              title: 'Option B',
              _meta: { '_claude/askUserQuestionOption': { preview: 'big preview' } },
            },
          ],
          default: 'a',
        },
      },
    })
    const f = fields[0] as ElicitationEnumField
    expect(f.kind).toBe('enum')
    expect(f.options).toEqual([
      { value: 'a', title: 'Option A', description: 'first' },
      { value: 'b', title: 'Option B', preview: 'big preview' },
    ])
    expect(f.default).toBe('a')
  })

  it('normalizes untitled string enums', () => {
    const fields = normalizeElicitationForm({
      type: 'object',
      properties: { color: { type: 'string', enum: ['red', 'green'] } },
    })
    const f = fields[0] as ElicitationEnumField
    expect(f.options).toEqual([
      { value: 'red', title: 'red' },
      { value: 'green', title: 'green' },
    ])
  })

  it('normalizes array anyOf items as enum-multi', () => {
    const fields = normalizeElicitationForm({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          default: ['x'],
          items: {
            anyOf: [
              { const: 'x', title: 'X' },
              { const: 'y', title: 'Y', description: 'why' },
            ],
          },
        },
      },
    })
    const f = fields[0] as ElicitationEnumMultiField
    expect(f).toMatchObject({ kind: 'enum-multi', minItems: 1, maxItems: 2, default: ['x'] })
    expect(f.options).toHaveLength(2)
  })

  it('normalizes array enum items as enum-multi', () => {
    const fields = normalizeElicitationForm({
      type: 'object',
      properties: { tags: { type: 'array', items: { enum: ['a', 'b'] } } },
    })
    const f = fields[0] as ElicitationEnumMultiField
    expect(f.kind).toBe('enum-multi')
    expect(f.options).toEqual([
      { value: 'a', title: 'a' },
      { value: 'b', title: 'b' },
    ])
  })

  it('folds the AskUserQuestion bridge shape without special-casing', () => {
    // What the claude fork emits for one single-select question + its Other box.
    const fields = normalizeElicitationForm({
      type: 'object',
      properties: {
        question_0: {
          type: 'string',
          title: 'Approach',
          oneOf: [
            { const: 'Yes', title: 'Yes' },
            { const: 'No', title: 'No' },
          ],
        },
        question_0_custom: { type: 'string', title: 'Other' },
      },
    })
    expect(fields.map((f) => f.kind)).toEqual(['enum', 'string'])
    expect(fields.every((f) => !f.required)).toBe(true)
  })

  it('skips unsupported property types with a warn, never throws', () => {
    const onWarn = vi.fn()
    const fields = normalizeElicitationForm(
      {
        type: 'object',
        properties: {
          good: { type: 'string' },
          bad: { type: 'object' },
        },
      } as unknown as ElicitationSchema,
      onWarn,
    )
    expect(fields.map((f) => f.name)).toEqual(['good'])
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('skips array properties without enum/anyOf items with a warn', () => {
    const onWarn = vi.fn()
    const fields = normalizeElicitationForm(
      {
        type: 'object',
        properties: {
          bad: { type: 'array', items: { type: 'string' } as never },
        },
      },
      onWarn,
    )
    expect(fields).toHaveLength(0)
    expect(onWarn).toHaveBeenCalledOnce()
  })

  it('handles a schema with no properties', () => {
    expect(normalizeElicitationForm({ type: 'object' })).toEqual([])
  })
})

describe('defaultElicitationValues', () => {
  it('prefills declared defaults only', () => {
    const fields = normalizeElicitationForm({
      type: 'object',
      properties: {
        a: { type: 'string', default: 'x' },
        b: { type: 'string' },
        c: { type: 'boolean', default: false },
      },
    })
    expect(defaultElicitationValues(fields)).toEqual({ a: 'x', c: false })
  })
})

describe('validateElicitationValues', () => {
  const schema: ElicitationSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 2, maxLength: 5, pattern: '^[a-z]+$' },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      level: { type: 'string', oneOf: [{ const: 'low', title: 'Low' }] },
      tags: { type: 'array', minItems: 1, maxItems: 2, items: { enum: ['x', 'y', 'z'] } },
    },
    required: ['name'],
  }
  const fields = normalizeElicitationForm(schema)

  it('accepts valid values', () => {
    expect(
      validateElicitationValues(fields, { name: 'abc', age: 30, level: 'low', tags: ['x'] }),
    ).toBeNull()
  })

  it('accepts absent optional values', () => {
    expect(validateElicitationValues(fields, { name: 'abc' })).toBeNull()
  })

  it('rejects a missing required value', () => {
    expect(validateElicitationValues(fields, {})).toMatch(/Name/)
    expect(validateElicitationValues(fields, { name: '' })).toMatch(/Name/)
  })

  it('enforces minLength / maxLength / pattern', () => {
    expect(validateElicitationValues(fields, { name: 'a' })).toBeTruthy()
    expect(validateElicitationValues(fields, { name: 'abcdef' })).toBeTruthy()
    expect(validateElicitationValues(fields, { name: 'ABC' })).toBeTruthy()
  })

  it('tolerates an invalid regex pattern (agent bug, not user error)', () => {
    const bad = normalizeElicitationForm({
      type: 'object',
      properties: { p: { type: 'string', pattern: '([' } },
      required: ['p'],
    })
    expect(validateElicitationValues(bad, { p: 'anything' })).toBeNull()
  })

  it('enforces minimum / maximum', () => {
    expect(validateElicitationValues(fields, { name: 'abc', age: -1 })).toBeTruthy()
    expect(validateElicitationValues(fields, { name: 'abc', age: 151 })).toBeTruthy()
  })

  it('enforces enum membership', () => {
    expect(validateElicitationValues(fields, { name: 'abc', level: 'high' })).toBeTruthy()
    expect(validateElicitationValues(fields, { name: 'abc', tags: ['x', 'nope'] })).toBeTruthy()
  })

  it('enforces minItems / maxItems', () => {
    expect(validateElicitationValues(fields, { name: 'abc', tags: [] })).toBeNull() // optional
    expect(validateElicitationValues(fields, { name: 'abc', tags: ['x', 'y', 'z'] })).toBeTruthy()
    const requiredTags = normalizeElicitationForm({
      type: 'object',
      properties: { tags: { type: 'array', minItems: 2, items: { enum: ['x', 'y'] } } },
      required: ['tags'],
    })
    expect(validateElicitationValues(requiredTags, { tags: [] })).toBeTruthy()
    expect(validateElicitationValues(requiredTags, { tags: ['x'] })).toBeTruthy()
    expect(validateElicitationValues(requiredTags, { tags: ['x', 'y'] })).toBeNull()
  })

  it('returns the first error only', () => {
    const msg = validateElicitationValues(fields, { name: '', age: -5 })
    expect(msg).toMatch(/Name/)
  })
})
