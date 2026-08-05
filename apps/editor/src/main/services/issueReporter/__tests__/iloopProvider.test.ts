/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/issueReporter/providers/iloopProvider.ts
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NullLogger } from '@universe-editor/platform'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ILoopDefaults } from '../../../../shared/issueReporter.js'
import { ILoopIssueReporterProvider } from '../providers/iloopProvider.js'

const PASTE_HINT = '（诊断信息较长，请从剪贴板粘贴）'

function makeProvider(zipPath = '/nonexistent/universe-diagnostics.zip') {
  return new ILoopIssueReporterProvider(() => Promise.resolve(zipPath), new NullLogger())
}

function stubFetchOk(path = '/default/2026/08/05/zip.zip') {
  const fetchMock = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ path }), { status: 200 })),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ILoopIssueReporterProvider', () => {
  it('declares attachment support', () => {
    expect(makeProvider().supportsAttachments).toBe(true)
  })

  it('builds the addPost url from defaults without attachments when not requested', async () => {
    const fetchMock = stubFetchOk()
    const url = await makeProvider().buildIssueUrl({
      markdown: '## 版本',
      pasteHint: PASTE_HINT,
      attachDiagnostics: false,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    const parsed = new URL(url)
    expect(`${parsed.protocol}//${parsed.host}`).toBe(ILoopDefaults.appUrl)
    expect(parsed.pathname).toBe('/addPost')
    expect(parsed.searchParams.get('board')).toBe(ILoopDefaults.board)
    expect(parsed.searchParams.get('category')).toBe(ILoopDefaults.category)
    expect(parsed.searchParams.get('content')).toBe('## 版本')
    expect(parsed.searchParams.get('title')).toBeNull()
    expect(parsed.searchParams.get('attachments')).toBeNull()
  })

  it('honors providerOptions overrides', async () => {
    stubFetchOk()
    const url = await makeProvider().buildIssueUrl({
      markdown: 'x',
      pasteHint: PASTE_HINT,
      attachDiagnostics: false,
      providerOptions: {
        serverUrl: 'http://files.example.com:9999',
        appUrl: 'http://iloop.example.com/',
        board: 'other-board',
        category: '建议',
      },
    })
    expect(url.startsWith('http://iloop.example.com/addPost?')).toBe(true)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('board')).toBe('other-board')
    expect(parsed.searchParams.get('category')).toBe('建议')
  })

  it('uploads the diagnostics zip and references it as name@path attachment', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'iloop-test-'))
    const zipPath = join(dir, 'universe-diagnostics-2026-08-05.zip')
    await fs.writeFile(zipPath, 'PK fake zip')

    const fetchMock = stubFetchOk('/default/2026/08/05/universe-diagnostics.zip')
    const url = await makeProvider(zipPath).buildIssueUrl({
      markdown: 'body',
      pasteHint: PASTE_HINT,
      attachDiagnostics: true,
      providerOptions: { serverUrl: 'http://files.example.com:3030' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [uploadUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(uploadUrl).toBe('http://files.example.com:3030/upload')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)

    const parsed = new URL(url)
    expect(parsed.searchParams.get('attachments')).toBe(
      'universe-diagnostics-2026-08-05.zip@/default/2026/08/05/universe-diagnostics.zip',
    )
  })

  it('propagates upload failures', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'iloop-test-'))
    const zipPath = join(dir, 'diag.zip')
    await fs.writeFile(zipPath, 'PK')
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('nope', { status: 500, statusText: 'Server Error' })),
      ),
    )
    await expect(
      makeProvider(zipPath).buildIssueUrl({
        markdown: 'body',
        pasteHint: PASTE_HINT,
        attachDiagnostics: true,
      }),
    ).rejects.toThrow('HTTP 500')
  })

  it('degrades content to the paste hint when the url would exceed the cap', async () => {
    stubFetchOk()
    const url = await makeProvider().buildIssueUrl({
      markdown: 'x'.repeat(8000),
      pasteHint: PASTE_HINT,
      attachDiagnostics: false,
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('content')).toBe(PASTE_HINT)
  })
})
