/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  timelineFollowTarget — three-way mapping from the active editor to what the
 *  Timeline view should follow. A virtual editor (graph, settings, …) must keep
 *  the timeline on the previous file ('keep') instead of blanking it; only the
 *  absence of any active editor clears the view.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, type IFileService } from '@universe-editor/platform'
import { DiffEditorInput } from '../../editor/DiffEditorInput.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { GitGraphEditorInput } from '../../editor/GitGraphEditorInput.js'
import { PerforceGraphEditorInput } from '../../editor/PerforceGraphEditorInput.js'
import { SettingsEditorInput } from '../../editor/SettingsEditorInput.js'
import { timelineFollowTarget } from '../followTarget.js'

const fileService = {} as IFileService

describe('timelineFollowTarget', () => {
  it('follows a file editor', () => {
    const uri = URI.file('/ws/a.ts')
    const target = timelineFollowTarget(new FileEditorInput(uri, fileService))
    expect(target).not.toBe('keep')
    expect(target?.toString()).toBe(uri.toString())
  })

  it('follows the file behind a diff editor', () => {
    const uri = URI.file('/ws/a.ts')
    const target = timelineFollowTarget(
      new DiffEditorInput(uri, 'base', 'current', undefined, undefined, false, fileService),
    )
    expect(target).not.toBe('keep')
    expect(target?.toString()).toBe(uri.toString())
  })

  it('keeps the current file while a virtual editor is active', () => {
    expect(timelineFollowTarget(new GitGraphEditorInput())).toBe('keep')
    expect(timelineFollowTarget(new PerforceGraphEditorInput())).toBe('keep')
    expect(timelineFollowTarget(new SettingsEditorInput())).toBe('keep')
  })

  it('clears when there is no active editor', () => {
    expect(timelineFollowTarget(undefined)).toBeUndefined()
    expect(timelineFollowTarget(null)).toBeUndefined()
  })
})
