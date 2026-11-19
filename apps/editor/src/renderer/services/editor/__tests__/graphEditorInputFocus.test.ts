/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Graph editor inputs route focus() into the mounted editor's row list via
 *  the view-state callback, so opening/activating the tab lands keyboard focus
 *  on the commits; without a mounted editor they decline, letting
 *  focusEditorInput fall back to the group body.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitGraphViewState } from '../../gitGraph/gitGraphViewState.js'
import { perforceGraphViewState } from '../../perforceGraph/perforceGraphViewState.js'
import { GitGraphEditorInput } from '../GitGraphEditorInput.js'
import { PerforceGraphEditorInput } from '../PerforceGraphEditorInput.js'

afterEach(() => {
  gitGraphViewState.focusRows = null
  gitGraphViewState.focusRowsByGroup.clear()
  perforceGraphViewState.focusRows = null
  perforceGraphViewState.focusRowsByGroup.clear()
})

describe('graph editor input focus()', () => {
  it('declines when no editor is mounted', () => {
    expect(new GitGraphEditorInput().focus()).toBe(false)
    expect(new PerforceGraphEditorInput().focus()).toBe(false)
  })

  it('forwards to the mounted editor’s row-list focus callback', () => {
    const gitFocus = vi.fn()
    const p4Focus = vi.fn()
    gitGraphViewState.focusRows = gitFocus
    perforceGraphViewState.focusRows = p4Focus

    expect(new GitGraphEditorInput().focus()).toBe(true)
    expect(gitFocus).toHaveBeenCalledTimes(1)
    expect(new PerforceGraphEditorInput().focus()).toBe(true)
    expect(p4Focus).toHaveBeenCalledTimes(1)
  })

  it('prefers the requesting group’s mounted editor over the last registration', () => {
    const mainGit = vi.fn()
    const auxGit = vi.fn()
    const mainP4 = vi.fn()
    const auxP4 = vi.fn()
    // The main window remounted last; a group-less read would pick these.
    gitGraphViewState.focusRowsByGroup.set(1, mainGit)
    gitGraphViewState.focusRowsByGroup.set(2, auxGit)
    gitGraphViewState.focusRows = mainGit
    perforceGraphViewState.focusRowsByGroup.set(1, mainP4)
    perforceGraphViewState.focusRowsByGroup.set(2, auxP4)
    perforceGraphViewState.focusRows = mainP4

    expect(new GitGraphEditorInput().focus(2)).toBe(true)
    expect(auxGit).toHaveBeenCalledTimes(1)
    expect(mainGit).not.toHaveBeenCalled()
    expect(new PerforceGraphEditorInput().focus(2)).toBe(true)
    expect(auxP4).toHaveBeenCalledTimes(1)
    expect(mainP4).not.toHaveBeenCalled()
  })
})
