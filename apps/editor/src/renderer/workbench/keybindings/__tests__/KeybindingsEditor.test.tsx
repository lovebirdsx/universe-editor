import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import {
  CommandsRegistry,
  Emitter,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { KeybindingsEditor } from '../KeybindingsEditor.js'
import {
  IUserKeybindingsService,
  type IUserKeybindingsService as IUserKeybindingsServiceType,
} from '../../../services/keybindings/UserKeybindingsService.js'
import { KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT } from '../../preferences/preferencesFocus.js'

function registerVisibleCommand(): IDisposable[] {
  return [
    CommandsRegistry.registerCommand('test.keybindings.open', () => undefined, {
      description: 'Open Test Command',
      category: 'Test',
    }),
    KeybindingsRegistry.registerKeybinding({
      key: 'ctrl+alt+t',
      command: 'test.keybindings.open',
    }),
  ]
}

function mount() {
  const onDidChangeEmitter = new Emitter<void>()
  const userKeybindingsService: IUserKeybindingsServiceType = {
    _serviceBrand: undefined,
    onDidChange: onDidChangeEmitter.event,
    userEntries: [],
    disabledCommands: [],
    initialize: async () => undefined,
    reload: async () => undefined,
    setKeybinding: vi.fn(),
    resetKeybinding: vi.fn(),
    getUserEntry: () => undefined,
    getDefaultKey: () => undefined,
    diagnostics: { vscodeFilePath: undefined, vscodeParsedCount: 0, vscodeRegisteredCount: 0 },
  }

  const services = new ServiceCollection()
  services.set(IUserKeybindingsService, userKeybindingsService)
  const instantiation = new InstantiationService(services)

  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <KeybindingsEditor />
    </ServicesContext.Provider>,
  )

  return { ...utils, onDidChangeEmitter, userKeybindingsService }
}

describe('KeybindingsEditor', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('focuses the search input on mount', async () => {
    disposables.push(...registerVisibleCommand())
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(search))
  })

  it('re-focuses the search input when the focus event fires', async () => {
    disposables.push(...registerVisibleCommand())
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(search))

    const other = document.createElement('button')
    document.body.appendChild(other)
    other.focus()
    expect(document.activeElement).toBe(other)

    act(() => {
      document.dispatchEvent(new Event(KEYBINDINGS_EDITOR_FOCUS_SEARCH_EVENT))
    })

    await waitFor(() => expect(document.activeElement).toBe(search))
    other.remove()
  })

  it('focuses the recorder input when editing a keybinding', async () => {
    disposables.push(...registerVisibleCommand())
    const { container } = mount()
    const editButton = container.querySelector(
      'button[title="Edit keybinding"]',
    ) as HTMLButtonElement
    fireEvent.click(editButton)

    const recorderInput = container.querySelector(
      'input[placeholder="Press a key…"]',
    ) as HTMLInputElement

    await waitFor(() => expect(document.activeElement).toBe(recorderInput))
  })
})
