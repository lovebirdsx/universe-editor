import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@universe-editor/extension-api'
import { activate } from '../extension.js'

const mocks = vi.hoisted(() => ({
  appendLine: vi.fn(),
  showInformationMessage: vi.fn(),
  registerCommand: vi.fn(),
  createOutputChannel: vi.fn(),
}))

vi.mock('@universe-editor/extension-api', () => ({
  commands: { registerCommand: mocks.registerCommand },
  window: {
    createOutputChannel: mocks.createOutputChannel,
    showInformationMessage: mocks.showInformationMessage,
  },
}))

function fakeContext(): ExtensionContext {
  return { subscriptions: { push: vi.fn() } } as unknown as ExtensionContext
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createOutputChannel.mockReturnValue({ appendLine: mocks.appendLine })
})

describe('activate', () => {
  it('registers the hello-world command wired to the output channel', () => {
    let handler: (() => void) | undefined
    mocks.registerCommand.mockImplementation((_id: string, fn: () => void) => {
      handler = fn
      return { dispose: () => undefined }
    })

    activate(fakeContext())

    expect(mocks.registerCommand).toHaveBeenCalledWith(
      '__name__.helloWorld',
      expect.any(Function),
    )
    expect(mocks.createOutputChannel).toHaveBeenCalledWith('__displayName__')

    handler?.()

    expect(mocks.appendLine).toHaveBeenCalledWith('Hello from __displayName__!')
    expect(mocks.showInformationMessage).toHaveBeenCalledWith('Hello from __displayName__!')
  })
})
