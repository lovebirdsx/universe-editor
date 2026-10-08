/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/sideTaskConfig.ts
 *
 *  Focus: per-agent resolution against a live bag (both claude- and
 *  codex-shaped), the silent no-entry path, invalid / unoffered pins falling
 *  back to the parent model with a warning, and settings-map sanitization.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import {
  buildSideTaskModelOverrides,
  readSideTaskModels,
  SIDE_TASK_MODELS_KEY,
} from '../sideTaskConfig.js'

function selectOpt(
  id: string,
  category: 'model' | 'thought_level' | 'mode',
  values: string[],
  currentValue: string,
): SessionConfigOption {
  return {
    id,
    type: 'select',
    name: id,
    category,
    currentValue,
    options: values.map((v) => ({ value: v, name: v.toUpperCase() })),
  }
}

const claudeBag: readonly SessionConfigOption[] = [
  selectOpt('model', 'model', ['sonnet', 'opus'], 'opus'),
  selectOpt('effort', 'thought_level', ['low', 'high', 'max'], 'high'),
  selectOpt('mode', 'mode', ['default', 'plan'], 'default'),
]

describe('buildSideTaskModelOverrides', () => {
  it('resolves the pin to the category option id, with its label', () => {
    const warn = vi.fn()
    const out = buildSideTaskModelOverrides(
      claudeBag,
      'claude-code',
      { 'claude-code': 'sonnet' },
      warn,
    )
    expect(out.values).toEqual({ model: 'sonnet' })
    expect(out.labels).toEqual({ model: 'SONNET' })
    expect(out.model).toEqual({ configId: 'model', value: 'sonnet' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('resolves a codex-shaped bag by category, not by hardcoded id', () => {
    const codexBag: readonly SessionConfigOption[] = [
      selectOpt('model', 'model', ['gpt-5', 'gpt-5-codex'], 'gpt-5'),
      selectOpt('reasoning_effort', 'thought_level', ['low', 'high'], 'medium'),
    ]
    const warn = vi.fn()
    const out = buildSideTaskModelOverrides(codexBag, 'codex', { codex: 'gpt-5-codex' }, warn)
    expect(out.values).toEqual({ model: 'gpt-5-codex' })
    expect(out.labels).toEqual({ model: 'GPT-5-CODEX' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('no entry for this agent produces no override and no warning', () => {
    const warn = vi.fn()
    const out = buildSideTaskModelOverrides(claudeBag, 'claude-code', { codex: 'gpt-5' }, warn)
    expect(out).toEqual({ values: {}, labels: {} })
    expect(out.model).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  it('a value the agent does not offer is skipped with a warning', () => {
    const warn = vi.fn()
    const out = buildSideTaskModelOverrides(
      claudeBag,
      'claude-code',
      { 'claude-code': 'haiku' },
      warn,
    )
    expect(out).toEqual({ values: {}, labels: {} })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('haiku')
  })

  it('an agent without a model option is skipped with a warning', () => {
    const noModelBag = claudeBag.filter((o) => o.category !== 'model')
    const warn = vi.fn()
    const out = buildSideTaskModelOverrides(
      noModelBag,
      'claude-code',
      { 'claude-code': 'sonnet' },
      warn,
    )
    expect(out).toEqual({ values: {}, labels: {} })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('never touches other categories (effort / mode stay inherited)', () => {
    const warn = vi.fn()
    const out = buildSideTaskModelOverrides(
      claudeBag,
      'claude-code',
      { 'claude-code': 'sonnet' },
      warn,
    )
    expect(Object.keys(out.values)).toEqual(['model'])
  })

  it('grouped model candidates are searched too', () => {
    const grouped: SessionConfigOption = {
      id: 'model',
      type: 'select',
      name: 'model',
      category: 'model',
      currentValue: 'a',
      options: [
        { group: 'g1', name: 'G1', options: [{ value: 'x', name: 'X' }] },
        { group: 'g2', name: 'G2', options: [{ value: 'y', name: 'Y' }] },
      ],
    }
    const warn = vi.fn()
    const out = buildSideTaskModelOverrides([grouped], 'claude-code', { 'claude-code': 'y' }, warn)
    expect(out.values).toEqual({ model: 'y' })
    expect(out.labels).toEqual({ model: 'Y' })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('readSideTaskModels', () => {
  const withValue = (value: unknown) => ({
    get: (key: string): unknown => (key === SIDE_TASK_MODELS_KEY ? value : undefined),
  })

  it('reads the per-agent map, trimming values', () => {
    const config = withValue({ 'claude-code': ' haiku ', codex: 'gpt-5-codex' })
    expect(readSideTaskModels(config as never)).toEqual({
      'claude-code': 'haiku',
      codex: 'gpt-5-codex',
    })
  })

  it('unset / non-object / array values yield an empty map', () => {
    for (const value of [undefined, null, 'haiku', ['haiku'], 42]) {
      expect(readSideTaskModels(withValue(value) as never)).toEqual({})
    }
  })

  it('drops non-string and blank entries instead of failing the fork', () => {
    const config = withValue({ 'claude-code': 'haiku', codex: 7, other: '   ', '': 'x' })
    expect(readSideTaskModels(config as never)).toEqual({ 'claude-code': 'haiku', '': 'x' })
  })
})
