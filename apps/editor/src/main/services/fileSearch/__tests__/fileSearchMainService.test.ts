/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for main-process workspace file-name search.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { URI } from '@universe-editor/platform'
import { FileSearchMainService } from '../fileSearchMainService.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'universe-file-search-'))
  roots.push(root)
  return root
}

async function writeFile(root: string, relPath: string): Promise<void> {
  const target = path.join(root, relPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, '')
}

async function trySymlink(
  target: string,
  linkPath: string,
  type: 'file' | 'dir',
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type)
    return true
  } catch {
    return false // Windows 无 symlink 权限 → 跳过
  }
}

afterEach(async () => {
  const prefix = path.resolve(os.tmpdir(), 'universe-file-search-')
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root)
    if (resolved.startsWith(prefix)) {
      await fs.rm(resolved, { recursive: true, force: true })
    }
  }
})

describe('FileSearchMainService', () => {
  it('uses maxResults as a result cap, not a traversal cap', async () => {
    const root = await makeRoot()
    await writeFile(root, 'first.txt')
    await writeFile(root, 'ActionDetailView.tsx')

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'ActionDetailView.tsx',
      maxResults: 1,
    })

    expect(complete.filesWalked).toBe(2)
    expect(complete.results.map((r) => r.relativePath)).toEqual(['ActionDetailView.tsx'])
  })

  it('supports matchAll with search excludes and ignored directory names', async () => {
    const root = await makeRoot()
    await writeFile(root, 'src/main.ts')
    await writeFile(root, 'dist/generated.ts')
    await writeFile(root, 'node_modules/pkg/index.ts')

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      excludes: ['dist/**'],
      ignore: ['node_modules'],
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['src/main.ts'])
  })

  it('finds a file symbolic link by following its target type', async () => {
    const root = await makeRoot()
    await writeFile(root, 'real.ts')
    if (!(await trySymlink(path.join(root, 'real.ts'), path.join(root, 'link.ts'), 'file'))) return

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath).sort()).toEqual(['link.ts', 'real.ts'])
  })

  it('traverses a directory symbolic link', async () => {
    const root = await makeRoot()
    await writeFile(root, 'target/inside.ts')
    if (!(await trySymlink(path.join(root, 'target'), path.join(root, 'linkdir'), 'dir'))) return

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'inside.ts',
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath).sort()).toEqual([
      'linkdir/inside.ts',
      'target/inside.ts',
    ])
  })

  it('skips a dangling symbolic link without throwing', async () => {
    const root = await makeRoot()
    await writeFile(root, 'real.ts')
    if (
      !(await trySymlink(path.join(root, 'does-not-exist'), path.join(root, 'broken.ts'), 'file'))
    )
      return

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['real.ts'])
  })
})
