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

function SearchActionsHarness() {
  const actions = useSearchActions([], vi.fn(), '')
  return (
    <button type="button" onClick={() => actions.onActivateMatch(resource, match, 0)}>
      Open search result
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

  it('reveals a search match when Monaco mounts after the initial 50ms retry window', async () => {
    vi.useFakeTimers()
    groups = new EditorGroupsService()
    editorService = new EditorService(groups)
    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groups)
    services.set(IEditorService, editorService)
    services.set(IUriIdentityService, new UriIdentityService('linux'))
    services.set(IFileService, fileService as never)
    services.set(IDialogService, { _serviceBrand: undefined } as never)
    const instantiation = new InstantiationService(services)
    services.set(IInstantiationService, instantiation)

    render(
      <ServicesContext.Provider value={instantiation}>
        <SearchActionsHarness />
      </ServicesContext.Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open search result' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(75)
    })

    const input = groups.activeGroup.activeEditor
    expect(input).toBeInstanceOf(FileEditorInput)
    const editor = {
      setSelection: vi.fn(),
      revealLineInCenter: vi.fn(),
      focus: vi.fn(),
    }
    FileEditorRegistry.register(input as FileEditorInput, editor as never, groups.activeGroup.id)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(editor.setSelection).toHaveBeenCalledWith({
      startLineNumber: 12,
      startColumn: 7,
      endLineNumber: 12,
      endColumn: 13,
    })
    expect(editor.revealLineInCenter).toHaveBeenCalledWith(12)
  })
})
