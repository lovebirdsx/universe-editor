import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import {
  ContextKeyService,
  ICommandService,
  IContextKeyService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../useService.js'
import { useGlobalKeybindingHandler } from '../useGlobalKeybindingHandler.js'

function TestHost() {
  useGlobalKeybindingHandler()
  return null
}

function createHarness() {
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const commandService = { _serviceBrand: undefined, executeCommand }
  const services = new ServiceCollection()
  services.set(ICommandService, commandService as never)
  services.set(IContextKeyService, new ContextKeyService())
  const instantiation = new InstantiationService(services)
  return { executeCommand, instantiation }
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
