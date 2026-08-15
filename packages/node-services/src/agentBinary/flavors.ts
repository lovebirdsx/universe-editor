/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Flavor definitions for the two native agent binaries the editor downloads:
 *  the platform-specific optional dependency of @anthropic-ai/claude-agent-sdk
 *  and the platform version of @openai/codex. The shared AgentBinaryStore
 *  carries all download/registry/extraction logic; each flavor pins only what
 *  differs (registry coordinates, tar layout, platform detection, version dir
 *  layout, and how the "bundled" version is discovered).
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'

export type AgentBinaryId = 'claude' | 'codex'

/**
 * Pinned `@openai/codex` version to download. Kept in sync with the codex-acp
 * fork's lockfile (`vendor/codex-acp`); bumped by hand when following upstream.
 */
export const CODEX_VERSION = '0.146.0'

export interface AgentBinaryPlatform {
  /** Platform/arch suffix of the native package, e.g. `win32-x64`, `linux-x64-musl`. */
  readonly suffix: string
  /** Executable file name inside the package and on disk. */
  readonly binName: string
  /** Rust target triple the tarball nests the binary under (codex only). */
  readonly triple?: string
}

export interface AgentBinaryFlavor {
  readonly id: AgentBinaryId
  /** Version the binary is bundled/pinned at. Claude reads claude-binary.json; codex is a constant. */
  bundledVersion(): Promise<string>
  /** Detect the current host's platform binary package. */
  detectPlatform(): AgentBinaryPlatform
  /** npm package name for the platform binary, e.g. `@anthropic-ai/claude-agent-sdk-win32-x64`. */
  platformPackage(platform: AgentBinaryPlatform): string
  /** Registry version to fetch for that package, e.g. `0.3.186` (claude) or `0.146.0-win32-x64` (codex). */
  platformVersion(version: string, platform: AgentBinaryPlatform): string
  /** Package name whose `latest` dist-tag is polled for prefetch/version info. */
  readonly latestPackage: string
  /** Resolved executable path inside an extracted version dir (or temp dir). */
  binaryIn(dir: string, platform: AgentBinaryPlatform): string
  /** tar extraction options (strip + entry filter) for the platform tarball. */
  extractOptions(platform: AgentBinaryPlatform): {
    readonly strip: number
    readonly filter: (entryPath: string) => boolean
  }
}

function isMuslLibc(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined
  return !report?.header?.glibcVersionRuntime
}

/**
 * Claude flavor. `metaPath` is resolved lazily (the packaged path under
 * `process.resourcesPath` vs the dev-tree `resolveFromRepo` path only diverge
 * once `app` exists, and bundledVersion() must not touch either until called).
 */
export function createClaudeFlavor(metaPath: () => string): AgentBinaryFlavor {
  return {
    id: 'claude',

    async bundledVersion(): Promise<string> {
      const resolved = metaPath()
      const raw = await readFile(resolved, 'utf8')
      const meta = JSON.parse(raw) as { sdkVersion?: string }
      if (!meta.sdkVersion) {
        throw new Error(`claude-binary.json at ${resolved} is missing sdkVersion`)
      }
      return meta.sdkVersion
    },

    detectPlatform(): AgentBinaryPlatform {
      const arch = process.arch
      if (process.platform === 'win32') return { suffix: `win32-${arch}`, binName: 'claude.exe' }
      if (process.platform === 'darwin') return { suffix: `darwin-${arch}`, binName: 'claude' }
      if (process.platform === 'linux') {
        return { suffix: `linux-${arch}${isMuslLibc() ? '-musl' : ''}`, binName: 'claude' }
      }
      throw new Error(`Unsupported platform for Claude binary: ${process.platform}-${arch}`)
    },

    platformPackage(platform) {
      return `@anthropic-ai/claude-agent-sdk-${platform.suffix}`
    },

    platformVersion(version) {
      return version
    },

    latestPackage: '@anthropic-ai/claude-agent-sdk',

    binaryIn(dir, platform) {
      return path.join(dir, platform.binName)
    },

    extractOptions(platform) {
      return { strip: 1, filter: (entryPath) => entryPath === `package/${platform.binName}` }
    },
  }
}

export const codexFlavor: AgentBinaryFlavor = {
  id: 'codex',

  async bundledVersion(): Promise<string> {
    return CODEX_VERSION
  },

  detectPlatform(): AgentBinaryPlatform {
    const arch = process.arch
    const win = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
    const mac = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
    const linux = arch === 'arm64' ? 'aarch64-unknown-linux-musl' : 'x86_64-unknown-linux-musl'
    if (process.platform === 'win32')
      return { suffix: `win32-${arch}`, triple: win, binName: 'codex.exe' }
    if (process.platform === 'darwin')
      return { suffix: `darwin-${arch}`, triple: mac, binName: 'codex' }
    if (process.platform === 'linux')
      return { suffix: `linux-${arch}`, triple: linux, binName: 'codex' }
    throw new Error(`Unsupported platform for codex binary: ${process.platform}-${arch}`)
  },

  platformPackage() {
    return '@openai/codex'
  },

  platformVersion(version, platform) {
    return `${version}-${platform.suffix}`
  },

  latestPackage: '@openai/codex',

  binaryIn(dir, platform) {
    return path.join(dir, 'bin', platform.binName)
  },

  extractOptions(platform) {
    // The binary + its sibling runtime resources live under
    // `package/vendor/<triple>/` (npm prefixes every entry with `package/`; the
    // codex platform package nests everything under `vendor/<triple>/`). Strip
    // those three segments so `bin/<binName>`, `codex-resources/`, `codex-path/`
    // land directly in the extract dir with their relative layout preserved.
    const triple = platform.triple
    if (!triple) throw new Error('codex platform is missing its target triple')
    const prefix = `package/vendor/${triple}/`
    return { strip: 3, filter: (entryPath) => entryPath.startsWith(prefix) }
  },
}
