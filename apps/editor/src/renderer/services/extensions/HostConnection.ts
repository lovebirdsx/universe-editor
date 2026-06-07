/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  HostConnection — one renderer↔extension-host RPC connection. Wraps a single
 *  spawned host (identified by its opaque handle): the stdio framing protocol,
 *  the ChannelClient (calling the host's ExtHost* channels), the ChannelServer
 *  (hosting the renderer's MainThread* channels), and the per-connection channel
 *  wiring. ExtensionHostClientService owns one of these per trust tier.
 *
 *  Only the trusted connection wires SCM (the SCM service is a global singleton
 *  and is a trusted capability); a restricted connection that tries to create a
 *  source control is rejected host-side.
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
  type IFileService,
  type ILogger,
  type INotificationService,
  type IOutputChannel,
  type IOutputService,
  type IQuickInputService,
  type IStatusBarService,
} from '@universe-editor/platform'
import {
  ExtHostChannels,
  StdioFramingProtocol,
  type IExtHostCommands,
  type IExtHostExtensions,
  type IExtHostScm,
} from '@universe-editor/extensions-common'
import type {
  ExtHostKind,
  IExtensionHostService,
} from '../../../shared/ipc/extensionHostService.js'
import type { IAcpPathPolicy } from '../acp/acpPathPolicy.js'
import { MainThreadCommands, type CommandOwnershipLedger } from './MainThreadCommands.js'
import { MainThreadFs } from './MainThreadFs.js'
import { MainThreadOutput } from './MainThreadOutput.js'
import { MainThreadWindow } from './MainThreadWindow.js'
import type { IScmService } from './ScmService.js'

export interface HostConnectionDeps {
  readonly host: IExtensionHostService
  readonly notification: INotificationService
  readonly quickInput: IQuickInputService
  readonly statusBar: IStatusBarService
  readonly dialog: IDialogService
  readonly files: IFileService
  readonly pathPolicy: IAcpPathPolicy
  readonly commandService: ICommandService
  /** Wired only for the trusted connection — the SCM service is a singleton. */
  readonly scm?: IScmService
  readonly output: IOutputService
  readonly stderr: IOutputChannel
  readonly logger: ILogger
  readonly ledger: CommandOwnershipLedger
}

export class HostConnection extends Disposable {
  readonly commands: IExtHostCommands
  readonly extensions: IExtHostExtensions
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

    const mainThreadWindow = store.add(
      new MainThreadWindow(deps.notification, deps.quickInput, deps.statusBar, deps.dialog),
    )
    server.registerChannel(
      ExtHostChannels.mainThreadWindow,
      ProxyChannel.fromService(mainThreadWindow),
    )

    if (deps.scm) {
      deps.scm.setExtHost(
        ProxyChannel.toService<IExtHostScm>(client.getChannel(ExtHostChannels.extHostScm)),
      )
      server.registerChannel(ExtHostChannels.mainThreadScm, ProxyChannel.fromService(deps.scm))
    }

    const mainThreadFs = new MainThreadFs(workspaceRoot, deps.pathPolicy, deps.files)
    server.registerChannel(ExtHostChannels.mainThreadFs, ProxyChannel.fromService(mainThreadFs))

    const mainThreadOutput = store.add(new MainThreadOutput(deps.output))
    server.registerChannel(
      ExtHostChannels.mainThreadOutput,
      ProxyChannel.fromService(mainThreadOutput),
    )
  }

  get dead(): boolean {
    return this._dead
  }

  markDead(): void {
    this._dead = true
  }
}
