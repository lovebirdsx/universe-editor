import { afterEach, describe, expect, it } from 'vitest'
import { EditorInput, URI, UriIdentityService, type IDisposable } from '@universe-editor/platform'
import { EditorGroupsService } from '../../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { editorScopedContextValues } from '../editorScopedContext.js'

class TestEditor extends EditorInput {
  private readonly _name: string
  private _dirty = false

  constructor(name: string) {
    super()
    this._name = name
  }

  get typeId() {
    return 'test'
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  override get isDirty() {
    return this._dirty
  }
  set dirty(value: boolean) {
    this._dirty = value
  }
  getName() {
    return this._name
  }
}

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function groupsWith(...editors: EditorInput[]): EditorGroupsService {
  const groups = new EditorGroupsService()
  disposables.push(groups)
  for (const editor of editors) groups.activeGroup.openEditor(editor)
  return groups
}

describe('editorScopedContextValues', () => {
  it('reflects the target tab position, not the group active editor', () => {
    const groups = groupsWith(new TestEditor('a'), new TestEditor('b'), new TestEditor('c'))
    const group = groups.activeGroup
    const clicked = group.editors[2]!
    group.setActive(group.editors[0]!)

    const values = editorScopedContextValues(group, clicked)

    expect(values['activeEditorId']).toBe(clicked.id)
    expect(values['activeEditorType']).toBe('test')
    expect(values['hasActiveEditor']).toBe(true)
    expect(values['editorIsOpen']).toBe(true)
    expect(values['groupEditorsCount']).toBe(3)
    expect(values['activeEditorGroupEmpty']).toBe(false)
    expect(values['activeEditorIsFirstInGroup']).toBe(false)
    expect(values['activeEditorIsLastInGroup']).toBe(true)
  })

  it('seeds explicit empty values for an empty group instead of falling back to root', () => {
    const groups = groupsWith()
    const values = editorScopedContextValues(groups.activeGroup, groups.activeGroup.activeEditor)

    expect(values['activeEditorId']).toBe('')
    expect(values['activeEditorType']).toBe('')
    expect(values['hasActiveEditor']).toBe(false)
    expect(values['editorIsOpen']).toBe(false)
    expect(values['groupEditorsCount']).toBe(0)
    expect(values['activeEditorGroupEmpty']).toBe(true)
    expect(values['activeEditorIsFirstInGroup']).toBe(false)
    expect(values['activeEditorIsLastInGroup']).toBe(false)
  })

  it('uses a provided resource override for the scheme key', () => {
    const groups = groupsWith(new TestEditor('a'))
    const values = editorScopedContextValues(groups.activeGroup, groups.activeGroup.activeEditor, {
      resource: URI.file('/repo/doc.md'),
    })

    expect(values['resourceScheme']).toBe('file')
  })

  it('keeps SCM keys conservative and does not crash when deps are missing', () => {
    const groups = groupsWith(new TestEditor('a'))
    const values = editorScopedContextValues(groups.activeGroup, groups.activeGroup.activeEditor)

    expect(values['resourceScmProvider']).toBe('')
    expect(values['scmActiveResourceHasChanges']).toBe(false)
  })

  it('derives language and dirty state from a file editor', () => {
    const file = new FileEditorInput(URI.file('/repo/settings.json'), {} as never)
    disposables.push(file)
    const groups = groupsWith(file)
    file.setDirty(true)

    const values = editorScopedContextValues(groups.activeGroup, file)

    expect(values['activeEditorLanguageId']).toBe('json')
    expect(values['activeEditorIsDirty']).toBe(true)
    expect(values['resourceScheme']).toBe('file')
  })

  it('reports the owning SCM provider and dirty-diff changes for a file editor', () => {
    const file = new FileEditorInput(URI.file('D:/repo/a.ts'), {} as never)
    disposables.push(file)
    const groups = groupsWith(file)

    const values = editorScopedContextValues(groups.activeGroup, file, {
      scmService: {
        sourceControls: {
          get: () => [{ id: 'git', rootUri: 'D:/repo' }],
          read: () => [{ id: 'git', rootUri: 'D:/repo' }],
        },
      } as never,
      scmDecorations: { hasChanges: () => true } as never,
      dirtyDiff: { resource: file.resource, regions: [{}] } as never,
      uriIdentity: new UriIdentityService('win32'),
    })

    expect(values['resourceScmProvider']).toBe('|git|')
    expect(values['scmActiveResourceHasChanges']).toBe(true)
  })

  it('ignores SCM state for an editor whose resource is not on this host', () => {
    const file = new FileEditorInput(URI.file('D:/repo/a.ts'), {} as never)
    disposables.push(file)
    const groups = groupsWith(file)

    const values = editorScopedContextValues(groups.activeGroup, file, {
      scmService: {
        sourceControls: {
          get: () => [{ id: 'git', rootUri: 'D:/repo' }],
          read: () => [{ id: 'git', rootUri: 'D:/repo' }],
        },
      } as never,
      remoteAuthority: 'another-host',
    })

    expect(values['resourceScmProvider']).toBe('')
  })

  it('marks groups that belong to auxiliary windows', () => {
    const groups = groupsWith(new TestEditor('main'))
    expect(
      editorScopedContextValues(groups.activeGroup, groups.activeGroup.activeEditor)[
        'isAuxiliaryEditorWindow'
      ],
    ).toBe(false)

    const auxPart = groups.createAuxiliaryPart({ activate: false })
    auxPart.activeGroup.openEditor(new TestEditor('aux'))
    expect(
      editorScopedContextValues(auxPart.activeGroup, auxPart.activeGroup.activeEditor)[
        'isAuxiliaryEditorWindow'
      ],
    ).toBe(true)
  })
})
