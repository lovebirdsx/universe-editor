import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  IEditorGroupsService,
  ILoggerService,
  InstantiationService,
  JSONContributionRegistry,
  NullLogger,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import { ShowJsonSchemaAction } from '../jsonSchemaActions.js'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { SchemaViewerInput } from '../../services/editor/SchemaViewerInput.js'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length) disposables.pop()?.dispose()
  vi.restoreAllMocks()
})

function fakeFileEditorInput(path: string, language: string): FileEditorInput {
  return {
    resource: URI.file(path),
    language,
  } as unknown as FileEditorInput
}

function makeServices(activeEditor: unknown): {
  services: ServiceCollection
  openEditor: ReturnType<typeof vi.fn>
} {
  const openEditor = vi.fn()
  const groups = {
    activeGroup: { activeEditor, openEditor },
  } as unknown as IEditorGroupsService
  const loggerService = { createLogger: () => new NullLogger() } as unknown as ILoggerService
  const services = new ServiceCollection()
  services.set(IEditorGroupsService, groups)
  services.set(ILoggerService, loggerService)
  return { services, openEditor }
}

async function run(services: ServiceCollection, arg?: unknown): Promise<void> {
  const inst = new InstantiationService(services)
  await inst.invokeFunction(async (accessor) => {
    await CommandsRegistry.getCommand(ShowJsonSchemaAction.ID)!.handler(accessor, arg)
  })
}

// Make `instanceof FileEditorInput` succeed for the plain fake objects.
function asFileInput(o: object): FileEditorInput {
  Object.setPrototypeOf(o, FileEditorInput.prototype)
  return o as FileEditorInput
}

describe('ShowJsonSchemaAction', () => {
  it('opens a SchemaViewerInput for a json file that matches a schema', async () => {
    disposables.push(registerAction2(ShowJsonSchemaAction))
    disposables.push(
      JSONContributionRegistry.registerSchema({
        uri: 'test://settings',
        fileMatch: ['**/.claude/settings.json'],
        schema: { type: 'object', description: 'claude' },
      }),
    )
    const active = asFileInput(fakeFileEditorInput('C:/u/.claude/settings.json', 'json'))
    const { services, openEditor } = makeServices(active)

    await run(services)

    expect(openEditor).toHaveBeenCalledTimes(1)
    expect(openEditor.mock.calls[0]![0]).toBeInstanceOf(SchemaViewerInput)
  })

  it('does nothing for a json file with no matching schema', async () => {
    disposables.push(registerAction2(ShowJsonSchemaAction))
    const active = asFileInput(fakeFileEditorInput('C:/u/random.json', 'json'))
    const { services, openEditor } = makeServices(active)

    await run(services)

    expect(openEditor).not.toHaveBeenCalled()
  })

  it('does nothing when the active editor is not a FileEditorInput', async () => {
    disposables.push(registerAction2(ShowJsonSchemaAction))
    const { services, openEditor } = makeServices({ language: 'json' })

    await run(services)

    expect(openEditor).not.toHaveBeenCalled()
  })

  it('opens the schema in the named group instead of the active group', async () => {
    disposables.push(registerAction2(ShowJsonSchemaAction))
    disposables.push(
      JSONContributionRegistry.registerSchema({
        uri: 'test://settings',
        fileMatch: ['**/.claude/settings.json'],
        schema: { type: 'object', description: 'claude' },
      }),
    )
    const target = asFileInput(fakeFileEditorInput('C:/u/.claude/settings.json', 'json'))
    const active = asFileInput(fakeFileEditorInput('D:/repo/.claude/settings.json', 'json'))
    const targetOpen = vi.fn()
    const activeOpen = vi.fn()
    const g1 = {
      id: 1,
      activeEditor: target,
      editors: [target],
      isLocked: false,
      openEditor: targetOpen,
    }
    const g2 = {
      id: 2,
      activeEditor: active,
      editors: [active],
      isLocked: false,
      openEditor: activeOpen,
    }
    const groups = {
      activeGroup: g2,
      groups: [g1, g2],
      getGroup: (id: number) => (id === 1 ? g1 : id === 2 ? g2 : undefined),
      activeGroupForOpen: g2,
      activateGroup: vi.fn(),
    }

    const services = new ServiceCollection()
    services.set(IEditorGroupsService, groups as never)
    services.set(ILoggerService, {
      createLogger: () => new NullLogger(),
    } as unknown as ILoggerService)

    await run(services, { groupId: 1 })

    expect(targetOpen).toHaveBeenCalledTimes(1)
    expect(targetOpen.mock.calls[0]![0]).toBeInstanceOf(SchemaViewerInput)
    expect(activeOpen).not.toHaveBeenCalled()
  })
})
