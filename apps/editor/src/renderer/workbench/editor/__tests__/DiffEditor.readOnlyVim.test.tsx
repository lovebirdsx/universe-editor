/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Generic DiffEditor attaches Vim to both editable working-tree diffs and
 *  read-only snapshot diffs (commit changes, timeline revisions, depot blobs,
 *  Explorer compare). The snapshot path relies on `isReadOnly` to refuse write
 *  commands while motions / search / yank / ]c / [c keep working.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

type Listener = () => void

interface CodeEditorStub {
  readOnly: boolean
  hasTextFocus(): boolean
  getOption(option: number): unknown
  onDidChangeCursorPosition(listener: Listener): { dispose(): void }
  onDidScrollChange(): { dispose(): void }
  getPosition(): { lineNumber: number; column: number }
  setPosition(): void
  revealLineInCenter(): void
}

interface DiffEditorStub {
  model: { original: unknown; modified: unknown } | null
  setModel(model: unknown): void
  getOriginalEditor(): CodeEditorStub
  getModifiedEditor(): CodeEditorStub
  updateOptions(options: { readOnly?: boolean }): void
  focus(): void
  saveViewState(): unknown
  restoreViewState(state: unknown): void
  onDidUpdateDiff(listener: Listener): { dispose(): void }
  revealFirstDiff(): void
  dispose(): void
}

const monacoTestState = vi.hoisted(() => ({
  diffEditors: [] as DiffEditorStub[],
  textFocused: false,
  createModelCalls: 0,
}))

vi.mock('../monaco/MonacoLoader.js', () => {
  const EDITOR_OPTION = { lineHeight: 5, readOnly: 4 }

  function disposable(dispose: () => void = () => {}) {
    return { dispose }
  }

  function makeCodeEditor(): CodeEditorStub {
    const editor: CodeEditorStub = {
      readOnly: true,
      hasTextFocus: () => monacoTestState.textFocused,
      getOption: (option: number) => (option === EDITOR_OPTION.lineHeight ? 23 : editor.readOnly),
      onDidChangeCursorPosition: (listener: Listener) => {
        listener()
        return disposable()
      },
      onDidScrollChange: () => disposable(),
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      setPosition: () => {},
      revealLineInCenter: () => {},
    }
    return editor
  }

  function makeModel(initial: string, language: string, uri: unknown) {
    let value = initial
    let versionId = 1
    let disposed = false
    const contentListeners = new Set<() => void>()
    const willDisposeListeners = new Set<() => void>()
    return {
      uri,
      getValue: () => value,
      setValue: (next: string) => {
        value = next
        versionId++
        for (const l of contentListeners) l()
      },
      getLanguageId: () => language,
      getAlternativeVersionId: () => versionId,
      getValueLength: () => value.length,
      isDisposed: () => disposed,
      onDidChangeContent: (cb: () => void) => {
        contentListeners.add(cb)
        return disposable(() => contentListeners.delete(cb))
      },
      onWillDispose: (cb: () => void) => {
        willDisposeListeners.add(cb)
        return disposable(() => willDisposeListeners.delete(cb))
      },
      dispose: () => {
        if (disposed) return
        for (const l of [...willDisposeListeners]) l()
        disposed = true
        contentListeners.clear()
        willDisposeListeners.clear()
      },
    }
  }

  function makeDiffEditor(): DiffEditorStub {
    const original = makeCodeEditor()
    const modified = makeCodeEditor()
    const editor: DiffEditorStub = {
      model: null,
      setModel(model: unknown) {
        editor.model = model as { original: unknown; modified: unknown } | null
      },
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      // Monaco mirrors the diff's readOnly option onto the modified sub-editor.
      updateOptions(options: { readOnly?: boolean }) {
        if (options.readOnly !== undefined) modified.readOnly = options.readOnly
      },
      focus: () => {},
      saveViewState: () => ({ kind: 'auto-flushed' }),
      restoreViewState: () => {},
      onDidUpdateDiff: () => disposable(),
      revealFirstDiff: () => {},
      dispose: () => {
        editor.model = null
      },
    }
    monacoTestState.diffEditors.push(editor)
    return editor
  }

  const monacoStub = {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      EditorOption: EDITOR_OPTION,
      createModel: (text: string, language: string, uri: unknown) => {
        monacoTestState.createModelCalls++
        return makeModel(text, language, uri)
      },
      getModel: () => null,
      createDiffEditor: () => makeDiffEditor(),
    },
  }

  return {
    MonacoLoader: {
      ensureInitialized: () => Promise.resolve(monacoStub),
      get: () => monacoStub,
      peek: () => monacoStub,
      getOverrideServices: () => ({}),
      trackEditorDispose: () => ({ dispose: () => {} }),
    },
  }
})

