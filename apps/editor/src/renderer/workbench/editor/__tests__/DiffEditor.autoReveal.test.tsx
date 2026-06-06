/*---------------------------------------------------------------------------------------------
 *  Tests for DiffEditor initial diff navigation.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

type Listener = () => void

interface DiffEditorStub {
  model: unknown
  readonly goToDiffCalls: string[]
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

  function makeCodeEditor() {
    return {
      onDidChangeCursorPosition: () => disposable(),
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
      goToDiffCalls: [] as string[],
      restoreViewStateCalls: [] as unknown[],
      setModel(model: unknown) {
        this.model = model
      },
      getOriginalEditor: () => original,
      getModifiedEditor: () => modified,
      updateOptions: () => {},
      saveViewState: () => null,
      restoreViewState(state: unknown) {
        this.restoreViewStateCalls.push(state)
      },
      onDidUpdateDiff(listener: Listener) {
        listeners.add(listener)
        return disposable(() => listeners.delete(listener))
      },
      goToDiff(target: string) {
        this.goToDiffCalls.push(target)
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
    },
  }
})

import { cleanup, render } from '@testing-library/react'
import {
  ICommandService,
  IConfigurationService,
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
}

function createInstantiationService(): InstantiationService {
  const services = new ServiceCollection()
  services.set(IConfigurationService, new FakeConfigurationService() as never)
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: async () => undefined,
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
  it('jumps to the first change after the initial diff computation', async () => {
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')
    renderDiffEditor(input, { id: 1 })

    const editor = await waitForDiffEditor()
    editor.fireUpdateDiff()

    expect(editor.goToDiffCalls).toEqual(['next'])
  })

  it('restores saved view state instead of jumping to the first change', async () => {
    const group = { id: 2 }
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')
    const savedState = { modified: { cursorState: [] } }
    EditorViewStateCache.save(group.id, input.resource.toString(), savedState)

    renderDiffEditor(input, group)

    const editor = await waitForDiffEditor()
    editor.fireUpdateDiff()

    expect(editor.restoreViewStateCalls).toEqual([savedState, savedState])
    expect(editor.goToDiffCalls).toEqual([])
  })

  it('only handles the first diff update for initial navigation', async () => {
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')
    renderDiffEditor(input, { id: 1 })

    const editor = await waitForDiffEditor()
    editor.fireUpdateDiff()
    editor.fireUpdateDiff()

    expect(editor.goToDiffCalls).toEqual(['next'])
  })
})
