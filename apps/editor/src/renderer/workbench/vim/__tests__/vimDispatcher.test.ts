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
  type IVimPendingHint,
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
  { id: 'termDown', keys: ['j'], command: 'terminal.scrollLineDown' },
]

interface FakeVim extends IVimModeService {
  modes: Map<string, VimSurfaceMode>
  sequencePending: string[]
  unsupported: string[]
  whichKeyEnabled: boolean
}

function createVim(overrides: Partial<FakeVim> = {}): FakeVim {
  const modes = new Map<string, VimSurfaceMode>()
  const fake: FakeVim = {
    _serviceBrand: undefined,
    onDidChangeMode: (() => ({ dispose: () => undefined })) as never,
    onDidChangeActiveSurface: (() => ({ dispose: () => undefined })) as never,
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
    getUserKeymapIssues: () => [],
    reservedKeys: ['escape', 'i', 'a', ':', '/', '?', 'space'],
    getSequenceTimeoutMs: () => 50,
    getPassThroughUnmappedKeys: () => false,
    getLeader: () => 'space',
    getShowStatusBar: () => true,
    isSurfaceEnabled: () => true,
    setPendingKeys: () => undefined,
    setSequencePendingKeys: (keys) => {
      fake.sequencePending.push(keys)
    },
    pendingKeys: '',
    reportUnsupportedKey: (key) => {
      fake.unsupported.push(key)
    },
    unsupportedKey: undefined,
    setEditorSubMode: () => undefined,
    getEditorSubMode: () => 'normal',
    getWhichKeyEnabled: () => fake.whichKeyEnabled,
    whichKey: undefined,
    onDidChangeWhichKey: (() => ({ dispose: () => undefined })) as never,
    setWhichKey: (state) => {
      Object.defineProperty(fake, 'whichKey', { value: state, configurable: true })
    },
    sequencePending: [],
    unsupported: [],
    whichKeyEnabled: false,
    modes,
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
    expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 3, hasCount: true })
  })

  describe('multi-token sequence and its timeout', () => {
    function focusedList(): void {
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
    }

    it('completes a prefix on the next key', () => {
      vi.useFakeTimers()
      focusedList()
      const { dispatcher, commands } = createDispatcher()
      expect(dispatcher.handleKeyDown(doc, press('g'))).toBe(true)
      expect(commands).not.toHaveBeenCalled()
      expect(dispatcher.handleKeyDown(doc, press('g'))).toBe(true)
      expect(commands).toHaveBeenCalledWith('list.focusFirst', { count: 1 })
    })

    it('runs the complete entry itself when its longer sibling times out', () => {
      vi.useFakeTimers()
      focusedList()
      const vim = createVim({
        getEffectiveKeymap: () => [
          { id: 'z', keys: ['z'], command: 'z.command' },
          { id: 'za', keys: ['z', 'a'], command: 'za.command' },
        ],
      })
      const { dispatcher, commands } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press('z'))
      vi.advanceTimersByTime(49)
      expect(commands).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(commands).toHaveBeenCalledTimes(1)
      expect(commands).toHaveBeenCalledWith('z.command', { count: 1 })
      expect(vim.sequencePending.at(-1)).toBe('')
    })

    it('drops an incomplete prefix on timeout instead of replaying it', () => {
      vi.useFakeTimers()
      focusedList()
      const vim = createVim()
      const { dispatcher, commands } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press('g'))
      expect(vim.sequencePending.at(-1)).toBe('g')
      vi.advanceTimersByTime(60)
      expect(commands).not.toHaveBeenCalled()
      expect(vim.sequencePending.at(-1)).toBe('')
      // the sequence is clean again: a single `g` is a fresh prefix, `j` is a motion
      expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
      expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 1 })
    })

    it('drops a lone count on timeout', () => {
      vi.useFakeTimers()
      focusedList()
      const vim = createVim()
      const { dispatcher, commands } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press('3'))
      expect(vim.sequencePending.at(-1)).toBe('3')
      vi.advanceTimersByTime(60)
      expect(vim.sequencePending.at(-1)).toBe('')
      dispatcher.handleKeyDown(doc, press('j'))
      expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 1 })
    })

    it('restarts the timeout on each pending key', () => {
      vi.useFakeTimers()
      focusedList()
      const vim = createVim({
        getSequenceTimeoutMs: () => 100,
        getEffectiveKeymap: () => [{ id: 'gab', keys: ['g', 'a', 'b'], command: 'deep.command' }],
      })
      const { dispatcher, commands } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press('g'))
      vi.advanceTimersByTime(80)
      dispatcher.handleKeyDown(doc, press('a'))
      vi.advanceTimersByTime(80)
      // 160ms since `g`, but only 80 since the last key: still pending
      expect(vim.sequencePending.at(-1)).toBe('ga')
      dispatcher.handleKeyDown(doc, press('b'))
      expect(commands).toHaveBeenCalledWith('deep.command', { count: 1 })
    })

    it('still runs a deferred match on timeout while which-key is open', () => {
      vi.useFakeTimers()
      focusedList()
      const vim = createVim({
        whichKeyEnabled: true,
        getSequenceTimeoutMs: () => 400,
        getEffectiveKeymap: () => [
          { id: 'l', keys: ['space'], command: 'leader.only' },
          { id: 'le', keys: ['space', 'e'], command: 'workbench.view.explorer' },
        ],
      })
      const { dispatcher, commands } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press(' '))
      vi.advanceTimersByTime(300)
      expect(vim.whichKey).toBeDefined()
      vi.advanceTimersByTime(100)
      expect(commands).toHaveBeenCalledWith('leader.only', { count: 1 })
      expect(vim.whichKey).toBeUndefined()
    })
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

  it('keeps the rest of a pending sequence with Vim despite a User binding', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const registration: IDisposable = KeybindingsRegistry.registerKeybinding({
      key: 'e',
      command: 'user.explorer',
      weight: KeybindingWeight.User,
    })
    cleanups.push(() => registration.dispose())
    const leaderKeymap: readonly IVimKeymapEntry[] = [
      { id: 'leader.explorer', keys: ['space', 'e'], command: 'workbench.view.explorer' },
    ]
    const vim = createVim({ getEffectiveKeymap: () => leaderKeymap, getLeader: () => 'space' })
    const { dispatcher, commands } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, press(' '))).toBe(true)
    expect(dispatcher.handleKeyDown(doc, press('e'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('workbench.view.explorer', { count: 1 })
    expect(commands).not.toHaveBeenCalledWith('user.explorer', expect.anything())
  })

  it('clears sequences on reset so a count cannot leak between surfaces', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    dispatcher.handleKeyDown(doc, press('3'))
    dispatcher.resetAll(doc)
    dispatcher.handleKeyDown(doc, press('j'))
    expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 1 })
  })

  it('does not replay a pending timeout after dispose', () => {
    vi.useFakeTimers()
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    dispatcher.handleKeyDown(doc, press('g'))
    dispatcher.dispose(doc)
    vi.advanceTimersByTime(100)
    expect(commands).not.toHaveBeenCalled()
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
  })

  it('does not replay a pending timeout for an unmounted surface', () => {
    vi.useFakeTimers()
    const el = element()
    const registration = registerVimSurface(surface('list', el), doc)
    el.focus()
    const ambiguous: readonly IVimKeymapEntry[] = [
      { id: 'z', keys: ['z'], command: 'z.command' },
      { id: 'za', keys: ['z', 'a'], command: 'za.command' },
    ]
    const vim = createVim({ getEffectiveKeymap: () => ambiguous })
    const { dispatcher, commands } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press('z'))).toBe(true)
    registration.dispose()
    vi.advanceTimersByTime(100)
    expect(commands).not.toHaveBeenCalled()
  })

  it('catches command execution failures instead of leaking a rejection', async () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const commands = vi.fn(async () => {
      throw new Error('boom')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dispatcher = new VimDispatcher({
      commandService: { executeCommand: commands } as never,
      contextKeyService: createContext(),
      vimModeService: createVim(),
    })
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
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
    const { dispatcher } = createDispatcher({ vim })

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
    expect(commands).toHaveBeenCalledWith('terminal.scrollLineDown', {
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

  it('prefers a scoped `when` entry over an earlier unscoped one', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const context = createContext()
    context.createKey<boolean>('acpChatFocused', true).set(true)
    const scopedKeymap: readonly IVimKeymapEntry[] = [
      { id: 'generic', keys: ['a'], command: 'list.someGenericCommand' },
      {
        id: 'chatTop',
        keys: ['a'],
        command: 'workbench.action.agent.scrollTimelineToTop',
        when: 'acpChatFocused',
      },
    ]
    const vim = createVim({ getEffectiveKeymap: () => scopedKeymap })
    const { dispatcher, commands } = createDispatcher({ vim, context })
    expect(dispatcher.handleKeyDown(doc, press('a'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('workbench.action.agent.scrollTimelineToTop', {
      count: 1,
    })
  })

  it('falls back to the unscoped entry when the `when` scope is inactive', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const context = createContext()
    context.createKey<boolean>('acpChatFocused', false).set(false)
    const scopedKeymap: readonly IVimKeymapEntry[] = [
      { id: 'generic', keys: ['a'], command: 'list.someGenericCommand' },
      {
        id: 'chatTop',
        keys: ['a'],
        command: 'workbench.action.agent.scrollTimelineToTop',
        when: 'acpChatFocused',
      },
    ]
    const vim = createVim({ getEffectiveKeymap: () => scopedKeymap })
    const { dispatcher, commands } = createDispatcher({ vim, context })
    expect(dispatcher.handleKeyDown(doc, press('a'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('list.someGenericCommand', { count: 1 })
  })

  it('routes editor surfaces through handleStroke in Normal mode', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    const handleStroke = vi.fn(() => true)
    registerVimSurface(surface('editor', container, { actions: { handleStroke } }), doc)
    const { dispatcher } = createDispatcher()
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

  it('does not drop the key that interrupts a deferred match', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    // `z` is a command and also the head of `za`.
    const deferred: readonly IVimKeymapEntry[] = [
      { id: 'z', keys: ['z'], command: 'z.command' },
      { id: 'za', keys: ['z', 'a'], command: 'za.command' },
      { id: 'down', keys: ['j'], command: 'list.focusDown' },
    ]
    const vim = createVim({ getEffectiveKeymap: () => deferred })
    const { dispatcher, commands } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, press('z'))).toBe(true)
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    const executed = (commands.mock.calls as unknown[][]).map((call) => call[0])
    expect(executed).toEqual(['z.command', 'list.focusDown'])
  })

  it('hands an interrupting key on an editor back to the controller', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    const handleStroke = vi.fn(() => true)
    registerVimSurface(surface('editor', container, { actions: { handleStroke } }), doc)
    const keymap: readonly IVimKeymapEntry[] = [
      { id: 'l', keys: ['space'], command: 'leader.only' },
      { id: 'lf', keys: ['space', 'f'], command: 'leader.file' },
    ]
    const vim = createVim({ getEffectiveKeymap: () => keymap, getLeader: () => 'space' })
    const { dispatcher, commands } = createDispatcher({ vim })

    dispatcher.handleKeyDown(doc, press(' '))
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('leader.only', { count: 1 })
    expect(handleStroke).toHaveBeenCalledTimes(1)
  })

  it('prefers a surface-declared entry over the kind-wide one on the same keys', () => {
    const el = element()
    const surfaceEntry: IVimKeymapEntry = {
      id: 'surface.search',
      keys: ['/'],
      command: 'surface.focusSearch',
      scope: 'surface',
    }
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const keymap: readonly IVimKeymapEntry[] = [
      { id: 'generic', keys: ['/'], command: 'generic.search' },
      surfaceEntry,
    ]
    const vim = createVim({ getEffectiveKeymap: () => keymap })
    const { dispatcher, commands } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press('/'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('surface.focusSearch', { count: 1 })
  })

  it('passes a surface kind switched off in settings through', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const vim = createVim({ isSurfaceEnabled: (kind) => kind !== 'list' })
    const { dispatcher, commands } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(commands).not.toHaveBeenCalled()
  })

  it('passes an editor through when vim.surfaces.editor is off', () => {
    const container = element()
    const textarea = doc.createElement('textarea')
    container.appendChild(textarea)
    textarea.focus()
    const handleStroke = vi.fn(() => true)
    registerVimSurface(surface('editor', container, { actions: { handleStroke } }), doc)
    const vim = createVim({ isSurfaceEnabled: (kind) => kind !== 'editor' })
    const { dispatcher } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(handleStroke).not.toHaveBeenCalled()
  })

  it('treats Ctrl+[ like Escape when a non-editor surface is in Insert mode', () => {
    const el = element()
    registerVimSurface(surface('list', el, { defaultMode: 'insert' }), doc)
    el.focus()
    const vim = createVim()
    const { dispatcher } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(false)
    expect(dispatcher.handleKeyDown(doc, press('[', { ctrlKey: true }))).toBe(true)
    expect(vim.getMode('list:1', 'insert')).toBe('normal')
  })

  it('lets a reader surface keep keys it does not map (link hints, help, find)', () => {
    const el = element()
    registerVimSurface(surface('reader', el), doc)
    el.focus()
    const { dispatcher, commands } = createDispatcher()
    // mapped motion is claimed ...
    expect(dispatcher.handleKeyDown(doc, press('j'))).toBe(true)
    expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 1 })
    // ... everything else keeps flowing to the preview's own handlers.
    expect(dispatcher.handleKeyDown(doc, press('f'))).toBe(false)
    expect(dispatcher.handleKeyDown(doc, press('?'))).toBe(false)
    expect(dispatcher.handleKeyDown(doc, press('d'))).toBe(false)
    expect(commands).toHaveBeenCalledTimes(1)
  })

  describe('feedback', () => {
    it('marks an explicit count so 1G and G differ', () => {
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const { dispatcher, commands } = createDispatcher()
      dispatcher.handleKeyDown(doc, press('G', { shiftKey: true }))
      expect(commands).toHaveBeenLastCalledWith('list.focusLast', { count: 1 })
      dispatcher.handleKeyDown(doc, press('1'))
      dispatcher.handleKeyDown(doc, press('G', { shiftKey: true }))
      expect(commands).toHaveBeenLastCalledWith('list.focusLast', { count: 1, hasCount: true })
    })

    it('reports the pending count and prefix, then clears them', () => {
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const vim = createVim()
      const { dispatcher } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press('3'))
      dispatcher.handleKeyDown(doc, press('g'))
      expect(vim.sequencePending.at(-1)).toBe('3g')
      dispatcher.handleKeyDown(doc, press('g'))
      expect(vim.sequencePending.at(-1)).toBe('')
    })

    it('reports a swallowed unmapped printable key', () => {
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const vim = createVim()
      const { dispatcher } = createDispatcher({ vim })
      expect(dispatcher.handleKeyDown(doc, press('x'))).toBe(true)
      expect(vim.unsupported).toEqual(['x'])
    })

    it('reports the whole broken sequence, not just the last key', () => {
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const vim = createVim()
      const { dispatcher } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press('g'))
      dispatcher.handleKeyDown(doc, press('x'))
      expect(vim.unsupported).toEqual(['gx'])
    })

    it('does not report keys that pass through', () => {
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const vim = createVim({ getPassThroughUnmappedKeys: () => true })
      const { dispatcher } = createDispatcher({ vim })
      expect(dispatcher.handleKeyDown(doc, press('x'))).toBe(false)
      expect(vim.unsupported).toEqual([])
    })

    it('opens which-key after the delay and keeps the sequence alive past the timeout', () => {
      vi.useFakeTimers()
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const vim = createVim({
        whichKeyEnabled: true,
        getSequenceTimeoutMs: () => 800,
        getEffectiveKeymap: () => [
          { id: 'a', keys: ['space', 'e'], command: 'workbench.view.explorer' },
          { id: 'b', keys: ['space', 'w', 'h'], command: 'workbench.action.focusLeftGroup' },
        ],
      })
      const { dispatcher, commands } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press(' '))
      expect(vim.whichKey).toBeUndefined()
      vi.advanceTimersByTime(300)
      expect(vim.whichKey?.prefix).toBe('<Space>')
      expect(vim.whichKey?.items.map((item) => item.key)).toEqual(['e', 'w'])
      // Past the sequence timeout (800ms): still pending, nothing flushed.
      vi.advanceTimersByTime(1000)
      expect(vim.whichKey).toBeDefined()
      dispatcher.handleKeyDown(doc, press('e'))
      expect(commands).toHaveBeenCalledWith('workbench.view.explorer', { count: 1 })
      expect(vim.whichKey).toBeUndefined()
    })

    it('stays closed when vim.whichKey is off', () => {
      vi.useFakeTimers()
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const vim = createVim({
        getEffectiveKeymap: () => [{ id: 'a', keys: ['space', 'e'], command: 'x' }],
      })
      const { dispatcher } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press(' '))
      vi.advanceTimersByTime(1000)
      expect(vim.whichKey).toBeUndefined()
    })

    it('Escape closes which-key', () => {
      vi.useFakeTimers()
      const el = element()
      registerVimSurface(surface('list', el), doc)
      el.focus()
      const vim = createVim({
        whichKeyEnabled: true,
        getSequenceTimeoutMs: () => 800,
        getEffectiveKeymap: () => [{ id: 'a', keys: ['space', 'e'], command: 'x' }],
      })
      const { dispatcher } = createDispatcher({ vim })
      dispatcher.handleKeyDown(doc, press(' '))
      vi.advanceTimersByTime(300)
      expect(vim.whichKey).toBeDefined()
      dispatcher.handleKeyDown(doc, press('Escape'))
      expect(vim.whichKey).toBeUndefined()
    })
  })
})

