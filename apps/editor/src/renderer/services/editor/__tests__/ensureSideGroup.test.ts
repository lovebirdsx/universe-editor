/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for ensureSideGroup — the "open to the side" target every beside-entry
 *  point shares. The activating side effect is load-bearing (the resolver routes
 *  new editors through activeGroupForOpen), so it is asserted here rather than
 *  left to the call sites.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { GroupDirection } from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { ensureSideGroup } from '../openToSide.js'

describe('ensureSideGroup', () => {
  let groups: EditorGroupsService

  beforeEach(() => {
    groups = new EditorGroupsService()
  })

  it('creates and activates a group to the right when the layout has none', () => {
    const source = groups.activeGroup

    const target = ensureSideGroup(groups)

    expect(target).not.toBe(source)
    expect(groups.count).toBe(2)
    expect(groups.activeGroup).toBe(target)
    expect(groups.findGroup({ direction: GroupDirection.Right }, source)).toBe(target)
  })

  it('reuses an existing right neighbour instead of adding another group', () => {
    const source = groups.activeGroup
    const existing = groups.addGroup(source, GroupDirection.Right)
    groups.activateGroup(source)

    expect(ensureSideGroup(groups)).toBe(existing)
    expect(groups.count).toBe(2)
    // Re-activated, so a subsequent resolver open lands there rather than in
    // whichever group happened to be active.
    expect(groups.activeGroup).toBe(existing)
  })

  it('reuses the group it created when asked again from the same source', () => {
    const source = groups.activeGroup

    const first = ensureSideGroup(groups, source)

    expect(ensureSideGroup(groups, source)).toBe(first)
    expect(groups.count).toBe(2)
  })

  it('extends rightwards when the default source is already the rightmost group', () => {
    // Each beside-open activates its target, so a second call with the default
    // source measures from the group the first one just opened. The layout grows
    // to the right instead of piling into one side group — the same behaviour
    // Quick Open's Ctrl+Enter has.
    const first = ensureSideGroup(groups)

    const second = ensureSideGroup(groups)

    expect(second).not.toBe(first)
    expect(groups.count).toBe(3)
  })

  it('defaults the source to the active group', () => {
    const left = groups.activeGroup
    const right = groups.addGroup(left, GroupDirection.Right)
    groups.activateGroup(right)

    // From the active (rightmost) group there is no neighbour to reuse, so a
    // third group is added rather than `right` being handed back.
    const third = ensureSideGroup(groups)

    expect(third).not.toBe(right)
    expect(groups.count).toBe(3)
  })

  it('uses an explicit source rather than the active group', () => {
    const left = groups.activeGroup
    const right = groups.addGroup(left, GroupDirection.Right)
    const third = groups.addGroup(right, GroupDirection.Right)
    groups.activateGroup(third)

    // `right` already sits beside `left` — reused even though `left` is not the
    // active group.
    expect(ensureSideGroup(groups, left)).toBe(right)
    expect(groups.count).toBe(3)
  })
})
