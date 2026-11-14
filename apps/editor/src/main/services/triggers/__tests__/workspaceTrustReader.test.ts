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

function remote(authority: string, path: string): string {
  return URI.from({ scheme: 'remote-ssh', authority, path }).toString()
}

describe('createWorkspaceTrustProbe', () => {
  it('trusts a workspace that equals or nests under a trusted folder', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [{ uri: URI.file('X:/trusted').toJSON(), trusted: true }],
    })
    await expect(probe(URI.file('X:/trusted').toString())).resolves.toBe(true)
    await expect(probe(URI.file('X:/trusted/child').toString())).resolves.toBe(true)
    await expect(probe(URI.file('X:/other').toString())).resolves.toBe(false)
  })

  it('trusts a remote workspace nested under a trusted remote folder of the same authority', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [{ uri: URI.parse(remote('dev', '/home/testuser')).toJSON(), trusted: true }],
    })
    await expect(probe(remote('dev', '/home/testuser'))).resolves.toBe(true)
    await expect(probe(remote('dev', '/home/testuser/proj'))).resolves.toBe(true)
    await expect(probe(remote('dev', '/home/testuser2'))).resolves.toBe(false)
  })

  it('requires the same remote authority', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [{ uri: URI.parse(remote('dev', '/home/testuser')).toJSON(), trusted: true }],
    })
    await expect(probe(remote('other', '/home/testuser/proj'))).resolves.toBe(false)
  })

  it('compares remote paths case-sensitively (remote filesystem semantics)', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [{ uri: URI.parse(remote('dev', '/home/TestUser')).toJSON(), trusted: true }],
    })
    await expect(probe(remote('dev', '/home/TestUser/proj'))).resolves.toBe(true)
    await expect(probe(remote('dev', '/home/testuser/proj'))).resolves.toBe(false)
  })

  it('does not mix local and remote trust records', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [{ uri: URI.parse(remote('dev', '/home/testuser')).toJSON(), trusted: true }],
    })
    await expect(probe(URI.file('X:/home/testuser').toString())).resolves.toBe(false)
  })

  it('ignores entries persisted with trusted: false and unsupported URIs', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [
        { uri: URI.file('X:/revoked').toJSON(), trusted: false },
        { uri: URI.parse('universe:/trusted').toJSON(), trusted: true },
      ],
    })
    await expect(probe(URI.file('X:/revoked/child').toString())).resolves.toBe(false)
  })

  it('treats an unparseable workspace as untrusted', async () => {
    const { probe } = probeWith({
      uriTrustInfo: [{ uri: URI.file('X:/trusted').toJSON(), trusted: true }],
    })
    await expect(probe('relative/path')).resolves.toBe(false)
    await expect(probe('')).resolves.toBe(false)
  })

  it('fails closed when the trust list cannot be read', async () => {
    const { logger: log, warns } = logger()
    const storage = {
      get: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
    } as unknown as Pick<Storage, 'get'>
    const probe = createWorkspaceTrustProbe({ storage, logger: log })
    await expect(probe(URI.file('X:/trusted').toString())).resolves.toBe(false)
    expect(warns.some((line) => line.includes('storage unavailable'))).toBe(true)
  })

  it('treats an absent trust list as untrusted', async () => {
    const { probe } = probeWith(undefined)
    await expect(probe(URI.file('X:/workspace').toString())).resolves.toBe(false)
  })
})
