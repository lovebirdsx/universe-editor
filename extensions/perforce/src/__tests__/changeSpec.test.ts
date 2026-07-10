import { describe, expect, it } from 'vitest'
import { buildNewChangeSpec, replaceDescription, parseDescription } from '../changeSpec.js'

describe('buildNewChangeSpec', () => {
  it('builds a Change: new spec with tab-indented description', () => {
    const spec = buildNewChangeSpec('my feature', { client: 'ws', user: 'alice' })
    expect(spec).toContain('Change: new')
    expect(spec).toContain('Client: ws')
    expect(spec).toContain('User: alice')
    expect(spec).toContain('Description:\n\tmy feature')
    expect(spec.endsWith('\n')).toBe(true)
  })

  it('indents every line of a multi-line description', () => {
    const spec = buildNewChangeSpec('line 1\nline 2')
    expect(spec).toContain('Description:\n\tline 1\n\tline 2')
  })

  it('falls back to a placeholder for an empty description', () => {
    const spec = buildNewChangeSpec('')
    expect(spec).toContain('\t<enter description>')
  })
})

const SAMPLE_SPEC = [
  'Change: 4521',
  '',
  'Client: my-client',
  '',
  'User: alice',
  '',
  'Status: pending',
  '',
  'Description:',
  '\told description line 1',
  '\told description line 2',
  '',
  'Files:',
  '\t//depot/main/foo.txt # edit',
  '\t//depot/main/bar.txt # add',
  '',
].join('\n')

describe('parseDescription', () => {
  it('extracts the de-indented description body', () => {
    expect(parseDescription(SAMPLE_SPEC)).toBe('old description line 1\nold description line 2')
  })

  it('returns empty when there is no description field', () => {
    expect(parseDescription('Change: 1\n\nStatus: pending\n')).toBe('')
  })
})

describe('replaceDescription', () => {
  it('swaps the description while preserving the Files list', () => {
    const updated = replaceDescription(SAMPLE_SPEC, 'brand new message')
    expect(parseDescription(updated)).toBe('brand new message')
    expect(updated).toContain('//depot/main/foo.txt # edit')
    expect(updated).toContain('//depot/main/bar.txt # add')
    expect(updated).toContain('Client: my-client')
    // Old description must be gone.
    expect(updated).not.toContain('old description line 1')
  })

  it('handles a multi-line replacement', () => {
    const updated = replaceDescription(SAMPLE_SPEC, 'a\nb\nc')
    expect(parseDescription(updated)).toBe('a\nb\nc')
    expect(updated).toContain('Files:')
  })

  it('appends a Description block when the spec lacks one', () => {
    const updated = replaceDescription('Change: 1\n\nStatus: pending\n', 'added')
    expect(parseDescription(updated)).toBe('added')
  })
})
