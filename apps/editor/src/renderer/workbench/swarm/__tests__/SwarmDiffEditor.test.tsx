import { cleanup, render } from '@testing-library/react'
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

vi.mock('../../editor/monaco/MonacoLoader.js', () => {
  function disposable(dispose: () => void = () => {}) {
    return { dispose }
  }

  function makeModel(uri: unknown) {
    return { uri, dispose: () => {} }
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
      createModel: (_text: string, _language: string, uri: unknown) => makeModel(uri),
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

vi.mock('../SwarmInlineCommentController.js', () => ({
  SwarmInlineCommentController: class {
    setComments() {}
    dispose() {}
  },
}))

import {
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorGroupsService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { SwarmDiffEditorInput } from '../../../services/editor/SwarmDiffEditorInput.js'
import { DiffEditorRegistry } from '../../../services/editor/DiffEditorRegistry.js'
import { EditorViewStateCache } from '../../../services/editor/EditorViewStateCache.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupContext } from '../../editor/EditorGroupContext.js'
import { SwarmDiffEditor } from '../SwarmDiffEditor.js'

function createInstantiationService(): InstantiationService {
  const services = new ServiceCollection()
  services.set(IConfigurationService, {
    _serviceBrand: undefined,
    get: (_key: string, defaultValue?: unknown) => defaultValue,
    getMerged: () => ({}),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  } as never)
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: async () => [],
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
  DiffEditorRegistry._resetForTests()
  EditorViewStateCache._resetForTests()
  monacoTestState.diffEditors.length = 0
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
})
