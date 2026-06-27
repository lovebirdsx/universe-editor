/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for resolving the native Claude binary the bundled ACP agent
 *  spawns. The agent ships as a single esbuild file with no node_modules, so the
 *  ~226MB native binary is never packaged: it is downloaded on demand into
 *  userData, reused from a system install, or pointed at a custom path. The
 *  resolved absolute path is handed to the agent via CLAUDE_CODE_EXECUTABLE.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

export type ClaudeBinarySource = 'download' | 'system' | 'custom'

export interface IClaudeBinaryResolveOptions {
  /** How to obtain the binary. Defaults to 'download' when omitted by callers. */
  readonly source: ClaudeBinarySource
  /** Absolute path to a user-provided binary; required when source is 'custom'. */
  readonly customPath?: string
}

export interface IClaudeBinaryProgress {
  /** Bytes downloaded so far. */
  readonly received: number
  /** Total bytes per Content-Length, or 0 when the server didn't report it. */
  readonly total: number
}

export interface IClaudeBinaryResult {
  /** Absolute path to a ready-to-spawn Claude binary. */
  readonly path: string
}

export interface IClaudeBinaryVersionInfo {
  /** SDK version the bundled ACP agent was built against (from claude-binary.json). */
  readonly bundledVersion: string
  /**
   * Actually-installed binary version on disk — the version named by the `.active`
   * pointer file (each version lives in its own dir named after it). null means no
   * binary has been downloaded yet.
   */
  readonly installedVersion: string | null
  /**
   * Latest version available on the npm registry for @anthropic-ai/claude-agent-sdk.
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
 * Resolves the native Claude binary, downloading it on first use when needed.
 * `resolve` is idempotent and de-dupes concurrent calls for the same options;
 * a cached binary returns immediately without re-downloading.
 */
export interface IClaudeBinaryService {
  readonly _serviceBrand: undefined

  /** Fires while a download is in flight so the UI can show progress. */
  readonly onDidChangeProgress: Event<IClaudeBinaryProgress>

  resolve(opts: IClaudeBinaryResolveOptions): Promise<IClaudeBinaryResult>

  /** Returns version metadata for the download-mode binary. */
  getVersionInfo(): Promise<IClaudeBinaryVersionInfo>

  /**
   * Best-effort background download of the most desirable version (latest when
   * available, otherwise the bundled SDK version) into a staging area, so a later
   * forceDownload() can activate it instantly. No-op when the desired version is
   * already installed or already staged. Never throws — network failures are
   * swallowed so idle prefetch never disrupts the user.
   */
  prefetch(): Promise<void>

  /**
   * Force-downloads (or activates a prefetched) version into its own per-version
   * dir and flips the `.active` pointer to it. Because each version has its own
   * dir, activation never overwrites the running binary's locked files (the EPERM
   * trap on Windows); the previous version's dir is cleaned up best-effort.
   */
  forceDownload(version: string): Promise<IClaudeBinaryResult>

  /**
   * Removes stale (non-active) version dirs left behind by a previous upgrade.
   * Safe to call only at startup/idle — mid-session the predecessor binary is
   * still locked by the running agent. Best-effort; never throws.
   */
  cleanupStaleVersions(): Promise<void>
}

export const IClaudeBinaryService = createDecorator<IClaudeBinaryService>('claudeBinaryService')
