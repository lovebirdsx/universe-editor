import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  CommandsRegistry,
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  IStatusBarService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { ServicesContext } from '../useService.js'
import { useGlobalKeybindingHandler } from '../useGlobalKeybindingHandler.js'
import { IKeyboardDebugService } from '../../services/keybinding/keyboardDebugService.js'
import { SplitEditorDownAction } from '../../actions/editorActions.js'
import { OpenKeybindingsEditorAction } from '../../actions/preferencesActions.js'
import { OpenFolderAction } from '../../actions/workspaceActions.js'

function TestHost() {
  useGlobalKeybindingHandler()
  return null
}

function createHarness() {
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const commandService = { _serviceBrand: undefined, executeCommand }
  const statusBar = new StatusBarService()
  const services = new ServiceCollection()
  services.set(ICommandService, commandService as never)
  services.set(IContextKeyService, new ContextKeyService())
  services.set(IStatusBarService, statusBar)
  services.set(IKeyboardDebugService, {
    _serviceBrand: undefined,
    enabled: false,
    onDidChange: () => ({ dispose() {} }),
    toggle: () => false,
    append: () => {},
  } as never)
  const instantiation = new InstantiationService(services)
  return { executeCommand, instantiation, statusBar }
}

interface DispatchOpts extends KeyboardEventInit {
  from?: HTMLElement
}

function dispatch(opts: DispatchOpts = {}) {
  const { from, ...init } = opts
  const target = from ?? document.body
  const event = new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init })
  const preventDefault = vi.spyOn(event, 'preventDefault')
  const stopPropagation = vi.spyOn(event, 'stopPropagation')
  target.dispatchEvent(event)
  return { event, preventDefault, stopPropagation }
}

describe('useGlobalKeybindingHandler', () => {
  let disposables: IDisposable[] = []

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
    document.body.innerHTML = ''
  })

  function bind(key: string, command: string) {
    disposables.push(KeybindingsRegistry.registerKeybinding({ key, command }))
    disposables.push(CommandsRegistry.registerCommand(command, () => {}))
  }

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  it('resolves bound key and executes the command', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('ctrl+b', 'test.toggle')
    mountHost(instantiation)

    const { preventDefault, stopPropagation } = dispatch({ ctrlKey: true, key: 'b' })
    expect(executeCommand).toHaveBeenCalledWith('test.toggle')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['ArrowLeft', 'ctrl+left'],
    ['ArrowRight', 'ctrl+right'],
    ['ArrowUp', 'ctrl+up'],
    ['ArrowDown', 'ctrl+down'],
  ])('maps browser key %s to canonical %s for keybinding lookup', (domKey, binding) => {
    const { executeCommand, instantiation } = createHarness()
    bind(binding, 'test.arrowCmd')
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: domKey })
    expect(executeCommand).toHaveBeenCalledWith('test.arrowCmd')
  })

  it.each([
    ['Digit5', '%', 'ctrl+shift+5'],
    ['Backquote', '~', 'ctrl+shift+`'],
  ])('resolves shift-mutated %s via e.code so %s still matches %s', (code, shiftedKey, binding) => {
    const { executeCommand, instantiation } = createHarness()
    bind(binding, 'test.codeCmd')
    mountHost(instantiation)

    dispatch({ ctrlKey: true, shiftKey: true, key: shiftedKey, code })
    expect(executeCommand).toHaveBeenCalledWith('test.codeCmd')
  })

  it('does nothing when no keybinding matches', () => {
    const { executeCommand, instantiation } = createHarness()
    mountHost(instantiation)

    const { preventDefault } = dispatch({ key: 'q' })
    expect(executeCommand).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('does not swallow plain typing in an INPUT element', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('b', 'test.bareB')
    mountHost(instantiation)

    const input = document.createElement('input')
    document.body.appendChild(input)
    const { preventDefault } = dispatch({ key: 'b', from: input })

    expect(executeCommand).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
  })

  // The handler resolves *before* the editable-target check decides whether to
  // bail. Function keys (F1, ArrowDown, Tab, Escape, …) have e.key.length > 1
  // so the "looks-like-typing" guard does NOT bail; the registry binding fires
  // even when focus is inside a textarea/input. This matches VSCode.
  it('non-printable function key (F1) on editable target STILL fires registry binding', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('f1', 'test.help')
    mountHost(instantiation)

    const input = document.createElement('input')
    document.body.appendChild(input)
    dispatch({ key: 'F1', from: input })

    expect(executeCommand).toHaveBeenCalledWith('test.help')
  })

  it('does not swallow shift-only typing (capital letters) in editable target', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('shift+a', 'test.cap')
    mountHost(instantiation)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    dispatch({ shiftKey: true, key: 'A', from: textarea })

    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('does not swallow Delete in editable target even if a global Delete binding exists', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('delete', 'workbench.files.action.delete')
    mountHost(instantiation)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    const { preventDefault, stopPropagation } = dispatch({ key: 'Delete', from: textarea })

    expect(executeCommand).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('still fires when ctrl is pressed inside editable target', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('ctrl+b', 'test.toggle')
    mountHost(instantiation)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    dispatch({ ctrlKey: true, key: 'b', from: textarea })

    expect(executeCommand).toHaveBeenCalledWith('test.toggle')
  })

  it('treats contenteditable element the same as INPUT', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('b', 'test.bareB')
    mountHost(instantiation)

    const div = document.createElement('div')
    div.contentEditable = 'true'
    document.body.appendChild(div)
    dispatch({ key: 'b', from: div })

    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('detaches the listener on unmount', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('ctrl+b', 'test.toggle')
    const view = mountHost(instantiation)
    view.unmount()

    dispatch({ ctrlKey: true, key: 'b' })
    expect(executeCommand).not.toHaveBeenCalled()
  })
})

