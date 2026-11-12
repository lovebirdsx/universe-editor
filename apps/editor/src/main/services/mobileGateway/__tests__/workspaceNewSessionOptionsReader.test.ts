import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  FileSystemError,
  URI,
  type IFileService,
  type IFileStat,
  type ILogger,
} from '@universe-editor/platform'
import { mkTempDir } from '@universe-editor/temp-root'
import { describe, expect, it, vi } from 'vitest'
import { workspaceIdFromUri, workspaceStoragePathFor } from '../../../storage.js'
import { WorkspaceNewSessionOptionsReader } from '../workspaceNewSessionOptionsReader.js'

interface FakeFilesOptions {
  readonly textFiles?: ReadonlyMap<string, string>
  readonly stat?: (resource: URI) => Promise<IFileStat>
  readonly realpath?: (resource: URI) => Promise<URI>
}

function statFor(resource: URI, isDirectory: boolean, size = 0): IFileStat {
  return { resource, isFile: !isDirectory, isDirectory, size, mtime: 0 }
}

function makeFiles(options: FakeFilesOptions = {}) {
  const textFiles = options.textFiles ?? new Map<string, string>()
  const stat = vi.fn(
    options.stat ??
      (async (resource: URI) => {
        const text = textFiles.get(resource.toString())
        return text !== undefined ? statFor(resource, false, text.length) : statFor(resource, true)
      }),
  )
  const readFileText = vi.fn(async (resource: URI) => {
    const text = textFiles.get(resource.toString())
    if (text === undefined) throw new FileSystemError('missing', 'ENOENT')
    return text
  })
  const realpath = options.realpath === undefined ? undefined : vi.fn(options.realpath)
  const files = {
    stat,
    readFileText,
    ...(realpath !== undefined ? { realpath } : {}),
  } as unknown as IFileService
  return { files, stat, readFileText, realpath }
}

function nullLogger(): Pick<ILogger, 'debug' | 'warn'> {
  return { debug: () => {}, warn: () => {} }
}

function makeReader(
  userDataDir: string,
  files?: IFileService,
  platform: 'linux' | 'win32' = 'linux',
): WorkspaceNewSessionOptionsReader {
  return new WorkspaceNewSessionOptionsReader({
    userDataDir,
    logger: nullLogger(),
    platform,
    ...(files !== undefined ? { files } : {}),
  })
}

async function writeBucket(userDataDir: string, folder: string, state: unknown): Promise<void> {
  const file = workspaceStoragePathFor(userDataDir, workspaceIdFromUri(folder))
  await mkdir(join(userDataDir, 'workspaces'), { recursive: true })
  await writeFile(file, JSON.stringify(state), 'utf8')
}

function settingsFile(root: string, layer: '.universe-editor' | '.vscode'): string {
  return `${root}/${layer}/settings.json`
}

