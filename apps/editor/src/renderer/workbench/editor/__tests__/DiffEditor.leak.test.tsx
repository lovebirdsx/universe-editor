/*---------------------------------------------------------------------------------------------
 *  Regression test: DiffEditor must dispose every platform-event subscription it
 *  opens (configService.onDidChangeConfiguration, diffInput.onDidChangeContent)
 *  when it unmounts. These are tracked Disposables; a missing useEffect cleanup
 *  leaks them on "Restart Editor". Wrapped in StrictMode to mirror main.tsx and
 *  exercise the mount → cleanup → reconnect passive-effect cycle.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

interface DiffEditorStub {
  model: unknown
  setModel(model: unknown): void
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
    const editor = {
      model: null as unknown,
      setModel(model: unknown) {
        this.model = model
      },
      getOriginalEditor: () => makeCodeEditor(),
      getModifiedEditor: () => makeCodeEditor(),
      updateOptions: () => {},
      saveViewState: () => null,
      restoreViewState: () => {},
      onDidUpdateDiff: () => disposable(),
      revealFirstDiff: () => {},
      dispose: () => {},
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

import { StrictMode } from 'react'
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

class CountingConfigService {
  declare readonly _serviceBrand: undefined
  subscribeCount = 0
  disposeCount = 0

  get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue
  }

  onDidChangeConfiguration() {
    this.subscribeCount++
    return {
      dispose: () => {
        this.disposeCount++
      },
    }
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
  return new InstantiationService(services)
}

afterEach(() => {
  cleanup()
  EditorViewStateCache._resetForTests()
  monacoTestState.diffEditors.length = 0
})

describe('DiffEditor disposal', () => {
  it('disposes every config + content subscription on unmount', async () => {
    const config = new CountingConfigService()
    const instantiation = createInstantiationService(config)
    const input = new DiffEditorInput(URI.file('/ws/a.txt'), 'before\n', 'after\n')

    let contentSubscribeCount = 0
    let contentDisposeCount = 0
    vi.spyOn(input, 'onDidChangeContent').mockImplementation((() => {
      contentSubscribeCount++
      return {
        dispose: () => {
          contentDisposeCount++
        },
      }
    }) as never)

    const { unmount } = render(
      <StrictMode>
        <ServicesContext.Provider value={instantiation}>
          <EditorGroupContext.Provider value={{ id: 1 } as never}>
            <DiffEditor input={input} />
          </EditorGroupContext.Provider>
        </ServicesContext.Provider>
      </StrictMode>,
    )

    await vi.waitFor(() => {
      expect(monacoTestState.diffEditors.at(0)?.model).toBeTruthy()
    })

    // Both effects must have subscribed at least once before we check teardown.
    expect(config.subscribeCount).toBeGreaterThan(0)
    expect(contentSubscribeCount).toBeGreaterThan(0)

    unmount()

    // Every subscription opened must have been disposed by an effect cleanup.
    expect(config.disposeCount).toBe(config.subscribeCount)
    expect(contentDisposeCount).toBe(contentSubscribeCount)
  })
})
