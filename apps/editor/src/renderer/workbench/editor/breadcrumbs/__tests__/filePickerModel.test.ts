/*---------------------------------------------------------------------------------------------
 *  Tests for workbench/editor/breadcrumbs/filePickerModel.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  URI,
  type IDirectoryEntry,
  type IFileService,
  type IUriIdentityService,
  type IWorkspace,
} from '@universe-editor/platform'
import { FilePickerDataSource, resolveFilePickerRoot } from '../filePickerModel.js'
import type { IExcludeService } from '../../../../services/exclude/ExcludeService.js'

const uriIdentity = {
  isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  relativePath: (from: URI, to: URI) => {
    const base = from.path.replace(/\/+$/, '')
    if (to.path === base) return ''
    if (!to.path.startsWith(`${base}/`)) return null
    return to.path.slice(base.length + 1)
  },
} as unknown as IUriIdentityService

function fileService(entriesByPath: Record<string, IDirectoryEntry[]>): IFileService {
  return {
    list: vi.fn(async (directory: URI) => {
      const entries = entriesByPath[directory.path]
      if (!entries) throw new Error(`missing ${directory.path}`)
      return entries
    }),
  } as unknown as IFileService
}

function entry(name: string, isDirectory = false): IDirectoryEntry {
  return { name, isDirectory, isFile: !isDirectory }
}

function makeSource(
  root: URI,
  focus: URI | undefined,
  entries: Record<string, IDirectoryEntry[]>,
  options: { exclude?: IExcludeService; workspace?: IWorkspace } = {},
) {
  return new FilePickerDataSource(
    root,
    focus,
    options.workspace ?? null,
    uriIdentity,
    fileService(entries),
    options.exclude,
  )
}

describe('resolveFilePickerRoot', () => {
  it('opens the parent directory of a file segment', () => {
    const file = URI.file('/ws/src/a.ts')
    const resolved = resolveFilePickerRoot({ kind: 'file', uri: file, label: 'a.ts' })
    expect(resolved.root.toString()).toBe('file:///ws/src')
    expect(resolved.focusResource?.toString()).toBe('file:///ws/src/a.ts')
  })

  it('opens a root segment as-is', () => {
    const root = URI.file('/')
    const resolved = resolveFilePickerRoot({ kind: 'root', uri: root, label: '/' })
    expect(resolved.root.toString()).toBe('file:///')
    expect(resolved.focusResource).toBeUndefined()
  })
})

describe('FilePickerDataSource', () => {
  it('lists directories first, sorted naturally', async () => {
    const source = makeSource(URI.file('/ws'), URI.file('/ws/b.txt'), {
      '/ws': [entry('b.txt'), entry('a.txt'), entry('zdir', true), entry('Adir', true)],
    })
    await source.loadRoot()
    expect(source.getRoots().map((e) => e.name)).toEqual(['Adir', 'zdir', 'a.txt', 'b.txt'])
    expect(source.findRootChild(URI.file('/ws/b.txt'))?.name).toBe('b.txt')
  })

  it('keeps the focused file even when files.exclude hides it', async () => {
    const exclude = {
      isExcluded: () => true,
    } as unknown as IExcludeService
    const source = makeSource(
      URI.file('/ws'),
      URI.file('/ws/keep.txt'),
      { '/ws': [entry('keep.txt'), entry('hidden.txt'), entry('node_modules', true)] },
      { exclude, workspace: { folder: URI.file('/ws') } as IWorkspace },
    )
    await source.loadRoot()
    expect(source.getRoots().map((e) => e.name)).toEqual(['keep.txt'])
  })

  it('loads children lazily and resolves the parent link', async () => {
    const source = makeSource(URI.file('/ws'), undefined, {
      '/ws': [entry('src', true)],
      '/ws/src': [entry('a.ts'), entry('nested', true)],
      '/ws/src/nested': [entry('b.ts')],
    })
    await source.loadRoot()
    const dir = source.getRoots()[0]!
    expect(source.getChildren(dir)).toBeNull()
    expect(source.hasChildren(dir)).toBe(true)

    await source.loadChildren(dir)
    expect(source.getChildren(dir)?.map((e) => e.name)).toEqual(['nested', 'a.ts'])

    const nested = source.getChildren(dir)![0]!
    await source.loadChildren(nested)
    const file = source.getChildren(nested)![0]!
    // TreeModel destructures `getParent` before calling it.
    const getParent = source.getParent
    expect(getParent(file)?.name).toBe('nested')
    expect(getParent(nested)?.name).toBe('src')
    expect(getParent(dir)).toBeNull()
  })

  it('does not apply files.exclude outside the workspace', async () => {
    const exclude = {
      isExcluded: vi.fn(() => true),
    } as unknown as IExcludeService
    const source = makeSource(
      URI.file('/tmp'),
      URI.file('/tmp/run.log'),
      { '/tmp': [entry('run.log'), entry('other.txt')] },
      { exclude, workspace: { folder: URI.file('/ws') } as IWorkspace },
    )
    await source.loadRoot()
    expect(exclude.isExcluded).not.toHaveBeenCalled()
    expect(source.getRoots().map((e) => e.name)).toEqual(['other.txt', 'run.log'])
    expect(source.findRootChild(URI.file('/tmp/run.log'))?.name).toBe('run.log')
  })

  it('reports empty directories as childless after loading', async () => {
    const source = makeSource(URI.file('/ws'), undefined, {
      '/ws': [entry('empty', true)],
      '/ws/empty': [],
    })
    await source.loadRoot()
    const dir = source.getRoots()[0]!
    expect(source.hasChildren(dir)).toBe(true)
    await source.loadChildren(dir)
    expect(source.hasChildren(dir)).toBe(false)
    expect(source.getChildren(dir)).toEqual([])
  })

  it('deduplicates concurrent loads of the same directory', async () => {
    const list = vi.fn(async () => [entry('a.txt')])
    const source = new FilePickerDataSource(
      URI.file('/ws'),
      undefined,
      null,
      uriIdentity,
      { list } as unknown as IFileService,
      undefined,
    )
    await Promise.all([source.loadRoot(), source.loadRoot(), source.loadRoot()])
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('retries a failed directory load', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([entry('a.txt')])
    const source = new FilePickerDataSource(
      URI.file('/ws'),
      undefined,
      null,
      uriIdentity,
      { list } as unknown as IFileService,
      undefined,
    )
    await expect(source.loadRoot()).rejects.toThrow('boom')
    await source.loadRoot()
    expect(source.getRoots().map((e) => e.name)).toEqual(['a.txt'])
  })
})
