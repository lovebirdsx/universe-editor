import { describe, it, expect } from 'vitest'
import {
  URI,
  type ICommandService,
  type IFileService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { MergeEditorInput, type MergeEditorContents } from '../MergeEditorInput.js'

function contents(path: string): MergeEditorContents {
  return {
    path,
    base: '',
    current: '',
    incoming: '',
    merged: '',
    currentLabel: 'HEAD',
    incomingLabel: 'theirs',
  }
}

function makeWorkspace(folder?: URI): IWorkspaceService {
  return { current: folder ? { folder } : null } as IWorkspaceService
}

describe('MergeEditorInput', () => {
  it('keeps a file: fileUri for a local workspace', () => {
    const input = new MergeEditorInput(
      contents('/ws/a.ts'),
      {} as IFileService,
      {} as ICommandService,
      makeWorkspace(URI.file('/ws')),
    )
    expect(input.fileUri.toString()).toBe(URI.file('/ws/a.ts').toString())
  })

  it('reattaches the workspace authority for a remote workspace', () => {
    const folder = URI.from({ scheme: 'remote-ssh', authority: 'auth', path: '/ws' })
    const input = new MergeEditorInput(
      contents('/ws/a.ts'),
      {} as IFileService,
      {} as ICommandService,
      makeWorkspace(folder),
    )
    expect(input.fileUri.toString()).toBe('remote-ssh://auth/ws/a.ts')
  })

  it('writes the merge result to the workspace resource URI and stages the bare path', async () => {
    const written: URI[] = []
    const fileService = {
      writeFile: async (uri: URI) => {
        written.push(uri)
      },
    } as unknown as IFileService
    const staged: unknown[][] = []
    const commandService = {
      executeCommand: async (...args: unknown[]) => {
        staged.push(args)
      },
    } as unknown as ICommandService
    const folder = URI.from({ scheme: 'remote-ssh', authority: 'auth', path: '/ws' })
    const input = new MergeEditorInput(
      contents('/ws/a.ts'),
      fileService,
      commandService,
      makeWorkspace(folder),
    )
    input.setResult('resolved')

    const saved = await input.save()

    expect(saved).toBe(true)
    expect(written[0]?.toString()).toBe('remote-ssh://auth/ws/a.ts')
    expect(staged).toEqual([['git.stage', { resourceUri: '/ws/a.ts' }]])
  })

  it('runs the provider follow-up command instead of git.stage when set', async () => {
    const fileService = { writeFile: async () => {} } as unknown as IFileService
    const executed: unknown[][] = []
    const commandService = {
      executeCommand: async (...args: unknown[]) => {
        executed.push(args)
      },
    } as unknown as ICommandService
    const input = new MergeEditorInput(
      {
        ...contents('/ws/a.ts'),
        saveCommand: {
          command: 'perforce.acceptResolved',
          arguments: [{ resourceUri: '/ws/a.ts' }],
        },
      },
      fileService,
      commandService,
      makeWorkspace(URI.file('/ws')),
    )

    await input.save()

    expect(executed).toEqual([['perforce.acceptResolved', { resourceUri: '/ws/a.ts' }]])
  })

  it('runs a follow-up command that takes no arguments', async () => {
    const fileService = { writeFile: async () => {} } as unknown as IFileService
    const executed: unknown[][] = []
    const commandService = {
      executeCommand: async (...args: unknown[]) => {
        executed.push(args)
      },
    } as unknown as ICommandService
    const input = new MergeEditorInput(
      { ...contents('/ws/a.ts'), saveCommand: { command: 'noop.finish' } },
      fileService,
      commandService,
      makeWorkspace(URI.file('/ws')),
    )

    await input.save()

    expect(executed).toEqual([['noop.finish']])
  })
})
