import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  window: {
    showWarningMessage: apiMock.showWarningMessage,
  },
}))

import { commitAmendSmart, commitSmart, type CommitRepository } from '../commitOperations.js'

interface FakeRepoOptions {
  readonly commitMessage?: string
  readonly hasStagedChanges?: boolean
  readonly hasChanges?: boolean
  readonly lastCommitMessage?: string
}

type FakeRepo = CommitRepository & {
  setStaged(value: boolean): void
}

function makeRepo(options: FakeRepoOptions = {}): FakeRepo {
  let commitMessage = options.commitMessage ?? 'message'
  let hasStagedChanges = options.hasStagedChanges ?? false
  const repo: FakeRepo = {
    get commitMessage() {
      return commitMessage
    },
    set commitMessage(value: string) {
      commitMessage = value
    },
    get hasStagedChanges() {
      return hasStagedChanges
    },
    get hasChanges() {
      return options.hasChanges ?? false
    },
    setStaged(value: boolean) {
      hasStagedChanges = value
    },
    stageAll: vi.fn(async () => true),
    commit: vi.fn(async () => true),
    commitAmend: vi.fn(async () => true),
    getLastCommitMessage: vi.fn(async () => options.lastCommitMessage ?? 'previous message'),
  }
  return repo
}

describe('commitSmart', () => {
  beforeEach(() => {
    apiMock.showWarningMessage.mockReset()
  })

  it('stages all changes before committing when nothing is staged', async () => {
    const repo = makeRepo({ hasChanges: true })
    vi.mocked(repo.stageAll).mockImplementation(async () => {
      repo.setStaged(true)
      return true
    })

    await expect(commitSmart(repo)).resolves.toBe(true)

    expect(repo.stageAll).toHaveBeenCalledTimes(1)
    expect(repo.commit).toHaveBeenCalledWith('message')
    expect(repo.commitMessage).toBe('')
  })

  it('does not commit when there are no changes to stage', async () => {
    const repo = makeRepo()

    await expect(commitSmart(repo)).resolves.toBe(false)

    expect(apiMock.showWarningMessage).toHaveBeenCalledWith('There are no changes to commit.')
    expect(repo.stageAll).not.toHaveBeenCalled()
    expect(repo.commit).not.toHaveBeenCalled()
  })
})

describe('commitAmendSmart', () => {
  beforeEach(() => {
    apiMock.showWarningMessage.mockReset()
  })

  it('loads the last commit message when the amend message is empty', async () => {
    const repo = makeRepo({ commitMessage: '   ' })

    await expect(commitAmendSmart(repo)).resolves.toBe(false)

    expect(repo.commitMessage).toBe('previous message')
    expect(repo.commitAmend).not.toHaveBeenCalled()
  })

  it('stages all working tree changes before amending when nothing is staged', async () => {
    const repo = makeRepo({ hasChanges: true })
    vi.mocked(repo.stageAll).mockImplementation(async () => {
      repo.setStaged(true)
      return true
    })

    await expect(commitAmendSmart(repo)).resolves.toBe(true)

    expect(repo.stageAll).toHaveBeenCalledTimes(1)
    expect(repo.commitAmend).toHaveBeenCalledWith('message')
    expect(repo.commitMessage).toBe('')
  })

  it('shows a friendly warning when amend has no staged or working tree changes', async () => {
    const repo = makeRepo({ commitMessage: 'previous message' })

    await expect(commitAmendSmart(repo)).resolves.toBe(false)

    expect(apiMock.showWarningMessage).toHaveBeenCalledWith('There are no changes to amend.')
    expect(repo.stageAll).not.toHaveBeenCalled()
    expect(repo.commitAmend).not.toHaveBeenCalled()
  })

  it('allows message-only amend when the commit message changed', async () => {
    const repo = makeRepo({ commitMessage: 'new message' })

    await expect(commitAmendSmart(repo)).resolves.toBe(true)

    expect(apiMock.showWarningMessage).not.toHaveBeenCalled()
    expect(repo.stageAll).not.toHaveBeenCalled()
    expect(repo.commitAmend).toHaveBeenCalledWith('new message')
    expect(repo.commitMessage).toBe('')
  })

  it('warns before staging when there is no commit to amend', async () => {
    const repo = makeRepo({
      hasChanges: true,
      lastCommitMessage: '',
    })

    await expect(commitAmendSmart(repo)).resolves.toBe(false)

    expect(apiMock.showWarningMessage).toHaveBeenCalledWith('No commits to amend.')
    expect(repo.stageAll).not.toHaveBeenCalled()
    expect(repo.commitAmend).not.toHaveBeenCalled()
  })
})
