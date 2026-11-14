import { describe, expect, it, vi } from 'vitest'
import { URI, WORKSPACE_TRUST_STORAGE_KEY, type ILogger } from '@universe-editor/platform'
import type { Storage } from '../../../storage.js'
import { createWorkspaceTrustProbe } from '../workspaceTrustReader.js'

function logger(): { logger: ILogger; warns: string[] } {
  const warns: string[] = []
  const value = {
    level: 0,
    onDidChangeLogLevel: () => ({ dispose: () => undefined }),
    setLevel: () => undefined,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => warns.push(message),
    error: () => undefined,
    flush: () => undefined,
  } as unknown as ILogger
  return { logger: value, warns }
}

function probeWith(stored: unknown) {
  const { logger: log, warns } = logger()
  const storage = {
    get: vi.fn(async (key: string) => (key === WORKSPACE_TRUST_STORAGE_KEY ? stored : undefined)),
  } as unknown as Pick<Storage, 'get'>
  return { probe: createWorkspaceTrustProbe({ storage, logger: log }), warns, storage }
}

describe('createWorkspaceTrustProbe', () => {
  it('trusts a workspace that equals or nests under a trusted folder', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [{ uri: URI.file('X:/trusted').toJSON(), trusted: true }],
    })
    await expect(probe('X:/trusted')).resolves.toBe(true)
    await expect(probe('X:/trusted/child')).resolves.toBe(true)
    await expect(probe('X:/other')).resolves.toBe(false)
  })

  it('ignores entries persisted with trusted: false and non-file URIs', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [
        { uri: URI.file('X:/revoked').toJSON(), trusted: false },
        { uri: URI.parse('universe:/trusted').toJSON(), trusted: true },
      ],
    })
    await expect(probe('X:/revoked/child')).resolves.toBe(false)
  })

  it('fails closed when the trust list cannot be read', async () => {
    const { logger: log, warns } = logger()
    const storage = {
      get: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
    } as unknown as Pick<Storage, 'get'>
    const probe = createWorkspaceTrustProbe({ storage, logger: log })
    await expect(probe('X:/trusted')).resolves.toBe(false)
    expect(warns.some((line) => line.includes('storage unavailable'))).toBe(true)
  })

  it('treats an absent trust list as untrusted', async () => {
    const { probe } = probeWith(undefined)
    await expect(probe('X:/workspace')).resolves.toBe(false)
  })
})
