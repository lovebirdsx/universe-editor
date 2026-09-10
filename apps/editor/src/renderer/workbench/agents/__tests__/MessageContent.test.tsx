/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for MessageContent — renders ContentBlock[] as React. Validates
 *  markdown rendering, image / resource_link handling, and the IEditorResolverService
 *  click wiring for file:// resources and file:// links.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  IEditorResolverService,
  IEditorService,
  IFileService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type {
  IEditorResolverService as IEditorResolverServiceType,
  IEditorService as IEditorServiceType,
  IFileService as IFileServiceType,
} from '@universe-editor/platform'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { MessageContent } from '../MessageContent.js'
import { ServicesContext } from '../../useService.js'

// MonacoLoader is heavy + lazily imports the package; tests run in happy-dom
// where Monaco won't actually load. Stub it so the CodeBlock effect short-circuits
// to the plain-text fallback path (`html === null`).
vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => new Promise(() => {}),
  },
}))

afterEach(() => {
  cleanup()
})

function makeEditorResolver(): IEditorResolverServiceType & {
  openEditor: ReturnType<typeof vi.fn>
} {
  const openEditor = vi.fn().mockResolvedValue(undefined)
  return {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor,
  } as unknown as IEditorResolverServiceType & { openEditor: ReturnType<typeof vi.fn> }
}

function renderContent(blocks: readonly ContentBlock[], resolver?: IEditorResolverServiceType) {
  const services = new ServiceCollection()
  services.set(IEditorResolverService, resolver ?? makeEditorResolver())
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <MessageContent blocks={blocks} />
    </ServicesContext.Provider>,
  )
}

function renderPlain(blocks: readonly ContentBlock[]) {
  const services = new ServiceCollection()
  services.set(IEditorResolverService, makeEditorResolver())
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <MessageContent blocks={blocks} variant="plain" />
    </ServicesContext.Provider>,
  )
}

