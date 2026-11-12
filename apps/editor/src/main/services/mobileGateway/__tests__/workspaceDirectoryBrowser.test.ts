import {
  FileSystemError,
  URI,
  type IDirectoryEntry,
  type IFileService,
  type IFileStat,
  type ILogger,
} from '@universe-editor/platform'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_DIRECTORY_ENTRIES,
  WorkspaceDirectoryBrowser,
  WorkspaceDirectoryBrowseError,
} from '../workspaceDirectoryBrowser.js'

function statFor(resource: URI, isDirectory: boolean): IFileStat {
  return { resource, isFile: !isDirectory, isDirectory, size: 0, mtime: 0 }
}

function directory(name: string): IDirectoryEntry {
  return { name, isDirectory: true, isFile: false }
}

function file(name: string): IDirectoryEntry {
  return { name, isDirectory: false, isFile: true }
}

function makeBrowser(
  options: {
    readonly stat?: (resource: URI) => Promise<IFileStat>
    readonly list?: (resource: URI) => Promise<IDirectoryEntry[]>
    readonly realpath?: (resource: URI) => Promise<URI>
  } = {},
) {
  const stat = vi.fn(options.stat ?? (async (resource: URI) => statFor(resource, true)))
  const list = vi.fn(options.list ?? (async () => []))
  const realpath = options.realpath === undefined ? undefined : vi.fn(options.realpath)
  const files = {
    stat,
    list,
    ...(realpath !== undefined ? { realpath } : {}),
  } as unknown as IFileService
  const browser = new WorkspaceDirectoryBrowser(files, { platform: 'linux' })
  return { browser, stat, list, realpath }
}

