/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for MarkdownView — the shared markdown → React renderer used by both
 *  the ACP chat and the markdown preview editor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  IConfigurationService,
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import type {
  IConfigurationService as IConfigurationServiceType,
  IEditorResolverService as IEditorResolverServiceType,
} from '@universe-editor/platform'
import { MarkdownView } from '../MarkdownView.js'
import { ServicesContext } from '../../useService.js'

// Monaco won't load under happy-dom; stub so CodeBlock falls back to plain text.
vi.mock('../../editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => new Promise(() => {}),
  },
}))

// mermaid can't render real SVG under happy-dom; drive the two branches via a mock.
const { renderMock } = vi.hoisted(() => ({ renderMock: vi.fn() }))
vi.mock('../mermaidLoader.js', () => ({
  MermaidLoader: {
    ensureInitialized: () => Promise.resolve({}),
    render: renderMock,
  },
}))

afterEach(() => {
  cleanup()
  renderMock.mockReset()
})

function makeResolver(): IEditorResolverServiceType {
  return {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor: vi.fn().mockResolvedValue(undefined),
  } as unknown as IEditorResolverServiceType
}

function makeConfig(): IConfigurationServiceType {
  return {
    _serviceBrand: undefined,
    get: () => 'dark',
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  } as unknown as IConfigurationServiceType
}

function renderMarkdown(text: string, testId?: string) {
  const services = new ServiceCollection()
  services.set(IEditorResolverService, makeResolver())
  services.set(IConfigurationService, makeConfig())
  const inst = new InstantiationService(services)
  return render(
    <ServicesContext.Provider value={inst}>
      <MarkdownView text={text} {...(testId !== undefined ? { testId } : {})} />
    </ServicesContext.Provider>,
  )
}

describe('MarkdownView', () => {
  it('renders headings, bold, and italic', () => {
    renderMarkdown('# Title\n\nsome **bold** and *em*')
    expect(screen.getByText('Title').tagName).toBe('H1')
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByText('em').tagName).toBe('EM')
  })

  it('renders ordered and unordered lists', () => {
    const { container } = renderMarkdown('1. a\n\n2. b\n\n3. c\n\n- x\n- y')
    expect(container.querySelector('ol')).toBeTruthy()
    expect(container.querySelector('ul')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('renders a code fence with a language attribute', () => {
    const { container } = renderMarkdown('```ts\nconst x = 1\n```')
    const pre = container.querySelector('pre[data-lang="ts"]')
    expect(pre?.textContent).toContain('const x = 1')
  })

  it('renders GFM tables', () => {
    const { container } = renderMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelectorAll('th')).toHaveLength(2)
  })

  it('applies the optional testId to the root', () => {
    renderMarkdown('hello', 'preview-md')
    expect(screen.getByTestId('preview-md')).toBeTruthy()
  })

  it('drops links with unsafe schemes', () => {
    renderMarkdown('[evil](javascript:alert(1))')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('routes a mermaid fence to MermaidBlock and injects the rendered svg', async () => {
    renderMock.mockResolvedValue('<svg id="rendered"><g /></svg>')
    renderMarkdown('```mermaid\ngraph TD; A-->B\n```')
    const diagram = await screen.findByTestId('mermaid-diagram')
    expect(diagram.querySelector('svg')).toBeTruthy()
    expect(renderMock).toHaveBeenCalledWith('graph TD; A-->B', 'dark')
  })

  it('falls back to a code block when mermaid rendering fails', async () => {
    renderMock.mockRejectedValue(new Error('syntax error'))
    const { container } = renderMarkdown('```mermaid\nnot a diagram\n```')
    await waitFor(() => expect(renderMock).toHaveBeenCalled())
    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
    const pre = container.querySelector('pre[data-lang="mermaid"]')
    expect(pre?.textContent).toContain('not a diagram')
  })

  it('streaming mode produces the same DOM as a one-shot render', () => {
    const full = '# Title\n\nfirst **para**\n\n- a\n- b\n\n```ts\nconst x = 1\n```\n\ntail text'
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver())
    services.set(IConfigurationService, makeConfig())
    const inst = new InstantiationService(services)
    const { rerender } = render(
      <ServicesContext.Provider value={inst}>
        <MarkdownView text={full.slice(0, 1)} streaming testId="stream-md" />
      </ServicesContext.Provider>,
    )
    // Grow the text chunk by chunk through the incremental path.
    for (let i = 2; i <= full.length; i++) {
      rerender(
        <ServicesContext.Provider value={inst}>
          <MarkdownView text={full.slice(0, i)} streaming testId="stream-md" />
        </ServicesContext.Provider>,
      )
    }
    const streamedHtml = screen.getByTestId('stream-md').innerHTML
    cleanup()
    renderMarkdown(full, 'stream-md')
    expect(streamedHtml).toBe(screen.getByTestId('stream-md').innerHTML)
  })
})