describe('useGlobalKeybindingHandler — chord support', () => {
  let disposables: IDisposable[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    disposables.forEach((d) => d.dispose())
    disposables = []
    document.body.innerHTML = ''
  })

  function bindChord(chords: readonly [string, string], command: string) {
    disposables.push(KeybindingsRegistry.registerKeybinding({ chords, command }))
    disposables.push(CommandsRegistry.registerCommand(command, () => {}))
  }

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  it('shows status bar entry on first chord stroke and clears on completion', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    const first = dispatch({ ctrlKey: true, key: 'k' })
    expect(first.preventDefault).toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(1)
    expect(statusBar.entries.get()[0]!.entry.text).toContain('Ctrl+K')
    expect(executeCommand).not.toHaveBeenCalled()

    const second = dispatch({ ctrlKey: true, key: 's' })
    expect(second.preventDefault).toHaveBeenCalled()
    expect(executeCommand).toHaveBeenCalledWith('chord.openSettings')
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it('non-matching second stroke aborts the chord without firing a command', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    expect(statusBar.entries.get()).toHaveLength(1)

    dispatch({ key: 'x' })
    expect(executeCommand).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it('chord pending entry auto-clears after 1.5s timeout', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    expect(statusBar.entries.get()).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1600)
    })

    expect(statusBar.entries.get()).toHaveLength(0)
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('cleans up pending chord on unmount', () => {
    const { instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    const view = mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    expect(statusBar.entries.get()).toHaveLength(1)

    view.unmount()
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it('ignores standalone modifier keydown events', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'Control' })
    expect(executeCommand).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it.each([
    ['ArrowLeft', 'ctrl+left', 'chord.focusLeft'],
    ['ArrowRight', 'ctrl+right', 'chord.focusRight'],
    ['ArrowUp', 'ctrl+up', 'chord.focusUp'],
    ['ArrowDown', 'ctrl+down', 'chord.focusDown'],
  ])('maps browser key %s in second chord stroke to canonical %s', (domKey, _binding, command) => {
    const { executeCommand, instantiation } = createHarness()
    bindChord(['ctrl+k', _binding], command)
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    dispatch({ ctrlKey: true, key: domKey })
    expect(executeCommand).toHaveBeenCalledWith(command)
  })
})

describe('useGlobalKeybindingHandler — ESC always fires globally', () => {
  let disposables: IDisposable[] = []

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
    document.body.innerHTML = ''
  })

  function bind(key: string, command: string) {
    disposables.push(KeybindingsRegistry.registerKeybinding({ key, command }))
    disposables.push(CommandsRegistry.registerCommand(command, () => {}))
  }

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  // ESC 必须能穿透 isEditableTarget 守卫，这样当焦点在 Output 面板的 <select>
  // 或其他非编辑类但被归为"editable"的元素上时，ESC 仍能将焦点还给编辑器。
  //
  // 新机制下不靠 ESC 硬编码特例：ESC 的 e.key === 'Escape' 长度为 6，不是单字符，
  // 因此不会命中 isPrintableTyping 早退分支，会进入 registry 解析路径。
  // 这些 test 验证 registry-driven 路径在 editable target 上仍能命中 ESC binding。

  it('fires escape-bound command even when a SELECT element is focused', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('escape', 'test.focusEditor')
    mountHost(instantiation)

    const select = document.createElement('select')
    document.body.appendChild(select)
    dispatch({ key: 'Escape', from: select })

    expect(executeCommand).toHaveBeenCalledWith('test.focusEditor')
  })

  it('fires escape-bound command even when an INPUT element is focused', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('escape', 'test.focusEditor')
    mountHost(instantiation)

    const input = document.createElement('input')
    document.body.appendChild(input)
    dispatch({ key: 'Escape', from: input })

    expect(executeCommand).toHaveBeenCalledWith('test.focusEditor')
  })

  it('fires escape-bound command even when a contenteditable div is focused', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('escape', 'test.focusEditor')
    mountHost(instantiation)

    const div = document.createElement('div')
    div.contentEditable = 'true'
    document.body.appendChild(div)
    dispatch({ key: 'Escape', from: div })

    expect(executeCommand).toHaveBeenCalledWith('test.focusEditor')
  })
})

