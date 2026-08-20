import { describe, expect, it } from 'vitest'
import { timestampLines } from '../timestampLines.js'

const stamp = (token: string) => () => `[${token}] `

describe('timestampLines', () => {
  it('stamps a single appendLine at the line start', () => {
    const result = timestampLines('hello\n', true, stamp('00:00:00.000'))

    expect(result.text).toBe('[00:00:00.000] hello\n')
    expect(result.atLineStart).toBe(true)
  })

  it('stamps each line of a multi-line append', () => {
    const result = timestampLines('a\nb\nc\n', true, stamp('00:00:00.000'))

    expect(result.text).toBe('[00:00:00.000] a\n[00:00:00.000] b\n[00:00:00.000] c\n')
    expect(result.atLineStart).toBe(true)
  })

  it('stamps only once across consecutive appends that join into one line', () => {
    const first = timestampLines('foo', true, stamp('t1'))
    expect(first.text).toBe('[t1] foo')
    expect(first.atLineStart).toBe(false)

    const second = timestampLines('bar', first.atLineStart, stamp('t2'))
    expect(second.text).toBe('bar')
    expect(second.atLineStart).toBe(false)
  })

  it('stamps again after an append that ends with a newline', () => {
    const first = timestampLines('foo\n', true, stamp('t1'))
    expect(first.text).toBe('[t1] foo\n')
    expect(first.atLineStart).toBe(true)

    const second = timestampLines('bar', first.atLineStart, stamp('t2'))
    expect(second.text).toBe('[t2] bar')
    expect(second.atLineStart).toBe(false)
  })

  it('leaves empty appends untouched and keeps the state', () => {
    expect(timestampLines('', false, stamp('t1'))).toEqual({ text: '', atLineStart: false })
    expect(timestampLines('', true, stamp('t1'))).toEqual({ text: '', atLineStart: true })
  })
})
