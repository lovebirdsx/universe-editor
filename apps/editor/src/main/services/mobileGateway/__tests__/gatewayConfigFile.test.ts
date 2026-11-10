/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Machine-local gateway.json parsing, patch validation and file reads.
 *--------------------------------------------------------------------------------------------*/

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mkTempDir } from '@universe-editor/temp-root'
import { DEFAULT_MOBILE_GATEWAY_CONFIG } from '../../../../shared/ipc/mobileGatewayService.js'
import {
  mergeMobileGatewayConfig,
  parseMobileGatewayConfigFile,
  readMobileGatewayConfigFile,
  serializeMobileGatewayConfig,
  validateMobileGatewayConfigPatch,
} from '../gatewayConfigFile.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile(content?: string): Promise<string> {
  const dir = mkTempDir('ue-mobile-gateway-config-')
  dirs.push(dir)
  const file = join(dir, 'gateway.json')
  if (content !== undefined) await writeFile(file, content, 'utf8')
  return file
}

describe('parseMobileGatewayConfigFile', () => {
  it('uses defaults for an empty object and ignores unknown fields', () => {
    expect(parseMobileGatewayConfigFile({})).toEqual({
      ok: true,
      config: DEFAULT_MOBILE_GATEWAY_CONFIG,
    })
    expect(parseMobileGatewayConfigFile({ futureField: true })).toEqual({
      ok: true,
      config: DEFAULT_MOBILE_GATEWAY_CONFIG,
    })
  })

  it('accepts a partial config and trims string values', () => {
    expect(
      parseMobileGatewayConfigFile({
        enabled: true,
        bind: 'lan',
        lanAddress: '  192.0.2.20  ',
        port: 48000,
        allowedHosts: ['  pc.example.ts.net  '],
        certificateMode: 'root-ca',
        vapidSubject: '  mailto:dev@example.com  ',
        sessionHistoryWorkspaceLimit: 12,
      }),
    ).toEqual({
      ok: true,
      config: {
        enabled: true,
        bind: 'lan',
        lanAddress: '192.0.2.20',
        port: 48000,
        allowedHosts: ['pc.example.ts.net'],
        certificateMode: 'root-ca',
        vapidSubject: 'mailto:dev@example.com',
        sessionHistoryWorkspaceLimit: 12,
      },
    })
  })

  it('rejects a non-object document', () => {
    expect(parseMobileGatewayConfigFile(null)).toMatchObject({ ok: false })
    expect(parseMobileGatewayConfigFile([])).toMatchObject({ ok: false })
    expect(parseMobileGatewayConfigFile('{}')).toMatchObject({ ok: false })
  })

  it.each([
    [{ enabled: 'true' }, '"enabled" must be a boolean'],
    [{ bind: 'public' }, '"bind" must be "loopback" or "lan"'],
    [{ lanAddress: 42 }, '"lanAddress" must be a string'],
    [{ port: 0 }, '"port" must be an integer between 1 and 65535'],
    [{ port: 70000 }, '"port" must be an integer between 1 and 65535'],
    [{ port: '47321' }, '"port" must be an integer between 1 and 65535'],
    [{ allowedHosts: [1] }, '"allowedHosts" contains an invalid host name'],
    [{ allowedHosts: [''] }, '"allowedHosts" contains an invalid host name'],
    [{ allowedHosts: 'pc.example.ts.net' }, '"allowedHosts" must be an array'],
    [{ certificateMode: 'ca' }, '"certificateMode" must be "self-signed" or "root-ca"'],
    [{ vapidSubject: 'http://example.com' }, '"vapidSubject" must be an https'],
    [
      { sessionHistoryWorkspaceLimit: 0 },
      '"sessionHistoryWorkspaceLimit" must be an integer between 1 and 100',
    ],
    [
      { sessionHistoryWorkspaceLimit: 101 },
      '"sessionHistoryWorkspaceLimit" must be an integer between 1 and 100',
    ],
    [
      { sessionHistoryWorkspaceLimit: 1.5 },
      '"sessionHistoryWorkspaceLimit" must be an integer between 1 and 100',
    ],
    [
      { sessionHistoryWorkspaceLimit: '20' },
      '"sessionHistoryWorkspaceLimit" must be an integer between 1 and 100',
    ],
  ])('rejects invalid known fields: %j', (raw, message) => {
    const result = parseMobileGatewayConfigFile(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join('; ')).toContain(message)
  })

  it('rejects more than 16 allowed hosts', () => {
    const result = parseMobileGatewayConfigFile({
      allowedHosts: Array.from({ length: 17 }, (_, index) => `pc${index}.example.ts.net`),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('at most 16 entries')
  })
})

describe('validateMobileGatewayConfigPatch', () => {
  it('accepts an empty patch', () => {
    expect(validateMobileGatewayConfigPatch({})).toEqual({ ok: true, patch: {} })
  })

  it('rejects unknown fields and null values', () => {
    const unknown = validateMobileGatewayConfigPatch({ futureField: true })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.errors[0]).toContain('unknown config field')

    const nullPort = validateMobileGatewayConfigPatch({ port: null })
    expect(nullPort.ok).toBe(false)
  })

  it('drops undefined fields and trims accepted values', () => {
    expect(
      validateMobileGatewayConfigPatch({
        enabled: undefined,
        lanAddress: '  192.0.2.20 ',
        allowedHosts: [' pc.example.ts.net '],
        certificateMode: 'root-ca',
        sessionHistoryWorkspaceLimit: 8,
      }),
    ).toEqual({
      ok: true,
      patch: {
        lanAddress: '192.0.2.20',
        allowedHosts: ['pc.example.ts.net'],
        certificateMode: 'root-ca',
        sessionHistoryWorkspaceLimit: 8,
      },
    })
  })
})

describe('mergeMobileGatewayConfig', () => {
  it('only replaces fields present in the patch', () => {
    const base = { ...DEFAULT_MOBILE_GATEWAY_CONFIG, enabled: true, port: 48000 }
    expect(mergeMobileGatewayConfig(base, { bind: 'lan' })).toEqual({ ...base, bind: 'lan' })
    expect(mergeMobileGatewayConfig(base, { port: 49000 })).toEqual({ ...base, port: 49000 })
    expect(mergeMobileGatewayConfig(base, { allowedHosts: [] })).toEqual({
      ...base,
      allowedHosts: [],
    })
    expect(mergeMobileGatewayConfig(base, { certificateMode: 'root-ca' })).toEqual({
      ...base,
      certificateMode: 'root-ca',
    })
  })
})

describe('serializeMobileGatewayConfig', () => {
  it('round-trips and uses a stable key order', () => {
    const config = {
      ...DEFAULT_MOBILE_GATEWAY_CONFIG,
      enabled: true,
      allowedHosts: ['pc.example.ts.net'],
    }
    const serialized = serializeMobileGatewayConfig(config)
    expect(serialized).toEqual(config)
    expect(serialized).not.toBe(config)
    expect(Object.keys(serialized)).toEqual([
      'enabled',
      'bind',
      'lanAddress',
      'port',
      'allowedHosts',
      'certificateMode',
      'vapidSubject',
      'sessionHistoryWorkspaceLimit',
    ])
  })
})

describe('readMobileGatewayConfigFile', () => {
  it('reports a missing file without creating it', async () => {
    const file = await tempFile()
    expect(await readMobileGatewayConfigFile(file)).toEqual({ kind: 'missing' })
  })

  it('treats an empty file as defaults', async () => {
    const file = await tempFile('   \n')
    expect(await readMobileGatewayConfigFile(file)).toEqual({
      kind: 'ok',
      config: DEFAULT_MOBILE_GATEWAY_CONFIG,
    })
  })

  it('accepts JSONC comments, trailing commas and a BOM', async () => {
    const file = await tempFile('﻿{\n  // machine-local\n  "enabled": true,\n  "port": 48000,\n}\n')
    expect(await readMobileGatewayConfigFile(file)).toEqual({
      kind: 'ok',
      config: { ...DEFAULT_MOBILE_GATEWAY_CONFIG, enabled: true, port: 48000 },
    })
  })

  it('reports invalid JSON with an offset', async () => {
    const file = await tempFile('{ "enabled": ')
    const result = await readMobileGatewayConfigFile(file)
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toContain('not valid JSON')
  })

  it('reports invalid known fields', async () => {
    const file = await tempFile('{ "port": 0 }')
    const result = await readMobileGatewayConfigFile(file)
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') expect(result.error).toContain('"port"')
  })
})
