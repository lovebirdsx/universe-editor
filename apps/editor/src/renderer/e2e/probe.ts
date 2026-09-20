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
  KeybindingWeight,
  KeybindingsRegistry,
  LifecyclePhase,
  LogLevel,
  Orientation,
  Severity,
  StatusBarAlignment,
  StorageScope,
  URI,
  autorun,
  normalizeKeybindingString,
  onUnexpectedError,
  type AiModelKnowledge,
  type AiProviderEntry,
  type ContextKeyExpression,
  type IAiModelService,
  type ICommandService,
  type IConfigurationService,
  type IContextKeyService,
  type IDirectoryEntry,
  type IEditorGroupsService,
  type IEditorResolverService,
  type IEditorService,
  type IFileService,
  type IFileWatcherService,
  type ILayoutService,
  type ILifecycleService,
  type ILoggerService,
  type INotificationService,
  type IOutputService,
  type IStatusBarService,
  type IStorageService,
  type ITextSearchMainService,
  type IViewDescriptorService,
  type IViewsService,
  type IWindowsService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import type { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import {
  readCodeHtmlBytes,
  readHeapFlowTotals,
  readHeapGauges,
} from '../services/memory/heapFlowCounters.js'
import type { IAcpSessionHistoryService } from '../services/acp/session/acpSessionHistory.js'
import type { BugRecorderClient } from '../services/bugRecording/bugRecorderClient.js'
import { collectTranscripts } from '../actions/bugRecordingActions.js'
import type { IMcpServerEnablementService } from '../services/acp/mcpServerEnablementService.js'
import type { ITimelineService } from '../services/timeline/TimelineService.js'
import type { ITreeViewsService } from '../services/extensions/TreeViewsService.js'
import type { IExtensionMcpServersService } from '../services/extensions/extensionMcpServersService.js'
import type { IUpdateService } from '../../shared/ipc/updateService.js'
import type { IUserSettingsSyncService } from '../services/configuration/UserSettingsSync.js'
import type { ITerminalService } from '../../shared/ipc/terminalService.js'
import type { IRemoteStatusService } from '../../shared/ipc/remoteStatusService.js'
import type { ITerminalManagerService } from '../services/terminal/TerminalManagerService.js'
import type { ITerminalXtermService } from '../services/terminal/TerminalXtermService.js'
import type { ILanguageFeaturesService } from '../services/languageFeatures/LanguageFeaturesService.js'
import type { IOutlineService } from '../services/languageFeatures/OutlineService.js'
import type { ITimerService } from '../services/performance/TimerService.js'
import type { IInteractionPerfService } from '../services/performance/InteractionPerfService.js'
import type { IMemoryPressureService } from '../services/memory/memoryPressureService.js'
import {
  MEMORY_PRESSURE_LEVEL_NAMES,
  MemoryPressureLevel,
} from '../services/memory/memoryPressureLevels.js'
import { readHeapSample } from '../services/memory/rendererHeapSample.js'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
import { DocumentSyncStats } from '../services/extensions/documentSyncStats.js'
import { getActiveTextEditor } from '../services/editor/activeTextEditor.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { DiffEditorRegistry } from '../services/editor/DiffEditorRegistry.js'
import { MonacoLoader, type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import type { IOutputModelService } from '../services/output/OutputModelService.js'
import { revealOutputPanel } from '../services/output/revealOutputPanel.js'
import { DirtyDiffPeekRegistry } from '../workbench/scm/dirtyDiff/DirtyDiffPeekRegistry.js'
import { AcpPromptDraftCache } from '../services/acp/session/acpPromptDraftCache.js'
import { swarmNotificationE2E } from '../services/swarm/swarmNotificationE2E.js'
import { memoryReminderE2E } from '../services/memory/memoryReminderE2E.js'
import { applyViewDrop } from '../workbench/dnd/applyViewDrop.js'
import {
  E2E_PROBE_ENABLED_KEY,
  E2E_PROBE_KEY,
  DISPOSABLE_LEAK_REPORT_KEY,
  type E2EDisposableLeakReport,
  type E2ELifecyclePhase,
  type E2EProbe,
  type E2ESemanticTokenDebug,
  type E2ESemanticTokenStyleDebug,
  type E2EStatusBarEntry,
  type E2EUpdateState,
  type E2EAiDebugRecord,
  type E2EBugRecordingResult,
  type E2EBugRecordingStatus,
  type E2ECodeAction,
  type E2EConfigTarget,
  type E2EContributedMcpServer,
  type E2EDirtyDiffDecoration,
  type E2EDocumentSyncStats,
  type E2EEditorDecoration,
  type E2EExtensionUpdate,
  type E2EFindWidgetState,
  type E2EGcControlState,
  type E2EInstalledExtension,
  type E2EKeybindingEntry,
  type E2EKeybindingTrace,
  type E2EMarker,
  type E2EMemoryReminderDecision,
  type E2EMemoryReminderSample,
  type E2EMemoryReminderState,
  type E2ENotification,
  type E2EOutlineRetentionStats,
  type E2ERecentTarget,
  type E2EScmDecoration,
  type E2ETerminalLink,
  type E2ETimelineItem,
  type E2ETreeItem,
  type E2EWorkingTreeHint,
} from '../../shared/e2e/contract.js'
import type { IScmService } from '../services/extensions/ScmService.js'
import type {
  IRecentTargetsService,
  RecentTarget,
} from '../services/editor/RecentTargetsService.js'
import type { IScmIgnoredResourcesService } from '../services/scm/ScmIgnoredResourcesService.js'
import type { IScmDecorationsService } from '../services/scm/ScmDecorationsService.js'
import type { IScmWorkingTreeHintService } from '../services/scm/ScmWorkingTreeHintService.js'
import type { IScmBehindHintService } from '../services/scm/ScmBehindHintService.js'
import type { IAiDebugService } from '../../shared/ipc/aiDebugService.js'
import type { IFileClipboardService } from '../../shared/ipc/fileClipboardService.js'
import type { IDiagnosticsService } from '../../shared/ipc/services.js'
import type { ExplorerTreeService } from '../services/explorer/ExplorerTreeService.js'
import type { EditorGroupsService } from '../services/editor/EditorGroupsService.js'
import type { IExtensionManagementService } from '../../shared/ipc/extensionManagementService.js'
import type { IExtensionGalleryService } from '../../shared/ipc/extensionGalleryService.js'
import type { IExtensionEnablementService } from '../services/extensions/ExtensionEnablementService.js'
import type { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { EnablementState } from '../services/extensions/ExtensionEnablementService.js'
import type { IUserKeybindingsService } from '../services/keybindings/UserKeybindingsService.js'
import type { WorkbenchThemeService } from '../services/themes/workbenchThemeService.js'
import { currentRemoteAuthority } from '../services/remote/windowRemoteAuthority.js'

export interface E2EProbeServices {
  readonly commandService: ICommandService
  readonly contextKeyService: IContextKeyService
  readonly lifecycleService: ILifecycleService
  readonly editorService: IEditorService
  readonly editorGroupsService: IEditorGroupsService
  readonly editorResolverService: IEditorResolverService
  readonly statusBarService: IStatusBarService
  readonly notificationService: INotificationService
  readonly workspaceService: IWorkspaceService
  readonly windowsService: IWindowsService
  readonly layoutService: ILayoutService
  readonly viewsService: IViewsService
  readonly viewDescriptorService: IViewDescriptorService
  readonly configurationService: IConfigurationService
  readonly storageService: IStorageService
  readonly acpSessionService: IAcpSessionService
  readonly acpSessionHistoryService: IAcpSessionHistoryService
  readonly bugRecorderClient: BugRecorderClient
  readonly mcpServerEnablementService: IMcpServerEnablementService
  readonly extensionMcpServersService: IExtensionMcpServersService
  readonly outputService: IOutputService
  readonly updateService: IUpdateService
  readonly terminalService: ITerminalService
  readonly terminalManagerService: ITerminalManagerService
  readonly terminalXtermService: ITerminalXtermService
  readonly scmService: IScmService
  readonly scmIgnoredResourcesService: IScmIgnoredResourcesService
  readonly scmDecorationsService: IScmDecorationsService
  readonly scmWorkingTreeHintService: IScmWorkingTreeHintService
  readonly scmBehindHintService: IScmBehindHintService
  readonly recentTargetsService: IRecentTargetsService
  readonly languageFeaturesService: ILanguageFeaturesService
  readonly outlineService: IOutlineService
  readonly timelineService: ITimelineService
  readonly treeViewsService: ITreeViewsService
  readonly aiDebugService: IAiDebugService
  readonly aiModelService: IAiModelService
  readonly timerService: ITimerService
  readonly interactionPerfService: IInteractionPerfService
  readonly memoryPressureService: IMemoryPressureService
  readonly diagnosticsService: IDiagnosticsService
  readonly explorerTreeService: ExplorerTreeService
  readonly fileService: IFileService
  readonly textSearchMainService: ITextSearchMainService
  readonly fileWatcherService: IFileWatcherService
  readonly remoteStatusService: IRemoteStatusService
  readonly extensionManagementService: IExtensionManagementService
  readonly extensionGalleryService: IExtensionGalleryService
  readonly extensionEnablementService: IExtensionEnablementService
  readonly extensionHostClientService: IExtensionHostClientService
  readonly outputModelService: IOutputModelService
  readonly loggerService: ILoggerService
  readonly userKeybindingsService: IUserKeybindingsService
  readonly userSettingsSync: IUserSettingsSyncService
  readonly themeService: WorkbenchThemeService
  readonly fileClipboardService: IFileClipboardService
  /**
   * Resolves once the one-shot bootstrap focus restore has landed. That restore
   * is fire-and-forget and runs AFTER LifecyclePhase.Restored, so specs must
   * await this before driving focus themselves to avoid a race.
   */
  readonly bootstrapFocusSettled: Promise<void>
  /** Tears down React + snapshots the Disposable tracker; see E2EProbe. */
  readonly computeTeardownLeakReport: () => E2EDisposableLeakReport | null
}

const ALL_LOG_LEVELS: readonly LogLevel[] = [
  LogLevel.Trace,
  LogLevel.Debug,
  LogLevel.Info,
  LogLevel.Warning,
  LogLevel.Error,
]

/** The Output panel's Monaco editor, identified by its `output://` model uri. */
function findOutputEditor(): monaco.editor.ICodeEditor | undefined {
  // peek(), not get(): specs poll the output probes while Monaco is still
  // dynamically importing, and a thrown "not initialized" would fail the poll
  // instead of retrying until the editor mounts.
  return MonacoLoader.peek()
    ?.editor.getEditors()
    .find((ed) => ed.getModel()?.uri.scheme === 'output')
}

/**
 * The active group's editor (a file editor or an untitled buffer) — the editor
 * the Find commands used to resolve to before they followed the focus, and the
 * one a regression would wrongly reveal the find widget in. Resolved through the
 * active input rather than "the first non-output editor": an unrelated editor
 * mounted earlier (agents prompt, peek preview) must not stand in for it and
 * turn the assertion vacuous.
 */
function findFileEditor(groups: IEditorGroupsService): monaco.editor.ICodeEditor | undefined {
  return getActiveTextEditor(groups)?.editor
}

/**
 * Minimal shape of Monaco's FindController/FindReplaceState, as already narrowed
 * in services/editor/editorFocus.ts for the `findWidgetVisible` bridge.
 */
interface FindControllerLike {
  getState(): {
    readonly isRevealed: boolean
    readonly matchesCount: number
    readonly currentMatch: number | null
    readonly searchString: string
  } | null
}

function readFindState(
  editor: monaco.editor.ICodeEditor | undefined,
): E2EFindWidgetState | undefined {
  const state = (
    editor?.getContribution('editor.contrib.findController') as FindControllerLike | undefined
  )?.getState()
  if (!state) return undefined
  return {
    isRevealed: state.isRevealed,
    matchesCount: state.matchesCount,
    currentMatch: state.currentMatch,
    searchString: state.searchString,
  }
}

/**
 * Reaches the view model's coordinates converter, the only thing that answers
 * "is this model line collapsed by a hidden area?". getTopForLineNumber and
 * friends map a hidden line onto its neighbouring visible line, so they report
 * every line as rendered and cannot be used here.
 */
interface HiddenAreaAwareEditor {
  readonly _modelData?: {
    readonly viewModel?: {
      readonly coordinatesConverter?: {
        modelPositionIsVisible(position: { lineNumber: number; column: number }): boolean
      }
    }
  }
}

function outputLineVisibility(): ((line: number) => boolean) | undefined {
  const editor = findOutputEditor() as
    | (monaco.editor.ICodeEditor & HiddenAreaAwareEditor)
    | undefined
  const converter = editor?._modelData?.viewModel?.coordinatesConverter
  if (!converter) return undefined
  return (line: number) => converter.modelPositionIsVisible({ lineNumber: line, column: 1 })
}

const NONE_TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as import('../workbench/editor/monaco/MonacoLoader.js').monaco.CancellationToken

/** Same none-token, widened for the platform-typed workspace symbol providers. */
const NONE_PLATFORM_TOKEN =
  NONE_TOKEN as unknown as import('@universe-editor/platform').CancellationToken

function severityName(severity: Severity): 'info' | 'warning' | 'error' {
  switch (severity) {
    case Severity.Warning:
      return 'warning'
    case Severity.Error:
      return 'error'
    default:
      return 'info'
  }
}

/**
 * SCM-domain suffix matcher: normalize separators + case just to compare a
 * resource path tail against a spec-provided `suffix` (mirrors ScmView's
 * pathKey). Not a persisted identity key, so the base path util is unnecessary
 * here.
 */
function normalizeScmPath(p: string): string {
  // eslint-disable-next-line no-restricted-syntax -- SCM-domain suffix compare only
  return p.replace(/\\/g, '/').toLowerCase()
}

function toE2EMarker(m: monaco.editor.IMarker): E2EMarker {
  return {
    message: m.message,
    severity: m.severity,
    startLineNumber: m.startLineNumber,
    ...(m.relatedInformation !== undefined && m.relatedInformation.length > 0
      ? {
          relatedInformation: m.relatedInformation.map((ri) => ({
            message: ri.message,
            uri: ri.resource.toString(),
          })),
        }
      : {}),
  }
}

/** MRU 槽位 → {kind,id}；closedEditor 槽位不给（Ctrl+Tab 不列已关闭的编辑器，探针与
 *  它读同一套语义，head 才对得上 picker 的第 0 行）。 */
function toE2ERecentTarget(target: RecentTarget): E2ERecentTarget | undefined {
  if (target.kind === 'view') return { kind: 'view', id: target.descriptor.id }
  if (target.kind === 'editor') return { kind: 'editor', id: target.editor.id }
  return undefined
}

async function getCompletionLabels(
  uri: string,
  lineNumber: number,
  column: number,
): Promise<readonly string[]> {
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
}

/** FNV-1a（UTF-16 码元，32 位）。刻意不用 `crypto.subtle.digest`：那要先整体编码成字节，等于给
 *  可能上兆的缓冲区再复制一份，而这个指纹的意义正是「比一次大缓冲区只要一趟、零分配」。spec 侧
 *  有一份同样的循环，两边由 `smoke.docSyncExternalReload.spec.ts` 的手写字面量钉住。 */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  }
  return hash >>> 0
}

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

/** ConfigurationTarget (const enum) → E2EConfigTarget name, by layer index. */
const CONFIG_TARGET_NAMES: readonly E2EConfigTarget[] = [
  'default',
  'vscodeUser',
  'user',
  'vscodeWorkspace',
  'project',
  'memory',
]

/** 探针记录 outline 代际的上限：弱引用很小，但上限能防住更新风暴把观测器本身撑大；
 *  读数里的 `dropped` 说明上限有没有真的截断过（要比较两段计数时必须为 0）。 */
const OUTLINE_RETENTION_MAX_GENERATIONS = 256

/** 一代 outline：`IOutlineService` 发布的模型，以及它的首个符号（视图回调链钉住的
 *  就是这个层次的对象）。两者都只持弱引用——探针绝不能成为某一代活下来的原因。 */
interface OutlineGenerationRefs {
  readonly model: WeakRef<object>
  readonly symbol: WeakRef<object> | undefined
}

/** Registry items keep `when` as an AST or a string; the trace keeps it pre-serialized. */
function serializeWhen(when: ContextKeyExpression | string | undefined): string | undefined {
  if (when === undefined) return undefined
  return typeof when === 'string' ? when : when.serialize()
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

  // Counts onDidChangeContributions so a spec can observe a host restart even
  // when the pre/post contribution DTOs are identical.
  let extensionHostGeneration = 0
  ds.add(
    services.extensionHostClientService.onDidChangeContributions(() => {
      extensionHostGeneration += 1
    }),
  )

  // Buffer filesystem change events (incl. remote-ssh watcher events) so specs
  // can poll them. Cleared by watchFolder; lives for the probe's lifetime.
  const watchedChangeEvents: { type: string; resource: string }[] = []
  ds.add(
    services.fileWatcherService.onDidChangeFiles((batch) => {
      for (const ev of batch) {
        watchedChangeEvents.push({
          type: ev.type,
          resource: URI.revive(ev.resource)?.toString() ?? '',
        })
      }
    }),
  )
  let remoteSearchSeq = 0

  /**
   * Walk the workspace folder to find the file whose path ends with `suffix`
   * (same case-insensitive, separator-agnostic match as `normalizeScmPath`), so
   * the hint probe can hand the on-demand `getHint` a concrete resource URI
   * rather than a bare path tail.
   */
  async function findWorkspaceResourceEndingWith(suffix: string): Promise<URI | undefined> {
    const root = services.workspaceService.current?.folder
    if (!root) return undefined
    const needle = normalizeScmPath(suffix)
    const queue: URI[] = [root]
    while (queue.length > 0) {
      const dir = queue.shift()!
      let entries: IDirectoryEntry[]
      try {
        entries = await services.fileService.list(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const child = URI.joinPath(dir, entry.name)
        if (entry.isDirectory) queue.push(child)
        else if (entry.isFile && normalizeScmPath(child.fsPath).endsWith(needle)) return child
      }
    }
    return undefined
  }

  // outline 代际保留观测器（仅 E2E，由 spec 显式 start/stop）。它记录视图被要求渲染
  // 过什么，好让强制回收之后能回答「上一代到底能不能被回收」，而不是「回调身份稳不稳」。
  // 这里只存 WeakRef：某一代若还活着，那是窗口里别的东西仍然可达它——正是本观测器要
  // 抓的缺陷。每次 start 开一轮新统计（清空上一轮）；stop 只是关订阅，读数仍在。
  let outlineRetentionRefs: OutlineGenerationRefs[] = []
  let outlineRetentionDropped = 0
  let outlineRetentionSeen = new WeakSet<object>()
  let outlineRetentionSub: IDisposable | undefined
  let gcControl: WeakRef<object> | undefined

  const startOutlineRetentionProbe = (): void => {
    if (outlineRetentionSub) return
    outlineRetentionRefs = []
    outlineRetentionDropped = 0
    outlineRetentionSeen = new WeakSet()
    outlineRetentionSub = autorun((reader) => {
      const model = services.outlineService.outline.read(reader)
      // 同一个模型对象可能被再次发布（例如缓存命中后重发），按 model 去重，避免同一代算两次。
      if (!model || outlineRetentionSeen.has(model)) return
      outlineRetentionSeen.add(model)
      if (outlineRetentionRefs.length >= OUTLINE_RETENTION_MAX_GENERATIONS) {
        outlineRetentionDropped++
        return
      }
      const first = model.roots[0]
      outlineRetentionRefs.push({
        model: new WeakRef(model),
        symbol: first !== undefined ? new WeakRef(first) : undefined,
      })
    })
  }

  const stopOutlineRetentionProbe = (): void => {
    outlineRetentionSub?.dispose()
    outlineRetentionSub = undefined
  }
  ds.add({ dispose: () => stopOutlineRetentionProbe() })

  const getOutlineRetentionStats = (): E2EOutlineRetentionStats => {
    let aliveModels = 0
    let aliveSymbols = 0
    let aliveGenerations = 0
    for (const ref of outlineRetentionRefs) {
      const modelAlive = ref.model.deref() !== undefined
      const symbolAlive = ref.symbol?.deref() !== undefined
      if (modelAlive) aliveModels++
      if (symbolAlive) aliveSymbols++
      if (modelAlive || symbolAlive) aliveGenerations++
    }
    return {
      recording: outlineRetentionSub !== undefined,
      generations: outlineRetentionRefs.length,
      dropped: outlineRetentionDropped,
      aliveModels,
      aliveSymbols,
      aliveGenerations,
    }
  }

  const probe: E2EProbe = {
    whenReady: () => services.lifecycleService.when(LifecyclePhase.Ready),
    whenRestored: () => services.lifecycleService.when(LifecyclePhase.Restored),
    whenBootstrapFocusSettled: () => services.bootstrapFocusSettled,
    getLifecyclePhase: () => phaseToName(services.lifecycleService.phase),
    getContextKey: (key) => services.contextKeyService.get(key),
    getConfigurationValue: (key) => services.configurationService.get(key),
    getConfigurationValueOrigin: (key) =>
      CONFIG_TARGET_NAMES[services.configurationService.getValueOrigin(key) ?? -1],
    whenUserSettingsInitialized: () => services.userSettingsSync.whenInitialized,
    runCommand: (id, ...args) => services.commandService.executeCommand(id, ...args),
    getActiveEditorUri: () => services.editorService.activeEditorId.get(),
    getRecentTargets: (): E2ERecentTarget[] => {
      const out: E2ERecentTarget[] = []
      for (const target of services.recentTargetsService.getRecentTargets()) {
        const dto = toE2ERecentTarget(target)
        if (dto) out.push(dto)
      }
      return out
    },
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
        ...(entry.id !== undefined && { entryId: entry.id }),
        ...(entry.backgroundColor !== undefined && { backgroundColor: entry.backgroundColor }),
      })),
    getNotifications: (): E2ENotification[] =>
      services.notificationService.notifications.get().map((n) => ({
        message: n.message,
        severity: severityName(n.severity),
        actions: n.actions?.map((a) => a.label) ?? [],
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
    reloadStorageFromDisk: async () => {
      await services.storageService.reloadFromDisk?.()
    },
    getCurrentWorkspacePath: () => services.workspaceService.current?.folder.fsPath,
    getOpenWindows: async () =>
      (await services.windowsService.getWindows()).map((w) => {
        const revived = w.folder ? URI.revive(w.folder) : null
        return { id: w.id, folder: revived?.fsPath ?? null, name: w.name }
      }),
    focusWindow: (id) => services.windowsService.focusWindow(id),
    openFolderInNewWindow: (fsPath) => services.windowsService.openWindow(URI.file(fsPath)),
    getRecentWorkspacePaths: () => services.workspaceService.recent.map((r) => r.folder.fsPath),
    removeRecentWorkspace: (fsPath) => services.workspaceService.removeRecent(URI.file(fsPath)),
    getLayoutSizes: () => ({ ...services.layoutService.sizes.get() }),
    getEditorGroupsLayout: () => {
      const grid = (services.editorGroupsService as EditorGroupsService).grid
      const container = grid.getContainerSize()
      const activeId = services.editorGroupsService.activeGroup?.id
      return {
        orientation: grid.orientation === Orientation.Horizontal ? 'horizontal' : 'vertical',
        containerWidth: container?.width ?? 0,
        containerHeight: container?.height ?? 0,
        groups: grid.getViews().map((group) => ({
          id: String(group.id),
          active: group.id === activeId,
          flexSize: grid.getLeafSize(group),
          width: grid.getViewSize(group)?.width ?? 0,
          height: grid.getViewSize(group)?.height ?? 0,
        })),
      }
    },
    getFileIconThemeId: () => services.themeService.getFileIconTheme().id,
    getRegisteredFileIconThemeIds: () => services.themeService.getFileIconThemes().map((t) => t.id),
    getProductIconThemeId: () => services.themeService.getProductIconTheme().id,
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
    getTokenizationSupportInfo: async (languageId: string) => {
      const { TokenizationRegistry } =
        await import('monaco-editor/esm/vs/editor/common/languages.js')
      // Read-only on purpose: getOrCreate would force-resolve the factory and
      // mask the product's own warm-up path (a stuck model would silently heal
      // the moment the e2e gate polls). The takeover gates must observe the
      // support the product resolved by itself.
      const support = TokenizationRegistry.get(languageId)
      return support === null ? null : { constructorName: support.constructor.name }
    },
    getEditorGroupCount: () => services.editorGroupsService.count,
    getActiveGroupId: () => {
      const id = services.editorGroupsService.activeGroup?.id
      return id === undefined ? undefined : String(id)
    },
    getActiveGroupEditorCount: () => services.editorGroupsService.activeGroup?.editors.length ?? 0,
    getActiveGroupEditorUris: () =>
      (services.editorGroupsService.activeGroup?.editors ?? [])
        .map((e) => e.resource?.toString())
        .filter((u): u is string => u !== undefined),
    getEditorGroupEditorUris: (groupId) =>
      (services.editorGroupsService.groups.find((g) => String(g.id) === groupId)?.editors ?? [])
        .map((e) => e.resource?.toString())
        .filter((u): u is string => u !== undefined),
    getActiveGroupEditorFlags: () => {
      const group = services.editorGroupsService.activeGroup
      return (group?.editors ?? []).map((e) => ({
        uri: e.resource?.toString(),
        sticky: group.isSticky(e),
        preview: group.previewEditor === e,
      }))
    },
    setActiveEditorCursor: (lineNumber: number, column: number) => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      if (!monaco) return false
      monaco.setPosition({ lineNumber, column })
      // Monaco 0.55's setPosition no longer reveals: a real user's "cursor on
      // line N" implies line N is visible (keyboard nav / go-to-line scrolls).
      // Mirror that so specs asserting viewport state see a truthful editor.
      monaco.revealPosition({ lineNumber, column })
      monaco.focus()
      return true
    },
    getActiveEditorCursor: () => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      const position = monaco?.getPosition()
      if (!position) return undefined
      return { lineNumber: position.lineNumber, column: position.column }
    },
    getActiveEditorSelectionCount: () => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      return monaco?.getSelections()?.length
    },
    getActiveEditorFirstVisibleLine: () => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      return monaco?.getVisibleRanges()[0]?.startLineNumber
    },
    getActiveEditorLastVisibleLine: () => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      const ranges = monaco?.getVisibleRanges()
      return ranges && ranges.length > 0 ? ranges[ranges.length - 1]?.endLineNumber : undefined
    },
    getActiveEditorText: () => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      return monaco?.getModel()?.getValue()
    },
    isActiveEditorDirty: () => services.editorGroupsService.activeGroup?.activeEditor?.isDirty,
    // 只走一趟模型、不持有副本：调用方比的是两个数，而不是把上兆的正文搬过桥。
    getActiveEditorTextDigest: () => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      const model = monaco?.getModel()
      if (!model) return undefined
      const text = model.getValue()
      return { length: text.length, hash: fnv1a(text) }
    },
    setActiveEditorText: (text: string) => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
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
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      if (!monaco) return false
      monaco.setSelection({ startLineNumber, startColumn, endLineNumber, endColumn })
      monaco.focus()
      return true
    },
    getActiveEditorSelection: () => {
      const monaco = getActiveTextEditor(services.editorGroupsService)?.editor
      const selection = monaco?.getSelection()
      if (!selection) return undefined
      return {
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn,
      }
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
    getActiveDiffEditable: () => {
      const active = services.editorGroupsService.activeGroup?.activeEditor
      if (!(active instanceof DiffEditorInput)) return undefined
      return { editable: active.modifiedEditable, dirty: active.isDirty }
    },
    setActiveDiffModifiedText: (text: string) => {
      const group = services.editorGroupsService.activeGroup
      const active = group?.activeEditor
      if (!(active instanceof DiffEditorInput) || !active.modifiedEditable) return false
      const model = DiffEditorRegistry.get(active, group?.id)?.getModel()?.modified
      if (!model) return false
      model.setValue(text)
      return true
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
    getDirtyDiffDecorationSummary: async (
      uri: string,
    ): Promise<readonly E2EDirtyDiffDecoration[]> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const out: E2EDirtyDiffDecoration[] = []
      for (const d of model.getAllDecorations()) {
        const className = d.options.linesDecorationsClassName
        if (typeof className !== 'string') continue
        const kind = /\bdirty-diff-gutter-(added|modified|deleted)\b/.exec(className)?.[1] as
          | E2EDirtyDiffDecoration['kind']
          | undefined
        if (kind === undefined) continue
        const overviewRuler = d.options.overviewRuler
        const minimap = d.options.minimap
        out.push({
          kind,
          startLineNumber: d.range.startLineNumber,
          endLineNumber: d.range.endLineNumber,
          hasOverviewRuler: overviewRuler != null,
          ...(typeof overviewRuler?.color === 'string'
            ? { overviewRulerColor: overviewRuler.color }
            : {}),
          hasMinimap: minimap != null,
          ...(typeof minimap?.color === 'string' ? { minimapColor: minimap.color } : {}),
        })
      }
      return out
    },
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
    reloadActiveAcpSession: async () => {
      const session = services.acpSessionService.activeSession.get()
      const durableId = session?.sessionIdOnAgent.get()
      if (!session || !durableId) throw new Error('[E2E] no durable active ACP session')
      await services.acpSessionService.closeSession(session.id)
      const resumed = await services.acpSessionService.resumeSession(durableId)
      return resumed.id
    },
    getActiveAcpSessionImageSupported: () =>
      services.acpSessionService.activeSession.get()?.imageSupported.get() === true,
    sendAcpPrompt: async (text) => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) throw new Error('[E2E] no active ACP session')
      await s.sendPrompt(text)
    },
    addActiveSelectionToAcpPrompt: async () => {
      await services.commandService.executeCommand(
        'workbench.action.agent.addSelectionToExistingChat',
      )
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
    getAcpVisiblePromptText: () => {
      const host = document.querySelector('[data-testid="acp-prompt-drop-host"]')
      // Monaco renders whitespace as &nbsp; in the view DOM — normalize back.
      const visible = host?.querySelector('.view-lines')?.textContent ?? ''
      return visible.replace(/\u00a0/g, ' ')
    },
    getAcpMessages: () => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) return []
      return s.messages.get().map((m) => ({
        role: m.role,
        text: m.text,
        streaming: m.streaming,
        ...(m.selectionContexts !== undefined && m.selectionContexts.length > 0
          ? {
              selectionLabels: m.selectionContexts.map(
                (selection) =>
                  `${selection.relPath}:${selection.startLine === selection.endLine ? selection.startLine : `${selection.startLine}-${selection.endLine}`}`,
              ),
            }
          : {}),
      }))
    },
    getAcpToolCalls: () => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) return []
      // Children hang off the timeline slot, not the lane entry `toolCalls` returns —
      // a sub-agent message is not a top-level call and never appears there.
      const childrenByParent = new Map<
        string,
        NonNullable<ReturnType<E2EProbe['getAcpToolCalls']>[number]['children']>
      >()
      for (const item of s.timeline.get()) {
        if (item.kind !== 'toolCall' || item.call.children === undefined) continue
        childrenByParent.set(
          item.id,
          item.call.children.map((child) =>
            child.kind === 'message'
              ? {
                  id: child.id,
                  kind: 'message',
                  role: child.message.role,
                  textLength: child.message.text.length,
                  live: child.message.live === true,
                  streaming: child.message.streaming,
                }
              : { id: child.id, kind: 'toolCall', textLength: child.call.text.length },
          ),
        )
      }
      return s.toolCalls.get().map((t) => {
        const children = childrenByParent.get(t.id)
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          text: t.text,
          ...(t.mcpServer !== undefined && { mcpServer: t.mcpServer }),
          // Per-card, not per-session: `children` is documented as present only on
          // cards that have them, and a session-wide guard would hand `[]` to every
          // card the moment one sub-agent existed.
          ...(children !== undefined && { children }),
        }
      })
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
    getContributedMcpServers: (): readonly E2EContributedMcpServer[] =>
      Object.entries(services.extensionMcpServersService.rawRecord).map(([name, entry]) => {
        const command =
          entry !== null && typeof entry === 'object' && 'command' in entry
            ? String((entry as { command: unknown }).command ?? '')
            : ''
        return { name, command }
      }),
    setAcpSessionMcpServers: (names) => {
      const s = services.acpSessionService.activeSession.get()
      if (!s) throw new Error('[E2E] no active ACP session')
      services.acpSessionService.setSessionMcpServers(s.id, names)
    },
    setAcpMcpServerEnabled: async (name, enabled) => {
      await services.mcpServerEnablementService.whenReady
      await services.mcpServerEnablementService.setEnabled(name, enabled, StorageScope.GLOBAL)
    },
    getAcpSessionStatus: () => services.acpSessionService.activeSession.get()?.status.get(),
    getActiveAcpSessionAuthority: () => {
      const s = services.acpSessionService.activeSession.get()
      const durableId = s?.sessionIdOnAgent.get()
      if (!durableId) return undefined
      return services.acpSessionHistoryService.get(durableId)?.authority
    },
    getAcpSessionCreateProfiles: () => services.acpSessionService.getSessionCreateProfiles(),
    getAcpPendingElicitation: () => {
      const s = services.acpSessionService.activeSession.get()
      const e = s?.pendingElicitation.get()
      if (!e) return undefined
      const req = e.request
      // The custom-mode variant's index signature types these as unknown —
      // guard before exposing them to the spec.
      const mode = 'mode' in req && typeof req.mode === 'string' ? req.mode : 'form'
      const message = 'message' in req && typeof req.message === 'string' ? req.message : ''
      const schema = 'requestedSchema' in req ? req.requestedSchema : undefined
      const props =
        schema !== null && typeof schema === 'object'
          ? (schema as { properties?: Record<string, unknown> }).properties
          : undefined
      return { mode, message, fields: props ? Object.keys(props) : [] }
    },
    resolveAcpElicitation: (content) => {
      const s = services.acpSessionService.activeSession.get()
      const e = s?.pendingElicitation.get()
      if (!e) throw new Error('[E2E] no pending ACP elicitation')
      e.resolve({ action: 'accept', content })
    },
    cancelAcpElicitation: () => {
      const s = services.acpSessionService.activeSession.get()
      s?.pendingElicitation.get()?.cancel()
    },
    getActiveOutputChannelName: () => services.outputService.activeChannelName.get(),
    getOutputChannelNames: () => services.outputService.channelNames.get(),
    createOutputChannel: (name: string) => {
      services.outputService.createChannel(name)
    },
    appendToOutputChannel: (name: string, text: string) => {
      const channel =
        services.outputService.getChannel(name) ?? services.outputService.createChannel(name)
      channel.append(text)
    },
    getOutputChannelContent: (name: string) =>
      services.outputService.getChannel(name)?.getText() ?? '',
    setActiveOutputChannel: (name: string) => {
      services.outputService.setActiveChannel(name)
    },
    setOutputHiddenLevels: (levels: readonly number[]) => {
      const wanted = new Set<number>(levels)
      for (const level of ALL_LOG_LEVELS) {
        services.outputModelService.setLevelHidden(level, wanted.has(level))
      }
    },
    getOutputHiddenLevels: () => [...services.outputModelService.hiddenLevels.get()],
    setOutputFilterText: (text: string) => {
      services.outputModelService.setFilterText(text)
    },
    getOutputHiddenRanges: () => {
      const name = services.outputService.activeChannelName.get()
      if (name === undefined) return []
      return services.outputModelService
        .getHiddenRanges(name)
        .map((r) => ({ startLine: r.startLine, endLineExclusive: r.endLineExclusive }))
    },
    getVisibleOutputLines: (): readonly string[] => {
      const model = findOutputEditor()?.getModel()
      const isVisible = outputLineVisibility()
      if (!model || !isVisible) return []
      const visible: string[] = []
      for (let line = 1; line <= model.getLineCount(); line++) {
        if (isVisible(line)) visible.push(model.getLineContent(line))
      }
      return visible
    },
    getOutputFindState: () => readFindState(findOutputEditor()),
    getFileEditorFindState: () => readFindState(findFileEditor(services.editorGroupsService)),
    focusOutputView: () => {
      revealOutputPanel(services.layoutService, services.viewsService)
    },
    logToChannel: (channelId, channelName, level, message) => {
      const logger = services.loggerService.createLogger({ id: channelId, name: channelName })
      if (level === 'trace') logger.trace(message)
      else if (level === 'debug') logger.debug(message)
      else if (level === 'info') logger.info(message)
      else if (level === 'warn') logger.warn(message)
      else logger.error(message)
    },
    terminalCreate: async (): Promise<string> => {
      const info = await services.terminalService.create({})
      if (!terminalBuffers.has(info.id)) terminalBuffers.set(info.id, '')
      return info.id
    },
    terminalCreateInWorkspace: async (): Promise<string | null> => {
      const id = await services.terminalManagerService.newTerminal()
      if (id !== null) terminalBuffers.set(id, '')
      return id
    },
    terminalInput: (id: string, data: string): Promise<void> =>
      services.terminalService.input(id, data),
    terminalClose: (id: string): Promise<void> => {
      services.terminalManagerService.closeTerminal(id)
      return Promise.resolve()
    },
    terminalReadBuffer: (id: string): string => terminalBuffers.get(id) ?? '',
    terminalProvideLinks: (id: string, row: number): Promise<readonly E2ETerminalLink[]> => {
      const holder = services.terminalXtermService.get(id)
      if (!holder) return Promise.resolve([])
      return new Promise((resolve) => {
        // provideLinks is callback-style and may answer synchronously; the
        // promise wrapper just normalizes both shapes for the spec.
        holder.provideLinks(row, (links) => {
          resolve(
            (links ?? []).map((l) => ({
              text: l.text,
              startX: l.range.start.x,
              startY: l.range.start.y,
              endX: l.range.end.x,
              endY: l.range.end.y,
            })),
          )
        })
      })
    },
    terminalFindRow: (id: string, needle: string): number => {
      const buf = services.terminalXtermService.get(id)?.term.buffer.active
      if (!buf) return -1
      for (let y = buf.length - 1; y >= 0; y--) {
        if (buf.getLine(y)?.translateToString(true).includes(needle)) return y + 1
      }
      return -1
    },
    terminalRowText: (id: string, row: number): string => {
      const buf = services.terminalXtermService.get(id)?.term.buffer.active
      return buf?.getLine(row - 1)?.translateToString(true) ?? ''
    },
    terminalProfiles: async (): Promise<readonly string[]> => {
      await services.terminalManagerService.refreshProfiles()
      return services.terminalManagerService.profiles.get()?.map((p) => p.profileName) ?? []
    },
    getPanelTerminalCount: (): number =>
      services.terminalManagerService.panelTerminals.get().length,
    getPanelTerminalNames: (): readonly string[] =>
      services.terminalManagerService.panelTerminals.get().map((t) => t.name),
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
    // (case-insensitive, separator-agnostic). Lets specs assert which changelist
    // group a file landed in after a drag-and-drop move.
    getScmGroupIdsForResource: (suffix: string): readonly string[] => {
      const needle = normalizeScmPath(suffix)
      const out: string[] = []
      for (const sc of services.scmService.sourceControls.get()) {
        for (const g of sc.groups.get()) {
          const hit = g.resources
            .get()
            .some((r) => normalizeScmPath(r.resourceUri).endsWith(needle))
          if (hit) out.push(g.id)
        }
      }
      return out
    },
    // Cached git-ignored answer for a resource, exactly as the Explorer rows and
    // editor tabs read it when deciding to dim a label. undefined while the batch
    // check-ignore is still in flight, so specs poll until it settles.
    isResourceGitIgnored: (uri: string): boolean | undefined =>
      services.scmIgnoredResourcesService.isIgnored(URI.parse(uri)),
    getScmDecorationForResource: (suffix: string): E2EScmDecoration | null => {
      const needle = normalizeScmPath(suffix)
      const { files, supplementary } = services.scmDecorationsService.decorations.get()
      // Both maps are keyed by the same SCM path key, so the same suffix match
      // finds the file in either. A file can sit in both (locally changed AND
      // behind), so merge them into one record — the spec gets everything at
      // once and can still tell "letter without grey text" apart.
      const fileKey = [...files.keys()].find((k) => k.endsWith(needle))
      const suppKey = [...supplementary.keys()].find((k) => k.endsWith(needle))
      if (fileKey === undefined && suppKey === undefined) return null
      const deco = fileKey !== undefined ? files.get(fileKey) : undefined
      const supp = suppKey !== undefined ? supplementary.get(suppKey) : undefined
      // The two tooltips stay separate because the row shows BOTH (ExplorerTreeNode
      // joins them with ' • '). Folding them with ?? would let a group tooltip hide
      // the supplementary one, which is exactly the overlap a spec needs to assert.
      return {
        ...(deco?.letter !== undefined ? { letter: deco.letter } : {}),
        ...(supp !== undefined ? { description: supp.description } : {}),
        ...(deco?.tooltip !== undefined ? { tooltip: deco.tooltip } : {}),
        ...(supp?.tooltip !== undefined ? { descriptionTooltip: supp.tooltip } : {}),
        ...(deco?.color !== undefined ? { color: deco.color } : {}),
      }
    },
    getScmWorkingTreeHintForResource: async (
      suffix: string,
    ): Promise<E2EWorkingTreeHint | null> => {
      const resource = await findWorkspaceResourceEndingWith(suffix)
      if (resource === undefined) return null
      const hint = services.scmWorkingTreeHintService.getHint(resource)
      if (hint === undefined) return null
      return {
        color: hint.color,
        letter: hint.letter,
        ...(hint.tooltip !== undefined ? { tooltip: hint.tooltip } : {}),
        ...(hint.strikeThrough ? { strikeThrough: true } : {}),
      }
    },
    installVsixExtension: async (vsixPath: string, authority?: string): Promise<string> => {
      const local = await services.extensionManagementService.installVSIX(vsixPath, authority)
      return local.identifier
    },
    installGalleryExtension: async (identifier: string): Promise<string> => {
      const [gallery] = await services.extensionGalleryService.getExtensions([identifier])
      if (!gallery) throw new Error(`marketplace has no extension ${identifier}`)
      const local = await services.extensionManagementService.installFromGallery(gallery)
      return local.identifier
    },
    uninstallExtension: (identifier: string, authority?: string): Promise<void> =>
      services.extensionManagementService.uninstall(identifier, authority),
    getInstalledExtensionIds: async (authority?: string): Promise<readonly string[]> => {
      const list = await services.extensionManagementService.getInstalled(authority)
      return list.map((e) => e.identifier)
    },
    getInstalledExtensionVersions: async (): Promise<readonly E2EInstalledExtension[]> => {
      const list = await services.extensionManagementService.getInstalled()
      return list.map((e) => ({ identifier: e.identifier, version: e.version }))
    },
    checkForExtensionUpdates: async (): Promise<readonly E2EExtensionUpdate[]> => {
      const updates = await services.extensionManagementService.checkForUpdates()
      return updates.map((u) => ({
        identifier: u.identifier,
        fromVersion: u.fromVersion,
        toVersion: u.toVersion,
      }))
    },
    getBuiltinExtensionIds: async (): Promise<readonly string[]> => {
      const list = await services.extensionManagementService.listBuiltinExtensions()
      return list.map((e) => e.identifier)
    },
    getDevExtensionIds: async (): Promise<readonly string[]> => {
      const contributions = await services.extensionHostClientService.getContributions()
      return contributions.filter((c) => c.extensionIsUnderDevelopment === true).map((c) => c.id)
    },
    getExtensionHostGeneration: (): number => extensionHostGeneration,
    getExtHostUnhandledRejections: (): string[] => [
      ...services.extensionHostClientService.getUnhandledRejections(),
    ],
    getDisabledExtensionIds: (): Promise<readonly string[]> =>
      services.extensionEnablementService.getEffectiveDisabledIds(),
    getVersionIncompatibleExtensionIds: async (): Promise<readonly string[]> => {
      const all = [
        ...(await services.extensionManagementService.getInstalled()),
        ...(await services.extensionManagementService.listBuiltinExtensions()),
        ...(await services.extensionManagementService.listDevExtensions()),
      ]
      return all.filter((e) => e.isVersionCompatible === false).map((e) => e.identifier)
    },
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
        const symbols = (await provider.provideWorkspaceSymbols(query, NONE_PLATFORM_TOKEN)) ?? []
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
    getDefinition: async (uri, lineNumber, column) => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const provider = services.languageFeaturesService.getDefinitionProviders(
        model.getLanguageId(),
      )[0]
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
    getHover: async (uri, lineNumber, column) => {
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
      return markers.map(toE2EMarker)
    },
    getMarkers: async (uri: string, owner?: string) => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const markers = monacoNs.editor.getModelMarkers({
        ...(owner !== undefined ? { owner } : {}),
        resource: monacoNs.Uri.parse(uri),
      })
      return markers.map(toE2EMarker)
    },
    getCodeActions: async (
      uri: string,
      range: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      },
    ): Promise<readonly E2ECodeAction[]> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      const features = await MonacoLoader.getLanguageFeaturesService()
      const out: E2ECodeAction[] = []
      for (const provider of features.codeActionProvider.ordered(model)) {
        const list = await provider.provideCodeActions(
          model,
          new monacoNs.Range(
            range.startLineNumber,
            range.startColumn,
            range.endLineNumber,
            range.endColumn,
          ),
          { markers: [], trigger: monacoNs.languages.CodeActionTriggerType.Invoke },
          NONE_TOKEN,
        )
        for (const action of list?.actions ?? []) {
          out.push({
            title: action.title,
            ...(action.kind !== undefined && { kind: action.kind }),
            hasEdit: action.edit !== undefined,
          })
        }
      }
      return out
    },
    getEditorDecorations: async (uri: string): Promise<readonly E2EEditorDecoration[]> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      return model.getAllDecorations().map((d) => {
        const hover = d.options.hoverMessage
        const hoverParts = Array.isArray(hover) ? hover : hover ? [hover] : []
        const description =
          hoverParts.length > 0 ? hoverParts.map((h) => h.value).join('\n') : undefined
        return {
          startLineNumber: d.range.startLineNumber,
          startColumn: d.range.startColumn,
          endLineNumber: d.range.endLineNumber,
          endColumn: d.range.endColumn,
          ...(d.options.className != null && { className: d.options.className }),
          ...(description !== undefined && { description }),
        }
      })
    },
    getMarkdownLineTokens: async (
      uri: string,
      lineNumber: number,
    ): Promise<ReadonlyArray<readonly [number, string]>> => {
      const monacoNs = await MonacoLoader.ensureInitialized()
      const model = monacoNs.editor.getModel(monacoNs.Uri.parse(uri))
      if (!model) return []
      // colorize forces the lazy tokens-provider factory to resolve. We can't use
      // `editor.tokenize`: it calls the legacy `support.tokenize`, which the
      // TextMate support (encoded-only, like VSCode's) does not implement — and
      // VSCode's own standalone API has the same gap. Drive `tokenizeEncoded`
      // over the whole document so multi-line frontmatter state carries into the
      // requested line, then decode the standard token types.
      await monacoNs.editor.colorize('', 'markdown', {})
      const [{ TokenizationRegistry }, { TokenMetadata }] = await Promise.all([
        import('monaco-editor/esm/vs/editor/common/languages.js'),
        import('monaco-editor/esm/vs/editor/common/encodedTokenAttributes.js'),
      ])
      const support = await TokenizationRegistry.getOrCreate('markdown')
      if (!support) return []
      let state = support.getInitialState()
      for (let lineNo = 1; lineNo <= model.getLineCount(); lineNo++) {
        const result = support.tokenizeEncoded(model.getLineContent(lineNo), true, state)
        state = result.endState
        if (lineNo === lineNumber) {
          const tokens: Array<readonly [number, string]> = []
          const entries = result.tokens
          for (let i = 0, len = entries.length >>> 1; i < len; i++) {
            const metadata = entries[(i << 1) + 1]!
            tokens.push([
              entries[i << 1]! + 1,
              TokenMetadata.getClassNameFromMetadata(metadata),
            ] as const)
          }
          return tokens
        }
      }
      return []
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
    getSemanticTokenStyleDebug: async (
      type: string,
      modifiers: string[],
      language: string,
    ): Promise<E2ESemanticTokenStyleDebug> => {
      const colorTheme = services.themeService.getColorThemeData()
      const metadata = colorTheme.getTokenStyleMetadata(type, modifiers, language)
      let style: E2ESemanticTokenStyleDebug['style']
      if (metadata) {
        style = {
          ...(metadata.foreground !== undefined
            ? { foreground: colorTheme.tokenColorMap[metadata.foreground] }
            : {}),
          ...(metadata.bold !== undefined ? { bold: metadata.bold } : {}),
          ...(metadata.italic !== undefined ? { italic: metadata.italic } : {}),
          ...(metadata.underline !== undefined ? { underline: metadata.underline } : {}),
          ...(metadata.strikethrough !== undefined
            ? { strikethrough: metadata.strikethrough }
            : {}),
        }
      }

      // The flag Monaco's SemanticTokensProviderStyling actually reads — resolved
      // by the semantic theme bridge from editor.semanticHighlighting.enabled.
      // Returns null until the semantic clone is the active theme (the bridge
      // injects it into _knownThemes[name]; getColorTheme() === that entry is
      // the check), which is exactly what the themes spec polls for.
      let semanticHighlighting: boolean | null = null
      try {
        const { StandaloneServices } =
          await import('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js')
        const { IStandaloneThemeService } =
          await import('monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js')
        const { toMonacoThemeName } = await import('../services/themes/monacoThemeAdapter.js')
        const themeService = StandaloneServices.get<{
          _knownThemes: Map<string, { semanticHighlighting?: unknown }>
          getColorTheme: () => { semanticHighlighting?: unknown }
        }>(IStandaloneThemeService)
        const injected = themeService._knownThemes.get(toMonacoThemeName(colorTheme.settingsId))
        if (injected && themeService.getColorTheme() === injected) {
          const flag = injected.semanticHighlighting
          semanticHighlighting = typeof flag === 'boolean' ? flag : null
        }
      } catch {
        semanticHighlighting = null
      }

      return { ...(style ? { style } : {}), semanticHighlighting }
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
      // Monaco's CodeLens controller cancels the previous in-flight getModel()
      // promise (via a RunOnceScheduler) every time it recomputes lenses on a
      // model/viewport/focus change. On slow CI cold starts (tsserver spin-up)
      // that recompute races this probe and rejects our await with `Canceled`.
      // Swallow it and report "not ready yet" so the caller's poll retries,
      // instead of letting the rejection abort the poll.
      let model: Awaited<ReturnType<NonNullable<typeof controller.getModel>>> | undefined
      try {
        model = await controller.getModel()
      } catch {
        return []
      }
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
    getMarkdownCompletions: (uri: string, lineNumber: number, column: number) =>
      getCompletionLabels(uri, lineNumber, column),
    getCompletions: (uri: string, lineNumber: number, column: number) =>
      getCompletionLabels(uri, lineNumber, column),
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
    startOutlineRetentionProbe,
    stopOutlineRetentionProbe,
    getOutlineRetentionStats,
    armGcControl: (): void => {
      // 只在这里分配、函数返回后除了下面的 WeakRef 再无引用：强制回收要么收走它，
      // 要么这一轮回收未能被证明有效。
      const control = {
        marker: 'e2e-gc-control',
        payload: Array.from({ length: 64 }, (_, i) => ({ i })),
      }
      gcControl = new WeakRef(control)
    },
    getGcControlState: (): E2EGcControlState => {
      if (!gcControl) return 'unarmed'
      return gcControl.deref() === undefined ? 'collected' : 'alive'
    },
    resolveKeybinding: (key: string): { kind: string; command?: string } => {
      const r = KeybindingsRegistry.resolveKeystroke(key)
      return r.kind === 'execute' ? { kind: r.kind, command: r.command } : { kind: r.kind }
    },
    hasCommand: (id: string): boolean => CommandsRegistry.getCommand(id) !== undefined,
    getKeybindingCommandsForKey: (key: string): string[] => {
      const normalized = normalizeKeybindingString(key)
      return KeybindingsRegistry.getAllKeybindings()
        .filter((kb) => {
          const first = kb.chords ? kb.chords[0] : kb.key
          return (
            first !== undefined && normalizeKeybindingString(first) === normalized && !kb.isNegated
          )
        })
        .map((kb) => kb.command)
    },
    getAllKeybindings: (): readonly E2EKeybindingEntry[] =>
      KeybindingsRegistry.getAllKeybindings().flatMap((kb): E2EKeybindingEntry[] => {
        const when = serializeWhen(kb.when)
        const base = {
          command: kb.command,
          weight: kb.weight ?? KeybindingWeight.WorkbenchContrib,
          isNegated: kb.isNegated ?? false,
          ...(when !== undefined ? { when } : {}),
        }
        if (kb.chords) {
          const chords: [string, string] = [
            normalizeKeybindingString(kb.chords[0]),
            normalizeKeybindingString(kb.chords[1]),
          ]
          return [{ ...base, key: chords[0], chords }]
        }
        if (kb.key === undefined) return []
        return [{ ...base, key: normalizeKeybindingString(kb.key) }]
      }),
    traceKeybinding: (key: string, pending?: readonly string[]): E2EKeybindingTrace => {
      const trace = KeybindingsRegistry.traceKeystroke(key, services.contextKeyService, pending)
      const candidates = trace.candidates.map((c) => ({
        command: c.command,
        weight: c.weight,
        whenMatched: c.whenMatched,
        reason: c.outcomeReason,
        selected: c.selected,
        keys: c.whenKeys.map((k) => ({ key: k.key, value: k.value })),
        ...(c.when !== undefined ? { when: c.when } : {}),
      }))
      // The trace's `execute` variant carries no weight, but exactly one candidate
      // is flagged `selected` — that is the winner whose weight decides whether
      // the dispatcher defers to monaco (MonacoDefault) or preventDefaults.
      const winnerWeight = candidates.find((c) => c.selected)?.weight
      if (trace.kind === 'execute') {
        return {
          kind: 'execute',
          command: trace.command,
          candidates,
          ...(winnerWeight !== undefined ? { weight: winnerWeight } : {}),
        }
      }
      return { kind: trace.kind, candidates }
    },
    getUserKeybindingDebug: () => ({
      userEntries: services.userKeybindingsService.userEntries.map((e) => ({
        key: e.key,
        command: e.command,
        ...(e.when !== undefined ? { when: e.when } : {}),
      })),
      vscodeParsedCount: services.userKeybindingsService.diagnostics.vscodeParsedCount,
      vscodeRegisteredCount: services.userKeybindingsService.diagnostics.vscodeRegisteredCount,
    }),
    getUserKeybindingEntries: (command: string) =>
      services.userKeybindingsService.getUserEntries(command).map((e) => ({
        key: e.key,
        command: e.command,
        ...(e.when !== undefined ? { when: e.when } : {}),
      })),
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
    isWorkspaceWatchArmed: (): boolean => services.explorerTreeService.watchArmed,
    getViewContainerByViewId: (viewId: string) =>
      services.viewDescriptorService.getViewContainerByViewId(viewId)?.id,
    getActiveViewContainerId: (location: number) =>
      services.viewsService.getActiveViewContainerId(location),
    getViewIdsByContainer: (containerId: string) =>
      services.viewDescriptorService.getViewsByContainer(containerId).map((v) => v.id),
    getTreeItems: async (viewId: string): Promise<readonly E2ETreeItem[]> => {
      await services.treeViewsService.loadChildren(viewId)
      const roots = services.treeViewsService.getRoots(viewId)
      if (!roots) return []
      return roots.map((item) => ({
        label: item.label,
        collapsibleState: item.collapsibleState,
      }))
    },
    getTimelineItems: async (uri: string): Promise<readonly E2ETimelineItem[]> => {
      const resource = URI.parse(uri)
      const out: E2ETimelineItem[] = []
      for (const provider of services.timelineService.getProvidersForUri(resource)) {
        const dto = await services.timelineService.getTimeline(provider.handle, resource, {
          resetCache: true,
        })
        for (const item of dto?.items ?? []) {
          out.push({
            label: item.label,
            timestamp: item.timestamp,
            ...(item.contextValue !== undefined && { contextValue: item.contextValue }),
          })
        }
      }
      return out
    },
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
    getViewSize: (viewId: string) => services.viewDescriptorService.getViewState(viewId).size,
    getPersistedViewSize: (viewId: string) =>
      services.viewDescriptorService.getPersistedViewSize(viewId),
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
    startBugRecording: async (): Promise<E2EBugRecordingStatus> => {
      const folder = services.workspaceService.current?.folder.toString()
      return await services.bugRecorderClient.startRecording(
        folder !== undefined ? { workspaceFolders: [folder] } : {},
      )
    },
    // Bypasses the redaction dialog on purpose: the spec asserts both branches
    // of the export, and the dialog itself is covered by unit tests.
    stopBugRecording: (redact: boolean): Promise<E2EBugRecordingResult> => {
      const transcripts = collectTranscripts(services.acpSessionHistoryService)
      return services.bugRecorderClient.stopRecording({
        redact,
        ...(transcripts.length > 0 ? { transcripts } : {}),
      })
    },
    markBugRecordingStep: () => services.bugRecorderClient.markStep(),
    getBugRecordingStatus: (): E2EBugRecordingStatus => services.bugRecorderClient.status.get(),
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
    aiSetProviders: (entries) =>
      services.aiModelService.updateProviders(entries as unknown as readonly AiProviderEntry[]),
    aiSetModelKnowledge: (entries) =>
      // The DTO types capabilities as a loose record and nativeProtocol as a
      // bare string; the persisted shape is AiModelKnowledge per key.
      services.aiModelService.updateModelKnowledge(
        entries as unknown as Readonly<Record<string, AiModelKnowledge>>,
      ),
    aiGetModels: async () => {
      const models = await services.aiModelService.getModels()
      return models.map((m) => ({
        id: m.id,
        providerId: m.providerId,
        protocol: m.protocol,
        channelModel: m.channelModel,
        ...(m.vendor !== undefined ? { vendor: m.vendor } : {}),
        name: m.name,
        family: m.family,
        maxInputTokens: m.maxInputTokens,
        maxOutputTokens: m.maxOutputTokens,
        ...(m.pricing !== undefined
          ? {
              pricing: {
                input: m.pricing.input,
                output: m.pricing.output,
                ...(m.pricing.currency !== undefined ? { currency: m.pricing.currency } : {}),
              },
            }
          : {}),
        ...(m.pricingOrigin !== undefined ? { pricingOrigin: m.pricingOrigin } : {}),
      }))
    },
    aiGetProviderIssues: async () => {
      const issues = await services.aiModelService.getProviderIssues()
      return issues.map((i) => ({
        providerId: i.providerId,
        reason: i.reason,
        fatal: i.fatal,
        ...(i.detail !== undefined ? { detail: i.detail } : {}),
      }))
    },
    aiSetModelConfiguration: (modelId, config) =>
      services.aiModelService.setModelConfiguration(modelId, config),
    aiGetModelConfiguration: (modelId) => services.aiModelService.getModelConfiguration(modelId),
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
    getInteractionPerfSummary: () => {
      const s = services.interactionPerfService.getSummary()
      return {
        startedAt: s.startedAt,
        totalSampleCount: s.totalSampleCount,
        interactionCount: s.interactionCount,
        slowCount: s.slowCount,
        byType: s.byType,
        loafCount: s.loafCount,
        slowest: s.slowest.map((entry) => ({
          label: entry.label,
          durationMs: entry.durationMs,
          startTime: entry.startTime,
          eventTypes: entry.report.eventTypes,
          decomposition: entry.report.decomposition,
          phases: entry.report.phases,
          loafs: entry.report.loafs,
          context: entry.report.context,
        })),
      }
    },
    // The renderer's own heap is normally invisible from outside, and the whole point of
    // the watermark is to notice it before V8 aborts. A spec that only asserted the
    // service exists would prove nothing: `performance.memory` being readable inside a
    // real Electron renderer is an assumption worth failing a test over.
    getMemoryPressure: async (forceLevel) => {
      const service = services.memoryPressureService
      const forced =
        forceLevel === 'elevated'
          ? MemoryPressureLevel.Elevated
          : forceLevel === 'critical'
            ? MemoryPressureLevel.Critical
            : undefined
      const release = forced === undefined ? [] : service.release(forced)
      const sample = readHeapSample()
      return {
        level: MEMORY_PRESSURE_LEVEL_NAMES[service.level.get()] ?? 'unknown',
        describe: service.describe(),
        releaserIds: service.releaserIds(),
        usedBytes: sample?.used ?? null,
        limitBytes: sample?.limit ?? null,
        release: release.map((entry) => ({
          id: entry.id,
          freed: entry.freed,
          ...(entry.error !== undefined ? { error: entry.error } : {}),
        })),
        releasedBytes: release.reduce((sum, entry) => sum + entry.freed, 0),
      }
    },
    getHeapFlowCounters: () => ({
      flow: readHeapFlowTotals(),
      gauge: readHeapGauges(),
      codeHtmlBytes: readCodeHtmlBytes(),
    }),
    // 瞬时量而非累计量：管道此刻还欠着 ack 的载荷。读的是管道自己写的模块（不读文档），
    // 所以拆掉的管道读作零，而不是停在最后一帧。
    getDocumentSyncStats: (): E2EDocumentSyncStats => DocumentSyncStats.read(),
    // Read-only view of main's round state. Starting a round stays the user's call (the
    // command + its consent dialog), so this exists purely so a spec can tell "armed and
    // waiting for a stable baseline" from "over, because the window reloaded".
    getHeapSnapshotStatus: async () => {
      const status = await services.diagnosticsService.getHeapSnapshotStatus()
      return {
        active: status.active,
        phase: status.phase,
        attempts: status.attempts,
        attemptLimit: status.attemptLimit,
        appAttempts: status.appAttempts,
        appAttemptLimit: status.appAttemptLimit,
        artifacts: status.artifacts,
        bytes: status.bytes,
        ...(status.code === undefined ? {} : { code: status.code }),
        ...(status.detail === undefined ? {} : { detail: status.detail }),
      }
    },
    driveSwarmNotificationPoll: async () => {
      await swarmNotificationE2E.driveRefresh?.()
    },
    // Replays readings through the reminder's own policy; the contribution drops live
    // readings for the rest of this renderer's life once a replay has happened, so the
    // spec's series is the whole timeline. `?.` because the seam is empty unless the
    // contribution is loaded.
    driveMemoryReminder: (samples: readonly E2EMemoryReminderSample[]): void => {
      memoryReminderE2E.drive?.(
        samples.map((sample) => ({
          afterMs: sample.afterMs,
          level:
            sample.level === 'normal'
              ? MemoryPressureLevel.Normal
              : sample.level === 'critical'
                ? MemoryPressureLevel.Critical
                : MemoryPressureLevel.Elevated,
          usedBytes: sample.usedBytes,
        })),
      )
    },
    getMemoryReminderDecisions: (): E2EMemoryReminderDecision[] =>
      // Copied out of the module-level seam: a spec must not be able to mutate what the
      // contribution records for the next assertion.
      memoryReminderE2E.decisions.map((decision) => ({
        remind: decision.remind,
        reason: decision.reason,
        ...(decision.sustainedMs === undefined ? {} : { sustainedMs: decision.sustainedMs }),
        ...(decision.used === undefined ? {} : { usedBytes: decision.used }),
      })),
    getMemoryReminderState: (): E2EMemoryReminderState => {
      const state = memoryReminderE2E.readState?.()
      return {
        sustainedSince: state?.sustainedSince ?? null,
        lastSampleAt: state?.lastSampleAt ?? null,
        reminded: state?.reminded ?? false,
        lastRemindedAt: state?.lastRemindedAt ?? null,
      }
    },
    getSwarmNotifiedReviewIds: () => swarmNotificationE2E.notified.map((ids) => [...ids]),
    getSwarmNotifyDiag: () => ({
      lastActionable: [...swarmNotificationE2E.lastActionable],
    }),
    readFileText: (uri) => services.fileService.readFileText(URI.parse(uri)),
    writeFileText: (uri, text) => services.fileService.writeFile(URI.parse(uri), text),
    statResource: async (uri) => {
      const resource = URI.parse(uri)
      if (!(await services.fileService.exists(resource))) return null
      const stat = await services.fileService.stat(resource)
      return {
        resource: URI.revive(stat.resource)?.toString() ?? '',
        isFile: stat.isFile,
        isDirectory: stat.isDirectory,
        size: stat.size,
      }
    },
    listResource: async (uri) =>
      (await services.fileService.list(URI.parse(uri))).map((e) => e.name),
    deleteResource: (uri) => services.fileService.delete(URI.parse(uri)),
    searchTextInRoot: async (root, pattern) => {
      const complete = await services.textSearchMainService.search({
        pattern,
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
        sessionId: `e2e-${Date.now().toString(36)}-${++remoteSearchSeq}`,
        root: URI.parse(root).toJSON(),
        configurationExcludes: [],
      })
      return complete.results.map((m) => URI.revive(m.resource)?.toString() ?? '')
    },
    watchFolder: async (uri) => {
      watchedChangeEvents.length = 0
      await services.fileWatcherService.watch(URI.parse(uri))
    },
    getWatchedChangeEvents: () => watchedChangeEvents.map((e) => ({ ...e })),
    getRemoteConnections: async () => {
      const list = await services.remoteStatusService.getConnections()
      return list.map((c) => ({
        authority: c.authority,
        state: c.state,
        ...(c.errorMessage !== undefined ? { errorMessage: c.errorMessage } : {}),
      }))
    },
    dropRemoteSocket: (authority) => services.remoteStatusService.dropSocketForTesting(authority),
    dropRemoteExtensionHostSocket: (authority) =>
      services.remoteStatusService.dropExtensionHostSocketForTesting(authority),
    openWorkspaceUri: (uri) => services.workspaceService.openFolder(URI.parse(uri)),
    openUri: (uri) => services.editorResolverService.openEditor(URI.parse(uri)),
    getCurrentWorkspaceUri: () => services.workspaceService.current?.folder.toString(),
    getRecentWorkspaceUris: () => services.workspaceService.recent.map((r) => r.folder.toString()),
    getWindowRemoteAuthority: async () => currentRemoteAuthority(services.workspaceService.current),
    readClipboardSnapshot: async () => {
      const snap = await services.fileClipboardService.readResources()
      return {
        resources: snap.resources.map((r) => ({
          resource: URI.revive(r.resource)?.toString() ?? '',
          isDirectory: r.isDirectory,
        })),
        isCut: snap.isCut,
        source: snap.source,
      }
    },
  }

  window[E2E_PROBE_KEY] = probe

  console.info('[E2E] probe installed')
  return ds
}
