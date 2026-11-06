/*---------------------------------------------------------------------------------------------
 *  Tests for EditorViewTargetService — it follows the last-used editor surface
 *  (openTargetPart), not the focused window (activePart).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { EditorInput, GroupDirection, URI } from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { EditorViewTargetService } from '../EditorViewTargetService.js'

class TestInput extends EditorInput {
  constructor(
    private readonly _resource: URI,
    private readonly _name: string,
  ) {
    super()
  }
  get typeId(): string {
    return 'editorViewTarget.test'
  }
  get resource(): URI {
    return this._resource
  }
  getName(): string {
    return this._name
  }
}

function make(name: string): TestInput {
  return new TestInput(URI.file(`/ws/${name}.ts`), name)
}

const disposables: Array<{ dispose(): void }> = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()!.dispose()
})

function makeGroups(): EditorGroupsService {
  const groups = new EditorGroupsService()
  disposables.push(groups)
  return groups
}

function makeService(groups: EditorGroupsService): EditorViewTargetService {
  const service = new EditorViewTargetService(groups)
  disposables.push(service)
  return service
}

describe('EditorViewTargetService', () => {
  it('defaults to the auxiliary part when it is the open target', () => {
    const groups = makeGroups()
    const aux = groups.createAuxiliaryPart({ activate: true })

    const service = makeService(groups)

    expect(service.targetGroup.get()).toBe(aux.activeGroup)
    expect(service.targetEditor.get()).toBeUndefined()
  })

  it('keeps the auxiliary target when the main window regains focus without editor interaction', () => {
    const groups = makeGroups()
    const aux = groups.createAuxiliaryPart({ activate: true })
    const editor = make('aux')
    aux.activeGroup.openEditor(editor)
    const service = makeService(groups)

    groups.activatePart(groups.mainPart, { preserveFocus: true, updateOpenTarget: false })

    expect(service.targetGroup.get()).toBe(aux.activeGroup)
    expect(service.targetEditor.get()).toBe(editor)
  })

  it('retargets when a main-window group is explicitly activated', () => {
    const groups = makeGroups()
    const aux = groups.createAuxiliaryPart({ activate: true })
    aux.activeGroup.openEditor(make('aux'))
    const service = makeService(groups)

    groups.activateGroup(groups.mainPart.activeGroup)

    expect(service.targetGroup.get()).toBe(groups.mainPart.activeGroup)
  })

  it('tracks the target group active editor', () => {
    const groups = makeGroups()
    const service = makeService(groups)
    const group = groups.mainPart.activeGroup

    const first = make('first')
    group.openEditor(first)
    expect(service.targetEditor.get()).toBe(first)

    const second = make('second')
    group.openEditor(second)
    expect(service.targetEditor.get()).toBe(second)

    group.closeEditor(second)
    expect(service.targetEditor.get()).toBe(first)
  })

  it('falls back to a live group when the target part is removed', () => {
    const groups = makeGroups()
    const aux = groups.createAuxiliaryPart({ activate: true })
    aux.activeGroup.openEditor(make('aux'))
    const service = makeService(groups)
    expect(service.targetGroup.get()).toBe(aux.activeGroup)

    groups.removePart(aux, { force: true })

    expect(service.targetGroup.get()).toBe(groups.mainPart.activeGroup)
  })

  it('falls back to the part active group when the target group is removed', () => {
    const groups = makeGroups()
    const aux = groups.createAuxiliaryPart({ activate: true })
    const first = aux.activeGroup
    const second = aux.addGroup(first, GroupDirection.Right)
    aux.activateGroup(second)
    const service = makeService(groups)
    expect(service.targetGroup.get()).toBe(second)

    groups.removeGroup(second)

    expect(service.targetGroup.get()).toBe(aux.activeGroup)
  })
})
