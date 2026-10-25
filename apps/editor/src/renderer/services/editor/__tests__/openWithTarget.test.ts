import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  EditorRegistry,
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IEditorGroup,
  type IUriIdentityService,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { ensureSideGroup } from '../openToSide.js'
import type {
  IAuxiliaryEditorWindowService,
  OpenEditorInNewWindowOptions,
  OpenEditorInNewWindowResult,
} from '../../windows/auxiliaryEditorWindowService.js'
import {
  openExistingInputWithTarget,
  openFreshInputWithTarget,
  openPinnedSingletonEditor,
  openSingletonEditor,
  openSingletonWithTarget,
  openUriEditor,
  openUriWithTarget,
  type OpenTargetServices,
} from '../openWithTarget.js'

class PlainEditor extends EditorInput {
  constructor(private readonly _resource: URI = URI.file('X:/plain.txt')) {
    super()
  }
  get typeId() {
    return 'test.plain'
  }
  get resource() {
    return this._resource
  }
  getName() {
    return this._resource.path
  }
}

class CloneableEditor extends EditorInput {
  static readonly TYPE_ID = 'test.cloneable'

  constructor(
    private readonly _name: string,
    private readonly _id?: string,
  ) {
    super()
  }
  get typeId() {
    return CloneableEditor.TYPE_ID
  }
  get resource() {
    return URI.file(`X:/${this._name}.txt`)
  }
  override get id() {
    return this._id ?? super.id
  }
  getName() {
    return this._name
  }
  override serialize(): { name: string } {
    return { name: this._name }
  }
  static deserialize(data: unknown): CloneableEditor | null {
    const d = data as { name?: string } | null
    return d?.name ? new CloneableEditor(d.name) : null
  }
}

class TrackedEditor extends PlainEditor {
  disposeCount = 0
  override dispose(): void {
    this.disposeCount++
    super.dispose()
  }
}

class FakeAuxiliaryEditorWindowService {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{
    editor: EditorInput
    options: OpenEditorInNewWindowOptions | undefined
  }> = []
  failModes = new Set<string>()

  constructor(private readonly _groups: EditorGroupsService) {}

  async openEditorInNewWindow(
    editor: EditorInput,
    options?: OpenEditorInNewWindowOptions,
  ): Promise<OpenEditorInNewWindowResult> {
    this.calls.push({ editor, options })
    const mode = options?.mode ?? 'open'
    if (this.failModes.has(mode)) return { ok: false, reason: 'error' }
    return {
      ok: true,
      window: {
        part: { activeGroup: this._groups.activeGroup },
      } as never,
      editor,
    }
  }
}

function makeUriIdentity(): IUriIdentityService {
  return {
    isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  } as unknown as IUriIdentityService
}

function makeServices(
  groups: EditorGroupsService,
  aux: FakeAuxiliaryEditorWindowService,
  resolver?: { createEditorInput(uri: URI): EditorInput; created: URI[] },
): OpenTargetServices {
  return {
    groups,
    aux: aux as unknown as IAuxiliaryEditorWindowService,
    inst: new InstantiationService(new ServiceCollection()),
    uriIdentity: makeUriIdentity(),
    ...(resolver !== undefined ? { resolver: resolver as unknown as IEditorResolverService } : {}),
  }
}

function sideGroupOf(groups: EditorGroupsService, source: IEditorGroup): IEditorGroup {
  return ensureSideGroup(groups, source)
}

const disposables: Array<{ dispose(): void }> = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
})

function makeGroups(): EditorGroupsService {
  const groups = new EditorGroupsService()
  disposables.push(groups)
  return groups
}