function editorSurface(actions: IVimSurfaceRegistration['actions']): HTMLTextAreaElement {
  const container = element()
  const textarea = doc.createElement('textarea')
  container.appendChild(textarea)
  textarea.focus()
  registerVimSurface(surface('editor', container, { actions }), doc)
  return textarea
}

describe('VimDispatcher editor strokes', () => {
  it('routes Ctrl+[ to the editor core while the editor is in Insert mode', () => {
    const handleStroke = vi.fn(() => true)
    editorSurface({ handleStroke })
    const vim = createVim()
    vim.setMode('editor:1', 'insert')
    const { dispatcher } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, press('[', { ctrlKey: true }))).toBe(true)
    expect(handleStroke).toHaveBeenCalledTimes(1)
    // other Insert keys, including Ctrl+] / Ctrl+O, stay with Monaco
    expect(dispatcher.handleKeyDown(doc, press(']', { ctrlKey: true }))).toBe(false)
    expect(dispatcher.handleKeyDown(doc, press('o', { ctrlKey: true }))).toBe(false)
    expect(handleStroke).toHaveBeenCalledTimes(1)
  })

  it('leaves Ctrl+[ to a dialog that owns Escape, even in Insert mode', () => {
    const handleStroke = vi.fn(() => true)
    editorSurface({ handleStroke })
    const dialog = element()
    dialog.setAttribute('data-renderer-dialog', '')
    const vim = createVim()
    vim.setMode('editor:1', 'insert')
    const { dispatcher } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press('[', { ctrlKey: true }))).toBe(false)
    expect(handleStroke).not.toHaveBeenCalled()
  })

  describe('r / f / t waiting for a character', () => {
    const leaderKeymap: readonly IVimKeymapEntry[] = [
      { id: 'leader.explorer', keys: ['space', 'e'], command: 'workbench.view.explorer' },
    ]

    it('hands the leader to the core as the awaited character', () => {
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke, isAwaitingCharArg: () => true })
      const vim = createVim({ getEffectiveKeymap: () => leaderKeymap })
      const { dispatcher, commands } = createDispatcher({ vim })

      expect(dispatcher.handleKeyDown(doc, press(' '))).toBe(true)
      expect(handleStroke).toHaveBeenCalledTimes(1)
      expect(vim.sequencePending).toEqual([])
      // nothing is pending, so `e` is an ordinary core key and not `<Space>e`
      dispatcher.handleKeyDown(doc, press('e'))
      expect(commands).not.toHaveBeenCalled()
      expect(handleStroke).toHaveBeenCalledTimes(2)
    })

    it('still opens a leader sequence when the core is not waiting', () => {
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke, isAwaitingCharArg: () => false })
      const vim = createVim({ getEffectiveKeymap: () => leaderKeymap })
      const { dispatcher, commands } = createDispatcher({ vim })

      dispatcher.handleKeyDown(doc, press(' '))
      expect(handleStroke).not.toHaveBeenCalled()
      dispatcher.handleKeyDown(doc, press('e'))
      expect(commands).toHaveBeenCalledWith('workbench.view.explorer', { count: 1 })
    })

    it('reads the flag on every stroke', () => {
      let awaiting = true
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke, isAwaitingCharArg: () => awaiting })
      const vim = createVim({ getEffectiveKeymap: () => leaderKeymap })
      const { dispatcher, commands } = createDispatcher({ vim })

      dispatcher.handleKeyDown(doc, press(' '))
      expect(handleStroke).toHaveBeenCalledTimes(1)
      awaiting = false
      dispatcher.handleKeyDown(doc, press(' '))
      dispatcher.handleKeyDown(doc, press('e'))
      expect(handleStroke).toHaveBeenCalledTimes(1)
      expect(commands).toHaveBeenCalledWith('workbench.view.explorer', { count: 1 })
    })
  })

  // Ctrl+R / Ctrl+V / Ctrl+O / Ctrl+I are editor-core commands in Normal mode (redo,
  // block Visual, jump back / forward) but stay the workbench's / Monaco's in Insert
  // mode and with Vim off. The dispatcher is the only place that decides.
  describe.each(['r', 'v', 'o', 'i'])('Ctrl+%s', (letter) => {
    const stroke = () => press(letter, { ctrlKey: true })

    it('reaches the editor core in Normal mode and is consumed', () => {
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke })
      const { dispatcher } = createDispatcher()
      expect(dispatcher.handleKeyDown(doc, stroke())).toBe(true)
      expect(handleStroke).toHaveBeenCalledTimes(1)
    })

    it('is handed on when the core does not take it', () => {
      editorSurface({ handleStroke: () => false })
      const { dispatcher } = createDispatcher()
      expect(dispatcher.handleKeyDown(doc, stroke())).toBe(false)
    })

    it('is not touched in Insert mode', () => {
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke })
      const vim = createVim()
      vim.setMode('editor:1', 'insert')
      const { dispatcher } = createDispatcher({ vim })
      expect(dispatcher.handleKeyDown(doc, stroke())).toBe(false)
      expect(handleStroke).not.toHaveBeenCalled()
    })

    it('is not touched when Vim is off or the editor surface is off', () => {
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke })
      const off = createDispatcher({ vim: createVim({ getEnabled: () => false }) })
      expect(off.dispatcher.handleKeyDown(doc, stroke())).toBe(false)
      const surfaceOff = createDispatcher({
        vim: createVim({ isSurfaceEnabled: (kind) => kind !== 'editor' }),
      })
      expect(surfaceOff.dispatcher.handleKeyDown(doc, stroke())).toBe(false)
      expect(handleStroke).not.toHaveBeenCalled()
    })

    it('yields to a User binding on the same chord', () => {
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke })
      const registration = KeybindingsRegistry.registerKeybinding({
        key: `ctrl+${letter}`,
        command: 'user.cmd',
        weight: KeybindingWeight.User,
      })
      cleanups.push(() => registration.dispose())
      const { dispatcher } = createDispatcher()
      expect(dispatcher.handleKeyDown(doc, stroke())).toBe(false)
      expect(handleStroke).not.toHaveBeenCalled()
    })
  })
})

