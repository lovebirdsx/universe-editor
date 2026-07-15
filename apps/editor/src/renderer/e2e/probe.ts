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
  type IFileService,
  type ILayoutService,
  type ILifecycleService,
  type IOutputService,
  type IStatusBarService,
  type IViewDescriptorService,
  type IViewsService,
  type IWindowsService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type { IAcpSessionService } from '../services/acp/acpSessionService.js'
import type { IUpdateService } from '../../shared/ipc/updateService.js'
import type { ITerminalService } from '../../shared/ipc/terminalService.js'
import type { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import type { IOutlineService } from '../services/languageFeatures/OutlineService.js'
import type { ITimerService } from '../services/performance/TimerService.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../services/editor/DiffEditorRegistry.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'
import { DirtyDiffPeekRegistry } from '../workbench/scm/dirtyDiff/DirtyDiffPeekRegistry.js'
import { AcpPromptDraftCache } from '../services/acp/acpPromptDraftCache.js'
import { applyViewDrop } from '../workbench/dnd/applyViewDrop.js'
import {
  E2E_PROBE_ENABLED_KEY,
  E2E_PROBE_KEY,
  DISPOSABLE_LEAK_REPORT_KEY,
  type E2EDisposableLeakReport,
  type E2ELifecyclePhase,
  type E2EProbe,
  type E2ESemanticTokenDebug,
  type E2EStatusBarEntry,
  type E2EUpdateState,
  type E2EAiDebugRecord,
} from '../../shared/e2e/contract.js'
import type { IScmService } from '../services/extensions/ScmService.js'
import type { IAiDebugService } from '../../shared/ipc/aiDebugService.js'
import type { ExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import type { IExtensionManagementService } from '../../shared/ipc/extensionManagementService.js'
import {
  type IExtensionEnablementService,
  EnablementState,
} from '../services/extensions/ExtensionEnablementService.js'

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
  readonly viewsService: IViewsService
  readonly viewDescriptorService: IViewDescriptorService
  readonly configurationService: IConfigurationService
  readonly acpSessionService: IAcpSessionService
  readonly outputService: IOutputService
  readonly updateService: IUpdateService
  readonly terminalService: ITerminalService
  readonly scmService: IScmService
  readonly languageFeaturesService: ILanguageFeaturesService
  readonly outlineService: IOutlineService
  readonly aiDebugService: IAiDebugService
  readonly timerService: ITimerService
  readonly explorerTreeService: ExplorerTreeService
  readonly fileService: IFileService
  readonly extensionManagementService: IExtensionManagementService
  readonly extensionEnablementService: IExtensionEnablementService
  /**
   * Resolves once the one-shot bootstrap focus restore has landed. That restore
   * is fire-and-forget and runs AFTER LifecyclePhase.Restored, so specs must
   * await this before driving focus themselves to avoid a race.
   */
  readonly bootstrapFocusSettled: Promise<void>
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

/** Minimal shape of Monaco's inline-completions controller for ghost-text probing. */
interface GhostTextLike {
  readonly parts: ReadonlyArray<{ readonly text: string }>
}
interface InlineCompletionsModelLike {
  readonly primaryGhostText?: { get?: () => GhostTextLike | undefined }
  readonly inlineEditState?: { get?: () => InlineEditStateLike | undefined }
}
interface InlineEditStateLike {
  readonly inlineEdit?: { readonly edit?: { readonly text?: string } }
}
interface InlineCompletionsControllerLike {
  dispose(): void
  readonly model?: { get?: () => InlineCompletionsModelLike | undefined }
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

  // The fake inline-completion provider installed by installFakeInlineCompletion,
  // replaced on each call and disposed with the probe.
  let fakeInlineCompletion: IDisposable | undefined

  // The fake inline-edit (NES) provider installed by installFakeInlineEdit.
  let fakeInlineEdit: IDisposable | undefined

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
    whenBootstrapFocusSettled: () => services.bootstrapFocusSettled,
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
      // Flatten the discriminated-union state into the stable E2E contract. The
      // one-shot idle flags (error / notAvailable) surface as their own statuses.
      let status: string = s.type
      if (s.type === 'idle') {
        status = s.notAvailable ? 'not-available' : s.error !== undefined ? 'error' : 'idle'
      }
      return {
        status,
        currentVersion: s.currentVersion,
        ...('version' in s && s.version !== undefined && { version: s.version }),
        ...(s.type === 'downloading' && { percent: s.percent }),
        ...(s.type === 'idle' && s.error !== undefined && { error: s.error }),
      }
    },
    openWorkspace: (fsPath) => services.workspaceService.openFolder(URI.file(fsPath)),
    closeWorkspace: () => services.workspaceService.closeFolder(),
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
    getActiveEditorFirstVisibleLine: () => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return undefined
      const monaco = FileEditorRegistry.get(active)
      return monaco?.getVisibleRanges()[0]?.startLineNumber
    },
    getActiveEditorLastVisibleLine: () => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return undefined
      const monaco = FileEditorRegistry.get(active)
      const ranges = monaco?.getVisibleRanges()
      return ranges && ranges.length > 0 ? ranges[ranges.length - 1]?.endLineNumber : undefined
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
    getActiveDiffContent: () => {
      const group = services.editorGroupsService.activeGroup
      const active = group?.activeEditor
      if (!(active instanceof DiffEditorInput)) return undefined
      const ed = DiffEditorRegistry.get(active, group?.id)
      const model = ed?.getModel()
      if (!model) return undefined
      return { original: model.original.getValue(), modified: model.modified.getValue() }
    },
    openDirtyDiffPeekAtLine: (line: number): boolean =>
      DirtyDiffPeekRegistry.getHost()?.openAtLine(line) ?? false,
    getDirtyDiffPeekState: () => {
      const host = DirtyDiffPeekRegistry.getHost()
      if (!host || !host.isPeekOpen()) return undefined
      const group = services.editorGroupsService.activeGroup
      const active = group?.activeEditor
      const editor = active instanceof FileEditorInput ? FileEditorRegistry.get(active) : undefined
      return {
        open: true,
        panelHeightPx: host.getPeekPanelHeightPx() ?? 0,
        maxHeightPx: host.getPeekMaxHeightPx() ?? 0,
        editorFirstVisibleLine: editor?.getVisibleRanges()[0]?.startLineNumber ?? 0,
      }
    },
    isDirtyDiffPeekVisible: (): boolean =>
      services.contextKeyService.get('dirtyDiffPeekVisible') === true,
    resizeDirtyDiffPeekByPx: (deltaPx: number): number | undefined =>
      DirtyDiffPeekRegistry.getHost()?.resizePeekByPx(deltaPx),
    installAcpEchoAgent: (agentId, jsPath, env) => {
      services.configurationService.update(
        'acp.agents',
        [
          {
            id: agentId,
            name: 'Echo Agent',
            command: 'node',
            args: [jsPath],
            ...(env ? { env } : {}),
          },
        ],
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
    getActiveAcpSessionImageSupported: () =>
      services.acpSessionService.activeSession.get()?.imageSupported.get() === true,
    sendAcpPrompt: async (text) => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) throw new Error('[E2E] no active ACP session')
      await s.sendPrompt(text)
    },
    setAcpCollapseMode: (mode) => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) throw new Error('[E2E] no active ACP session')
      // collapseMode is read-only on the model; cycle until it lands on target.
      for (let i = 0; i < 3 && s.collapseMode.get() !== mode; i++) s.cycleCollapseMode()
    },
    getAcpPromptText: () => {
      const id = services.acpSessionService.activeSessionId.get()
      if (!id) return ''
      return AcpPromptDraftCache.load(id)?.text ?? ''
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
    getVisibleScmGroupIds: (): readonly string[] => {
      const out: string[] = []
      for (const sc of services.scmService.sourceControls.get()) {
        for (const g of sc.groups.get()) {
          // Mirror ScmView's visibility rule: hide only when empty AND hideWhenEmpty.
          if (g.resources.get().length === 0 && g.hideWhenEmpty.get()) continue
          out.push(g.id)
        }
      }
      return out
    },
    // Group ids whose resource list contains a file whose path ends with `suffix`
    // (case-insensitive, separator-agnostic). Lets specs assert which changelist /
    // reconcile group a file landed in after a drag-and-drop move.
    getScmGroupIdsForResource: (suffix: string): readonly string[] => {
      // SCM-domain suffix match: normalize separators + case just to compare a
      // resource path tail against `suffix` (mirrors ScmView's pathKey). Not a
      // persisted identity key, so the base path util is unnecessary here.
      // eslint-disable-next-line no-restricted-syntax -- SCM-domain suffix compare only
      const normalize = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
      const needle = normalize(suffix)
      const out: string[] = []
      for (const sc of services.scmService.sourceControls.get()) {
        for (const g of sc.groups.get()) {
          const hit = g.resources.get().some((r) => normalize(r.resourceUri).endsWith(needle))
          if (hit) out.push(g.id)
        }
      }
      return out
    },
    installVsixExtension: async (vsixPath: string): Promise<string> => {
      const local = await services.extensionManagementService.installVSIX(vsixPath)
      return local.identifier
    },
    uninstallExtension: (identifier: string): Promise<void> =>
      services.extensionManagementService.uninstall(identifier),
    getInstalledExtensionIds: async (): Promise<readonly string[]> => {
      const list = await services.extensionManagementService.getInstalled()
      return list.map((e) => e.identifier)
    },
    getBuiltinExtensionIds: async (): Promise<readonly string[]> => {
      const list = await services.extensionManagementService.listBuiltinExtensions()
      return list.map((e) => e.identifier)
    },
    getDisabledExtensionIds: (): Promise<readonly string[]> =>
      services.extensionEnablementService.getEffectiveDisabledIds(),
    setExtensionEnablement: (
      identifier: string,
      enabled: boolean,
      workspace = false,
    ): Promise<void> =>
      services.extensionEnablementService.setEnablement(
        identifier,
        enabled
          ? workspace
            ? EnablementState.EnabledWorkspace
            : EnablementState.EnabledGlobally
          : workspace
            ? EnablementState.DisabledWorkspace
            : EnablementState.DisabledGlobally,
      ),
    getMarkdownDocumentSymbols: async (uri: string): Promise<readonly string[]> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
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
      const monacoNs = await MonacoLoader.ensureInitialized()
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
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const provider = services.languageFeaturesService.getFoldingRangeProviders('markdown')[0]
      if (!provider) return []
      const ranges = (await provider.provideFoldingRanges(model, {}, NONE_TOKEN)) ?? []
      return ranges.map((r) => [r.start, r.end] as const)
    },
    getMarkdownMarkers: async (uri: string) => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const markers = monacoNs.editor.getModelMarkers({
        owner: 'markdown',
        resource: monacoNs.Uri.parse(uri),
      })
      return markers.map((m) => ({
        message: m.message,
        severity: m.severity,
        startLineNumber: m.startLineNumber,
      }))
    },
    getMarkdownLineTokens: async (
      uri: string,
      lineNumber: number,
    ): Promise<ReadonlyArray<readonly [number, string]>> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      // colorize forces the lazy tokens-provider factory to resolve; then
      // tokenize the whole document so multi-line frontmatter state carries into
      // the requested line. `editor.tokenize` returns per-line token arrays.
      await monacoNs.editor.colorize('', 'markdown', {})
      const perLine = monacoNs.editor.tokenize(model.getValue(), 'markdown')
      const line = perLine[lineNumber - 1] ?? []
      return line.map((t) => [t.offset + 1, t.type] as const)
    },
    getSemanticTokenDebug: async (
      uri: string,
      lineNumber: number,
      column: number,
    ): Promise<E2ESemanticTokenDebug> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return { error: 'no-model' }

      // 1) Is a semantic-tokens provider registered for this model, and does it
      //    return tokens when called directly? (host RPC + tsserver round-trip)
      const features = await MonacoLoader.getLanguageFeaturesService()
      const providers = features.documentSemanticTokensProvider.ordered(model)
      let legend: { tokenTypes: readonly string[]; tokenModifiers: readonly string[] } | undefined
      let directTokenCount = -1
      if (providers[0]) {
        try {
          legend = providers[0].getLegend()
          const result = await providers[0].provideDocumentSemanticTokens(model, null, NONE_TOKEN)
          // Only whole-document tokens carry `.data`; edits are never requested here.
          directTokenCount = result && 'data' in result ? result.data.length / 5 : 0
        } catch (err) {
          directTokenCount = -2
          void err
        }
      }

      // 2) Standalone config gate: editor.semanticHighlighting must resolve truthy
      //    for the feature to fetch, and the active theme must expose a color for
      //    the semantic token type at the probed position.
      const { StandaloneServices } =
        await import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js')
      const { IConfigurationService } =
        await import('monaco-editor/esm/vs/platform/configuration/common/configuration.js')
      const configService = StandaloneServices.get<{
        getValue: (section: string, overrides?: unknown) => unknown
      }>(IConfigurationService)
      const semanticHighlightingSetting = configService.getValue('editor.semanticHighlighting', {
        overrideIdentifier: model.getLanguageId(),
        resource: model.uri,
      })

      // 3) Was a semantic color actually applied to the merged line tokens? Force
      //    tokenization, then read the foreground color id at the probed column.
      const tokenization = (
        model as unknown as {
          tokenization: {
            forceTokenization: (line: number) => void
            getLineTokens: (line: number) => {
              getCount: () => number
              getStartOffset: (i: number) => number
              getEndOffset: (i: number) => number
              getForeground: (i: number) => number
              getClassName: (i: number) => string
            }
          }
        }
      ).tokenization
      tokenization.forceTokenization(lineNumber)
      const lineTokens = tokenization.getLineTokens(lineNumber)
      const offset = column - 1
      let foreground = -1
      let className = ''
      for (let i = 0; i < lineTokens.getCount(); i++) {
        if (offset >= lineTokens.getStartOffset(i) && offset < lineTokens.getEndOffset(i)) {
          foreground = lineTokens.getForeground(i)
          className = lineTokens.getClassName(i)
          break
        }
      }

      // Resolve the foreground color-id → hex via the theme's token color map so
      // we can tell whether the applied color is the semantic property-blue or a
      // grammar guess.
      let foregroundHex = ''
      try {
        const { IStandaloneThemeService } =
          await import('monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js')
        const themeService = StandaloneServices.get<{
          getColorTheme: () => {
            tokenTheme: { getColorMap: () => Array<{ toString: () => string }> }
          }
        }>(IStandaloneThemeService)
        const colorMap = themeService.getColorTheme().tokenTheme.getColorMap()
        foregroundHex = colorMap[foreground]?.toString() ?? ''
      } catch (err) {
        foregroundHex = `err:${(err as Error).message}`
      }

      // Grammar-only foreground at the same spot (monaco.editor.tokenize bypasses
      // semantic tokens entirely). If this already differs from the interface
      // name's grammar color, a naive prop≠type comparison would pass even with
      // semantic highlighting broken — so surface it to keep the check honest.
      let grammarClassName = ''
      try {
        const perLine = monacoNs.editor.tokenize(model.getValue(), model.getLanguageId())
        const lineGrammar = perLine[lineNumber - 1] ?? []
        for (let i = lineGrammar.length - 1; i >= 0; i--) {
          if (offset >= (lineGrammar[i]?.offset ?? 0)) {
            grammarClassName = lineGrammar[i]?.type ?? ''
            break
          }
        }
      } catch (err) {
        void err
      }

      return {
        providerCount: providers.length,
        ...(legend ? { legend } : {}),
        directTokenCount,
        semanticHighlightingSetting,
        foreground,
        foregroundHex,
        className,
        grammarClassName,
        languageId: model.getLanguageId(),
      }
    },
    getCodeLensDebug: async (uri: string, lineNumber: number) => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return { error: 'no-model' }
      const features = await MonacoLoader.getLanguageFeaturesService()
      const providers = features.codeLensProvider.ordered(model)
      if (!providers[0]) return { providerCount: 0 }

      const list = await providers[0].provideCodeLenses(model, NONE_TOKEN)
      const lenses = list?.lenses ?? []
      // Resolve the lens covering the probed line (CodeLens ranges are 1-based).
      const target = lenses.find((l) => l.range.startLineNumber === lineNumber)
      let resolvedCommandId = ''
      let resolvedCommandTitle = ''
      if (target) {
        const resolved =
          !target.command && providers[0].resolveCodeLens
            ? ((await providers[0].resolveCodeLens(model, target, NONE_TOKEN)) ?? target)
            : target
        resolvedCommandId = resolved.command?.id ?? ''
        resolvedCommandTitle = resolved.command?.title ?? ''
      }
      return {
        providerCount: providers.length,
        lensCount: lenses.length,
        resolvedCommandId,
        resolvedCommandTitle,
      }
    },
    getRenderedCodeLenses: async () => {
      // Read the lenses Monaco's OWN CodeLens controller has computed for the
      // active editor — the real render path, gated by the `editor.codeLens`
      // option, editor focus and viewport resolution. Unlike getCodeLensDebug
      // (which calls the provider directly and so stays green even when nothing
      // renders on screen), this reflects what the user actually sees.
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return []
      const editor = FileEditorRegistry.get(active)
      if (!editor) return []
      const controller = editor.getContribution('css.editor.codeLens') as {
        getModel?: () => Promise<
          | {
              lenses?: ReadonlyArray<{
                symbol: {
                  range: { startLineNumber: number }
                  command?: { id: string; title: string }
                }
              }>
            }
          | undefined
        >
      } | null
      if (!controller?.getModel) return []
      const model = await controller.getModel()
      return (model?.lenses ?? []).map((l) => ({
        line: l.symbol.range.startLineNumber,
        commandId: l.symbol.command?.id ?? '',
        title: l.symbol.command?.title ?? '',
      }))
    },
    getMarkdownDocumentLinks: async (uri: string): Promise<readonly string[]> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const features = await MonacoLoader.getLanguageFeaturesService()
      const targets: string[] = []
      for (const provider of features.linkProvider.ordered(model)) {
        const list = await provider.provideLinks(model, NONE_TOKEN)
        for (const link of list?.links ?? []) {
          const resolved =
            !link.url && provider.resolveLink
              ? ((await provider.resolveLink(link, NONE_TOKEN)) ?? link)
              : link
          if (resolved.url) targets.push(resolved.url.toString())
        }
      }
      return targets
    },
    getMarkdownHover: async (uri: string, lineNumber: number, column: number): Promise<string> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return ''
      const features = await MonacoLoader.getLanguageFeaturesService()
      const position = new monacoNs.Position(lineNumber, column)
      const parts: string[] = []
      for (const provider of features.hoverProvider.ordered(model)) {
        const hover = await provider.provideHover(model, position, NONE_TOKEN)
        for (const c of hover?.contents ?? []) parts.push(c.value)
      }
      return parts.join('\n')
    },
    getMarkdownCompletions: async (
      uri: string,
      lineNumber: number,
      column: number,
    ): Promise<readonly string[]> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const features = await MonacoLoader.getLanguageFeaturesService()
      const position = new monacoNs.Position(lineNumber, column)
      const labels: string[] = []
      for (const provider of features.completionProvider.ordered(model)) {
        const list = await provider.provideCompletionItems(
          model,
          position,
          { triggerKind: 0 },
          NONE_TOKEN,
        )
        for (const item of list?.suggestions ?? []) {
          labels.push(typeof item.label === 'string' ? item.label : item.label.label)
        }
      }
      return labels
    },
    getMarkdownReferences: async (
      uri: string,
      lineNumber: number,
      column: number,
    ): Promise<readonly string[]> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const features = await MonacoLoader.getLanguageFeaturesService()
      const position = new monacoNs.Position(lineNumber, column)
      const targets: string[] = []
      for (const provider of features.referenceProvider.ordered(model)) {
        const locations =
          (await provider.provideReferences(
            model,
            position,
            { includeDeclaration: true },
            NONE_TOKEN,
          )) ?? []
        for (const loc of locations) targets.push(loc.uri.toString())
      }
      return targets
    },
    getMarkdownPasteEdit: async (
      uri: string,
      mime: string,
      data: string,
      selection?: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      },
    ): Promise<string | null> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return null
      const features = await MonacoLoader.getLanguageFeaturesService()
      const range =
        selection ??
        ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as const)
      const dataTransfer = {
        get: (m: string) => (m === mime ? { asString: async () => data } : undefined),
      }
      for (const provider of features.documentPasteEditProvider.ordered(model)) {
        const p = provider as {
          provideDocumentPasteEdits?: (
            model: unknown,
            ranges: readonly unknown[],
            dt: unknown,
            ctx: unknown,
            token: unknown,
          ) => Promise<{ edits: { insertText: string | { snippet: string } }[] } | undefined>
        }
        const result = await p.provideDocumentPasteEdits?.(
          model,
          [range],
          dataTransfer,
          { triggerKind: 0 },
          NONE_TOKEN,
        )
        const insert = result?.edits[0]?.insertText
        if (insert != null) return typeof insert === 'string' ? insert : insert.snippet
      }
      return null
    },
    getMarkdownDropEdit: async (
      uri: string,
      entries: { mime: string; text?: string; base64?: string; fileName?: string }[],
    ): Promise<string | null> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return null
      const features = await MonacoLoader.getLanguageFeaturesService()

      // A minimal VSDataTransfer stub supporting both `get(mime)` (uri-list /
      // text) and iteration (image file entries), matching what the real drop
      // controller hands the provider.
      const items = entries.map((e) => {
        const bytes = e.base64 ? Uint8Array.from(atob(e.base64), (c) => c.charCodeAt(0)) : undefined
        return {
          mime: e.mime,
          item: {
            asString: async () => e.text ?? '',
            asFile: () =>
              bytes ? { name: e.fileName ?? 'image', data: async () => bytes } : undefined,
          },
        }
      })
      const dataTransfer = {
        get: (m: string) => items.find((it) => it.mime === m)?.item,
        *[Symbol.iterator]() {
          for (const it of items) yield [it.mime, it.item] as [string, unknown]
        },
      }
      const position = { lineNumber: 1, column: 1 }
      for (const provider of features.documentDropEditProvider.ordered(model)) {
        const p = provider as {
          provideDocumentDropEdits?: (
            model: unknown,
            position: unknown,
            dt: unknown,
            token: unknown,
          ) => Promise<{ edits: { insertText: string | { snippet: string } }[] } | undefined>
        }
        const result = await p.provideDocumentDropEdits?.(model, position, dataTransfer, NONE_TOKEN)
        const insert = result?.edits[0]?.insertText
        if (insert != null) return typeof insert === 'string' ? insert : insert.snippet
      }
      return null
    },
    // Insert a snippet into the active editor via SnippetController2 (the same
    // path FileBulkEditService uses for drop/paste-to-link) and report the
    // resulting buffer text plus the text left selected — so an e2e can assert the
    // `${1:text}` placeholder is both expanded and selected (the VSCode gesture).
    insertMarkdownSnippet: (snippet: string): { text: string; selected: string } | undefined => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return undefined
      const editor = FileEditorRegistry.get(active)
      const model = editor?.getModel()
      if (!editor || !model) return undefined
      const controller = editor.getContribution('snippetController2') as {
        insert?: (template: string) => void
      } | null
      if (!controller?.insert) return undefined
      controller.insert(snippet)
      const selection = editor.getSelection()
      const selected = selection ? model.getValueInRange(selection) : ''
      return { text: model.getValue(), selected }
    },
    // End-to-end drop execution: run the markdown drop provider for `entries`,
    // then apply its edit through the REAL bulk-edit path monaco's drop
    // controller uses — `createCombinedWorkspaceEdit` + IBulkEditService.apply(
    // edit, { editor }) — and report the resulting buffer text and the text left
    // selected. Unlike getMarkdownDropEdit (provider only) / insertMarkdownSnippet
    // (SnippetController only), this covers the FileBulkEditService glue that a
    // real drag-and-drop flows through, so the auto-select regression is caught.
    applyMarkdownDropEdit: async (
      uri: string,
      entries: { mime: string; text?: string; base64?: string; fileName?: string }[],
      position?: { lineNumber: number; column: number },
    ): Promise<{ text: string; selected: string } | null> => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return null
      const editor = FileEditorRegistry.get(active)
      const model = editor?.getModel()
      if (!editor || !model) return null
      // `uri` is accepted for call-site clarity; the drop always targets the
      // active editor's own model (what a real drag-and-drop lands in).
      void uri

      const features = await MonacoLoader.getLanguageFeaturesService()
      const bulkEditService = await MonacoLoader.getBulkEditService()

      const items = entries.map((e) => {
        const bytes = e.base64 ? Uint8Array.from(atob(e.base64), (c) => c.charCodeAt(0)) : undefined
        return {
          mime: e.mime,
          item: {
            asString: async () => e.text ?? '',
            asFile: () =>
              bytes ? { name: e.fileName ?? 'image', data: async () => bytes } : undefined,
          },
        }
      })
      const dataTransfer = {
        get: (m: string) => items.find((it) => it.mime === m)?.item,
        *[Symbol.iterator]() {
          for (const it of items) yield [it.mime, it.item] as [string, unknown]
        },
      }

      const pos = position ?? { lineNumber: 1, column: 1 }
      let snippet: string | undefined
      for (const provider of features.documentDropEditProvider.ordered(model)) {
        const p = provider as {
          provideDocumentDropEdits?: (
            model: unknown,
            position: unknown,
            dt: unknown,
            token: unknown,
          ) => Promise<{ edits: { insertText: string | { snippet: string } }[] } | undefined>
        }
        const result = await p.provideDocumentDropEdits?.(model, pos, dataTransfer, NONE_TOKEN)
        const insert = result?.edits[0]?.insertText
        if (insert != null) {
          snippet = typeof insert === 'string' ? insert : insert.snippet
          break
        }
      }
      if (snippet == null) return null

      // Mirror monaco's createCombinedWorkspaceEdit: one ResourceTextEdit at the
      // drop range carrying the snippet as `insertAsSnippet`.
      const range = {
        startLineNumber: pos.lineNumber,
        startColumn: pos.column,
        endLineNumber: pos.lineNumber,
        endColumn: pos.column,
      }
      editor.focus()
      editor.setPosition(pos)
      await bulkEditService.apply(
        {
          edits: [
            {
              resource: model.uri,
              textEdit: { range, text: snippet, insertAsSnippet: true },
            },
          ],
        },
        { editor },
      )
      const selection = editor.getSelection()
      const selected = selection ? model.getValueInRange(selection) : ''
      return { text: model.getValue(), selected }
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
    getOutlineActiveSymbol: (): string | undefined =>
      services.outlineService.activeSymbol.get()?.name,
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
    renameExplorerResource: async (fsPath: string, newName: string): Promise<string> => {
      const target = await services.explorerTreeService.rename(URI.file(fsPath), newName)
      return target.toString()
    },
    moveExplorerResource: async (fsPath: string, destDirFsPath: string): Promise<string> => {
      const [target] = await services.explorerTreeService.moveResources(
        [{ resource: URI.file(fsPath), isDirectory: false }],
        URI.file(destDirFsPath),
      )
      return target?.toString() ?? ''
    },
    readWorkspaceFileText: (fsPath: string): Promise<string> =>
      services.fileService.readFileText(URI.file(fsPath)),
    getViewContainerByViewId: (viewId: string) =>
      services.viewDescriptorService.getViewContainerByViewId(viewId)?.id,
    getViewIdsByContainer: (containerId: string) =>
      services.viewDescriptorService.getViewsByContainer(containerId).map((v) => v.id),
    getViewContainerIdsByLocation: (location: number) =>
      services.viewDescriptorService.getViewContainersByLocation(location).map((c) => c.id),
    moveViewsToContainer: (viewIds: readonly string[], targetContainerId: string) =>
      services.viewDescriptorService.moveViewsToContainer(viewIds, targetContainerId),
    moveViewToLocation: (viewId: string, location: number) =>
      services.viewDescriptorService.moveViewToLocation(viewId, location),
    moveViewInContainer: (containerId: string, viewId: string, targetViewId: string) =>
      services.viewDescriptorService.moveViewInContainer(containerId, viewId, targetViewId),
    moveViewContainerToLocation: (containerId: string, location: number) =>
      services.viewDescriptorService.moveViewContainerToLocation(containerId, location),
    mergeViewContainerInto: (sourceContainerId: string, targetContainerId: string) =>
      applyViewDrop(
        services.viewDescriptorService,
        { kind: 'container', id: sourceContainerId },
        { kind: 'container', containerId: targetContainerId, merge: true },
      ),
    getViewCollapsed: (viewId: string) =>
      services.viewDescriptorService.getViewState(viewId).collapsed === true,
    setViewCollapsed: (viewId: string, collapsed: boolean) =>
      services.viewDescriptorService.setViewCollapsed(viewId, collapsed),
    flushViewCustomizationsSave: () => services.viewDescriptorService.save(),
    resetViewLocations: () => services.viewDescriptorService.reset(),
    installFakeInlineCompletion: (text: string): boolean => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return false
      const editor = FileEditorRegistry.get(active)
      const model = editor?.getModel()
      if (!editor || !model) return false
      fakeInlineCompletion?.dispose()
      fakeInlineCompletion = services.languageFeaturesService.registerInlineCompletionsProvider(
        '*',
        {
          provideInlineCompletions: (_m, position) => ({
            items: [
              {
                insertText: text,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              },
            ],
          }),
          disposeInlineCompletions: () => {
            // No per-completion resources to release.
          },
        },
      )
      ds.add(fakeInlineCompletion)
      return true
    },
    getActiveInlineSuggestionText: (): string | undefined => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return undefined
      const editor = FileEditorRegistry.get(active)
      if (!editor || typeof editor.getContribution !== 'function') return undefined
      const controller = editor.getContribution<InlineCompletionsControllerLike>(
        'editor.contrib.inlineCompletionsController',
      )
      const ghost = controller?.model?.get?.()?.primaryGhostText?.get?.()
      if (!ghost || ghost.parts.length === 0) return undefined
      return ghost.parts.map((p) => p.text).join('')
    },
    installFakeInlineEdit: (startLine: number, endLine: number, text: string): boolean => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return false
      const editor = FileEditorRegistry.get(active)
      const model = editor?.getModel()
      if (!editor || !model) return false
      fakeInlineEdit?.dispose()
      fakeInlineEdit = services.languageFeaturesService.registerInlineCompletionsProvider('*', {
        provideInlineCompletions: (m, _position, context) => {
          if (context.includeInlineEdits !== true) return { items: [] }
          return {
            items: [
              {
                insertText: text,
                range: {
                  startLineNumber: startLine,
                  startColumn: 1,
                  endLineNumber: endLine,
                  endColumn: m.getLineMaxColumn(endLine),
                },
                isInlineEdit: true,
                showInlineEditMenu: true,
              },
            ],
          }
        },
        disposeInlineCompletions: () => {
          // No per-completion resources to release.
        },
      })
      ds.add(fakeInlineEdit)
      return true
    },
    getActiveInlineEditText: (): string | undefined => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof FileEditorInput)) return undefined
      const editor = FileEditorRegistry.get(active)
      if (!editor || typeof editor.getContribution !== 'function') return undefined
      const controller = editor.getContribution<InlineCompletionsControllerLike>(
        'editor.contrib.inlineCompletionsController',
      )
      return controller?.model?.get?.()?.inlineEditState?.get?.()?.inlineEdit?.edit?.text
    },
    getAiDebugRecords: async (): Promise<readonly E2EAiDebugRecord[]> => {
      const records = await services.aiDebugService.listRecords()
      return records.map((r) => ({
        id: r.id,
        ...(r.purpose !== undefined && { purpose: r.purpose }),
        modelId: r.modelId,
        status: r.status,
        responsePreview: r.responsePreview,
      }))
    },
    clearAiDebugRecords: () => services.aiDebugService.clearRecords(),
    replayAiDebugRecord: (id: string): Promise<string | undefined> =>
      new Promise<string | undefined>((resolve) => {
        // Buffer chunks/ends per replayId: over IPC the replayId returned by
        // replayRecord() can arrive after the first replayed chunk, so we can't
        // assume it is known when events start flowing.
        const textByReplay = new Map<string, string>()
        const ended = new Set<string>()
        let myReplayId: string | undefined
        let settled = false

        const finish = (rid: string): void => {
          if (settled) return
          settled = true
          subChunk.dispose()
          subEnd.dispose()
          resolve(textByReplay.get(rid) ?? '')
        }

        const subChunk = services.aiDebugService.onDidReplayChunk((e) => {
          if (e.chunk.type !== 'text') return
          textByReplay.set(e.replayId, (textByReplay.get(e.replayId) ?? '') + e.chunk.value)
        })
        const subEnd = services.aiDebugService.onDidReplayEnd((e) => {
          ended.add(e.replayId)
          if (myReplayId === e.replayId) finish(e.replayId)
        })

        void services.aiDebugService.replayRecord(id).then((rid) => {
          if (rid === undefined) {
            if (settled) return
            settled = true
            subChunk.dispose()
            subEnd.dispose()
            resolve(undefined)
            return
          }
          myReplayId = rid
          if (ended.has(rid)) finish(rid)
        })
      }),
    getStartupMetrics: async () => {
      const m = await services.timerService.getStartupMetrics()
      return {
        totalTime: m.totalTime,
        phases: m.phases.map((p) => ({
          label: p.label,
          from: p.from,
          to: p.to,
          duration: p.duration,
        })),
      }
    },
  }

  window[E2E_PROBE_KEY] = probe

  console.info('[E2E] probe installed')
  return ds
}