describe('WorkspaceNewSessionOptionsReader', () => {
  it('returns the remembered directory and configured project roots', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    await writeBucket(userDataDir, folder, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/ws/packages/app' },
    })
    const textFiles = new Map([
      [
        settingsFile(folder, '.universe-editor'),
        JSON.stringify({ 'acp.projectRoots': ['packages/demo', '/ws/tools', '/elsewhere'] }),
      ],
    ])
    const { files } = makeFiles({ textFiles })

    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      lastRelativePath: 'packages/app',
      projectRoots: ['packages/demo', 'tools'],
    })
  })

  it('omits a remembered root, outside path, or mismatched authority', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    const { files } = makeFiles()

    await writeBucket(userDataDir, folder, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/ws' },
    })
    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })

    await writeBucket(userDataDir, folder, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/other/app' },
    })
    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })

    const remote = 'remote-ssh://build-host/srv/ws'
    await writeBucket(userDataDir, remote, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/srv/ws/app', authority: 'other-host' },
    })
    await expect(
      makeReader(userDataDir, files).read({ folder: remote, authority: 'build-host' }),
    ).resolves.toStrictEqual({ projectRoots: [] })

    await writeBucket(userDataDir, remote, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/srv/ws/app', authority: 'build-host' },
    })
    await expect(
      makeReader(userDataDir, files).read({ folder: remote, authority: 'build-host' }),
    ).resolves.toStrictEqual({ lastRelativePath: 'app', projectRoots: [] })
  })

  it('keeps the memory on transient stat errors but drops unavailable paths', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    await writeBucket(userDataDir, folder, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/ws/packages/app' },
    })

    const transient = makeFiles({
      stat: async () => {
        throw new Error('transport hiccup')
      },
    })
    await expect(makeReader(userDataDir, transient.files).read({ folder })).resolves.toStrictEqual({
      lastRelativePath: 'packages/app',
      projectRoots: [],
    })

    const missing = makeFiles({
      stat: async (resource) => {
        if (resource.toString().endsWith('/packages/app')) {
          throw new FileSystemError('missing', 'ENOENT')
        }
        return statFor(resource, true)
      },
    })
    await expect(makeReader(userDataDir, missing.files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })

    const escaped = makeFiles({
      realpath: async (resource) =>
        resource.toString().endsWith('/packages/app') ? URI.file('/outside/app') : resource,
    })
    await expect(makeReader(userDataDir, escaped.files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })
  })

  it('resolves a remembered path under a POSIX root workspace', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///'
    await writeBucket(userDataDir, folder, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/opt/lib' },
    })
    const { files } = makeFiles()

    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      lastRelativePath: 'opt/lib',
      projectRoots: [],
    })
  })

  it('prefers the project settings layer even when its value is empty or invalid', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    const { files } = makeFiles({
      textFiles: new Map([
        [settingsFile(folder, '.universe-editor'), '{"acp.projectRoots": []}'],
        [settingsFile(folder, '.vscode'), '{"acp.projectRoots": ["packages/other"]}'],
      ]),
    })
    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })

    const invalid = makeFiles({
      textFiles: new Map([
        [settingsFile(folder, '.universe-editor'), '{"acp.projectRoots": "nope"}'],
        [settingsFile(folder, '.vscode'), '{"acp.projectRoots": ["packages/other"]}'],
      ]),
    })
    await expect(makeReader(userDataDir, invalid.files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })
  })

  it('falls back to the VSCode layer when project settings lack the key or are unreadable', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'

    const missingKey = makeFiles({
      textFiles: new Map([
        [settingsFile(folder, '.universe-editor'), '{"editor.fontSize": 13}'],
        [settingsFile(folder, '.vscode'), '{"acp.projectRoots": ["packages/other"]}'],
      ]),
    })
    await expect(makeReader(userDataDir, missingKey.files).read({ folder })).resolves.toStrictEqual(
      {
        projectRoots: ['packages/other'],
      },
    )

    const broken = makeFiles({
      textFiles: new Map([
        [settingsFile(folder, '.universe-editor'), '{"acp.projectRoots": ['],
        [settingsFile(folder, '.vscode'), '{"acp.projectRoots": ["packages/other"]}'],
      ]),
    })
    await expect(makeReader(userDataDir, broken.files).read({ folder })).resolves.toStrictEqual({
      projectRoots: ['packages/other'],
    })
  })

  it('parses JSONC comments and trailing commas', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    const { files } = makeFiles({
      textFiles: new Map([
        [
          settingsFile(folder, '.universe-editor'),
          '{\n  // project list\n  "acp.projectRoots": ["packages/demo",],\n}',
        ],
      ]),
    })
    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      projectRoots: ['packages/demo'],
    })
  })

  it('filters outside roots, excludes the root, normalizes separators, and dedupes', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    const { files } = makeFiles({
      textFiles: new Map([
        [
          settingsFile(folder, '.universe-editor'),
          JSON.stringify({
            'acp.projectRoots': [
              'packages\\demo',
              './packages/demo',
              '.',
              '/ws/packages/demo',
              '/ws',
              '/outside',
              '../escape',
            ],
          }),
        ],
      ]),
    })
    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      projectRoots: ['packages/demo'],
    })
  })

  it('caps the configured roots', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    const roots = Array.from({ length: 60 }, (_, index) => `packages/p${index}`)
    const { files } = makeFiles({
      textFiles: new Map([
        [settingsFile(folder, '.universe-editor'), JSON.stringify({ 'acp.projectRoots': roots })],
      ]),
    })
    const result = await makeReader(userDataDir, files).read({ folder })
    expect(result.projectRoots).toHaveLength(50)
    expect(result.projectRoots[0]).toBe('packages/p0')
    expect(result.projectRoots[49]).toBe('packages/p49')
  })

  it('resolves absolute roots with POSIX semantics for remote workspaces', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'remote-ssh://build-host/srv/ws'
    const { files } = makeFiles({
      textFiles: new Map([
        [
          settingsFile(folder, '.universe-editor'),
          JSON.stringify({ 'acp.projectRoots': ['/srv/ws/lib', '/srv/other', 'packages\\ui'] }),
        ],
      ]),
    })
    await expect(
      makeReader(userDataDir, files).read({ folder, authority: 'build-host' }),
    ).resolves.toStrictEqual({
      projectRoots: ['lib', 'packages/ui'],
    })
  })

  it('returns only an empty fallback without a file provider', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    await writeBucket(userDataDir, folder, {
      'acp.lastSessionCwd': { schemaVersion: 1, cwd: '/ws/packages/app' },
    })
    await expect(makeReader(userDataDir).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })
  })

  it('degrades to no last path on a missing or corrupt bucket', async () => {
    const userDataDir = mkTempDir('universe-new-session-options-')
    const folder = 'file:///ws'
    const { files } = makeFiles()
    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })

    const file = workspaceStoragePathFor(userDataDir, workspaceIdFromUri(folder))
    await mkdir(join(userDataDir, 'workspaces'), { recursive: true })
    await writeFile(file, '{not json', 'utf8')
    await expect(makeReader(userDataDir, files).read({ folder })).resolves.toStrictEqual({
      projectRoots: [],
    })
  })
})
