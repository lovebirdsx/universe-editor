import { describe, expect, it, vi } from 'vitest'
import type { EditorInput, IEditorGroup, IEditorGroupsService } from '@universe-editor/platform'
import { openInLockAwareGroup } from '../openInLockAwareGroup.js'

function makeGroup(isLocked = false, existing?: EditorInput) {
  return {
    isLocked,
    openEditor: vi.fn(),
    findEditor: vi.fn(() => existing),
  } as unknown as IEditorGroup
}

function makeGroups(activeGroup: IEditorGroup, activeGroupForOpen: IEditorGroup) {
  const activateGroup = vi.fn()
  const groups = {
    activeGroup,
    activeGroupForOpen,
    openTargetGroup: activeGroup,
    activateGroup,
  } as unknown as IEditorGroupsService
  return { groups, activateGroup }
}

const editor = {} as never

describe('openInLockAwareGroup — preferred group', () => {
  it('opens in the preferred group and activates it when it is not the active group', () => {
    const active = makeGroup()
    const preferred = makeGroup()
    const { groups, activateGroup } = makeGroups(active, active)

    openInLockAwareGroup(groups, editor, { activate: true }, preferred)

    expect(preferred.openEditor).toHaveBeenCalledTimes(1)
    expect(active.openEditor).not.toHaveBeenCalled()
    expect(activateGroup).toHaveBeenCalledWith(preferred)
  })

  it('falls back to the lock-aware group when the preferred group is locked', () => {
    const active = makeGroup()
    const unlocked = makeGroup()
    const lockedPreferred = makeGroup(true)
    const { groups, activateGroup } = makeGroups(active, unlocked)

    openInLockAwareGroup(groups, editor, { activate: true }, lockedPreferred)

    expect(lockedPreferred.openEditor).not.toHaveBeenCalled()
    expect(unlocked.openEditor).toHaveBeenCalledTimes(1)
    expect(activateGroup).toHaveBeenCalledWith(unlocked)
  })

  it('keeps the existing lock-aware routing without a preferred group', () => {
    const active = makeGroup()
    const unlocked = makeGroup()
    const { groups, activateGroup } = makeGroups(active, unlocked)

    openInLockAwareGroup(groups, editor)

    expect(unlocked.openEditor).toHaveBeenCalledTimes(1)
    expect(activateGroup).toHaveBeenCalledWith(unlocked)
  })

  it('does not activate when the target is already the active group', () => {
    const active = makeGroup()
    const { groups, activateGroup } = makeGroups(active, active)

    openInLockAwareGroup(groups, editor, { activate: true }, active)

    expect(active.openEditor).toHaveBeenCalledTimes(1)
    expect(activateGroup).not.toHaveBeenCalled()
  })
})

describe('openInLockAwareGroup — dedupe winner', () => {
  it('returns the caller input when the target opens it as a new tab', () => {
    const active = makeGroup()
    const { groups } = makeGroups(active, active)

    expect(openInLockAwareGroup(groups, editor)).toBe(editor)
  })

  it('returns the existing instance when the target group dedupes the input', () => {
    const active = makeGroup()
    const existing = {} as EditorInput
    const unlocked = makeGroup(false, existing)
    const { groups } = makeGroups(active, unlocked)

    expect(openInLockAwareGroup(groups, editor)).toBe(existing)
  })
})
