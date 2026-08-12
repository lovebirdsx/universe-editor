/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  MainThreadFs — the renderer end of `workspace.fs`. The extension host calls
 *  these `$`-methods; each one passes through the same path policy that guards
 *  ACP agents (denies `.ssh`/`.aws`/`.env`…, forbids escaping the workspace
 *  root) before delegating to IFileService. File contents cross the wire as
 *  base64 strings.
 *
 *  Defense in depth: the policy is text-level (it can't see symlinks). After it
 *  passes, we resolve the real, symlink-followed path via IFileService.realpath
 *  and re-run the policy on it — so a workspace-internal symlink pointing at
 *  `~/.ssh` (or anywhere outside the root) is still rejected. Falls back to the
 *  text-only decision if the file service has no realpath.
 *--------------------------------------------------------------------------------------------*/

import {
  URI,
  type IFileSearchService,
  type IFileService,
  type ILogger,
} from '@universe-editor/platform'
import {
  base64ToBytes,
  bytesToBase64,
  compileGlobMatcher,
  type ExtHostFileType,
  type IExtHostFileStatDto,
  type IMainThreadFs,
} from '@universe-editor/extensions-common'
import type { IAcpPathPolicy } from '../acp/acpPathPolicy.js'

/** Upper bound for the `rg --files` enumeration behind `workspace.findFiles`;
 *  the include-glob filter and the caller's `maxResults` apply on top. */
const FIND_FILES_ENUMERATION_CAP = 100_000

export class MainThreadFs implements IMainThreadFs {
  /** Lazily resolved, symlink-followed form of `_cwd` (see `_getCanonicalCwd`). */
  private _canonicalCwd: Promise<string | undefined> | undefined

  constructor(
    /** Workspace root used as the policy's containment boundary. */
    private readonly _cwd: string | undefined,
    private readonly _policy: IAcpPathPolicy,
    private readonly _files: IFileService,
    private readonly _fileSearch: IFileSearchService,
    /** The configured default search excludes (files.exclude ∪ search.exclude). */
    private readonly _defaultExcludes: () => readonly string[],
    private readonly _logger: ILogger,
  ) {}

  private async _guard(path: string): Promise<URI> {
    if (this._cwd === undefined) {
      throw new Error('workspace.fs requires an open workspace folder')
    }
    const decision = this._policy.check(this._cwd, path)
    if (!decision.ok) {
      throw new Error(`workspace.fs denied: ${decision.reason}`)
    }
    const uri = URI.file(decision.normalized)
    await this._guardRealpath(uri)
    return uri
  }

  /**
   * Second line of defense: re-run the policy against the symlink-resolved real
   * path. The text policy already vetted the literal path; this catches a
   * symlink whose real target escapes the workspace or lands on a sensitive
   * prefix. No-op when the file service can't resolve real paths.
   */
  private async _guardRealpath(uri: URI): Promise<void> {
    if (!this._files.realpath) return
    let real: URI
    try {
      real = await this._files.realpath(uri)
    } catch {
      // realpath shouldn't normally fail (it tolerates missing tails), but if it
      // does we keep the text-level guarantee rather than failing the operation.
      return
    }
    // Compare the canonical target against the *canonical* cwd. `_cwd` may carry
    // a non-canonical form of the same directory — symlinked, or (on Windows CI,
    // whose temp dir lives under an 8.3 short name like `RUNNER~1`) the short
    // name — while realpath always returns the long/real form. Comparing the
    // real target to a non-canonical cwd would spuriously read as "escapes
    // workspace root" and deny every gated read of an unopened file.
    const canonicalCwd = await this._getCanonicalCwd()
    const decision = this._policy.check(canonicalCwd ?? (this._cwd as string), real.fsPath)
    if (!decision.ok) {
      throw new Error(`workspace.fs denied (real path): ${decision.reason}`)
    }
  }

  /**
   * Canonicalize `_cwd` the same way realpath canonicalizes targets, so the
   * containment check in `_guardRealpath` compares like with like. Resolved
   * once and cached; falls back to the literal cwd if realpath is unavailable
   * or throws.
   */
  private _getCanonicalCwd(): Promise<string | undefined> {
    if (this._canonicalCwd) return this._canonicalCwd
    this._canonicalCwd = (async () => {
      if (this._cwd === undefined || !this._files.realpath) return this._cwd
      try {
        return (await this._files.realpath(URI.file(this._cwd))).fsPath
      } catch {
        return this._cwd
      }
    })()
    return this._canonicalCwd
  }

  async $readFile(path: string): Promise<string> {
    const bytes = await this._files.readFile(await this._guard(path))
    return bytesToBase64(bytes)
  }

  async $writeFile(path: string, base64: string): Promise<void> {
    return this._files.writeFile(await this._guard(path), base64ToBytes(base64))
  }

  async $stat(path: string): Promise<IExtHostFileStatDto> {
    const stat = await this._files.stat(await this._guard(path))
    return { type: stat.isDirectory ? 'dir' : 'file', size: stat.size, mtime: stat.mtime }
  }

  async $readDirectory(path: string): Promise<Array<[string, ExtHostFileType]>> {
    const entries = await this._files.list(await this._guard(path))
    return entries.map((e) => [e.name, e.isDirectory ? 'dir' : 'file'])
  }

  async $createDirectory(path: string): Promise<void> {
    return this._files.createDirectory(await this._guard(path))
  }

  async $delete(path: string, recursive: boolean): Promise<void> {
    return this._files.delete(await this._guard(path), { recursive })
  }

  async $rename(source: string, target: string, overwrite: boolean): Promise<void> {
    const [from, to] = await Promise.all([this._guard(source), this._guard(target)])
    return this._files.rename(from, to, { overwrite })
  }

  async $copy(source: string, target: string, overwrite: boolean): Promise<void> {
    const [from, to] = await Promise.all([this._guard(source), this._guard(target)])
    return this._files.copy(from, to, { overwrite })
  }

  /**
   * `workspace.findFiles`: enumerate the workspace live (matchAll walks with rg,
   * never the stale listing cache), then apply the include glob to each match's
   * workspace-relative path. No path policy here — the enumeration is rooted at
   * the workspace and only fsPaths inside it come back.
   */
  async $findFiles(
    include: string,
    exclude: readonly string[] | null,
    maxResults: number | null,
  ): Promise<string[]> {
    if (this._cwd === undefined) {
      throw new Error('workspace.findFiles requires an open workspace folder')
    }
    const complete = await this._fileSearch.search({
      root: URI.file(this._cwd),
      pattern: '',
      matchAll: true,
      excludes: exclude === null ? [...this._defaultExcludes()] : [...exclude],
      maxResults: FIND_FILES_ENUMERATION_CAP,
    })
    if (complete.limitHit) {
      this._logger.warn(
        `findFiles enumeration truncated at ${FIND_FILES_ENUMERATION_CAP} entries; results may be incomplete`,
      )
    }
    const matches = compileGlobMatcher(include)
    const out: string[] = []
    for (const match of complete.results) {
      if (!matches(match.relativePath)) continue
      out.push(match.fsPath)
      if (maxResults !== null && out.length >= maxResults) break
    }
    return out
  }
}
