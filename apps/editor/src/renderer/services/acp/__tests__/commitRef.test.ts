/*---------------------------------------------------------------------------------------------
 *  Tests for commitRef.ts: shared label/ref assembly, git-vs-generic repo resolution,
 *  and the serialized setRepo→getCommits queue.
 *--------------------------------------------------------------------------------------------*/

import type { GitGraphCommitDto, GitGraphLoadResult } from '@universe-editor/extensions-common'
import { GitGraphCommands } from '@universe-editor/extensions-common'
import { URI, type ICommandService } from '@universe-editor/platform'
import { afterEach, describe, expect, it } from 'vitest'
import { scmViewState } from '../../../workbench/scm/scmViewState.js'
import {
  commitLabel,
  commitRefFromParts,
  commitToRef,
  loadRepoCommits,
  MAX_COMMITS,
  MAX_COMMIT_SUBJECT_LENGTH,
  resolveCommitRepoRoot,
  resolveGitRepoRoot,
} from '../commitRef.js'

class FakeCommandService implements ICommandService {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{ id: string; args: unknown[] }> = []
  handlers = new Map<string, (...args: unknown[]) => unknown>()

  async executeCommand<T>(id: string, ...args: unknown[]): Promise<T | undefined> {
    this.calls.push({ id, args })
    return (await this.handlers.get(id)?.(...args)) as T | undefined
  }
}

