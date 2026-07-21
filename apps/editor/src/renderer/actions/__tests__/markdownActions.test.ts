/*---------------------------------------------------------------------------------------------
 *  Tests for markdown preview title-bar actions, focused on the link-navigated
 *  case: a preview opened from a clicked link (constructed from a URI, with no
 *  held source FileEditorInput). "Open Source" must still work — it has to open
 *  the source file, not silently do nothing.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
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
  OpenMarkdownPreviewAction,
  OpenMarkdownSourceAction,
} from '../markdownActions.js'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { EditorViewStateCache } from '../../services/editor/EditorViewStateCache.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { MarkdownPreviewInput } from '../../services/editor/MarkdownPreviewInput.js'
import { MarkdownPreviewViewStateCache } from '../../services/editor/MarkdownPreviewViewStateCache.js'
import { MonacoModelRegistry } from '../../workbench/editor/monaco/MonacoModelRegistry.js'
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

// Regression: after scrolling a preview (Ctrl+Shift+V toggle mode), switching
// back to the source must land the source editor at the same place. In toggle
// mode the source editor is detached, so its own preview↔source scroll sync
// never runs; OpenMarkdownSourceAction must instead carry the preview's
// top-visible source line back as a one-shot reveal request the remounted
// FileEditor consumes.
describe('OpenMarkdownSourceAction — carries preview scroll back to the source', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    MarkdownPreviewRegistry._resetForTests()
    FileEditorRegistry._resetForTests()
    EditorViewStateCache._resetForTests()
  })

  function makeScrolledController(topLine: number, atBottom = false): IMarkdownPreviewController {
    const onDidScroll = new Emitter<void>()
    return {
      scrollToLine: () => {},
      scrollToAnchor: () => {},
      getTopVisibleLine: () => topLine,
      isScrolledToBottom: () => atBottom,
      focus: () => {},
      onDidScroll: onDidScroll.event,
      openFind: () => {},
      closeFind: () => {},
      findNext: () => {},
      findPrev: () => {},
      showLinkHints: () => {},
      hideLinkHints: () => {},
      toggleHelp: () => {},
    }
  }

  it('stashes the preview top line as a reveal request when toggling back (held source)', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')
    const groupId = groups.activeGroup.id

    // Toggle mode: the preview holds the source FileEditorInput.
    const source = inst.createInstance(FileEditorInput, sourceUri)
    const preview = new MarkdownPreviewInput(source)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })
    // The user scrolled the preview down to source line 42.
    MarkdownPreviewRegistry.register(sourceUri, makeScrolledController(42))

    await runCommand(inst, OpenMarkdownSourceAction, disposables)

    // Source is back in place, and a reveal request for line 42 was stashed for
    // the FileEditor to consume on mount (the fix for the lost scroll position).
    expect(groups.activeGroup.activeEditor).toBe(source)
    expect(EditorViewStateCache.takeRevealLine(groupId, sourceUri.toString())).toBe(42)
  })

  it('stashes the reveal request when re-opening the source in place (no held source)', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')
    const groupId = groups.activeGroup.id

    // Link-navigated preview: no held source input.
    const preview = new MarkdownPreviewInput(sourceUri)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })
    MarkdownPreviewRegistry.register(sourceUri, makeScrolledController(17))

    await runCommand(inst, OpenMarkdownSourceAction, disposables)

    const active = groups.activeGroup.activeEditor
    expect(active).toBeInstanceOf(FileEditorInput)
    expect(EditorViewStateCache.takeRevealLine(groupId, sourceUri.toString())).toBe(17)
  })

  it('reveals the LAST source line when the preview was scrolled to the bottom', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')
    const groupId = groups.activeGroup.id

    // Stub the shared model's line count (5 lines) without a live Monaco runtime.
    const peekSpy = vi
      .spyOn(MonacoModelRegistry, 'peek')
      .mockReturnValue({ getLineCount: () => 5 } as never)

    const source = inst.createInstance(FileEditorInput, sourceUri)
    const preview = new MarkdownPreviewInput(source)
    groups.activeGroup.openEditor(preview, { activate: true, pinned: true })
    // Preview at the very bottom: top-visible line (2) must be ignored in favour
    // of the source's last line (5), so the source lands flush at its end.
    MarkdownPreviewRegistry.register(sourceUri, makeScrolledController(2, /* atBottom */ true))

    await runCommand(inst, OpenMarkdownSourceAction, disposables)

    expect(EditorViewStateCache.takeRevealLine(groupId, sourceUri.toString())).toBe(5)
    peekSpy.mockRestore()
  })
})

// Entering the preview must align it to the source file's *viewport top* line, so
// it opens where the user is looking rather than at the preview's own saved
// scroll. Crucially it must NOT use the cursor line: mouse-wheel scrolling leaves
// the cursor behind, so aligning to the cursor snaps the preview back to the
// cursor's (stale) position — the very bug this covers. OpenMarkdownPreviewAction
// stashes a one-shot reveal-line the preview consumes.
describe('OpenMarkdownPreviewAction — aligns the preview to the source viewport top', () => {
  const disposables: IDisposable[] = []

  afterEach(() => {
    while (disposables.length > 0) disposables.pop()?.dispose()
    MarkdownPreviewViewStateCache._resetForTests()
    FileEditorRegistry._resetForTests()
  })

  it('stashes the source top-visible line (not the cursor) as the preview reveal request', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')

    const source = inst.createInstance(FileEditorInput, sourceUri)
    groups.activeGroup.openEditor(source, { activate: true, pinned: true })
    // Register a fake Monaco editor scrolled to the bottom (viewport top = line 90)
    // while the cursor is left behind on line 1 — exactly what mouse-wheel scrolling
    // produces. The preview must follow the viewport, not the cursor.
    const fakeEditor = {
      getVisibleRanges: () => [{ startLineNumber: 90 }],
      getPosition: () => ({ lineNumber: 1, column: 1 }),
    } as never
    FileEditorRegistry.register(source, fakeEditor, groups.activeGroup.id)

    await runCommand(inst, OpenMarkdownPreviewAction, disposables)

    // The preview replaced the source tab and a reveal-to-line-90 request is queued.
    expect(groups.activeGroup.activeEditor).toBeInstanceOf(MarkdownPreviewInput)
    expect(MarkdownPreviewViewStateCache.peekRevealLine(sourceUri.toString())).toBe(90)
  })

  it('falls back to the cursor line when no visible range is available yet', async () => {
    const { groups, inst } = setup()
    const sourceUri = URI.file('/repo/doc.md')

    const source = inst.createInstance(FileEditorInput, sourceUri)
    groups.activeGroup.openEditor(source, { activate: true, pinned: true })
    const fakeEditor = {
      getVisibleRanges: () => [],
      getPosition: () => ({ lineNumber: 63, column: 1 }),
    } as never
    FileEditorRegistry.register(source, fakeEditor, groups.activeGroup.id)

    await runCommand(inst, OpenMarkdownPreviewAction, disposables)

    expect(groups.activeGroup.activeEditor).toBeInstanceOf(MarkdownPreviewInput)
    expect(MarkdownPreviewViewStateCache.peekRevealLine(sourceUri.toString())).toBe(63)
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
      scrollToAnchor: () => {},
      getTopVisibleLine: () => 1,
      isScrolledToBottom: () => false,
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
