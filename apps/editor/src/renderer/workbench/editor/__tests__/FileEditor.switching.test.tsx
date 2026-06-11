/*---------------------------------------------------------------------------------------------
 *  Tests for FileEditor tab switching with unsaved file buffers.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = () => void

vi.mock('../monaco/MonacoLoader.js', () => {
  function disposable(dispose: () => void = () => {}) {
    return { dispose }
  }

  function makeModel(initial: string, language: string, uri: unknown) {
    let value = initial
    const listeners = new Set<Listener>()
    return {
      uri,
      getValue: () => value,
      setValue: (next: string) => {
        if (next === value) return
        value = next
        for (const listener of listeners) listener()
      },
      getLanguageId: () => language,
      onDidChangeContent: (listener: Listener) => {
        listeners.add(listener)
        return disposable(() => listeners.delete(listener))
      },
      dispose: () => listeners.clear(),
    }
  }

  const monacoStub = {
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
    },
    KeyCode: { F1: 59 },
    editor: {
      createModel: (text: string, language: string, uri: unknown) => makeModel(text, language, uri),
      create: () => {
        let model: ReturnType<typeof makeModel> | null = null
        const container = document.createElement('div')
        return {
          setModel: (next: ReturnType<typeof makeModel>) => {
            model = next
          },
          getModel: () => model,
          updateOptions: () => {},
          addCommand: () => null,
          focus: () => {},
          saveViewState: () => null,
          restoreViewState: () => {},
          getPosition: () => null,
          setPosition: () => {},
          revealPositionInCenter: () => {},
          onDidChangeCursorPosition: () => disposable(),
          onDidScrollChange: () => disposable(),
          onDidFocusEditorWidget: () => disposable(),
          onDidBlurEditorWidget: () => disposable(),
          onDidFocusEditorText: () => disposable(),
          onDidBlurEditorText: () => disposable(),
          onDidChangeModel: () => disposable(),
          getContainerDomNode: () => container,
          dispose: () => {},
        }
      },
    },
  }

  return {
    MonacoLoader: {
      ensureInitialized: () => Promise.resolve(monacoStub),
      get: () => monacoStub,
      getOverrideServices: () => ({}),
    },
  }
})

import { cleanup, render } from '@testing-library/react'
import {
  ContextKeyService,
  ConfigurationTarget,
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  IFocusStackService,
  InstantiationService,
  observableValue,
  ServiceCollection,
  URI,
  type IConfigurationChangeEvent,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { FileEditor } from '../FileEditor.js'
import { MonacoModelRegistry } from '../monaco/MonacoModelRegistry.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../../services/editor/FileEditorRegistry.js'
import { IOutlineService } from '../../../services/languageFeatures/OutlineService.js'
import { IUserKeybindingsService } from '../../../services/keybindings/UserKeybindingsService.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupContext } from '../EditorGroupContext.js'

function makeFs(initial: Record<string, string>): IFileServiceType {
  const store = { ...initial }
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText(resource: URI) {
      const value = store[resource.toString()]
      if (value === undefined) throw new Error('ENOENT')
      return value
    },
    async writeFile(resource: URI, content: Uint8Array | string) {
      store[resource.toString()] =
        typeof content === 'string' ? content : new TextDecoder().decode(content)
    },
    async exists(resource: URI) {
      return store[resource.toString()] !== undefined
    },
    async stat(resource: URI) {
      return {
        resource,
        isFile: true,
        isDirectory: false,
        size: store[resource.toString()]?.length ?? 0,
        mtime: 1,
      }
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

class FakeConfigurationService {
  declare readonly _serviceBrand: undefined

  get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue
  }

  update(_key: string, _value: unknown, _target?: ConfigurationTarget): void {}

  loadLayer(_target: ConfigurationTarget, _data: Record<string, unknown>): void {}

  getLayerSnapshot(): Readonly<Record<string, unknown>> {
    return {}
  }

  onDidChangeConfiguration(_listener: (e: IConfigurationChangeEvent) => void) {
    return { dispose() {} }
  }

  getMerged<T = Record<string, unknown>>(_key: string): T {
    return {} as T
  }
}

class FakeGroup {
  readonly id = 1
  previewEditor: FileEditorInput | undefined

  constructor(public activeEditor: FileEditorInput | undefined) {}

  pinEditor(input: FileEditorInput): void {
    if (this.previewEditor === input) this.previewEditor = undefined
  }
}

class FakeGroupsService {
  declare readonly _serviceBrand: undefined

  constructor(private readonly group: FakeGroup) {}

  get groups(): readonly FakeGroup[] {
    return [this.group]
  }

  get activeGroup(): FakeGroup {
    return this.group
  }

  onDidActiveGroupChange() {
    return { dispose() {} }
  }
}

function renderEditor(
  instantiation: InstantiationService,
  group: FakeGroup,
  input: FileEditorInput,
) {
  return (
    <ServicesContext.Provider value={instantiation}>
      <EditorGroupContext.Provider value={group as never}>
        <FileEditor input={input} />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>
  )
}

afterEach(() => {
  cleanup()
  FileEditorRegistry._resetForTests()
  MonacoModelRegistry._resetForTests()
})

describe('FileEditor tab switching', () => {
  it('preserves unsaved file text when switching to another file and back', async () => {
    const uriA = URI.file('/ws/a.txt')
    const uriB = URI.file('/ws/b.txt')
    const services = new ServiceCollection()
    services.set(IFileService, makeFs({ [uriA.toString()]: 'A disk', [uriB.toString()]: 'B disk' }))
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: async () => undefined,
    } as never)
    services.set(IConfigurationService, new FakeConfigurationService() as never)
    services.set(IContextKeyService, new ContextKeyService())
    services.set(IFocusStackService, {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose() {} }),
      push: () => {},
      getTop: () => undefined,
      getAll: () => [],
      nextPart: () => undefined,
      previousPart: () => undefined,
      clear: () => {},
    })
    services.set(IUserKeybindingsService, {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose() {} }),
      userEntries: [],
      initialize: async () => {},
      reload: async () => {},
      setKeybinding: () => {},
      resetKeybinding: () => {},
      getUserEntry: () => undefined,
      getDefaultKey: () => undefined,
    })
    const instantiation = new InstantiationService(services)
    const inputA = instantiation.createInstance(FileEditorInput, uriA)
    const inputB = instantiation.createInstance(FileEditorInput, uriB)
    const group = new FakeGroup(inputA)
    services.set(IEditorGroupsService, new FakeGroupsService(group) as never)
    services.set(IOutlineService, {
      _serviceBrand: undefined,
      outline: observableValue('test.outline', undefined),
      activeSymbol: observableValue('test.activeSymbol', undefined),
      revealSymbol: () => {},
    } as never)

    const { rerender } = render(renderEditor(instantiation, group, inputA))

    await vi.waitFor(() => {
      expect(MonacoModelRegistry.peek(uriA)?.getValue()).toBe('A disk')
    })
    MonacoModelRegistry.peek(uriA)?.setValue('A edited')
    await vi.waitFor(() => expect(inputA.isDirty).toBe(true))

    group.activeEditor = inputB
    rerender(renderEditor(instantiation, group, inputB))
    await vi.waitFor(() => {
      expect(MonacoModelRegistry.peek(uriB)?.getValue()).toBe('B disk')
    })

    group.activeEditor = inputA
    rerender(renderEditor(instantiation, group, inputA))

    await vi.waitFor(() => {
      expect(MonacoModelRegistry.peek(uriA)?.getValue()).toBe('A edited')
    })
  })
})
