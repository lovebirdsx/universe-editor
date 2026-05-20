/*---------------------------------------------------------------------------------------------
 *  Tests for FileEditor — auto-pin on first edit (主题 11 WP2).
 *
 *  Monaco itself is heavy and tied to Vite worker imports; we mock both the
 *  loader and the model registry so the React component exercises only the
 *  bookkeeping wiring (resolve -> setModel -> onDidChangeContent -> pinEditor).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

const monacoMockState = vi.hoisted(() => ({
  createOptions: undefined as Record<string, unknown> | undefined,
  updateOptionsCalls: [] as Record<string, unknown>[],
}))

vi.mock('../monaco/MonacoLoader.js', () => {
  const monacoStub = {
    editor: {
      create: (_container: unknown, options: Record<string, unknown>) => {
        monacoMockState.createOptions = options
        return {
          setModel: () => {},
          dispose: () => {},
          getModel: () => null,
          updateOptions: (options: Record<string, unknown>) => {
            monacoMockState.updateOptionsCalls.push(options)
          },
          addCommand: () => null,
          focus: () => {},
          saveViewState: () => null,
          restoreViewState: () => {},
          onDidChangeCursorPosition: () => ({ dispose: () => {} }),
          onDidScrollChange: () => ({ dispose: () => {} }),
          onDidFocusEditorWidget: () => ({ dispose: () => {} }),
          onDidBlurEditorWidget: () => ({ dispose: () => {} }),
          getContainerDomNode: () => document.createElement('div'),
        }
      },
      setTheme: () => {},
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

vi.mock('../monaco/MonacoModelRegistry.js', () => {
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

vi.mock('../../../services/editor/FileEditorRegistry.js', () => {
  return {
    FileEditorRegistry: {
      register: () => {},
      unregister: () => {},
    },
  }
})

import { cleanup, render } from '@testing-library/react'
import {
  ContextKeyService,
  ConfigurationTarget,
  EditorInput,
  ICommandService,
  type IConfigurationChangeEvent,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { FileEditor } from '../FileEditor.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
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

class FakeConfigurationService {
  declare readonly _serviceBrand: undefined

  private readonly _listeners = new Set<(e: IConfigurationChangeEvent) => void>()

  constructor(private readonly _values: Record<string, unknown> = {}) {}

  get<T>(key: string, defaultValue?: T): T | undefined {
    return Object.prototype.hasOwnProperty.call(this._values, key)
      ? (this._values[key] as T)
      : defaultValue
  }

  update(key: string, value: unknown, _target?: ConfigurationTarget): void {
    this._values[key] = value
    this.fire(key)
  }

  loadLayer(_target: ConfigurationTarget, data: Record<string, unknown>): void {
    Object.assign(this._values, data)
    this.fire(...Object.keys(data))
  }

  getLayerSnapshot(): Readonly<Record<string, unknown>> {
    return { ...this._values }
  }

  onDidChangeConfiguration = (listener: (e: IConfigurationChangeEvent) => void) => {
    this._listeners.add(listener)
    return { dispose: () => this._listeners.delete(listener) }
  }

  fire(...keys: string[]): void {
    for (const listener of this._listeners) {
      listener({
        affectsConfiguration: (key) => keys.includes(key),
      })
    }
  }
}

afterEach(() => {
  cleanup()
  onDidChangeContentCb = undefined
  monacoMockState.createOptions = undefined
  monacoMockState.updateOptionsCalls = []
})

describe('FileEditor — auto-pin on first edit', () => {
  it('calls pinEditor on the group that owns the input when content changes', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: async () => undefined,
    } as never)
    services.set(IConfigurationService, new FakeConfigurationService() as never)
    services.set(IContextKeyService, new ContextKeyService())
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

  it('passes editor font size and word wrap settings to Monaco on create', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: async () => undefined,
    } as never)
    services.set(
      IConfigurationService,
      new FakeConfigurationService({
        'editor.fontSize': 20,
        'editor.fontFamily': "'Fira Code', monospace",
        'editor.wordWrap': true,
        'workbench.colorTheme': 'light',
      }) as never,
    )
    services.set(IContextKeyService, new ContextKeyService())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.txt'))
    services.set(IEditorGroupsService, new FakeGroupsService([new FakeGroup(input)]) as never)

    render(
      <ServicesContext.Provider value={inst}>
        <FileEditor input={input} />
      </ServicesContext.Provider>,
    )

    await vi.waitFor(() => {
      expect(monacoMockState.createOptions).toBeDefined()
    })
    expect(monacoMockState.createOptions).toMatchObject({
      fontSize: 20,
      fontFamily: "'Fira Code', monospace",
      wordWrap: 'on',
      theme: 'vs',
    })
  })

  it('updates live Monaco options when editor settings change', async () => {
    const services = new ServiceCollection()
    services.set(IFileService, makeFs())
    services.set(ICommandService, {
      _serviceBrand: undefined,
      executeCommand: async () => undefined,
    } as never)
    const config = new FakeConfigurationService({
      'editor.fontSize': 14,
      'editor.fontFamily': "Consolas, 'Courier New', monospace",
      'editor.wordWrap': false,
    })
    services.set(IConfigurationService, config as never)
    services.set(IContextKeyService, new ContextKeyService())
    const inst = new InstantiationService(services)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.txt'))
    services.set(IEditorGroupsService, new FakeGroupsService([new FakeGroup(input)]) as never)

    render(
      <ServicesContext.Provider value={inst}>
        <FileEditor input={input} />
      </ServicesContext.Provider>,
    )

    await vi.waitFor(() => {
      expect(monacoMockState.createOptions).toBeDefined()
    })
    config.update('editor.fontSize', 18, ConfigurationTarget.User)
    config.update('editor.fontFamily', "'JetBrains Mono', monospace", ConfigurationTarget.User)
    config.update('editor.wordWrap', true, ConfigurationTarget.User)

    expect(monacoMockState.updateOptionsCalls).toContainEqual({ fontSize: 18 })
    expect(monacoMockState.updateOptionsCalls).toContainEqual({
      fontFamily: "'JetBrains Mono', monospace",
    })
    expect(monacoMockState.updateOptionsCalls).toContainEqual({ wordWrap: 'on' })
  })
})
