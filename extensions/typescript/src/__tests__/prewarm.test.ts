/*---------------------------------------------------------------------------------------------
 *  Tests for the TypeScript plugin's tsconfig-driven prewarm helpers:
 *  - resolvePrewarmTargets: single tsconfig auto-warms, multi + no config warms
 *    nothing, explicit config warms the listed (existing) tsconfigs;
 *  - enumerateTsconfigs: finds tsconfig*.json, skips heavy dirs;
 *  - findSeedFile: picks a real source file, skipping loose *.config.* files that
 *    would land tsserver in a symbol-less inferred project (the original bug).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { FileType } from '@universe-editor/extension-api'
import { enumerateTsconfigs, findSeedFile, resolvePrewarmTargets } from '../extension.js'

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
  it('finds tsconfig*.json and skips heavy dirs', async () => {
    const readDir = makeReadDir({
      '/w': [
        ['tsconfig.json', F],
        ['node_modules', D],
        ['packages', D],
        ['eslint.config.js', F],
      ],
      '/w/node_modules': [['tsconfig.json', F]], // must be skipped
      '/w/packages': [['app', D]],
      '/w/packages/app': [
        ['tsconfig.json', F],
        ['tsconfig.node.json', F],
      ],
    })
    const found = await enumerateTsconfigs('/w', readDir)
    expect(found.sort()).toEqual([
      'packages/app/tsconfig.json',
      'packages/app/tsconfig.node.json',
      'tsconfig.json',
    ])
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
