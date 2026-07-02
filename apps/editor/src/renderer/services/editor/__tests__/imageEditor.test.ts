/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { ImageEditorInput } from '../ImageEditorInput.js'
import { FileEditorInput } from '../FileEditorInput.js'
import { EditorService } from '../EditorService.js'
import { isImageResource } from '../imageFileTypes.js'
import { fileUriToImageUrl, imageRequestUrlToFileUrl } from '../../../../shared/imageResource.js'

function makeFileInput(resource: URI): FileEditorInput {
  const services = new ServiceCollection()
  services.set(IFileService, { _serviceBrand: undefined } as unknown as IFileServiceType)
  return new InstantiationService(services).createInstance(FileEditorInput, resource)
}

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

  it('keeps a distinct identity from the text FileEditorInput for the same file', () => {
    const uri = URI.file('/w/pics/logo.svg')
    const image = new ImageEditorInput(uri)
    const text = makeFileInput(uri)

    // Both surface the real file: resource (needed for tab icon, SCM
    // decorations, ue-file loading), but their editor identity must differ so
    // the image preview and the text view can coexist as two tabs.
    expect(image.resource.toString()).toBe(text.resource.toString())
    expect(image.id).not.toBe(text.id)
    expect(image.matches(text)).toBe(false)
    expect(text.matches(image)).toBe(false)
  })
})

describe('EditorService: image and text editors of one file coexist', () => {
  it('does not dedupe an image tab against a text tab for the same file', () => {
    const svc = new EditorService()
    const uri = URI.file('/w/pics/logo.svg')

    svc.openEditor(makeFileInput(uri), { pinned: true })
    svc.openEditor(new ImageEditorInput(uri), { pinned: true })

    const ids = svc.openEditors.get().map((e) => e.id)
    expect(ids).toHaveLength(2)
    expect(ids).toContain(uri.toString())
    expect(ids).toContain(`image:${uri.toString()}`)
  })

  it('reactivates the same image tab instead of opening a duplicate', () => {
    const svc = new EditorService()
    const uri = URI.file('/w/pics/logo.svg')

    const first = new ImageEditorInput(uri)
    svc.openEditor(first, { pinned: true })
    const second = new ImageEditorInput(uri)
    svc.openEditor(second, { pinned: true })

    expect(svc.openEditors.get()).toHaveLength(1)
    expect(second.isDisposed).toBe(true)
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