describe('MessageContent', () => {
  it('renders an empty container when no blocks', () => {
    const { container } = renderContent([])
    const root = container.firstChild as HTMLElement
    expect(root).not.toBeNull()
    expect(root.childNodes.length).toBe(0)
  })

  it('renders a plain text block as a paragraph', () => {
    renderContent([{ type: 'text', text: 'hello world' }])
    expect(screen.getByTestId('acp-markdown')).toBeTruthy()
    const p = screen.getByText('hello world')
    expect(p.tagName).toBe('P')
  })

  it('renders bold and italic markdown inline', () => {
    renderContent([{ type: 'text', text: 'a **bold** and *em* text' }])
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('em').tagName).toBe('EM')
  })

  it('renders ATX headings up to h6', () => {
    renderContent([{ type: 'text', text: '# h1\n## h2\n### h3' }])
    expect(screen.getByText('h1').tagName).toBe('H1')
    expect(screen.getByText('h2').tagName).toBe('H2')
    expect(screen.getByText('h3').tagName).toBe('H3')
  })

  it('renders unordered and ordered lists', () => {
    renderContent([{ type: 'text', text: '- a\n- b\n- c' }])
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toBe('a')
  })

  it('renders code fence with language attribute', () => {
    const { container } = renderContent([{ type: 'text', text: '```ts\nconst x = 1\n```' }])
    const pre = container.querySelector('pre[data-lang="ts"]')
    expect(pre).toBeTruthy()
    expect(pre?.textContent).toContain('const x = 1')
  })

  it('renders inline code', () => {
    const { container } = renderContent([{ type: 'text', text: 'use `npm install`' }])
    const code = container.querySelector('code')
    expect(code).toBeTruthy()
    expect(code?.textContent).toBe('npm install')
  })

  it('renders an image block as a data URI', () => {
    renderContent([{ type: 'image', mimeType: 'image/png', data: 'YWJjZA==' }])
    const img = screen.getByTestId('acp-image-block') as HTMLImageElement
    expect(img.src).toBe('data:image/png;base64,YWJjZA==')
  })

  it('opens the preview popover when the image block is clicked and closes on second click', () => {
    renderContent([{ type: 'image', mimeType: 'image/png', data: 'YWJjZA==' }])
    fireEvent.click(screen.getByTestId('acp-image-block'))
    expect(screen.getByTestId('acp-image-preview-popover')).toBeTruthy()
    fireEvent.click(screen.getByTestId('acp-image-block'))
    expect(screen.queryByTestId('acp-image-preview-popover')).toBeNull()
  })

  it('renders a restored Codex text-embedded image as a ChatImage thumbnail', () => {
    const dataUrl = 'data:image/png;base64,YWJjZA=='
    renderContent([{ type: 'text', text: `[@image](${dataUrl})` }])
    const img = screen.getByTestId('acp-image-block') as HTMLImageElement
    expect(img.src).toBe(dataUrl)
    // the raw markdown text must not leak through
    expect(screen.queryByText(/\[@image\]/)).toBeNull()
  })

  it('groups consecutive image blocks into a single horizontal row', () => {
    renderContent([
      { type: 'image', mimeType: 'image/png', data: 'YWJjZA==' },
      { type: 'image', mimeType: 'image/png', data: 'ZWZnaA==' },
      { type: 'text', text: 'between' },
      { type: 'image', mimeType: 'image/png', data: 'aWprbA==' },
    ])
    const rows = screen.getAllByTestId('acp-image-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelectorAll('[data-testid="acp-image-block"]')).toHaveLength(2)
    expect(rows[1]?.querySelectorAll('[data-testid="acp-image-block"]')).toHaveLength(1)
  })

  it('renders an audio placeholder', () => {
    renderContent([{ type: 'audio', mimeType: 'audio/wav', data: 'd2F2' }])
    const node = screen.getByTestId('acp-audio-block')
    expect(node.textContent).toContain('audio/wav')
  })

  it('renders a resource_link as an enabled button when the URI is file://', () => {
    renderContent([
      {
        type: 'resource_link',
        uri: 'file:///workspace/foo.ts',
        name: 'foo.ts',
        mimeType: 'text/typescript',
      },
    ])
    const btn = screen.getByTestId('acp-resource-link') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toContain('foo.ts')
    expect(btn.textContent).toContain('text/typescript')
  })

  it('renders a resource_link as a disabled button for non-file schemes', () => {
    renderContent([{ type: 'resource_link', uri: 'https://example.com/x', name: 'remote' }])
    const btn = screen.getByTestId('acp-resource-link') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('renders a `resource` block similarly to resource_link', () => {
    renderContent([{ type: 'resource', resource: { uri: 'file:///workspace/bar.md', text: '' } }])
    const btn = screen.getByTestId('acp-resource-link') as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(btn.textContent).toContain('file:///workspace/bar.md')
  })

  it('opens the editor when a file:// resource_link is clicked', () => {
    const resolver = makeEditorResolver()
    renderContent(
      [
        {
          type: 'resource_link',
          uri: 'file:///workspace/foo.ts',
          name: 'foo.ts',
        },
      ],
      resolver,
    )
    fireEvent.click(screen.getByTestId('acp-resource-link'))
    expect(resolver.openEditor).toHaveBeenCalledTimes(1)
    const arg = resolver.openEditor.mock.calls[0]?.[0] as { scheme: string; fsPath: string }
    expect(arg?.scheme).toBe('file')
  })

  it('does not open the editor when a non-file resource is clicked', () => {
    const resolver = makeEditorResolver()
    renderContent([{ type: 'resource_link', uri: 'https://example.com/x', name: 'x' }], resolver)
    fireEvent.click(screen.getByTestId('acp-resource-link'))
    expect(resolver.openEditor).not.toHaveBeenCalled()
  })

  it('opens the editor when a file:// markdown link is clicked', async () => {
    const resolver = makeEditorResolver()
    // file:// links resolve through the shared file-link pipeline, which probes
    // the target on disk before opening.
    const services = new ServiceCollection()
    services.set(IEditorResolverService, resolver)
    services.set(IFileService, {
      _serviceBrand: undefined,
      exists: () => Promise.resolve(true),
      stat: (resource: unknown) =>
        Promise.resolve({ resource, isFile: true, isDirectory: false, size: 0, mtime: 0 }),
    } as unknown as IFileServiceType)
    services.set(IEditorService, {
      _serviceBrand: undefined,
      openEditor: vi.fn(),
    } as unknown as IEditorServiceType)
    const inst = new InstantiationService(services)
    render(
      <ServicesContext.Provider value={inst}>
        <MessageContent blocks={[{ type: 'text', text: '[foo](file:///workspace/foo.ts)' }]} />
      </ServicesContext.Provider>,
    )
    const a = screen.getByRole('link', { name: 'foo' })
    fireEvent.click(a)
    await waitFor(() => expect(resolver.openEditor).toHaveBeenCalledTimes(1))
  })

  it('routes external http(s) markdown links through window.open', () => {
    const resolver = makeEditorResolver()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      renderContent([{ type: 'text', text: '[github](https://example.com/g)' }], resolver)
      fireEvent.click(screen.getByRole('link', { name: 'github' }))
      expect(open).toHaveBeenCalledWith('https://example.com/g', '_blank', 'noopener,noreferrer')
      expect(resolver.openEditor).not.toHaveBeenCalled()
    } finally {
      open.mockRestore()
    }
  })

  it('drops malformed markdown links with unsafe schemes', () => {
    renderContent([{ type: 'text', text: '[evil](javascript:alert(1))' }])
    // Unsafe href → not rendered as a <a>; the literal text remains in the DOM.
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders multiple blocks in sequence', () => {
    renderContent([
      { type: 'text', text: 'hello' },
      { type: 'resource_link', uri: 'file:///foo.md', name: 'foo.md' },
      { type: 'image', mimeType: 'image/png', data: 'YWJjZA==' },
    ])
    expect(screen.getByText('hello')).toBeTruthy()
    expect(screen.getByTestId('acp-resource-link')).toBeTruthy()
    expect(screen.getByTestId('acp-image-block')).toBeTruthy()
  })

  it('renders a slash-command wrapper as a compact badge', () => {
    renderContent([
      {
        type: 'text',
        text:
          '<command-name>/model</command-name>\n' +
          '<command-message>model</command-message>\n' +
          '<command-args>default</command-args>\n' +
          '<local-command-stdout>Set model to claude-sonnet-4-6</local-command-stdout>',
      },
    ])
    const badge = screen.getByTestId('acp-command-badge')
    expect(badge.textContent).toContain('/model default')
    expect(screen.getByTestId('acp-command-badge-stdout').textContent).toContain(
      'Set model to claude-sonnet-4-6',
    )
    // The raw XML tags must not leak through to the markdown renderer.
    expect(screen.queryByText(/<command-name>/)).toBeNull()
  })

  it('reassembles wrappers split across consecutive text blocks (streaming case)', () => {
    renderContent([
      { type: 'text', text: '<command-name>/cle' },
      { type: 'text', text: 'ar</command-name>' },
    ])
    const badge = screen.getByTestId('acp-command-badge')
    expect(badge.textContent).toContain('/clear')
    expect(screen.queryByText(/<command-name>/)).toBeNull()
  })

  it('keeps surrounding prose around a badge', () => {
    renderContent([
      {
        type: 'text',
        text: 'before text\n<command-name>/clear</command-name>\nafter text',
      },
    ])
    expect(screen.getByTestId('acp-command-badge')).toBeTruthy()
    expect(screen.getByText('before text')).toBeTruthy()
    expect(screen.getByText('after text')).toBeTruthy()
  })

  it('renders back-to-back invocations as two badges', () => {
    renderContent([
      {
        type: 'text',
        text: '<command-name>/a</command-name><command-name>/b</command-name>',
      },
    ])
    expect(screen.getAllByTestId('acp-command-badge')).toHaveLength(2)
  })

  it('renders agent notification XML literally and links only the embedded path', () => {
    // Regression: `<task-notification>…</task-notification>`-style text — the
    // closing tags are markup, not absolute paths; only the real path inside
    // the body becomes a link.
    const input =
      '<task-notification><summary>build failed: src/foo.ts:10:5</summary></task-notification>'
    const { container } = renderContent([{ type: 'text', text: input }])
    const links = screen.getAllByTestId('md-filepath')
    expect(links).toHaveLength(1)
    expect(links[0]!.textContent).toBe('src/foo.ts:10:5')
    expect(container.textContent).toBe(input)
  })

  describe('variant="plain" (user messages)', () => {
    it('renders markdown syntax verbatim without inline formatting', () => {
      const { container } = renderPlain([{ type: 'text', text: 'a **bold** and *em* text' }])
      const plain = screen.getByTestId('acp-plaintext')
      expect(plain.textContent).toBe('a **bold** and *em* text')
      expect(screen.queryByTestId('acp-markdown')).toBeNull()
      expect(container.querySelector('strong')).toBeNull()
      expect(container.querySelector('em')).toBeNull()
    })

    it('does not parse ATX headings or markdown link syntax', () => {
      const { container } = renderPlain([
        { type: 'text', text: '# not a heading\n[not a link](https://example.com)' },
      ])
      expect(container.querySelector('h1')).toBeNull()
      expect(screen.getByTestId('acp-plaintext').textContent).toBe(
        '# not a heading\n[not a link](https://example.com)',
      )
    })

    it('preserves newlines via the pre-wrap block', () => {
      renderPlain([{ type: 'text', text: 'line one\nline two\nline three' }])
      const plain = screen.getByTestId('acp-plaintext')
      expect(plain.textContent).toBe('line one\nline two\nline three')
      expect(plain.className).toContain('plainTextBlock')
    })

    it('still strips slash-command wrappers into badges', () => {
      renderPlain([
        {
          type: 'text',
          text:
            '<command-name>/model</command-name>\n' +
            '<command-message>model</command-message>\n' +
            '<command-args>default</command-args>\n' +
            '<local-command-stdout>Set model to claude-sonnet-4-6</local-command-stdout>',
        },
      ])
      expect(screen.getByTestId('acp-command-badge').textContent).toContain('/model default')
      expect(screen.queryByText(/<command-name>/)).toBeNull()
    })

    it('renders image and resource blocks identically to the markdown variant', () => {
      renderPlain([
        { type: 'image', mimeType: 'image/png', data: 'YWJjZA==' },
        { type: 'resource_link', uri: 'file:///workspace/foo.ts', name: 'foo.ts' },
      ])
      expect(screen.getByTestId('acp-image-block')).toBeTruthy()
      expect(screen.getByTestId('acp-resource-link')).toBeTruthy()
    })

    it('linkifies a bare URL while keeping surrounding text verbatim', () => {
      const { container } = renderPlain([
        { type: 'text', text: 'See https://example.com/a?b=1 for details' },
      ])
      const plain = screen.getByTestId('acp-plaintext')
      expect(plain.textContent).toBe('See https://example.com/a?b=1 for details')
      const link = container.querySelector('a')!
      expect(link.getAttribute('href')).toBe('https://example.com/a?b=1')
      expect(link.textContent).toBe('https://example.com/a?b=1')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    })

    it('linkifies multiple URLs and strips trailing CJK punctuation', () => {
      const { container } = renderPlain([
        { type: 'text', text: '请看https://example.com。还有 https://a.example.com/b, 完' },
      ])
      const plain = screen.getByTestId('acp-plaintext')
      expect(plain.textContent).toBe('请看https://example.com。还有 https://a.example.com/b, 完')
      const links = [...container.querySelectorAll('a')]
      expect(links.map((l) => l.getAttribute('href'))).toEqual([
        'https://example.com',
        'https://a.example.com/b',
      ])
    })

    it('linkifies the bare URL inside markdown link syntax without parsing the syntax', () => {
      const { container } = renderPlain([
        { type: 'text', text: '[not a link](https://example.com)' },
      ])
      const plain = screen.getByTestId('acp-plaintext')
      // The syntax characters stay literal text; only the bare URL is a link.
      expect(plain.textContent).toBe('[not a link](https://example.com)')
      const link = container.querySelector('a')!
      expect(link.getAttribute('href')).toBe('https://example.com')
    })

    it('does not linkify a URL glued to a preceding word char', () => {
      const { container } = renderPlain([
        { type: 'text', text: 'foohttps://example.com and xhttps://example.com' },
      ])
      expect(container.querySelector('a')).toBeNull()
    })

    it('opens a clicked link in a new window instead of navigating', () => {
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
      try {
        const { container } = renderPlain([{ type: 'text', text: 'go https://example.com now' }])
        const link = container.querySelector('a')!
        fireEvent.click(link)
        expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
      } finally {
        openSpy.mockRestore()
      }
    })

    it('linkifies a URL at the very start and end of the text', () => {
      const { container } = renderPlain([
        { type: 'text', text: 'https://a.example.com mid https://b.example.com' },
      ])
      const links = [...container.querySelectorAll('a')]
      expect(links.map((l) => l.getAttribute('href'))).toEqual([
        'https://a.example.com',
        'https://b.example.com',
      ])
      expect(screen.getByTestId('acp-plaintext').textContent).toBe(
        'https://a.example.com mid https://b.example.com',
      )
    })

    it('matches an uppercase scheme and strips trailing ASCII punctuation', () => {
      const { container } = renderPlain([
        { type: 'text', text: 'See HTTPS://EXAMPLE.COM/A, then http://b.example.com.' },
      ])
      const links = [...container.querySelectorAll('a')]
      expect(links.map((l) => l.getAttribute('href'))).toEqual([
        'HTTPS://EXAMPLE.COM/A',
        'http://b.example.com',
      ])
    })

    it('linkifies a Unix absolute path with a :line:col suffix', () => {
      renderPlain([{ type: 'text', text: 'check /home/user/src/foo.ts:10:5 please' }])
      const plain = screen.getByTestId('acp-plaintext')
      expect(plain.textContent).toBe('check /home/user/src/foo.ts:10:5 please')
      const link = screen.getByTestId('md-filepath')
      expect(link.textContent).toBe('/home/user/src/foo.ts:10:5')
    })

    it('keeps XML closing tags literal while linking the embedded path', () => {
      // Same regression as the markdown variant, for the plain-text pipeline.
      const input =
        '<task-notification><summary>build failed: src/foo.ts:10:5</summary></task-notification>'
      renderPlain([{ type: 'text', text: input }])
      const links = screen.getAllByTestId('md-filepath')
      expect(links).toHaveLength(1)
      expect(links[0]!.textContent).toBe('src/foo.ts:10:5')
      expect(screen.getByTestId('acp-plaintext').textContent).toBe(input)
    })

    it('linkifies a Windows drive path', () => {
      renderPlain([{ type: 'text', text: String.raw`open C:\Users\dev\foo.ts now` }])
      expect(screen.getByTestId('md-filepath').textContent).toBe(String.raw`C:\Users\dev\foo.ts`)
    })

    it('a path directly after a CJK char links whole (CJK-aware relative path)', () => {
      // The CJK prefix is swallowed into the relative path — the intended
      // markdown behavior (`见项目/子级/结构` starts at `见`, not at `项`).
      renderPlain([{ type: 'text', text: '见src/foo/bar.ts' }])
      expect(screen.getByTestId('md-filepath').textContent).toBe('见src/foo/bar.ts')
    })

    it('linkifies a relative path only when it carries a directory separator', () => {
      renderPlain([{ type: 'text', text: 'edit src/foo/bar.ts and package.json' }])
      const links = screen.getAllByTestId('md-filepath')
      expect(links).toHaveLength(1)
      expect(links[0]!.textContent).toBe('src/foo/bar.ts')
      expect(screen.getByTestId('acp-plaintext').textContent).toBe(
        'edit src/foo/bar.ts and package.json',
      )
    })

    it('clicking a file-path link resolves through the file-link pipeline without crashing', () => {
      renderPlain([{ type: 'text', text: 'open src/foo/bar.ts' }])
      // With only IEditorResolverService registered, resolution reports
      // "missing" (no file service) — the click must not throw.
      fireEvent.click(screen.getByTestId('md-filepath'))
    })
  })
})
