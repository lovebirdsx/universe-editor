/**
 * Provides the "have" revision content of a file for diffs. The SCM baseline in
 * Perforce is the depot revision you last synced (`#have`), whose content lives
 * on the server — fetched with `p4 print -q <file>#have`.
 *
 * Every baseline read is a server round-trip (unlike git's local HEAD blob), so
 * results are cached through the shared {@link P4Cache}'s immutable `print`
 * namespace, keyed on the resolved `depotFile#rev`. A new sync changes the have
 * revision, so the key changes and the old content is never mis-served; the
 * content itself is immutable, so it can even persist across sessions.
 */
import {
  INTERACTIVE_CONTENT_EXEC,
  INTERACTIVE_EXEC,
  type P4ExecResult,
  type P4Service,
} from './p4Service.js'
import { parseFstat, type FstatInfo } from './fstatParser.js'
import { P4Cache, P4CacheNs } from './p4Cache.js'
import { norm } from './pathUtil.js'

/** Cached negative result: the file is not under depot control (`parseFstat`
 *  found no `depotFile`). `wrap` refuses to cache `undefined`, so the negative
 *  needs a real string; '' can't collide with a serialized {@link FstatInfo}
 *  (those always begin with '{'). */
const NOT_CONTROLLED = ''

/** A have-content read with its failure surfaced (`error`) and per-stage timings,
 *  so a caller can tell "no have revision" (fall back to opening the file) from
 *  "the fstat/print actually failed" (show a toast). */
export interface HaveContentResult {
  readonly content?: string
  readonly error?: P4ExecResult
  readonly timings: {
    readonly fstatMs: number
    readonly printMs: number
    /** True when the print content came from the cache (no new p4 round-trip). */
    readonly printCached: boolean
  }
}

export class BaselineProvider {
  constructor(
    private readonly _p4: P4Service,
    private readonly _cache: P4Cache,
  ) {}

  /**
   * `p4 fstat` for one local file, cached under the ttl `fstat` namespace keyed
   * by `norm(localPath)` so {@link P4Cache.invalidateFile} can drop it after a
   * mutation. Transient failures (exitCode ≠ 0) are never cached; the negative
   * result (not under depot control) is cached so the dirty-diff gutter doesn't
   * re-`fstat` every non-depot file on each tab switch.
   */
  async getFstatInfo(localPath: string): Promise<FstatInfo | undefined> {
    return (await this._getFstatInfoResult(localPath)).info
  }

  /**
   * {@link getFstatInfo} with the failure surfaced instead of collapsed into
   * `undefined`, so a caller that needs to report "fstat really failed" (rather
   * than "file has no depot entry") can tell the two apart.
   */
  private async _getFstatInfoResult(localPath: string): Promise<{
    info?: FstatInfo
    error?: P4ExecResult
  }> {
    const { value, error } = await this._cache.wrapWithError(
      P4CacheNs.fstat,
      norm(localPath),
      async () => {
        const res = await this._p4.execRecords(['fstat', localPath], INTERACTIVE_EXEC)
        if (res.result.exitCode !== 0) return { error: res.result }
        const info = parseFstat(res.records)[0]
        return { value: info ? JSON.stringify(info) : NOT_CONTROLLED }
      },
    )
    if (error) return { error }
    if (value === undefined || value === NOT_CONTROLLED) return {}
    return { info: JSON.parse(value) as FstatInfo }
  }

  /**
   * Content of `localPath` at its have revision, or undefined when the file has
   * no have revision (e.g. an open-for-add file that isn't in the depot yet).
   * Kept silent on failure so the dirty-diff gutter (which re-reads on every tab
   * switch) never toasts — callers that need the failure use
   * {@link getHaveContentResult}.
   */
  async getHaveContent(localPath: string): Promise<string | undefined> {
    return (await this.getHaveContentResult(localPath)).content
  }

  /**
   * {@link getHaveContent} with failure + timings surfaced. An `error` means the
   * fstat or print genuinely failed (timeout, connection, permission); no `error`
   * and no `content` means the file simply has no have revision (open-for-add /
   * not under depot control), which is a normal fallback, not a fault.
   */
  async getHaveContentResult(localPath: string): Promise<HaveContentResult> {
    const fstatStart = Date.now()
    const { info, error } = await this._getFstatInfoResult(localPath)
    const fstatMs = Date.now() - fstatStart
    if (error) return { error, timings: { fstatMs, printMs: 0, printCached: true } }
    if (!info || !info.haveRev) return { timings: { fstatMs, printMs: 0, printCached: true } }

    const spec = `${info.depotFile}#${info.haveRev}`
    // The print error rides the in-flight promise (not a caller closure), so a
    // second concurrent caller of the same `spec` sees the same failure instead
    // of misreading "no content" as "no have revision". `printCached` flips only
    // when the fetch runs.
    let printCached = true
    const printStart = Date.now()
    const { value: content, error: printError } = await this._cache.wrapWithError(
      P4CacheNs.print,
      spec,
      async () => {
        printCached = false
        const print = await this._p4.exec(['print', '-q', spec], INTERACTIVE_CONTENT_EXEC)
        if (print.exitCode !== 0) return { error: print }
        return { value: print.stdout }
      },
    )
    const printMs = Date.now() - printStart
    if (content !== undefined) return { content, timings: { fstatMs, printMs, printCached } }
    if (printError) return { error: printError, timings: { fstatMs, printMs, printCached } }
    return { timings: { fstatMs, printMs, printCached } }
  }

  /**
   * Have-revision content of `localPath` as raw bytes, for binary files (e.g.
   * xlsx) that a UTF-8 string baseline would corrupt. Not cached (binary blobs
   * bypass the string `print` cache); returns undefined when there is no have rev.
   */
  async getHaveContentBytes(localPath: string): Promise<Buffer | undefined> {
    return (await this.getHaveContentBytesResult(localPath)).content
  }

  /** {@link getHaveContentBytes} with failure surfaced, mirroring
   *  {@link getHaveContentResult} so the spreadsheet open path can report too. */
  async getHaveContentBytesResult(localPath: string): Promise<{
    content?: Buffer
    error?: P4ExecResult
  }> {
    const { info, error } = await this._getFstatInfoResult(localPath)
    if (error) return { error }
    if (!info || !info.haveRev) return {}
    const spec = `${info.depotFile}#${info.haveRev}`
    const print = await this._p4.execBinary(['print', '-q', spec], INTERACTIVE_CONTENT_EXEC)
    if (print.exitCode !== 0) {
      // execBinary reports raw bytes; the failure reason lives in stderr, so hand
      // notifyP4Failure a text-shaped result (a Buffer stdout would break the
      // trim() in p4ErrorText).
      return { error: { stdout: '', stderr: print.stderr, exitCode: print.exitCode } }
    }
    return { content: print.stdout }
  }
}
