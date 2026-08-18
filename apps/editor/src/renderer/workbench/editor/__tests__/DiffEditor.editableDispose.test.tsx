/*---------------------------------------------------------------------------------------------
 *  Regression test: an editable (live working-tree) diff shares the file's
 *  MonacoModelRegistry model. Closing the tab disposes the DiffEditorInput
 *  synchronously BEFORE React unmounts the DiffEditor component, so the input
 *  must NOT release the shared-model ref in dispose() — Monaco's DiffEditorWidget
 *  asserts ("TextModel got disposed before DiffEditorWidget model got reset")
 *  when a model dies while still attached. The ref is owned by the component,
 *  which releases it in its set-model effect cleanup AFTER setModel(null).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

interface DiffEditorStub {
  model: { original: unknown; modified: unknown } | null
  setModel(model: unknown): void
}

const monacoTestState = vi.hoisted(() => ({
  diffEditors: [] as DiffEditorStub[],
  createModelCount: 0,
}))

vi.mock('../monaco/MonacoLoader.js', () => {
  function disposable(dispose: () => void = () => {}) {
    return { dispose }
  }
  function makeCodeEditor() {
    return {
      onDidChangeCursorPosition: () => disposable(),
      onDidScrollChange: () => disposable(),
      getPosition: () => null,
      setPosition: () => {},
      revealLineInCenter: () => {},
    }
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
    const editor = {
      model: null as { original: unknown; modified: unknown } | null,
      setModel(model: unknown) {
        this.model = model as { original: unknown; modified: unknown } | null
      },
      getOriginalEditor: () => makeCodeEditor(),
      getModifiedEditor: () => makeCodeEditor(),
      updateOptions: () => {},
      saveViewState: () => null,
      restoreViewState: () => {},
      onDidUpdateDiff: () => disposable(),
      revealFirstDiff: () => {},
      focus: () => {},
      dispose: () => {
        // Real Monaco detaches its models when the widget disposes; mirror that
        // so a model disposed after ed.dispose() is not "attached".
        editor.model = null
      },
    }
    monacoTestState.diffEditors.push(editor)
    return editor
  }
  const monacoStub = {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      createModel: (text: string, language: string, uri: unknown) => {
        monacoTestState.createModelCount++
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

import { StrictMode } from 'react'
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
import { MonacoModelRegistry } from '../monaco/MonacoModelRegistry.js'
import { EditorViewStateCache } from '../../../services/editor/EditorViewStateCache.js'
import { _resetDiffModelCacheForTests } from '../../../services/editor/diffModelCache.js'
import { ServicesContext } from '../../useService.js'
import { DiffEditor } from '../DiffEditor.js'
import { EditorGroupContext } from '../EditorGroupContext.js'

// readFileText throws → _refreshCleanBaseline treats the file as not-on-disk and
// keeps the buffer clean; the tests only exercise acquire/release ordering.
const fileService = {} as IFileService

class CountingConfigService {
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

function createInstantiationService(config: CountingConfigService): InstantiationService {
  const services = new ServiceCollection()
  services.set(IConfigurationService, config as never)
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: async () => undefined,
  } as never)
  services.set(IContextKeyService, { _serviceBrand: undefined, set: () => {} } as never)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { activeEditor: undefined, lastActivationPreservedFocus: false },
  } as never)
  return new InstantiationService(services)
}

function renderDiff(input: DiffEditorInput, instantiation: InstantiationService) {
  return render(
    <StrictMode>
      <ServicesContext.Provider value={instantiation}>
        <EditorGroupContext.Provider value={{ id: 1 } as never}>
          <DiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>
    </StrictMode>,
  )
}

const uri = URI.file('/ws/note.md')

afterEach(() => {
  cleanup()
  EditorViewStateCache._resetForTests()
  _resetDiffModelCacheForTests()
  MonacoModelRegistry._resetForTests()
  monacoTestState.diffEditors.length = 0
  monacoTestState.createModelCount = 0
})

describe('DiffEditor editable shared-model ownership', () => {
  it('keeps the shared model alive when the input is disposed before unmount', async () => {
    const instantiation = createInstantiationService(new CountingConfigService())
    const input = new DiffEditorInput(uri, 'head', 'disk', undefined, undefined, true, fileService)

    const { unmount } = renderDiff(input, instantiation)

    await vi.waitFor(() => {
      expect(monacoTestState.diffEditors.at(-1)?.model).toBeTruthy()
    })

    const widget = monacoTestState.diffEditors.at(-1)!
    const sharedModel = input.peekModifiedModel()
    expect(sharedModel).toBeTruthy()
    expect(sharedModel!.isDisposed()).toBe(false)

    // Simulate DiffEditorWidget's assertion: a model disposed while still attached
    // to the widget is an error.
    let disposedWhileAttached = false
    sharedModel!.onWillDispose(() => {
      if (widget.model?.modified === sharedModel) disposedWhileAttached = true
    })

    // closeEditor disposes the input synchronously, before React unmounts.
    input.dispose()
    expect(sharedModel!.isDisposed()).toBe(false)
    expect(disposedWhileAttached).toBe(false)

    // Unmount runs the set-model effect cleanup: setModel(null) detaches the
    // widget, then releaseModifiedModel() drops the refcount to zero.
    unmount()
    expect(disposedWhileAttached).toBe(false)
    expect(sharedModel!.isDisposed()).toBe(true)
    expect(MonacoModelRegistry.peek(uri)).toBeUndefined()
  })

  it('releases the old shared model only when the effect rewires after a flip', async () => {
    const instantiation = createInstantiationService(new CountingConfigService())
    const input = new DiffEditorInput(uri, 'head', 'disk', undefined, undefined, true, fileService)

    const { unmount } = renderDiff(input, instantiation)

    await vi.waitFor(() => {
      expect(monacoTestState.diffEditors.at(-1)?.model).toBeTruthy()
    })

    const sharedModel = input.peekModifiedModel()
    expect(sharedModel).toBeTruthy()

    // Flip editable → snapshot. The input drops dirty tracking but must NOT
    // release the model here — the component's effect cleanup does, after the
    // widget detaches and rewires to the snapshot pair.
    input.update('head', 'commit-blob', false)
    expect(input.modifiedEditable).toBe(false)
    expect(sharedModel!.isDisposed()).toBe(false)

    await vi.waitFor(() => {
      expect(sharedModel!.isDisposed()).toBe(true)
    })
    expect(MonacoModelRegistry.peek(uri)).toBeUndefined()

    input.dispose()
    unmount()
  })
})