describe('openFreshInputWithTarget', () => {
  it('leaves the default target to the caller', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new PlainEditor()

    const result = await openFreshInputWithTarget(makeServices(groups, aux), input, 'default')

    expect(result.handled).toBe(false)
    expect(groups.groups).toHaveLength(1)
    expect(aux.calls).toHaveLength(0)
  })

  it('opens into a newly created side group', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new PlainEditor()

    const result = await openFreshInputWithTarget(makeServices(groups, aux), input, 'side')

    expect(result.handled).toBe(true)
    expect(groups.groups).toHaveLength(2)
    const side = groups.groups[1]!
    expect(groups.activeGroup).toBe(side)
    expect(side.contains(input)).toBe(true)
    expect(result.group).toBe(side)
    expect(result.editor).toBe(input)
    expect(aux.calls).toHaveLength(0)
  })

  it('opens into a new window with mode open', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new PlainEditor()

    const result = await openFreshInputWithTarget(makeServices(groups, aux), input, 'newWindow', {
      pinned: true,
    })

    expect(result.handled).toBe(true)
    expect(aux.calls).toHaveLength(1)
    expect(aux.calls[0]!.options).toMatchObject({ mode: 'open', pinned: true })
  })

  it('reports unhandled when the new window fails', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    aux.failModes.add('open')
    const input = new PlainEditor()

    const result = await openFreshInputWithTarget(makeServices(groups, aux), input, 'newWindow')

    expect(result.handled).toBe(false)
  })
})

describe('openExistingInputWithTarget', () => {
  it('focuses the input when the side group already contains it', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new CloneableEditor('a')
    const source = groups.activeGroup
    source.openEditor(input)
    const side = sideGroupOf(groups, source)
    side.openEditor(input)

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      source,
      'side',
    )

    expect(result.handled).toBe(true)
    expect(result.editor).toBe(input)
    expect(result.group).toBe(side)
    expect(groups.activeGroup).toBe(side)
  })

  it('clones a cloneable input instead of sharing the instance', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    disposables.push(registration)
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new CloneableEditor('a')
    const source = groups.activeGroup
    source.openEditor(input)

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      source,
      'side',
    )

    expect(result.handled).toBe(true)
    expect(result.editor).not.toBe(input)
    expect(result.editor?.matches(input)).toBe(true)
    expect(source.contains(input)).toBe(true)
    expect(result.group?.contains(result.editor!)).toBe(true)
  })

  it('moves an input that cannot be cloned', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new PlainEditor()
    const source = groups.activeGroup
    source.openEditor(input)

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      source,
      'side',
    )

    expect(result.handled).toBe(true)
    expect(result.editor).toBe(input)
    expect(source.contains(input)).toBe(false)
    expect(result.group?.contains(input)).toBe(true)
  })

  it('moves singleton inputs even when they are cloneable', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    disposables.push(registration)
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new CloneableEditor('a')
    const source = groups.activeGroup
    source.openEditor(input)

    await openExistingInputWithTarget(makeServices(groups, aux), input, source, 'side', {
      singleton: true,
    })

    expect(source.contains(input)).toBe(false)
    expect(groups.activeGroup.contains(input)).toBe(true)
  })

  it('uses createFresh for an uncloneable input instead of moving it', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new PlainEditor(URI.file('X:/original.txt'))
    const fresh = new PlainEditor(URI.file('X:/fresh.txt'))
    const source = groups.activeGroup
    source.openEditor(input)

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      source,
      'side',
      { createFresh: () => fresh },
    )

    expect(result.handled).toBe(true)
    expect(result.editor).toBe(fresh)
    expect(source.contains(input)).toBe(true)
    expect(result.group?.contains(fresh)).toBe(true)
  })

  it('copies a cloneable input into a new window', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    disposables.push(registration)
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new CloneableEditor('a')
    const source = groups.activeGroup
    source.openEditor(input)

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      source,
      'newWindow',
    )

    expect(result.handled).toBe(true)
    expect(aux.calls).toHaveLength(1)
    expect(aux.calls[0]!.options).toMatchObject({ mode: 'copy', source })
  })

  it('moves an uncloneable input into a new window', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new PlainEditor()
    const source = groups.activeGroup
    source.openEditor(input)

    await openExistingInputWithTarget(makeServices(groups, aux), input, source, 'newWindow')

    expect(aux.calls).toHaveLength(1)
    expect(aux.calls[0]!.options).toMatchObject({ mode: 'move', source })
  })

  it('falls back to move when copy fails', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    disposables.push(registration)
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    aux.failModes.add('copy')
    const input = new CloneableEditor('a')
    const source = groups.activeGroup
    source.openEditor(input)

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      source,
      'newWindow',
    )

    expect(result.handled).toBe(true)
    expect(aux.calls.map((call) => call.options?.mode)).toEqual(['copy', 'move'])
  })

  it('reports unhandled when both copy and move fail', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    disposables.push(registration)
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    aux.failModes.add('copy')
    aux.failModes.add('move')
    const input = new CloneableEditor('a')
    const source = groups.activeGroup
    source.openEditor(input)

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      source,
      'newWindow',
    )

    expect(result.handled).toBe(false)
    expect(source.contains(input)).toBe(true)
  })

  it('opens fresh when the input is not mounted anywhere', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const input = new PlainEditor()

    const result = await openExistingInputWithTarget(
      makeServices(groups, aux),
      input,
      undefined,
      'side',
    )

    expect(result.handled).toBe(true)
    expect(groups.groups).toHaveLength(2)
    expect(groups.activeGroup.contains(input)).toBe(true)
  })

  it('splits from the active part, not from a source group in another window', async () => {
    const partA = { id: 'aux' } as never
    const partB = { id: 'main' } as never
    const input = new PlainEditor()
    const makeGroup = (part: unknown, initial: EditorInput[] = []): IEditorGroup => {
      const editors = [...initial]
      return {
        part,
        isLocked: false,
        editors,
        contains: (editor: EditorInput) => editors.includes(editor),
        setActive: vi.fn(),
      } as unknown as IEditorGroup
    }
    const sourceGroup = makeGroup(partA, [input])
    const activeGroup = makeGroup(partB)
    const allGroups = [sourceGroup, activeGroup]
    let active = activeGroup
    const fakeGroups = {
      groups: allGroups,
      get activeGroup() {
        return active
      },
      get activeGroupForOpen() {
        return active
      },
      findGroup: () => undefined,
      addGroup: (source: IEditorGroup) => {
        const created = makeGroup(source.part)
        allGroups.push(created)
        return created
      },
      activateGroup: (group: IEditorGroup) => {
        active = group
      },
      moveEditor: (editor: EditorInput, dest: IEditorGroup, src: IEditorGroup) => {
        const srcEditors = src.editors as unknown as EditorInput[]
        const destEditors = dest.editors as unknown as EditorInput[]
        const index = srcEditors.indexOf(editor)
        if (index >= 0) srcEditors.splice(index, 1)
        destEditors.push(editor)
      },
    } as unknown as EditorGroupsService
    const aux = new FakeAuxiliaryEditorWindowService(fakeGroups)

    const result = await openExistingInputWithTarget(
      makeServices(fakeGroups, aux),
      input,
      sourceGroup,
      'side',
    )

    expect(result.handled).toBe(true)
    expect(result.group?.part).toBe(partB)
    expect(sourceGroup.contains(input)).toBe(false)
    expect(active.contains(input)).toBe(true)
  })
})

