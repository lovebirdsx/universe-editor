/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test stub for IFileService — in-memory file store. Only what the ACP layer
 *  exercises is implemented (readFile / readFileText for the project
 *  `.mcp.json`); everything else throws so an unexpected call fails loudly.
 *--------------------------------------------------------------------------------------------*/

import {
  URI,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
} from '@universe-editor/platform'

export class StubFileService implements IFileService {
  declare readonly _serviceBrand: undefined
  readonly files = new Map<string, string>()
  set(resource: URI, content: string): void {
    this.files.set(resource.toString(), content)
  }
  async readFile(resource: URI): Promise<Uint8Array> {
    const c = this.files.get(resource.toString())
    if (c === undefined) throw new Error('ENOENT')
    return new TextEncoder().encode(c)
  }
  async readFileText(resource: URI): Promise<string> {
    const c = this.files.get(resource.toString())
    if (c === undefined) throw new Error('ENOENT')
    return c
  }
  async writeFile(resource: URI, content: Uint8Array | string): Promise<void> {
    this.files.set(
      resource.toString(),
      typeof content === 'string' ? content : new TextDecoder().decode(content),
    )
  }
  async exists(resource: URI): Promise<boolean> {
    return this.files.has(resource.toString())
  }
  async stat(): Promise<IFileStat> {
    throw new Error('not implemented')
  }
  async list(): Promise<IDirectoryEntry[]> {
    return []
  }
  async createDirectory(): Promise<void> {}
  async delete(): Promise<void> {}
  async rename(): Promise<void> {}
  async copy(): Promise<void> {}
  async listRecursive(): Promise<URI[]> {
    return []
  }
}
