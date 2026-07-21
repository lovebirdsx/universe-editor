/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/sessionSentinel.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  armSessionSentinel,
  disarmSessionSentinel,
  findCrashDumpsSince,
  readAbnormalExitReport,
  _resetSentinelForTests,
} from '../sessionSentinel.js'

describe('sessionSentinel', () => {
  let userDataDir: string
  let crashDumpsDir: string

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'ue-sentinel-'))
    crashDumpsDir = join(userDataDir, 'Crashes')
    _resetSentinelForTests()
  })

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true })
  })

  it('reports nothing when no sentinel exists', () => {
    expect(readAbnormalExitReport(userDataDir, crashDumpsDir)).toBeUndefined()
  })

  it('a leftover sentinel is reported as an abnormal exit with the previous session id', () => {
    armSessionSentinel(userDataDir, '20260721T164939')
    const report = readAbnormalExitReport(userDataDir, crashDumpsDir)
    expect(report?.previousSessionId).toBe('20260721T164939')
    expect(report?.crashDumps).toEqual([])
  })

  it('disarm removes the sentinel so the next launch reports nothing', () => {
    armSessionSentinel(userDataDir, 'session-a')
    disarmSessionSentinel(userDataDir)
    expect(readAbnormalExitReport(userDataDir, crashDumpsDir)).toBeUndefined()
  })

  it('disarm without arming leaves an existing sentinel intact (second-instance guard)', async () => {
    await fs.writeFile(
      join(userDataDir, 'session-sentinel.json'),
      JSON.stringify({ sessionId: 'primary', startedAt: Date.now() }),
    )
    disarmSessionSentinel(userDataDir)
    expect(readAbnormalExitReport(userDataDir, crashDumpsDir)?.previousSessionId).toBe('primary')
  })

  it('an unparsable or malformed sentinel yields no report', async () => {
    const path = join(userDataDir, 'session-sentinel.json')
    await fs.writeFile(path, '{torn')
    expect(readAbnormalExitReport(userDataDir, crashDumpsDir)).toBeUndefined()
    await fs.writeFile(path, JSON.stringify({ sessionId: 42 }))
    expect(readAbnormalExitReport(userDataDir, crashDumpsDir)).toBeUndefined()
  })

  it('associates nested crash dumps written after the session started, skipping older ones', async () => {
    const reportsDir = join(crashDumpsDir, 'reports')
    await fs.mkdir(reportsDir, { recursive: true })
    const fresh = join(reportsDir, 'fresh.dmp')
    const stale = join(reportsDir, 'stale.dmp')
    const unrelated = join(reportsDir, 'notes.txt')
    await fs.writeFile(fresh, 'x')
    await fs.writeFile(stale, 'x')
    await fs.writeFile(unrelated, 'x')
    const old = new Date(Date.now() - 60 * 60 * 1000)
    await fs.utimes(stale, old, old)

    const found = findCrashDumpsSince(crashDumpsDir, Date.now() - 5 * 60 * 1000)
    expect(found).toEqual([fresh])
  })

  it('a missing crash dumps directory yields an empty dump list', () => {
    armSessionSentinel(userDataDir, 'session-b')
    const report = readAbnormalExitReport(userDataDir, join(userDataDir, 'nope'))
    expect(report?.crashDumps).toEqual([])
  })
})
