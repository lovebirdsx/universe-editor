/*---------------------------------------------------------------------------------------------
 *  Regression: switching a diff tab away and back (diff ↔ file) must preserve the
 *  diff's scroll/cursor. The DiffEditor unmounts on that switch, and React runs
 *  effect cleanups in declaration order — so the editor-create effect (declared
 *  first) used to dispose the Monaco instance *before* the view-state effect's
 *  cleanup flushed, leaving nothing cached and snapping the remounted diff to the
 *  top. This test drives that ordering with a Monaco stub whose saveViewState()
 *  returns null once disposed, and asserts a live view state survives unmount.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

interface DiffEditorStub {
  model: unknown
  disposed: boolean
  scrollTop: number
  setModel(model: unknown): void
  fireUpdateDiff(): void
}

const monacoTestState = vi.hoisted(() => ({
  diffEditors: [] as DiffEditorStub[],
}))

vi.mock('../monaco/MonacoLoader.js', () => {
  type Listener = () => void
  function disposable(dispose: () => void = () => {}) {
    return { dispose }
  }
  function makeCodeEditor() {
    return {
      onDidChangeCursorPosition: () => disposable(),
      onDidScrollChange: () => disposable(),
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      setPosition: () => {},
      revealLineInCenter: () => {},
    }
  }
  function makeModel(initial: string, language: string, uri: unknown) {
    let value = initial
    return {
      uri,
      getValue: () => value,
      setValue: (next: string) => {
        value = next
      },
      getLanguageId: () => language,
      dispose: () => {},
    }
  }
  function makeDiffEditor(): DiffEditorStub {
    const listeners = new Set<Listener>()
    const editor = {
      model: null as unknown,
      disposed: false,
      scrollTop: 120,
      setModel(model: unknown) {
        this.model = model
      },
      getOriginalEditor: () => makeCodeEditor(),
      getModifiedEditor: () => makeCodeEditor(),
      updateOptions: () => {},
      focus: () => {},
      // A live editor reports its scroll; a disposed one returns null (mirrors
      // Monaco, whose saveViewState() no longer produces state after dispose()).
      saveViewState(this: DiffEditorStub) {
        return this.disposed ? null : { scrollTop: this.scrollTop }
      },
      restoreViewState: () => {},
      onDidUpdateDiff(listener: Listener) {
        listeners.add(listener)
        return disposable(() => listeners.delete(listener))
      },
      revealFirstDiff: () => {},
      fireUpdateDiff() {
        for (const l of [...listeners]) l()
      },
      dispose(this: DiffEditorStub) {
        this.disposed = true
      },
    }
    monacoTestState.diffEditors.push(editor)
    return editor
  }
  const monacoStub = {
    Uri: { parse: (value: string) => ({ toString: () => value }) },
    editor: {
      createModel: (text: string, language: string, uri: unknown) => makeModel(text, language, uri),
      createDiffEditor: () => makeDiffEditor(),
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
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../../../services/editor/DiffEditorInput.js'
import { EditorViewStateCache } from '../../../services/editor/EditorViewStateCache.js'
import { ServicesContext } from '../../useService.js'
import { DiffEditor } from '../DiffEditor.js'
import { EditorGroupContext } from '../EditorGroupContext.js'

class FakeConfigurationService {
  declare readonly _serviceBrand: undefined
  get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue
  }
  onDidChangeConfiguration() {
    return { dispose() {} }
  }
  getMerged<T = Record<string, unknown>>(_key: string): T {
    return {} as T
  }
}

function createInstantiationService(): InstantiationService {
  const services = new ServiceCollection()
  services.set(IConfigurationService, new FakeConfigurationService() as never)
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

afterEach(() => {
  cleanup()
  EditorViewStateCache._resetForTests()
  monacoTestState.diffEditors.length = 0
})

describe('DiffEditor view-state survives unmount (diff ↔ file switch)', () => {
  it('flushes a live view state before disposing the editor on unmount', async () => {
    const instantiation = createInstantiationService()
    const group = { id: 7 }
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')

    const { unmount } = render(
      <ServicesContext.Provider value={instantiation}>
        <EditorGroupContext.Provider value={group as never}>
          <DiffEditor input={input} />
        </EditorGroupContext.Provider>
      </ServicesContext.Provider>,
    )

    const editor = await vi.waitFor(() => {
      const e = monacoTestState.diffEditors.at(0)
      expect(e?.model).toBeTruthy()
      return e!
    })
    editor.fireUpdateDiff()

    unmount()

    // The final flush must have read the LIVE editor (scrollTop 120), not the
    // already-disposed one (which reports null and would leave the cache empty →
    // scroll reset on remount).
    const saved = EditorViewStateCache.load(group.id, input.resource.toString()) as {
      scrollTop?: number
    } | null
    expect(saved).not.toBeNull()
    expect(saved?.scrollTop).toBe(120)
  })
})