describe('VimDispatcher workbench-wide modifier chords', () => {
  const navKeymap: readonly IVimKeymapEntry[] = [
    {
      id: 'nav.back',
      keys: ['ctrl+o'],
      command: 'workbench.action.goBack',
      surfaces: ['editor', 'list'],
    },
    { id: 'bare', keys: ['Q'], command: 'never.run', surfaces: ['editor'] },
  ]
  const ctrlO = () => press('o', { ctrlKey: true })

  it('runs a mapped chord on the editor through the keymap, not the core', () => {
    const handleStroke = vi.fn(() => true)
    editorSurface({ handleStroke })
    const vim = createVim({ getEffectiveKeymap: () => navKeymap })
    const { dispatcher, commands } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, ctrlO())).toBe(true)
    expect(commands).toHaveBeenCalledWith('workbench.action.goBack', { count: 1 })
    expect(handleStroke).not.toHaveBeenCalled()
  })

  it('carries the count typed into the editor core', () => {
    const takeCount = vi.fn(() => 3)
    editorSurface({ handleStroke: () => true, takeCount })
    const vim = createVim({ getEffectiveKeymap: () => navKeymap })
    const { dispatcher, commands } = createDispatcher({ vim })

    dispatcher.handleKeyDown(doc, ctrlO())
    expect(takeCount).toHaveBeenCalledTimes(1)
    expect(commands).toHaveBeenCalledWith('workbench.action.goBack', {
      count: 3,
      hasCount: true,
    })
  })

  it('leaves the chord to the core while it is busy or waiting for a character', () => {
    for (const actions of [
      { takeCount: () => undefined },
      { isAwaitingCharArg: () => true, takeCount: () => 0 },
    ]) {
      const handleStroke = vi.fn(() => true)
      editorSurface({ handleStroke, ...actions })
      const vim = createVim({ getEffectiveKeymap: () => navKeymap })
      const { dispatcher, commands } = createDispatcher({ vim })
      expect(dispatcher.handleKeyDown(doc, ctrlO())).toBe(true)
      expect(handleStroke).toHaveBeenCalledTimes(1)
      expect(commands).not.toHaveBeenCalled()
      __resetVimSurfacesForTests()
      doc.body.innerHTML = ''
    }
  })

  it('never routes a bare key away from the editor core', () => {
    const handleStroke = vi.fn(() => true)
    editorSurface({ handleStroke })
    const vim = createVim({ getEffectiveKeymap: () => navKeymap })
    const { dispatcher, commands } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press('Q', { shiftKey: true }))
    expect(handleStroke).toHaveBeenCalledTimes(1)
    expect(commands).not.toHaveBeenCalled()
  })

  it('runs the same chord on a list instead of passing it to the global Open File', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const vim = createVim({ getEffectiveKeymap: () => navKeymap })
    const { dispatcher, commands } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, ctrlO())).toBe(true)
    expect(commands).toHaveBeenCalledWith('workbench.action.goBack', { count: 1 })
  })
})

