/*---------------------------------------------------------------------------------------------
 *  Tests for revealEditorInGroups — cross-group reveal of singleton editors.
 *
 *  Regression: IEditorService.openEditor only dedupes within the active group,
 *  so running "View Git Graph" while the graph was open in another split group
 *  opened a second copy instead of activating the existing one.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { EditorInput, URI, type IEditorGroupsService } from '@universe-editor/platform'
import { revealEditorInGroups } from '../revealEditorInGroups.js'

class TestInput extends EditorInput {
  constructor(private readonly _uri: URI) {
    super()
  }
  get typeId() {
    return 'test'
  }
  get resource() {
    return this._uri
  }
  getName() {
    return this._uri.path
  }
}

class SingletonInput extends TestInput {}

function makeGroup(editors: EditorInput[]) {
  return { editors, setActive: vi.fn() }
}

function makeGroups(groups: ReturnType<typeof makeGroup>[], activeIndex = 0) {
  return {
    groups,
    activeGroup: groups[activeIndex],
    activateGroup: vi.fn(),
  } as unknown as IEditorGroupsService
}

describe('revealEditorInGroups', () => {
  it('activates a match found in a non-active group', () => {
    const target = new SingletonInput(URI.file('/singleton'))
    const activeGroup = makeGroup([new TestInput(URI.file('/a.txt'))])
    const otherGroup = makeGroup([target])
    const groups = makeGroups([activeGroup, otherGroup], 0)

    const revealed = revealEditorInGroups(groups, (e) => e instanceof SingletonInput)

    expect(revealed).toBe(true)
    expect(groups.activateGroup).toHaveBeenCalledWith(otherGroup)
    expect(otherGroup.setActive).toHaveBeenCalledWith(target)
    expect(activeGroup.setActive).not.toHaveBeenCalled()
  })

  it('prefers the active group when several groups hold a match', () => {
    // Otherwise "open X" would yank the user into a different split group even
    // though the group they are working in already shows X.
    const inActive = new SingletonInput(URI.file('/active'))
    const inOther = new SingletonInput(URI.file('/other'))
    const activeGroup = makeGroup([inActive])
    const otherGroup = makeGroup([inOther])
    const groups = makeGroups([otherGroup, activeGroup], 1)

    expect(revealEditorInGroups(groups, (e) => e instanceof SingletonInput)).toBe(true)
    expect(groups.activateGroup).toHaveBeenCalledWith(activeGroup)
    expect(activeGroup.setActive).toHaveBeenCalledWith(inActive)
    expect(otherGroup.setActive).not.toHaveBeenCalled()
  })

  it('returns false when no group holds a match', () => {
    const activeGroup = makeGroup([new TestInput(URI.file('/a.txt'))])
    const groups = makeGroups([activeGroup], 0)

    expect(revealEditorInGroups(groups, (e) => e instanceof SingletonInput)).toBe(false)
    expect(groups.activateGroup).not.toHaveBeenCalled()
    expect(activeGroup.setActive).not.toHaveBeenCalled()
  })
})
