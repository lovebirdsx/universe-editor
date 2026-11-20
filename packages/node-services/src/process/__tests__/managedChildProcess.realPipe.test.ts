/*---------------------------------------------------------------------------------------------
 *  Real-pipe backpressure for ManagedChildProcess.writeStdin: a child that does not read its
 *  stdin must make writes park on 'drain', and they must settle once it starts reading.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { ManagedChildProcess } from '../managedChildProcess.js'

// Leaves stdin unread for argv[1] ms (the timer keeps it alive meanwhile), then drains and reports.
const SLOW_READER = `
let total = 0
setTimeout(() => {
  process.stdin.on('data', (c) => { total += c.length })
  process.stdin.on('end', () => { process.stdout.write('total=' + total) })
  process.stdin.resume()
}, Number(process.argv[1]))
`

const CHUNK = 'x'.repeat(256 * 1024)

describe('ManagedChildProcess real-pipe backpressure', () => {
  it('parks writes while the child does not read and settles them once it does', async () => {
    const holdMs = 600
    const child = spawn(process.execPath, ['-e', SLOW_READER, String(holdMs)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    const managed = new ManagedChildProcess(child)
    let stdout = ''
    managed.onStdout((b) => (stdout += b.toString('utf8')))
    const exited = new Promise<void>((r) => managed.onDidExit(() => r()))

    const start = Date.now()
    const settledAt: number[] = []
    const writes: Promise<void>[] = []
    // 32 × 256KiB = 8MiB, far past any OS pipe buffer, so most writes must wait.
    for (let i = 0; i < 32; i++) {
      writes.push(managed.writeStdin(CHUNK).then(() => void settledAt.push(Date.now() - start)))
    }

    await new Promise((r) => setTimeout(r, holdMs / 2))
    const settledWhilePaused = settledAt.length
    expect(settledWhilePaused).toBeLessThan(writes.length)

    await Promise.all(writes)
    expect(Math.max(...settledAt)).toBeGreaterThanOrEqual(holdMs - 50)
    managed.endStdin()
    await exited
    expect(stdout.trim()).toBe(`total=${CHUNK.length * writes.length}`)
    managed.dispose()
  }, 20_000)
})
