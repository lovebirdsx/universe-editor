/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  VimDispatcher: guard order, surface routing, counts, sequences, yield rules.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import {
  ContextKeyService,
  KeybindingsRegistry,
  KeybindingWeight,
  type IDisposable,
} from '@universe-editor/platform'
import {
  __resetVimSurfacesForTests,
  registerVimSurface,
  type IVimKeymapEntry,
  type IVimSurfaceRegistration,
  type VimSurfaceKind,
  type VimSurfaceMode,
} from '@universe-editor/workbench-ui'
import { VimDispatcher } from '../vimDispatcher.js'
import type { IVimActiveSurface, IVimModeService } from '../../../services/vim/vimModeService.js'

const win = new Window()
const doc = win.document as unknown as Document

const KEYMAP: readonly IVimKeymapEntry[] = [
  { id: 'down', keys: ['j'], command: 'list.focusDown' },
  { id: 'first', keys: ['g', 'g'], command: 'list.focusFirst' },
  { id: 'last', keys: ['G'], command: 'list.focusLast' },
  { id: 'toggle', keys: ['z', 'a'], command: 'list.toggle' },
  { id: 'termDown', keys: ['j'], command: 'workbench.action.terminal.normalScrollLineDown' },
]

interface FakeVim extends IVimModeService {
  modes: Map<string, VimSurfaceMode>
  keymap: readonly IVimKeymapEntry[]
  reserved: readonly string[]
  passThrough: boolean
}

function createVim(overrides: Partial<FakeVim> = {}): FakeVim {
  const modes = new Map<string, VimSurfaceMode>()
  const fake: FakeVim = {
    _serviceBrand: undefined,
    onDidChangeMode: (() => ({ dispose: () => undefined })) as never,
    getEnabled: () => true,
    getMode: (key, fallback) => modes.get(key) ?? fallback,
    setMode: (key, mode) => {
      modes.set(key, mode)
    },
    forgetSurface: (key) => {
      modes.delete(key)
    },
    activateSurface: (surface: IVimActiveSurface | undefined) => {
      Object.defineProperty(fake, 'activeSurface', { value: surface, configurable: true })
    },
    activeSurface: undefined,
    getEffectiveKeymap: () => KEYMAP,
    getUserKeymap: () => [],
    reservedKeys: ['escape', 'i', 'a', ':', '/', '?', 'space'],
    getSequenceTimeoutMs: () => 50,
    getPassThroughUnmappedKeys: () => false,
    getLeader: () => 'space',
    getShowStatusBar: () => true,
    isSurfaceEnabled: () => true,
    modes,
    keymap: KEYMAP,
    reserved: ['escape', 'i', 'a', ':', '/', '?', 'space'],
    passThrough: false,
    ...overrides,
  }
  return fake
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  __resetVimSurfacesForTests()
  doc.body.innerHTML = ''
  vi.useRealTimers()
})

function createContext(): ContextKeyService {
  const context = new ContextKeyService()
  cleanups.push(() => context.dispose())
  return context
}

function createDispatcher(
  options: {
    vim?: FakeVim
    context?: ContextKeyService
    handleStroke?: (event: KeyboardEvent) => boolean
  } = {},
) {
  const commands = vi.fn(async () => undefined)
  const vim = options.vim ?? createVim()
  const context = options.context ?? createContext()
  const dispatcher = new VimDispatcher({
    commandService: { executeCommand: commands } as never,
    contextKeyService: context,
    vimModeService: vim,
  })
  return { commands, vim, context, dispatcher }
}

function surface(
  kind: VimSurfaceKind,
  el: HTMLElement | null,
  options: Partial<IVimSurfaceRegistration> = {},
): IVimSurfaceRegistration {
  return {
    id: `${kind}-1`,
    kind,
    getElement: () => el,
    getSurfaceKey: () => `${kind}:1`,
    defaultMode: 'normal',
    actions: {},
    ...options,
  }
}

function element(tag = 'div'): HTMLElement {
  const el = doc.createElement(tag)
  ;(el as HTMLElement).tabIndex = 0
  doc.body.appendChild(el)
  return el
}

function press(key: string, init: KeyboardEventInit = {}, target: Document = doc): KeyboardEvent {
  const event = new win.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  } as never)
  Object.defineProperty(event, 'target', { value: target.activeElement })
  return event as unknown as KeyboardEvent
}

