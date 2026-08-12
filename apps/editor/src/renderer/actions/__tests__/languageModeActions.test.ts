/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/actions/languageModeActions.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IQuickPickSeparator } from '@universe-editor/platform'
import { buildLanguagePickItems } from '../languageModeActions.js'

const LANGUAGES = [
  { id: 'typescript', aliases: ['TypeScript'] },
  { id: 'json', aliases: ['JSON'] },
  { id: 'plaintext' },
  { id: 'dotenv' },
  { id: 'csharp', aliases: ['C#'] },
]

describe('buildLanguagePickItems', () => {
  it('puts Auto Detect first, then a separator, then sorted languages', () => {
    const items = buildLanguagePickItems(LANGUAGES, 'json')
    expect(items[0]).toMatchObject({ id: '$auto$', label: 'Auto Detect' })
    expect((items[1] as IQuickPickSeparator).type).toBe('separator')
    const labels = items.slice(2).map((i) => ('label' in i ? i.label : ''))
    expect(labels).toEqual(['C#', 'Dotenv', 'JSON', 'Plain Text', 'TypeScript'])
  })

  it('marks the current language as configured in its description', () => {
    const items = buildLanguagePickItems(LANGUAGES, 'json')
    const json = items.find((i) => i.id === 'json')
    expect(json && 'description' in json && json.description).toBe('json — Configured Language')
    const ts = items.find((i) => i.id === 'typescript')
    expect(ts && 'description' in ts && ts.description).toBe('typescript')
  })

  it('dedupes repeated language ids', () => {
    const items = buildLanguagePickItems(
      [...LANGUAGES, { id: 'json', aliases: ['JSON Duplicate'] }],
      'plaintext',
    )
    expect(items.filter((i) => i.id === 'json')).toHaveLength(1)
  })
})
