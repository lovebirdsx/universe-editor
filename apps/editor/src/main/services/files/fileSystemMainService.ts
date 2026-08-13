/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process filesystem gateway, reached from the renderer through
 *  ProxyChannel. A scheme-routed FileService with the local `file:` provider
 *  pre-registered; additional providers (e.g. remote hosts) plug into
 *  `providers` without touching consumers.
 *--------------------------------------------------------------------------------------------*/

import { FileService, ILoggerService, REMOTE_SCHEME } from '@universe-editor/platform'
import { LocalFileSystemProvider } from './localFileSystemProvider.js'
import { RemoteFileSystemProvider } from '../remote/remoteFileSystemProvider.js'
import { IRemoteConnectionService } from '../remote/remoteConnectionMainService.js'

export class FileSystemMainService extends FileService {
  constructor(
    @ILoggerService loggerService?: ILoggerService,
    @IRemoteConnectionService remoteConnections?: IRemoteConnectionService,
  ) {
    super()
    this._register(this.providers.register('file', new LocalFileSystemProvider(loggerService)))
    if (remoteConnections) {
      this._register(
        this.providers.register(
          REMOTE_SCHEME,
          new RemoteFileSystemProvider(remoteConnections, loggerService),
        ),
      )
    }
  }
}
