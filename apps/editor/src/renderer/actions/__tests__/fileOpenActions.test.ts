/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests activeEditorSelectionText — the helper that seeds "Go to File…" with the
 *  active editor's selection (Ctrl+P using selected text as the search term).
 *--------------------------------------------------------------------------------------------*/

import {
  CommandsRegistry,
  IHostService,
  ILoggerService,
  INotificationService,
  InstantiationService,
  ServiceCollection,
  Severity,
  URI,
  registerAction2,
  type IHostService as IHostServiceType,
  type ILoggerService as ILoggerServiceType,
  type INotificationService as INotificationServiceType,
} from '@universe-editor/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OpenWithDefaultAppAction,
  RefreshExplorerAction,
  activeEditorSelectionText,
} from '../fileOpenActions.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { IExplorerTreeService } from '../../services/explorer/ExplorerTreeService.js'

function fakeSelection(text: string, isEmpty = false) {
  return { isEmpty: () => isEmpty, __text: text }
}

function fakeEditor(selection: ReturnType<typeof fakeSelection> | null) {
  return {
    getSelection: () => selection,
    getModel: () => ({
      getValueInRange: (sel: { __text: string }) => sel.__text,
    }),
  }
}

describe('activeEditorSelectionText', () => {
  afterEach(() => {
    FileEditorRegistry._resetForTests()
  })

  it('returns undefined when the active editor is not a FileEditorInput', () => {
    const editorService = { activeEditor: { get: () => undefined } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns undefined when the active input has no mounted editor', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns undefined when the selection is empty', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('', true)) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns undefined when the selection is only whitespace', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('   ')) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBeUndefined()
  })

  it('returns the trimmed selected text', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('  FileEditorInput  ')) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBe('FileEditorInput')
  })

  it('keeps only the first line of a multi-line selection', () => {
    const input = new FileEditorInput(URI.file('/workspace/src/a.ts'), {} as never)
    FileEditorRegistry.register(input, fakeEditor(fakeSelection('foo.ts\nbar.ts')) as never)
    const editorService = { activeEditor: { get: () => input } }
    expect(activeEditorSelectionText(editorService as never)).toBe('foo.ts')
  })
})

class OpenHost {
  declare readonly _serviceBrand: undefined
  readonly opened: string[] = []
  constructor(readonly platform: IHostServiceType['platform'] = 'win32') {}
  async openWithDefaultApp(path: string): Promise<string> {
    this.opened.push(path)
    return ''
  }
}

class OpenNotification {
  declare readonly _serviceBrand: undefined
  readonly notified: Array<{ severity: Severity; message: string }> = []
  notify(opts: { severity: Severity; message: string }): void {
    this.notified.push(opts)
  }
}

class OpenLogger {
  declare readonly _serviceBrand: undefined
  createLogger(): { debug(message: string): void } {
    return { debug: () => {} }
  }
  setLevel(): void {}
  getLevel(): number {
    return 0
  }
}

async function runOpenWithDefaultApp(
  host: OpenHost,
  notification: OpenNotification,
  logger: OpenLogger,
  target: URI,
): Promise<void> {
  const services = new ServiceCollection()
  services.set(IHostService, host as unknown as IHostServiceType)
  services.set(INotificationService, notification as unknown as INotificationServiceType)
  services.set(ILoggerService, logger as unknown as ILoggerServiceType)
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    const cmd = CommandsRegistry.getCommand(OpenWithDefaultAppAction.ID)!
    await cmd.handler(accessor, { target: target.toJSON() })
  })
}

describe('OpenWithDefaultAppAction', () => {
  const disposables: Array<{ dispose(): void }> = []
  beforeEach(() => {
    disposables.push(registerAction2(OpenWithDefaultAppAction))
  })
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('opens a file resource with the OS default application', async () => {
    const host = new OpenHost()
    const target = URI.file('/ws/src/notes.md')
    await runOpenWithDefaultApp(host, new OpenNotification(), new OpenLogger(), target)
    expect(host.opened).toEqual([target.fsPath])
  })

  it('opens a WSL remote resource via its UNC path on a Windows client', async () => {
    const host = new OpenHost('win32')
    const target = URI.parse('remote-ssh://wsl+ubuntu-24.04/home/u/notes.md')
    await runOpenWithDefaultApp(host, new OpenNotification(), new OpenLogger(), target)
    expect(host.opened).toEqual(['\\\\wsl$\\ubuntu-24.04\\home\\u\\notes.md'])
  })

  it('notifies instead of opening a non-WSL remote resource', async () => {
    const host = new OpenHost('win32')
    const notification = new OpenNotification()
    const target = URI.parse('remote-ssh://alice@host/home/u/notes.md')
    await runOpenWithDefaultApp(host, notification, new OpenLogger(), target)
    expect(host.opened).toHaveLength(0)
    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]?.severity).toBe(Severity.Info)
  })

  it('notifies instead of opening a WSL remote on a non-Windows client', async () => {
    const host = new OpenHost('linux')
    const notification = new OpenNotification()
    const target = URI.parse('remote-ssh://wsl+ubuntu-24.04/home/u/notes.md')
    await runOpenWithDefaultApp(host, notification, new OpenLogger(), target)
    expect(host.opened).toHaveLength(0)
    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]?.severity).toBe(Severity.Info)
  })
})

interface FakeTree {
  root: URI | null
  refresh: ReturnType<typeof vi.fn>
}

async function runRefresh(tree: FakeTree, arg?: unknown): Promise<void> {
  const services = new ServiceCollection()
  services.set(IExplorerTreeService, tree as unknown as never)
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    const cmd = CommandsRegistry.getCommand(RefreshExplorerAction.ID)!
    await cmd.handler(accessor, ...(arg === undefined ? [] : [arg]))
  })
}

describe('RefreshExplorerAction', () => {
  const disposables: Array<{ dispose(): void }> = []
  beforeEach(() => {
    disposables.push(registerAction2(RefreshExplorerAction))
  })
  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
  })

  it('refreshes the workspace root recursively when invoked without a target', async () => {
    const root = URI.file('/ws')
    const refresh = vi.fn().mockResolvedValue(undefined)
    await runRefresh({ root, refresh })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]?.[0]?.toString()).toBe(root.toString())
    // 递归为 true：重读已加载的子目录，外部新增的嵌套目录才能显示。
    expect(refresh.mock.calls[0]?.[1]).toBe(true)
  })

  it('recurses into the right-clicked directory only, staying on that subtree', async () => {
    const root = URI.file('/ws')
    const dir = URI.file('/ws/packages')
    const refresh = vi.fn().mockResolvedValue(undefined)
    await runRefresh({ root, refresh }, { resource: dir.toJSON(), isDirectory: true })

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0]?.[0]?.toString()).toBe(dir.toString())
    expect(refresh.mock.calls[0]?.[1]).toBe(true)
  })
})