describe('openUriWithTarget', () => {
  const makeResolver = () => {
    const created: URI[] = []
    return {
      created,
      createEditorInput(uri: URI): EditorInput {
        created.push(uri)
        return new PlainEditor(uri)
      },
    }
  }

  it('opens a fresh resolver input to the side', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const resolver = makeResolver()
    const uri = URI.file('X:/src/a.ts')

    const result = await openUriWithTarget(makeServices(groups, aux, resolver), uri, 'side')

    expect(result.handled).toBe(true)
    expect(resolver.created).toEqual([uri])
    expect(result.group?.contains(result.editor!)).toBe(true)
    expect(result.group).toBe(groups.activeGroup)
    expect(aux.calls).toHaveLength(0)
  })

  it('copies an already-open resource into a new window', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    disposables.push(registration)
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const resolver = makeResolver()
    const open = new CloneableEditor('a')
    groups.activeGroup.openEditor(open)

    await openUriWithTarget(makeServices(groups, aux, resolver), URI.file('X:/a.txt'), 'newWindow')

    expect(resolver.created).toHaveLength(0)
    expect(aux.calls[0]!.options).toMatchObject({ mode: 'copy' })
  })

  it('opens a fresh resolver input in a new window', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const resolver = makeResolver()
    const uri = URI.file('X:/src/a.ts')

    const result = await openUriWithTarget(makeServices(groups, aux, resolver), uri, 'newWindow')

    expect(result.handled).toBe(true)
    expect(resolver.created).toEqual([uri])
    expect(aux.calls[0]!.options).toMatchObject({ mode: 'open' })
  })

  it('disposes the fresh input when the new window fails', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    aux.failModes.add('open')
    const uri = URI.file('X:/src/a.ts')
    const created: TrackedEditor[] = []
    const resolver = {
      created: [] as URI[],
      createEditorInput(u: URI): EditorInput {
        this.created.push(u)
        const input = new TrackedEditor(u)
        created.push(input)
        return input
      },
    }

    const result = await openUriWithTarget(makeServices(groups, aux, resolver), uri, 'newWindow')

    expect(result.handled).toBe(false)
    expect(created[0]!.disposeCount).toBe(1)
  })

  it('reports unhandled without a resolver', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)

    const result = await openUriWithTarget(
      makeServices(groups, aux),
      URI.file('X:/src/a.ts'),
      'side',
    )

    expect(result.handled).toBe(false)
    expect(groups.groups).toHaveLength(1)
  })

  it('builds the input through createInput instead of the resolver', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const resolver = makeResolver()
    const uri = URI.file('X:/logs/main.log')
    const custom = new PlainEditor(uri)

    const result = await openUriWithTarget(makeServices(groups, aux, resolver), uri, 'side', {
      createInput: () => custom,
    })

    expect(result.handled).toBe(true)
    expect(result.editor).toBe(custom)
    expect(resolver.created).toHaveLength(0)
  })

  it('ignores the default target', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const resolver = makeResolver()

    const result = await openUriWithTarget(
      makeServices(groups, aux, resolver),
      URI.file('X:/src/a.ts'),
      'default',
    )

    expect(result.handled).toBe(false)
    expect(resolver.created).toHaveLength(0)
  })
})

