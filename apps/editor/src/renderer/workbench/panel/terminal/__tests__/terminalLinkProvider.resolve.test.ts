/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Terminal file links must not start a workspace file search on hover: on a huge
 *  tree that search is a full ripgrep walk (diagnostics showed the PowerShell
 *  banner URL `https://aka.ms/pscore6` driving minutes of rg at high CPU).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import type { Terminal, ILink } from '@xterm/xterm'
import { URI } from '@universe-editor/platform'
import { createFileLinkProvider, type ResolveTerminalFile } from '../terminalLinkProvider.js'
import { makeTerminalBuffer } from './terminalFakeBuffer.js'

function provideLinks(text: string, resolveFile: ResolveTerminalFile, openFile = vi.fn()) {
  const term = { buffer: { active: makeTerminalBuffer(text, 200) } } as unknown as Terminal
  let links: ILink[] = []
  createFileLinkProvider(
    term,
    resolveFile,
    openFile,
    () => '/workspace',
    () => undefined,
  ).provideLinks(1, (l) => {
    links = l ?? []
  })
  return links
}

describe('terminal file-link resolution', () => {
  it('hovers with a stat-only resolve and searches only on click', async () => {
    const uri = URI.file('/workspace/src/found.ts')
    const resolveFile = vi.fn<ResolveTerminalFile>(async (_p, options) =>
      options?.search === true ? uri : null,
    )
    const openFile = vi.fn()

    const links = provideLinks('error in src/found.ts:3', resolveFile, openFile)
    expect(links).toHaveLength(1)
    expect(resolveFile).toHaveBeenCalledTimes(1)
    expect(resolveFile.mock.calls[0]![1]?.search).not.toBe(true)

    links[0]!.activate({ button: 0 } as MouseEvent, '')
    await vi.waitFor(() =>
      expect(openFile).toHaveBeenCalledWith(uri, 3, undefined, undefined, 'default'),
    )
    expect(resolveFile).toHaveBeenLastCalledWith('/workspace/src/found.ts', { search: true })
  })

  it('does not search on click when the exact path already exists', async () => {
    const uri = URI.file('/workspace/src/a.ts')
    const resolveFile = vi.fn<ResolveTerminalFile>(async () => uri)
    const openFile = vi.fn()

    const links = provideLinks('src/a.ts', resolveFile, openFile)
    links[0]!.activate({ button: 0 } as MouseEvent, '')
    await vi.waitFor(() => expect(openFile).toHaveBeenCalled())
    expect(resolveFile).toHaveBeenCalledTimes(1)
  })

  it('produces no file link for the path tail of a URL', () => {
    const resolveFile = vi.fn<ResolveTerminalFile>(async () => null)
    const links = provideLinks(
      'Try the new cross-platform PowerShell https://aka.ms/pscore6',
      resolveFile,
    )
    expect(links).toHaveLength(0)
    expect(resolveFile).not.toHaveBeenCalled()
  })

  it('still links Windows drive paths', () => {
    const resolveFile = vi.fn<ResolveTerminalFile>(async () => null)
    const links = provideLinks('at C:/repo/src/a.ts:12', resolveFile)
    expect(links.map((l) => l.text)).toEqual(['C:/repo/src/a.ts:12'])
  })
})
