import { MAX_SIDE_TASK_QUOTE_LENGTH } from '@universe-editor/mobile-protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetComposerPrefillForTests,
  clipSideTaskQuote,
  depositComposerPrefill,
  sideTaskQuoteText,
  takeComposerPrefill,
} from '../composerPrefill.js'

describe('composer prefill', () => {
  beforeEach(() => {
    _resetComposerPrefillForTests()
  })

  it('hands a deposited value over exactly once', () => {
    depositComposerPrefill('durable-1', 'original prompt')
    expect(takeComposerPrefill('durable-1')).toBe('original prompt')
    expect(takeComposerPrefill('durable-1')).toBeUndefined()
  })

  it('keys prefill by session and ignores empty text', () => {
    depositComposerPrefill('a', 'first')
    depositComposerPrefill('b', 'second')
    depositComposerPrefill('c', '')
    expect(takeComposerPrefill('b')).toBe('second')
    expect(takeComposerPrefill('a')).toBe('first')
    expect(takeComposerPrefill('c')).toBeUndefined()
  })
})

describe('side-task quote text', () => {
  it('trims and clips overlong quotes', () => {
    expect(clipSideTaskQuote('  hello  ')).toBe('hello')
    const long = 'x'.repeat(MAX_SIDE_TASK_QUOTE_LENGTH + 10)
    const clipped = clipSideTaskQuote(long)
    expect(clipped).toHaveLength(MAX_SIDE_TASK_QUOTE_LENGTH)
    expect(clipped.endsWith('…')).toBe(true)
  })

  it('renders a markdown blockquote with a trailing blank line', () => {
    expect(sideTaskQuoteText('line one\n\nline two')).toBe('> line one\n>\n> line two\n\n')
    expect(sideTaskQuoteText('   ')).toBe('')
  })
})
