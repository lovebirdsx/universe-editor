import { describe, expect, it } from 'vitest'
import { detectFrontmatterRange } from '../frontmatter.js'

describe('detectFrontmatterRange', () => {
  it('detects a closed frontmatter block at the start of the document', () => {
    const text = '---\ntitle: hi\ndescription: [hello]\n---\n\n# Body\n'
    expect(detectFrontmatterRange(text)).toEqual({ startLine: 0, endLine: 4 })
  })

  it('accepts `...` as a closing fence', () => {
    expect(detectFrontmatterRange('---\na: 1\n...\nbody')).toEqual({ startLine: 0, endLine: 3 })
  })

  it('returns undefined when the first line is not a fence', () => {
    expect(detectFrontmatterRange('# Heading\n\n---\n')).toBeUndefined()
  })

  it('returns undefined for an unterminated block', () => {
    expect(detectFrontmatterRange('---\ntitle: hi\n')).toBeUndefined()
  })

  it('tolerates CRLF line endings', () => {
    expect(detectFrontmatterRange('---\r\na: 1\r\n---\r\n')).toEqual({ startLine: 0, endLine: 3 })
  })
})
