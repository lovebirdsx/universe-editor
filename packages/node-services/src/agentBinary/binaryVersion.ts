/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Version parsing / precedence comparison for the native agent binaries, plus a
 *  best-effort `--version` probe used to enforce a hard lower bound at spawn time.
 *
 *  Deliberately self-contained rather than reusing extension-manifest's semver
 *  helper: that one is fail-open on garbage input and ignores prerelease
 *  ordering, which is the opposite of what a "never launch below the pin" floor
 *  needs. Electron-free, shared by the local main process and the remote server.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process'
import { spawnViaCmd } from '../process/cmdSpawn.js'
import type { AgentBinaryId } from './flavors.js'

export interface ParsedBinaryVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Dot-separated prerelease identifiers; empty for a release version. */
  readonly prerelease: readonly string[]
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const SEMVER_TOKEN_RE = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?/g
const NUMERIC_RE = /^\d+$/

/** `2.1.220 (Claude Code)` — the CLI banner, not the SDK package version. */
const CLAUDE_OUTPUT_RE =
  /^[ \t]*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)[ \t]*\(Claude Code\)/m
/** `codex-cli 0.145.0` — same namespace as the `@openai/codex` package version. */
const CODEX_OUTPUT_RE = /codex-cli[ \t]+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/i

const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const MAX_PROBE_OUTPUT_CHARS = 64 * 1024

/**
 * Strict parse: the whole (trimmed) string must be one version, with an optional
 * `v` prefix. Used for both `.active` directory names and version literals, so a
 * dir name that is anything but a version is reported as unparseable rather than
 * silently normalized into something comparable.
 */
export function parseBinaryVersion(raw: string): ParsedBinaryVersion | null {
  const match = SEMVER_RE.exec(raw.trim())
  if (!match) return null
  const [, majorRaw, minorRaw, patchRaw, prereleaseRaw] = match
  if (majorRaw === undefined || minorRaw === undefined || patchRaw === undefined) return null
  const major = Number(majorRaw)
  const minor = Number(minorRaw)
  const patch = Number(patchRaw)
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null
  }
  return {
    major,
    minor,
    patch,
    prerelease: prereleaseRaw === undefined ? [] : prereleaseRaw.split('.'),
  }
}

/**
 * Semver precedence: numeric fields, then prerelease (a prerelease sorts below
 * its release, numeric identifiers below alphanumeric ones, and a shorter
 * identifier list below a longer one when all shared parts are equal). Build
 * metadata is ignored, as the spec requires.
 */
export function compareBinaryVersions(a: ParsedBinaryVersion, b: ParsedBinaryVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePrerelease(a.prerelease, b.prerelease)
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0
    return a.length === 0 ? 1 : -1
  }
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    const left = a[i]
    const right = b[i]
    if (left === undefined || right === undefined) break
    if (left === right) continue
    const leftNumeric = NUMERIC_RE.test(left)
    const rightNumeric = NUMERIC_RE.test(right)
    if (leftNumeric && rightNumeric) {
      const leftValue = Number(left)
      const rightValue = Number(right)
      if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left < right ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * Extracts the version a binary reports. Each agent has a known banner and falls
 * back to the first semver-looking token anywhere in the output — a wrapper
 * script or a localized banner must not read as "no version" for a binary that
 * plainly printed one. Returns null when nothing parses; callers treat that as
 * "unknown" and skip the floor check rather than guess.
 */
export function parseVersionOutput(id: AgentBinaryId, output: string): string | null {
  const known = (id === 'claude' ? CLAUDE_OUTPUT_RE : CODEX_OUTPUT_RE).exec(output)?.[1]
  if (known !== undefined && parseBinaryVersion(known) !== null) return known
  return firstSemverToken(output)
}

function firstSemverToken(output: string): string | null {
  SEMVER_TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SEMVER_TOKEN_RE.exec(output)) !== null) {
    const before = match.index === 0 ? '' : (output[match.index - 1] ?? '')
    const after = output[match.index + match[0].length] ?? ''
    // `1.2.3` inside `1.2.3.4` or `11.2.3` is a substring, not the version.
    if (NUMERIC_RE.test(before) || before === '.' || NUMERIC_RE.test(after) || after === '.') {
      continue
    }
    if (parseBinaryVersion(match[0]) !== null) return match[0]
  }
  return null
}

export interface ProbeBinaryVersionOptions {
  /** Hard upper bound on the probe; the child is SIGKILLed when it elapses. */
  readonly timeoutMs?: number
}

/**
 * Runs `<binary> --version` and parses the reported version. Never rejects and
 * never throws: a missing file, a non-executable, a hang or unparseable output
 * all resolve to null, because the caller's verdict on an unknown version must
 * be "cannot tell" — killing a working setup over a probe failure would be far
 * worse than skipping one version check.
 */
export function probeBinaryVersion(
  binaryPath: string,
  id: AgentBinaryId,
  options: ProbeBinaryVersionOptions = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  return new Promise<string | null>((resolve) => {
    let settled = false
    let output = ''
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    let child: ChildProcess
    try {
      child =
        process.platform === 'win32' && /\.(cmd|bat)$/i.test(binaryPath)
          ? spawnViaCmd(binaryPath, ['--version'])
          : spawn(binaryPath, ['--version'], {
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            })
    } catch {
      resolve(null)
      return
    }

    // Only ever fires from an event/timer callback, i.e. after this line has run.
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, timeoutMs)

    const collect = (chunk: Buffer): void => {
      if (output.length >= MAX_PROBE_OUTPUT_CHARS) return
      output += chunk.toString('utf8')
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', () => finish(null))
    child.once('close', () => finish(parseVersionOutput(id, output)))
  })
}
