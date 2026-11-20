/*---------------------------------------------------------------------------------------------
 *  Tests for the TypeScript plugin's tsconfig-driven prewarm helpers:
 *  - resolvePrewarmTargets: single tsconfig auto-warms, multi + no config warms
 *    nothing, explicit config warms the listed (existing) tsconfigs;
 *  - enumerateTsconfigs: one bounded findFiles search, skips heavy dirs;
 *  - findSeedFile: picks a real source file, skipping loose *.config.* files that
 *    would land tsserver in a symbol-less inferred project (the original bug).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { FileType } from '@universe-editor/extension-api'
import { enumerateTsconfigs, findSeedFile, resolvePrewarmTargets } from '../extension.js'
import type { FindTsconfigFiles } from '../extension.js'

/** Build an in-memory `readDir` over a `{ absolutePath: [name, FileType][] }` tree. */
function makeReadDir(tree: Record<string, Array<[string, FileType]>>) {
  return (dir: string) => Promise.resolve(tree[dir] ?? [])
}

const F = FileType.File
const D = FileType.Directory

describe('resolvePrewarmTargets', () => {
  it('auto-warms the sole tsconfig when none configured', () => {
    expect(resolvePrewarmTargets(['tsconfig.json'], [])).toEqual([''])
    expect(resolvePrewarmTargets(['packages/app/tsconfig.json'], [])).toEqual(['packages/app'])
  })

  it('warms nothing for a multi-tsconfig workspace with no config', () => {
    expect(resolvePrewarmTargets(['a/tsconfig.json', 'b/tsconfig.json'], [])).toEqual([])
  })

  it('warms exactly the configured tsconfigs that exist', () => {
    const all = ['a/tsconfig.json', 'b/tsconfig.json', 'c/tsconfig.json']
    expect(resolvePrewarmTargets(all, ['a/tsconfig.json', 'c/tsconfig.json'])).toEqual(['a', 'c'])
  })

  it('ignores configured tsconfigs that do not exist', () => {
    expect(resolvePrewarmTargets(['a/tsconfig.json'], ['nope/tsconfig.json'])).toEqual([])
  })

  it('normalizes backslashes and leading ./ in configured paths', () => {
    const all = ['a/tsconfig.json']
    expect(resolvePrewarmTargets(all, ['./a\\tsconfig.json'])).toEqual(['a'])
  })

  it('dedupes tsconfigs living in the same directory', () => {
    const all = ['a/tsconfig.json', 'a/tsconfig.web.json']
    expect(resolvePrewarmTargets(all, ['a/tsconfig.json', 'a/tsconfig.web.json'])).toEqual(['a'])
  })
})

describe('enumerateTsconfigs', () => {
  it('runs one bounded search that excludes heavy dirs, keeping only tsconfig*.json', async () => {
    const calls: Array<[string, string, number]> = []
    const find: FindTsconfigFiles = (include, exclude, maxResults) => {
      calls.push([include, exclude, maxResults])
      return Promise.resolve([
        'packages/app/tsconfig.node.json',
        'tsconfig.json',
        'packages/app/tsconfig.json',
        'packages/app/tsconfigish.json',
      ])
    }
    const found = await enumerateTsconfigs(find)
    expect(found).toEqual([
      'tsconfig.json',
      'packages/app/tsconfig.json',
      'packages/app/tsconfig.node.json',
    ])
    expect(calls).toHaveLength(1)
    const [include, exclude] = calls[0]!
    expect(include).toBe('**/tsconfig*.json')
    for (const dir of ['node_modules', '.git', 'dist', 'out', 'build', '.next']) {
      expect(exclude).toContain(dir)
    }
  })

  it('returns no tsconfigs when the search fails', async () => {
    const find: FindTsconfigFiles = () => Promise.reject(new Error('no workspace'))
    expect(await enumerateTsconfigs(find)).toEqual([])
  })
})

describe('findSeedFile', () => {
  it('skips loose *.config.* and picks a real source file (the prewarm bug)', async () => {
    const readDir = makeReadDir({
      '/w': [
        ['eslint.config.js', F],
        ['vite.config.ts', F],
        ['src', D],
      ],
      '/w/src': [['index.ts', F]],
    })
    const seed = await findSeedFile('/w', readDir)
    expect(seed).toEqual({ path: '/w/src/index.ts', languageId: 'typescript' })
  })

  it('maps extensions to languageIds and skips node_modules', async () => {
    const readDir = makeReadDir({
      '/w': [
        ['node_modules', D],
        ['app.tsx', F],
      ],
      '/w/node_modules': [['x.ts', F]],
    })
    const seed = await findSeedFile('/w', readDir)
    expect(seed).toEqual({ path: '/w/app.tsx', languageId: 'typescriptreact' })
  })

  it('returns undefined when only loose config files exist', async () => {
    const readDir = makeReadDir({ '/w': [['prettier.config.mjs', F]] })
    expect(await findSeedFile('/w', readDir)).toBeUndefined()
  })
})
