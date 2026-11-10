import { describe, expect, it } from 'vitest'
import {
  firstLineSummary,
  firstNonEmptyLine,
  formatElapsed,
  stripAnsi,
  stripCodeFence,
} from '../index.js'

describe('activity text helpers', () => {
  it('takes the first line and clamps long summaries', () => {
    expect(firstLineSummary('  hello\nworld')).toBe('hello')
    expect(firstLineSummary('x'.repeat(130))).toBe(`${'x'.repeat(120)}…`)
    expect(firstLineSummary('')).toBe('')
  })

  it('finds the first non-empty line', () => {
    expect(firstNonEmptyLine('\n \n  hello \nworld')).toBe('hello')
    expect(firstNonEmptyLine('   ')).toBe('')
  })

  it('strips only a whole-block code fence', () => {
    expect(stripCodeFence('```console\nout\n```')).toBe('out')
    expect(stripCodeFence('```\nerr\n```')).toBe('err')
    expect(stripCodeFence('plain text')).toBe('plain text')
    expect(stripCodeFence('```console\nout')).toBe('```console\nout')
  })

  it('formats elapsed time compactly', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59_000)).toBe('59s')
    expect(formatElapsed(60_000)).toBe('1:00')
    expect(formatElapsed(3_723_000)).toBe('62:03')
  })

  it('strips ANSI styles and other escapes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m plain')).toBe('red plain')
    expect(stripAnsi('\x1b[2Kprogress')).toBe('progress')
    expect(stripAnsi('plain')).toBe('plain')
  })
})