describe('VimDispatcher editor which-key', () => {
  function editorWithHint(hint: () => IVimPendingHint | undefined) {
    const handleStroke = vi.fn(() => true)
    editorSurface({ handleStroke, getPendingHint: hint })
    return handleStroke
  }

  it('opens the core hint after the delay and follows the prefix immediately', () => {
    vi.useFakeTimers()
    let hint: IVimPendingHint | undefined = {
      prefix: 'g',
      items: [{ key: 'g', title: 'First line', isGroup: false }],
    }
    editorWithHint(() => hint)
    const vim = createVim({ whichKeyEnabled: true })
    const { dispatcher } = createDispatcher({ vim })

    expect(dispatcher.handleKeyDown(doc, press('g'))).toBe(true)
    expect(vim.whichKey).toBeUndefined()
    vi.advanceTimersByTime(300)
    expect(vim.whichKey?.prefix).toBe('g')

    hint = { prefix: 'gg', items: [{ key: 'g', title: 'First line', isGroup: false }] }
    dispatcher.handleKeyDown(doc, press('g'))
    // Already open: refreshed without waiting another 300ms.
    expect(vim.whichKey?.prefix).toBe('gg')

    hint = undefined
    dispatcher.handleKeyDown(doc, press('j'))
    expect(vim.whichKey).toBeUndefined()
  })

  it('does not open over a visible suggest widget on an editor, but lists still do', () => {
    vi.useFakeTimers()
    const context = createContext()
    context.createKey<boolean>('suggestWidgetVisible', true).set(true)
    const hint: IVimPendingHint = {
      prefix: 'g',
      items: [{ key: 'g', title: 'First line', isGroup: false }],
    }
    editorWithHint(() => hint)
    const vim = createVim({ whichKeyEnabled: true })
    const { dispatcher } = createDispatcher({ vim, context })
    dispatcher.handleKeyDown(doc, press('g'))
    vi.advanceTimersByTime(400)
    expect(vim.whichKey).toBeUndefined()

    __resetVimSurfacesForTests()
    doc.body.innerHTML = ''
    mountList(doc, 'list:1')
    const listVim = createVim({
      whichKeyEnabled: true,
      getSequenceTimeoutMs: () => 800,
      getEffectiveKeymap: () => [{ id: 'a', keys: ['space', 'e'], command: 'x' }],
    })
    const list = createDispatcher({ vim: listVim, context })
    list.dispatcher.handleKeyDown(doc, press(' '))
    vi.advanceTimersByTime(300)
    expect(listVim.whichKey?.prefix).toBe('<Space>')
  })

  it('closes on resetAll and stays closed while vim.whichKey is off', () => {
    vi.useFakeTimers()
    let hint: IVimPendingHint | undefined = {
      prefix: 'g',
      items: [{ key: 'g', title: 'First line', isGroup: false }],
    }
    editorWithHint(() => hint)
    const vim = createVim({ whichKeyEnabled: true })
    const { dispatcher } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press('g'))
    vi.advanceTimersByTime(300)
    expect(vim.whichKey).toBeDefined()
    dispatcher.resetAll(doc)
    expect(vim.whichKey).toBeUndefined()

    hint = { prefix: 'g', items: [{ key: 'g', title: 'First line', isGroup: false }] }
    vim.whichKeyEnabled = false
    dispatcher.handleKeyDown(doc, press('g'))
    vi.advanceTimersByTime(400)
    expect(vim.whichKey).toBeUndefined()
  })

  it('does not ask the core for a hint when the engine consumes the stroke', () => {
    vi.useFakeTimers()
    const getPendingHint = vi.fn(() => undefined)
    editorSurface({ handleStroke: vi.fn(() => true), getPendingHint })
    const vim = createVim({
      whichKeyEnabled: true,
      getSequenceTimeoutMs: () => 800,
      getEffectiveKeymap: () => [{ id: 'a', keys: ['space', 'e'], command: 'x' }],
    })
    const { dispatcher } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press(' '))).toBe(true)
    expect(getPendingHint).not.toHaveBeenCalled()
  })
})