describe('VimDispatcher', () => {
  it('executes a mapped key on the focused list surface', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 1 })
  })

  it('passes a count into the command', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    dispatcher.handleKeyDown(doc, press('3'))
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 3 })
  })

  it('handles a multi-token sequence and its timeout', () => {
    vi.useFakeTimers()
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('g'))).toBe(true)
    expect(commands).not.toHaveBeenCalled()
    expect(dispatcher.handleKeyDown(doc, press('g'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('list.focusFirst', { count: 1 })
  })

  it('passes a stroke another listener already prevented', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    const event = press('j')
    event.preventDefault()
    expect(dispatcher.handleKeyDown(doc, event)).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('passes IME composition strokes through', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    const event = press('j')
    Object.defineProperty(event, 'isComposing', { value: true })
    expect(dispatcher.handleKeyDown(doc, event)).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('passes webview focus through even when a menu is mounted', () => {
    const webview = element()
    webview.setAttribute('data-vim-surface', 'webview')
    webview.focus()
    registerVimSurface(surface('menu', null), doc)
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('passes while a renderer dialog exists', () => {
    const dialog = element()
    dialog.setAttribute('data-renderer-dialog', '')
    registerVimSurface(surface('menu', null), doc)
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('passes while Quick Input is open', () => {
    const context = createContext()
    context.createKey<boolean>('quickInputVisible', true).set(true)
    registerVimSurface(surface('menu', null), doc)
    const { dispatcher, commands } = createDispatcher({ context })
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('passes when an editable target owns the keyboard', () => {
    const input = element('input')
    input.focus()
    registerVimSurface(surface('menu', null), doc)
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('yields to a User binding that is not reserved', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const registration: IDisposable = KeybindingsRegistry.registerKeybinding({
      key: 'j',
      command: 'user.down',
      weight: KeybindingWeight.User,
    })
    cleanups.push(() => registration.dispose())
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('keeps reserved keys with Vim despite a User binding', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const registration: IDisposable = KeybindingsRegistry.registerKeybinding({
      key: 'i',
      command: 'user.insert',
      weight: KeybindingWeight.User,
    })
    cleanups.push(() => registration.dispose())
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('i'))).toBe(true)
    expect(commands).not.toHaveBeenCalled()
  })

  it('in Insert mode only routes Escape to an editor surface', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    const handleStroke = vi.fn(() => true)
    registerVimSurface(surface('editor', container, { actions: { handleStroke } }), doc)
    textarea.focus()
    const vim = createVim()
    vim.setMode('editor:1', 'insert')
    const { dispatcher } = createDispatcher({ vim, handleStroke })

    expect(dispatcher.handleKeyDown(doc, press('x'))).toBe(false)
    expect(handleStroke).not.toHaveBeenCalled()
    expect(dispatcher.handleKeyDown(doc, press('Escape'))).toBe(true)
    expect(handleStroke).toHaveBeenCalledTimes(1)
  })

  it('lets a terminal keep its shell input until Normal Mode', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    registerVimSurface(surface('terminal', container, { defaultMode: 'insert' }), doc)
    const vim = createVim({ getEffectiveKeymap: () => [KEYMAP[4]!] })
    const { dispatcher, commands } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    vim.setMode('terminal:1', 'terminal-normal')
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('workbench.action.terminal.normalScrollLineDown', {
      count: 1,
    })
  })

  it('swallows unmapped printables on a terminal in Normal mode', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    registerVimSurface(surface('terminal', container, { defaultMode: 'insert' }), doc)
    const vim = createVim({ getEffectiveKeymap: () => [] })
    vim.setMode('terminal:1', 'terminal-normal')
    const { dispatcher, commands } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, press('x'))).toBe(true)
    expect(commands).not.toHaveBeenCalled()
  })

  it('swallows an unmapped printable key on list surfaces', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    expect(dispatcher.handleKeyDown(doc, press('q'))).toBe(true)
    expect(commands).not.toHaveBeenCalled()
  })

  it('passes an unmapped printable key when vim.passThroughUnmappedKeys is on', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const vim = createVim({ getPassThroughUnmappedKeys: () => true })
    const { dispatcher } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press('q'))).toBe(false)
  })

  it('routes editor surfaces through handleStroke in Normal mode', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    const handleStroke = vi.fn(() => true)
    registerVimSurface(surface('editor', container, { actions: { handleStroke } }), doc)
    const { dispatcher } = createDispatcher({ handleStroke })
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    expect(handleStroke).toHaveBeenCalledTimes(1)
  })

  it('routes a leader sequence on an editor to the command registry', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    const handleStroke = vi.fn(() => true)
    registerVimSurface(surface('editor', container, { actions: { handleStroke } }), doc)
    const leaderKeymap: readonly IVimKeymapEntry[] = [
      { id: 'leader.explorer', keys: ['space', 'e'], command: 'workbench.view.explorer' },
    ]
    const vim = createVim({ getEffectiveKeymap: () => leaderKeymap, getLeader: () => 'space' })
    const { dispatcher, commands } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, press(' '))).toBe(true)
    expect(handleStroke).not.toHaveBeenCalled()
    expect(commands).not.toHaveBeenCalled()

    expect(dispatcher.handleKeyDown(doc, press('e'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('workbench.view.explorer', { count: 1 })
    expect(handleStroke).not.toHaveBeenCalled()
  })

  it('falls back to the editor controller when a leader prefix matches nothing', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    const handleStroke = vi.fn(() => true)
    registerVimSurface(surface('editor', container, { actions: { handleStroke } }), doc)
    const leaderKeymap: readonly IVimKeymapEntry[] = [
      { id: 'leader.explorer', keys: ['space', 'e'], command: 'workbench.view.explorer' },
    ]
    const vim = createVim({ getEffectiveKeymap: () => leaderKeymap, getLeader: () => 'space' })
    const { dispatcher, commands } = createDispatcher({ vim })

    dispatcher.handleKeyDown(doc, press(' '))
    expect(dispatcher.handleKeyDown(doc, press('z'))).toBe(true)
    expect(commands).not.toHaveBeenCalled()
    expect(handleStroke).toHaveBeenCalledTimes(1)
  })
})