describe('openSingletonWithTarget', () => {
  it('moves an already-open preview into a new window instead of copying it', async () => {
    const registration = EditorRegistry.registerEditorProvider({
      typeId: CloneableEditor.TYPE_ID,
      componentKey: 'file',
      deserialize: (data) => CloneableEditor.deserialize(data),
    })
    disposables.push(registration)
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const preview = new CloneableEditor('doc', 'preview:doc')
    groups.activeGroup.openEditor(preview)
    const createInput = vi.fn(() => new CloneableEditor('doc', 'preview:doc'))

    const result = await openSingletonWithTarget(
      makeServices(groups, aux),
      'newWindow',
      'preview:doc',
      createInput,
    )

    expect(result.handled).toBe(true)
    expect(createInput).not.toHaveBeenCalled()
    expect(aux.calls[0]!.options).toMatchObject({ mode: 'move' })
  })

  it('creates a fresh preview when none is open', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    const preview = new CloneableEditor('doc', 'preview:doc')
    const createInput = vi.fn(() => preview)

    const result = await openSingletonWithTarget(
      makeServices(groups, aux),
      'side',
      'preview:doc',
      createInput,
    )

    expect(result.handled).toBe(true)
    expect(createInput).toHaveBeenCalledOnce()
    expect(groups.activeGroup.contains(preview)).toBe(true)
  })

  it('disposes the fresh preview when the new window fails', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    aux.failModes.add('open')
    const preview = new TrackedEditor(URI.file('X:/preview.md'))

    const result = await openSingletonWithTarget(
      makeServices(groups, aux),
      'newWindow',
      'preview:doc',
      () => preview,
    )

    expect(result.handled).toBe(false)
    expect(preview.disposeCount).toBe(1)
  })
})

