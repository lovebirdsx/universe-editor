/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for MarkdownPreviewInput — identity, naming, and serialize round-trip.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { MarkdownPreviewInput } from '../MarkdownPreviewInput.js'

describe('MarkdownPreviewInput', () => {
  const src = URI.file('/workspace/readme.md')

  it('reports the markdown.preview typeId', () => {
    expect(new MarkdownPreviewInput(src).typeId).toBe('markdown.preview')
  })

  it('uses a markdown-preview resource scheme', () => {
    expect(new MarkdownPreviewInput(src).resource.scheme).toBe('markdown-preview')
  })

  it('derives a stable id from the source uri', () => {
    const a = new MarkdownPreviewInput(src)
    const b = new MarkdownPreviewInput(src)
    expect(a.id).toBe(b.id)
    expect(a.id).toContain('readme.md')
  })

  it('names the tab after the source file', () => {
    expect(new MarkdownPreviewInput(src).getName()).toContain('readme.md')
  })

  it('round-trips through serialize / deserialize', () => {
    const data = new MarkdownPreviewInput(src).serialize()
    const restored = MarkdownPreviewInput.deserialize(data)
    expect(restored).not.toBeNull()
    expect(restored?.sourceUri.toString()).toBe(src.toString())
  })

  it('returns null when deserializing malformed data', () => {
    expect(MarkdownPreviewInput.deserialize(null)).toBeNull()
    expect(MarkdownPreviewInput.deserialize({})).toBeNull()
  })
})
