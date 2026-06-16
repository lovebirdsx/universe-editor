/*---------------------------------------------------------------------------------------------
 *  Renderer-side E2E probe installer.
 *
 *  Installed only when `window.__UNIVERSE_E2E_ENABLED__` is true (set by preload
 *  after main forwarded the `--enable-e2e-probe` argv flag). Exposes a minimal,
 *  read-mostly API on `window.__E2E__` so Playwright specs can drive the
 *  workbench through service interfaces rather than fragile DOM selectors.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  CommandsRegistry,
  DisposableStore,
  EditorInput,
  EditorRegistry,
  IDisposable,
  KeybindingsRegistry,
  LifecyclePhase,
  StatusBarAlignment,
  URI,
  onUnexpectedError,
  type ICommandService,
  type IConfigurationService,
  type IContextKeyService,
  type IEditorGroupsService,
  type IEditorResolverService,
  type IEditorService,
  type ILayoutService,
  type ILifecycleService,
  type IOutputService,
  type IStatusBarService,
  type IWindowsService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type { IAcpSessionService } from '../services/acp/acpSessionService.js'
import type { IUpdateService } from '../../shared/ipc/updateService.js'
import type { ITerminalService } from '../../shared/ipc/terminalService.js'
import type { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import type { IOutlineService } from '../services/languageFeatures/OutlineService.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../services/editor/DiffEditorRegistry.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import {
  E2E_PROBE_ENABLED_KEY,
  E2E_PROBE_KEY,
  DISPOSABLE_LEAK_REPORT_KEY,
  type E2EDisposableLeakReport,
  type E2ELifecyclePhase,
  type E2EProbe,
  type E2EStatusBarEntry,
  type E2EUpdateState,
} from '../../shared/e2e/contract.js'
import type { IScmService } from '../services/extensions/ScmService.js'

export interface E2EProbeServices {
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly lifecycleService: ILifecycleService
  readonly editorService: IEditorService
  readonly editorGroupsService: IEditorGroupsService
  readonly editorResolverService: IEditorResolverService
  readonly statusBarService: IStatusBarService
  readonly workspaceService: IWorkspaceService
  readonly windowsService: IWindowsService
  readonly layoutService: ILayoutService
  readonly configurationService: IConfigurationService
  readonly acpSessionService: IAcpSessionService
  readonly outputService: IOutputService
  readonly updateService: IUpdateService
  readonly terminalService: ITerminalService
  readonly scmService: IScmService
  readonly languageFeaturesService: ILanguageFeaturesService
  readonly outlineService: IOutlineService
  /** Tears down React + snapshots the Disposable tracker; see E2EProbe. */
  readonly computeTeardownLeakReport: () => E2EDisposableLeakReport | null
}

const NONE_TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as import('../workbench/editor/monaco/MonacoLoader.js').monaco.CancellationToken

class DummyEditorInput extends EditorInput {
  constructor(
    private readonly _uri: URI,
    private readonly _typeId: string,
  ) {
    super()
  }
  override get typeId() {
    return this._typeId
  }
  override get resource() {
    return this._uri
  }
  override getName() {
    return `Dummy: ${this._uri.path.split('/').pop() ?? ''}`
  }
}

function phaseToName(phase: LifecyclePhase): E2ELifecyclePhase {
  switch (phase) {
    case LifecyclePhase.Starting:
      return 'Starting'
    case LifecyclePhase.Ready:
      return 'Ready'
    case LifecyclePhase.Restored:
      return 'Restored'
    case LifecyclePhase.Eventually:
      return 'Eventually'
    default:
      return 'Starting'
  }
}

