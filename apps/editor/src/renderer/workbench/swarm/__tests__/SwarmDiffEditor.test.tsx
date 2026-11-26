import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = () => void

interface DiffEditorStub {
  model: unknown
  revealFirstDiffCalls: number
  readonly restoreViewStateCalls: unknown[]
  setModel(model: unknown): void
  fireUpdateDiff(): void
  getOriginalEditor(): unknown
  getModifiedEditor(): unknown
}

const monacoTestState = vi.hoisted(() => ({
  diffEditors: [] as DiffEditorStub[],
  createModelCalls: 0,
}))

vi.mock('../../editor/monaco/MonacoLoader.js', () => {
  const EDITOR_OPTION = { lineHeight: 5, readOnly: 4 }

  function disposable(dispose: () => void = () => {}) {
    return { dispose }
  }

  function makeModel(text: string, uri: unknown) {
    return {
      uri,
      value: text,
      getValue() {
        return this.value as string
      },
      setValue(next: string) {
        this.value = next
      },
      dispose: () => {},
    }
  }

  // Monaco fires an initial cursor event while a model attaches; mimic it so the
  // view-state flush runs before the diff is computed.
  function makeCodeEditor() {
    return {
      onDidChangeCursorPosition: (listener: Listener) => {
        listener()
        return disposable()
      },
      onDidScrollChange: () => disposable(),
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      setPosition: () => {},
      revealLineInCenter: () => {},
      getOption: (option: number) => (option === EDITOR_OPTION.lineHeight ? 23 : true),
    }
  }

  function makeDiffEditor(): DiffEditorStub {
    const listeners = new Set<Listener>()
    const original = makeCodeEditor()
    const modified = makeCodeEditor()
    const editor = {
      model: null as unknown,
      revealFirstDiffCalls: 0,
      restoreViewStateCalls: [] as unknown[],
      setModel(model: unknown) {
        this.model = model
      },
      onDidUpdateDiff(listener: Listener) {
        listeners.add(listener)
        return disposable(() => listeners.delete(listener))
      },
      revealFirstDiff() {
        this.revealFirstDiffCalls++
      },
      fireUpdateDiff() {
        for (const listener of [...listeners]) listener()
      },
      // A freshly-created editor already has a (top-of-file) view state.
      saveViewState: () => ({ kind: 'auto-flushed' }),
      restoreViewState(state: unknown) {
        this.restoreViewStateCalls.push(state)
      },
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      focus: () => {},
      dispose: () => {},
    }
    monacoTestState.diffEditors.push(editor)
    return editor
  }

  const monacoStub = {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      EditorOption: EDITOR_OPTION,
      createModel: (text: string, _language: string, uri: unknown) => {
        monacoTestState.createModelCalls++
        return makeModel(text, uri)
      },
      createDiffEditor: () => makeDiffEditor(),
    },
  }

  return {
    MonacoLoader: {
      ensureInitialized: () => Promise.resolve(monacoStub),
      get: () => monacoStub,
      getOverrideServices: () => ({}),
      trackEditorDispose: () => ({ dispose: () => {} }),
    },
  }
})

vi.mock('../SwarmInlineCommentController.js', () => ({
  SwarmInlineCommentController: class {
    setComments() {}
    dispose() {}
  },
}))

vi.mock('../../editor/vim/attachVim.js', () => ({
  attachVim: vi.fn(() => ({ controller: {}, dispose: vi.fn() })),
}))

import {
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
  type IFileService,
} from '@universe-editor/platform'
import { SwarmDiffEditorInput } from '../../../services/editor/SwarmDiffEditorInput.js'
import { DiffEditorRegistry } from '../../../services/editor/DiffEditorRegistry.js'
import { EditorViewStateCache } from '../../../services/editor/EditorViewStateCache.js'
import { _resetDiffModelCacheForTests } from '../../../services/editor/diffModelCache.js'
import { IVimModeService } from '../../../services/vim/vimModeService.js'
import { IVimInputMethodService } from '../../../../shared/ipc/vimInputMethodService.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupContext } from '../../editor/EditorGroupContext.js'
import { attachVim } from '../../editor/vim/attachVim.js'
import { editorVimSurfaceKey } from '../../editor/vim/vimSurfaceKeys.js'
import { SwarmDiffEditor } from '../SwarmDiffEditor.js'

function createVimServices() {
  return {
    vimModeService: { _serviceBrand: undefined, forgetSurface: vi.fn() },
    vimInputMethodService: { _serviceBrand: undefined },
  }
}