describe('VimDispatcher when-gated entries', () => {
  const GATED: readonly IVimKeymapEntry[] = [
    { id: 'down', keys: ['j'], command: 'list.focusDown' },
    {
      id: 'nextChange',
      keys: [']', 'c'],
      command: 'compare.next',
      when: 'textCompareEditorVisible',
    },
    { id: 'nextFold', keys: [']', 'z'], command: 'fold.next' },
  ]

  function focused(kind: VimSurfaceKind = 'list'): void {
    const el = element()
    registerVimSurface(surface(kind, el), doc)
    el.focus()
  }

  it('does not make a prefix of a key whose only longer entries fail their when', () => {
    focused()
    const vim = createVim({ getEffectiveKeymap: () => [GATED[0]!, GATED[1]!] })
    const { dispatcher, commands } = createDispatcher({ vim })
    // `]` has no live continuation: it is an ordinary unmapped key now, not a pending prefix.
    expect(dispatcher.handleKeyDown(doc, press(']'))).toBe(true)
    expect(vim.sequencePending.filter((text) => text !== '')).toEqual([])
    expect(vim.unsupported).toEqual([']'])
    // ... so the next key is not eaten by a phantom prefix.
    dispatcher.handleKeyDown(doc, press('j'))
    expect(commands).toHaveBeenCalledWith('list.focusDown', { count: 1 })
  })

  it('opens no which-key for a prefix that only has failing entries', () => {
    vi.useFakeTimers()
    focused()
    const vim = createVim({ whichKeyEnabled: true, getEffectiveKeymap: () => GATED.slice(0, 2) })
    const { dispatcher } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press(']'))
    vi.advanceTimersByTime(1000)
    expect(vim.whichKey).toBeUndefined()
  })

  it('still lets a pass-through surface keep the key when the entry is gated off', () => {
    focused('reader')
    const vim = createVim({ getEffectiveKeymap: () => GATED.slice(0, 2) })
    const { dispatcher } = createDispatcher({ vim })
    expect(dispatcher.handleKeyDown(doc, press(']'))).toBe(false)
  })

  it('keeps the prefix when the when is satisfied', () => {
    focused()
    const context = createContext()
    context.createKey<boolean>('textCompareEditorVisible', true).set(true)
    const vim = createVim({ getEffectiveKeymap: () => GATED })
    const { dispatcher, commands } = createDispatcher({ vim, context })
    expect(dispatcher.handleKeyDown(doc, press(']'))).toBe(true)
    expect(vim.sequencePending.at(-1)).toBe(']')
    dispatcher.handleKeyDown(doc, press('c'))
    expect(commands).toHaveBeenCalledWith('compare.next', { count: 1 })
  })

  it('keeps an ungated sibling under the same prefix usable when the gated one is off', () => {
    focused()
    const vim = createVim({ getEffectiveKeymap: () => GATED })
    const { dispatcher, commands } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press(']'))
    expect(vim.sequencePending.at(-1)).toBe(']')
    dispatcher.handleKeyDown(doc, press('z'))
    expect(commands).toHaveBeenCalledWith('fold.next', { count: 1 })
  })

  it('applies the same filter to a leader sequence on an editor', () => {
    const handleStroke = vi.fn(() => true)
    editorSurface({ handleStroke })
    const vim = createVim({
      getEffectiveKeymap: () => [
        { id: 'gated', keys: ['space', 'x'], command: 'gated.command', when: 'neverSet' },
      ],
    })
    const { dispatcher, commands } = createDispatcher({ vim })
    // the leader has no live continuation: the editor core gets it back
    expect(dispatcher.handleKeyDown(doc, press(' '))).toBe(true)
    expect(handleStroke).toHaveBeenCalledTimes(1)
    expect(commands).not.toHaveBeenCalled()
  })
})

