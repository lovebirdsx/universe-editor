import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import {
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  IStatusBarService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { StatusBarService } from '../statusbar/StatusBarService.js'
import { ServicesContext } from '../useService.js'
import { useGlobalKeybindingHandler } from '../useGlobalKeybindingHandler.js'

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

  it('does not swallow shift-only typing (capital letters) in editable target', () => {
    const { executeCommand, instantiation } = createHarness()
    bind('shift+a', 'test.cap')
    mountHost(instantiation)

    const textarea = document.createElement('textarea')
    document.body.appendChild(textarea)
    dispatch({ shiftKey: true, key: 'A', from: textarea })

    expect(executeCommand).not.toHaveBeenCalled()
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
