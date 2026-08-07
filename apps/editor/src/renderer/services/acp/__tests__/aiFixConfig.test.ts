/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/acp/aiFixConfig.ts
 *
 *  Focus: category → configId resolution against differently-shaped bags
 *  (codex: model/reasoning_effort, claude: model/effort), invalid-value
 *  skipping with a warning, empty-string settings producing no override, and
 *  the empty-bag cold-cache fallback.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { buildAiFixConfigOverrides, readAiFixSettings } from '../aiFixConfig.js'

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
    options: values.map((v) => ({ value: v, name: v })),
  }
}

const codexBag: readonly SessionConfigOption[] = [
  selectOpt('model', 'model', ['gpt-5', 'gpt-5-codex'], 'gpt-5'),
  selectOpt('reasoning_effort', 'thought_level', ['low', 'medium', 'high'], 'medium'),
  selectOpt('mode', 'mode', ['read-only', 'auto'], 'auto'),
]

const claudeBag: readonly SessionConfigOption[] = [
  selectOpt('model', 'model', ['sonnet', 'opus'], 'sonnet'),
  selectOpt('effort', 'thought_level', ['low', 'high', 'max'], 'high'),
  selectOpt('mode', 'mode', ['default', 'plan'], 'default'),
]

describe('buildAiFixConfigOverrides', () => {
  const settings = (over: Partial<Record<'model' | 'thoughtLevel' | 'mode', string>>) => ({
    agentId: 'codex',
    model: '',
    thoughtLevel: '',
    mode: '',
    ...over,
  })

  it('resolves category → configId for a codex-shaped bag', () => {
    const warn = vi.fn()
    const out = buildAiFixConfigOverrides(
      codexBag,
      settings({ model: 'gpt-5-codex', thoughtLevel: 'low', mode: 'auto' }),
      warn,
    )
    expect(out).toEqual({ model: 'gpt-5-codex', reasoning_effort: 'low', mode: 'auto' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('resolves category → configId for a claude-shaped bag (effort, not reasoning_effort)', () => {
    const warn = vi.fn()
    const out = buildAiFixConfigOverrides(
      claudeBag,
      settings({ model: 'opus', thoughtLevel: 'max' }),
      warn,
    )
    expect(out).toEqual({ model: 'opus', effort: 'max' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('skips an unselectable value with a warning, keeping the valid ones', () => {
    const warn = vi.fn()
    const out = buildAiFixConfigOverrides(
      codexBag,
      settings({ model: 'nonexistent', thoughtLevel: 'low' }),
      warn,
    )
    expect(out).toEqual({ reasoning_effort: 'low' })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('empty-string settings produce no override and no warning', () => {
    const warn = vi.fn()
    const out = buildAiFixConfigOverrides(codexBag, settings({}), warn)
    expect(out).toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  it('empty bag yields no overrides plus a single cold-cache warning', () => {
    const warn = vi.fn()
    const out = buildAiFixConfigOverrides(
      [],
      settings({ model: 'gpt-5', thoughtLevel: 'low' }),
      warn,
    )
    expect(out).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a category the agent does not offer is skipped with a warning', () => {
    const noModeBag = codexBag.filter((o) => o.category !== 'mode')
    const warn = vi.fn()
    const out = buildAiFixConfigOverrides(noModeBag, settings({ mode: 'auto' }), warn)
    expect(out).toEqual({})
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('grouped options are searched too (nested candidates)', () => {
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
    const out = buildAiFixConfigOverrides([grouped], settings({ model: 'y' }), warn)
    expect(out).toEqual({ model: 'y' })
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('readAiFixSettings', () => {
  it('reads the four keys with the documented factory defaults', () => {
    const config = {
      get: <T>(key: string): T | undefined => {
        const map: Record<string, string> = {
          'acp.aiFix.agentId': 'codex',
          'acp.aiFix.model': 'gpt-5-codex',
          'acp.aiFix.thoughtLevel': 'low',
          'acp.aiFix.mode': 'auto',
        }
        return map[key] as T | undefined
      },
    }
    expect(readAiFixSettings(config as never)).toEqual({
      agentId: 'codex',
      model: 'gpt-5-codex',
      thoughtLevel: 'low',
      mode: 'auto',
    })
  })

  it('falls back to factory defaults when the keys are unset', () => {
    const config = { get: (): undefined => undefined }
    expect(readAiFixSettings(config as never)).toEqual({
      agentId: 'codex',
      model: '',
      thoughtLevel: 'low',
      mode: '',
    })
  })
})
