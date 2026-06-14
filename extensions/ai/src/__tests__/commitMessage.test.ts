import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeCommand = vi.fn()
const showInformationMessage = vi.fn()
const showWarningMessage = vi.fn()
const showErrorMessage = vi.fn()
const getModels = vi.fn()
const sendRequest = vi.fn()
const getConfig = vi.fn()

vi.mock('@universe-editor/extension-api', () => ({
  AiMessageRole: { System: 0, User: 1, Assistant: 2 },
  ai: {
    getModels: () => getModels(),
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

beforeEach(() => {
  vi.clearAllMocks()
  getConfig.mockImplementation((_key: string, def: unknown) => Promise.resolve(def))
  getModels.mockResolvedValue([{ id: 'm1' }])
})

describe('generateCommitMessage', () => {
  it('bails out with an info message when there is no diff', async () => {
    executeCommand.mockResolvedValueOnce('   ')
    await generateCommitMessage({ rootUri: '/r' })
    expect(showInformationMessage).toHaveBeenCalledOnce()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('errors when no model is available', async () => {
    executeCommand.mockResolvedValueOnce('diff --git a b')
    getModels.mockResolvedValueOnce([])
    await generateCommitMessage({ rootUri: '/r' })
    expect(showErrorMessage).toHaveBeenCalledOnce()
    expect(sendRequest).not.toHaveBeenCalled()
  })

  it('streams the generated message back via git.setCommitMessage', async () => {
    executeCommand.mockResolvedValueOnce('diff --git a b')
    sendRequest.mockReturnValue(streamFrom(['feat: ', 'add thing']))
    await generateCommitMessage({ rootUri: '/r' })
    const writes = executeCommand.mock.calls.filter((c) => c[0] === 'git.setCommitMessage')
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.at(-1)).toEqual(['git.setCommitMessage', { rootUri: '/r' }, 'feat: add thing'])
  })

  it('warns when the model returns an empty message', async () => {
    executeCommand.mockResolvedValueOnce('diff --git a b')
    sendRequest.mockReturnValue(streamFrom(['', '   ']))
    await generateCommitMessage({ rootUri: '/r' })
    expect(showWarningMessage).toHaveBeenCalledOnce()
  })

  it('passes the configured model id to the request', async () => {
    executeCommand.mockResolvedValueOnce('diff --git a b')
    getConfig.mockImplementation((key: string, def: unknown) =>
      Promise.resolve(key === 'commitMessage.modelId' ? 'custom-model' : def),
    )
    sendRequest.mockReturnValue(streamFrom(['x']))
    await generateCommitMessage({ rootUri: '/r' })
    expect(getModels).not.toHaveBeenCalled()
    expect(sendRequest.mock.calls[0]?.[1]).toMatchObject({ modelId: 'custom-model' })
  })
})
