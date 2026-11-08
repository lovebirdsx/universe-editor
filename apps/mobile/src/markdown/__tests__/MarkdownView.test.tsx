import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
