/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  RemoteTerminalService — the server's Terminal channel surface. Implements the
 *  shared ITerminalService (cwd as a URI) on top of the Electron-free PtyHostService.
 *
 *  The per-connection codec already translated the client's remote-ssh cwd into a
 *  `file:` URI before it reached here, so the only URI work left is `uri.fsPath` to
 *  hand PtyHostService its narrow native-path input. pty `onData` chunks are merged
 *  per id through a small throttler so high-frequency output does not multiply the
 *  tunnel's frame count.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  URI,
  type Event,
  type ILogChannel,
  type ILogger,
  type ITerminalCreatedInfo,
  type ITerminalDataEvent,
  type ITerminalExitEvent,
  type ITerminalProfile,
  type ITerminalProfilesRequest,
  type ITerminalService,
  type ITerminalSpawnSpec,
  type ITerminalTitleEvent,
  type UriComponents,
} from '@universe-editor/platform'
import {
  PtyHostService,
  TerminalDataThrottler,
  type PtySpawner,
} from '@universe-editor/node-services'

const DATA_THROTTLE_MS = 5

function reviveUri(value: UriComponents | URI): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class RemoteTerminalService extends Disposable implements ITerminalService {
  declare readonly _serviceBrand: undefined

  private readonly _host: PtyHostService

  private readonly _onData = this._register(new Emitter<ITerminalDataEvent>())
  readonly onData: Event<ITerminalDataEvent> = this._onData.event

  private readonly _onExit = this._register(new Emitter<ITerminalExitEvent>())
  readonly onExit: Event<ITerminalExitEvent> = this._onExit.event

  private readonly _onTitleChange = this._register(new Emitter<ITerminalTitleEvent>())
  readonly onTitleChange: Event<ITerminalTitleEvent> = this._onTitleChange.event

  constructor(spawn?: PtySpawner, logger?: { createLogger(channel: ILogChannel): ILogger }) {
    super()
    this._host = this._register(
      new PtyHostService({
        ...(spawn !== undefined ? { spawn } : {}),
        ...(logger !== undefined ? { logger } : {}),
      }),
    )
    const throttler = this._register(
      new TerminalDataThrottler((id, data) => this._onData.fire({ id, data }), DATA_THROTTLE_MS),
    )
    this._register(this._host.onData((e) => throttler.push(e.id, e.data)))
    this._register(this._host.onExit((e) => this._onExit.fire(e)))
    this._register(this._host.onTitleChange((e) => this._onTitleChange.fire(e)))
  }

  create(spec: ITerminalSpawnSpec): Promise<ITerminalCreatedInfo> {
    const { cwd, ...rest } = spec
    const cwdPath = cwd ? reviveUri(cwd).fsPath : undefined
    return this._host.create({ ...rest, ...(cwdPath !== undefined ? { cwd: cwdPath } : {}) })
  }

  getProfiles(request: ITerminalProfilesRequest): Promise<readonly ITerminalProfile[]> {
    return this._host.getProfiles(request)
  }

  input(id: string, data: string): Promise<void> {
    return this._host.input(id, data)
  }

  resize(id: string, cols: number, rows: number): Promise<void> {
    return this._host.resize(id, cols, rows)
  }

  kill(id: string): Promise<void> {
    return this._host.kill(id)
  }

  list(): Promise<readonly ITerminalCreatedInfo[]> {
    return this._host.list()
  }

  release(id: string): Promise<void> {
    return this._host.release(id)
  }
}