describe('openSingletonEditor', () => {
  it('runs the default path for a plain click without building an input', async () => {
    const groups = makeGroups()
    const create = vi.fn(() => new TrackedEditor())
    const openDefault = vi.fn()

    const targeted = await openSingletonEditor(
      makeServices(groups, new FakeAuxiliaryEditorWindowService(groups)),
      'default',
      create,
      openDefault,
    )

    expect(targeted).toBe(false)
    expect(openDefault).toHaveBeenCalledOnce()
    expect(create).not.toHaveBeenCalled()
  })

  it('opens a fresh instance to the side when none is open', async () => {
    const groups = makeGroups()
    const source = groups.activeGroup
    const openDefault = vi.fn()

    const targeted = await openSingletonEditor(
      makeServices(groups, new FakeAuxiliaryEditorWindowService(groups)),
      'side',
      () => new TrackedEditor(URI.file('X:/graph')),
      openDefault,
    )

    expect(targeted).toBe(true)
    expect(openDefault).not.toHaveBeenCalled()
    expect(groups.groups).toHaveLength(2)
    expect(groups.activeGroup).not.toBe(source)
    expect(groups.activeGroup.editors.map((e) => e.resource?.path)).toEqual(['/X:/graph'])
  })

  it('moves the open instance to the side and disposes the unused probe', async () => {
    const groups = makeGroups()
    const source = groups.activeGroup
    const open = new TrackedEditor(URI.file('X:/graph'))
    source.openEditor(open)
    const probe = new TrackedEditor(URI.file('X:/graph'))

    const targeted = await openSingletonEditor(
      makeServices(groups, new FakeAuxiliaryEditorWindowService(groups)),
      'side',
      () => probe,
      vi.fn(),
    )

    expect(targeted).toBe(true)
    expect(source.contains(open)).toBe(false)
    expect(groups.activeGroup.contains(open)).toBe(true)
    expect(open.disposeCount).toBe(0)
    expect(probe.disposeCount).toBe(1)
  })

  it('falls back to the default path when the new window fails', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    aux.failModes.add('open')
    const probe = new TrackedEditor(URI.file('X:/graph'))
    const openDefault = vi.fn()

    const targeted = await openSingletonEditor(
      makeServices(groups, aux),
      'newWindow',
      () => probe,
      openDefault,
    )

    expect(targeted).toBe(false)
    expect(openDefault).toHaveBeenCalledOnce()
    expect(probe.disposeCount).toBe(1)
  })
})

describe('openUriEditor', () => {
  it('runs only the default path for a plain invocation', async () => {
    const groups = makeGroups()
    const createInput = vi.fn(() => new PlainEditor())
    const openDefault = vi.fn()

    const targeted = await openUriEditor(
      makeServices(groups, new FakeAuxiliaryEditorWindowService(groups)),
      'default',
      URI.file('X:/settings.json'),
      openDefault,
      { createInput },
    )

    expect(targeted).toBe(false)
    expect(openDefault).toHaveBeenCalledOnce()
    expect(createInput).not.toHaveBeenCalled()
  })

  it('opens a fresh copy to the side and skips the default path', async () => {
    const groups = makeGroups()
    const source = groups.activeGroup
    const uri = URI.file('X:/settings.json')
    source.openEditor(new PlainEditor(uri))
    const openDefault = vi.fn()

    const targeted = await openUriEditor(
      makeServices(groups, new FakeAuxiliaryEditorWindowService(groups)),
      'side',
      uri,
      openDefault,
      { createInput: () => new PlainEditor(uri) },
    )

    expect(targeted).toBe(true)
    expect(openDefault).not.toHaveBeenCalled()
    expect(groups.groups).toHaveLength(2)
    // A file is copied: the original tab stays where it was.
    expect(source.editors).toHaveLength(1)
    expect(groups.activeGroup).not.toBe(source)
  })

  it('falls back to the default path when the new window fails', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    aux.failModes.add('open')
    const input = new TrackedEditor(URI.file('X:/settings.json'))
    const openDefault = vi.fn()

    const targeted = await openUriEditor(
      makeServices(groups, aux),
      'newWindow',
      URI.file('X:/settings.json'),
      openDefault,
      { createInput: () => input },
    )

    expect(targeted).toBe(false)
    expect(openDefault).toHaveBeenCalledOnce()
    expect(input.disposeCount).toBe(1)
  })
})

describe('openPinnedSingletonEditor', () => {
  it('opens pinned in the active group by default', async () => {
    const groups = makeGroups()
    const page = new TrackedEditor(URI.file('X:/perf'))

    await openPinnedSingletonEditor(
      makeServices(groups, new FakeAuxiliaryEditorWindowService(groups)),
      'default',
      () => page,
    )

    expect(groups.groups).toHaveLength(1)
    expect(groups.activeGroup.activeEditor).toBe(page)
    expect(groups.activeGroup.isPinned(page)).toBe(true)
  })

  it('moves the open page into a new window', async () => {
    const groups = makeGroups()
    const aux = new FakeAuxiliaryEditorWindowService(groups)
    groups.activeGroup.openEditor(new TrackedEditor(URI.file('X:/perf')))

    const targeted = await openPinnedSingletonEditor(
      makeServices(groups, aux),
      'newWindow',
      () => new TrackedEditor(URI.file('X:/perf')),
    )

    expect(targeted).toBe(true)
    expect(aux.calls[0]!.options).toMatchObject({ mode: 'move' })
  })
})