// ---------------------------------------------------------------------------
// ContextKey-driven ESC routing. With the refactor, ESC no longer has any
// hardcoded path through the global handler — every consumer registers an
// `escape` keybinding with a `when` clause, and the registry's reverse-iter
// resolution picks the binding whose `when` matches the current context.
//
// Concretely: when Quick Input is visible, `quickInputVisible` is true and
// the CloseQuickInputAction-style binding wins; when it's not visible the
// FocusActiveEditorGroupAction-style binding wins. The handler itself stays
// agnostic — it just forwards whichever command the registry returns.
// ---------------------------------------------------------------------------
describe('useGlobalKeybindingHandler — ESC routing by contextKey', () => {
  let disposables: IDisposable[] = []

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
    document.body.innerHTML = ''
  })

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  it('routes ESC to different commands depending on quickInputVisible', () => {
    const { executeCommand, instantiation } = createHarness()
    const contextKeyService = instantiation.invokeFunction((a) => a.get(IContextKeyService))
    const quickInputVisible = contextKeyService.createKey<boolean>('quickInputVisible', false)

    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'escape',
        command: 'test.focusEditor',
        when: '!quickInputVisible',
      }),
    )
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'escape',
        command: 'test.closeQuickInput',
        when: 'quickInputVisible',
      }),
    )
    disposables.push(CommandsRegistry.registerCommand('test.focusEditor', () => {}))
    disposables.push(CommandsRegistry.registerCommand('test.closeQuickInput', () => {}))
    mountHost(instantiation)

    // quickInputVisible=false → focus editor
    dispatch({ key: 'Escape' })
    expect(executeCommand).toHaveBeenLastCalledWith('test.focusEditor')

    // Flip the key, dispatch again → close quick input
    quickInputVisible.set(true)
    dispatch({ key: 'Escape' })
    expect(executeCommand).toHaveBeenLastCalledWith('test.closeQuickInput')

    // Flip back → focus editor again
    quickInputVisible.set(false)
    dispatch({ key: 'Escape' })
    expect(executeCommand).toHaveBeenLastCalledWith('test.focusEditor')

    expect(executeCommand).toHaveBeenCalledTimes(3)
  })
})

describe('useGlobalKeybindingHandler — QuickInput isolation', () => {
  let disposables: IDisposable[] = []

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
    document.body.innerHTML = ''
  })

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  function showQuickInput(instantiation: InstantiationService): HTMLInputElement {
    const contextKeyService = instantiation.invokeFunction((a) => a.get(IContextKeyService))
    contextKeyService.createKey<boolean>('quickInputVisible', true)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    return input
  }

  it('leaves Ctrl+N for QuickInput navigation without executing the workbench command', () => {
    const { executeCommand, instantiation } = createHarness()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+n',
        command: 'workbench.action.files.newUntitledFile',
      }),
    )
    const input = showQuickInput(instantiation)
    mountHost(instantiation)

    const { preventDefault, stopPropagation } = dispatch({ ctrlKey: true, key: 'n', from: input })

    expect(executeCommand).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('still routes Escape to the QuickInput close command', () => {
    const { executeCommand, instantiation } = createHarness()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'escape',
        command: 'workbench.action.closeQuickInput',
        when: 'quickInputVisible',
      }),
    )
    const input = showQuickInput(instantiation)
    mountHost(instantiation)

    const { preventDefault, stopPropagation } = dispatch({ key: 'Escape', from: input })

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.closeQuickInput')
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('does not enter chord mode while QuickInput is visible', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        chords: ['ctrl+k', 'ctrl+s'],
        command: 'workbench.action.openGlobalKeybindings',
      }),
    )
    const input = showQuickInput(instantiation)
    mountHost(instantiation)

    const { preventDefault, stopPropagation } = dispatch({ ctrlKey: true, key: 'k', from: input })

    expect(executeCommand).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
  })

  it('leaves native input editing shortcuts such as Ctrl+A alone', () => {
    const { executeCommand, instantiation } = createHarness()
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+a',
        command: 'test.globalSelectAll',
      }),
    )
    const input = showQuickInput(instantiation)
    mountHost(instantiation)

    const { preventDefault, stopPropagation } = dispatch({ ctrlKey: true, key: 'a', from: input })

    expect(executeCommand).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })
})

