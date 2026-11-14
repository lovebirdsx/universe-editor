/*---------------------------------------------------------------------------------------------
 *  Integration test for the real watchdog process (Windows + built addon only):
 *  spawn a dummy target, start the detached child, force-kill the target with
 *  `taskkill /F`, and require the record to carry the real exit code. This is the
 *  one place the native wait, the detached spawn and the atomic write are exercised
 *  together; the pure mapping lives in mainExitForensics.test.ts.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from '@universe-editor/temp-root'
import { afterEach, describe, expect, it } from 'vitest'
import { readMainExitRecord } from '../mainExitForensics.js'
import { startMainExitWatchdog } from '../mainExitWatchdog.js'

const addonPath = join(
  import.meta.dirname,
  '../../../../../packages/process-job/build/Release/process_job.node',
)
const runnable = process.platform === 'win32' && existsSync(addonPath)

const SESSION_ID = '20261113T101500'
const tempDirs: string[] = []

function sessionDir(): string {
  const root = mkTempDir('main-exit-watchdog-')
  tempDirs.push(root)
  return join(root, SESSION_ID)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function requirePid(child: { readonly pid?: number | undefined }): number {
  if (child.pid === undefined) throw new Error('spawned process has no pid')
  return child.pid
}

async function waitForRecord(dir: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const record = readMainExitRecord(dir)
    if (record) return record
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return readMainExitRecord(dir)
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

describe.skipIf(!runnable)('startMainExitWatchdog', () => {
  it('records the exit code of a target killed with taskkill /F', async () => {
    const dir = sessionDir()
    const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    const targetPid = requirePid(target)
    try {
      expect(
        startMainExitWatchdog({
          sessionDir: dir,
          execPath: process.execPath,
          addonPath,
          targetPid,
        }),
      ).toBeDefined()
      // Let the detached child open the target before force-killing it; production
      // starts the watchdog minutes before a death, this is only test-time pressure.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      execFileSync('taskkill', ['/pid', String(targetPid), '/F'], { stdio: 'ignore' })
      const record = await waitForRecord(dir)
      expect(record).toMatchObject({ pid: targetPid, exitCode: 1, exitCodeHex: '0x00000001' })
    } finally {
      if (isAlive(targetPid)) {
        try {
          process.kill(targetPid)
        } catch {}
      }
    }
  })

  it('keeps an NTSTATUS exit code unsigned', async () => {
    const dir = sessionDir()
    // Node's process.exit takes an int32, but Windows gets the unsigned DWORD back —
    // exactly the shape a native access-violation death produces.
    const target = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0xC0000005), 1500)'],
      {
        stdio: 'ignore',
      },
    )
    const targetPid = requirePid(target)
    try {
      expect(
        startMainExitWatchdog({
          sessionDir: dir,
          execPath: process.execPath,
          addonPath,
          targetPid,
        }),
      ).toBeDefined()
      const record = await waitForRecord(dir)
      expect(record).toMatchObject({
        pid: targetPid,
        exitCode: 0xc0000005,
        exitCodeHex: '0xC0000005',
      })
    } finally {
      if (isAlive(targetPid)) {
        try {
          process.kill(targetPid)
        } catch {}
      }
    }
  })

  it('stop reaps the watchdog without recording anything', async () => {
    const dir = sessionDir()
    const target = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    const targetPid = requirePid(target)
    try {
      const watchdog = startMainExitWatchdog({
        sessionDir: dir,
        execPath: process.execPath,
        addonPath,
        targetPid,
      })
      expect(watchdog).toBeDefined()
      // Let the detached child open the target handle, matching the production
      // case where the watchdog has been waiting for the whole session.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const watchdogPid = watchdog?.pid
      await watchdog?.stop()
      expect(watchdogPid === undefined || !isAlive(watchdogPid)).toBe(true)
      // A clean quit: the target is still running, so there is no exit code to record.
      expect(readMainExitRecord(dir)).toBeUndefined()
      expect(isAlive(targetPid)).toBe(true)
    } finally {
      if (isAlive(targetPid)) {
        try {
          process.kill(targetPid)
        } catch {}
      }
    }
  })

  it('stays disabled when the native addon is missing', () => {
    const dir = sessionDir()
    expect(
      startMainExitWatchdog({
        sessionDir: dir,
        execPath: process.execPath,
        addonPath: join(dir, 'missing', 'process_job.node'),
      }),
    ).toBeUndefined()
  })
})
