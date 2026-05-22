/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for MessageContent — renders AcpContentBlock[] as React. Validates
 *  markdown rendering, image / resource_link handling, and the IEditorResolverService
 *  click wiring for file:// resources and file:// links.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type { IEditorResolverService as IEditorResolverServiceType } from '@universe-editor/platform'
import type { AcpContentBlock } from '../../../services/acp/acpProtocol.js'
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

function renderContent(blocks: readonly AcpContentBlock[], resolver?: IEditorResolverServiceType) {
  const services = new ServiceCollection()
  services.set(IEditorResolverService, resolver ?? makeEditorResolver())
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <MessageContent blocks={blocks} />
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
    renderContent([{ type: 'resource', uri: 'file:///workspace/bar.md' }])
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

  it('opens the editor when a file:// markdown link is clicked', () => {
    const resolver = makeEditorResolver()
    renderContent([{ type: 'text', text: '[foo](file:///workspace/foo.ts)' }], resolver)
    const a = screen.getByRole('link', { name: 'foo' })
    fireEvent.click(a)
    expect(resolver.openEditor).toHaveBeenCalledTimes(1)
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
})
