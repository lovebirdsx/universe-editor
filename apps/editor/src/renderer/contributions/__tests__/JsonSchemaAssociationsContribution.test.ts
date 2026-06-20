import { afterEach, describe, expect, it } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  DisposableStore,
  DisposableTracker,
  JSONContributionRegistry,
  LogLevel,
  markAsSingleton,
  NullLogger,
  setDisposableTracker,
  URI,
  type IFileService,
  type ILoggerService,
} from '@universe-editor/platform'
import type {
  IRemoteSchemaService,
  RemoteSchemaResult,
} from '../../../shared/ipc/remoteSchemaService.js'
import { JsonSchemaAssociationsContribution } from '../JsonSchemaAssociationsContribution.js'

function fakeFileService(files: Record<string, string>): IFileService {
  return {
    readFileText: async (resource: URI) => {
      const text = files[resource.fsPath] ?? files[resource.path]
      if (text === undefined) throw new Error(`ENOENT: ${resource.fsPath}`)
      return text
    },
  } as unknown as IFileService
}

function fakeRemoteSchema(byUrl: Record<string, string>): IRemoteSchemaService {
  return {
    fetchSchema: async (url: string): Promise<RemoteSchemaResult> => {
      const content = byUrl[url]
      if (content === undefined) return { ok: false, error: `no mock for ${url}` }
      return { ok: true, content }
    },
  } as IRemoteSchemaService
}