async function expectBrowseError(promise: Promise<unknown>, code: 'bad_request' | 'internal') {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('WorkspaceDirectoryBrowser', () => {
  it('lists directories only, sorted case-insensitively', async () => {
    const { browser } = makeBrowser({
      list: async () => [directory('zeta'), directory('Alpha'), file('readme.md')],
    })

    await expect(browser.read({ folder: 'file:///ws' }, undefined)).resolves.toStrictEqual({
      relativePath: '',
      entries: [
        { name: 'Alpha', relativePath: 'Alpha' },
        { name: 'zeta', relativePath: 'zeta' },
      ],
    })
  })

  it('reports the parent path for nested directories', async () => {
    const { browser, stat } = makeBrowser({
      list: async () => [directory('ui')],
    })

    await expect(browser.read({ folder: 'file:///ws' }, 'packages')).resolves.toStrictEqual({
      relativePath: 'packages',
      parentRelativePath: '',
      entries: [{ name: 'ui', relativePath: 'packages/ui' }],
    })
    expect(stat.mock.calls[0]?.[0].toString()).toBe('file:///ws/packages')
  })

  it('rejects invalid paths without touching the filesystem', async () => {
    const { browser, stat, list } = makeBrowser()
    await expectBrowseError(browser.read({ folder: 'file:///ws' }, '../outside'), 'bad_request')
    await expectBrowseError(browser.read({ folder: 'file:///ws' }, 'a\\b'), 'bad_request')
    await expectBrowseError(browser.read({ folder: 'file:///ws' }, '/abs'), 'bad_request')
    expect(stat).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })

  it('maps missing or unreadable targets to bad_request', async () => {
    const missing = makeBrowser({
      stat: async () => {
        throw new FileSystemError('missing', 'ENOENT')
      },
    })
    await expectBrowseError(missing.browser.read({ folder: 'file:///ws' }, 'gone'), 'bad_request')

    const denied = makeBrowser({
      list: async () => {
        throw new FileSystemError('denied', 'EACCES')
      },
    })
    await expectBrowseError(denied.browser.read({ folder: 'file:///ws' }, undefined), 'bad_request')

    const broken = makeBrowser({
      list: async () => {
        throw new Error('provider exploded')
      },
    })
    await expectBrowseError(broken.browser.read({ folder: 'file:///ws' }, undefined), 'internal')
  })

  it('classifies revived IPC errors by code instead of instanceof', async () => {
    const missing = makeBrowser({
      stat: async () => {
        throw Object.assign(new Error('ENOENT: /ws/gone'), { code: 'ENOENT' })
      },
    })
    await expectBrowseError(missing.browser.read({ folder: 'file:///ws' }, 'gone'), 'bad_request')

    const denied = makeBrowser({
      list: async () => {
        throw Object.assign(new Error('EACCES: /ws'), { code: 'EACCES' })
      },
    })
    await expectBrowseError(denied.browser.read({ folder: 'file:///ws' }, undefined), 'bad_request')

    const disconnected = makeBrowser({
      stat: async () => {
        throw new Error('remote connection closed')
      },
    })
    await expectBrowseError(
      disconnected.browser.read({ folder: 'file:///ws' }, undefined),
      'internal',
    )
  })

  it('classifies realpath failures and logs only the error code', async () => {
    const debug = vi.fn()
    const deniedFiles = {
      stat: vi.fn(async (resource: URI) => statFor(resource, true)),
      list: vi.fn(async () => []),
      realpath: vi.fn(async () => {
        throw Object.assign(new Error('EACCES: /ws/secret'), { code: 'EACCES' })
      }),
    } as unknown as IFileService
    const denied = new WorkspaceDirectoryBrowser(deniedFiles, {
      platform: 'linux',
      logger: { debug } as unknown as ILogger,
    })
    await expectBrowseError(denied.read({ folder: 'file:///ws' }, 'sub'), 'bad_request')
    expect(debug).toHaveBeenCalledWith('workspace directory realpath failed: code=EACCES')
    expect(JSON.stringify(debug.mock.calls)).not.toContain('/ws/secret')

    const disconnectedFiles = {
      stat: vi.fn(async (resource: URI) => statFor(resource, true)),
      list: vi.fn(async () => []),
      realpath: vi.fn(async () => {
        throw new Error('remote connection closed')
      }),
    } as unknown as IFileService
    const disconnected = new WorkspaceDirectoryBrowser(disconnectedFiles, { platform: 'linux' })
    await expectBrowseError(disconnected.read({ folder: 'file:///ws' }, 'sub'), 'internal')
  })

  it('rejects a file target', async () => {
    const { browser } = makeBrowser({
      stat: async (resource) => statFor(resource, false),
    })
    await expectBrowseError(browser.read({ folder: 'file:///ws' }, 'notes.md'), 'bad_request')
  })

  it('rejects a symlink that resolves outside the workspace', async () => {
    const escaped = makeBrowser({
      realpath: async (resource) =>
        resource.toString() === 'file:///ws/link'
          ? URI.parse('file:///outside')
          : URI.parse(resource.toString()),
    })
    await expectBrowseError(escaped.browser.read({ folder: 'file:///ws' }, 'link'), 'bad_request')

    const inside = makeBrowser({
      realpath: async (resource) => URI.parse(resource.toString()),
    })
    await expect(inside.browser.read({ folder: 'file:///ws' }, 'link')).resolves.toMatchObject({
      relativePath: 'link',
    })
  })

  it('preserves remote scheme and authority when listing', async () => {
    const { browser, stat } = makeBrowser({
      list: async () => [directory('sub')],
    })
    await browser.read({ folder: 'remote-ssh://build-host/work' }, undefined)
    expect(stat.mock.calls[0]?.[0].toString()).toBe('remote-ssh://build-host/work')
  })

  it('skips entry names the wire path cannot represent', async () => {
    const { browser } = makeBrowser({
      list: async () => [directory('good'), directory('bad\\name'), directory('..')],
    })
    await expect(browser.read({ folder: 'file:///ws' }, undefined)).resolves.toMatchObject({
      entries: [{ name: 'good', relativePath: 'good' }],
    })
  })

  it('caps the number of entries', async () => {
    const { browser } = makeBrowser({
      list: async () =>
        Array.from({ length: MAX_DIRECTORY_ENTRIES + 1 }, (_, index) =>
          directory(`d${String(index).padStart(3, '0')}`),
        ),
    })
    const listing = await browser.read({ folder: 'file:///ws' }, undefined)
    expect(listing.entries).toHaveLength(MAX_DIRECTORY_ENTRIES)
    expect(listing.truncated).toBe(true)
  })

  it('caps the total listing characters', async () => {
    const longName = 'x'.repeat(600)
    const { browser } = makeBrowser({
      list: async () =>
        Array.from({ length: MAX_DIRECTORY_ENTRIES }, (_, index) =>
          directory(`${index}-${longName}`),
        ),
    })
    const listing = await browser.read({ folder: 'file:///ws' }, undefined)
    expect(listing.truncated).toBe(true)
    expect(listing.entries.length).toBeLessThan(MAX_DIRECTORY_ENTRIES)
    const total = listing.entries.reduce(
      (sum, entry) => sum + entry.name.length + entry.relativePath.length,
      0,
    )
    expect(total).toBeLessThanOrEqual(256 * 1024)
  })
})

describe('WorkspaceDirectoryBrowseError', () => {
  it('keeps its code', () => {
    const error = new WorkspaceDirectoryBrowseError('bad_request', 'nope')
    expect(error.code).toBe('bad_request')
    expect(error.name).toBe('WorkspaceDirectoryBrowseError')
  })
})
