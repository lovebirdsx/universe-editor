/**
 * Regression: a stray `console.log` from an in-process extension dependency must
 * not reach stdout (the RPC wire). protectStdout binds the real stdout writer for
 * framing and repoints console.* to stderr. See bootstrap.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { MAX_LOG_MESSAGE_LENGTH, protectStdout } from '../stdoutProtection.js'

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

  it('prefixes each console method with its level tag for main-side routing', () => {
    const { target, stderrWrites } = makeTarget()
    protectStdout(target)
    target.console.log('l')
    target.console.info('i')
    target.console.debug('d')
    target.console.warn('w')
    target.console.error('e')
    const out = stderrWrites.join('')
    expect(out).toContain('[info] l')
    expect(out).toContain('[info] i')
    expect(out).toContain('[debug] d')
    expect(out).toContain('[warn] w')
    expect(out).toContain('[error] e')
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

  it('leaves a small message byte-identical', () => {
    const { target, stderrWrites } = makeTarget()
    protectStdout(target)
    target.console.log('hello', { a: 1 })
    expect(stderrWrites.join('')).toBe('[info] hello { a: 1 }\n')
  })

  it('truncates an oversized message at the cap and keeps the marker', () => {
    const { target, stderrWrites } = makeTarget()
    protectStdout(target)
    target.console.log('x'.repeat(MAX_LOG_MESSAGE_LENGTH + 4096))
    const out = stderrWrites.join('')
    expect(out).toContain('chars truncated')
    expect(out).not.toContain('x'.repeat(MAX_LOG_MESSAGE_LENGTH))
    expect(out.length).toBeLessThan(MAX_LOG_MESSAGE_LENGTH + 128)
  })

  it('caps a huge string nested inside an object argument during inspect', () => {
    const { target, stderrWrites } = makeTarget()
    protectStdout(target)
    target.console.log('provideCompletionItems', { document: 'y'.repeat(8192) })
    const out = stderrWrites.join('')
    expect(out).not.toContain('y'.repeat(8192))
    expect(out).toContain('more characters')
  })
})
