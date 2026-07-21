/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for HtmlPreviewInput — identity, naming, and serialize round-trip.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { HtmlPreviewInput } from '../HtmlPreviewInput.js'

describe('HtmlPreviewInput', () => {
  const src = URI.file('/workspace/index.html')

  it('reports the html.preview typeId', () => {
    expect(new HtmlPreviewInput(src).typeId).toBe('html.preview')
  })

  it('uses an html-preview resource scheme so it never collides with the file editor', () => {
    expect(new HtmlPreviewInput(src).resource.scheme).toBe('html-preview')
  })

  it('derives a stable id from the source uri', () => {
    const a = new HtmlPreviewInput(src)
    const b = new HtmlPreviewInput(src)
    expect(a.id).toBe(b.id)
    expect(a.id).toContain('index.html')
  })

  it('names the tab after the source file', () => {
    expect(new HtmlPreviewInput(src).getName()).toContain('index.html')
  })

  it('round-trips through serialize / deserialize', () => {
    const data = new HtmlPreviewInput(src).serialize()
    const restored = HtmlPreviewInput.deserialize(data)
    expect(restored).not.toBeNull()
    expect(restored?.sourceUri.toString()).toBe(src.toString())
  })

  it('returns null when deserializing malformed data', () => {
    expect(HtmlPreviewInput.deserialize(null)).toBeNull()
    expect(HtmlPreviewInput.deserialize({})).toBeNull()
  })

  it('is not dirty and has no held source when constructed from a URI', () => {
    const input = new HtmlPreviewInput(src)
    expect(input.isDirty).toBe(false)
    expect(input.sourceInput).toBeUndefined()
  })
})
