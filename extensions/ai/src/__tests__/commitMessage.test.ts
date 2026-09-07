import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeCommand = vi.fn()
const showInformationMessage = vi.fn()
const showWarningMessage = vi.fn()
const showErrorMessage = vi.fn()
const getModels = vi.fn()
const getActiveModelId = vi.fn()
const getCommitModelId = vi.fn()
const sendRequest = vi.fn()
const getConfig = vi.fn()

vi.mock('@universe-editor/extension-api', () => ({
  AiMessageRole: { System: 0, User: 1, Assistant: 2 },
  ai: {
    getModels: () => getModels(),
    getActiveModelId: () => getActiveModelId(),
    getCommitModelId: () => getCommitModelId(),
    sendRequest: (...args: unknown[]) => sendRequest(...args),
  },
  commands: { executeCommand: (...args: unknown[]) => executeCommand(...args) },
  window: {
    showInformationMessage: (...a: unknown[]) => showInformationMessage(...a),
    showWarningMessage: (...a: unknown[]) => showWarningMessage(...a),
    showErrorMessage: (...a: unknown[]) => showErrorMessage(...a),
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string, def: unknown) => getConfig(key, def) }),
  },
}))

const { generateCommitMessage } = await import('../commitMessage.js')

function streamFrom(values: string[]) {
  return {
    stream: (async function* () {
      for (const v of values) yield { type: 'text' as const, value: v }
    })(),
    result: Promise.resolve(),
    cancel: vi.fn(),
  }
}

function contextWith(files: { path: string; diff: string }[]) {
  return { repoName: 'r', branch: 'main', recentCommits: [], userCommits: [], files }
}

let nextContext: unknown

beforeEach(() => {
  vi.resetAllMocks()
  nextContext = undefined
  getConfig.mockImplementation((_key: string, def: unknown) => Promise.resolve(def))
  getModels.mockResolvedValue([{ id: 'm1' }])
  getActiveModelId.mockResolvedValue(undefined)
  getCommitModelId.mockResolvedValue(undefined)
  // Route by command id rather than call order: the fire-and-forget
  // `_workbench.revealScm` bridge runs before `git.getCommitGenerationContext`,
  // so order-based mockResolvedValueOnce slots no longer line up.
  executeCommand.mockImplementation((id: string) =>
    Promise.resolve(id === 'git.getCommitGenerationContext' ? nextContext : undefined),
  )
})

function givenContext(ctx: unknown) {
  nextContext = ctx
}

describe('generateCommitMessage', () => {
  it('reveals the SCM panel before doing any work', async () => {
    givenContext(contextWith([{ path: 'a.ts', diff: 'diff --git a b' }]))
    sendRequest.mockReturnValue(streamFrom(['x']))
    await generateCommitMessage({ rootUri: '/r' })
    const reveals = executeCommand.mock.calls.filter((c) => c[0] === '_workbench.revealScm')
    expect(reveals).toHaveLength(1)
    // Reveal runs before the context read so the panel is already up while the
    // diff is fetched and the message streams in.
    const revealIdx = executeCommand.mock.calls.findIndex((c) => c[0] === '_workbench.revealScm')
    const ctxIdx = executeCommand.mock.calls.findIndex(
      (c) => c[0] === 'git.getCommitGenerationContext',
    )
    expect(revealIdx).toBeLessThan(ctxIdx)
  })

  it('still bails out cleanly when the reveal bridge is unavailable', async () => {
    executeCommand.mockImplementation((id: string) =>
      id === 'git.getCommitGenerationContext'
        ? Promise.resolve(contextWith([]))
        : Promise.reject(new Error('unknown command')),
    )
    await generateCommitMessage({ rootUri: '/r' })
    expect(showInformationMessage).toHaveBeenCalledOnce()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('bails out with an info message when there are no changes', async () => {
    givenContext(contextWith([]))
    await generateCommitMessage({ rootUri: '/r' })
    expect(showInformationMessage).toHaveBeenCalledOnce()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('errors when no model is available', async () => {
    givenContext(contextWith([{ path: 'a.ts', diff: 'diff --git a b' }]))
    getModels.mockResolvedValueOnce([])
    await generateCommitMessage({ rootUri: '/r' })
    expect(showErrorMessage).toHaveBeenCalledOnce()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('streams the generated message back via git.setCommitMessage', async () => {
    givenContext(contextWith([{ path: 'a.ts', diff: 'diff --git a b' }]))
    sendRequest.mockReturnValue(streamFrom(['feat: ', 'add thing']))
    await generateCommitMessage({ rootUri: '/r' })
    const writes = executeCommand.mock.calls.filter((c) => c[0] === 'git.setCommitMessage')
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.at(-1)).toEqual(['git.setCommitMessage', { rootUri: '/r' }, 'feat: add thing'])
  })

  it('warns when the model returns an empty message', async () => {
    givenContext(contextWith([{ path: 'a.ts', diff: 'diff --git a b' }]))
    sendRequest.mockReturnValue(streamFrom(['', '   ']))
    await generateCommitMessage({ rootUri: '/r' })
    expect(showWarningMessage).toHaveBeenCalledOnce()
  })

  it('prefers the commit model over the active chat model when none is configured', async () => {
    givenContext(contextWith([{ path: 'a.ts', diff: 'diff --git a b' }]))
    getCommitModelId.mockResolvedValueOnce('openai/default/commit-model')
    getActiveModelId.mockResolvedValueOnce('openai/default/chat-model')
    sendRequest.mockReturnValue(streamFrom(['x']))
    await generateCommitMessage({ rootUri: '/r' })
    expect(getModels).not.toHaveBeenCalled()
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ modelId: 'openai/default/commit-model' })
  })

  it('prefers the active model over the first available when none is configured', async () => {
    givenContext(contextWith([{ path: 'a.ts', diff: 'diff --git a b' }]))
    getActiveModelId.mockResolvedValueOnce('openai/default/active')
    sendRequest.mockReturnValue(streamFrom(['x']))
    await generateCommitMessage({ rootUri: '/r' })
    expect(getModels).not.toHaveBeenCalled()
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ modelId: 'openai/default/active' })
  })

  it('includes recent commits and custom instructions in the prompt', async () => {
    givenContext({
      repoName: 'r',
      branch: 'main',
      recentCommits: ['feat: prior work'],
      userCommits: [],
      files: [{ path: 'a.ts', diff: 'diff --git a b' }],
    })
    getConfig.mockImplementation((key: string, def: unknown) =>
      Promise.resolve(key === 'commitMessage.instructions' ? 'Write in Chinese.' : def),
    )
    sendRequest.mockReturnValue(streamFrom(['x']))
    await generateCommitMessage({ rootUri: '/r' })
    const userMessage = sendRequest.mock.calls[0]?.[0]?.[1]?.content as string
    expect(userMessage).toContain('feat: prior work')
    expect(userMessage).toContain('Write in Chinese.')
    expect(userMessage).toContain('### a.ts')
  })
})
