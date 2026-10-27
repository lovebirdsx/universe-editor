import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IEditorGroupsService,
  IEditorResolverService,
  IQuickInputService,
  IUriIdentityService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  runWithInvocationModifiers,
  type IEditorResolverService as IEditorResolverServiceType,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../../services/editor/EditorGroupsService.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { ReopenWithAction } from '../editorResolverActions.js'

const openWithTargetMocks = vi.hoisted(() => ({
  openFreshInputWithTarget: vi.fn(
    async (_services: unknown, _input: unknown, _target: unknown, _options: unknown) => ({
      handled: true,
    }),
  ),
  openTargetServicesFrom: vi.fn(() => ({ marker: 'services' })),
}))
vi.mock('../../services/editor/openWithTarget.js', () => openWithTargetMocks)

const URI_FILE = URI.file('/repo/file.ts')

function setup(): {
  groups: EditorGroupsService
  existing: FileEditorInput
  created: FileEditorInput[]
  openEditor: ReturnType<typeof vi.fn>
  run: (mods?: { ctrlKey?: boolean; altKey?: boolean }) => Promise<void>
} {
  const groups = new EditorGroupsService()
  const existing = new FileEditorInput(URI_FILE, {} as never)
  groups.activeGroup.openEditor(existing)

  const created: FileEditorInput[] = []
  const openEditor = vi.fn(async () => undefined)
  const resolver: IEditorResolverServiceType = {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose() {} }),
    resolveEditors: () =>
      [
        {
          glob: '**/*',
          info: { typeId: 'custom', displayName: 'Custom', priority: 100 },
          factory: () => new FileEditorInput(URI.file('/repo/custom.ts'), {} as never),
        },
      ] as never,
    createEditorInput: () => {
      const input = new FileEditorInput(URI.file('/repo/custom.ts'), {} as never)
      created.push(input)
      return input
    },
    openEditor,
  }
  const services = new ServiceCollection(
    [IEditorGroupsService, groups],
    [IEditorResolverService, resolver],
    [IQuickInputService, { pick: async (items: { id: string }[]) => items[0] } as never],
    [IUriIdentityService, new UriIdentityService('linux')],
  )
  const inst = new InstantiationService(services)

  return {
    groups,
    existing,
    created,
    openEditor,
    run: async (mods) => {
      const invoke = (): Promise<void> =>
        inst.invokeFunction((accessor) =>
          new ReopenWithAction().run(accessor, { resource: URI_FILE.toJSON() }),
        )
      await (mods ? runWithInvocationModifiers(mods, invoke) : invoke())
    },
  }
}

beforeEach(() => {
  openWithTargetMocks.openFreshInputWithTarget.mockClear()
  openWithTargetMocks.openFreshInputWithTarget.mockResolvedValue({ handled: true })
  openWithTargetMocks.openTargetServicesFrom.mockClear()
})

describe('ReopenWithAction', () => {
  it('reopens in the same group, not the open target', async () => {
    const { groups, existing, created, openEditor, run } = setup()

    await run()

    expect(groups.activeGroup.contains(existing)).toBe(false)
    expect(groups.activeGroup.activeEditor).toBe(created[0])
    expect(openEditor).not.toHaveBeenCalled()
    expect(openWithTargetMocks.openFreshInputWithTarget).not.toHaveBeenCalled()
  })

  it('opens the picked type to the side under Ctrl', async () => {
    const { groups, existing, created, openEditor, run } = setup()

    await run({ ctrlKey: true })

    expect(groups.activeGroup.contains(existing)).toBe(false)
    expect(openEditor).not.toHaveBeenCalled()
    expect(created).toHaveLength(1)
    expect(openWithTargetMocks.openTargetServicesFrom).toHaveBeenCalledOnce()
    expect(openWithTargetMocks.openFreshInputWithTarget).toHaveBeenCalledOnce()
    const [services, opened, target, options] =
      openWithTargetMocks.openFreshInputWithTarget.mock.calls[0]!
    expect(services).toEqual({ marker: 'services' })
    expect(opened).toBe(created[0])
    expect(target).toBe('side')
    // The split must originate from the tab's own group, not the active one.
    expect(options).toEqual({ pinned: true, sourceGroup: groups.activeGroup })
  })

  it('disposes the fresh input and reopens in the group when the target fails', async () => {
    openWithTargetMocks.openFreshInputWithTarget.mockResolvedValueOnce({ handled: false })
    const { groups, created, run } = setup()

    await run({ altKey: true })

    expect(created[0]!.isDisposed).toBe(true)
    expect(groups.activeGroup.activeEditor).toBe(created[1])
  })
})
