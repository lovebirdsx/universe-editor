/**
 * Tests for the markdown filesystem bridge. The headline guard is the workspace
 * scan: it must go through the renderer's bounded, rg-backed `workspace.findFiles`
 * and never walk the tree with per-directory `readDirectory` RPCs. The hand-rolled
 * walk it replaced never returned on a game depot (600k+ directories), which
 * pinned the '#' workspace-symbol picker's spinner forever.
 */
import { describe, expect, it, vi } from 'vitest'

const findFiles = vi.fn()
const readDirectory = vi.fn()
const readFile = vi.fn()
const stat = vi.fn()

vi.mock('@universe-editor/extension-api', () => ({
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: {
    findFiles: (...args: unknown[]) => findFiles(...args),
    fs: {
      readDirectory: (...args: unknown[]) => readDirectory(...args),
      readFile: (...args: unknown[]) => readFile(...args),
      stat: (...args: unknown[]) => stat(...args),
    },
  },
}))

const { createMdFsBridge } = await import('../mdFsBridge.js')
const { URI } = await import('vscode-uri')

describe('createMdFsBridge.$findMarkdownFiles', () => {
  it('enumerates through workspace.findFiles, never by walking directories', async () => {
    findFiles.mockResolvedValue([URI.file('/ws/a.md'), URI.file('/ws/docs/b.markdown')])
    const bridge = createMdFsBridge(URI.file('/ws'))

    const found = await bridge.$findMarkdownFiles()

    expect(found).toEqual([
      URI.file('/ws/a.md').toString(),
      URI.file('/ws/docs/b.markdown').toString(),
    ])
    // The scan is one bounded call, not a per-directory RPC storm.
    expect(readDirectory).not.toHaveBeenCalled()
    expect(findFiles).toHaveBeenCalledTimes(1)
    const [include, exclude, maxResults] = findFiles.mock.calls[0]!
    expect(include).toBe('**/*.{md,markdown}')
    // undefined exclude = the configured search excludes (files.exclude ∪ search.exclude).
    expect(exclude).toBeUndefined()
    expect(typeof maxResults).toBe('number')
    expect(maxResults).toBeGreaterThan(0)
  })

  it('returns nothing without an open workspace folder', async () => {
    findFiles.mockClear()
    const bridge = createMdFsBridge(undefined)
    expect(await bridge.$findMarkdownFiles()).toEqual([])
    expect(findFiles).not.toHaveBeenCalled()
  })
})
