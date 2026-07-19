/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  A markdown preview tab carries a virtual `markdown-preview:` URI, but its
 *  right-click file commands must target the underlying source `.md` file so the
 *  `resourceScheme == file` when-clauses show them and the commands have a
 *  `file:` URI to act on. tabContextMenuResource performs that mapping.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { tabContextMenuResource } from '../tabContextMenuResource.js'
import { MarkdownPreviewInput } from '../../../services/editor/MarkdownPreviewInput.js'

describe('tabContextMenuResource', () => {
  it('maps a markdown preview tab to its source file URI', () => {
    const source = URI.file('D:/docs/note.md')
    const preview = new MarkdownPreviewInput(source)

    const result = tabContextMenuResource(preview)

    expect(result?.scheme).toBe('file')
    expect(result?.toString()).toBe(source.toString())
  })

  it('returns a plain input resource unchanged', () => {
    const resource = URI.file('D:/src/index.ts')

    expect(tabContextMenuResource({ resource })).toBe(resource)
  })

  it('returns null when the input has no URI resource', () => {
    expect(tabContextMenuResource({ resource: 'diff:whatever' })).toBeNull()
    expect(tabContextMenuResource({})).toBeNull()
  })
})