describe('useGlobalKeybindingHandler — popover nav routing by contextKey', () => {
  let disposables: IDisposable[] = []

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
    document.body.innerHTML = ''
  })

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  // The prompt suggestion commands register their navigation keys (Ctrl+J/N/P,
  // arrows, Tab, Enter, Escape) with `when: acpPromptPopupVisible`, last, so the
  // newest-wins resolver routes those keys to them while the popover is open and
  // lets any global binding win otherwise. There is no hardcoded handler
  // special-case (the old `isNavPopupOwnedKey` pass-through is gone).
  it('routes Ctrl+N to the popover command only while acpPromptPopupVisible is true', () => {
    const { executeCommand, instantiation } = createHarness()
    const contextKeyService = instantiation.invokeFunction((a) => a.get(IContextKeyService))
    const popupVisible = contextKeyService.createKey<boolean>('acpPromptPopupVisible', false)

    disposables.push(
      KeybindingsRegistry.registerKeybinding({ key: 'ctrl+n', command: 'test.global' }),
    )
    disposables.push(
      KeybindingsRegistry.registerKeybinding({
        key: 'ctrl+n',
        command: 'test.popoverNext',
        when: 'acpPromptPopupVisible',
      }),
    )
    disposables.push(CommandsRegistry.registerCommand('test.global', () => {}))
    disposables.push(CommandsRegistry.registerCommand('test.popoverNext', () => {}))
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    mountHost(instantiation)

    // Popover open → routes to the suggestion command, consuming the key so the
    // textarea never sees it.
    popupVisible.set(true)
    const open = dispatch({ ctrlKey: true, key: 'n', from: ta })
    expect(executeCommand).toHaveBeenLastCalledWith('test.popoverNext')
    expect(open.preventDefault).toHaveBeenCalled()
    expect(open.stopPropagation).toHaveBeenCalled()

    // Popover closed → the global binding wins again.
    popupVisible.set(false)
    dispatch({ ctrlKey: true, key: 'n', from: ta })
    expect(executeCommand).toHaveBeenLastCalledWith('test.global')
  })
})

