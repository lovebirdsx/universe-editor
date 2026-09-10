/*---------------------------------------------------------------------------------------------
 *  Tests for LogOutputView: per-channel model switching, view-state save, and
 *  auto-scroll initialization. Asserts on the service-layer models (the Monaco
 *  stub editor only mirrors a textarea for prompt-style tests).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import * as monacoStub from 'monaco-editor'
import {
  CommandsRegistry,
  IContextKeyService,
  IEditorGroupsService,
  IFocusableRegistry,
  IFileService,
  IInstantiationService,
  IOutputService,
  InstantiationService,
  ServiceCollection,
  URI,
  registerAction2,
  type FocusableElementGetter,
  type IDisposable,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
import {
  IOutputModelService,
  OutputModelService,
} from '../../../../services/output/OutputModelService.js'
import { FileEditorInput } from '../../../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../../../services/editor/FileEditorRegistry.js'
import { FindInFileAction } from '../../../../actions/searchActions.js'
import { ServicesContext } from '../../../useService.js'
import { LogOutputView, isScrolledToBottom } from '../LogOutputView.js'

// The monaco stub's scroll geometry / scroll-event hooks are test-only exports
// (vitest aliases `monaco-editor` to the stub at runtime). Typecheck resolves
// `monaco-editor` to the real package types, which lack them — hence the
// `as unknown as` narrowing, same pattern as PromptInput.test.tsx.
const {
  _fireScrollChangeForTests,
  _resetScrollGeometryForTests,
  _setScrollGeometryForTests,
  _getActionRunsForTests,
  _resetActionRunsForTests,
} = monacoStub as unknown as {
  _fireScrollChangeForTests(): void
  _resetScrollGeometryForTests(): void
  _setScrollGeometryForTests(g: {
    scrollTop: number
    scrollHeight: number
    viewportHeight: number
  }): void
  _getActionRunsForTests(): readonly string[]
  _resetActionRunsForTests(): void
}

function makeStorage(): IStorageService {
  return {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService
}

function setup(
  viewId?: string,
  opts?: { wrapInViewBody?: boolean; contextKeys?: IContextKeyService },
) {
  const output = new OutputService(makeStorage())
  const models = new OutputModelService(output, makeStorage())
  const services = new ServiceCollection()
  services.set(IOutputService, output)
  services.set(IOutputModelService, models)
  // Left unbound unless a test asks for it: the bridge must stay a soft
  // dependency so the view keeps working without the context-key subsystem.
  if (opts?.contextKeys) services.set(IContextKeyService, opts.contextKeys)
  const registered = new Map<string, FocusableElementGetter>()
  const registry = {
    register: vi.fn((id: string, getter: FocusableElementGetter) => {
      registered.set(id, getter)
      return { dispose: () => registered.delete(id) }
    }),
    get: (id: string) => registered.get(id),
  }
  services.set(IFocusableRegistry, registry as unknown as IFocusableRegistry)
  const instantiation = new InstantiationService(services)
  const body = (
    <ServicesContext.Provider value={instantiation}>
      <LogOutputView fontSize={13} fontFamily="monospace" viewId={viewId} />
    </ServicesContext.Provider>
  )
  const view = render(
    opts?.wrapInViewBody && viewId ? (
      // Stand-in for the production ViewBody fallback container: the element
      // focusView() lands on when the primary getter can't resolve yet.
      <div data-view-id={viewId} tabIndex={-1}>
        {body}
      </div>
    ) : (
      body
    ),
  )
  return { output, models, registry, registered, view }
}

async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

describe('LogOutputView', () => {
  it('acquires and seeds the model of the active channel', async () => {
    const { output, models } = setup()
    const ch = output.createChannel('main')
    ch.append('hello\n')
    await settle()
    expect(models.peekModel('main')?.getValue()).toBe('hello\n')
  })

  it('mirrors later flushes into the mounted model', async () => {
    const { output, models } = setup()
    const ch = output.createChannel('main')
    ch.append('hello\n')
    await settle()

    ch.appendLine('world')
    await settle()
    expect(models.peekModel('main')?.getValue()).toBe('hello\nworld\n')
  })

  it('saves the previous channel view state when switching channels', async () => {
    const { output, models } = setup()
    const saveSpy = vi.spyOn(models, 'saveViewState')
    output.createChannel('main').append('x')
    await settle()

    output.createChannel('debug')
    output.setActiveChannel('debug')
    await settle()

    expect(saveSpy).toHaveBeenCalledWith('main', null)
  })

  it('re-acquires a distinct model per channel', async () => {
    const { output, models } = setup()
    output.createChannel('main').append('m\n')
    output.createChannel('debug').append('d\n')
    await settle()

    output.setActiveChannel('debug')
    await settle()
    expect(models.peekModel('debug')?.getValue()).toBe('d\n')
    expect(models.peekModel('main')).toBeDefined()
    expect(models.peekModel('debug')).not.toBe(models.peekModel('main'))
  })

  it('initializes autoScroll from the restored position (stub reports bottom)', async () => {
    const { output, models } = setup()
    models.setAutoScroll(false)
    output.createChannel('main').append('x')
    await settle()
    expect(models.autoScroll.get()).toBe(true)
  })

  it('does NOT release the auto-scroll lock when a mid-scroll event arrives while following the tail (Bug: scroll listener misjudges programmatic reveal)', async () => {
    // Repro for the auto-scroll-lock bug: while following the tail (autoScroll
    // = true, cursor at the bottom), new output arrives and revealLastLine()
    // scrolls to the new tail. Monaco fires onDidScrollChange ASYNCHRONOUSLY,
    // after the synchronous `applyingRevealRef` guard has already been reset.
    // At that moment the editor sits at a mid-scroll position (scrollHeight
    // already grew from the appended text, scrollTop hasn't landed at the
    // bottom yet), so `isScrolledToBottom` returns false — and the scroll
    // listener wrongly calls setAutoScroll(false), releasing the lock. The
    // correct behavior (VSCode outputView parity): only an explicit cursor
    // move (onDidChangeCursorPosition, reason Explicit) toggles the lock; a
    // scroll event must never release it.
    const { output, models } = setup()
    output.createChannel('main').append('line1\nline2\n')
    await settle()
    // Sanity: we start following the tail (stub geometry defaults to bottom).
    expect(models.autoScroll.get()).toBe(true)

    // Simulate the mid-scroll state a programmatic reveal passes through:
    // content grew (scrollHeight 200) but the viewport hasn't reached the
    // bottom (scrollTop 0, viewport 100 → 0+100 < 200-20 → not at bottom).
    _setScrollGeometryForTests({ scrollTop: 0, scrollHeight: 200, viewportHeight: 100 })
    try {
      act(() => {
        _fireScrollChangeForTests()
      })
      // The scroll event must NOT release the follow-tail lock.
      expect(models.autoScroll.get()).toBe(true)
    } finally {
      _resetScrollGeometryForTests()
    }
  })

  it('parks the cursor at the end of the last line on first attach', async () => {
    const { output, models } = setup()
    output.createChannel('main').append('hello\nworld\n')
    await settle()
    const model = models.peekModel('main')
    expect(model).toBeDefined()
    // The stub editor mirrors setPosition into the textarea selection; read the
    // cursor back through the model to assert it landed past the last line.
    const lastLine = model!.getLineCount()
    expect(model!.getLineContent(lastLine)).toBe('')
  })

  it('registers the editor as the view focus target so keyboard input reaches Monaco', async () => {
    const { output, registry, registered } = setup('workbench.view.output.main')
    output.createChannel('main').append('x')
    await settle()
    expect(registry.register).toHaveBeenCalledWith(
      'workbench.view.output.main',
      expect.any(Function),
      { fallback: false },
    )
    const getter = registered.get('workbench.view.output.main')
    // editContext 模式下 Monaco 的键盘焦点元素是 div.native-edit-context
    //（FocusTracker + 所有 keydown 挂它）；同 DOM 的 textarea.ime-text-area 是
    // tabindex=-1 aria-hidden 的 IME 占位，聚焦它键盘事件落空。getter 必须返回
    // 前者，否则 LayoutService.focusView 对着错误元素轮询超时、焦点滞留。
    const el = getter?.() as HTMLElement | null
    expect(el).toBeTruthy()
    expect(el?.classList.contains('native-edit-context')).toBe(true)
    expect(el?.classList.contains('ime-text-area')).toBe(false)
  })

  it('focus lands on the native-edit-context element, not the IME placeholder', async () => {
    const { output, registered } = setup('workbench.view.output.main')
    output.createChannel('main').append('x')
    await settle()
    const getter = registered.get('workbench.view.output.main')
    const el = getter?.() as HTMLElement | null
    el?.focus()
    // The element the registry hands to LayoutService.focusView must be the one
    // that actually takes DOM focus (LayoutService asserts activeElement === el).
    expect(document.activeElement).toBe(el)
    expect(
      (document.activeElement as HTMLElement | null)?.classList.contains('ime-text-area'),
    ).toBe(false)
  })

  it('pulls focus into the editor when it becomes ready while focus sits on the view fallback (Bug: async primary strands focus on the ViewBody container)', async () => {
    // Repro for the first-open-of-a-channel focus bug (no MRU dot): focusView()
    // polls `registry.get(viewId)` and lands DOM focus on the ViewBody fallback
    // container, because the primary getter can't resolve to `.native-edit-context`
    // until the Monaco editor finishes its async create. By the time the editor
    // IS ready, focusView has already returned "success" (activeElement ===
    // fallback container) and the one-shot registry handover at registration time
    // has already been missed. Result: focus stays stranded on the fallback
    // container and the editor is never keyboard-reachable. The view must reclaim
    // focus into Monaco once its editor becomes ready while focus is parked on
    // its own fallback container.
    const { output } = setup('workbench.view.output.main', { wrapInViewBody: true })
    const fallback = document.querySelector(
      '[data-view-id="workbench.view.output.main"]',
    ) as HTMLElement
    expect(fallback).toBeTruthy()

    // focusView() "succeeds" against the fallback before the editor is ready
    // (this happens during the editor's async create in production).
    fallback.focus()
    expect(document.activeElement).toBe(fallback)

    output.createChannel('main').append('x')
    // Wait for the async editor create so `.native-edit-context` exists.
    await settle()
    const nativeEditContext = document.querySelector('.native-edit-context')
    expect(nativeEditContext).toBeTruthy()

    // The editor is now live but focus is still parked on the fallback. The view
    // must notice and reclaim focus into Monaco.
    expect(document.activeElement).toBe(nativeEditContext)
  })
})

describe('LogOutputView editorFocus bridge', () => {
  // The global Escape binding bows out on `editorFocus`, and Monaco's own find
  // widget closes the editor on Escape. If the Output editor never claims the
  // key, Escape jumps to the editor group instead of closing the find widget.
  // FileEditor maintains it for group editors; this view has to do the same.
  function makeContextKeyService() {
    const values = new Map<string, unknown>()
    const service = {
      _serviceBrand: undefined,
      get: (key: string) => values.get(key),
      set: vi.fn((key: string, value: unknown) => {
        values.set(key, value)
      }),
    }
    return { service, values }
  }

  async function mountFocused() {
    const ctx = makeContextKeyService()
    const { output, view } = setup('workbench.view.output.main', {
      contextKeys: ctx.service as unknown as IContextKeyService,
    })
    output.createChannel('main').append('x')
    await settle()
    const nativeEditContext = document.querySelector('.native-edit-context') as HTMLElement
    expect(nativeEditContext).toBeTruthy()
    return { ctx, view, nativeEditContext }
  }

  it('claims editorFocus while the log editor holds DOM focus', async () => {
    const { ctx, view, nativeEditContext } = await mountFocused()

    act(() => nativeEditContext.focus())
    expect(ctx.values.get('editorFocus')).toBe(true)

    view.unmount()
  })

  it('releases editorFocus on blur (recomputed from the DOM, not hardcoded)', async () => {
    const { ctx, view, nativeEditContext } = await mountFocused()
    act(() => nativeEditContext.focus())
    expect(ctx.values.get('editorFocus')).toBe(true)

    act(() => nativeEditContext.blur())
    await settle()
    expect(ctx.values.get('editorFocus')).toBe(false)

    view.unmount()
  })

  it('does not leave editorFocus stuck true when the view unmounts while focused', async () => {
    const { ctx, view, nativeEditContext } = await mountFocused()
    act(() => nativeEditContext.focus())
    expect(ctx.values.get('editorFocus')).toBe(true)

    view.unmount()
    expect(ctx.values.get('editorFocus')).toBe(false)
  })
})

describe('Output editor claims the Find commands', () => {
  // Bug: Ctrl+F in the Output panel opened the find widget in the *file editor
  // above* (or did nothing). The Find actions resolved their target through
  // `getActiveTextEditor()` — the active group's editor — which the Output
  // editor is not. They must follow the DOM focus instead, like VSCode's
  // `getFocusedCodeEditor()`. This mounts the real view, focuses it and runs the
  // real Find command, so it covers the whole chain: view focus → editorFocus →
  // getFocusedMonacoEditor() → resolveFindTargetEditor().
  const disposables: IDisposable[] = []

  beforeEach(() => {
    _resetActionRunsForTests()
  })

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    FileEditorRegistry._resetForTests()
  })

  function stubFs() {
    return {
      _serviceBrand: undefined,
      async readFile() {
        return new Uint8Array()
      },
      async stat() {
        throw new Error('not used')
      },
    }
  }

  it('routes Ctrl+F to the Output editor, never to the active file editor', async () => {
    const ctx = {
      _serviceBrand: undefined,
      get: () => undefined,
      set: vi.fn(),
    }
    const output = new OutputService(makeStorage())
    const models = new OutputModelService(output, makeStorage())
    const services = new ServiceCollection()
    services.set(IOutputService, output)
    services.set(IOutputModelService, models)
    services.set(IContextKeyService, ctx as unknown as IContextKeyService)
    services.set(IFocusableRegistry, {
      register: () => ({ dispose: () => {} }),
      get: () => null,
    } as unknown as IFocusableRegistry)
    services.set(IFileService, stubFs() as never)
    const instantiation = new InstantiationService(services)
    services.set(IInstantiationService, instantiation)
    // A file editor is open and registered: the pre-fix bug was opening ITS find
    // widget while the user was looking at the Output panel.
    const fileInput = instantiation.createInstance(FileEditorInput, URI.file('/ws/a.ts'))
    disposables.push({ dispose: () => fileInput.dispose() })
    const fileGetAction = vi.fn(() => ({ run: vi.fn() }))
    FileEditorRegistry.register(fileInput, { getAction: fileGetAction } as never)
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { id: 1, activeEditor: fileInput },
    } as never)
    disposables.push(registerAction2(FindInFileAction))

    render(
      <ServicesContext.Provider value={instantiation}>
        <LogOutputView fontSize={13} fontFamily="monospace" viewId="workbench.view.output.main" />
      </ServicesContext.Provider>,
    )
    output.createChannel('main').append('needle\n')
    await settle()

    const nativeEditContext = document.querySelector('.native-edit-context') as HTMLElement
    act(() => nativeEditContext.focus())
    expect(ctx.set).toHaveBeenCalledWith('editorFocus', true)

    await instantiation.invokeFunction((accessor) => {
      CommandsRegistry.getCommand(FindInFileAction.ID)!.handler(accessor)
    })

    expect(_getActionRunsForTests()).toEqual(['actions.find'])
    expect(fileGetAction).not.toHaveBeenCalled()
  })
})

describe('isScrolledToBottom', () => {
  const fakeEditor = (scrollTop: number, scrollHeight: number, height: number) =>
    ({
      getScrollTop: () => scrollTop,
      getScrollHeight: () => scrollHeight,
      getLayoutInfo: () => ({ height }),
    }) as never

  it('is true within the threshold and false above it', () => {
    expect(isScrolledToBottom(fakeEditor(200, 400, 200))).toBe(true)
    expect(isScrolledToBottom(fakeEditor(181, 400, 200))).toBe(true)
    expect(isScrolledToBottom(fakeEditor(100, 400, 200))).toBe(false)
  })
})
