/*---------------------------------------------------------------------------------------------
 *  Tests for monacoCommandSource — bridging Monaco's editor-local action
 *  registry into the unified palette's IQuickPickItem stream.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import type { EditorInput, IEditorGroupsService, IFileService } from '@universe-editor/platform'
import type { monaco } from '../../editor/monaco/MonacoLoader.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../editor/FileEditorRegistry.js'
import { collectMonacoCommands, isMonacoCommandItem } from '../monacoCommandSource.js'

const fileServiceStub = {} as IFileService

function makeGroupsService(active: EditorInput | undefined): IEditorGroupsService {
  return {
    activeGroup: { activeEditor: active },
  } as unknown as IEditorGroupsService
}

function makeFakeEditor(actions: ReadonlyArray<Partial<monaco.editor.IEditorAction>>) {
  return {
    getSupportedActions: () =>
      actions.map((a) => ({
        id: a.id ?? '',
        label: a.label ?? '',
        alias: '',
        metadata: undefined,
        isSupported: a.isSupported ?? (() => true),
        run: a.run ?? (() => Promise.resolve()),
      })),
  } as unknown as monaco.editor.IStandaloneCodeEditor
}

function makeFakeEditorWithKeybindings(
  actions: ReadonlyArray<Partial<monaco.editor.IEditorAction>>,
  keybindings: Record<string, string>,
  field: '_standaloneKeybindingService' | '_keybindingService' = '_standaloneKeybindingService',
) {
  const editor = makeFakeEditor(actions) as unknown as Record<string, unknown>
  editor[field] = {
    lookupKeybinding: (id: string) => {
      const label = keybindings[id]
      return label !== undefined ? { getLabel: () => label } : null
    },
  }
  return editor as unknown as monaco.editor.IStandaloneCodeEditor
}

afterEach(() => {
  FileEditorRegistry._resetForTests()
})

describe('collectMonacoCommands', () => {
  it('returns [] when no active editor', () => {
    expect(collectMonacoCommands(makeGroupsService(undefined))).toEqual([])
  })

  it('returns [] when active editor is not a FileEditorInput', () => {
    // Use a minimal EditorInput subclass that is NOT a FileEditorInput
    const fakeInput = {
      id: 'untitled:1',
      type: 'untitled',
      label: 'untitled',
      isDirty: false,
      typeId: 'untitled',
      resource: URI.parse('untitled:1'),
    } as unknown as EditorInput
    expect(collectMonacoCommands(makeGroupsService(fakeInput))).toEqual([])
  })

  it('returns [] when no Monaco instance is registered for the active input', () => {
    const input = new FileEditorInput(URI.file('/x.ts'), fileServiceStub)
    expect(collectMonacoCommands(makeGroupsService(input))).toEqual([])
  })

  it('maps each supported action to an IQuickPickItem with Monaco markers', () => {
    const input = new FileEditorInput(URI.file('/x.ts'), fileServiceStub)
    const editor = makeFakeEditor([
      { id: 'editor.action.formatDocument', label: 'Format Document' },
      { id: 'editor.action.gotoLine', label: 'Go to Line' },
      { id: 'editor.action.disabled', label: 'Disabled', isSupported: () => false },
    ])
    FileEditorRegistry.register(input, editor)

    const items = collectMonacoCommands(makeGroupsService(input))
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: 'editor.action.formatDocument',
      label: 'Format Document',
      description: 'Monaco',
      _monaco: true,
      _actionId: 'editor.action.formatDocument',
    })
    expect(items.every(isMonacoCommandItem)).toBe(true)
  })

  it('populates keybinding field when _standaloneKeybindingService provides a label (real Monaco field)', () => {
    const input = new FileEditorInput(URI.file('/x.ts'), fileServiceStub)
    const editor = makeFakeEditorWithKeybindings(
      [{ id: 'editor.action.formatDocument', label: 'Format Document' }],
      { 'editor.action.formatDocument': 'Alt+Shift+F' },
      '_standaloneKeybindingService',
    )
    FileEditorRegistry.register(input, editor)

    const items = collectMonacoCommands(makeGroupsService(input))
    expect(items[0]?.keybinding).toBe('Alt+Shift+F')
  })

  it('populates keybinding field when _keybindingService provides a label (fallback)', () => {
    const input = new FileEditorInput(URI.file('/x.ts'), fileServiceStub)
    const editor = makeFakeEditorWithKeybindings(
      [{ id: 'editor.action.formatDocument', label: 'Format Document' }],
      { 'editor.action.formatDocument': 'Alt+Shift+F' },
      '_keybindingService',
    )
    FileEditorRegistry.register(input, editor)

    const items = collectMonacoCommands(makeGroupsService(input))
    expect(items[0]?.keybinding).toBe('Alt+Shift+F')
  })

  it('leaves keybinding undefined when no binding is registered for the action', () => {
    const input = new FileEditorInput(URI.file('/x.ts'), fileServiceStub)
    const editor = makeFakeEditorWithKeybindings(
      [{ id: 'editor.action.gotoLine', label: 'Go to Line' }],
      {},
    )
    FileEditorRegistry.register(input, editor)

    const items = collectMonacoCommands(makeGroupsService(input))
    expect(items[0]?.keybinding).toBeUndefined()
  })

  it('leaves keybinding undefined and does not throw when no keybinding service is present', () => {
    const input = new FileEditorInput(URI.file('/x.ts'), fileServiceStub)
    const editor = makeFakeEditor([{ id: 'editor.action.gotoLine', label: 'Go to Line' }])
    FileEditorRegistry.register(input, editor)

    const items = collectMonacoCommands(makeGroupsService(input))
    expect(items[0]?.keybinding).toBeUndefined()
  })
})

describe('isMonacoCommandItem', () => {
  it('discriminates Monaco items from plain quick-pick items', () => {
    expect(isMonacoCommandItem({ id: 'x', label: 'x' })).toBe(false)
    expect(
      isMonacoCommandItem({
        id: 'x',
        label: 'x',
        _monaco: true,
        _actionId: 'x',
        _editor: {} as monaco.editor.IStandaloneCodeEditor,
      } as never),
    ).toBe(true)
  })
})
