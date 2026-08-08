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
  perforceGraphViewState.focusRows = null
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
})
