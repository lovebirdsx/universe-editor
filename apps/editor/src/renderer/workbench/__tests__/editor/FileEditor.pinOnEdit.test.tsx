/*---------------------------------------------------------------------------------------------
 *  Tests for FileEditor — auto-pin on first edit (主题 11 WP2).
 *
 *  Monaco itself is heavy and tied to Vite worker imports; we mock both the
 *  loader and the model registry so the React component exercises only the
 *  bookkeeping wiring (resolve -> setModel -> onDidChangeContent -> pinEditor).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../editor/monaco/MonacoLoader.js', () => {
  const monacoStub = {
    editor: {
      create: () => ({
        setModel: () => {},
        dispose: () => {},
        getModel: () => null,
        addCommand: () => null,
        focus: () => {},
        saveViewState: () => null,
        restoreViewState: () => {},
        onDidChangeCursorPosition: () => ({ dispose: () => {} }),
        onDidScrollChange: () => ({ dispose: () => {} }),
      }),
    },
    KeyCode: { F1: 0 },
  }
  return {
    MonacoLoader: {
      ensureInitialized: () => Promise.resolve(monacoStub),
      get: () => monacoStub,
    },
  }
})

let onDidChangeContentCb: (() => void) | undefined

vi.mock('../../editor/monaco/MonacoModelRegistry.js', () => {
  return {
    languageForResource: () => 'plaintext',
    MonacoModelRegistry: {
      acquire: () => ({
        onDidChangeContent: (cb: () => void) => {
          onDidChangeContentCb = cb
          return { dispose: () => {} }
        },
        getValue: () => 'edited',
      }),
      release: () => {},
      peek: () => null,
    },
  }
})

vi.mock('../../editor/FileEditorRegistry.js', () => {
  return {
    FileEditorRegistry: {
      register: () => {},
      unregister: () => {},
    },
  }
})

import { cleanup, render } from '@testing-library/react'
import {
  EditorInput,
  ICommandService,
  IConfigurationService,
  IEditorGroupsService,
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { FileEditor } from '../../editor/FileEditor.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { ServicesContext } from '../../useService.js'

function makeFs(): IFileServiceType {
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
      return true
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

class FakeGroup {
  constructor(
    public previewEditor: EditorInput | undefined,
    public readonly pinCalls: EditorInput[] = [],
  ) {}
  pinEditor(input: EditorInput) {
    this.pinCalls.push(input)
    if (this.previewEditor === input) this.previewEditor = undefined
  }
}

class FakeGroupsService {
  declare readonly _serviceBrand: undefined
  constructor(public readonly groups: FakeGroup[]) {}
  get activeGroup(): FakeGroup {
    return this.groups[0]!
  }
  onDidActiveGroupChange() {
    return { dispose() {} }
  }
}

afterEach(() => {
  cleanup()
  onDidChangeContentCb = undefined
})

describe('FileEditor — auto-pin on first edit', () => {
  it('calls pinEditor on the group that owns the input when content changes', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: async () => undefined,
    } as never)
    services.set(IConfigurationService, {
      _serviceBrand: undefined,
      get: () => true,
      update: () => {},
      onDidChangeConfiguration: () => ({ dispose: () => {} }),
      loadLayer: () => {},
      getLayerSnapshot: () => ({}),
    } as never)
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.txt'))
    const group = new FakeGroup(input)
    const groups = new FakeGroupsService([group])
    services.set(IEditorGroupsService, groups as unknown as IEditorGroupsService)

    render(
      <ServicesContext.Provider value={inst}>
        <FileEditor input={input} />
      </ServicesContext.Provider>,
    )

    // Wait for the resolve()->setModel async chain to register the listener.
    await vi.waitFor(() => {
      if (!onDidChangeContentCb) throw new Error('not yet')
    })
    onDidChangeContentCb!()
    expect(group.pinCalls).toContain(input)
    expect(group.previewEditor).toBeUndefined()
  })
})