function mountList(target: Document, surfaceKey: string): void {
  const el = target.createElement('div') as HTMLElement
  el.tabIndex = 0
  target.body.appendChild(el)
  registerVimSurface(surface('list', el, { getSurfaceKey: () => surfaceKey }), target)
  el.focus()
}

describe('VimDispatcher which-key lifecycle', () => {
  const LEADER: readonly IVimKeymapEntry[] = [
    { id: 'a', keys: ['space', 'e'], command: 'workbench.view.explorer' },
    { id: 'b', keys: ['space', 'w', 'h'], command: 'workbench.action.focusLeftGroup' },
  ]

  function whichKeyVim(timeoutMs = 800): FakeVim {
    return createVim({
      whichKeyEnabled: true,
      getSequenceTimeoutMs: () => timeoutMs,
      getEffectiveKeymap: () => LEADER,
    })
  }

  it('does not open if vim.whichKey was switched off during the delay', () => {
    vi.useFakeTimers()
    mountList(doc, 'list:1')
    const vim = whichKeyVim()
    const { dispatcher } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press(' '))
    vim.whichKeyEnabled = false
    vi.advanceTimersByTime(400)
    expect(vim.whichKey).toBeUndefined()
  })

  it('closes when vim.whichKey is switched off while open and the prefix advances', () => {
    vi.useFakeTimers()
    mountList(doc, 'list:1')
    const vim = whichKeyVim()
    const { dispatcher } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press(' '))
    vi.advanceTimersByTime(300)
    expect(vim.whichKey?.prefix).toBe('<Space>')
    vim.whichKeyEnabled = false
    dispatcher.handleKeyDown(doc, press('w'))
    expect(vim.whichKey).toBeUndefined()
  })

  it('refreshes immediately once open instead of waiting out the delay again', () => {
    vi.useFakeTimers()
    mountList(doc, 'list:1')
    const vim = whichKeyVim()
    const { dispatcher } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press(' '))
    vi.advanceTimersByTime(300)
    dispatcher.handleKeyDown(doc, press('w'))
    expect(vim.whichKey?.prefix).toBe('<Space>w')
  })

  describe('with two windows sharing one service', () => {
    const win2 = new Window()
    const doc2 = win2.document as unknown as Document

    afterEach(() => {
      doc2.body.innerHTML = ''
    })

    function pressIn(target: Document, key: string): KeyboardEvent {
      const event = new win2.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      Object.defineProperty(event, 'target', { value: target.activeElement })
      return event as unknown as KeyboardEvent
    }

    function setup(timeoutMs: { current: number }) {
      mountList(doc, 'list:a')
      mountList(doc2, 'list:b')
      const vim = createVim({
        whichKeyEnabled: true,
        getSequenceTimeoutMs: () => timeoutMs.current,
        getEffectiveKeymap: () => LEADER,
      })
      const commands = vi.fn(async () => undefined)
      const make = () =>
        new VimDispatcher({
          commandService: { executeCommand: commands } as never,
          contextKeyService: createContext(),
          vimModeService: vim,
        })
      return { vim, commands, a: make(), b: make() }
    }

    it("does not treat another window's open which-key as its own", () => {
      vi.useFakeTimers()
      const { vim, a, b } = setup({ current: 5000 })
      a.handleKeyDown(doc, press(' '))
      vi.advanceTimersByTime(300)
      const opened = vim.whichKey
      expect(opened).toBeDefined()

      // window B starts a leader sequence: it must wait out its own delay
      b.handleKeyDown(doc2, pressIn(doc2, ' '))
      expect(vim.whichKey).toBe(opened)
      vi.advanceTimersByTime(300)
      expect(vim.whichKey).not.toBe(opened)
      expect(vim.whichKey?.prefix).toBe('<Space>')
    })

    it("ends the sequence on timeout even though another window's which-key is open", () => {
      vi.useFakeTimers()
      const timeout = { current: 5000 }
      const { vim, commands, a, b } = setup(timeout)
      a.handleKeyDown(doc, press(' '))
      vi.advanceTimersByTime(300)
      const opened = vim.whichKey
      timeout.current = 100
      b.handleKeyDown(doc2, pressIn(doc2, ' '))
      vi.advanceTimersByTime(100)
      // B timed out and reset: `e` no longer completes `<Space>e`
      b.handleKeyDown(doc2, pressIn(doc2, 'e'))
      expect(commands).not.toHaveBeenCalled()
      // and B's reset did not close A's overlay
      expect(vim.whichKey).toBe(opened)
    })

    it("does not close another window's which-key when this one resets", () => {
      vi.useFakeTimers()
      const { vim, a, b } = setup({ current: 5000 })
      a.handleKeyDown(doc, press(' '))
      vi.advanceTimersByTime(300)
      const opened = vim.whichKey
      b.resetAll(doc2)
      expect(vim.whichKey).toBe(opened)
      a.resetAll(doc)
      expect(vim.whichKey).toBeUndefined()
    })
  })
})

describe('VimDispatcher unsupported-key reporting', () => {
  it('reports display-ready text, formatted once', () => {
    const el = element()
    registerVimSurface(surface('list', el), doc)
    el.focus()
    const vim = createVim({
      getEffectiveKeymap: () => [{ id: 'a', keys: ['space', 'e'], command: 'x' }],
    })
    const { dispatcher } = createDispatcher({ vim })
    dispatcher.handleKeyDown(doc, press(' '))
    dispatcher.handleKeyDown(doc, press('x'))
    expect(vim.unsupported).toEqual(['<Space>x'])
  })
})
