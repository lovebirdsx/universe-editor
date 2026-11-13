/*---------------------------------------------------------------------------------------------
 *  Tests for mainExitForensics.ts — the read side of the exit watchdog. The mapping
 *  must stay conservative: only known NTSTATUS values become native-death, code 1
 *  is the TerminateProcess signature, and anything else is explicitly unknown.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/temp-root'
import { afterEach, describe, expect, it } from 'vitest'
import {
  classifyMainExit,
  formatExitCodeHex,
  MAIN_EXIT_FILE,
  readMainExitRecord,
} from '../mainExitForensics.js'

const SESSION_ID = '20261113T101500'
const tempDirs: string[] = []

function sessionDir(): string {
  const root = mkTempDir('main-exit-')
  tempDirs.push(root)
  const dir = join(root, SESSION_ID)
  mkdirSync(dir)
  return dir
}

function writeRecord(dir: string, value: unknown): void {
  writeFileSync(
    join(dir, MAIN_EXIT_FILE),
    typeof value === 'string' ? value : JSON.stringify(value),
  )
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe('formatExitCodeHex', () => {
  it('keeps NTSTATUS values unsigned and fixed width', () => {
    expect(formatExitCodeHex(0)).toBe('0x00000000')
    expect(formatExitCodeHex(1)).toBe('0x00000001')
    expect(formatExitCodeHex(0xc0000005)).toBe('0xC0000005')
    expect(formatExitCodeHex(-1073741819)).toBe('0xC0000005')
  })
})

describe('classifyMainExit', () => {
  it('maps 0 to clean and 1 to the external TerminateProcess signature', () => {
    expect(classifyMainExit(0).cause).toBe('clean')
    expect(classifyMainExit(1)).toMatchObject({ cause: 'external-terminate' })
  })

  it('names the common crash statuses', () => {
    expect(classifyMainExit(0xc0000005)).toMatchObject({
      cause: 'native-crash',
      statusName: 'STATUS_ACCESS_VIOLATION',
    })
    expect(classifyMainExit(0xc0000409)).toMatchObject({
      cause: 'native-crash',
      statusName: 'STATUS_STACK_BUFFER_OVERRUN',
    })
    expect(classifyMainExit(0xe0000008)).toMatchObject({
      cause: 'native-crash',
      statusName: 'OOM',
    })
  })

  it('does not invent a cause for unrecognised codes', () => {
    expect(classifyMainExit(2)).toMatchObject({ cause: 'unknown', statusName: undefined })
    expect(classifyMainExit(0xdeadbeef).cause).toBe('unknown')
  })
})

describe('readMainExitRecord', () => {
  it('re-derives the hex string from the numeric code', () => {
    const dir = sessionDir()
    writeRecord(dir, { pid: 123, exitCode: 0xc0000005, exitCodeHex: '0xWRONG', exitedAt: 42 })
    expect(readMainExitRecord(dir)).toEqual({
      pid: 123,
      exitCode: 0xc0000005,
      exitCodeHex: '0xC0000005',
      exitedAt: 42,
    })
  })

  it('rejects malformed records instead of partially trusting them', () => {
    for (const value of [
      'not json',
      { pid: 0, exitCode: 1, exitedAt: 1 },
      { pid: 1, exitCode: -1, exitedAt: 1 },
      { pid: 1, exitCode: 0x1_0000_0000, exitedAt: 1 },
      { pid: 1, exitCode: 1, exitedAt: 'now' },
    ]) {
      const dir = sessionDir()
      writeRecord(dir, value)
      expect(readMainExitRecord(dir)).toBeUndefined()
    }
  })

  it('returns undefined for a missing file or a directory name that is not a session id', () => {
    expect(readMainExitRecord(sessionDir())).toBeUndefined()
    const root = mkTempDir('main-exit-')
    tempDirs.push(root)
    const forged = join(root, 'not-a-session-id')
    mkdirSync(forged)
    writeRecord(forged, { pid: 1, exitCode: 1, exitedAt: 1 })
    expect(readMainExitRecord(forged)).toBeUndefined()
  })
})