vi.mock('../vim/attachVim.js', () => ({
  attachVim: vi.fn(() => ({ controller: {}, dispose: vi.fn() })),
}))

import { cleanup, render } from '@testing-library/react'
import {
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../../../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../../../services/editor/DiffEditorRegistry.js'
import { EditorViewStateCache } from '../../../services/editor/EditorViewStateCache.js'
import { _resetDiffModelCacheForTests } from '../../../services/editor/diffModelCache.js'
import { MonacoModelRegistry } from '../monaco/MonacoModelRegistry.js'
import { IVimModeService } from '../../../services/vim/vimModeService.js'
import { IVimInputMethodService } from '../../../../shared/ipc/vimInputMethodService.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupContext } from '../EditorGroupContext.js'
import { attachVim } from '../vim/attachVim.js'
import { editorVimSurfaceKey } from '../vim/vimSurfaceKeys.js'
import { DiffEditor } from '../DiffEditor.js'

const fileService = {} as IFileService

class FakeConfigService {
  declare readonly _serviceBrand: undefined
  get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue
  }
  onDidChangeConfiguration() {
    return { dispose: () => {} }
  }
  getMerged<T = Record<string, unknown>>(_key: string): T {
    return {} as T
  }
}

interface ModelChangeEvent {
  readonly kind: string
  readonly editor?: unknown
  readonly replacedEditor?: unknown
}

