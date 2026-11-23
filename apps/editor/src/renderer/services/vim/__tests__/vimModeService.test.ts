/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  VimModeService: mode memory, context keys, status bar, keymap merge.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextKeyService } from '@universe-editor/platform'
import type { IVimKeymapEntry } from '@universe-editor/workbench-ui'
import { VimModeService } from '../vimModeService.js'

interface FakeConfig {
  values: Record<string, unknown>
  listeners: Set<(event: { affectsConfiguration(key: string): boolean }) => void>
  get<T>(key: string): T | undefined
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(key: string): boolean }) => void,
  ): { dispose(): void }
  set(key: string, value: unknown): void
  fire(key: string): void
}

function createConfig(initial: Record<string, unknown> = {}): FakeConfig {
  const values: Record<string, unknown> = { ...initial }
  const listeners = new Set<(event: { affectsConfiguration(key: string): boolean }) => void>()
  return {
    values,
    listeners,
    get<T>(key: string): T | undefined {
      return values[key] as T | undefined
    },
    onDidChangeConfiguration(listener) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    set(key, value) {
      values[key] = value
    },
    fire(key) {
      for (const listener of listeners) listener({ affectsConfiguration: (k) => k === key })
    },
  }
}

function createStatusBar() {
  const records: { entry: Record<string, unknown>; disposed: boolean }[] = []
  return {
    records,
    addEntry(entry: Record<string, unknown>) {
      const record = { entry, disposed: false }
      records.push(record)
      return {
        dispose: () => {
          record.disposed = true
        },
        update: (next: Record<string, unknown>) => {
          record.entry = next
        },
      }
    },
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function create(initial: Record<string, unknown> = { 'vim.enabled': true }): {
  service: VimModeService
  config: FakeConfig
  context: ContextKeyService
  status: ReturnType<typeof createStatusBar>
} {
  const config = createConfig(initial)
  const context = new ContextKeyService()
  const status = createStatusBar()
  const service = new VimModeService(config as never, context, status as never)
  cleanups.push(() => {
    service.dispose()
    context.dispose()
  })
  return { service, config, context, status }
}

const EDITOR = {
  surfaceKey: 'editor:1:1',
  kind: 'editor' as const,
  id: 'editor:1:1',
  defaultMode: 'normal' as const,
}

describe('VimModeService', () => {
  it('returns the default mode until a surface has its own', () => {
    const { service } = create()
    expect(service.getMode('list:1', 'normal')).toBe('normal')
    expect(service.getMode('terminal:1', 'insert')).toBe('insert')
  })

  it('remembers modes per surface and fires the change event', () => {
    const { service } = create()
    const listener = vi.fn()
    const sub = service.onDidChangeMode(listener)
    service.setMode('editor:1', 'insert')
    expect(service.getMode('editor:1', 'normal')).toBe('insert')
    expect(service.getMode('editor:2', 'normal')).toBe('normal')
    expect(listener).toHaveBeenCalledWith({ surfaceKey: 'editor:1', mode: 'insert' })
    sub.dispose()
  })

  it('writes the root context keys for the active surface', () => {
    const { service, context } = create()
    service.activateSurface(EDITOR)
    expect(context.get('vimEnabled')).toBe(true)
    expect(context.get('vimMode')).toBe('normal')
    expect(context.get('vimNormalMode')).toBe(true)
    expect(context.get('vimSurface')).toBe('editor')
    expect(context.get('vimSurfaceId')).toBe('editor:1:1')

    service.setMode(EDITOR.surfaceKey, 'insert')
    expect(context.get('vimMode')).toBe('insert')
    expect(context.get('vimNormalMode')).toBe(false)
  })

  it('forgets a closed surface and falls back to its default mode', () => {
    const { service, context } = create()
    service.activateSurface(EDITOR)
    service.setMode(EDITOR.surfaceKey, 'insert')
    expect(context.get('vimMode')).toBe('insert')

    service.forgetSurface(EDITOR.surfaceKey)
    expect(service.getMode(EDITOR.surfaceKey, 'normal')).toBe('normal')
    expect(context.get('vimMode')).toBe('normal')

    // Forgetting a key that was never remembered is a no-op.
    service.forgetSurface('editor:9:9')
    expect(service.getMode('editor:9:9', 'normal')).toBe('normal')
  })

  it('clears the keys when no surface owns the keyboard', () => {
    const { service, context } = create()
    service.activateSurface(EDITOR)
    service.activateSurface(undefined)
    expect(context.get('vimMode')).toBe('')
    expect(context.get('vimNormalMode')).toBe(false)
    expect(context.get('vimSurface')).toBe('')
  })

  it('shows the status entry only while enabled and a surface is active', () => {
    const { service, status } = create()
    service.activateSurface(EDITOR)
    expect(status.records).toHaveLength(1)
    expect(status.records[0]?.entry).toMatchObject({
      id: 'vim-mode',
      icon: 'vim-normal',
      text: 'NORMAL',
      priority: 5000,
      command: 'workbench.action.toggleVimMode',
    })

    service.setMode(EDITOR.surfaceKey, 'insert')
    expect(status.records[0]?.entry).toMatchObject({ icon: 'vim-insert', text: 'INSERT' })

    service.activateSurface(undefined)
    expect(status.records[0]?.disposed).toBe(true)
  })

  it('labels editor visual flavours and keeps them normal-class', () => {
    const { service, status, context } = create()
    service.activateSurface(EDITOR)
    const labels: [Parameters<VimModeService['setEditorSubMode']>[0], string][] = [
      ['visual', 'VISUAL'],
      ['visual-line', 'V-LINE'],
      ['visual-block', 'V-BLOCK'],
    ]
    for (const [sub, label] of labels) {
      service.setEditorSubMode(sub)
      expect(status.records[0]?.entry).toMatchObject({ text: label })
      expect(context.get('vimVisualMode')).toBe(true)
      expect(context.get('vimNormalMode')).toBe(true)
    }
    service.setEditorSubMode('normal')
    expect(status.records[0]?.entry).toMatchObject({ text: 'NORMAL' })
    expect(context.get('vimVisualMode')).toBe(false)
  })

  it('drops the visual sub-mode when the coarse mode changes', () => {
    const { service, context } = create()
    service.activateSurface(EDITOR)
    service.setEditorSubMode('visual')
    service.setMode(EDITOR.surfaceKey, 'insert')
    expect(service.getEditorSubMode(EDITOR.surfaceKey)).toBe('insert')
    service.setMode(EDITOR.surfaceKey, 'normal')
    expect(service.getEditorSubMode(EDITOR.surfaceKey)).toBe('normal')
    expect(context.get('vimVisualMode')).toBe(false)
  })

  it('ignores editor sub-modes on non-editor surfaces', () => {
    const { service, status } = create()
    service.activateSurface({ surfaceKey: 'list:1', kind: 'list', id: 'l', defaultMode: 'normal' })
    service.setEditorSubMode('visual')
    expect(status.records[0]?.entry).toMatchObject({ text: 'NORMAL' })
  })

  it('distinguishes terminal Normal from editor Normal', () => {
    const { service, status } = create()
    service.activateSurface({
      surfaceKey: 'terminal:1',
      kind: 'terminal',
      id: 't',
      defaultMode: 'insert',
    })
    service.setMode('terminal:1', 'terminal-normal')
    expect(status.records[0]?.entry).toMatchObject({ text: 'TERMINAL' })
  })

  it('shows pending keys in a second entry, preferring the editor core', () => {
    const { service, status } = create()
    service.activateSurface(EDITOR)
    service.setSequencePendingKeys('<Space>w')
    const feedback = () => status.records.find((r) => r.entry['id'] === 'vim-feedback')
    expect(feedback()?.entry).toMatchObject({ text: '<Space>w' })
    service.setPendingKeys('2d')
    expect(service.pendingKeys).toBe('2d')
    expect(feedback()?.entry).toMatchObject({ text: '2d' })
    service.setPendingKeys('')
    service.setSequencePendingKeys('')
    expect(feedback()?.disposed).toBe(true)
  })

  it('shows an unsupported key for ~1.5s and throttles repeats', () => {
    vi.useFakeTimers()
    cleanups.push(() => vi.useRealTimers())
    const { service, status } = create()
    service.activateSurface(EDITOR)
    const feedback = () => status.records.filter((r) => r.entry['id'] === 'vim-feedback')
    service.reportUnsupportedKey('x')
    expect(service.unsupportedKey).toBe('x')
    expect(feedback()[0]?.entry).toMatchObject({ text: 'Unsupported: x' })

    // Same key inside the throttle window: ignored, timer not restarted.
    vi.advanceTimersByTime(50)
    service.reportUnsupportedKey('x')
    vi.advanceTimersByTime(1450)
    expect(service.unsupportedKey).toBeUndefined()
    expect(feedback()[0]?.disposed).toBe(true)
  })

  it('shows the reported text verbatim: callers format tokens, the service does not', () => {
    vi.useFakeTimers()
    cleanups.push(() => vi.useRealTimers())
    const { service } = create()
    service.activateSurface(EDITOR)
    service.reportUnsupportedKey('<C-d>')
    expect(service.unsupportedKey).toBe('<C-d>')
    vi.advanceTimersByTime(1600)
    // a raw editor key name is shown as-is, never re-parsed as a keymap token
    service.reportUnsupportedKey('F2')
    expect(service.unsupportedKey).toBe('F2')
    vi.advanceTimersByTime(1600)
    service.reportUnsupportedKey('delete')
    expect(service.unsupportedKey).toBe('delete')
  })

  it('ignores unsupported-key reports while vim is off, hidden or the key is empty', () => {
    vi.useFakeTimers()
    cleanups.push(() => vi.useRealTimers())
    const off = create({ 'vim.enabled': false })
    off.service.activateSurface(EDITOR)
    off.service.reportUnsupportedKey('x')
    expect(off.service.unsupportedKey).toBeUndefined()

    const hidden = create({ 'vim.enabled': true, 'vim.showStatusBar': false })
    hidden.service.activateSurface(EDITOR)
    hidden.service.reportUnsupportedKey('x')
    expect(hidden.service.unsupportedKey).toBeUndefined()
    expect(hidden.status.records).toHaveLength(0)

    const empty = create()
    empty.service.activateSurface(EDITOR)
    empty.service.reportUnsupportedKey('')
    expect(empty.service.unsupportedKey).toBeUndefined()
  })

  it('cancels the unsupported-key timer on dispose', () => {
    vi.useFakeTimers()
    cleanups.push(() => vi.useRealTimers())
    const { service } = create()
    service.activateSurface(EDITOR)
    service.reportUnsupportedKey('x')
    expect(vi.getTimerCount()).toBe(1)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears feedback and which-key when the active surface changes', () => {
    const { service } = create()
    service.activateSurface(EDITOR)
    service.setSequencePendingKeys('g')
    service.setWhichKey({ prefix: 'g', items: [] })
    const listener = vi.fn()
    service.onDidChangeWhichKey(listener)
    service.activateSurface({ surfaceKey: 'list:1', kind: 'list', id: 'l', defaultMode: 'normal' })
    expect(service.pendingKeys).toBe('')
    expect(service.whichKey).toBeUndefined()
    expect(listener).toHaveBeenCalledWith(undefined)
  })

  it('follows vim.whichKey and clears an open list when turned off', () => {
    const { service, config } = create()
    expect(service.getWhichKeyEnabled()).toBe(true)
    service.activateSurface(EDITOR)
    service.setWhichKey({ prefix: '<Space>', items: [] })
    config.set('vim.whichKey', false)
    config.fire('vim.whichKey')
    expect(service.getWhichKeyEnabled()).toBe(false)
    expect(service.whichKey).toBeUndefined()
  })

  it('hides the status entry when vim.showStatusBar is false', () => {
    const { service, status, config } = create({ 'vim.enabled': true, 'vim.showStatusBar': false })
    service.activateSurface(EDITOR)
    expect(status.records).toHaveLength(0)
    config.set('vim.showStatusBar', true)
    config.fire('vim.showStatusBar')
    expect(status.records).toHaveLength(1)
  })

  it('turns every context key off when vim is disabled', () => {
    const { service, context, config } = create()
    const setEnabled = (value: boolean) => {
      config.set('vim.enabled', value)
      config.fire('vim.enabled')
    }
    service.activateSurface(EDITOR)
    service.setEditorSubMode('visual')
    expect(context.get('vimNormalMode')).toBe(true)
    expect(context.get('vimVisualMode')).toBe(true)
    setEnabled(false)
    expect(context.get('vimEnabled')).toBe(false)
    expect(context.get('vimMode')).toBe('')
    expect(context.get('vimNormalMode')).toBe(false)
    expect(context.get('vimVisualMode')).toBe(false)
    expect(context.get('vimSurface')).toBe('')
    expect(context.get('vimSurfaceId')).toBe('')
    expect(service.getEnabled()).toBe(false)

    setEnabled(true)
    service.activateSurface({
      surfaceKey: 't:1',
      kind: 'terminal',
      id: 't',
      defaultMode: 'insert',
    })
    service.setMode('t:1', 'terminal-normal')
    expect(context.get('vimTerminalNormalMode')).toBe(true)
    setEnabled(false)
    expect(context.get('vimTerminalNormalMode')).toBe(false)
  })

  it('treats a surface switched off in settings as absent for the context keys', () => {
    const { service, context, config } = create()
    service.activateSurface(EDITOR)
    service.setEditorSubMode('visual')
    config.set('vim.surfaces.editor', false)
    config.fire('vim.surfaces.editor')
    expect(context.get('vimEnabled')).toBe(true)
    expect(context.get('vimMode')).toBe('')
    expect(context.get('vimNormalMode')).toBe(false)
    expect(context.get('vimVisualMode')).toBe(false)
    expect(context.get('vimSurface')).toBe('')

    config.set('vim.surfaces.editor', true)
    config.fire('vim.surfaces.editor')
    expect(context.get('vimNormalMode')).toBe(true)
    expect(context.get('vimSurface')).toBe('editor')

    service.activateSurface({
      surfaceKey: 't:1',
      kind: 'terminal',
      id: 't',
      defaultMode: 'insert',
    })
    service.setMode('t:1', 'terminal-normal')
    config.set('vim.surfaces.terminalNormalMode', false)
    config.fire('vim.surfaces.terminalNormalMode')
    expect(context.get('vimTerminalNormalMode')).toBe(false)
  })

  it('filters the keymap by surface and replaces the leader', () => {
    const { service } = create({
      'vim.enabled': true,
      'vim.leader': ',',
    })
    const lists = service.getEffectiveKeymap('list')
    const editor = service.getEffectiveKeymap('editor')
    expect(lists.some((entry) => entry.command === 'list.focusDown')).toBe(true)
    expect(editor.some((entry) => entry.command === 'list.focusDown')).toBe(false)
    const leader = lists.find((entry) => entry.id === 'leader.quickOpen')
    expect(leader?.keys).toEqual([',', 'f'])
  })

  it('lets vim.keymap user entries replace defaults by id and append new ones', () => {
    const { service } = create({
      'vim.enabled': true,
      'vim.keymap': [
        { id: 'list.focusDown', keys: ['n'], command: 'user.down' },
        { id: 'user.custom', keys: ['<leader>', 'z'], command: 'user.z' },
      ],
    })
    const keymap = service.getEffectiveKeymap('list')
    expect(keymap.find((entry) => entry.id === 'list.focusDown')?.command).toBe('user.down')
    expect(keymap.find((entry) => entry.id === 'user.custom')?.keys).toEqual(['space', 'z'])
  })

  it('replaces the leader token in reserved keys', () => {
    const { service } = create({ 'vim.enabled': true, 'vim.leader': 'space' })
    expect(service.reservedKeys).toContain('space')
    expect(service.reservedKeys).not.toContain('<leader>')
  })

  it('lets an empty vim.reservedKeys clear the reserved set', () => {
    const { service } = create({ 'vim.enabled': true, 'vim.reservedKeys': [] })
    expect(service.reservedKeys).toEqual([])
  })

  it('falls back to the defaults when vim.reservedKeys is not an array', () => {
    const { service } = create({ 'vim.enabled': true, 'vim.reservedKeys': 'escape' })
    expect(service.reservedKeys.length).toBeGreaterThan(0)
  })

  it('caches the effective keymap until configuration changes', () => {
    const { service, config } = create({ 'vim.enabled': true })
    const first = service.getEffectiveKeymap('list')
    expect(service.getEffectiveKeymap('list')).toBe(first)

    config.set('vim.leader', ',')
    config.fire('vim.leader')
    const next = service.getEffectiveKeymap('list')
    expect(next).not.toBe(first)
    expect(next.find((entry) => entry.id === 'leader.quickOpen')?.keys).toEqual([',', 'f'])
  })

  it('honours per-surface switches', () => {
    const { service } = create({
      'vim.enabled': true,
      'vim.surfaces.lists': false,
      'vim.surfaces.tabs': false,
      'vim.surfaces.activityBar': false,
      'vim.surfaces.terminalNormalMode': false,
    })
    expect(service.isSurfaceEnabled('list')).toBe(false)
    expect(service.isSurfaceEnabled('tabs')).toBe(false)
    expect(service.isSurfaceEnabled('activityBar')).toBe(false)
    expect(service.isSurfaceEnabled('terminal')).toBe(false)
    expect(service.isSurfaceEnabled('editor')).toBe(true)
  })

  describe('surface keymaps', () => {
    const SURFACE: readonly IVimKeymapEntry[] = [
      { id: 'x.focusSearch', keys: ['/'], command: 'workbench.action.focusSettingsSearch' },
    ]

    it('merges a surface keymap first and tags it', () => {
      const { service } = create()
      const merged = service.getEffectiveKeymap('list', SURFACE)
      expect(merged[0]).toMatchObject({ id: 'x.focusSearch', scope: 'surface' })
      expect(merged.some((entry) => entry.command === 'list.focusDown')).toBe(true)
      expect(service.getEffectiveKeymap('list').some((entry) => entry.id === 'x.focusSearch')).toBe(
        false,
      )
    })

    it('caches per array identity and per configuration', () => {
      const { service, config } = create()
      const first = service.getEffectiveKeymap('list', SURFACE)
      expect(service.getEffectiveKeymap('list', SURFACE)).toBe(first)
      // an equal-but-new array is a different cache key (surfaces must keep theirs stable)
      expect(service.getEffectiveKeymap('list', [...SURFACE])).not.toBe(first)

      config.set('vim.leader', ',')
      config.fire('vim.leader')
      expect(service.getEffectiveKeymap('list', SURFACE)).not.toBe(first)
    })

    it('treats an empty surface keymap as none', () => {
      const { service } = create()
      expect(service.getEffectiveKeymap('list', [])).toBe(service.getEffectiveKeymap('list'))
    })
  })

  describe('vim.keymap problems', () => {
    const spyWarn = () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      cleanups.push(() => warn.mockRestore())
      return warn
    }

    it('warns once per problem across reloads, and keeps listing them', () => {
      const warn = spyWarn()
      const { service, config } = create({
        'vim.enabled': true,
        'vim.keymap': [{ id: 'u', keys: ['ctrl+'], command: 'a.b' }],
      })
      expect(service.getUserKeymapIssues()).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)

      config.fire('vim.keymap')
      config.fire('vim.keymap')
      expect(service.getUserKeymapIssues()).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)

      config.set('vim.keymap', [{ id: 'u', keys: ['ctrl+'], command: 'a.b' }, 'oops'])
      config.fire('vim.keymap')
      expect(service.getUserKeymapIssues()).toHaveLength(2)
      expect(warn).toHaveBeenCalledTimes(2)
    })

    it('exposes the parsed items for diagnostics', () => {
      const { service } = create({
        'vim.enabled': true,
        'vim.keymap': [
          { id: 'list.focusDown', keys: ['n'] },
          { id: 'list.delete', command: '-' },
        ],
      })
      expect(service.getUserKeymap()).toHaveLength(2)
    })
  })

  describe('vim.leader', () => {
    const spyWarn = () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      cleanups.push(() => warn.mockRestore())
      return warn
    }

    it.each([
      ['space', 'space'],
      ['Space', 'space'],
      ['<space>', 'space'],
      ['<Space>', 'space'],
      [' ', 'space'],
      [' Space ', 'space'],
      [',', ','],
      ['S', 'S'],
      ['ctrl+x', 'ctrl+x'],
    ])('normalizes %j to %j', (raw, expected) => {
      const warn = spyWarn()
      const { service } = create({ 'vim.enabled': true, 'vim.leader': raw })
      expect(service.getLeader()).toBe(expected)
      expect(warn).not.toHaveBeenCalled()
    })

    it.each([[''], ['   '], ['bogus'], ['<>'], ['ctrl+'], [3], [['space']]])(
      'falls back to space and warns once for %j',
      (raw) => {
        const warn = spyWarn()
        const { service, config } = create({ 'vim.enabled': true, 'vim.leader': raw })
        expect(service.getLeader()).toBe('space')
        expect(warn).toHaveBeenCalledTimes(1)
        config.fire('vim.leader')
        expect(warn).toHaveBeenCalledTimes(1)
      },
    )

    it('uses the default silently when unset', () => {
      const warn = spyWarn()
      const { service } = create({ 'vim.enabled': true })
      expect(service.getLeader()).toBe('space')
      expect(warn).not.toHaveBeenCalled()
    })

    it('feeds the normalized leader into the keymap and the reserved keys', () => {
      const { service } = create({ 'vim.enabled': true, 'vim.leader': '<Space>' })
      expect(
        service.getEffectiveKeymap('list').find((entry) => entry.id === 'leader.quickOpen')?.keys,
      ).toEqual(['space', 'f'])
      expect(service.reservedKeys).toContain('space')
    })
  })
})
