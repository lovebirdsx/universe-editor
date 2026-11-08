import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import { AuditLog } from '../auditLog.js'

describe('AuditLog', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkTempDir('ue-mobile-gateway-')
    file = join(dir, 'mobile', 'audit.jsonl')
  })

  afterEach(() => {
    removeDirWithRetry(dir)
  })

  it('appends entries and returns the most recent ones oldest-first', async () => {
    let now = 1_000
    const log = new AuditLog(file, { now: () => now++ })
    await log.append({ action: 'pairing_started', result: 'success' })
    await log.append({ deviceId: 'd1', action: 'device_connected', result: 'success' })
    await log.append({
      deviceId: 'd1',
      action: 'device_revoked',
      result: 'failure',
      detail: 'device not found',
    })

    const recent = await log.recent(2)
    expect(recent).toHaveLength(2)
    expect(recent[0]?.action).toBe('device_connected')
    expect(recent[1]?.action).toBe('device_revoked')
    expect(recent[1]?.detail).toBe('device not found')
  })

  it('rotates to audit.jsonl.1 and still reads across the rotation', async () => {
    const log = new AuditLog(file, { now: () => 1_000, maxBytes: 220 })
    for (let index = 0; index < 8; index += 1) {
      await log.append({
        deviceId: `device-${index}`,
        action: 'device_connected',
        result: 'success',
      })
    }
    await expect(fs.stat(`${file}.1`)).resolves.toBeDefined()
    const recent = await log.recent(20)
    expect(recent.length).toBeGreaterThan(0)
    expect(recent.at(-1)?.deviceId).toBe('device-7')
  })

  it('keeps a bounded number of rotated generations', async () => {
    const log = new AuditLog(file, { now: () => 1_000, maxBytes: 200, maxFiles: 2 })
    for (let index = 0; index < 30; index += 1) {
      await log.append({
        deviceId: `device-${index}`,
        action: 'device_connected',
        result: 'success',
      })
    }
    await expect(fs.stat(`${file}.1`)).resolves.toBeDefined()
    await expect(fs.stat(`${file}.2`)).resolves.toBeDefined()
    await expect(fs.stat(`${file}.3`)).rejects.toMatchObject({ code: 'ENOENT' })

    const recent = await log.recent(200)
    expect(recent.at(-1)?.deviceId).toBe('device-29')
    const ids = recent.map((entry) => entry.deviceId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('skips malformed lines instead of failing reads', async () => {
    const log = new AuditLog(file)
    await log.append({ action: 'gateway_start', result: 'success' })
    await fs.appendFile(file, 'not json\n', 'utf8')
    await log.append({ action: 'gateway_stop', result: 'success' })

    const recent = await log.recent(10)
    expect(recent.map((entry) => entry.action)).toEqual(['gateway_start', 'gateway_stop'])
  })

  it('clamps read limits to at least one entry', async () => {
    const log = new AuditLog(file)
    await log.append({ action: 'gateway_start', result: 'success' })
    await log.append({ action: 'gateway_stop', result: 'success' })
    const recent = await log.recent(0)
    expect(recent).toHaveLength(1)
  })
})
