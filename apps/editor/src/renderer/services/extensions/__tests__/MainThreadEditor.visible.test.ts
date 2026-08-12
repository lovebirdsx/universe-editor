/**
 * `MainThreadEditor` mirrors the per-group visible text editors to the host
 * (`window.visibleTextEditors` / `onDidChangeVisibleTextEditors`): one snapshot
 * per group (its active text editor, file or untitled; custom editors excluded),
 * pushed as a whole set. Group edits, tab activations and editor mounts within
 * one event turn coalesce into a single microtask push, and a push whose set did
 * not actually change is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  observableValue,
  URI,
  type GroupDirection,
  type IEditorGroup,
  type IEditorService,
  type IFileService,
  type IInstantiationService,
  type ILogger,
  type IUriIdentityService,
} from '@universe-editor/platform'
import type { IActiveTextEditorDto, IExtHostEditor } from '@universe-editor/extensions-common'
import { MainThreadEditor } from '../MainThreadEditor.js'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { UntitledEditorInput } from '../../editor/UntitledEditorInput.js'
import { FileEditorRegistry } from '../../editor/FileEditorRegistry.js'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () =>
      Promise.resolve({ Uri: { parse: (s: string) => ({ toString: () => s }) } }),
    peek: () => undefined,
    get: () => {
      throw new Error('[MonacoLoader] not initialized; call ensureInitialized() first')
    },
  },
}))

const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as unknown as ILogger

class FakeCustomEditorInput extends EditorInput {
  override get typeId(): string {
    return 'test.custom'
  }
  override get resource(): URI {
    return URI.file('/ws/pic.png')
  }
  override getName(): string {
    return 'pic.png'
  }
}

function fakeModelEditor(uri: URI): monaco.editor.IStandaloneCodeEditor {
  const model = {
    uri: { toJSON: () => uri.toJSON(), toString: () => uri.toString() },
    getLanguageId: () => 'plaintext',
    getVersionId: () => 1,
  }
  return {
    getModel: () => model,
    getSelections: () => [],
    onDidChangeCursorSelection: () => ({ dispose: () => {} }),
  } as unknown as monaco.editor.IStandaloneCodeEditor
}

/** Flush the microtask the mirror coalesces pushes into. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('MainThreadEditor visible editors mirror', () => {
  const pushed: IActiveTextEditorDto[][] = []
  const extHost: IExtHostEditor = {
    $acceptActiveEditorChange: () => Promise.resolve(),
    $acceptVisibleEditorsChange: (editors) => {
      pushed.push([...editors])
      return Promise.resolve()
    },
    $acceptSelectionChange: () => Promise.resolve(),
  }
  const instantiation = {
    // The constructor eagerly builds FileBulkEditService; a no-op stands in.
    createInstance: () => ({ apply: vi.fn() }),
  } as unknown as IInstantiationService

  let groupsService: EditorGroupsService
  let activeEditorValue: ReturnType<typeof observableValue<EditorInput | undefined>>
  let mt: MainThreadEditor

  function openInGroup(group: IEditorGroup, input: FileEditorInput | UntitledEditorInput): void {
    group.openEditor(input)
    FileEditorRegistry.register(input, fakeModelEditor(input.resource!), group.id)
  }

  function visiblePaths(): string[] {
    return (pushed[pushed.length - 1] ?? []).map((s) => s.uri.path ?? '')
  }

  beforeEach(() => {
    pushed.length = 0
    groupsService = new EditorGroupsService()
    activeEditorValue = observableValue<EditorInput | undefined>('activeEditor', undefined)
    const editorService = { activeEditor: activeEditorValue } as unknown as IEditorService
    mt = new MainThreadEditor(
      editorService,
      {} as IUriIdentityService,
      extHost,
      {} as IFileService,
      groupsService,
      instantiation,
      logger,
    )
  })

  afterEach(() => {
    mt.dispose()
    groupsService.dispose()
    FileEditorRegistry._resetForTests()
  })

  it('pushes one snapshot per group when split into two groups', async () => {
    openInGroup(groupsService.groups[0]!, new FileEditorInput(URI.file('/ws/a.txt'), {} as never))
    await flushMicrotasks()
    expect(visiblePaths()).toEqual(['/ws/a.txt'])

    const second = groupsService.addGroup(groupsService.groups[0]!, 0 as GroupDirection)
    openInGroup(second, new FileEditorInput(URI.file('/ws/b.txt'), {} as never))
    await flushMicrotasks()
    expect(visiblePaths()).toEqual(['/ws/a.txt', '/ws/b.txt'])
  })

  it('coalesces a split and the first open into a single push', async () => {
    openInGroup(groupsService.groups[0]!, new FileEditorInput(URI.file('/ws/a.txt'), {} as never))
    await flushMicrotasks()
    const afterFirst = pushed.length

    const second = groupsService.addGroup(groupsService.groups[0]!, 0 as GroupDirection)
    openInGroup(second, new FileEditorInput(URI.file('/ws/b.txt'), {} as never))
    await flushMicrotasks()
    expect(pushed.length).toBe(afterFirst + 1)
  })

  it('pushes the new set when a group switches its active tab', async () => {
    const group = groupsService.groups[0]!
    openInGroup(group, new FileEditorInput(URI.file('/ws/a.txt'), {} as never))
    const b = new FileEditorInput(URI.file('/ws/b.txt'), {} as never)
    group.openEditor(b, { activate: false })
    FileEditorRegistry.register(b, fakeModelEditor(URI.file('/ws/b.txt')), group.id)
    await flushMicrotasks()
    expect(visiblePaths()).toEqual(['/ws/a.txt'])

    group.setActive(b)
    await flushMicrotasks()
    expect(visiblePaths()).toEqual(['/ws/b.txt'])
  })

  it('pushes the reduced set when a group is closed', async () => {
    openInGroup(groupsService.groups[0]!, new FileEditorInput(URI.file('/ws/a.txt'), {} as never))
    const second = groupsService.addGroup(groupsService.groups[0]!, 0 as GroupDirection)
    openInGroup(second, new FileEditorInput(URI.file('/ws/b.txt'), {} as never))
    await flushMicrotasks()
    expect(visiblePaths()).toEqual(['/ws/a.txt', '/ws/b.txt'])

    groupsService.removeGroup(second)
    await flushMicrotasks()
    expect(visiblePaths()).toEqual(['/ws/a.txt'])
  })

  it('includes untitled editors as visible text editors', async () => {
    openInGroup(groupsService.groups[0]!, new UntitledEditorInput('Untitled-1'))
    await flushMicrotasks()
    expect(pushed.at(-1)?.[0]?.uri.scheme).toBe('untitled')
    expect(pushed.at(-1)?.[0]?.uri.path).toBe('/Untitled-1')
  })

  it('excludes non-text custom editors from the set', async () => {
    groupsService.groups[0]!.openEditor(new FakeCustomEditorInput())
    await flushMicrotasks()
    expect(visiblePaths()).toEqual([])
  })

  it('does not re-push when editor instances churn without a set change', async () => {
    const group = groupsService.groups[0]!
    const a = new FileEditorInput(URI.file('/ws/a.txt'), {} as never)
    const editor = fakeModelEditor(URI.file('/ws/a.txt'))
    group.openEditor(a)
    FileEditorRegistry.register(a, editor, group.id)
    await flushMicrotasks()
    const afterOpen = pushed.length

    FileEditorRegistry.unregister(a, editor)
    FileEditorRegistry.register(a, editor, group.id)
    await flushMicrotasks()
    expect(pushed.length).toBe(afterOpen)
  })

  it('pushes once the Monaco instance mounts a tick after activation', async () => {
    const group = groupsService.groups[0]!
    const a = new FileEditorInput(URI.file('/ws/a.txt'), {} as never)
    group.openEditor(a)
    await flushMicrotasks()
    // Active tab without a mounted editor yet → empty set.
    expect(visiblePaths()).toEqual([])

    FileEditorRegistry.register(a, fakeModelEditor(URI.file('/ws/a.txt')), group.id)
    await flushMicrotasks()
    expect(visiblePaths()).toEqual(['/ws/a.txt'])
  })
})
