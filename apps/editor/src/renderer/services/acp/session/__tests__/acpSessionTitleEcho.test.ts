/*---------------------------------------------------------------------------------------------
 *  Tests for acpSessionTitleEcho — the prompt-echo detector that stops agent
 *  `lastPrompt` fallback titles from overwriting local ones.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isPromptEchoTitle, normalizeTitleForEcho } from '../acpSessionTitleEcho.js'

describe('normalizeTitleForEcho', () => {
  it('collapses whitespace runs to single spaces and trims', () => {
    expect(normalizeTitleForEcho(' \t fix \n\n the\tbug \r\n ')).toBe('fix the bug')
  })

  it('is idempotent', () => {
    const once = normalizeTitleForEcho('\t long   title\n with  gaps ')
    expect(normalizeTitleForEcho(once)).toBe(once)
  })

  it('keeps CJK text intact', () => {
    expect(normalizeTitleForEcho('修复  登录\n页面的 bug')).toBe('修复 登录 页面的 bug')
  })

  it('returns an empty string for empty or whitespace-only input', () => {
    expect(normalizeTitleForEcho('')).toBe('')
    expect(normalizeTitleForEcho('   \t\n ')).toBe('')
  })
})

describe('isPromptEchoTitle', () => {
  it('matches an exact echo', () => {
    expect(isPromptEchoTitle('Refactor auth module', ['Refactor auth module'])).toBe(true)
  })

  it('matches when only the whitespace shape differs', () => {
    expect(isPromptEchoTitle('fix the bug', ['fix\nthe   bug'])).toBe(true)
  })

  it('matches a claude-style 255-char truncation', () => {
    const prompt = 'x'.repeat(300)
    expect(isPromptEchoTitle(prompt.slice(0, 255) + '…', [prompt])).toBe(true)
  })

  it('matches an SDK-style 200-char truncation', () => {
    const prompt = 'y'.repeat(250)
    expect(isPromptEchoTitle(prompt.slice(0, 200) + '…', [prompt])).toBe(true)
  })

  it('matches a truncation of a multi-line prompt', () => {
    const prompt = 'word\n'.repeat(130)
    const normalized = normalizeTitleForEcho(prompt)
    expect(isPromptEchoTitle(normalized.slice(0, 255) + '…', [prompt])).toBe(true)
  })

  it('does not match an unrelated title', () => {
    expect(isPromptEchoTitle('Refactor auth module', ['write e2e tests'])).toBe(false)
  })

  it('returns false for an empty candidate set', () => {
    expect(isPromptEchoTitle('anything', [])).toBe(false)
  })

  it('returns false for an empty or whitespace-only title', () => {
    expect(isPromptEchoTitle('', [''])).toBe(false)
    expect(isPromptEchoTitle('   ', ['  '])).toBe(false)
  })

  it('does not match a bare ellipsis title', () => {
    expect(isPromptEchoTitle('…', ['anything'])).toBe(false)
  })

  it('matches when any of several candidates is an echo', () => {
    expect(isPromptEchoTitle('fix the bug', ['unrelated', 'fix the bug'])).toBe(true)
  })
})
