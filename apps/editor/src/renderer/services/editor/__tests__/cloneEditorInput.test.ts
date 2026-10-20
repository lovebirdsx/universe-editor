/*---------------------------------------------------------------------------------------------
 *  Tests for cloneEditorInputForSplit — an uncopyable input must never fall
 *  back to the original instance (sharing it across groups lets either close
 *  dispose the other's tab).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { EditorInput, EditorRegistry, URI, type ServicesAccessor } from '@universe-editor/platform'
import { canCloneEditorInputForSplit, cloneEditorInputForSplit } from '../cloneEditorInput.js'

class CloneableInput extends EditorInput {
  static readonly TYPE_ID = 'clone.test'
  constructor(
    private readonly _name: string,
    private readonly _resource = URI.from({ scheme: 'clone', path: `/${_name}` }),
  ) {
    super()
  }
  get typeId(): string {
    return CloneableInput.TYPE_ID
  }
  get resource(): URI {
    return this._resource
  }
  getName(): string {
    return this._name
  }
  override serialize(): { name: string } {
    return { name: this._name }
  }
}

class NoSerializeInput extends EditorInput {
  get typeId(): string {
    return 'clone.no-serialize'
  }
  get resource(): URI {
    return URI.from({ scheme: 'clone', path: '/no-serialize' })
  }
  getName(): string {
    return 'NoSerialize'
  }
}

class UndefinedSerializeInput extends NoSerializeInput {
  override get typeId(): string {
    return 'clone.undefined-serialize'
  }
  override get resource(): URI {
    return URI.from({ scheme: 'clone', path: '/undefined-serialize' })
  }
  override serialize(): undefined {
    return undefined
  }
}

const accessor = {
  get(): never {
    throw new Error('no services in this test')
  },
} as unknown as ServicesAccessor

const disposables: { dispose(): void }[] = []

afterEach(() => {
  while (disposables.length > 0) disposables.pop()!.dispose()
})

function registerProvider(typeId: string, deserialize?: (data: unknown) => EditorInput | null) {
  disposables.push(
    EditorRegistry.registerEditorProvider({
      typeId,
      componentKey: typeId,
      ...(deserialize ? { deserialize } : {}),
    }),
  )
}

describe('cloneEditorInputForSplit', () => {
  it('returns a distinct instance with the same identity for serializable types', () => {
    registerProvider(CloneableInput.TYPE_ID, (data) => {
      const d = data as { name: string }
      return new CloneableInput(d.name)
    })
    const input = new CloneableInput('a')
    expect(canCloneEditorInputForSplit(input)).toBe(true)

    const clone = cloneEditorInputForSplit(input, accessor)
    expect(clone).toBeDefined()
    expect(clone).not.toBe(input)
    expect(clone?.id).toBe(input.id)
    expect(clone?.typeId).toBe(input.typeId)
  })

  it('returns undefined instead of the original when the input has no serialize hook', () => {
    registerProvider('clone.no-serialize', () => new NoSerializeInput())
    const input = new NoSerializeInput()
    expect(canCloneEditorInputForSplit(input)).toBe(false)
    expect(cloneEditorInputForSplit(input, accessor)).toBeUndefined()
  })

  it('returns undefined when serialize() yields nothing', () => {
    registerProvider('clone.undefined-serialize', () => new UndefinedSerializeInput())
    const input = new UndefinedSerializeInput()
    expect(cloneEditorInputForSplit(input, accessor)).toBeUndefined()
  })

  it('returns undefined when the type has no deserialize provider', () => {
    registerProvider('clone.no-deserialize')
    const input = new CloneableInput('a')
    expect(canCloneEditorInputForSplit(input)).toBe(false)
    expect(cloneEditorInputForSplit(input, accessor)).toBeUndefined()
  })

  it('returns undefined when deserialization rejects the snapshot', () => {
    registerProvider(CloneableInput.TYPE_ID, () => null)
    const input = new CloneableInput('a')
    expect(canCloneEditorInputForSplit(input)).toBe(true)
    expect(cloneEditorInputForSplit(input, accessor)).toBeUndefined()
  })
})