function makeScmService(
  sourceControls: readonly { id: string; rootUri: string | undefined }[],
): never {
  return { sourceControls: { get: () => sourceControls } } as never
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

function loadResult(commits: GitGraphCommitDto[]): GitGraphLoadResult {
  return {
    commits,
    head: commits[0]?.hash ?? null,
    headName: 'main',
    moreAvailable: false,
    uncommittedChanges: 0,
  }
}

afterEach(() => {
  scmViewState.setSelectedRepo(undefined)
})

describe('commitLabel', () => {
  it('uses a 7-character hash and keeps short subjects intact', () => {
    expect(commitLabel('a1b2c3d4e5f6', 'fix login bug')).toBe('a1b2c3d fix login bug')
  })

  it('truncates long subjects with a single ellipsis', () => {
    const message = 'x'.repeat(MAX_COMMIT_SUBJECT_LENGTH + 10)
    const label = commitLabel('a1b2c3d4e5f6', message)
    expect(label).toBe(`a1b2c3d ${'x'.repeat(MAX_COMMIT_SUBJECT_LENGTH - 1)}…`)
  })
})

describe('commitRefFromParts', () => {
  it('assembles a commit ref with a fresh id', () => {
    const ref = commitRefFromParts({
      label: 'a1b2c3d subject',
      uri: 'file:///repo',
      commitHash: 'a1b2c3d4e5f6',
      description: 'subject body',
    })
    expect(ref.kind).toBe('commit')
    expect(ref.label).toBe('a1b2c3d subject')
    expect(ref.uri).toBe('file:///repo')
    expect(ref.meta).toStrictEqual({ commitHash: 'a1b2c3d4e5f6', description: 'subject body' })
    expect(ref.id.length).toBeGreaterThan(0)
  })

  it('maps a commit to a workspace URI and full message description', () => {
    const folder = URI.file('X:/workspace')
    const ref = commitToRef(commit({ message: 'x'.repeat(80) }), 'X:/workspace/repo', folder)
    expect(ref.label).toBe(`a1b2c3d ${'x'.repeat(MAX_COMMIT_SUBJECT_LENGTH - 1)}…`)
    expect(ref.meta?.description).toBe('x'.repeat(80))
    expect(ref.uri).toBe(URI.file('X:/workspace/repo').toString())
  })
})

describe('resolveCommitRepoRoot', () => {
  it('returns undefined without source controls', () => {
    expect(resolveCommitRepoRoot(makeScmService([]))).toBeUndefined()
  })

  it('prefers the selected repo when it is still present', () => {
    scmViewState.setSelectedRepo('/repo-b')
    expect(
      resolveCommitRepoRoot(
        makeScmService([
          { id: 'git', rootUri: '/repo-a' },
          { id: 'git', rootUri: '/repo-b' },
        ]),
      ),
    ).toBe('/repo-b')
  })

  it('falls back to the first control for stale selections', () => {
    scmViewState.setSelectedRepo('/gone')
    expect(
      resolveCommitRepoRoot(
        makeScmService([
          { id: 'perforce', rootUri: '/p4' },
          { id: 'git', rootUri: '/repo-a' },
        ]),
      ),
    ).toBe('/p4')
  })
})

describe('resolveGitRepoRoot', () => {
  it('ignores non-git controls', () => {
    expect(resolveGitRepoRoot(makeScmService([{ id: 'perforce', rootUri: '/p4' }]))).toBeUndefined()
  })

  it('prefers the selected git repo among several', () => {
    scmViewState.setSelectedRepo('/repo-b')
    expect(
      resolveGitRepoRoot(
        makeScmService([
          { id: 'git', rootUri: '/repo-a' },
          { id: 'git', rootUri: '/repo-b' },
          { id: 'perforce', rootUri: '/p4' },
        ]),
      ),
    ).toBe('/repo-b')
  })

  it('does not pick a stale selection owned by another provider', () => {
    scmViewState.setSelectedRepo('/p4')
    expect(
      resolveGitRepoRoot(
        makeScmService([
          { id: 'perforce', rootUri: '/p4' },
          { id: 'git', rootUri: '/repo-a' },
        ]),
      ),
    ).toBe('/repo-a')
  })
})

describe('loadRepoCommits', () => {
  it('runs setRepo then getCommits with the date-order options', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(GitGraphCommands.getCommits, () => loadResult([commit()]))

    const commits = await loadRepoCommits(commands, '/repo-a')

    expect(commits).toHaveLength(1)
    expect(commands.calls).toEqual([
      { id: GitGraphCommands.setRepo, args: ['/repo-a'] },
      {
        id: GitGraphCommands.getCommits,
        args: [{ maxCommits: MAX_COMMITS, order: 'date', includeRemotes: true }],
      },
    ])
  })

  it('honors a custom commit limit', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(GitGraphCommands.getCommits, () => loadResult([]))

    await loadRepoCommits(commands, '/repo-a', 50)

    expect(commands.calls[1]?.args).toEqual([
      { maxCommits: 50, order: 'date', includeRemotes: true },
    ])
  })

  it('returns an empty list when the extension omits commits', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(GitGraphCommands.getCommits, () => undefined)

    await expect(loadRepoCommits(commands, '/repo-a')).resolves.toEqual([])
  })

  it('propagates failures without poisoning the queue', async () => {
    const commands = new FakeCommandService()
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(GitGraphCommands.getCommits, () => {
      throw new Error('boom')
    })

    await expect(loadRepoCommits(commands, '/repo-a')).rejects.toThrow('boom')

    commands.handlers.set(GitGraphCommands.getCommits, () => loadResult([commit()]))
    await expect(loadRepoCommits(commands, '/repo-b')).resolves.toHaveLength(1)
  })

  it('serializes concurrent pairs so a later setRepo cannot retarget an in-flight read', async () => {
    const commands = new FakeCommandService()
    let releaseFirst: (() => void) | undefined
    let firstReadStarted: (() => void) | undefined
    const firstRead = new Promise<void>((resolve) => {
      firstReadStarted = resolve
    })
    commands.handlers.set(GitGraphCommands.setRepo, () => undefined)
    commands.handlers.set(GitGraphCommands.getCommits, () => {
      if (!releaseFirst) {
        firstReadStarted?.()
        return new Promise<GitGraphLoadResult>((resolve) => {
          releaseFirst = () => resolve(loadResult([commit()]))
        })
      }
      return loadResult([commit({ hash: 'b'.repeat(40) })])
    })

    const first = loadRepoCommits(commands, '/repo-a')
    await firstRead
    const second = loadRepoCommits(commands, '/repo-b')
    await Promise.resolve()

    expect(commands.calls).toEqual([
      { id: GitGraphCommands.setRepo, args: ['/repo-a'] },
      {
        id: GitGraphCommands.getCommits,
        args: [{ maxCommits: MAX_COMMITS, order: 'date', includeRemotes: true }],
      },
    ])

    releaseFirst?.()
    await expect(first).resolves.toHaveLength(1)
    await expect(second).resolves.toHaveLength(1)
    expect(commands.calls.map((call) => call.id)).toEqual([
      GitGraphCommands.setRepo,
      GitGraphCommands.getCommits,
      GitGraphCommands.setRepo,
      GitGraphCommands.getCommits,
    ])
    expect(commands.calls[2]?.args).toEqual(['/repo-b'])
  })
})
