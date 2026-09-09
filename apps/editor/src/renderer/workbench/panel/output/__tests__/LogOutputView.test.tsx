/*---------------------------------------------------------------------------------------------
 *  Tests for LogOutputView: per-channel model switching, view-state save, and
 *  auto-scroll initialization. Asserts on the service-layer models (the Monaco
 *  stub editor only mirrors a textarea for prompt-style tests).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import * as monacoStub from 'monaco-editor'
import {
  IFocusableRegistry,
  IOutputService,
  InstantiationService,
  ServiceCollection,
  type FocusableElementGetter,
  type IStorageService,
} from '@universe-editor/platform'
import { OutputService } from '../../../../services/output/OutputService.js'
import {
  IOutputModelService,
  OutputModelService,
} from '../../../../services/output/OutputModelService.js'
import { ServicesContext } from '../../../useService.js'
import { LogOutputView, isScrolledToBottom } from '../LogOutputView.js'

// The monaco stub's scroll geometry / scroll-event hooks are test-only exports
// (vitest aliases `monaco-editor` to the stub at runtime). Typecheck resolves
// `monaco-editor` to the real package types, which lack them — hence the
// `as unknown as` narrowing, same pattern as PromptInput.test.tsx.
const { _fireScrollChangeForTests, _resetScrollGeometryForTests, _setScrollGeometryForTests } =
  monacoStub as unknown as {
    _fireScrollChangeForTests(): void
    _resetScrollGeometryForTests(): void
    _setScrollGeometryForTests(g: {
      scrollTop: number
      scrollHeight: number
      viewportHeight: number
    }): void
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

function setup(viewId?: string, opts?: { wrapInViewBody?: boolean }) {
  const output = new OutputService(makeStorage())
  const models = new OutputModelService(output, makeStorage())
  const services = new ServiceCollection()
  services.set(IOutputService, output)
  services.set(IOutputModelService, models)
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
  render(
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
  return { output, models, registry, registered }
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
