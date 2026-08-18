/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/editor/DiffEditorInput.ts
 *
 *  Covers both the legacy structural behaviour (id / name / cross-file identity /
 *  serialize) and the new editable working-tree diff: `modifiedEditable` gating,
 *  shared-model acquire/release refcounting, dirty tracking against the on-disk
 *  baseline, and save() writing the edited buffer back through IFileService.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { DiffEditorInput } from '../DiffEditorInput.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

function makeFs(initial: Record<string, string> = {}): IFileServiceType & {
  store: Record<string, string>
  writes: Array<{ path: string; content: string }>
} {
  const store = { ...initial }
  const writes: Array<{ path: string; content: string }> = []
  return {
    _serviceBrand: undefined,
    store,
    writes,
    async readFile() {
      throw new Error('not implemented')
    },
    async readFileText(resource: URI) {
      const v = store[resource.toString()]
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    async writeFile(resource: URI, content: Uint8Array | string) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
      store[resource.toString()] = text
      writes.push({ path: resource.toString(), content: text })
    },
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not implemented')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  } as IFileServiceType & {
    store: Record<string, string>
    writes: Array<{ path: string; content: string }>
  }
}

function makeInstantiation(fs: IFileServiceType): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, fs)
  return new InstantiationService(services)
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('DiffEditorInput', () => {
  let fs: ReturnType<typeof makeFs>
  let inst: InstantiationService
  const uri = URI.file('/ws/a.ts')

  beforeEach(() => {
    fs = makeFs()
    inst = makeInstantiation(fs)
  })

  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('same-file diff keeps the legacy id / name / modifiedUri', () => {
    const input = inst.createInstance(
      DiffEditorInput,
      uri,
      'base',
      'current',
      undefined,
      undefined,
      false,
    )
    expect(input.id).toBe(`diff:${uri.toString()}`)
    expect(input.getName()).toBe('a.ts (Diff)')
    expect(input.modifiedUri.toString()).toBe(uri.toString())
    expect(input.resource.scheme).toBe('diff')
    expect(input.isCrossFile).toBe(false)
    input.dispose()
  })

  it('cross-file diff exposes both URIs and a distinct id / name', () => {
    const left = URI.file('/ws/a.ts')
    const right = URI.file('/ws/b.ts')
    const input = inst.createInstance(DiffEditorInput, left, 'A', 'B', right, undefined, false)
    expect(input.originalUri.toString()).toBe(left.toString())
    expect(input.modifiedUri.toString()).toBe(right.toString())
    expect(input.getName()).toBe('a.ts ↔ b.ts')
    expect(input.id).toBe(`diff:${left.toString()}↔${right.toString()}`)
    expect(input.isCrossFile).toBe(true)
    const reversed = inst.createInstance(DiffEditorInput, right, 'B', 'A', left, undefined, false)
    expect(reversed.id).not.toBe(input.id)
    input.dispose()
    reversed.dispose()
  })

  it('passing the same URI for both sides falls back to same-file semantics', () => {
    const input = inst.createInstance(
      DiffEditorInput,
      uri,
      'base',
      'current',
      uri,
      undefined,
      false,
    )
    expect(input.id).toBe(`diff:${uri.toString()}`)
    expect(input.getName()).toBe('a.ts (Diff)')
    expect(input.isCrossFile).toBe(false)
    input.dispose()
  })

  it('exposes openableResource only when provided', () => {
    expect(
      inst.createInstance(DiffEditorInput, uri, 'base', 'current', undefined, undefined, false)
        .openableResource,
    ).toBeUndefined()
    const openable = URI.file('/ws/a.ts')
    const input = inst.createInstance(
      DiffEditorInput,
      uri,
      'base',
      'current',
      undefined,
      openable,
      false,
    )
    expect(input.openableResource?.toString()).toBe(openable.toString())
    input.dispose()
  })

  describe('modifiedEditable', () => {
    it('is true for a live same-file diff and false for a snapshot', () => {
      const live = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'work',
        undefined,
        undefined,
        true,
      )
      const snapshot = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'work',
        undefined,
        undefined,
        false,
      )
      expect(live.modifiedEditable).toBe(true)
      expect(snapshot.modifiedEditable).toBe(false)
      live.dispose()
      snapshot.dispose()
    })

    it('is false for a cross-file compare even when liveModified is set', () => {
      const right = URI.file('/ws/b.ts')
      const input = inst.createInstance(DiffEditorInput, uri, 'A', 'B', right, undefined, true)
      expect(input.modifiedEditable).toBe(false)
      input.dispose()
    })
  })

  describe('shared modified model', () => {
    it('acquires the registry model and refcounts via paired release', () => {
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'disk',
        undefined,
        undefined,
        true,
      )
      const model = input.acquireModifiedModel()
      expect(MonacoModelRegistry.peek(uri)).toBe(model)
      expect(model.getValue()).toBe('disk')
      // Re-acquiring bumps the refcount; the entry stays until every holder releases.
      expect(input.acquireModifiedModel()).toBe(model)
      expect(MonacoModelRegistry.peek(uri)).toBe(model)
      expect(model.isDisposed()).toBe(false)

      input.releaseModifiedModel()
      expect(MonacoModelRegistry.peek(uri)).toBe(model)
      expect(model.isDisposed()).toBe(false)

      input.releaseModifiedModel()
      expect(MonacoModelRegistry.peek(uri)).toBeUndefined()
      expect(model.isDisposed()).toBe(true)

      // dispose() holds no ref — releasing past the last holder is a no-op.
      input.releaseModifiedModel()
      input.dispose()
    })

    it('keeps the shared model alive across dispose (ownership is the component)', () => {
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'disk',
        undefined,
        undefined,
        true,
      )
      const model = input.acquireModifiedModel()
      input.dispose()
      expect(MonacoModelRegistry.peek(uri)).toBe(model)
      expect(model.isDisposed()).toBe(false)
      input.releaseModifiedModel()
      expect(MonacoModelRegistry.peek(uri)).toBeUndefined()
      expect(model.isDisposed()).toBe(true)
    })

    it('stays clean when the file is not on disk (session-added file)', async () => {
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'new-buffer',
        undefined,
        undefined,
        true,
      )
      const model = input.acquireModifiedModel()
      await flush()
      expect(input.isDirty).toBe(false)
      model.setValue('edited')
      expect(input.isDirty).toBe(true)
      input.releaseModifiedModel()
      input.dispose()
    })
  })

  describe('save', () => {
    it('writes the edited shared model through IFileService and clears dirty', async () => {
      const uri = URI.file('/ws/a.txt')
      fs.store[uri.toString()] = 'disk'
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'disk',
        undefined,
        undefined,
        true,
      )
      const model = input.acquireModifiedModel()
      await flush()
      model.setValue('edited')
      expect(input.isDirty).toBe(true)

      const ok = await input.save()

      expect(ok).toBe(true)
      expect(fs.writes).toEqual([{ path: uri.toString(), content: 'edited' }])
      expect(input.isDirty).toBe(false)
      input.dispose()
    })

    it('preserves a leading BOM when writing the edited buffer', async () => {
      const bomUri = URI.file('/ws/bom.txt')
      fs.store[bomUri.toString()] = '﻿hello'
      const input = inst.createInstance(
        DiffEditorInput,
        bomUri,
        'head',
        'hello',
        undefined,
        undefined,
        true,
      )
      const model = input.acquireModifiedModel()
      await flush()
      model.setValue('hello!')
      expect(input.isDirty).toBe(true)

      await input.save()

      expect(fs.writes).toContainEqual({ path: bomUri.toString(), content: '﻿hello!' })
      expect(input.isDirty).toBe(false)
      input.dispose()
    })

    it('is a no-op for a snapshot diff', async () => {
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'parent',
        'commit',
        undefined,
        undefined,
        false,
      )
      const ok = await input.save()
      expect(ok).toBe(true)
      expect(fs.writes).toEqual([])
      input.dispose()
    })

    it('is a no-op when the editable model was never acquired', async () => {
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'disk',
        undefined,
        undefined,
        true,
      )
      const ok = await input.save()
      expect(ok).toBe(true)
      expect(fs.writes).toEqual([])
      input.dispose()
    })

    it('persists the mirrored buffer when the editable diff has no live model (Save All)', async () => {
      const uri = URI.file('/ws/a.txt')
      fs.store[uri.toString()] = 'disk'
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'disk',
        undefined,
        undefined,
        true,
      )
      const model = input.acquireModifiedModel()
      await flush()
      model.setValue('edited')
      // DiffLiveContentSyncContribution mirrors the live file into the input's
      // buffer while the diff is open.
      input.update('head', 'edited')
      // The component released its ref on unmount and the model died — a
      // background tab hit by Save All has no live model to save from.
      input.releaseModifiedModel()
      expect(input.peekModifiedModel()).toBeUndefined()
      expect(input.isDirty).toBe(true)

      const ok = await input.save()

      expect(ok).toBe(true)
      expect(fs.writes).toEqual([{ path: uri.toString(), content: 'edited' }])
      expect(input.isDirty).toBe(false)
      input.dispose()
    })
  })

  describe('liveModified flip', () => {
    it('clears dirty on flip but leaves the shared model to the component release', async () => {
      const uri = URI.file('/ws/a.txt')
      fs.store[uri.toString()] = 'disk'
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'head',
        'disk',
        undefined,
        undefined,
        true,
      )
      const model = input.acquireModifiedModel()
      await flush()
      model.setValue('edited')
      expect(input.isDirty).toBe(true)

      input.update('head', 'commit-blob', false)

      expect(input.modifiedEditable).toBe(false)
      expect(input.isDirty).toBe(false)
      // The input no longer owns the ref — the model survives until the
      // component's set-model effect cleanup releases it.
      expect(MonacoModelRegistry.peek(uri)).toBe(model)
      expect(model.isDisposed()).toBe(false)

      input.releaseModifiedModel()
      expect(MonacoModelRegistry.peek(uri)).toBeUndefined()
      expect(model.isDisposed()).toBe(true)
      input.dispose()
    })
  })

  describe('serialize / deserialize (Ctrl+Shift+T, session restore)', () => {
    it('serializes the structural URIs AND both sides content', () => {
      const openable = URI.file('/ws/a.ts')
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'base',
        'current',
        undefined,
        openable,
        false,
      )
      const data = input.serialize() as unknown as Record<string, unknown>
      expect(data['originalContent']).toBe('base')
      expect(data['modifiedContent']).toBe('current')
      expect(URI.revive(data['originalUri'] as never)?.toString()).toBe(uri.toString())
      expect(data['modifiedUri']).toBeUndefined()
      expect(URI.revive(data['openableResource'] as never)?.toString()).toBe(openable.toString())
      input.dispose()
    })

    it('serializes the modified URI for a cross-file compare', () => {
      const left = URI.file('/ws/a.ts')
      const right = URI.file('/ws/b.ts')
      const input = inst.createInstance(DiffEditorInput, left, 'A', 'B', right, undefined, false)
      const data = input.serialize() as unknown as Record<string, unknown>
      expect(URI.revive(data['modifiedUri'] as never)?.toString()).toBe(right.toString())
      input.dispose()
    })

    it('deserialize without an accessor returns null', () => {
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'base',
        'current',
        undefined,
        undefined,
        false,
      )
      expect(DiffEditorInput.deserialize(input.serialize())).toBeNull()
      input.dispose()
    })

    it('round-trips structure AND content through deserialize via accessor', () => {
      const openable = URI.file('/ws/a.ts')
      const original = inst.createInstance(
        DiffEditorInput,
        uri,
        'base',
        'current',
        undefined,
        openable,
        false,
      )
      const restored = inst.invokeFunction((accessor) =>
        DiffEditorInput.deserialize(original.serialize(), accessor),
      )
      expect(restored).not.toBeNull()
      expect(restored!.id).toBe(original.id)
      expect(restored!.isCrossFile).toBe(false)
      expect(restored!.openableResource?.toString()).toBe(openable.toString())
      expect(restored!.originalContent).toBe('base')
      expect(restored!.modifiedContent).toBe('current')
      expect(restored!.originalContent).not.toBe(restored!.modifiedContent)
      original.dispose()
      restored?.dispose()
    })

    it('round-trips a cross-file compare identity + content', () => {
      const left = URI.file('/ws/a.ts')
      const right = URI.file('/ws/b.ts')
      const original = inst.createInstance(DiffEditorInput, left, 'A', 'B', right, undefined, false)
      const restored = inst.invokeFunction((accessor) =>
        DiffEditorInput.deserialize(original.serialize(), accessor),
      )
      expect(restored!.isCrossFile).toBe(true)
      expect(restored!.id).toBe(`diff:${left.toString()}↔${right.toString()}`)
      expect(restored!.originalContent).toBe('A')
      expect(restored!.modifiedContent).toBe('B')
      original.dispose()
      restored?.dispose()
    })

    it('round-trips the liveModified flag', () => {
      const live = inst.createInstance(
        DiffEditorInput,
        uri,
        'base',
        'current',
        undefined,
        undefined,
        true,
      )
      const snapshot = inst.createInstance(
        DiffEditorInput,
        uri,
        'base',
        'current',
        undefined,
        undefined,
        false,
      )
      const restoredLive = inst.invokeFunction((accessor) =>
        DiffEditorInput.deserialize(live.serialize(), accessor),
      )
      const restoredSnapshot = inst.invokeFunction((accessor) =>
        DiffEditorInput.deserialize(snapshot.serialize(), accessor),
      )
      expect(live.liveModified).toBe(true)
      expect(snapshot.liveModified).toBe(false)
      expect(restoredLive!.liveModified).toBe(true)
      expect(restoredSnapshot!.liveModified).toBe(false)
      live.dispose()
      snapshot.dispose()
      restoredLive?.dispose()
      restoredSnapshot?.dispose()
    })

    it('rejects malformed payloads', () => {
      expect(DiffEditorInput.deserialize(null)).toBeNull()
      expect(DiffEditorInput.deserialize({})).toBeNull()
    })

    it('serializeForPersistence keeps full content within budget', () => {
      const input = inst.createInstance(
        DiffEditorInput,
        uri,
        'base',
        'current',
        undefined,
        undefined,
        false,
      )
      expect(input.serializeForPersistence(1024)).toEqual(input.serialize())
      input.dispose()
    })

    it('serializeForPersistence drops content over budget and deserialize skips it', () => {
      const left = URI.file('/ws/a.ts')
      const right = URI.file('/ws/b.ts')
      const input = inst.createInstance(
        DiffEditorInput,
        left,
        'A'.repeat(100),
        'B'.repeat(100),
        right,
        undefined,
        false,
      )
      const data = input.serializeForPersistence(64) as unknown as Record<string, unknown>
      expect(data['contentDropped']).toBe(true)
      expect(data['originalContent']).toBe('')
      expect(data['modifiedContent']).toBe('')
      expect(URI.revive(data['modifiedUri'] as never)?.toString()).toBe(right.toString())
      expect(DiffEditorInput.deserialize(data)).toBeNull()
      input.dispose()
    })
  })
})
