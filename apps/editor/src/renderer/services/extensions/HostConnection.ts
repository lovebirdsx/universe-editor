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
  ChannelClient,
  ChannelServer,
  Disposable,
  DisposableStore,
  Event,
  ProxyChannel,
  type ICommandService,
  type IDialogService,
  type IEditorService,
  type IFileService,
  type ILayoutService,
  type ILogger,
  type INotificationService,
  type IOutputChannel,
  type IOutputService,
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
  type IExtHostLanguages,
  type IExtHostScm,
  type IExtHostWebviews,
  type IExtensionActivationErrorDto,
} from '@universe-editor/extensions-common'
import type {
  ExtHostKind,
  IExtensionHostService,
} from '../../../shared/ipc/extensionHostService.js'
import type { IAcpPathPolicy } from '../acp/acpPathPolicy.js'
import { MainThreadCommands, type CommandOwnershipLedger } from './MainThreadCommands.js'
import { MainThreadAi } from './MainThreadAi.js'
import { MainThreadEditor } from './MainThreadEditor.js'
import { MainThreadExtensions } from './MainThreadExtensions.js'
import { MainThreadFs } from './MainThreadFs.js'
import { MainThreadLanguages } from './MainThreadLanguages.js'
import { MainThreadOutput } from './MainThreadOutput.js'
import { MainThreadStorage } from './MainThreadStorage.js'
import { MainThreadWindow } from './MainThreadWindow.js'
import type { ILanguageFeaturesService } from '../languageFeatures/LanguageFeaturesService.js'
import type { IScmService } from './ScmService.js'
import type { IWebviewService } from './WebviewService.js'
import type { IAiModelService } from '@universe-editor/platform'

export interface HostConnectionDeps {
  readonly host: IExtensionHostService
  readonly notification: INotificationService
  readonly quickInput: IQuickInputService
  readonly statusBar: IStatusBarService
  readonly dialog: IDialogService
  readonly files: IFileService
  readonly pathPolicy: IAcpPathPolicy
  readonly commandService: ICommandService
  readonly scm: IScmService
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
    workspaceRoot: string | undefined,
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

    const client = store.add(new ChannelClient(protocol))
    const server = store.add(new ChannelServer(protocol))

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

    const mainThreadWindow = store.add(
      new MainThreadWindow(deps.notification, deps.quickInput, deps.statusBar, deps.dialog),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadWindow,
      ProxyChannel.fromService(mainThreadWindow),
    )

    deps.scm.setExtHost(
      ProxyChannel.toService<IExtHostScm>(client.getChannel(ExtHostChannels.extHostScm)),
    )
    server.registerChannel(ExtHostChannels.mainThreadScm, ProxyChannel.fromService(deps.scm))

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
      new MainThreadEditor(deps.editorService, deps.uriIdentity, extHostEditor),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadEditor,
      ProxyChannel.fromService(mainThreadEditor),
    )

    const mainThreadAi = store.add(new MainThreadAi(deps.aiModel))
    server.registerChannel(ExtHostChannels.mainThreadAi, ProxyChannel.fromService(mainThreadAi))

    const mainThreadFs = new MainThreadFs(workspaceRoot, deps.pathPolicy, deps.files)
    server.registerChannel(ExtHostChannels.mainThreadFs, ProxyChannel.fromService(mainThreadFs))

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
