/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/SearchResultsTree.tsx
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { URI, type IFileMatch } from '@universe-editor/platform'
import { SearchResultsTree } from '../SearchResultsTree.js'

afterEach(() => cleanup())

function makeMatch(path: string, line: number, preview: string): IFileMatch {
  return {
    resource: URI.file(path).toJSON(),
    matches: [{ lineNumber: line, preview, ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

describe('SearchResultsTree', () => {
  it('groups matches by file and shows match counts', () => {
    const results: IFileMatch[] = [
      makeMatch('/ws/a.ts', 1, 'foo bar'),
      makeMatch('/ws/package.json', 2, 'foo'),
    ]
    render(<SearchResultsTree results={results} onActivateMatch={() => {}} />)
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('package.json')).toBeTruthy()
    expect(
      screen.getByText('a.ts').parentElement?.querySelector('[data-file-icon="file-typescript"]'),
    ).toBeTruthy()
    expect(
      screen
        .getByText('package.json')
        .parentElement?.querySelector('[data-file-icon="file-package"]'),
    ).toBeTruthy()
  })

  it('clicking a match row invokes the activate callback', () => {
    const onActivate = vi.fn()
    const results: IFileMatch[] = [makeMatch('/ws/a.ts', 4, 'foo bar')]
    render(<SearchResultsTree results={results} onActivateMatch={onActivate} />)
    fireEvent.click(screen.getByText(/foo/))
    expect(onActivate).toHaveBeenCalledTimes(1)
    const [resource, match, idx] = onActivate.mock.calls[0]!
    expect(resource).toBeInstanceOf(URI)
    expect(match.lineNumber).toBe(4)
    expect(idx).toBe(0)
  })

  it('clicking the file toggle button collapses the group', () => {
    const results: IFileMatch[] = [makeMatch('/ws/a.ts', 1, 'foo')]
    render(<SearchResultsTree results={results} onActivateMatch={() => {}} />)
    expect(screen.queryByText('foo')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Toggle a.ts'))
    expect(screen.queryByText('foo')).toBeFalsy()
  })
})
