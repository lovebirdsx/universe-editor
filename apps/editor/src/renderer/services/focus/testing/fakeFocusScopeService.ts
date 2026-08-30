/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Test helper: an IFocusScopeService with focus mode off unless folders are
 *  given. Lets tests that construct focus-aware services (search / quick open /
 *  file listing) wire a predictable scope without real configuration.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  UriIdentityService,
  URI,
  type Event,
  type HostPlatform,
} from '@universe-editor/platform'
import { type IFocusScopeService } from '../FocusScopeService.js'
import { isFocusVisible } from '../focusScopeUtils.js'

/** The host's case policy, so the fake agrees with production on the same run. */
const HOST_PLATFORM: HostPlatform =
  process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : 'unknown'

export class FakeFocusScopeService implements IFocusScopeService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange: Event<void> = this._onDidChange.event

  private _enabled: boolean
  // Case policy pinned to the host, matching what the real DI graph binds — the
  // fake is used by cross-platform tests, so folding case unconditionally would
  // make a linux run disagree with production on the same assertion.
  private readonly _uriIdentity = new UriIdentityService(HOST_PLATFORM)

  constructor(
    private _folders: readonly string[] = [],
    private readonly _root: URI | null = null,
    private readonly _showRootFiles = true,
  ) {
    this._enabled = _folders.length > 0
  }

  get active(): boolean {
    return this._enabled && this._folders.length > 0
  }

  get enabled(): boolean {
    return this._enabled
  }

  get folders(): readonly string[] {
    return this._folders
  }

  get showRootFiles(): boolean {
    return this._showRootFiles
  }

  get scanRoots(): readonly URI[] {
    const root = this._root
    if (!root) return []
    if (!this.active) return [root]
    return this._folders.map((rel) => URI.joinPath(root, rel))
  }

  get rootFilesInScope(): boolean {
    return this.active && this._showRootFiles
  }

  get fingerprint(): string {
    return JSON.stringify([this._showRootFiles, this._folders])
  }

  isVisible(relPath: string, isDirectory: boolean): boolean {
    if (!this.active) return true
    return isFocusVisible(
      relPath,
      isDirectory,
      this._folders,
      this._showRootFiles,
      this._uriIdentity,
    )
  }

  isFocusFolder(relPath: string): boolean {
    return this._folders.includes(normalize(relPath))
  }

  // The write side keeps state in memory only: tests that drive it are asserting
  // on what a command *did*, not on configuration layering (which has its own
  // tests against the real service).
  async setEnabled(enabled: boolean): Promise<void> {
    if (this._enabled === enabled) return
    this._enabled = enabled
    this._onDidChange.fire()
  }

  async setFolders(relPaths: readonly string[]): Promise<void> {
    this._folders = relPaths.map(normalize).filter((rel) => rel.length > 0)
    this._enabled = this._folders.length > 0
    this._onDidChange.fire()
  }

  async addFolders(relPaths: readonly string[]): Promise<void> {
    const added = relPaths.map(normalize).filter((rel) => rel.length > 0)
    await this.setFolders([...this._folders.filter((rel) => !added.includes(rel)), ...added])
  }

  async removeFolders(relPaths: readonly string[]): Promise<void> {
    const removed = relPaths.map(normalize)
    await this.setFolders(this._folders.filter((rel) => !removed.includes(rel)))
  }

  fireChange(): void {
    this._onDidChange.fire()
  }

  /**
   * Force the enabled-but-empty state, which the write API deliberately cannot
   * reach (it turns focus off with the last folder) but hand-edited settings and
   * a `false`-cancelled project layer both can.
   */
  setEnabledWithNoFolders(): void {
    this._folders = []
    this._enabled = true
    this._onDidChange.fire()
  }
}

function normalize(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}
