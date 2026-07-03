/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for MarkdownView — the shared markdown → React renderer used by both
 *  the ACP chat and the markdown preview editor.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  IEditorGroupsService,
  IEditorService,
  IEditorResolverService,
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type EditorInput,
} from '@universe-editor/platform'
import type {
  IConfigurationService as IConfigurationServiceType,
  IEditorGroup,
  IEditorGroupsService as IEditorGroupsServiceType,
  IEditorService as IEditorServiceType,
  IEditorResolverService as IEditorResolverServiceType,
  IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { MarkdownView, DocLinkContext } from '../MarkdownView.js'
import { ServicesContext } from '../../useService.js'
import { MarkdownPreviewInput } from '../../../services/editor/MarkdownPreviewInput.js'
import {
  MarkdownPreviewRegistry,
  type IMarkdownPreviewController,
} from '../../../services/editor/MarkdownPreviewRegistry.js'

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
  MarkdownPreviewRegistry._resetForTests()
  vi.restoreAllMocks()
  renderMock.mockReset()
})

function makeResolver(
  openEditor: (uri: URI, options?: unknown) => Promise<void> = vi.fn().mockResolvedValue(undefined),
): IEditorResolverServiceType {
  return {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor,
  } as unknown as IEditorResolverServiceType
}

function makeConfig(): IConfigurationServiceType {
  return {
    _serviceBrand: undefined,
    get: () => 'dark',
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  } as unknown as IConfigurationServiceType
}

function makeFileService(exists: (resource: URI) => boolean | Promise<boolean>): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists(resource: URI) {
      return exists(resource)
    },
    async stat(resource: URI) {
      return { resource, isFile: true, isDirectory: false, size: 0, mtime: 0 }
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  }
}

function makeEditorService(openEditor = vi.fn()): IEditorServiceType {
  return {
    _serviceBrand: undefined,
    openEditor,
  } as unknown as IEditorServiceType
}

function makeGroupsService(opened: { editor: EditorInput; options: unknown }[]) {
  let activeEditor: EditorInput | undefined
  const group = {
    get activeEditor() {
      return activeEditor
    },
    get editors() {
      return activeEditor ? [activeEditor] : []
    },
    openEditor(editor: EditorInput, options?: unknown) {
      opened.push({ editor, options })
      activeEditor = editor
    },
    closeEditor: () => true,
    indexOf: () => -1,
  } as unknown as IEditorGroup
  return {
    _serviceBrand: undefined,
    get activeGroup() {
      return group
    },
    get groups() {
      return [group]
    },
    getGroups: () => [group],
  } as unknown as IEditorGroupsServiceType
}