export function installE2EProbeIfEnabled(services: E2EProbeServices): IDisposable {
  const ds = new DisposableStore()
  if (typeof window === 'undefined' || window[E2E_PROBE_ENABLED_KEY] !== true) return ds

  // Accumulate every terminal's output so specs can poll it. Lives for the app's
  // lifetime — acceptable for the probe (only present under UNIVERSE_E2E=1).
  const terminalBuffers = new Map<string, string>()
  const d = services.terminalService.onData(({ id, data }) => {
    terminalBuffers.set(id, (terminalBuffers.get(id) ?? '') + data)
  })
  ds.add(d)

  const probe: E2EProbe = {
    whenReady: () => services.lifecycleService.when(LifecyclePhase.Ready),
    whenRestored: () => services.lifecycleService.when(LifecyclePhase.Restored),
    getLifecyclePhase: () => phaseToName(services.lifecycleService.phase),
    getContextKey: (key) => services.contextKeyService.get(key),
    runCommand: (id, ...args) => services.commandService.executeCommand(id, ...args),
    getActiveEditorUri: () => services.editorService.activeEditorId.get(),
    isReferencePeekFocused: () => {
      const active = document.activeElement
      return active instanceof HTMLElement && active.closest('.ref-tree') != null
    },
    getStatusBarEntries: (): E2EStatusBarEntry[] =>
      services.statusBarService.entries.get().map(({ id, entry }) => ({
        id: String(id),
        text: entry.text,
        alignment: entry.alignment === StatusBarAlignment.Right ? 'right' : 'left',
        ...(entry.icon !== undefined && { icon: entry.icon }),
        ...(entry.tooltip !== undefined && { tooltip: entry.tooltip }),
      })),
    getUpdateState: async (): Promise<E2EUpdateState> => {
      const s = await services.updateService.getState()
      return {
        status: s.status,
        currentVersion: s.currentVersion,
        ...(s.version !== undefined && { version: s.version }),
        ...(s.percent !== undefined && { percent: s.percent }),
        ...(s.error !== undefined && { error: s.error }),
      }
    },
    openWorkspace: (fsPath) => services.workspaceService.openFolder(URI.file(fsPath)),
    getCurrentWorkspacePath: () => services.workspaceService.current?.folder.fsPath,
    getOpenWindows: async () =>
      (await services.windowsService.getWindows()).map((w) => {
        const revived = w.folder ? URI.revive(w.folder) : null
        return { id: w.id, folder: revived?.fsPath ?? null, name: w.name }
      }),
    openFolderInNewWindow: (fsPath) => services.windowsService.openWindow(URI.file(fsPath)),
    getRecentWorkspacePaths: () => services.workspaceService.recent.map((r) => r.folder.fsPath),
    removeRecentWorkspace: (fsPath) => services.workspaceService.removeRecent(URI.file(fsPath)),
    getLayoutSizes: () => ({ ...services.layoutService.sizes.get() }),
    setLayoutSize: (key, value) => services.layoutService.setSize(key, value),
    flushLayoutSave: () => services.layoutService.save(),
    triggerError: (message = 'E2E triggerError') => {
      throw new Error(message)
    },
    triggerUnexpectedError: (message = 'E2E triggerUnexpectedError') => {
      onUnexpectedError(new Error(message))
    },
    registerDummyEditor: (glob: string, typeId: string) => {
      ds.add(EditorRegistry.registerEditorProvider({ typeId, componentKey: 'dummy' }))
      ds.add(
        services.editorResolverService.registerEditor(
          glob,
          { typeId, displayName: `Dummy (${typeId})`, priority: 100 },
          (uri) => new DummyEditorInput(uri, typeId),
        ),
      )
    },
    getActiveEditorTypeId: () => {
      return services.editorGroupsService.activeGroup?.activeEditor?.typeId
    },
    openFileUri: (fsPath: string, options?: { pinned?: boolean }) => {
      return services.editorResolverService.openEditor(URI.file(fsPath), options)
    },
    getEditorGroupCount: () => services.editorGroupsService.count,
    getActiveGroupEditorCount: () => services.editorGroupsService.activeGroup?.editors.length ?? 0,
    getActiveGroupEditorUris: () =>
      (services.editorGroupsService.activeGroup?.editors ?? [])
        .map((e) => e.resource?.toString())
        .filter((u): u is string => u !== undefined),
    setActiveEditorCursor: (lineNumber: number, column: number) => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return false
      const monaco = FileEditorRegistry.get(active)
      if (!monaco) return false
      monaco.setPosition({ lineNumber, column })
      monaco.focus()
      return true
    },
    getActiveEditorCursor: () => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return undefined
      const monaco = FileEditorRegistry.get(active)
      const position = monaco?.getPosition()
      if (!position) return undefined
      return { lineNumber: position.lineNumber, column: position.column }
    },
    getActiveEditorText: () => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return undefined
      const monaco = FileEditorRegistry.get(active)
      return monaco?.getModel()?.getValue()
    },
    setActiveEditorText: (text: string) => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return false
      const monaco = FileEditorRegistry.get(active)
      const model = monaco?.getModel()
      if (!monaco || !model) return false
      model.setValue(text)
      monaco.setPosition({ lineNumber: 1, column: 1 })
      monaco.focus()
      return true
    },
    setActiveEditorSelection: (
      startLineNumber: number,
      startColumn: number,
      endLineNumber: number,
      endColumn: number,
    ) => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return false
      const monaco = FileEditorRegistry.get(active)
      if (!monaco) return false
      monaco.setSelection({ startLineNumber, startColumn, endLineNumber, endColumn })
      monaco.focus()
      return true
    },
    getActiveDiffViewState: () => {
      const group = services.editorGroupsService.activeGroup
      const active = group?.activeEditor
      if (!(active instanceof DiffEditorInput)) return undefined
      const ed = DiffEditorRegistry.get(active, group?.id)
      if (!ed) return undefined
      const modified = ed.getModifiedEditor()
      const cursorLine = modified.getPosition()?.lineNumber ?? 0
      const firstVisibleLine = modified.getVisibleRanges()[0]?.startLineNumber ?? 0
      return {
        cursorLine,
        firstVisibleLine,
        lineChanges: ed.getLineChanges()?.length ?? 0,
        scrollTop: modified.getScrollTop(),
        layoutHeight: modified.getLayoutInfo().height,
      }
    },
    installAcpEchoAgent: (agentId, jsPath) => {
      services.configurationService.update(
        'acp.agents',
        [{ id: agentId, name: 'Echo Agent', command: 'node', args: [jsPath] }],
        ConfigurationTarget.Memory,
      )
      services.configurationService.update(
        'acp.defaultAgentId',
        agentId,
        ConfigurationTarget.Memory,
      )
    },
    getAcpSessionCount: () => services.acpSessionService.sessions.get().length,
    getActiveAcpSessionId: () => services.acpSessionService.activeSessionId.get(),
    sendAcpPrompt: async (text) => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) throw new Error('[E2E] no active ACP session')
      await s.sendPrompt(text)
    },
    getAcpMessages: () => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) return []
      return s.messages.get().map((m) => ({ role: m.role, text: m.text }))
    },
    getAcpToolCalls: () => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) return []
      return s.toolCalls.get().map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        text: t.text,
        ...(t.mcpServer !== undefined && { mcpServer: t.mcpServer }),
      }))
    },
    getAcpMcpServers: () => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) return []
      return s.mcpServers.get().map((m) => ({
        name: m.name,
        status: m.status,
        ...(m.transport !== undefined && { transport: m.transport }),
      }))
    },
    getAcpPendingQuestion: () => {
      const s = services.acpSessionService.activeSession.get()
      const q = s?.pendingQuestion.get()
      if (!q) return undefined
      return {
        toolCallId: q.toolCallId,
        questions: q.questions.map((qq) => ({ question: qq.question, header: qq.header })),
      }
    },
    resolveAcpQuestion: (answers) => {
      const s = services.acpSessionService.activeSession.get()
      const q = s?.pendingQuestion.get()
      if (!q) throw new Error('[E2E] no pending ACP question')
      q.resolve({ answers })
    },
    cancelAcpQuestion: () => {
      const s = services.acpSessionService.activeSession.get()
      s?.pendingQuestion.get()?.cancel()
    },
    getActiveOutputChannelName: () => services.outputService.activeChannelName.get(),
    getOutputChannelNames: () => services.outputService.channelNames.get(),
    createOutputChannel: (name: string) => {
      services.outputService.createChannel(name)
    },
    terminalCreate: async (): Promise<string> => {
      const info = await services.terminalService.create({})
      if (!terminalBuffers.has(info.id)) terminalBuffers.set(info.id, '')
      return info.id
    },
    terminalInput: (id: string, data: string): Promise<void> =>
      services.terminalService.input(id, data),
    terminalReadBuffer: (id: string): string => terminalBuffers.get(id) ?? '',
    getStoredLeakReport: (): E2EDisposableLeakReport | null => {
      const raw = sessionStorage.getItem(DISPOSABLE_LEAK_REPORT_KEY)
      if (!raw) return null
      return JSON.parse(raw) as E2EDisposableLeakReport
    },
    computeTeardownLeakReport: (): E2EDisposableLeakReport | null =>
      services.computeTeardownLeakReport(),
    getScmSourceControlCount: (): number => services.scmService.sourceControls.get().length,
    getScmInputBoxValue: (): string | undefined =>
      services.scmService.sourceControls.get()[0]?.inputValue.get(),
    getMarkdownDocumentSymbols: async (uri: string): Promise<readonly string[]> => {
      const monacoNs = MonacoLoader.get()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const provider = services.languageFeaturesService.getDocumentSymbolProviders('markdown')[0]
      if (!provider) return []
      const symbols = (await provider.provideDocumentSymbols(model, NONE_TOKEN)) ?? []
      const names: string[] = []
      const walk = (list: readonly { name: string; children?: readonly unknown[] }[]): void => {
        for (const s of list) {
          names.push(s.name)
          if (s.children) walk(s.children as typeof list)
        }
      }
      walk(symbols as readonly { name: string; children?: readonly unknown[] }[])
      return names
    },
    queryMarkdownWorkspaceSymbols: async (query: string): Promise<readonly string[]> => {
      const providers = services.languageFeaturesService.getWorkspaceSymbolProviders()
      const names: string[] = []
      for (const provider of providers) {
        const symbols = (await provider.provideWorkspaceSymbols(query)) ?? []
        for (const s of symbols) names.push(s.name)
      }
      return names
    },
    getMarkdownDefinition: async (
      uri: string,
      lineNumber: number,
      column: number,
    ): Promise<readonly string[]> => {
      const monacoNs = MonacoLoader.get()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const provider = services.languageFeaturesService.getDefinitionProviders('markdown')[0]
      if (!provider) return []
      const result = await provider.provideDefinition(
        model,
        new monacoNs.Position(lineNumber, column),
        NONE_TOKEN,
      )
      if (!result) return []
      const links = Array.isArray(result) ? result : [result]
      return links.map((l) => l.uri.toString())
    },
    getMarkdownFoldingRanges: async (
      uri: string,
    ): Promise<ReadonlyArray<readonly [number, number]>> => {
      const monacoNs = MonacoLoader.get()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const provider = services.languageFeaturesService.getFoldingRangeProviders('markdown')[0]
      if (!provider) return []
      const ranges = (await provider.provideFoldingRanges(model, {}, NONE_TOKEN)) ?? []
      return ranges.map((r) => [r.start, r.end] as const)
    },
    getMarkdownMarkers: (uri: string) => {
      const markers = MonacoLoader.get().editor.getModelMarkers({
        owner: 'markdown',
        resource: MonacoLoader.get().Uri.parse(uri),
      })
      return markers.map((m) => ({
        message: m.message,
        severity: m.severity,
        startLineNumber: m.startLineNumber,
      }))
    },
    getOutlineSymbols: (): readonly string[] => {
      const roots = services.outlineService.outline.get()?.roots ?? []
      const names: string[] = []
      const walk = (list: readonly { name: string; children?: readonly unknown[] }[]): void => {
        for (const s of list) {
          names.push(s.name)
          if (s.children) walk(s.children as typeof list)
        }
      }
      walk(roots as readonly { name: string; children?: readonly unknown[] }[])
      return names
    },
    getOutlineUri: (): string | undefined => services.outlineService.outline.get()?.uri,
    resolveKeybinding: (key: string): { kind: string; command?: string } => {
      const r = KeybindingsRegistry.resolveKeystroke(key)
      return r.kind === 'execute' ? { kind: r.kind, command: r.command } : { kind: r.kind }
    },
    hasCommand: (id: string): boolean => CommandsRegistry.getCommand(id) !== undefined,
    getKeybindingCommandsForKey: (key: string): string[] => {
      const normalized = key.trim().toLowerCase()
      return KeybindingsRegistry.getAllKeybindings()
        .filter((kb) => {
          const first = (kb.chords ? kb.chords[0] : kb.key)?.trim().toLowerCase()
          return first === normalized && !kb.isNegated
        })
        .map((kb) => kb.command)
    },
    updateConfigValue: (key: string, value: unknown): void =>
      services.configurationService.update(key, value, ConfigurationTarget.Memory),
  }

  window[E2E_PROBE_KEY] = probe

  console.info('[E2E] probe installed')
  return ds
}
