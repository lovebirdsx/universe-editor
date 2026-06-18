import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  NullLogger,
  URI,
  type IFileService,
} from '@universe-editor/platform'
import type {
  IRemoteSchemaService,
  RemoteSchemaResult,
} from '../../../../shared/ipc/remoteSchemaService.js'
import {
  DEFAULT_TRUSTED_SCHEMA_DOMAINS,
  isTrustedSchemaUrl,
  resolveSchemaFromUrl,
  SCHEMA_DOWNLOAD_ENABLE_KEY,
  SCHEMA_DOWNLOAD_TRUSTED_DOMAINS_KEY,
} from '../schemaUrlResolver.js'

describe('isTrustedSchemaUrl', () => {
  it('always trusts a non-http(s) local path', () => {
    expect(isTrustedSchemaUrl('/etc/schema.json', {})).toBe(true)
    expect(isTrustedSchemaUrl('./schemas/x.json', {})).toBe(true)
  })

  it('trusts an http(s) url matching a trusted prefix (case-insensitive)', () => {
    expect(
      isTrustedSchemaUrl(
        'https://JSON.SchemaStore.org/claude-code-settings.json',
        DEFAULT_TRUSTED_SCHEMA_DOMAINS,
      ),
    ).toBe(true)
  })

  it('rejects an http(s) url not in the trusted list', () => {
    expect(isTrustedSchemaUrl('https://evil.example/s.json', DEFAULT_TRUSTED_SCHEMA_DOMAINS)).toBe(
      false,
    )
  })

  it('ignores a prefix mapped to false', () => {
    expect(isTrustedSchemaUrl('https://x.test/s.json', { 'https://x.test/': false })).toBe(false)
  })
})

function deps(overrides: {
  config?: ConfigurationService
  files?: Record<string, string>
  fetch?: (url: string) => Promise<RemoteSchemaResult>
}) {
  const configuration = overrides.config ?? new ConfigurationService()
  const fileService = {
    readFileText: async (resource: URI) => {
      const text = overrides.files?.[resource.fsPath]
      if (text === undefined) throw new Error(`ENOENT: ${resource.fsPath}`)
      return text
    },
  } as unknown as IFileService
  const remoteSchema = {
    fetchSchema:
      overrides.fetch ?? (async () => ({ ok: false, error: 'no mock' }) as RemoteSchemaResult),
  } as IRemoteSchemaService
  return { configuration, fileService, remoteSchema, logger: new NullLogger() }
}

describe('resolveSchemaFromUrl', () => {
  it('reads + parses a local file', async () => {
    const path = URI.file('/schemas/x.json').fsPath
    const d = deps({ files: { [path]: JSON.stringify({ type: 'object' }) } })
    expect(await resolveSchemaFromUrl('/schemas/x.json', d, 'test')).toEqual({ type: 'object' })
  })

  it('downloads a trusted http url through the remote service', async () => {
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    const d = deps({ fetch: async () => ({ ok: true, content: JSON.stringify({ title: 'x' }) }) })
    expect(await resolveSchemaFromUrl(url, d, 'test')).toEqual({ title: 'x' })
  })

  it('returns undefined for an untrusted http url without calling fetch', async () => {
    const fetch = vi.fn(async () => ({ ok: true, content: '{}' }) as RemoteSchemaResult)
    const d = deps({ fetch })
    expect(await resolveSchemaFromUrl('https://evil.example/s.json', d, 'test')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns undefined when schema download is disabled', async () => {
    const config = new ConfigurationService()
    config.update(SCHEMA_DOWNLOAD_ENABLE_KEY, false, ConfigurationTarget.User)
    const fetch = vi.fn(async () => ({ ok: true, content: '{}' }) as RemoteSchemaResult)
    const d = deps({ config, fetch })
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    expect(await resolveSchemaFromUrl(url, d, 'test')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns undefined when the download fails', async () => {
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    const d = deps({ fetch: async () => ({ ok: false, error: 'HTTP 500' }) })
    expect(await resolveSchemaFromUrl(url, d, 'test')).toBeUndefined()
  })

  it('returns undefined when the downloaded content is not valid JSON', async () => {
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    const d = deps({ fetch: async () => ({ ok: true, content: '<html>' }) })
    expect(await resolveSchemaFromUrl(url, d, 'test')).toBeUndefined()
  })

  it('still trusts built-in defaults when the user adds only custom domains', async () => {
    const config = new ConfigurationService()
    config.update(
      SCHEMA_DOWNLOAD_TRUSTED_DOMAINS_KEY,
      { 'https://unpkg.com/': true },
      ConfigurationTarget.User,
    )
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    const d = deps({
      config,
      fetch: async () => ({ ok: true, content: JSON.stringify({ ok: 1 }) }),
    })
    expect(await resolveSchemaFromUrl(url, d, 'test')).toEqual({ ok: 1 })
  })

  it('lets the user explicitly distrust a built-in default domain', async () => {
    const config = new ConfigurationService()
    config.update(
      SCHEMA_DOWNLOAD_TRUSTED_DOMAINS_KEY,
      { 'https://json.schemastore.org/': false },
      ConfigurationTarget.User,
    )
    const fetch = vi.fn(async () => ({ ok: true, content: '{}' }) as RemoteSchemaResult)
    const d = deps({ config, fetch })
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    expect(await resolveSchemaFromUrl(url, d, 'test')).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})
