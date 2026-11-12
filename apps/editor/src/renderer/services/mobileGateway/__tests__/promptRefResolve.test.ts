/*---------------------------------------------------------------------------------------------
 *  Tests for the phone's second-step `#` resolution: commit history mapping and
 *  extension chatContext round-trips.
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphCommitDto, GitGraphLoadResult } from '@universe-editor/extensions-common'
import { GitGraphCommands } from '@universe-editor/extensions-common'
import { observableValue, URI, type ICommandService } from '@universe-editor/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { relativeTime } from '../../../relativeTime.js'
import { scmViewState } from '../../../workbench/scm/scmViewState.js'
import { MobilePromptRefResolver } from '../promptRefResolve.js'

class FakeCommandService implements ICommandService {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []
  handlers = new Map<string, (...args: unknown[]) => unknown>()

  async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
    this.calls.push({ id, args })
    return (await this.handlers.get(id)?.(...args)) as T | undefined
  }
}

function commit(over: Partial<GitGraphCommitDto> = {}): GitGraphCommitDto {
  return {
    hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    parents: [],
    author: 'Alice',
    email: 'alice@example.com',
    date: 1700000000,
    message: 'fix login bug',
    heads: [],
    tags: [],
    remotes: [],
    stash: null,
    worktrees: [],
    ...over,
  }
}

function makeResolver(options: {
  commands?: FakeCommandService
  sourceControls?: readonly { id: string; rootUri: string | undefined }[]
  folder?: URI
  providers?: readonly { handle: number; provider: unknown }[]
  resolveItem?: (...args: unknown[]) => Promise<unknown>
}): { resolver: MobilePromptRefResolver; resolveItem: ReturnType<typeof vi.fn> } {
  const commands = options.commands ?? new FakeCommandService()
  const resolveItem = vi.fn(options.resolveItem ?? (async () => undefined))
  const scm = {
    sourceControls: observableValue('test.scm', options.sourceControls ?? []),
  }
  const workspace = {
    current: { folder: options.folder ?? URI.file('/workspace'), name: 'workspace' },
  }
  const chatContext = {
    getProviders: () => options.providers ?? [],
    resolveItem,
    resolveItemOrThrow: resolveItem,
  }
  return {
    resolver: new MobilePromptRefResolver({
      commands: commands as never,
      scm: scm as never,
      workspace: workspace as never,
      chatContext: chatContext as never,
    }),
    resolveItem,
  }
}

function withCommits(commands: FakeCommandService, commits: GitGraphCommitDto[]): void {
  commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
  commands.handlers.set(GitGraphCommands.getCommits, () => {
    const result: GitGraphLoadResult = {
      commits,
      head: commits[0]?.hash ?? null,
      headName: 'main',
      moreAvailable: false,
      uncommittedChanges: 0,
    }
    return result
  })
}

afterEach(() => {
  scmViewState.setSelectedRepo(undefined)
  vi.restoreAllMocks()
})

describe('MobilePromptRefResolver commit', () => {
  it('returns no entries without a git source control and runs no commands', async () => {
    const commands = new FakeCommandService()
    const { resolver } = makeResolver({
      commands,
      sourceControls: [{ id: 'perforce', rootUri: '/p4' }],
    })

    await expect(resolver.resolveCommit(50)).resolves.toEqual([])
    expect(commands.calls).toEqual([])
  })

  it('maps commits to final wire entries in date order', async () => {
    const commands = new FakeCommandService()
    withCommits(commands, [commit(), commit({ hash: 'b'.repeat(40), message: 'older' })])
    const { resolver } = makeResolver({
      commands,
      sourceControls: [{ id: 'git', rootUri: '/workspace/repo' }],
    })

    const entries = await resolver.resolveCommit(50)

    expect(commands.calls[0]).toEqual({ id: GitGraphCommands.setRepo, args: ['/workspace/repo'] })
    expect(commands.calls[1]?.args).toEqual([
      { maxCommits: 50, order: 'date', includeRemotes: true },
    ])
    expect(entries).toEqual([
      {
        kind: 'commit',
        label: 'a1b2c3d fix login bug',
        uri: URI.file('/workspace/repo').toString(),
        commitHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        text: 'fix login bug',
        description: `Alice · ${relativeTime(1700000000 * 1000)}`,
      },
      {
        kind: 'commit',
        label: 'bbbbbbb older',
        uri: URI.file('/workspace/repo').toString(),
        commitHash: 'b'.repeat(40),
        text: 'older',
        description: `Alice · ${relativeTime(1700000000 * 1000)}`,
      },
    ])
  })

  it('inherits the remote scheme and authority from a remote workspace folder', async () => {
    const commands = new FakeCommandService()
    withCommits(commands, [commit()])
    const folder = URI.from({
      scheme: 'remote-ssh',
      authority: 'ssh-remote+host',
      path: '/home/u/ws',
    })
    const { resolver } = makeResolver({
      commands,
      sourceControls: [{ id: 'git', rootUri: '/home/u/repo' }],
      folder,
    })

    const entries = await resolver.resolveCommit(50)

    const uri = URI.parse(entries[0]!.uri)
    expect(uri.scheme).toBe('remote-ssh')
    expect(uri.authority).toBe('ssh-remote+host')
    expect(uri.path).toBe('/home/u/repo')
  })

  it('drops invalid hashes and empty subjects', async () => {
    const commands = new FakeCommandService()
    withCommits(commands, [
      commit({ hash: 'not-hex' }),
      commit({ hash: 'c'.repeat(40), message: '' }),
      commit({ hash: 'd'.repeat(40), message: 'kept' }),
    ])
    const { resolver } = makeResolver({
      commands,
      sourceControls: [{ id: 'git', rootUri: '/workspace/repo' }],
    })

    const entries = await resolver.resolveCommit(50)

    expect(entries.map((entry) => entry.commitHash)).toEqual(['d'.repeat(40)])
  })

  it('sanitizes control characters and clamps long subjects', async () => {
    const commands = new FakeCommandService()
    withCommits(commands, [commit({ message: `line1\nline2 ${'x'.repeat(600)}` })])
    const { resolver } = makeResolver({
      commands,
      sourceControls: [{ id: 'git', rootUri: '/workspace/repo' }],
    })

    const entries = await resolver.resolveCommit(50)

    const text = entries[0]?.text ?? ''
    expect(text).not.toContain('\n')
    expect(text.length).toBe(512)
    expect(text.endsWith('…')).toBe(true)
    expect(entries[0]?.label.length).toBeLessThanOrEqual(68)
  })

  it('honors the requested limit while loading', async () => {
    const commands = new FakeCommandService()
    withCommits(commands, [commit()])
    const { resolver } = makeResolver({
      commands,
      sourceControls: [{ id: 'git', rootUri: '/workspace/repo' }],
    })

    await resolver.resolveCommit(7)

    expect(commands.calls[1]?.args).toEqual([
      { maxCommits: 7, order: 'date', includeRemotes: true },
    ])
  })

  it('propagates command failures to the caller', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(GitGraphCommands.getCommits, () => {
      throw new Error('boom')
    })
    const { resolver } = makeResolver({
      commands,
      sourceControls: [{ id: 'git', rootUri: '/workspace/repo' }],
    })

    await expect(resolver.resolveCommit(50)).rejects.toThrow('boom')
  })
})

describe('MobilePromptRefResolver chatContext', () => {
  const provider = {
    label: 'Perforce CL',
    description: 'Pick a changelist',
    keywords: ['cl'],
  }

  it('resolves an extension item and maps it to a sendable entry', async () => {
    const resolveItem = vi.fn(async () => ({ label: 'CL 123', text: 'Change 123\n- src/a.ts' }))
    const { resolver } = makeResolver({
      providers: [{ handle: 4, provider }],
      resolveItem,
    })

    const entry = await resolver.resolveChatContext(4, 'cl', 'Perforce CL', '/workspace/sub')

    expect(resolveItem).toHaveBeenCalledWith(4, 'cl', { sessionDir: '/workspace/sub' })
    expect(entry).toEqual({
      kind: 'chatContext',
      label: 'CL 123',
      uri: '',
      text: 'Change 123\n- src/a.ts',
      description: 'Pick a changelist',
    })
  })

  it('omits the resolve context when no session directory is known', async () => {
    const { resolver, resolveItem } = makeResolver({
      providers: [{ handle: 4, provider }],
      resolveItem: async () => ({ label: 'CL 123', text: 'body' }),
    })

    await resolver.resolveChatContext(4, '', 'Perforce CL')

    expect(resolveItem).toHaveBeenCalledWith(4, '', undefined)
  })

  it('returns undefined when the user cancels on the PC', async () => {
    const { resolver } = makeResolver({ providers: [{ handle: 4, provider }] })

    await expect(resolver.resolveChatContext(4, '', 'Perforce CL')).resolves.toBeUndefined()
  })

  it('propagates extension picker failures instead of reporting a cancel', async () => {
    const { resolver } = makeResolver({
      providers: [{ handle: 4, provider }],
      resolveItem: async () => {
        throw new Error('p4 down')
      },
    })

    await expect(resolver.resolveChatContext(4, '', 'Perforce CL')).rejects.toThrow('p4 down')
  })

  it('rejects unknown handles and stale labels without opening a picker', async () => {
    const { resolver, resolveItem } = makeResolver({
      providers: [{ handle: 4, provider }],
      resolveItem: async () => ({ label: 'CL', text: 'body' }),
    })

    await expect(resolver.resolveChatContext(9, '', 'Perforce CL')).resolves.toBeUndefined()
    await expect(resolver.resolveChatContext(4, '', 'Swarm')).resolves.toBeUndefined()
    expect(resolveItem).not.toHaveBeenCalled()
  })

  it('drops empty bodies and strips unsafe controls while keeping newlines', async () => {
    const { resolver } = makeResolver({
      providers: [{ handle: 4, provider }],
      resolveItem: async () => ({ label: 'CL', text: 'a\u0000b\nc' }),
    })

    const entry = await resolver.resolveChatContext(4, '', 'Perforce CL')

    expect(entry?.text).toBe('a b\nc')
  })

  it('returns undefined for a whitespace-only body', async () => {
    const { resolver } = makeResolver({
      providers: [{ handle: 4, provider }],
      resolveItem: async () => ({ label: 'CL', text: ' \n\t ' }),
    })

    await expect(resolver.resolveChatContext(4, '', 'Perforce CL')).resolves.toBeUndefined()
  })

  it('clamps an oversized body and logs without the content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { resolver } = makeResolver({
      providers: [{ handle: 4, provider }],
      resolveItem: async () => ({ label: 'CL', text: 'x'.repeat(5000) }),
    })

    const entry = await resolver.resolveChatContext(4, '', 'Perforce CL')

    const text = entry?.text ?? ''
    expect(text.length).toBe(4096)
    expect(text.endsWith('…')).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.not.stringContaining('xxxx'))
  })
})