function createVimServices() {
  return {
    vimModeService: {
      _serviceBrand: undefined,
      forgetSurface: vi.fn(),
      activateSurface: vi.fn(),
    },
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
  services.set(IConfigurationService, new FakeConfigService() as never)
  services.set(
    ICommandService,
    (options.commandService ?? {
      _serviceBrand: undefined,
      executeCommand: async () => undefined,
    }) as never,
  )
  services.set(IContextKeyService, { _serviceBrand: undefined, set: () => {} } as never)
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

const uri = URI.file('/ws/note.md')

function createInput(liveModified: boolean): DiffEditorInput {
  return new DiffEditorInput(
    uri,
    'base',
    'changed',
    undefined,
    undefined,
    liveModified,
    fileService,
  )
}

function renderDiff(
  input: DiffEditorInput,
  instantiation: InstantiationService,
  group: ReturnType<typeof createGroup>,
) {
  return render(
    <ServicesContext.Provider value={instantiation}>
      <EditorGroupContext.Provider value={group as never}>
        <DiffEditor input={input} />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>,
  )
}

async function waitForAttachment() {
  await vi.waitFor(() => {
    expect(monacoTestState.diffEditors.at(-1)?.model).toBeTruthy()
  })
  await vi.waitFor(() => {
    expect(attachVim).toHaveBeenCalled()
  })
}

function lastAttachmentOptions() {
  return vi.mocked(attachVim).mock.calls.at(-1)![0]
}

afterEach(() => {
  cleanup()
  vi.mocked(attachVim).mockClear()
  monacoTestState.diffEditors.length = 0
  monacoTestState.textFocused = false
  monacoTestState.createModelCalls = 0
  DiffEditorRegistry._resetForTests()
  EditorViewStateCache._resetForTests()
  _resetDiffModelCacheForTests()
  MonacoModelRegistry._resetForTests()
})

describe('DiffEditor read-only Vim', () => {
  it('does not attach Vim without the optional Vim services', async () => {
    const group = createGroup(10)
    renderDiff(createInput(false), createInstantiationService(), group)
    await vi.waitFor(() => {
      expect(monacoTestState.diffEditors.at(-1)?.model).toBeTruthy()
    })
    expect(attachVim).not.toHaveBeenCalled()
  })

  it('attaches Vim to the read-only modified pane', async () => {
    const input = createInput(false)
    const group = createGroup(11)
    const vim = createVimServices()
    renderDiff(input, createInstantiationService({ vim }), group)
    await waitForAttachment()

    const editor = monacoTestState.diffEditors.at(-1)!
    const options = lastAttachmentOptions()
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
    renderDiff(
      createInput(false),
      createInstantiationService({
        vim: createVimServices(),
        commandService: commandService as never,
      }),
      createGroup(12),
    )
    await waitForAttachment()

    const options = lastAttachmentOptions()
    await options.executeCommand?.('workbench.action.editor.nextChange')
    expect(commandService.executeCommand).toHaveBeenCalledWith(
      'workbench.action.editor.nextChange',
      undefined,
    )
  })

  it('keeps an editable diff writable', async () => {
    renderDiff(
      createInput(true),
      createInstantiationService({ vim: createVimServices() }),
      createGroup(13),
    )
    await waitForAttachment()

    expect(lastAttachmentOptions().isReadOnly?.()).toBe(false)
  })

  it('disposes the Vim attachment on unmount', async () => {
    const result = renderDiff(
      createInput(false),
      createInstantiationService({ vim: createVimServices() }),
      createGroup(14),
    )
    await waitForAttachment()
    const attachment = vi.mocked(attachVim).mock.results.at(-1)!.value as { dispose: Mock }

    result.unmount()
    expect(attachment.dispose).toHaveBeenCalled()
  })

  it('forgets the Vim surface when the tab is closed or replaced', async () => {
    const input = createInput(false)
    const group = createGroup(15)
    const vim = createVimServices()
    renderDiff(input, createInstantiationService({ vim }), group)
    await waitForAttachment()

    const key = editorVimSurfaceKey(group.id, input.id)
    group.emitModelChange({ kind: 'close', editor: input })
    expect(vim.vimModeService.forgetSurface).toHaveBeenLastCalledWith(key)
    group.emitModelChange({ kind: 'replace', replacedEditor: input })
    expect(vim.vimModeService.forgetSurface).toHaveBeenLastCalledWith(key)
    group.emitModelChange({ kind: 'previewReplace', replacedEditor: input })
    expect(vim.vimModeService.forgetSurface).toHaveBeenLastCalledWith(key)
  })

  it('forgets the Vim surface when the whole group closes', async () => {
    const input = createInput(false)
    const group = createGroup(16)
    const vim = createVimServices()
    const result = renderDiff(input, createInstantiationService({ vim, groups: [] }), group)
    await waitForAttachment()

    vim.vimModeService.forgetSurface.mockClear()
    result.unmount()
    expect(vim.vimModeService.forgetSurface).toHaveBeenCalledWith(
      editorVimSurfaceKey(group.id, input.id),
    )
  })

  it('republishes the active surface when editability flips in place', async () => {
    const input = createInput(true)
    const group = createGroup(17)
    const vim = createVimServices()
    monacoTestState.textFocused = true
    renderDiff(input, createInstantiationService({ vim }), group)
    await waitForAttachment()

    vim.vimModeService.activateSurface.mockClear()
    input.update('new base', 'new changed', false)
    const key = editorVimSurfaceKey(group.id, input.id)
    await vi.waitFor(() => {
      expect(vim.vimModeService.activateSurface).toHaveBeenLastCalledWith({
        surfaceKey: key,
        kind: 'editor',
        id: key,
        defaultMode: 'normal',
      })
    })
  })

  it('reattaches Vim as writable when a read-only snapshot flips to editable', async () => {
    const input = createInput(false)
    const group = createGroup(18)
    const vim = createVimServices()
    renderDiff(input, createInstantiationService({ vim }), group)
    await waitForAttachment()
    const snapshotAttachment = vi.mocked(attachVim).mock.results.at(-1)!.value as {
      dispose: Mock
    }
    expect(lastAttachmentOptions().isReadOnly?.()).toBe(true)

    input.update('new base', 'new changed', true)
    await vi.waitFor(() => {
      expect(lastAttachmentOptions().isReadOnly?.()).toBe(false)
    })
    expect(snapshotAttachment.dispose).toHaveBeenCalled()
  })
})
