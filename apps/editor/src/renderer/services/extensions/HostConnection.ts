/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HostConnection — one renderer↔extension-host RPC connection. Wraps a single
 *  spawned host (identified by its opaque handle): the stdio framing protocol,
 *  the ChannelClient (calling the host's ExtHost* channels), the ChannelServer
 *  (hosting the renderer's MainThread* channels), and the per-connection channel
 *  wiring. ExtensionHostClientService owns one of these.
 *
 *  Every MainThread capability (commands/window/scm/languages/editor/ai/fs/
 *  output/storage/webview) is wired unconditionally: in the single-host model all
 *  local extensions share the same full API surface, gated at activation time by
 *  Workspace Trust rather than by connection.
 *--------------------------------------------------------------------------------------------*/

import {
  ChannelPair,
  Disposable,
  DisposableStore,
  Event,
  ProxyChannel,
  type ICommandService,
  type IDialogService,
  type IEditorGroupsService,
  type IEditorService,
  type IFileDialogService,
  type IFileSearchService,
  type IFileService,
  type IFileWatcherService,
  type IInstantiationService,
  type ILayoutService,
  type ILogger,
  type INotificationService,
  type IOpenerService,
  type IOutputChannel,
  type IOutputService,
  type IProgressService,
  type IQuickInputService,
  type IStatusBarService,
  type IStorageService,
  type IUriIdentityService,
  type IViewsService,
} from '@universe-editor/platform'
import {
  ExtHostChannels,
  StdioFramingProtocol,
  type IExtHostCommands,
  type IExtHostDocuments,
  type IExtHostEditor,
  type IExtHostExtensions,
  type IExtHostFileEvents,
  type IExtHostLanguages,
  type IExtHostScm,
  type IExtHostTimeline,
  type IExtHostWebviews,
  type IExtHostWindow,
  type IExtensionActivationErrorDto,
} from '@universe-editor/extensions-common'
import type {
  ExtHostKind,
  IExtensionHostService,
} from '../../../shared/ipc/extensionHostService.js'
import type { IAcpPathPolicy } from '../acp/acpPathPolicy.js'
import type { IExcludeService } from '../exclude/ExcludeService.js'
import { slowPhaseInstrument } from '../performance/perfPhases.js'
import { MainThreadCommands, type CommandOwnershipLedger } from './MainThreadCommands.js'
import { MainThreadAi } from './MainThreadAi.js'
import { MainThreadEditor } from './MainThreadEditor.js'
import { MainThreadExtensions } from './MainThreadExtensions.js'
import { MainThreadFileEvents } from './MainThreadFileEvents.js'
import { MainThreadFs } from './MainThreadFs.js'
import { MainThreadLanguages } from './MainThreadLanguages.js'
import { MainThreadOutput } from './MainThreadOutput.js'
import { MainThreadStorage } from './MainThreadStorage.js'
import { MainThreadWindow } from './MainThreadWindow.js'
import type { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import type { IScmService } from './ScmService.js'
import type { ITimelineService } from '../timeline/TimelineService.js'
import type { IWebviewService } from './WebviewService.js'
import type { IAiModelService } from '@universe-editor/platform'

export interface HostConnectionDeps {
  readonly host: IExtensionHostService
  readonly notification: INotificationService
  readonly quickInput: IQuickInputService
  readonly statusBar: IStatusBarService
  readonly dialog: IDialogService
  readonly files: IFileService
  /** Backs `workspace.findFiles` (live workspace enumeration). */
  readonly fileSearch: IFileSearchService
  /** Backs `workspace.findFiles` default excludes (files.exclude ∪ search.exclude). */
  readonly exclude: IExcludeService
  /** Backs `workspace.createFileSystemWatcher` (existing recursive workspace watch). */
  readonly fileWatcher: IFileWatcherService
  readonly pathPolicy: IAcpPathPolicy
  readonly commandService: ICommandService
  /** Backs `env.openExternal` (external URLs → OS browser, files → editor). */
  readonly opener: IOpenerService
  /** Backs `window.withProgress` (workbench progress UI). */
  readonly progress: IProgressService
  /** Backs `window.showOpenDialog` / `window.showSaveDialog`. */
  readonly fileDialogs: IFileDialogService
  /** Backs `window.showTextDocument` (open/reveal a text editor). */
  readonly editorGroups: IEditorGroupsService
  /** Creates FileEditorInput instances with their DI deps satisfied. */
  readonly instantiation: IInstantiationService
  readonly scm: IScmService
  readonly timeline: ITimelineService
  readonly languageFeatures: ILanguageFeaturesService
  readonly editorService: IEditorService
  /** Wired with editorService so MainThreadEditor can compare resources. */
  readonly uriIdentity: IUriIdentityService
  readonly aiModel: IAiModelService
  /** Persisted extension state. */
  readonly storage: IStorageService
  /** Custom-editor / webview model. */
  readonly webview: IWebviewService
  readonly output: IOutputService
  readonly layout: ILayoutService
  readonly views: IViewsService
  readonly stderr: IOutputChannel
  readonly logger: ILogger
  readonly ledger: CommandOwnershipLedger
  /** An extension's `activate` threw — surface it (notification + view badge). */
  readonly onActivationError: (error: IExtensionActivationErrorDto) => void
}

export class HostConnection extends Disposable {
  readonly commands: IExtHostCommands
  readonly extensions: IExtHostExtensions
  readonly languages: IExtHostLanguages
  readonly documents: IExtHostDocuments
  private _dead = false

  constructor(
    readonly kind: ExtHostKind,
    readonly handle: string,
    /** Workspace folder this host was pinned to at spawn (fsPath), if any. */
    readonly workspaceRoot: string | undefined,
    deps: HostConnectionDeps,
  ) {
    super()
    const store = this._register(new DisposableStore())

    store.add(
      deps.host.onStderr((chunk) => {
        if (chunk.handle === handle) deps.stderr.append(chunk.data)
      }),
    )

    const onData = Event.map(
      Event.filter(deps.host.onStdout, (c) => c.handle === handle),
      (c) => c.data,
    )
    const protocol = store.add(
      new StdioFramingProtocol({
        write: (frame) => {
          void deps.host.writeStdin(handle, frame).catch((err: unknown) => {
            deps.logger.warn(`writeStdin failed (${kind}): ${(err as Error).message}`)
          })
        },
        onData,
      }),
    )

    // Decode each frame ONCE and route by type: language-service responses for a
    // large file are multi-MB frames, and a second parse (client + server each
    // decoding everything) doubles the main-thread stall on every tab switch.
    // Slow decodes surface as an `extHost.rpcDecode` phase in the perf reports.
    const pair = store.add(new ChannelPair(protocol, slowPhaseInstrument('extHost.rpcDecode')))
    const { client, server } = pair

    this.commands = ProxyChannel.toService<IExtHostCommands>(
      client.getChannel(ExtHostChannels.extHostCommands),
    )
    this.extensions = ProxyChannel.toService<IExtHostExtensions>(
      client.getChannel(ExtHostChannels.extHostExtensions),
    )

    const mainThreadCommands = store.add(
      new MainThreadCommands(this.commands, deps.commandService, deps.ledger),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadCommands,
      ProxyChannel.fromService(mainThreadCommands),
    )

    const mainThreadExtensions = new MainThreadExtensions(deps.onActivationError)
    server.registerChannel(
      ExtHostChannels.mainThreadExtensions,
      ProxyChannel.fromService(mainThreadExtensions),
    )

    const extHostWindow = ProxyChannel.toService<IExtHostWindow>(
      client.getChannel(ExtHostChannels.extHostWindow),
    )
    const mainThreadWindow = store.add(
      new MainThreadWindow(
        deps.notification,
        deps.quickInput,
        deps.statusBar,
        deps.dialog,
        deps.opener,
        deps.progress,
        deps.fileDialogs,
        extHostWindow,
      ),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadWindow,
      ProxyChannel.fromService(mainThreadWindow),
    )

    deps.scm.setExtHost(
      ProxyChannel.toService<IExtHostScm>(client.getChannel(ExtHostChannels.extHostScm)),
    )
    server.registerChannel(ExtHostChannels.mainThreadScm, ProxyChannel.fromService(deps.scm))

    deps.timeline.setExtHost(
      ProxyChannel.toService<IExtHostTimeline>(client.getChannel(ExtHostChannels.extHostTimeline)),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadTimeline,
      ProxyChannel.fromService(deps.timeline),
    )

    this.languages = ProxyChannel.toService<IExtHostLanguages>(
      client.getChannel(ExtHostChannels.extHostLanguages),
    )
    this.documents = ProxyChannel.toService<IExtHostDocuments>(
      client.getChannel(ExtHostChannels.extHostDocuments),
    )
    const mainThreadLanguages = store.add(
      new MainThreadLanguages(this.languages, deps.languageFeatures),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadLanguages,
      ProxyChannel.fromService(mainThreadLanguages),
    )

    const extHostEditor = ProxyChannel.toService<IExtHostEditor>(
      client.getChannel(ExtHostChannels.extHostEditor),
    )
    const mainThreadEditor = store.add(
      new MainThreadEditor(
        deps.editorService,
        deps.uriIdentity,
        extHostEditor,
        deps.files,
        deps.editorGroups,
        deps.instantiation,
        deps.logger,
      ),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadEditor,
      ProxyChannel.fromService(mainThreadEditor),
    )

    const mainThreadAi = store.add(new MainThreadAi(deps.aiModel))
    server.registerChannel(ExtHostChannels.mainThreadAi, ProxyChannel.fromService(mainThreadAi))

    const mainThreadFs = new MainThreadFs(
      workspaceRoot,
      deps.pathPolicy,
      deps.files,
      deps.fileSearch,
      () => deps.exclude.getSearchExcludeGlobs(),
      deps.logger,
    )
    server.registerChannel(ExtHostChannels.mainThreadFs, ProxyChannel.fromService(mainThreadFs))

    const extHostFileEvents = ProxyChannel.toService<IExtHostFileEvents>(
      client.getChannel(ExtHostChannels.extHostFileEvents),
    )
    const mainThreadFileEvents = store.add(
      new MainThreadFileEvents(deps.fileWatcher, extHostFileEvents, deps.logger),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadFileEvents,
      ProxyChannel.fromService(mainThreadFileEvents),
    )

    const mainThreadOutput = store.add(new MainThreadOutput(deps.output, deps.layout, deps.views))
    server.registerChannel(
      ExtHostChannels.mainThreadOutput,
      ProxyChannel.fromService(mainThreadOutput),
    )

    const mainThreadStorage = new MainThreadStorage(deps.storage)
    server.registerChannel(
      ExtHostChannels.mainThreadStorage,
      ProxyChannel.fromService(mainThreadStorage),
    )

    deps.webview.setExtHost(
      kind,
      ProxyChannel.toService<IExtHostWebviews>(client.getChannel(ExtHostChannels.extHostWebviews)),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadWebviews,
      ProxyChannel.fromService(deps.webview.createMainThread(kind)),
    )
  }

  get dead(): boolean {
    return this._dead
  }

  markDead(): void {
    this._dead = true
  }
}
