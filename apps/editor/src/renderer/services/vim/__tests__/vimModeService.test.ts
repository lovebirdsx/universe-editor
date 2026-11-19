/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  VimModeService: mode memory, context keys, status bar, keymap merge.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextKeyService } from '@universe-editor/platform'
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
      text: '',
      priority: 5000,
      command: 'workbench.action.toggleVimMode',
    })

    service.setMode(EDITOR.surfaceKey, 'insert')
    expect(status.records[0]?.entry).toMatchObject({ icon: 'vim-insert' })

    service.activateSurface(undefined)
    expect(status.records[0]?.disposed).toBe(true)
  })

  it('hides the status entry when vim.showStatusBar is false', () => {
    const { service, status, config } = create({ 'vim.enabled': true, 'vim.showStatusBar': false })
    service.activateSurface(EDITOR)
    expect(status.records).toHaveLength(0)
    config.set('vim.showStatusBar', true)
    config.fire('vim.showStatusBar')
    expect(status.records).toHaveLength(1)
  })

  it('turns the context keys off when vim is disabled', () => {
    const { service, context, config } = create()
    service.activateSurface(EDITOR)
    config.set('vim.enabled', false)
    config.fire('vim.enabled')
    expect(context.get('vimEnabled')).toBe(false)
    expect(context.get('vimMode')).toBe('')
    expect(service.getEnabled()).toBe(false)
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
})
