/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin Electron-coupled wrapper over NodeFileSystemProvider: injects
 *  `shell.trashItem` as the trash hook. The disk logic lives in
 *  @universe-editor/node-services so a remote Node server can reuse it.
 *--------------------------------------------------------------------------------------------*/

import { shell } from 'electron'
import { createNamedLogger, type ILoggerService } from '@universe-editor/platform'
import { NodeFileSystemProvider } from '@universe-editor/node-services'

export class LocalFileSystemProvider extends NodeFileSystemProvider {
  constructor(loggerService?: ILoggerService) {
    super({
      logger: createNamedLogger(loggerService, { id: 'fileSystem', name: 'File System' }),
      trash: (nativePath) => shell.trashItem(nativePath),
    })
  }
}
