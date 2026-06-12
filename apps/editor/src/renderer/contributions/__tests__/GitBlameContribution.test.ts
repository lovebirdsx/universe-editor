/*---------------------------------------------------------------------------------------------
 *  Tests for GitBlameContribution — focuses on the case where the workspace is not
 *  a git repository, so the git extension never activates and never registers its
 *  internal `git.getBlame` command. Moving the caret / switching editors must not
 *  spam "command not found id=git.getBlame" warnings.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ConfigurationService,
  Emitter,
  Event,
  ICommandService,
  IConfigurationService,
  IEditorService,
  IFileService,
  IStatusBarService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
  type ILogger,
} from '@universe-editor/platform'
import { BlameCommands, type BlameResultDto } from '@universe-editor/extensions-common'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { CommandService } from '../../services/command/CommandService.js'
import { ILanguageFeaturesService } from '../../services/languageFeatures/LanguageFeaturesService.js'
import { GitBlameContribution } from '../GitBlameContribution.js'

vi.mock('../../workbench/editor/monaco/MonacoLoader.js', () => {
  const Range = class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number,
    ) {}
  }
  const m = { Range }
  return {
    MonacoLoader: {
      get: () => m,
      ensureInitialized: () => Promise.resolve(m),
    },
  }
})

function makeLogger(): ILogger {
  return {
    level: LogLevel.Info,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
}

function makeFakeEditor() {
  const cursor = new Emitter<unknown>()
  const node = document.createElement('div')
  return {
    cursor,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    onDidChangeCursorPosition: (cb: () => void) => cursor.event(cb),
    getModel: () => null,
    createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
    getContainerDomNode: () => node,
  }
}

function makeFileService(): IFileService {
  return {
    _serviceBrand: undefined,
    async readFile() {
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
  } as unknown as IFileService
}

function setup() {
  FileEditorRegistry._resetForTests()
  const services = new ServiceCollection()
  const inst = new InstantiationService(services)
  const logger = makeLogger()

  const active = observableValue<IEditorInput | undefined>('active', undefined)
  const editorService = {
    _serviceBrand: undefined,
    openEditor() {},
    closeEditor() {},
    closeAllEditors() {},
    openEditors: observableValue<readonly IEditorInput[]>('open', []),
    activeEditorId: observableValue<string | undefined>('id', undefined),
    activeEditor: active,
  } as unknown as IEditorService
  const languageFeatures = {
    _serviceBrand: undefined,
    registerHoverProvider: () => ({ dispose() {} }),
  } as unknown as ILanguageFeaturesService

  services.set(IFileService, makeFileService())
  services.set(ICommandService, new CommandService(inst, undefined, logger))
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, new StatusBarService())
  services.set(IConfigurationService, new ConfigurationService())
  services.set(ILanguageFeaturesService, languageFeatures)

  const statusBar = services.get(IStatusBarService) as StatusBarService
  const contrib = inst.createInstance(GitBlameContribution)
  return { inst, logger, active, statusBar, contrib }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('GitBlameContribution', () => {
  beforeEach(() => FileEditorRegistry._resetForTests())
  afterEach(() => FileEditorRegistry._resetForTests())

  it('does not warn "command not found" when git.getBlame is unregistered', async () => {
    const { inst, logger, active } = setup()
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.txt'))
    const editor = makeFakeEditor()
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )

    active.set(input, undefined)
    await flushMicrotasks()

    expect(logger.warn).not.toHaveBeenCalledWith(`command not found id=${BlameCommands.getBlame}`)
  })

  it('renders blame in the status bar once git.getBlame is registered', async () => {
    const { inst, statusBar, active } = setup()
    const result: BlameResultDto = {
      commits: [
        {
          hash: 'a'.repeat(40),
          authorName: 'Ada',
          authorEmail: 'ada@example.com',
          authorDate: Date.now(),
          summary: 'init',
          ranges: [{ startLine: 1, endLine: 1 }],
        },
      ],
      uncommittedLines: [],
    }
    const reg = CommandsRegistry.registerCommand(BlameCommands.getBlame, () => result)
    try {
      const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.txt'))
      const editor = makeFakeEditor()
      FileEditorRegistry.register(
        input,
        editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
      )
      active.set(input, undefined)
      await flushMicrotasks()

      const texts = statusBar.entries.get().map((e) => e.entry.text)
      expect(texts.some((t) => t.includes('Ada'))).toBe(true)
    } finally {
      reg.dispose()
    }
  })
})
