/*---------------------------------------------------------------------------------------------
 *  Tests for DiffEditor initial diff navigation.
 *
 *  The mocked Monaco mirrors two real behaviours that the original test missed:
 *  attaching a model emits an initial cursor event (so flushViewState writes the
 *  cache *before* the first diff is computed), and saveViewState() returns a
 *  non-null state. Together those used to poison the view-state cache and make
 *  the editor skip the first-change reveal — the regression this suite guards.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = () => void

interface DiffEditorStub {
  model: unknown
  revealFirstDiffCalls: number
  readonly restoreViewStateCalls: unknown[]
  setModel(model: unknown): void
  fireUpdateDiff(): void
}

const monacoTestState = vi.hoisted(() => ({
  diffEditors: [] as DiffEditorStub[],
}))

vi.mock('../monaco/MonacoLoader.js', () => {
  function disposable(dispose: () => void = () => {}) {
    return { dispose }
  }

  // Monaco fires an initial cursor event while a model attaches; mimic it so the
  // DiffEditor's flushViewState runs before the diff is computed.
  function makeCodeEditor() {
    return {
      onDidChangeCursorPosition: (listener: Listener) => {
        listener()
        return disposable()
      },
      onDidScrollChange: () => disposable(),
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
    const original = makeCodeEditor()
    const modified = makeCodeEditor()
    const editor = {
      model: null as unknown,
      revealFirstDiffCalls: 0,
      restoreViewStateCalls: [] as unknown[],
      setModel(model: unknown) {
        this.model = model
      },
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      updateOptions: () => {},
      focus: () => {},
      // A freshly-created editor already has a (top-of-file) view state.
      saveViewState: () => ({ kind: 'auto-flushed' }),
      restoreViewState(state: unknown) {
        this.restoreViewStateCalls.push(state)
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
      dispose: () => {},
    }
    monacoTestState.diffEditors.push(editor)
    return editor
  }

  const monacoStub = {
    Uri: {
      parse: (value: string) => ({ toString: () => value }),
    },
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
  services.set(IContextKeyService, {
    _serviceBrand: undefined,
    set: () => {},
  } as never)
  services.set(IEditorGroupsService, {
    _serviceBrand: undefined,
    activeGroup: { activeEditor: undefined, lastActivationPreservedFocus: false },
  } as never)
  return new InstantiationService(services)
}

function renderDiffEditor(input: DiffEditorInput, group: { id: number }) {
  const instantiation = createInstantiationService()
  return render(
    <ServicesContext.Provider value={instantiation}>
      <EditorGroupContext.Provider value={group as never}>
        <DiffEditor input={input} />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>,
  )
}

async function waitForDiffEditor(): Promise<DiffEditorStub> {
  await vi.waitFor(() => {
    const editor = monacoTestState.diffEditors.at(0)
    expect(editor?.model).toBeTruthy()
  })
  const editor = monacoTestState.diffEditors.at(0)
  if (!editor) throw new Error('Diff editor was not created')
  return editor
}

afterEach(() => {
  cleanup()
  EditorViewStateCache._resetForTests()
  monacoTestState.diffEditors.length = 0
})

describe('DiffEditor auto reveal', () => {
  it('reveals the first change on a fresh open, despite the initial cursor event populating the cache', async () => {
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')
    renderDiffEditor(input, { id: 1 })

    const editor = await waitForDiffEditor()
    editor.fireUpdateDiff()

    expect(editor.revealFirstDiffCalls).toBe(1)
    expect(editor.restoreViewStateCalls).toEqual([])
  })

  it('restores saved view state instead of revealing the first change', async () => {
    const group = { id: 2 }
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')
    const savedState = { modified: { cursorState: [] } }
    EditorViewStateCache.save(group.id, input.resource.toString(), savedState)

    renderDiffEditor(input, group)

    const editor = await waitForDiffEditor()
    editor.fireUpdateDiff()

    // Applied once on open and re-applied once the diff lands — both times the
    // original snapshot, not the cache value clobbered by the initial event.
    expect(editor.restoreViewStateCalls).toEqual([savedState, savedState])
    expect(editor.revealFirstDiffCalls).toBe(0)
  })

  it('only handles the first diff update for initial navigation', async () => {
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')
    renderDiffEditor(input, { id: 1 })

    const editor = await waitForDiffEditor()
    editor.fireUpdateDiff()
    editor.fireUpdateDiff()

    expect(editor.revealFirstDiffCalls).toBe(1)
  })
})
