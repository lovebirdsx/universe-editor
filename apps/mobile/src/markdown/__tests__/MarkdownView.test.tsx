import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownView } from '../MarkdownView.js'
import { strings } from '../../strings.js'

describe('MarkdownView', () => {
  it('renders headings, lists, code fences and inline code', () => {
    const { container } = render(
      <MarkdownView
        text={'# Title\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n\nUse `inline` here.'}
      />,
    )

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Title')
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['one', 'two'])
    expect(container.querySelector('.md-code-block__lang')?.textContent).toBe('ts')
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1')
    expect(container.querySelector('.md-inline-code')?.textContent).toBe('inline')
  })

  it('renders external links with rel=noopener', () => {
    render(<MarkdownView text="[Open](https://example.com/docs)" />)
    const link = screen.getByRole('link', { name: 'Open' })
    expect(link.getAttribute('href')).toBe('https://example.com/docs')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('renders GFM tables', () => {
    render(<MarkdownView text={'| A | B |\n| --- | :-: |\n| 1 | 2 |'} />)
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeTruthy()
    expect(screen.getByRole('cell', { name: '1' })).toBeTruthy()
  })

  it('does not inject raw HTML', () => {
    const { container } = render(
      <MarkdownView text={'<img src=x onerror="alert(1)"> <script>alert(1)</script>'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('rejects javascript: links and keeps them literal', () => {
    const { container } = render(<MarkdownView text="[click](javascript:alert(1))" />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('[click](javascript:alert(1))')
  })

  it('shows file links as inert text', () => {
    const { container } = render(
      <MarkdownView text={'[file](file:///tmp/x.txt) and /home/test/a.ts:12'} />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText('file')).toBeTruthy()
    const filepath = screen.getByText('/home/test/a.ts:12')
    expect(filepath.tagName).toBe('SPAN')
    expect(filepath.className).toContain('md-filepath')
  })

  it('renders images as a placeholder instead of loading external resources', () => {
    const { container } = render(
      <MarkdownView text="![screenshot](https://example.com/shot.png)" />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(strings.markdownImage('screenshot'))).toBeTruthy()
  })

  it('renders remote and data images directly when a loader is present', () => {
    const loader = { fetchWorkspaceImageBlob: vi.fn() }
    const { container } = render(
      <MarkdownView
        text={'![remote](https://example.com/a.png) ![inline](data:image/png;base64,AAA=)'}
        imageLoader={loader}
      />,
    )

    const images = [...container.querySelectorAll('img')]
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      'https://example.com/a.png',
      'data:image/png;base64,AAA=',
    ])
    expect(images.every((img) => img.getAttribute('referrerpolicy') === 'no-referrer')).toBe(true)
    expect(loader.fetchWorkspaceImageBlob).not.toHaveBeenCalled()
  })

  it('loads workspace paths through the loader and opens the preview', async () => {
    const loader = {
      fetchWorkspaceImageBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    }
    render(<MarkdownView text="![shot](img/a.png)" imageLoader={loader} />)

    await waitFor(() => screen.getByTestId('markdown-image'))
    expect(loader.fetchWorkspaceImageBlob).toHaveBeenCalledWith('img/a.png')

    fireEvent.click(screen.getByTestId('markdown-image'))
    expect(screen.getByTestId('image-preview')).toBeTruthy()
    fireEvent.click(screen.getByTestId('image-preview-close'))
    expect(screen.queryByTestId('image-preview')).toBeNull()
  })

  it('shows a failure label when a workspace image cannot be read', async () => {
    const loader = { fetchWorkspaceImageBlob: vi.fn(async () => Promise.reject(new Error('no'))) }
    render(<MarkdownView text="![shot](img/a.png)" imageLoader={loader} />)

    await waitFor(() =>
      expect(screen.getByTestId('markdown-image-failed').textContent).toContain(
        strings.markdownImageLoadFailed,
      ),
    )
  })

  it('keeps oversized image sources inert even with a loader', () => {
    const loader = { fetchWorkspaceImageBlob: vi.fn() }
    const { container } = render(
      <MarkdownView
        text={`![x](https://example.com/${'a'.repeat(8200)}.png)`}
        imageLoader={loader}
      />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText(strings.markdownImage('x'))).toBeTruthy()
    expect(loader.fetchWorkspaceImageBlob).not.toHaveBeenCalled()
  })

  it('does not nest an anchor around a previewable image', async () => {
    const loader = {
      fetchWorkspaceImageBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    }
    const { container } = render(
      <MarkdownView text="[![shot](img/a.png)](https://example.com/x)" imageLoader={loader} />,
    )

    await waitFor(() => screen.getByTestId('markdown-image'))
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('.md-link--inert')).toBeTruthy()
  })
})