/** Let the contribution's queued microtask + async refresh settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function userContribs() {
  return JSONContributionRegistry.getContributions().filter((c) => c.uri.startsWith('user://'))
}

describe('JsonSchemaAssociationsContribution', () => {
  const disposables: { dispose(): void }[] = []
  afterEach(() => {
    for (const d of disposables.splice(0)) d.dispose()
  })

  it('registers an inline user json.schemas entry', async () => {
    const config = new ConfigurationService()
    config.update(
      'json.schemas',
      [{ fileMatch: ['**/*.foo.json'], schema: { type: 'object' } }],
      ConfigurationTarget.User,
    )
    const c = new JsonSchemaAssociationsContribution(
      config,
      fakeFileService({}),
      undefined as never,
      undefined as never,
    )
    disposables.push(c)
    await settle()

    const entry = userContribs()[0]
    expect(entry?.fileMatch).toEqual(['**/*.foo.json'])
    expect(entry?.schema).toEqual({ type: 'object' })
  })

  it('reads a local schema file for a url entry', async () => {
    const config = new ConfigurationService()
    config.update(
      'json.schemas',
      [{ fileMatch: ['**/*.bar.json'], url: '/schemas/bar.json' }],
      ConfigurationTarget.User,
    )
    const fs = fakeFileService({
      [URI.file('/schemas/bar.json').fsPath]: JSON.stringify({ type: 'array' }),
    })
    const c = new JsonSchemaAssociationsContribution(
      config,
      fs,
      undefined as never,
      undefined as never,
    )
    disposables.push(c)
    await settle()

    expect(userContribs()[0]?.schema).toEqual({ type: 'array' })
  })

  it('skips an entry whose url cannot be read', async () => {
    const config = new ConfigurationService()
    config.update(
      'json.schemas',
      [{ fileMatch: ['**/*.bar.json'], url: '/missing.json' }],
      ConfigurationTarget.User,
    )
    const c = new JsonSchemaAssociationsContribution(
      config,
      fakeFileService({}),
      undefined as never,
      undefined as never,
    )
    disposables.push(c)
    await settle()

    expect(userContribs()).toHaveLength(0)
  })

  it('re-derives on json.schemas change, clearing the previous entries', async () => {
    const config = new ConfigurationService()
    config.update(
      'json.schemas',
      [{ fileMatch: ['**/*.a.json'], schema: { type: 'object' } }],
      ConfigurationTarget.User,
    )
    const c = new JsonSchemaAssociationsContribution(
      config,
      fakeFileService({}),
      undefined as never,
      undefined as never,
    )
    disposables.push(c)
    await settle()
    expect(userContribs()).toHaveLength(1)

    config.update('json.schemas', [], ConfigurationTarget.User)
    await settle()
    expect(userContribs()).toHaveLength(0)
  })

  it('downloads a trusted http(s) url through the remote service', async () => {
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    const config = new ConfigurationService()
    config.update('json.schemas', [{ fileMatch: ['**/*.c.json'], url }], ConfigurationTarget.User)
    const remote = fakeRemoteSchema({ [url]: JSON.stringify({ type: 'object', title: 'claude' }) })
    const c = new JsonSchemaAssociationsContribution(
      config,
      fakeFileService({}),
      remote,
      undefined as never,
    )
    disposables.push(c)
    await settle()

    expect(userContribs()[0]?.schema).toEqual({ type: 'object', title: 'claude' })
  })

  it('skips an http(s) url when schema download is disabled', async () => {
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    const config = new ConfigurationService()
    config.update('json.schemaDownload.enable', false, ConfigurationTarget.User)
    config.update('json.schemas', [{ fileMatch: ['**/*.c.json'], url }], ConfigurationTarget.User)
    const remote = fakeRemoteSchema({ [url]: JSON.stringify({ type: 'object' }) })
    const c = new JsonSchemaAssociationsContribution(
      config,
      fakeFileService({}),
      remote,
      undefined as never,
    )
    disposables.push(c)
    await settle()

    expect(userContribs()).toHaveLength(0)
  })

  it('skips an http(s) url that is not in the trusted domains list', async () => {
    const url = 'https://evil.example/schema.json'
    const config = new ConfigurationService()
    config.update('json.schemas', [{ fileMatch: ['**/*.c.json'], url }], ConfigurationTarget.User)
    const remote = fakeRemoteSchema({ [url]: JSON.stringify({ type: 'object' }) })
    const c = new JsonSchemaAssociationsContribution(
      config,
      fakeFileService({}),
      remote,
      undefined as never,
    )
    disposables.push(c)
    await settle()

    expect(userContribs()).toHaveLength(0)
  })

  it('does not register a user schema resolved after disposal', async () => {
    const url = 'https://json.schemastore.org/claude-code-settings.json'
    const config = new ConfigurationService()
    config.update('json.schemas', [{ fileMatch: ['**/*.c.json'], url }], ConfigurationTarget.User)

    // A remote service whose fetch we resolve manually, to interleave disposal
    // between the await and the registration.
    let release!: (r: RemoteSchemaResult) => void
    const pending = new Promise<RemoteSchemaResult>((r) => {
      release = r
    })
    const remote = { fetchSchema: () => pending } as unknown as IRemoteSchemaService
    const c = new JsonSchemaAssociationsContribution(
      config,
      fakeFileService({}),
      remote,
      undefined as never,
    )
    await settle()
    c.dispose()
    release({ ok: true, content: JSON.stringify({ type: 'object' }) })
    await settle()

    expect(userContribs()).toHaveLength(0)
  })

  it('keeps user schema handles in the disposable parent chain (no leak while alive)', async () => {
    // Regression: user-schema registry handles were pushed into a plain array,
    // so they never joined the parent chain and the leak tracker flagged them
    // as orphans for the whole life of the contribution (surfaced on reload).
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      // Mirror main.tsx: the contribution lives under a singleton root store,
      // so only un-parented disposables (the bug) get reported as leaks. The
      // logger service owns its loggers, so model that with a singleton logger
      // (otherwise the stub logger itself would surface as noise).
      const root = markAsSingleton(new DisposableStore())
      const loggerService = {
        _serviceBrand: undefined,
        createLogger: () => markAsSingleton(new NullLogger()),
        setLevel: () => {},
        getLevel: () => LogLevel.Info,
      } as unknown as ILoggerService
      const config = new ConfigurationService()
      config.update(
        'json.schemas',
        [{ fileMatch: ['**/*.foo.json'], schema: { type: 'object' } }],
        ConfigurationTarget.User,
      )
      const c = root.add(
        new JsonSchemaAssociationsContribution(
          config,
          fakeFileService({}),
          undefined as never,
          loggerService,
        ),
      )
      root.add(config)
      await settle()
      expect(userContribs()).toHaveLength(1)

      // The handle is alive (not disposed) but must not be reported as a leak.
      const report = tracker.computeLeakingDisposables()
      expect(report).toBeUndefined()

      void c
    } finally {
      setDisposableTracker(null)
    }
  })
})
