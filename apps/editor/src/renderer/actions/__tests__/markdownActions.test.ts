/*---------------------------------------------------------------------------------------------
 *  Tests for markdown preview title-bar actions, focused on the link-navigated
 *  case: a preview opened from a clicked link (constructed from a URI, with no
 *  held source FileEditorInput). "Open Source" must still work — it has to open
 *  the source file, not silently do nothing.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  Emitter,
  IContextKeyService,
  IEditorGroupsService,
  IFileService,
  IInstantiationService,
  InstantiationService,
  KeybindingsRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import {
  MarkdownPreviewFindAction,
  MarkdownPreviewHelpAction,
  MarkdownPreviewLinkHintsAction,
  OpenMarkdownSourceAction,
} from '../markdownActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../../services/editor/MarkdownPreviewRegistry.js'

function makeFakeFileService(): IFileServiceType {
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
      return true
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
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

function setup() {
  FileEditorRegistry._resetForTests()
  const groups = new EditorGroupsService()
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(IFileService, makeFakeFileService())
  services.set(IContextKeyService, new ContextKeyService())
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return { groups, inst }
}

async function runCommand(
  inst: InstantiationService,
  ctor: new () => unknown,
  disposables: IDisposable[],
): Promise<void> {
  disposables.push(registerAction2(ctor as never))
  const id = (ctor as unknown as { ID: string }).ID
  const cmd = CommandsRegistry.getCommand(id)
  if (!cmd) throw new Error(`command not registered: ${id}`)
  await inst.invokeFunction(async (accessor) => {
    await cmd.handler(accessor)
  })
}

describe('OpenMarkdownSourceAction — link-navigated preview', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    FileEditorRegistry._resetForTests()
  })

  it('opens the source file in place of a URI-constructed preview (no held source)', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')

    // Link-navigated preview: built from a URI, so it holds NO source input.
    const preview = new MarkdownPreviewInput(sourceUri)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })
    expect(groups.activeGroup.editors).toHaveLength(1)
    expect(preview.sourceInput).toBeUndefined()

    await runCommand(inst, OpenMarkdownSourceAction, disposables)

    // The preview tab is replaced by the source file editor.
    expect(groups.activeGroup.editors).toHaveLength(1)
    const active = groups.activeGroup.activeEditor
    expect(active).toBeInstanceOf(FileEditorInput)
    expect(active?.resource?.toString()).toBe(sourceUri.toString())
  })

  it('activates an already-open source tab instead of opening a duplicate', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')

    const source = inst.createInstance(FileEditorInput, sourceUri)
    groups.activeGroup.openEditor(source, { activate: true, pinned: true })
    const preview = new MarkdownPreviewInput(sourceUri)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })
    expect(groups.activeGroup.editors).toHaveLength(2)

    await runCommand(inst, OpenMarkdownSourceAction, disposables)

    // Existing source tab is activated; no third tab is created.
    expect(groups.activeGroup.activeEditor).toBe(source)
  })
})

// Regression: clicking the preview's title-bar buttons (Find / Help) moves focus
// off the preview container, which fires `focusout` → clearActive(), so
// MarkdownPreviewRegistry.getActive() is undefined by the time the command runs.
// The command must still reach the controller of the *active* preview (resolved
// via the editor group), or the buttons silently do nothing while the keyboard
// shortcut — which keeps focus inside the preview — works.
describe('Markdown preview commands fall back to the active preview when focus left it', () => {
  const disposables: IDisposable[] = []

  function makeController(): {
    controller: IMarkdownPreviewController
    calls: { openFind: number; toggleHelp: number; showLinkHints: number }
  } {
    const calls = { openFind: 0, toggleHelp: 0, showLinkHints: 0 }
    const onDidScroll = new Emitter<void>()
    const controller: IMarkdownPreviewController = {
      scrollToLine: () => {},
      getTopVisibleLine: () => 1,
      focus: () => {},
      onDidScroll: onDidScroll.event,
      openFind: () => {
        calls.openFind += 1
      },
      closeFind: () => {},
      findNext: () => {},
      findPrev: () => {},
      showLinkHints: () => {
        calls.showLinkHints += 1
      },
      hideLinkHints: () => {},
      toggleHelp: () => {
        calls.toggleHelp += 1
      },
    }
    return { controller, calls }
  }

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    MarkdownPreviewRegistry._resetForTests()
    FileEditorRegistry._resetForTests()
  })

  it('Find / Help / LinkHints reach the active preview without a live getActive()', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')

    const preview = new MarkdownPreviewInput(sourceUri)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })

    const { controller, calls } = makeController()
    // Registered (the preview is mounted) but NOT active — mirrors the state right
    // after a title-bar button steals focus and clearActive() runs.
    MarkdownPreviewRegistry.register(sourceUri, controller)
    expect(MarkdownPreviewRegistry.getActive()).toBeUndefined()

    await runCommand(inst, MarkdownPreviewFindAction, disposables)
    await runCommand(inst, MarkdownPreviewHelpAction, disposables)
    await runCommand(inst, MarkdownPreviewLinkHintsAction, disposables)

    expect(calls.openFind).toBe(1)
    expect(calls.toggleHelp).toBe(1)
    expect(calls.showLinkHints).toBe(1)
  })

  it('registers `?` as the Keyboard Shortcuts keybinding when the preview is focused', () => {
    disposables.push(registerAction2(MarkdownPreviewHelpAction))
    const ctx = new ContextKeyService()
    // Not gated yet — preview not focused, so neither form must resolve.
    expect(KeybindingsRegistry.resolveKeybinding('?', ctx)).toBeUndefined()
    expect(KeybindingsRegistry.resolveKeybinding('shift+?', ctx)).toBeUndefined()

    ctx.createKey('markdownPreviewFocused', true)
    ctx.createKey('markdownPreviewFindVisible', false)
    ctx.createKey('markdownPreviewLinkHintsVisible', false)
    // Both the bare `?` (synthetic / Playwright) and `shift+?` (real Chromium)
    // forms resolve to the help action.
    expect(KeybindingsRegistry.resolveKeybinding('?', ctx)).toBe(MarkdownPreviewHelpAction.ID)
    expect(KeybindingsRegistry.resolveKeybinding('shift+?', ctx)).toBe(MarkdownPreviewHelpAction.ID)
  })
})