describe('useGlobalKeybindingHandler — ctrl+k ctrl+s end-to-end', () => {
  const disposables: IDisposable[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    disposables.push(registerAction2(SplitEditorDownAction))
    disposables.push(registerAction2(OpenKeybindingsEditorAction))
    disposables.push(registerAction2(OpenFolderAction))
  })

  afterEach(() => {
    vi.useRealTimers()
    while (disposables.length > 0) disposables.pop()?.dispose()
    document.body.innerHTML = ''
  })

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  it('ctrl+k enters chord mode even with SplitEditorDown registered on the same first key', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    mountHost(instantiation)

    const first = dispatch({ ctrlKey: true, key: 'k' })
    expect(first.preventDefault).toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(1)
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('ctrl+k ctrl+s completes the chord and fires OpenKeybindingsEditorAction', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    expect(statusBar.entries.get()).toHaveLength(1)

    const second = dispatch({ ctrlKey: true, key: 's' })
    expect(second.preventDefault).toHaveBeenCalled()
    expect(executeCommand).toHaveBeenCalledWith(OpenKeybindingsEditorAction.ID)
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it('ctrl+k ctrl+o completes the chord and fires OpenFolderAction', () => {
    const { executeCommand, instantiation } = createHarness()
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    dispatch({ ctrlKey: true, key: 'o' })

    expect(executeCommand).toHaveBeenCalledWith(OpenFolderAction.ID)
  })

  it('ctrl+k followed by an unbound key aborts the chord without firing any command', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    expect(statusBar.entries.get()).toHaveLength(1)

    dispatch({ key: 'z' })
    expect(executeCommand).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it('SplitEditorDown is NOT fired when ctrl+k would enter chord mode', () => {
    const { executeCommand, instantiation } = createHarness()
    mountHost(instantiation)

    dispatch({ ctrlKey: true, key: 'k' })
    expect(executeCommand).not.toHaveBeenCalledWith(SplitEditorDownAction.ID)
  })
})

// ---------------------------------------------------------------------------
// Monaco interop: the handler must use document capture phase so that inner-
// element bubble listeners (like Monaco's internal chord dispatcher) cannot
// hide the first chord stroke by calling stopPropagation() before the event
// reaches a window-level bubble listener.
// ---------------------------------------------------------------------------
describe('useGlobalKeybindingHandler — Monaco interop (capture phase)', () => {
  let disposables: IDisposable[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    disposables.forEach((d) => d.dispose())
    disposables = []
    document.body.innerHTML = ''
  })

  function bindChord(chords: readonly [string, string], command: string) {
    disposables.push(KeybindingsRegistry.registerKeybinding({ chords, command }))
    disposables.push(CommandsRegistry.registerCommand(command, () => {}))
  }

  function mountHost(instantiation: InstantiationService) {
    return render(
      <ServicesContext.Provider value={instantiation}>
        <TestHost />
      </ServicesContext.Provider>,
    )
  }

  // Simulates Monaco's inner container calling stopPropagation() on the first
  // chord stroke (Ctrl+K).  A window-level bubble listener would never see this
  // event; a document capture listener fires first and is unaffected.
  it('enters chord mode even when an inner bubble listener stops propagation on the first stroke', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    // Simulate Monaco container that swallows Ctrl+K in bubble phase.
    const monacoContainer = document.createElement('div')
    document.body.appendChild(monacoContainer)
    monacoContainer.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'k') e.stopPropagation()
    })

    const innerTextarea = document.createElement('textarea')
    monacoContainer.appendChild(innerTextarea)

    const first = dispatch({ ctrlKey: true, key: 'k', from: innerTextarea })
    expect(first.preventDefault).toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(1)
    expect(executeCommand).not.toHaveBeenCalled()
  })

  // Simulates Monaco also stopping propagation on the second chord stroke.
  it('completes the chord even when an inner bubble listener stops propagation on the second stroke', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    const monacoContainer = document.createElement('div')
    document.body.appendChild(monacoContainer)
    // Monaco stops propagation on both Ctrl+K and Ctrl+S in bubble phase.
    monacoContainer.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 'k' || e.key === 's')) e.stopPropagation()
    })

    const innerTextarea = document.createElement('textarea')
    monacoContainer.appendChild(innerTextarea)

    dispatch({ ctrlKey: true, key: 'k', from: innerTextarea })
    expect(statusBar.entries.get()).toHaveLength(1)

    const second = dispatch({ ctrlKey: true, key: 's', from: innerTextarea })
    expect(second.preventDefault).toHaveBeenCalled()
    expect(executeCommand).toHaveBeenCalledWith('chord.openSettings')
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  // Chord abort also works when inner bubble listener is present.
  it('aborts chord when second stroke does not match, even with inner bubble stopPropagation', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    const monacoContainer = document.createElement('div')
    document.body.appendChild(monacoContainer)
    monacoContainer.addEventListener('keydown', (e) => e.stopPropagation())

    const innerTextarea = document.createElement('textarea')
    monacoContainer.appendChild(innerTextarea)

    dispatch({ ctrlKey: true, key: 'k', from: innerTextarea })
    expect(statusBar.entries.get()).toHaveLength(1)

    dispatch({ key: 'z', from: innerTextarea })
    expect(executeCommand).not.toHaveBeenCalled()
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  // Chord timeout still works regardless of Monaco interference.
  it('chord times out even when dispatched from inside a Monaco-like container', () => {
    const { executeCommand, instantiation, statusBar } = createHarness()
    bindChord(['ctrl+k', 'ctrl+s'], 'chord.openSettings')
    mountHost(instantiation)

    const monacoContainer = document.createElement('div')
    document.body.appendChild(monacoContainer)
    monacoContainer.addEventListener('keydown', (e) => e.stopPropagation())

    const innerTextarea = document.createElement('textarea')
    monacoContainer.appendChild(innerTextarea)

    dispatch({ ctrlKey: true, key: 'k', from: innerTextarea })
    expect(statusBar.entries.get()).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(1600)
    })

    expect(statusBar.entries.get()).toHaveLength(0)
    expect(executeCommand).not.toHaveBeenCalled()
  })
})
