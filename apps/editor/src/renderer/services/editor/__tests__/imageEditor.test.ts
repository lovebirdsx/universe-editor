/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { ImageEditorInput } from '../ImageEditorInput.js'
import { isImageResource } from '../imageFileTypes.js'
import { fileUriToImageUrl, imageRequestUrlToFileUrl } from '../../../../shared/imageResource.js'

describe('isImageResource', () => {
  it('accepts known image extensions regardless of case', () => {
    expect(isImageResource(URI.file('/a/b/pic.png'))).toBe(true)
    expect(isImageResource(URI.file('/a/b/pic.JPG'))).toBe(true)
    expect(isImageResource(URI.file('/a/b/logo.svg'))).toBe(true)
    expect(isImageResource(URI.file('/a/b/anim.gif'))).toBe(true)
  })

  it('rejects non-image and extensionless files', () => {
    expect(isImageResource(URI.file('/a/b/notes.txt'))).toBe(false)
    expect(isImageResource(URI.file('/a/b/README'))).toBe(false)
    expect(isImageResource(URI.file('/a/b/.gitignore'))).toBe(false)
  })
})

describe('ImageEditorInput', () => {
  it('reports its type id and resource-derived name', () => {
    const input = new ImageEditorInput(URI.file('/w/pics/cat.png'))
    expect(input.typeId).toBe('image')
    expect(input.getName()).toBe('cat.png')
    expect(input.isDirty).toBe(false)
  })

  it('round-trips through serialize / deserialize', () => {
    const input = new ImageEditorInput(URI.file('/w/pics/cat.png'))
    const restored = ImageEditorInput.deserialize(input.serialize())
    expect(restored).not.toBeNull()
    expect(restored?.resource.toString()).toBe(input.resource.toString())
  })

  it('deserialize returns null on malformed data', () => {
    expect(ImageEditorInput.deserialize(null)).toBeNull()
    expect(ImageEditorInput.deserialize({})).toBeNull()
  })
})

describe('ue-file url bridging', () => {
  it('maps a file URI to a ue-file url and back to the same file url', () => {
    const resource = URI.file('D:/my pics/图.png')
    const imageUrl = fileUriToImageUrl(resource)
    expect(imageUrl.startsWith('ue-file://local/')).toBe(true)
    expect(imageRequestUrlToFileUrl(imageUrl)).toBe(resource.toString())
  })

  it('preserves posix paths through the round-trip', () => {
    const resource = URI.file('/home/u/a b/pic.jpeg')
    expect(imageRequestUrlToFileUrl(fileUriToImageUrl(resource))).toBe(resource.toString())
  })
})
