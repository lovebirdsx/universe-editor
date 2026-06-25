/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for resolving the native `codex` binary the built-in Codex
 *  agent drives. The bundled codex-acp adapter (JS) spawns it directly via the
 *  `CODEX_PATH` env. The binary ships as the platform version of `@openai/codex`
 *  (e.g. `@openai/codex@<ver>-win32-x64`) and is deliberately NOT packaged (~300MB):
 *  it is downloaded on demand into userData, reused from a system install, or
 *  pointed at a custom path. The resolved absolute path is injected as `CODEX_PATH`.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export type CodexBinarySource = 'download' | 'system' | 'custom'

export interface ICodexBinaryResolveOptions {
  /** How to obtain the binary. Defaults to 'download' when omitted by callers. */
  readonly source: CodexBinarySource
  /** Absolute path to a user-provided binary; required when source is 'custom'. */
  readonly customPath?: string
}

export interface ICodexBinaryProgress {
  /** Bytes downloaded so far. */
  readonly received: number
  /** Total bytes per Content-Length, or 0 when the server didn't report it. */
  readonly total: number
}

export interface ICodexBinaryResult {
  /** Absolute path to a ready-to-spawn codex binary. */
  readonly path: string
}

export interface ICodexBinaryVersionInfo {
  /**
   * codex version pinned in CodexBinaryMainService, kept in sync with the
   * codex-acp fork's lockfile and bumped by hand when following upstream. Used as
   * both the default download target and the cache directory.
   */
  readonly bundledVersion: string
  /**
   * Actually-installed binary version on disk. Written by forceDownload() into a
   * `.version` sidecar file alongside the binary. null means the binary has not
   * been downloaded yet (no file at the expected cache path).
   */
  readonly installedVersion: string | null
  /**
   * Latest version available on the npm registry for @openai/codex.
   * null when the network query failed.
   */
  readonly latestVersion: string | null
  /**
   * Version already downloaded into the background prefetch staging area and ready
   * to be activated instantly by forceDownload() without a network fetch. null when
   * nothing is staged.
   */
  readonly prefetchedVersion: string | null
}

/**
 * Resolves the native codex binary, downloading it on first use when needed.
 * `resolve` is idempotent and de-dupes concurrent calls for the same options;
 * a cached binary returns immediately without re-downloading.
 */
export interface ICodexBinaryService {
  readonly _serviceBrand: undefined

  /** Fires while a download is in flight so the UI can show progress. */
  readonly onDidChangeProgress: Event<ICodexBinaryProgress>

  resolve(opts: ICodexBinaryResolveOptions): Promise<ICodexBinaryResult>

  /** Returns version metadata for the download-mode binary. */
  getVersionInfo(): Promise<ICodexBinaryVersionInfo>

  /**
   * Best-effort background download of the most desirable version (latest when
   * available, otherwise the pinned version) into a staging area, so a later
   * forceDownload() can activate it instantly. No-op when the desired version is
   * already installed or already staged. Never throws — network failures are
   * swallowed so idle prefetch never disrupts the user.
   */
  prefetch(): Promise<void>

  /**
   * Force-downloads the specified version of the binary, overwriting whatever is
   * currently cached at the bundled-version path. Writes a `.version` sidecar
   * file so getVersionInfo() can report the installed version accurately.
   */
  forceDownload(version: string): Promise<ICodexBinaryResult>
}

export const ICodexBinaryService = createDecorator<ICodexBinaryService>('codexBinaryService')
