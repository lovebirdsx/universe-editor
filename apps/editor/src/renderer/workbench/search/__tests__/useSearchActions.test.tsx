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

function SearchActionsHarness({ preserveFocus = false }: { preserveFocus?: boolean }) {
  const actions = useSearchActions([], vi.fn(), '')
  return (
    <button
      type="button"
      onClick={() => actions.onActivateMatch(resource, match, 0, { preview: true, preserveFocus })}
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

  function renderHarness(preserveFocus = false) {
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
        <SearchActionsHarness preserveFocus={preserveFocus} />
      </ServicesContext.Provider>,
    )
    return {
      groups: groupsService,
      buttonName: preserveFocus ? 'Preview search result' : 'Open search result',
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

  it('reveals a search match when Monaco mounts after the initial 50ms retry window', async () => {
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
    const ctx = renderHarness(true)

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
})
