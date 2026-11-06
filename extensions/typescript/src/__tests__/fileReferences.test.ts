import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Location } from 'vscode-languageserver-types'
import { getFileReferences } from '../extension.js'

const h = vi.hoisted(() => ({
  openTextDocument: vi.fn(),
  showWarningMessage: vi.fn(async () => undefined),
}))

vi.mock('@universe-editor/extension-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@universe-editor/extension-api')>()
  return {
    ...actual,
    // getFileReferences only reaches these two members; the rest of the module
    // surface is imported at module load but never called in this test.
    workspace: { openTextDocument: h.openTextDocument },
    window: { showWarningMessage: h.showWarningMessage },
  }
})

interface FakeDoc {
  uri: {
    scheme: string
    authority: string
    path: string
    query: string
    fragment: string
  }
  languageId: string
  version: number
  getText: () => string
}

function makeDoc(languageId = 'typescript'): FakeDoc {
  return {
    uri: {
      scheme: 'file',
      authority: '',
      path: '/ws/lib.ts',
      query: '',
      fragment: '',
    },
    languageId,
    version: 3,
    getText: () => 'export const value = 1',
  }
}

function makeClient(locations: Location[] | null = []) {
  return {
    didOpen: vi.fn(
      async (_uri: string, _languageId: string, _version: () => number, _text: () => string) =>
        undefined,
    ),
    provideFileReferences: vi.fn(async (): Promise<Location[] | null> => locations),
  }
}

beforeEach(() => {
  h.openTextDocument.mockReset()
  h.showWarningMessage.mockReset()
})

describe('getFileReferences', () => {
  it('opens and didOpens the target, then returns the server locations', async () => {
    const doc = makeDoc()
    h.openTextDocument.mockResolvedValue(doc)
    const locations = [
      {
        uri: 'file:///ws/use.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ]
    const client = makeClient(locations)

    const result = await getFileReferences(client, 'tsls', 'file:///ws/lib.ts')

    expect(h.openTextDocument).toHaveBeenCalledOnce()
    const target = h.openTextDocument.mock.calls[0]![0] as {
      toJSON: () => unknown
      toString: () => string
    }
    expect(typeof target.toJSON).toBe('function')
    expect(target.toString()).toBe('file:///ws/lib.ts')

    expect(client.didOpen).toHaveBeenCalledOnce()
    const [, languageId, version, text] = client.didOpen.mock.calls[0]!
    expect(languageId).toBe('typescript')
    expect(version()).toBe(3)
    expect(text()).toBe('export const value = 1')
    expect(client.provideFileReferences).toHaveBeenCalledWith('file:///ws/lib.ts')
    expect(result).toBe(locations)
  })

  it('warns instead of querying on the native server', async () => {
    const client = makeClient()

    await expect(getFileReferences(client, 'native', 'file:///ws/lib.ts')).resolves.toEqual([])

    expect(h.showWarningMessage).toHaveBeenCalledOnce()
    expect(h.openTextDocument).not.toHaveBeenCalled()
    expect(client.didOpen).not.toHaveBeenCalled()
  })

  it.each([undefined, 42, 'untitled:Untitled-1', 'remote-ssh://wsl/ws/lib.ts'])(
    'ignores a non-file target (%s)',
    async (input) => {
      const client = makeClient()

      await expect(getFileReferences(client, 'tsls', input)).resolves.toEqual([])

      expect(h.openTextDocument).not.toHaveBeenCalled()
      expect(client.didOpen).not.toHaveBeenCalled()
    },
  )

  it('ignores a document the TypeScript server does not own', async () => {
    h.openTextDocument.mockResolvedValue(makeDoc('plaintext'))
    const client = makeClient()

    await expect(getFileReferences(client, 'tsls', 'file:///ws/lib.ts')).resolves.toEqual([])

    expect(client.didOpen).not.toHaveBeenCalled()
  })

  it('turns a null server response into an empty list', async () => {
    h.openTextDocument.mockResolvedValue(makeDoc())
    const client = {
      didOpen: vi.fn(async () => undefined),
      provideFileReferences: vi.fn(async () => null),
    }

    await expect(getFileReferences(client, 'tsls', 'file:///ws/lib.ts')).resolves.toEqual([])
  })
})
