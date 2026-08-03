/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/search/openEditorSearch.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  IFileService,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  type IEditorGroupsService,
  type IFileMatch,
  type ITextSearchQuery,
} from '@universe-editor/platform'
import { mergeOpenEditorResults, searchOpenEditorModels } from '../openEditorSearch.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { UntitledEditorInput } from '../../editor/UntitledEditorInput.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

const QUERY: ITextSearchQuery = {
  pattern: 'needle',
  isRegex: false,
  matchCase: false,
  matchWholeWord: false,
  includes: [],
  excludes: [],
}

function stubFs() {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  }
}

function makeInstantiation(): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, stubFs() as never)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return inst
}

function groupsOf(...editors: { resource: URI }[]): IEditorGroupsService {
  return {
    _serviceBrand: undefined,
    groups: [{ id: 1, editors }],
  } as never
}

describe('searchOpenEditorModels', () => {
  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('searches untitled buffer content held only in memory', () => {
    const untitled = new UntitledEditorInput()
    MonacoModelRegistry.acquire(untitled.resource, 'first line\na needle here\nlast line')

    const results = searchOpenEditorModels(groupsOf(untitled), QUERY)

    expect(results).toHaveLength(1)
    expect(results[0]!.resource.scheme).toBe('untitled')
    expect(results[0]!.matches).toHaveLength(1)
    expect(results[0]!.matches[0]!.lineNumber).toBe(2)
    expect(results[0]!.matches[0]!.preview).toBe('a needle here')
  })

  it('includes dirty file buffers, skips clean ones', () => {
    const inst = makeInstantiation()
    const dirty = inst.createInstance(FileEditorInput, URI.file('/ws/dirty.ts'))
    dirty.setDirty(true)
    const clean = inst.createInstance(FileEditorInput, URI.file('/ws/clean.ts'))
    MonacoModelRegistry.acquire(dirty.resource, 'needle in buffer')
    MonacoModelRegistry.acquire(clean.resource, 'needle in buffer')

    const results = searchOpenEditorModels(groupsOf(dirty, clean), QUERY)

    expect(results).toHaveLength(1)
    expect(results[0]!.resource.toString()).toBe(dirty.resource.toString())
  })

  it('skips inputs whose model is not in the registry', () => {
    const untitled = new UntitledEditorInput()
    expect(searchOpenEditorModels(groupsOf(untitled), QUERY)).toHaveLength(0)
  })

  it('dedupes the same resource opened in a split', () => {
    const untitled = new UntitledEditorInput()
    MonacoModelRegistry.acquire(untitled.resource, 'needle')
    const groups = {
      _serviceBrand: undefined,
      groups: [
        { id: 1, editors: [untitled] },
        { id: 2, editors: [untitled] },
      ],
    } as never
    expect(searchOpenEditorModels(groups, QUERY)).toHaveLength(1)
  })
})

describe('mergeOpenEditorResults', () => {
  const uriIdentity = new UriIdentityService('linux')

  function fileMatch(path: string, preview: string): IFileMatch {
    return {
      resource: URI.file(path),
      matches: [{ lineNumber: 1, preview, ranges: [{ startColumn: 1, endColumn: 2 }] }],
    }
  }

  it('appends untitled results that have no disk counterpart', () => {
    const disk = [fileMatch('/ws/a.ts', 'disk')]
    const untitled: IFileMatch = {
      resource: URI.from({ scheme: 'untitled', path: '/Untitled-1' }),
      matches: [{ lineNumber: 1, preview: 'mem', ranges: [{ startColumn: 1, endColumn: 2 }] }],
    }
    const merged = mergeOpenEditorResults(disk, [untitled], uriIdentity)
    expect(merged).toHaveLength(2)
    expect(merged[1]).toBe(untitled)
  })

  it('replaces the disk entry for a dirty buffer of the same resource', () => {
    const disk = [fileMatch('/ws/a.ts', 'stale disk content')]
    const buffer = [fileMatch('/ws/a.ts', 'fresh buffer content')]
    const merged = mergeOpenEditorResults(disk, buffer, uriIdentity)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.matches[0]!.preview).toBe('fresh buffer content')
  })

  it('matches IPC-shaped (revivable) disk resources against buffer URIs', () => {
    const diskResource = URI.file('/ws/a.ts')
    const disk = [
      {
        resource: diskResource.toJSON() as unknown as URI,
        matches: fileMatch('/ws/a.ts', 'x').matches,
      },
    ]
    const buffer = [fileMatch('/ws/a.ts', 'fresh')]
    const merged = mergeOpenEditorResults(disk, buffer, uriIdentity)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.matches[0]!.preview).toBe('fresh')
  })
})
