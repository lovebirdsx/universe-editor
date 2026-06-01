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
  EditorInput,
  EditorRegistry,
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
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../services/editor/FileEditorRegistry.js'
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

export function installE2EProbeIfEnabled(services: E2EProbeServices): void {
  if (typeof window === 'undefined' || window[E2E_PROBE_ENABLED_KEY] !== true) return

  const probe: E2EProbe = {
    whenReady: () => services.lifecycleService.when(LifecyclePhase.Ready),
    whenRestored: () => services.lifecycleService.when(LifecyclePhase.Restored),
    getLifecyclePhase: () => phaseToName(services.lifecycleService.phase),
    getContextKey: (key) => services.contextKeyService.get(key),
    runCommand: (id, ...args) => services.commandService.executeCommand(id, ...args),
    getActiveEditorUri: () => services.editorService.activeEditorId.get(),
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
      EditorRegistry.registerEditorProvider({ typeId, componentKey: 'dummy' })
      services.editorResolverService.registerEditor(
        glob,
        { typeId, displayName: `Dummy (${typeId})`, priority: 100 },
        (uri) => new DummyEditorInput(uri, typeId),
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
    getStoredLeakReport: (): E2EDisposableLeakReport | null => {
      const raw = sessionStorage.getItem(DISPOSABLE_LEAK_REPORT_KEY)
      if (!raw) return null
      return JSON.parse(raw) as E2EDisposableLeakReport
    },
  }

  window[E2E_PROBE_KEY] = probe

  console.info('[E2E] probe installed')
}
