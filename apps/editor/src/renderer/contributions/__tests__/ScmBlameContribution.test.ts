/*---------------------------------------------------------------------------------------------
 *  Tests for ScmBlameContribution — focuses on the case where the workspace has
 *  no SCM provider, so nothing registers a `<providerId>.getBlame` command.
 *  Moving the caret / switching editors must not spam "command not found"
 *  warnings; once a provider registers its blame command the status bar fills.
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
  ILoggerService,
  IStatusBarService,
  IStorageService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
  type ILogger,
  type IObservable,
} from '@universe-editor/platform'
import { blameCommandId, type BlameResultDto } from '@universe-editor/extensions-common'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { CommandService } from '../../services/command/CommandService.js'
import { ILanguageFeaturesService } from '../../services/languageFeatures/LanguageFeaturesService.js'
import { IScmService } from '../../services/extensions/ScmService.js'
import { scmViewState } from '../../workbench/scm/scmViewState.js'
import { ScmBlameContribution } from '../ScmBlameContribution.js'
import { ScmSelectedRepoContribution } from '../ScmSelectedRepoContribution.js'

const GET_BLAME = blameCommandId('git')

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
  const model = {
    getLineMaxColumn: () => 5,
    onDidChangeContent: () => ({ dispose() {} }),
  }
  return {
    cursor,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    onDidChangeCursorPosition: (cb: () => void) => cursor.event(cb),
    getModel: () => model,
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

function setup(
  sourceControls:
    | readonly { id: string; rootUri: string }[]
    | IObservable<readonly { id: string; rootUri: string }[]> = [{ id: 'git', rootUri: '/ws' }],
) {
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
  interface CapturedHoverProvider {
    provideHover: (
      model: unknown,
      position: { lineNumber: number; column: number },
    ) =>
      | Promise<{ contents: { value: string; isTrusted?: boolean }[] } | null>
      | { contents: { value: string; isTrusted?: boolean }[] }
      | null
  }
  let hoverProvider: CapturedHoverProvider | undefined
  const languageFeatures = {
    _serviceBrand: undefined,
    registerHoverProvider: (_lang: string, provider: CapturedHoverProvider) => {
      hoverProvider = provider
      return { dispose() {} }
    },
  } as unknown as ILanguageFeaturesService

  services.set(IFileService, makeFileService())
  services.set(ICommandService, new CommandService(inst, undefined, logger))
  services.set(IEditorService, editorService)
  services.set(IStatusBarService, new StatusBarService())
  services.set(IConfigurationService, new ConfigurationService())
  services.set(ILanguageFeaturesService, languageFeatures)
  services.set(ILoggerService, {
    _serviceBrand: undefined,
    createLogger: () => logger,
  } as never)
  const scObservable = Array.isArray(sourceControls)
    ? observableValue<readonly { id: string; rootUri: string }[]>('scm.sourceControls', [
        ...sourceControls,
      ])
    : sourceControls
  services.set(IScmService, {
    _serviceBrand: undefined,
    sourceControls: scObservable,
  } as never)
  const store = new Map<string, unknown>()
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => {
      store.set(key, value)
    },
  } as never)

  const statusBar = services.get(IStatusBarService) as StatusBarService
  const contrib = inst.createInstance(ScmBlameContribution)
  return { inst, logger, active, statusBar, contrib, store, getHoverProvider: () => hoverProvider }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('ScmBlameContribution', () => {
  beforeEach(() => FileEditorRegistry._resetForTests())
  afterEach(() => {
    FileEditorRegistry._resetForTests()
    scmViewState.setSelectedRepo(undefined)
  })

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

    expect(logger.warn).not.toHaveBeenCalledWith(`command not found id=${GET_BLAME}`)
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
    const reg = CommandsRegistry.registerCommand(GET_BLAME, () => result)
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

  const blameResult = (author: string): BlameResultDto => ({
    commits: [
      {
        hash: 'b'.repeat(40),
        authorName: author,
        authorEmail: `${author}@example.com`,
        authorDate: Date.now(),
        summary: 'change',
        ranges: [{ startLine: 1, endLine: 1 }],
      },
    ],
    uncommittedLines: [],
  })

  function openFile(inst: InstantiationService, path = '/ws/git/a.txt') {
    const input = inst.createInstance(FileEditorInput, URI.file(path))
    const editor = makeFakeEditor()
    FileEditorRegistry.register(
      input,
      editor as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    return { input, editor }
  }

  it('switches the status-bar blame when the SCM view selection changes provider', async () => {
    const { inst, statusBar, active } = setup([
      { id: 'perforce', rootUri: '/ws' },
      { id: 'git', rootUri: '/ws/git' },
    ])
    const regs = [
      CommandsRegistry.registerCommand(blameCommandId('git'), () => blameResult('Gitty')),
      CommandsRegistry.registerCommand(blameCommandId('perforce'), () => blameResult('P4aula')),
    ]
    try {
      const { input } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks()

      const blameText = () =>
        statusBar.entries
          .get()
          .map((e) => e.entry.text)
          .join(' ')
      // Longest prefix owns the file by default → git blame.
      expect(blameText()).toContain('Gitty')

      scmViewState.setSelectedRepo('/ws')
      await flushMicrotasks()
      expect(blameText()).toContain('P4aula')

      scmViewState.setSelectedRepo('/ws/git')
      await flushMicrotasks()
      expect(blameText()).toContain('Gitty')
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })

  it('re-arbitrates to the restored selection when its provider registers its source control later', async () => {
    // Startup race: the workspace restore sets selectedRepo to the p4 root, but
    // only git's source control exists so far — the selection matches no owner,
    // so the longest-prefix fallback shows git blame. The perforce extension
    // finishes activating afterwards and registers its source control.
    const sourceControls = observableValue<readonly { id: string; rootUri: string }[]>(
      'scm.sourceControls',
      [{ id: 'git', rootUri: '/ws/git' }],
    )
    const { inst, statusBar, active } = setup(sourceControls)
    const regs = [
      CommandsRegistry.registerCommand(blameCommandId('git'), () => blameResult('Gitty')),
      CommandsRegistry.registerCommand(blameCommandId('perforce'), () => blameResult('P4aula')),
    ]
    try {
      scmViewState.setSelectedRepo('/ws')
      const { input } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks()

      const blameText = () =>
        statusBar.entries
          .get()
          .map((e) => e.entry.text)
          .join(' ')
      expect(blameText()).toContain('Gitty')

      sourceControls.set(
        [
          { id: 'git', rootUri: '/ws/git' },
          { id: 'perforce', rootUri: '/ws' },
        ],
        undefined,
      )
      await flushMicrotasks()
      expect(blameText()).toContain('P4aula')
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })

  it('adopts the persisted repo selection without the SCM view ever mounting', async () => {
    // The workspace closed with p4 selected and the SCM panel hidden: on reopen
    // the view never mounts, so the workbench-level contribution restores the
    // selection and blame re-arbitrates on its own (previously this stayed on
    // the longest-prefix fallback → git blame until the panel got focus).
    const { inst, statusBar, active, store } = setup([
      { id: 'git', rootUri: '/ws/git' },
      { id: 'perforce', rootUri: '/ws' },
    ])
    store.set('scm.selectedRepo', '/ws')
    const regs = [
      CommandsRegistry.registerCommand(blameCommandId('git'), () => blameResult('Gitty')),
      CommandsRegistry.registerCommand(blameCommandId('perforce'), () => blameResult('P4aula')),
    ]
    try {
      inst.createInstance(ScmSelectedRepoContribution)
      const { input } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks()

      const blameText = () =>
        statusBar.entries
          .get()
          .map((e) => e.entry.text)
          .join(' ')
      expect(blameText()).toContain('P4aula')
      expect(blameText()).not.toContain('Gitty')
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })

  it('a slow superseded provider fetch never overwrites the newer provider blame', async () => {
    const { inst, statusBar, active } = setup([
      { id: 'git', rootUri: '/ws/git' },
      { id: 'perforce', rootUri: '/ws' },
    ])
    let resolveGit!: (r: BlameResultDto) => void
    let resolveP4!: (r: BlameResultDto) => void
    const regs = [
      CommandsRegistry.registerCommand(
        blameCommandId('git'),
        () =>
          new Promise<BlameResultDto>((res) => {
            resolveGit = res
          }),
      ),
      CommandsRegistry.registerCommand(
        blameCommandId('perforce'),
        () =>
          new Promise<BlameResultDto>((res) => {
            resolveP4 = res
          }),
      ),
    ]
    try {
      const { input } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks() // refresh #1: git (longest prefix), in-flight

      scmViewState.setSelectedRepo('/ws') // refresh #2: perforce, in-flight
      await flushMicrotasks()

      const blameText = () =>
        statusBar.entries
          .get()
          .map((e) => e.entry.text)
          .join(' ')
      resolveP4(blameResult('P4aula'))
      await flushMicrotasks()
      expect(blameText()).toContain('P4aula')

      // The stale git fetch lands afterwards — it must not clobber the p4 entry.
      resolveGit(blameResult('Gitty'))
      await flushMicrotasks()
      expect(blameText()).toContain('P4aula')
      expect(blameText()).not.toContain('Gitty')
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })

  it('wires the status-bar click-through only when the provider has a graph view', async () => {
    const { inst, statusBar, active } = setup()
    const regs = [
      CommandsRegistry.registerCommand(GET_BLAME, () => blameResult('Ada')),
      CommandsRegistry.registerCommand('git-graph.view', () => undefined),
    ]
    try {
      const { input } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks()

      const withGraph = statusBar.entries.get().find((e) => e.entry.text.includes('Ada'))
      expect(withGraph?.entry.command).toBe('scm.blame.openCommit')
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })

  it('renders blame without a click-through when the provider has no graph view', async () => {
    const { inst, statusBar, active } = setup()
    const reg = CommandsRegistry.registerCommand(GET_BLAME, () => blameResult('Ada'))
    try {
      const { input } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks()

      const entry = statusBar.entries.get().find((e) => e.entry.text.includes('Ada'))
      expect(entry).toBeDefined()
      expect(entry?.entry.command).toBeUndefined()
    } finally {
      reg.dispose()
    }
  })

  it('status-bar click opens the git graph reveal bridge at the current commit', async () => {
    const { inst, active } = setup()
    const bridge = vi.fn()
    const regs = [
      CommandsRegistry.registerCommand(GET_BLAME, () => blameResult('Ada')),
      CommandsRegistry.registerCommand('git-graph.view', () => undefined),
      CommandsRegistry.registerCommand('_workbench.openGitGraph', bridge),
    ]
    try {
      const { input } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks()

      // Status-bar entries carry no arguments — the handler must fall back to
      // the current line's hash/provider.
      await CommandsRegistry.getCommand('scm.blame.openCommit')!.handler({} as never)

      expect(bridge).toHaveBeenCalledWith(expect.anything(), 'b'.repeat(40))
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })

  it('scm.blame.openCommit routes an explicit hash+provider to the matching bridge', async () => {
    setup([
      { id: 'git', rootUri: '/ws/git' },
      { id: 'perforce', rootUri: '/ws' },
    ])
    const gitBridge = vi.fn()
    const p4Bridge = vi.fn()
    const otherView = vi.fn()
    const regs = [
      CommandsRegistry.registerCommand('_workbench.openGitGraph', gitBridge),
      CommandsRegistry.registerCommand('_workbench.openPerforceGraph', p4Bridge),
      CommandsRegistry.registerCommand('hg-graph.view', otherView),
    ]
    try {
      const handler = CommandsRegistry.getCommand('scm.blame.openCommit')!.handler

      await handler({} as never, 'abc123', 'git')
      expect(gitBridge).toHaveBeenCalledWith(expect.anything(), 'abc123')

      await handler({} as never, '4521', 'perforce')
      expect(p4Bridge).toHaveBeenCalledWith(expect.anything(), '4521')

      // A third-party provider without a reveal bridge keeps the
      // `<providerId>-graph.view` convention (no reveal argument).
      await handler({} as never, 'cafe99', 'hg')
      expect(otherView).toHaveBeenCalledWith(expect.anything(), 'cafe99')
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })

  it('serves a hover whose commit hash is a trusted command link to the graph', async () => {
    const { inst, active, getHoverProvider } = setup()
    const regs = [
      CommandsRegistry.registerCommand(GET_BLAME, () => blameResult('Ada')),
      CommandsRegistry.registerCommand('git-graph.view', () => undefined),
    ]
    try {
      const { input, editor } = openFile(inst)
      active.set(input, undefined)
      await flushMicrotasks()
      await flushMicrotasks()

      const provider = getHoverProvider()
      expect(provider).toBeDefined()
      // The hover is gated on the active editor's own model — reuse the fake's.
      const hover = await provider!.provideHover(editor.getModel(), { lineNumber: 1, column: 5 })
      const value = hover?.contents[0]?.value ?? ''
      const expectedArgs = encodeURIComponent(JSON.stringify(['b'.repeat(40), 'git']))
      expect(value).toContain(`command:scm.blame.openCommit?${expectedArgs}`)
      expect(hover?.contents[0]?.isTrusted).toBe(true)
    } finally {
      regs.forEach((r) => r.dispose())
    }
  })
})
