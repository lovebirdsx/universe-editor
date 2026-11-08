/*---------------------------------------------------------------------------------------------
 *  Tests for search result activation.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  IDialogService,
  IEditorGroupsService,
  IEditorService,
  IFileService,
  IInstantiationService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { EditorService } from '../../../services/editor/EditorService.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../../services/editor/FileEditorRegistry.js'
import { useSearchActions } from '../useSearchActions.js'

const resource = URI.file('/workspace/search-result.ts')
const match = {
  lineNumber: 12,
  preview: 'const needle = true',
  ranges: [{ startColumn: 7, endColumn: 13 }],
}

const fileService = {
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

function SearchActionsHarness({
  preserveFocus = false,
  preview = true,
}: {
  preserveFocus?: boolean
  preview?: boolean
}) {
  const actions = useSearchActions([], vi.fn(), '')
  return (
    <button
      type="button"
      onClick={() => actions.onActivateMatch(resource, match, 0, { preview, preserveFocus })}
    >
      {preserveFocus ? 'Preview search result' : 'Open search result'}
    </button>
  )
}

describe('useSearchActions', () => {
  let editorService: EditorService | undefined
  let groups: EditorGroupsService | undefined

  afterEach(() => {
    cleanup()
    FileEditorRegistry._resetForTests()
    editorService?.dispose()
    groups?.dispose()
    editorService = undefined
    groups = undefined
    vi.useRealTimers()
  })

  function renderHarness(options: { preserveFocus?: boolean; preview?: boolean } = {}) {
    vi.useFakeTimers()
    const groupsService = new EditorGroupsService()
    const service = new EditorService(groupsService)
    groups = groupsService
    editorService = service
    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groupsService)
    services.set(IEditorService, service)
    services.set(IUriIdentityService, new UriIdentityService('linux'))
    services.set(IFileService, fileService as never)
    services.set(IDialogService, { _serviceBrand: undefined } as never)
    const instantiation = new InstantiationService(services)
    services.set(IInstantiationService, instantiation)

    render(
      <ServicesContext.Provider value={instantiation}>
        <SearchActionsHarness
          preserveFocus={options.preserveFocus === true}
          preview={options.preview !== false}
        />
      </ServicesContext.Provider>,
    )
    return {
      groups: groupsService,
      editorService: service,
      instantiation,
      buttonName: options.preserveFocus === true ? 'Preview search result' : 'Open search result',
    }
  }

  function mountEditor(input: FileEditorInput, groupId: number) {
    const editor = {
      setSelection: vi.fn(),
      revealRangeInCenterIfOutsideViewport: vi.fn(),
      focus: vi.fn(),
    }
    FileEditorRegistry.register(input, editor as never, groupId)
    return editor
  }

  const expectedRange = {
    startLineNumber: 12,
    startColumn: 7,
    endLineNumber: 12,
    endColumn: 13,
  }

  it('reveals a search match when Monaco mounts after the search activation', async () => {
    const ctx = renderHarness()

    fireEvent.click(screen.getByRole('button', { name: ctx.buttonName }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75)
    })

    const input = ctx.groups.activeGroup.activeEditor
    expect(input).toBeInstanceOf(FileEditorInput)
    const editor = mountEditor(input as FileEditorInput, ctx.groups.activeGroup.id)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(editor.setSelection).toHaveBeenCalledWith(expectedRange)
    expect(editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(expectedRange)
    // Click activation hands focus to the editor.
    expect(editor.focus).toHaveBeenCalled()
  })

  it('keeps keyboard focus in the results tree for a Space preview', async () => {
    const ctx = renderHarness({ preserveFocus: true })

    fireEvent.click(screen.getByRole('button', { name: ctx.buttonName }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75)
    })

    const input = ctx.groups.activeGroup.activeEditor
    expect(input).toBeInstanceOf(FileEditorInput)
    // Preview slot, not a pinned tab, and the group recorded the focus intent.
    expect(ctx.groups.activeGroup.previewEditor).toBe(input)
    expect(ctx.groups.activeGroup.lastActivationPreservedFocus).toBe(true)

    const editor = mountEditor(input as FileEditorInput, ctx.groups.activeGroup.id)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(editor.setSelection).toHaveBeenCalledWith(expectedRange)
    expect(editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(expectedRange)
    expect(editor.focus).not.toHaveBeenCalled()
  })

  it('reveals a match in an auxiliary-window editor while the main part has focus', async () => {
    const ctx = renderHarness({ preview: false })
    const aux = ctx.groups.createAuxiliaryPart()
    const auxInput = ctx.instantiation.createInstance(FileEditorInput, resource)
    ctx.editorService.openEditor(auxInput, { pinned: true })
    const auxEditor = mountEditor(auxInput, aux.activeGroup.id)

    // Alt+Tab back to the main window: focus moves, the open target stays aux.
    ctx.groups.activatePart(ctx.groups.mainPart, { preserveFocus: true })
    const mainInput = ctx.instantiation.createInstance(
      FileEditorInput,
      URI.file('/workspace/main.ts'),
    )
    ctx.groups.mainPart.activeGroup.openEditor(mainInput, { activate: true, pinned: true })
    const mainEditor = mountEditor(mainInput, ctx.groups.mainPart.activeGroup.id)

    fireEvent.click(screen.getByRole('button', { name: ctx.buttonName }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(auxEditor.setSelection).toHaveBeenCalledWith(expectedRange)
    expect(auxEditor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(expectedRange)
    expect(auxEditor.focus).toHaveBeenCalled()
    expect(mainEditor.setSelection).not.toHaveBeenCalled()
    expect(mainEditor.revealRangeInCenterIfOutsideViewport).not.toHaveBeenCalled()
  })

  it('reveals a not-yet-open result that opens into the auxiliary part', async () => {
    const ctx = renderHarness({ preview: false })
    const aux = ctx.groups.createAuxiliaryPart()
    ctx.groups.activatePart(ctx.groups.mainPart, { preserveFocus: true })
    const mainInput = ctx.instantiation.createInstance(
      FileEditorInput,
      URI.file('/workspace/main.ts'),
    )
    ctx.groups.mainPart.activeGroup.openEditor(mainInput, { activate: true, pinned: true })
    const mainEditor = mountEditor(mainInput, ctx.groups.mainPart.activeGroup.id)

    fireEvent.click(screen.getByRole('button', { name: ctx.buttonName }))

    const opened = aux.activeGroup.activeEditor
    expect(opened).toBeInstanceOf(FileEditorInput)
    const auxEditor = mountEditor(opened as FileEditorInput, aux.activeGroup.id)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(auxEditor.setSelection).toHaveBeenCalledWith(expectedRange)
    expect(auxEditor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(expectedRange)
    expect(auxEditor.focus).toHaveBeenCalled()
    expect(mainEditor.setSelection).not.toHaveBeenCalled()
  })

  it('reveals a Space preview in the auxiliary editor without focusing it', async () => {
    const ctx = renderHarness({ preserveFocus: true })
    const aux = ctx.groups.createAuxiliaryPart()
    const auxInput = ctx.instantiation.createInstance(FileEditorInput, resource)
    ctx.editorService.openEditor(auxInput, { pinned: true })
    const auxEditor = mountEditor(auxInput, aux.activeGroup.id)

    ctx.groups.activatePart(ctx.groups.mainPart, { preserveFocus: true })
    const mainInput = ctx.instantiation.createInstance(
      FileEditorInput,
      URI.file('/workspace/main.ts'),
    )
    ctx.groups.mainPart.activeGroup.openEditor(mainInput, { activate: true, pinned: true })
    const mainEditor = mountEditor(mainInput, ctx.groups.mainPart.activeGroup.id)

    fireEvent.click(screen.getByRole('button', { name: ctx.buttonName }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(auxEditor.setSelection).toHaveBeenCalledWith(expectedRange)
    expect(auxEditor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledWith(expectedRange)
    expect(auxEditor.focus).not.toHaveBeenCalled()
    expect(mainEditor.setSelection).not.toHaveBeenCalled()
  })
})
