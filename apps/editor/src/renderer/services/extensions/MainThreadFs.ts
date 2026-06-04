/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadFs — the renderer end of `workspace.fs`. The extension host calls
 *  these `$`-methods; each one passes through the same path policy that guards
 *  ACP agents (denies `.ssh`/`.aws`/`.env`…, forbids escaping the workspace
 *  root) before delegating to IFileService. File contents cross the wire as
 *  base64 strings.
 *--------------------------------------------------------------------------------------------*/

import { URI, type IFileService } from '@universe-editor/platform'
import {
  base64ToBytes,
  bytesToBase64,
  type ExtHostFileType,
  type IExtHostFileStatDto,
  type IMainThreadFs,
} from '@universe-editor/extensions-common'
import type { IAcpPathPolicy } from '../acp/acpPathPolicy.js'

export class MainThreadFs implements IMainThreadFs {
  constructor(
    /** Workspace root used as the policy's containment boundary. */
    private readonly _cwd: string | undefined,
    private readonly _policy: IAcpPathPolicy,
    private readonly _files: IFileService,
  ) {}

  private _guard(path: string): URI {
    if (this._cwd === undefined) {
      throw new Error('workspace.fs requires an open workspace folder')
    }
    const decision = this._policy.check(this._cwd, path)
    if (!decision.ok) {
      throw new Error(`workspace.fs denied: ${decision.reason}`)
    }
    return URI.file(decision.normalized)
  }

  async $readFile(path: string): Promise<string> {
    const bytes = await this._files.readFile(this._guard(path))
    return bytesToBase64(bytes)
  }

  $writeFile(path: string, base64: string): Promise<void> {
    return this._files.writeFile(this._guard(path), base64ToBytes(base64))
  }

  async $stat(path: string): Promise<IExtHostFileStatDto> {
    const stat = await this._files.stat(this._guard(path))
    return { type: stat.isDirectory ? 'dir' : 'file', size: stat.size, mtime: stat.mtime }
  }

  async $readDirectory(path: string): Promise<Array<[string, ExtHostFileType]>> {
    const entries = await this._files.list(this._guard(path))
    return entries.map((e) => [e.name, e.isDirectory ? 'dir' : 'file'])
  }

  $createDirectory(path: string): Promise<void> {
    return this._files.createDirectory(this._guard(path))
  }

  $delete(path: string, recursive: boolean): Promise<void> {
    return this._files.delete(this._guard(path), { recursive })
  }
}