function createInstantiationService(
  options: {
    vim?: ReturnType<typeof createVimServices>
    commandService?: ICommandService
    groups?: unknown[]
  } = {},
): InstantiationService {
  const services = new ServiceCollection()
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (_key: string, defaultValue?: unknown) => defaultValue,
    getMerged: () => ({}),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  } as never)
  services.set(
    ICommandService,
    (options.commandService ?? {
      _serviceBrand: undefined,
      executeCommand: async () => [],
    }) as never,
  )
  services.set(IContextKeyService, {
    _serviceBrand: undefined,
    set: () => {},
  } as never)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { activeEditor: undefined, lastActivationPreservedFocus: false },
    ...(options.groups !== undefined ? { groups: options.groups } : {}),
  } as never)
  if (options.vim !== undefined) {
    services.set(IVimModeService, options.vim.vimModeService as never)
    services.set(IVimInputMethodService, options.vim.vimInputMethodService as never)
  }
  return new InstantiationService(services)
}

interface ModelChangeEvent {
  readonly kind: string
  readonly editor?: unknown
  readonly replacedEditor?: unknown
}

function createGroup(id: number) {
  const listeners = new Set<(event: ModelChangeEvent) => void>()
  return {
    id,
    onDidChangeModel(listener: (event: ModelChangeEvent) => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    emitModelChange(event: ModelChangeEvent) {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

function createInput() {
  return new SwarmDiffEditorInput(
    {
      reviewId: '1001',
      depotFile: '//depot/src/a.ts',
      displayPath: 'depot/src/a.ts',
      localPath: 'C:/workspace/src/a.ts',
      leftVersion: 0,
      rightVersion: 1,
    },
    'before\n',
    'after\n',
    {} as IFileService,
  )
}

async function waitForDiffEditor(): Promise<DiffEditorStub> {
  await vi.waitFor(() => expect(monacoTestState.diffEditors.at(0)?.model).toBeTruthy())
  const editor = monacoTestState.diffEditors.at(0)
  if (!editor) throw new Error('Diff editor was not created')
  return editor
}

afterEach(() => {
  cleanup()
  vi.mocked(attachVim).mockClear()
  DiffEditorRegistry._resetForTests()
  EditorViewStateCache._resetForTests()
  _resetDiffModelCacheForTests()
  monacoTestState.diffEditors.length = 0
  monacoTestState.createModelCalls = 0
})

describe('SwarmDiffEditor', () => {
  it('registers the Monaco diff and reveals only the first diff update', async () => {
    const input = createInput()
    const group = { id: 7 }
    const result = render(
      <ServicesContext.Provider value={createInstantiationService()}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )

    const editor = await waitForDiffEditor()
    expect(DiffEditorRegistry.get(input, group.id)).toBe(editor)

    editor.fireUpdateDiff()
    editor.fireUpdateDiff()
    expect(editor.revealFirstDiffCalls).toBe(1)

    result.unmount()
    expect(DiffEditorRegistry.get(input, group.id)).toBeUndefined()
  })

  it('restores a saved view state instead of revealing the first change', async () => {
    const input = createInput()
    const group = { id: 8 }
    const savedState = { modified: { cursorState: [] } }
    EditorViewStateCache.save(group.id, input.resource.toString(), savedState)

    render(
      <ServicesContext.Provider value={createInstantiationService()}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )

    const editor = await waitForDiffEditor()
    editor.fireUpdateDiff()

    // Applied once on open and re-applied once the diff lands — both the original
    // snapshot, not the cache value clobbered by the initial cursor event.
    expect(editor.restoreViewStateCalls).toEqual([savedState, savedState])
    expect(editor.revealFirstDiffCalls).toBe(0)
  })

  it('persists the view state on unmount', async () => {
    const input = createInput()
    const group = { id: 9 }
    const result = render(
      <ServicesContext.Provider value={createInstantiationService()}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )

    await waitForDiffEditor()
    result.unmount()

    expect(EditorViewStateCache.load(group.id, input.resource.toString())).toEqual({
      kind: 'auto-flushed',
    })
  })

  it('updates the live models in place when the input content changes', async () => {
    const input = createInput()
    render(
      <ServicesContext.Provider value={createInstantiationService()}>
        <EditorGroupContext.Provider value={{ id: 10 } as never}>
          <SwarmDiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    const editor = await waitForDiffEditor()
    const model = editor.model as {
      original: { getValue(): string }
      modified: { getValue(): string }
    }
    expect(model.original.getValue()).toBe('before\n')
    expect(model.modified.getValue()).toBe('after\n')

    // A re-shelved pending version re-opened onto the same tab: updateFrom mutates
    // the input, the mounted editor must refresh instead of showing stale text.
    input.update('re-shelved left\n', 're-shelved right\n')
    expect(model.original.getValue()).toBe('re-shelved left\n')
    expect(model.modified.getValue()).toBe('re-shelved right\n')
  })

  it('reuses the cached models on a remount with identical content', async () => {
    const group = { id: 11 }
    const first = render(
      <ServicesContext.Provider value={createInstantiationService()}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={createInput()} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    const firstEditor = await waitForDiffEditor()
    const firstModel = firstEditor.model as { original: unknown; modified: unknown }
    expect(monacoTestState.createModelCalls).toBe(2)
    first.unmount()

    // Same id + same text: the second mount takes the LRU pair back instead of
    // rebuilding (createModel + tokenize are the cost this avoids).
    render(
      <ServicesContext.Provider value={createInstantiationService()}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={createInput()} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    await vi.waitFor(() => expect(monacoTestState.diffEditors.at(1)?.model).toBeTruthy())
    expect(monacoTestState.createModelCalls).toBe(2)
    const secondModel = monacoTestState.diffEditors.at(1)?.model as {
      original: unknown
      modified: unknown
    }
    expect(secondModel.original).toBe(firstModel.original)
    expect(secondModel.modified).toBe(firstModel.modified)
  })

  it('does not attach Vim without the optional Vim services', async () => {
    render(
      <ServicesContext.Provider value={createInstantiationService()}>
        <EditorGroupContext.Provider value={{ id: 12 } as never}>
          <SwarmDiffEditor input={createInput()} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    await waitForDiffEditor()
    expect(attachVim).not.toHaveBeenCalled()
  })

  it('attaches Vim to the read-only modified pane', async () => {
    const input = createInput()
    const group = createGroup(13)
    const vim = createVimServices()
    render(
      <ServicesContext.Provider value={createInstantiationService({ vim })}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    const editor = await waitForDiffEditor()

    expect(attachVim).toHaveBeenCalledTimes(1)
    const options = vi.mocked(attachVim).mock.calls[0]![0]
    expect(options.editor).toBe(editor.getModifiedEditor())
    expect(options.editor).not.toBe(editor.getOriginalEditor())
    expect(options.surfaceKey()).toBe(editorVimSurfaceKey(group.id, input.id))
    expect(options.isReadOnly?.()).toBe(true)
    expect(options.getLineHeight?.()).toBe(23)
    expect(options.vimModeService).toBe(vim.vimModeService)
    expect(options.inputMethodService).toBe(vim.vimInputMethodService)
  })

  it('routes ]c / [c through the command service', async () => {
    const commandService = { _serviceBrand: undefined, executeCommand: vi.fn(async () => []) }
    render(
      <ServicesContext.Provider
        value={createInstantiationService({
          vim: createVimServices(),
          commandService: commandService as never,
        })}
      >
        <EditorGroupContext.Provider value={createGroup(14) as never}>
          <SwarmDiffEditor input={createInput()} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    await waitForDiffEditor()

    const options = vi.mocked(attachVim).mock.calls[0]![0]
    await options.executeCommand?.('workbench.action.editor.nextChange')
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      'workbench.action.editor.nextChange',
      undefined,
    )
  })

  it('disposes the Vim attachment on unmount', async () => {
    const result = render(
      <ServicesContext.Provider value={createInstantiationService({ vim: createVimServices() })}>
        <EditorGroupContext.Provider value={createGroup(15) as never}>
          <SwarmDiffEditor input={createInput()} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    await waitForDiffEditor()
    const attachment = vi.mocked(attachVim).mock.results[0]!.value as { dispose(): void }

    result.unmount()
    expect(attachment.dispose).toHaveBeenCalledTimes(1)
  })

  it('forgets the Vim surface when the tab is closed', async () => {
    const input = createInput()
    const group = createGroup(16)
    const vim = createVimServices()
    render(
      <ServicesContext.Provider value={createInstantiationService({ vim })}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    await waitForDiffEditor()

    group.emitModelChange({ kind: 'close', editor: input })
    expect(vim.vimModeService.forgetSurface).toHaveBeenCalledWith(
      editorVimSurfaceKey(group.id, input.id),
    )
  })

  it('forgets the Vim surface when the whole group closes', async () => {
    const input = createInput()
    const group = createGroup(17)
    const vim = createVimServices()
    const result = render(
      <ServicesContext.Provider value={createInstantiationService({ vim, groups: [] })}>
        <EditorGroupContext.Provider value={group as never}>
          <SwarmDiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )
    await waitForDiffEditor()

    result.unmount()
    expect(vim.vimModeService.forgetSurface).toHaveBeenCalledWith(
      editorVimSurfaceKey(group.id, input.id),
    )
  })
})
