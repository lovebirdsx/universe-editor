import { describe, expect, it } from 'vitest'
import { basename, normalizeSlashes } from '../path.js'
import { PATH_CASES } from '../testing/pathCases.js'

describe('PATH_CASES × normalizeSlashes / basename', () => {
  for (const c of PATH_CASES) {
    it(`${c.name}: ${JSON.stringify(c.input)}`, () => {
      expect(normalizeSlashes(c.input), 'normalizeSlashes').toBe(c.slashes)
      expect(basename(normalizeSlashes(c.input)), 'workspace folder name').toBe(c.folderName)
    })
  }
})

describe('strip policy divergence', () => {
  it('basename strips a single trailing slash, normalizeSlashes strips all', () => {
    expect(basename('a//')).toBe('')
    expect(basename('a/')).toBe('a')
    expect(basename(normalizeSlashes('a//'))).toBe('a')
  })

  it('normalizeSlashes keeps a bare root so it never becomes empty', () => {
    expect(normalizeSlashes('/')).toBe('/')
    expect(normalizeSlashes('///')).toBe('/')
    expect(normalizeSlashes('')).toBe('')
  })
})
