/*---------------------------------------------------------------------------------------------
 *  Tests for SwarmDiffEditorInput's serialize/deserialize round-trip. The history,
 *  Ctrl+Shift+T and workspace-restore paths rely on it to rebuild a closed Swarm
 *  diff without re-reading p4.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  IFileService,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import {
  parseSwarmDiffContext,
  SwarmDiffEditorInput,
  type SwarmDiffContext,
} from '../SwarmDiffEditorInput.js'

function makeFs(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileHead() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not used')
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
  }
}

function makeInst(): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, makeFs())
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return inst
}

const LOCAL_PATH = 'X:/workspace/main/src/file.ts'

function makeContext(overrides: Partial<SwarmDiffContext> = {}): SwarmDiffContext {
  return {
    reviewId: '101',
    depotFile: '//depot/branch_x/main/src/file.ts',
    displayPath: 'main/src/file.ts',
    localPath: LOCAL_PATH,
    leftVersion: 0,
    rightVersion: 2,
    leftChange: null,
    rightChange: '9001',
    ...overrides,
  }
}

function createInput(inst: InstantiationService, context: SwarmDiffContext): SwarmDiffEditorInput {
  return inst.createInstance(SwarmDiffEditorInput, context, 'before', 'after')
}

describe('SwarmDiffEditorInput serialize/deserialize', () => {
  it('round-trips both sides and the full Swarm context', () => {
    const inst = makeInst()
    const context = makeContext()
    const input = createInput(inst, context)

    const revived = inst.invokeFunction((accessor) =>
      SwarmDiffEditorInput.deserialize(input.serialize(), accessor),
    )

    expect(revived).toBeInstanceOf(SwarmDiffEditorInput)
    expect(revived!.context).toEqual(context)
    expect(revived!.originalContent).toBe('before')
    expect(revived!.modifiedContent).toBe('after')
    expect(revived!.resource.toString()).toBe(input.resource.toString())
    expect(revived!.id).toBe(input.id)
    expect(revived!.getName()).toBe(input.getName())
    expect(revived!.openableResource?.toString()).toBe(URI.file(LOCAL_PATH).toString())
    expect(revived!.fileUri.toString()).toBe(input.fileUri.toString())
  })

  it('preserves an omitted change pair (no own property) and an explicit null pair', () => {
    const inst = makeInst()
    const omitted = makeContext()
    delete (omitted as { leftChange?: string | null }).leftChange
    delete (omitted as { rightChange?: string | null }).rightChange
    const explicitNull = makeContext({ leftChange: null, rightChange: null })

    for (const context of [omitted, explicitNull]) {
      const input = createInput(inst, context)
      const revived = inst.invokeFunction((accessor) =>
        SwarmDiffEditorInput.deserialize(input.serialize(), accessor),
      )
      expect(revived).toBeInstanceOf(SwarmDiffEditorInput)
      expect(revived!.resource.toString()).toBe(input.resource.toString())
      expect(revived!.id).toBe(input.id)
      if (context.leftChange === undefined) {
        expect(Object.hasOwn(revived!.context, 'leftChange')).toBe(false)
        expect(Object.hasOwn(revived!.context, 'rightChange')).toBe(false)
      } else {
        expect(revived!.context.leftChange).toBeNull()
        expect(revived!.context.rightChange).toBeNull()
      }
    }
  })

  it('leaves openableResource undefined when the depot file has no local mapping', () => {
    const inst = makeInst()
    const input = createInput(inst, makeContext({ localPath: null }))
    const revived = inst.invokeFunction((accessor) =>
      SwarmDiffEditorInput.deserialize(input.serialize(), accessor),
    )
    expect(revived!.openableResource).toBeUndefined()
  })

  it('persists the context within the budget and drops it over budget', () => {
    const inst = makeInst()
    const input = createInput(inst, makeContext())

    const budgeted = input.serializeForPersistence(1024)
    expect('contentDropped' in budgeted).toBe(false)
    expect(budgeted).toEqual(input.serialize())

    const dropped = input.serializeForPersistence(1)
    expect((dropped as { contentDropped?: boolean }).contentDropped).toBe(true)
    expect(
      inst.invokeFunction((accessor) => SwarmDiffEditorInput.deserialize(dropped, accessor)),
    ).toBeNull()
  })

  it('rejects corrupt, incomplete or legacy payloads', () => {
    const inst = makeInst()
    const valid = createInput(inst, makeContext()).serialize()

    const cases: unknown[] = [
      null,
      undefined,
      {},
      { ...valid, context: undefined },
      { ...valid, context: { ...valid.context, reviewId: 42 } },
      { ...valid, context: { ...valid.context, leftVersion: 'zero' } },
      { ...valid, context: { ...valid.context, leftChange: 42 } },
      { ...valid, originalContent: 7 },
      { ...valid, modifiedContent: null },
      // Legacy payload written before context was serialized.
      {
        originalUri: valid.originalUri,
        originalContent: valid.originalContent,
        modifiedContent: valid.modifiedContent,
      },
    ]
    for (const data of cases) {
      expect(
        inst.invokeFunction((accessor) => SwarmDiffEditorInput.deserialize(data, accessor)),
      ).toBeNull()
    }
    expect(SwarmDiffEditorInput.deserialize(valid)).toBeNull()
  })
})

describe('parseSwarmDiffContext', () => {
  it('accepts a valid context and omits undefined optional members', () => {
    expect(parseSwarmDiffContext(makeContext())).toEqual(makeContext())
    expect(parseSwarmDiffContext(makeContext({ leftVersion: null, localPath: null }))).toEqual(
      makeContext({ leftVersion: null, localPath: null }),
    )
    const raw = makeContext()
    delete (raw as { leftChange?: string | null }).leftChange
    expect(Object.hasOwn(parseSwarmDiffContext(raw)!, 'leftChange')).toBe(false)
  })

  it('rejects malformed contexts', () => {
    expect(parseSwarmDiffContext(null)).toBeNull()
    expect(parseSwarmDiffContext('nope')).toBeNull()
    expect(parseSwarmDiffContext({ ...makeContext(), reviewId: '' })).toBeNull()
    expect(parseSwarmDiffContext({ ...makeContext(), localPath: 3 })).toBeNull()
    expect(parseSwarmDiffContext({ ...makeContext(), rightVersion: Number.NaN })).toBeNull()
  })
})
