/*---------------------------------------------------------------------------------------------
 *  Tests for openResourcePreviewInGroup — the hover "Open Preview" button every
 *  file list shares. Both flavors route through openPreviewInGroup, so a preview
 *  of the same file is globally unique and previews of different files coexist.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { GroupDirection, URI } from '@universe-editor/platform'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import { HtmlPreviewInput } from '../../editor/HtmlPreviewInput.js'
import { MarkdownPreviewInput } from '../../editor/MarkdownPreviewInput.js'
import { openResourcePreviewInGroup } from '../openResourcePreview.js'

describe('openResourcePreviewInGroup', () => {
  let groups: EditorGroupsService
  let group: EditorGroupsService['activeGroup']

  beforeEach(() => {
    groups = new EditorGroupsService()
    group = groups.activeGroup
  })

  it('opens a markdown preview pinned in the target group', () => {
    expect(openResourcePreviewInGroup(groups, group, URI.file('/repo/a.md'))).toBe(true)

    expect(group.editors).toHaveLength(1)
    expect(group.activeEditor).toBeInstanceOf(MarkdownPreviewInput)
  })

  it('opens an html preview', () => {
    expect(openResourcePreviewInGroup(groups, group, URI.file('/repo/a.html'))).toBe(true)

    expect(group.activeEditor).toBeInstanceOf(HtmlPreviewInput)
  })

  it('focuses the existing preview of the same file in another group', () => {
    const side = groups.addGroup(group, GroupDirection.Right)
    const existing = new MarkdownPreviewInput(URI.file('/repo/a.md'))
    side.openEditor(existing, { activate: true, pinned: true })
    groups.activateGroup(group)

    expect(openResourcePreviewInGroup(groups, group, URI.file('/repo/a.md'))).toBe(true)

    expect(groups.activeGroup).toBe(side)
    expect(group.editors).toHaveLength(0)
    expect(side.editors).toEqual([existing])
  })

  it('lets previews of different files coexist', () => {
    expect(openResourcePreviewInGroup(groups, group, URI.file('/repo/a.md'))).toBe(true)
    const first = group.activeEditor
    expect(openResourcePreviewInGroup(groups, group, URI.file('/repo/b.md'))).toBe(true)

    expect(group.editors).toHaveLength(2)
    expect(first!.isDisposed).toBe(false)
  })

  it('returns false for a resource with no preview flavor', () => {
    expect(openResourcePreviewInGroup(groups, group, URI.file('/repo/main.ts'))).toBe(false)
    expect(group.editors).toHaveLength(0)
  })
})
