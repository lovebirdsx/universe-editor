/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for sanitizeTitle — the pure normalizer that turns a model's raw reply
 *  into a clean, single-line session title.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { buildTitlePrompt, sanitizeTitle } from '../acpSessionTitleService.js'

describe('sanitizeTitle', () => {
  it('trims surrounding quotes and backticks', () => {
    expect(sanitizeTitle('"Fix login bug"')).toBe('Fix login bug')
    expect(sanitizeTitle('`refactor parser`')).toBe('refactor parser')
    expect(sanitizeTitle("'Add dark mode'")).toBe('Add dark mode')
  })

  it('keeps only the first non-empty line', () => {
    expect(sanitizeTitle('\n\nAdd caching layer\n(more text)')).toBe('Add caching layer')
  })

  it('drops a leading Title: label (any case, ascii or fullwidth colon)', () => {
    expect(sanitizeTitle('Title: Implement search')).toBe('Implement search')
    expect(sanitizeTitle('title：实现搜索')).toBe('实现搜索')
  })

  it('drops trailing sentence punctuation', () => {
    expect(sanitizeTitle('Set up CI pipeline.')).toBe('Set up CI pipeline')
    expect(sanitizeTitle('修复崩溃！')).toBe('修复崩溃')
  })

  it('collapses internal whitespace', () => {
    expect(sanitizeTitle('Fix    the   bug')).toBe('Fix the bug')
  })

  it('truncates over-long titles with an ellipsis', () => {
    const long = 'a'.repeat(100)
    const out = sanitizeTitle(long)
    expect(out.length).toBe(60)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns an empty string for blank input', () => {
    expect(sanitizeTitle('   \n  ')).toBe('')
  })
})

describe('buildTitlePrompt', () => {
  it('omits the excerpt section when no quote is provided', () => {
    const prompt = buildTitlePrompt('how do I fix login?', '')
    expect(prompt).toBe('User message:\nhow do I fix login?\n\nTitle:')
  })

  it('includes the assistant reply when present', () => {
    const prompt = buildTitlePrompt('how do I fix login?', 'check the auth token')
    expect(prompt).toBe(
      'User message:\nhow do I fix login?\n\nAssistant reply:\ncheck the auth token\n\nTitle:',
    )
  })

  it('leads with the excerpt when a side-task quote is provided', () => {
    const prompt = buildTitlePrompt('why does this jump?', '', 'const x = scrollTop')
    expect(prompt).toBe(
      'Excerpt the user pulled aside to discuss:\nconst x = scrollTop\n\nUser message:\nwhy does this jump?\n\nTitle:',
    )
  })
})
