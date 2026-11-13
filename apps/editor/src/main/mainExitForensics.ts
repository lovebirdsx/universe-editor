/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Read-side counterpart of the main-process exit watchdog. The watchdog leaves a
 *  single `main-exit.json` in the dead session's log directory; on the next launch
 *  that DWORD exit code is the only witness able to separate an external
 *  TerminateProcess (code 1) from a native crash (NTSTATUS) and from a machine that
 *  never gave the watchdog a chance to write (tree kill / shutdown / power loss).
 *
 *  Pure parsing + classification: no electron import, no logging, and never throws
 *  on the startup path. The written hex string is re-derived from the numeric code
 *  so a truncated/hand-edited file cannot make decimal and hex disagree.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { SESSION_DIR_NAME_RE } from './exitSceneForensics.js'

export const MAIN_EXIT_FILE = 'main-exit.json'

export interface MainExitRecord {
  readonly pid: number
  /** Raw `GetExitCodeProcess` DWORD, kept unsigned so NTSTATUS values survive. */
  readonly exitCode: number
  /** `0xC0000005` — the shape people paste into bug reports. */
  readonly exitCodeHex: string
  /** Local epoch ms at which the watchdog observed the process gone. */
  readonly exitedAt: number
}

export type MainExitCause = 'clean' | 'external-terminate' | 'native-crash' | 'unknown'

export interface MainExitAttribution {
  readonly cause: MainExitCause
  /** Symbolic NTSTATUS name when the code is a known crash status. */
  readonly statusName: string | undefined
  /** One safe phrase naming what the code means; contains no paths or user data. */
  readonly description: string
}

export function formatExitCodeHex(exitCode: number): string {
  const value = exitCode >>> 0
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * `TerminateProcess` called with no explicit code (Task Manager, `taskkill /F`,
 * several antivirus products) reports 1. A process that calls `process.exit(1)`
 * and skips the shutdown path looks the same, which is why the forensic text says
 * "consistent with" rather than proving the killer.
 */
const EXTERNAL_TERMINATE_CODE = 1

interface KnownStatus {
  readonly name: string
  readonly description: string
}

// The handful of statuses that show up in real Electron main-process deaths.
// 0xE0000008 is the OOM termination Chromium's Windows builds surface; keep the
// label explicit so a reader does not mistake it for a documented NTSTATUS.
const KNOWN_NTSTATUS = new Map<number, KnownStatus>([
  [
    0xc0000005,
    { name: 'STATUS_ACCESS_VIOLATION', description: 'access violation (invalid memory access)' },
  ],
  [0xc00000fd, { name: 'STATUS_STACK_OVERFLOW', description: 'stack overflow' }],
  [
    0xc0000409,
    {
      name: 'STATUS_STACK_BUFFER_OVERRUN',
      description:
        'stack buffer overrun / __fastfail (e.g. control-flow or security check failure)',
    },
  ],
  [0xc0000374, { name: 'STATUS_HEAP_CORRUPTION', description: 'heap corruption' }],
  [0xc000001d, { name: 'STATUS_ILLEGAL_INSTRUCTION', description: 'illegal instruction' }],
  [0xc0000094, { name: 'STATUS_INTEGER_DIVIDE_BY_ZERO', description: 'integer divide by zero' }],
  [0xc0000006, { name: 'STATUS_IN_PAGE_ERROR', description: 'in-page I/O error' }],
  [0xc0000017, { name: 'STATUS_NO_MEMORY', description: 'out of memory (status)' }],
  [0xc0000602, { name: 'STATUS_FAIL_FAST_EXCEPTION', description: 'fail-fast exception' }],
  [0xc0000420, { name: 'STATUS_ASSERTION_FAILURE', description: 'assertion failure' }],
  [0xc0000135, { name: 'STATUS_DLL_NOT_FOUND', description: 'required DLL not found' }],
  [0xc0000142, { name: 'STATUS_DLL_INIT_FAILED', description: 'DLL initialization failed' }],
  [0xe0000008, { name: 'OOM', description: 'out of memory (Chromium OOM termination)' }],
])

/**
 * Map the watchdog's exit code to a cause. `unknown` is a real answer: inventing a
 * cause for an unrecognised nonzero code is exactly the over-attribution this
 * module exists to avoid.
 */
export function classifyMainExit(exitCode: number): MainExitAttribution {
  const value = exitCode >>> 0
  if (value === 0) {
    return {
      cause: 'clean',
      statusName: undefined,
      description: 'exit code 0 — the process returned no error code',
    }
  }
  if (value === EXTERNAL_TERMINATE_CODE) {
    return {
      cause: 'external-terminate',
      statusName: undefined,
      description:
        'TerminateProcess without an explicit code (Task Manager, taskkill /F, antivirus)',
    }
  }
  const known = KNOWN_NTSTATUS.get(value)
  if (known) {
    return { cause: 'native-crash', statusName: known.name, description: known.description }
  }
  return {
    cause: 'unknown',
    statusName: undefined,
    description: 'not a known crash status or external-termination code',
  }
}

/**
 * Read the previous session's watchdog record. The directory name is re-checked
 * because the id comes from a file on disk; malformed shapes are treated as "no
 * record" rather than partially trusted. Never throws.
 */
export function readMainExitRecord(sessionDir: string): MainExitRecord | undefined {
  if (!SESSION_DIR_NAME_RE.test(basename(sessionDir))) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(sessionDir, MAIN_EXIT_FILE), 'utf8'))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Partial<Record<keyof MainExitRecord, unknown>>
  if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return undefined
  if (
    typeof raw.exitCode !== 'number' ||
    !Number.isInteger(raw.exitCode) ||
    raw.exitCode < 0 ||
    raw.exitCode > 0xffffffff
  ) {
    return undefined
  }
  if (typeof raw.exitedAt !== 'number' || !Number.isFinite(raw.exitedAt)) return undefined
  return {
    pid: raw.pid,
    exitCode: raw.exitCode >>> 0,
    exitCodeHex: formatExitCodeHex(raw.exitCode),
    exitedAt: raw.exitedAt,
  }
}
