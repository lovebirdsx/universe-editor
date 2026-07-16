/*---------------------------------------------------------------------------------------------
 * Integration: EditorResolverService — registration and routing logic
 * Tests that registerEditor / resolveEditors dispatch URIs to the correct factory.
 * MonacoModelRegistry is mocked to avoid Vite-specific ?worker / ?raw imports.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LogLevel,
  NullLogger,
  URI,
  type EditorInput,
  type IEditorGroupsService,
  type IEditorService,
  type IInstantiationService,
  type ILoggerService,
} from '@universe-editor/platform'

// Break the Monaco dep chain: FileEditorInput → MonacoModelRegistry → MonacoLoader → ?raw
vi.mock('../../src/renderer/workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: { getOrCreate: vi.fn(), get: vi.fn(), _resetForTests: vi.fn() },
}))

import { EditorResolverService } from '../../src/renderer/services/editor/EditorResolverService.js'

// Minimal stubs for DI-injected constructor params — only openEditor() uses them
const mockInst = { createInstance: vi.fn() } as unknown as IInstantiationService
const mockEditor = { openEditor: vi.fn() } as unknown as IEditorService
// No editors open in these routing tests, so an empty group list is enough for
// the self-heal pass (`_upgradeOpenEditors`) to iterate over nothing.
const mockGroups = { groups: [] } as unknown as IEditorGroupsService
const mockLoggerService: ILoggerService = {
  _serviceBrand: undefined,
  createLogger: () => new NullLogger(),
  setLevel: () => {},
  getLevel: () => LogLevel.Info,
}

describe('editorResolver.routing (integration)', () => {
  let resolver: EditorResolverService

  beforeEach(() => {
    resolver = new EditorResolverService(mockInst, mockEditor, mockGroups, mockLoggerService)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registerEditor + resolveEditors returns matching registration', () => {
    const factory = vi.fn((uri: URI) => ({ typeId: 'dummy', name: uri.fsPath }))
    resolver.registerEditor(
      '**/*.xyz',
      { typeId: 'dummy', displayName: 'Dummy Editor' },
      factory as unknown as (uri: URI) => EditorInput,
    )

    const uri = URI.file('/some/file.xyz')
    const results = resolver.resolveEditors(uri)
    expect(results).toHaveLength(1)
    expect(results[0]?.info.typeId).toBe('dummy')
    expect(results[0]?.info.displayName).toBe('Dummy Editor')
  })

  it('resolveEditors returns empty for unregistered extension', () => {
    resolver.registerEditor('**/*.xyz', { typeId: 'dummy', displayName: 'Dummy' }, vi.fn())

    const uri = URI.file('/some/file.ts')
    const results = resolver.resolveEditors(uri)
    expect(results).toHaveLength(0)
  })

  it('higher-priority registration wins: sorted by priority descending', () => {
    resolver.registerEditor(
      '**/*.json',
      { typeId: 'json-rich', displayName: 'Rich JSON', priority: 100 },
      vi.fn(),
    )
    resolver.registerEditor(
      '**/*.json',
      { typeId: 'json-plain', displayName: 'Plain JSON', priority: 1 },
      vi.fn(),
    )

    const uri = URI.file('/config.json')
    const results = resolver.resolveEditors(uri)
    expect(results).toHaveLength(2)
    expect(results[0]?.info.typeId).toBe('json-rich')
    expect(results[1]?.info.typeId).toBe('json-plain')
  })
})
