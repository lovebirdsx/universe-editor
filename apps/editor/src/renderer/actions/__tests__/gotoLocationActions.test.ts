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
  KeybindingsRegistry,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  gotoLocationActions,
  monacoNavDefaultKeybindingCommandIds,
} from '../gotoLocationActions.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
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
    return { inst, triggerSpy, focusSpy }
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

  it('exposes only the keybound ids for MonacoLoader to unbind', () => {
    expect(monacoNavDefaultKeybindingCommandIds).toEqual([
      'editor.action.revealDefinition',
      'editor.action.peekDefinition',
      'editor.action.goToImplementation',
      'editor.action.peekImplementation',
      'editor.action.goToReferences',
    ])
  })
})