function makePreviewController(
  overrides: Partial<IMarkdownPreviewController> = {},
): IMarkdownPreviewController {
  const onDidScroll = new Emitter<void>()
  return {
    scrollToLine: () => {},
    scrollToAnchor: () => {},
    getTopVisibleLine: () => 1,
    focus: () => {},
    onDidScroll: onDidScroll.event,
    openFind: () => {},
    closeFind: () => {},
    findNext: () => {},
    findPrev: () => {},
    showLinkHints: () => {},
    hideLinkHints: () => {},
    toggleHelp: () => {},
    ...overrides,
  }
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

  it('renders ordered list continuation lines inside one list', () => {
    const { container } = renderMarkdown('1. 子项1\n啊哈哈\n\n2. 子项2\n啊哈哈')
    expect(container.querySelectorAll('ol')).toHaveLength(1)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getByText(/子项2/).closest('ol')).toBe(container.querySelector('ol'))
  })

  it('renders an indented sublist nested inside its parent list item', () => {
    const { container } = renderMarkdown('1. 子项1\n   - a\n   - b\n\n2. 子项2')
    // Exactly one top-level ordered list with two items; no stray sibling lists.
    expect(container.querySelectorAll('ol')).toHaveLength(1)
    const topItems = container.querySelectorAll('ol > li')
    expect(topItems).toHaveLength(2)
    // The sublist lives inside the first <li>, not as a sibling of the <ol>.
    const sublist = topItems[0]!.querySelector('ul')
    expect(sublist).toBeTruthy()
    expect(sublist!.querySelectorAll('li')).toHaveLength(2)
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

  it('renders a data:image embed as a plain <img> by default', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const { container } = renderMarkdown(`![shot](${dataUrl})`)
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(dataUrl)
    expect(img?.getAttribute('alt')).toBe('shot')
  })

  it('delegates image rendering to the renderImage prop when provided', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver())
    services.set(IConfigurationService, makeConfig())
    const inst = new InstantiationService(services)
    render(
      <ServicesContext.Provider value={inst}>
        <MarkdownView
          text={`[@image](${dataUrl})`}
          renderImage={(src, alt) => (
            <span data-testid="custom-img" data-src={src} data-alt={alt} />
          )}
        />
      </ServicesContext.Provider>,
    )
    const el = screen.getByTestId('custom-img')
    expect(el.getAttribute('data-src')).toBe(dataUrl)
    expect(el.getAttribute('data-alt')).toBe('@image')
  })

  it('gives headings a slug anchor id (CJK kept)', () => {
    const { container } = renderMarkdown('## 子结构：ITalkItem\n\nbody')
    expect(container.querySelector('[data-anchor="子结构italkitem"]')?.tagName).toBe('H2')
  })

  it('renders a same-document #anchor link and scrolls to its heading on click', () => {
    const scrollSpy = vi.fn()
    // happy-dom doesn't implement scrollIntoView — stub it on the prototype.
    const proto = globalThis.HTMLElement.prototype as { scrollIntoView?: unknown }
    const original = proto.scrollIntoView
    proto.scrollIntoView = scrollSpy
    try {
      renderMarkdown('## 子结构：ITalkItem\n\n见下方[子结构](#子结构italkitem)。')
      const link = screen.getByRole('link', { name: '子结构' })
      expect(link.getAttribute('href')).toBe('#子结构italkitem')
      link.click()
      expect(scrollSpy).toHaveBeenCalledTimes(1)
    } finally {
      if (original === undefined) delete proto.scrollIntoView
      else proto.scrollIntoView = original
    }
  })

  it('opens cross-file markdown fragment links as previews and queues anchor reveal', async () => {
    const opened: { editor: EditorInput; options: unknown }[] = []
    const openExternal = vi.spyOn(window, 'open').mockImplementation(() => null)
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver())
    services.set(IConfigurationService, makeConfig())
    services.set(
      IFileService,
      makeFileService((resource) => resource.path === '/repo/docs/foo.md'),
    )
    services.set(IEditorService, makeEditorService())
    services.set(IEditorGroupsService, makeGroupsService(opened))
    const inst = new InstantiationService(services)

    render(
      <ServicesContext.Provider value={inst}>
        <MarkdownView
          text="* [foo](./foo.md#hello)"
          baseUri={URI.file('/repo/docs')}
          previewLinks
        />
      </ServicesContext.Provider>,
    )

    screen.getByRole('link', { name: 'foo' }).click()
    await waitFor(() => expect(opened).toHaveLength(1))
    expect(openExternal).not.toHaveBeenCalled()
    const preview = opened[0]!.editor
    expect(preview).toBeInstanceOf(MarkdownPreviewInput)
    expect((preview as MarkdownPreviewInput).sourceUri.path).toBe('/repo/docs/foo.md')

    const scrollToAnchor = vi.fn()
    MarkdownPreviewRegistry.register(
      (preview as MarkdownPreviewInput).sourceUri,
      makePreviewController({ scrollToAnchor }),
    )
    expect(scrollToAnchor).toHaveBeenCalledWith('hello')
  })

  it('strips @ from explicit file links before resolving them', async () => {
    const resolverOpen = vi.fn().mockResolvedValue(undefined)
    const exists = vi.fn((resource: URI) => resource.path === '/repo/docs/path/to/file')
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver(resolverOpen))
    services.set(IConfigurationService, makeConfig())
    services.set(IFileService, makeFileService(exists))
    services.set(IEditorService, makeEditorService())
    const inst = new InstantiationService(services)

    render(
      <ServicesContext.Provider value={inst}>
        <MarkdownView text="[file](@path/to/file)" baseUri={URI.file('/repo/docs')} />
      </ServicesContext.Provider>,
    )

    screen.getByRole('link', { name: 'file' }).click()
    await waitFor(() => expect(resolverOpen).toHaveBeenCalledTimes(1))
    expect(exists).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/repo/docs/path/to/file' }),
    )
    expect(resolverOpen.mock.calls[0]?.[0]?.path).toBe('/repo/docs/path/to/file')
  })

  it('opens a clicked image link through the editor resolver (image preview, not garbled text)', async () => {
    const resolverOpen = vi.fn().mockResolvedValue(undefined)
    const openEditor = vi.fn()
    const exists = vi.fn((resource: URI) => resource.path === '/repo/docs/pic.png')
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver(resolverOpen))
    services.set(IConfigurationService, makeConfig())
    services.set(IFileService, makeFileService(exists))
    services.set(IEditorService, makeEditorService(openEditor))
    const inst = new InstantiationService(services)

    render(
      <ServicesContext.Provider value={inst}>
        <MarkdownView text="[shot](/repo/docs/pic.png)" baseUri={URI.file('/repo/docs')} />
      </ServicesContext.Provider>,
    )

    screen.getByRole('link', { name: 'shot' }).click()
    await waitFor(() => expect(resolverOpen).toHaveBeenCalledTimes(1))
    // Routed via the resolver so image extensions map to the image preview.
    expect(resolverOpen.mock.calls[0]?.[0]?.path).toBe('/repo/docs/pic.png')
    // Must NOT bypass the resolver by opening a bare FileEditorInput directly.
    expect(openEditor).not.toHaveBeenCalled()
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

describe('DocLinkContext', () => {
  it('routes a relative .md link to the doc-link handler instead of window.open', () => {
    const openDocLink = vi.fn()
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver())
    services.set(IConfigurationService, makeConfig())
    const inst = new InstantiationService(services)
    render(
      <ServicesContext.Provider value={inst}>
        <DocLinkContext.Provider value={openDocLink}>
          <MarkdownView text="[提交改动](../git/commit.md)" />
        </DocLinkContext.Provider>
      </ServicesContext.Provider>,
    )
    const link = screen.getByRole('link', { name: '提交改动' })
    expect(link.getAttribute('target')).toBeNull()
    link.click()
    expect(openDocLink).toHaveBeenCalledWith('../git/commit.md')
    expect(windowOpen).not.toHaveBeenCalled()
    windowOpen.mockRestore()
  })

  it('routes a relative .md#anchor link to the doc-link handler', () => {
    const openDocLink = vi.fn()
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver())
    services.set(IConfigurationService, makeConfig())
    const inst = new InstantiationService(services)
    render(
      <ServicesContext.Provider value={inst}>
        <DocLinkContext.Provider value={openDocLink}>
          <MarkdownView text="[查看 amend](../git/commit.md#amend-section)" />
        </DocLinkContext.Provider>
      </ServicesContext.Provider>,
    )
    screen.getByRole('link', { name: '查看 amend' }).click()
    expect(openDocLink).toHaveBeenCalledWith('../git/commit.md#amend-section')
  })

  it('falls through to window.open when DocLinkContext is absent', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const services = new ServiceCollection()
    services.set(IEditorResolverService, makeResolver())
    services.set(IConfigurationService, makeConfig())
    const inst = new InstantiationService(services)
    render(
      <ServicesContext.Provider value={inst}>
        <MarkdownView text="[外部链接](https://example.com)" />
      </ServicesContext.Provider>,
    )
    screen.getByRole('link', { name: '外部链接' }).click()
    expect(windowOpen).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    windowOpen.mockRestore()
  })
})
