/**
 * Regression: a stray `console.log` from an in-process extension dependency must
 * not reach stdout (the RPC wire). protectStdout binds the real stdout writer for
 * framing and repoints console.* to stderr. See bootstrap.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { protectStdout } from '../stdoutProtection.js'

function makeTarget() {
  const stdoutWrites: string[] = []
  const stderrWrites: string[] = []
  const stdout = {
    write: vi.fn((s: string) => {
      stdoutWrites.push(s)
      return true
    }),
  }
  // Console attaches error listeners to its streams, so use a real PassThrough,
  // but spy on write to capture output synchronously.
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream
  vi.spyOn(stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrWrites.push(String(chunk))
    return true
  })
  const target = { stdout, stderr, console } as Parameters<typeof protectStdout>[0]
  return { target, stdoutWrites, stderrWrites }
}

describe('protectStdout', () => {
  it('returns a writer bound to the original stdout (the framing channel)', () => {
    const { target, stdoutWrites } = makeTarget()
    const writeFrame = protectStdout(target)
    writeFrame('{"type":"response"}\n')
    expect(stdoutWrites).toEqual(['{"type":"response"}\n'])
  })

  it('routes console.log (which defaults to stdout) to stderr instead', () => {
    const { target, stdoutWrites, stderrWrites } = makeTarget()
    protectStdout(target)
    target.console.log('provideCompletionItems', { a: 1 })
    expect(stdoutWrites).toEqual([])
    expect(stderrWrites.join('')).toContain('provideCompletionItems')
  })

  it('routes console.info / debug / dir to stderr too', () => {
    const { target, stdoutWrites, stderrWrites } = makeTarget()
    protectStdout(target)
    target.console.info('i')
    target.console.debug('d')
    target.console.dir({ x: 1 })
    expect(stdoutWrites).toEqual([])
    expect(stderrWrites.join('')).toContain('i')
    expect(stderrWrites.join('')).toContain('d')
  })

  it('keeps console.error on stderr', () => {
    const { target, stdoutWrites, stderrWrites } = makeTarget()
    protectStdout(target)
    target.console.error('[ext-host] boom')
    expect(stdoutWrites).toEqual([])
    expect(stderrWrites.join('')).toContain('boom')
  })
})
