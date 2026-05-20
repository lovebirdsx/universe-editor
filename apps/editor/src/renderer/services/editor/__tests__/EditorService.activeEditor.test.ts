/*---------------------------------------------------------------------------------------------
 *  Tests for the IEditorService.activeEditor / openEditors observables.
 *
 *  Background: ExplorerAutoRevealContribution / FileEditorStatusContribution
 *  detect file editors with `instance instanceof FileEditorInput`. The EditorService's
 *  internal `toLegacy()` previously synthesized a plain `{id, type, label, isDirty}`
 *  object for every non-LegacyEditorInput, which broke that detection in production
 *  even though the underlying group held the real EditorInput.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  autorun,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { EditorService } from '../EditorService.js'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { FileEditorInput } from '../FileEditorInput.js'

function makeFs(): IFileServiceType {
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
      return { mtime: 1 } as Awaited<ReturnType<IFileServiceType['stat']>>
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  } as unknown as IFileServiceType
}

function makeEnv() {
  const services = new ServiceCollection()
  services.set(IFileService, makeFs())
  const inst = new InstantiationService(services)
  const groupsService = new EditorGroupsService()
  const editorService = new EditorService(groupsService)
  return { inst, groupsService, editorService }
}

describe('IEditorService.activeEditor preserves EditorInput identity', () => {
  it('activeEditor observable yields the real FileEditorInput, not a plain proxy', () => {
    const { inst, editorService } = makeEnv()
    const resource = URI.file('/ws/main.ts')
    const input = inst.createInstance(FileEditorInput, resource)
    editorService.openEditor(input, { pinned: true })

    let observed: unknown
    const disposable = autorun((r) => {
      observed = editorService.activeEditor.read(r)
    })
    expect(observed).toBeInstanceOf(FileEditorInput)
    expect((observed as FileEditorInput).resource.toString()).toBe(resource.toString())
    disposable.dispose()
    input.dispose()
  })

  it('openEditors observable yields real EditorInput instances', () => {
    const { inst, editorService } = makeEnv()
    const r1 = URI.file('/ws/a.ts')
    const r2 = URI.file('/ws/b.ts')
    const i1 = inst.createInstance(FileEditorInput, r1)
    const i2 = inst.createInstance(FileEditorInput, r2)
    editorService.openEditor(i1, { pinned: true })
    editorService.openEditor(i2, { pinned: true })

    const editors = editorService.openEditors.get()
    expect(editors).toHaveLength(2)
    for (const e of editors) {
      expect(e).toBeInstanceOf(FileEditorInput)
    }
    i1.dispose()
    i2.dispose()
  })
})
