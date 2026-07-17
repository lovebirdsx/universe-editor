/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/actions/gotoLocationActions.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  InstantiationService,
  IProgressService,
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { gotoLocationActions } from '../gotoLocationActions.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { ILanguageFeaturesService } from '../../services/languageFeatures/LanguageFeaturesService.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'

function stubFs() {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  }
}

describe('gotoLocationActions', () => {
  const disposables: IDisposable[] = []
  afterEach(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose()
    }
    FileEditorRegistry._resetForTests()
    MonacoModelRegistry._resetForTests()
  })

  function setup(opts: { hasActive?: boolean }) {
    const services = new ServiceCollection()
    services.set(IFileService, stubFs() as never)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)

    const triggerSpy = vi.fn()
    const focusSpy = vi.fn()
    let input: FileEditorInput | null = null
    if (opts.hasActive !== false) {
      input = inst.createInstance(FileEditorInput, URI.file('/ws/a.ts'))
      FileEditorRegistry.register(input, { trigger: triggerSpy, focus: focusSpy } as never)
      disposables.push({ dispose: () => input?.dispose() })
    }
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: input },
    } as never)
    services.set(ILanguageFeaturesService, {
      _serviceBrand: undefined,
      hasStartingLanguageServer: () => false,
      whenLanguageServersSettled: () => Promise.resolve(),
    } as never)
    const withProgressSpy = vi.fn(
      (_options: unknown, task: (...args: unknown[]) => Promise<unknown>) => task(),
    )
    services.set(IProgressService, {
      _serviceBrand: undefined,
      withProgress: withProgressSpy,
    } as never)
    return { inst, triggerSpy, focusSpy, withProgressSpy }
  }

  it('registers every command with category, F1 palette entry', () => {
    for (const ctor of gotoLocationActions) disposables.push(registerAction2(ctor))
    for (const ctor of gotoLocationActions) {
      const id = new ctor().desc.id
      expect(CommandsRegistry.getCommand(id)).toBeDefined()
      expect(
        MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
          (i) => 'command' in i && i.command === id,
        ),
      ).toBe(true)
    }
  })

  it('binds the documented default keys', () => {
    for (const ctor of gotoLocationActions) disposables.push(registerAction2(ctor))
    expect(KeybindingsRegistry.resolveKeybinding('f12')).toBe('editor.action.revealDefinition')
    expect(KeybindingsRegistry.resolveKeybinding('shift+f12')).toBe('editor.action.goToReferences')
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+f12')).toBe(
      'editor.action.goToImplementation',
    )
    expect(KeybindingsRegistry.resolveKeybinding('alt+f12')).toBe('editor.action.peekDefinition')
    expect(KeybindingsRegistry.resolveKeybinding('ctrl+shift+f12')).toBe(
      'editor.action.peekImplementation',
    )
  })

  it('binds Open Definition to the Side as a Ctrl+K F12 chord', () => {
    for (const ctor of gotoLocationActions) disposables.push(registerAction2(ctor))
    expect(KeybindingsRegistry.resolveKeystroke('ctrl+k')).toMatchObject({
      kind: 'enter-chord',
      pending: ['ctrl+k'],
    })
    expect(KeybindingsRegistry.resolveKeystroke('f12', undefined, ['ctrl+k'])).toMatchObject({
      kind: 'execute',
      command: 'editor.action.revealDefinitionAside',
    })
  })

  it('run() focuses then triggers the matching Monaco command id', async () => {
    const revealCtor = gotoLocationActions.find(
      (c) => new c().desc.id === 'editor.action.revealDefinition',
    )!
    disposables.push(registerAction2(revealCtor))
    const { inst, triggerSpy, focusSpy } = setup({})

    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand('editor.action.revealDefinition')!.handler(accessor)
    })

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(triggerSpy).toHaveBeenCalledWith('universe', 'editor.action.revealDefinition', {})
  })

  it('shows progress while a language server is still starting', async () => {
    const revealCtor = gotoLocationActions.find(
      (c) => new c().desc.id === 'editor.action.revealDefinition',
    )!
    disposables.push(registerAction2(revealCtor))
    const services = new ServiceCollection()
    services.set(IFileService, stubFs() as never)
    const inst = new InstantiationService(services)
    services.set(IInstantiationService, inst)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.ts'))
    FileEditorRegistry.register(input, { trigger: vi.fn(), focus: vi.fn() } as never)
    disposables.push({ dispose: () => input.dispose() })
    services.set(IEditorGroupsService, {
      _serviceBrand: undefined,
      activeGroup: { activeEditor: input },
    } as never)
    services.set(ILanguageFeaturesService, {
      _serviceBrand: undefined,
      hasStartingLanguageServer: () => true,
      whenLanguageServersSettled: () => Promise.resolve(),
    } as never)
    const withProgressSpy = vi.fn((_options: unknown, task: () => Promise<unknown>) => task())
    services.set(IProgressService, {
      _serviceBrand: undefined,
      withProgress: withProgressSpy,
    } as never)

    await inst.invokeFunction((accessor) => {
      CommandsRegistry.getCommand('editor.action.revealDefinition')!.handler(accessor)
    })

    expect(withProgressSpy).toHaveBeenCalledTimes(1)
  })

  it('run() is a no-op when there is no active editor', async () => {
    const revealCtor = gotoLocationActions.find(
      (c) => new c().desc.id === 'editor.action.revealDefinition',
    )!
    disposables.push(registerAction2(revealCtor))
    const { inst, triggerSpy } = setup({ hasActive: false })

    await expect(
      Promise.resolve(
        inst.invokeFunction((accessor) => {
          CommandsRegistry.getCommand('editor.action.revealDefinition')!.handler(accessor)
        }),
      ),
    ).resolves.not.toThrow()
    expect(triggerSpy).not.toHaveBeenCalled()
  })
})
