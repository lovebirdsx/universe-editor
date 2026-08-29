/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/SearchResultsTree.tsx
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileMatch,
} from '@universe-editor/platform'
import { SearchResultsTree } from '../SearchResultsTree.js'
import { searchViewState } from '../searchViewState.js'
import { searchSession } from '../searchSession.js'
import { ServicesContext } from '../../useService.js'
import { stubConfigurationService } from './stubConfigurationService.js'

afterEach(() => {
  cleanup()
  searchViewState.setViewMode('list')
  searchSession.treeExpansionOverrides = new Map()
})

function makeMatch(path: string, line: number, preview: string): IFileMatch {
  return {
    resource: URI.file(path),
    matches: [{ lineNumber: line, preview, ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

function makeMatchWithRanges(path: string, preview: string, count: number): IFileMatch {
  return {
    resource: URI.file(path),
    matches: Array.from({ length: count }, (_, i) => ({
      lineNumber: i + 1,
      preview,
      // Full-line range so the whole preview is one highlighted span, keeping it
      // queryable by exact text (a partial range would split it across spans).
      ranges: [{ startColumn: 1, endColumn: preview.length + 1 }],
    })),
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
      screen.getByText('a.ts').parentElement?.querySelector('[data-file-icon="mi-typescript"]'),
    ).toBeTruthy()
    expect(
      screen.getByText('package.json').parentElement?.querySelector('[data-file-icon="mi-nodejs"]'),
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

  it('tree mode nests files under workspace-relative folders', () => {
    searchViewState.setViewMode('tree')
    const results: IFileMatch[] = [makeMatch('/ws/src/a.ts', 1, 'foo')]
    render(
      <SearchResultsTree results={results} rootUri={URI.file('/ws')} onActivateMatch={() => {}} />,
    )
    expect(screen.getByText('src')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()
  })

  it('list mode shows the workspace-relative dir after the file name', () => {
    const results: IFileMatch[] = [
      makeMatch('/ws/src/deep/a.ts', 1, 'foo'),
      makeMatch('/ws/b.ts', 1, 'foo'),
    ]
    render(
      <SearchResultsTree results={results} rootUri={URI.file('/ws')} onActivateMatch={() => {}} />,
    )
    expect(screen.getByText('a.ts').parentElement?.textContent).toContain('src/deep')
    // files at the workspace root show no path
    expect(screen.getByText('b.ts').parentElement?.textContent).not.toContain('ws')
  })

  it('tree mode hides the dir path on file rows', () => {
    searchViewState.setViewMode('tree')
    const results: IFileMatch[] = [makeMatch('/ws/src/deep/a.ts', 1, 'foo')]
    render(
      <SearchResultsTree results={results} rootUri={URI.file('/ws')} onActivateMatch={() => {}} />,
    )
    expect(screen.getByText('a.ts').parentElement?.textContent).not.toContain('src/deep')
  })

  it('collapse-all signal hides every match row', () => {
    const results: IFileMatch[] = [makeMatch('/ws/a.ts', 1, 'foo')]
    render(<SearchResultsTree results={results} onActivateMatch={() => {}} />)
    expect(screen.queryByText('foo')).toBeTruthy()
    act(() => {
      searchViewState.requestCollapseAll()
    })
    expect(screen.queryByText('foo')).toBeFalsy()
  })

  it('collapseResults auto collapses files above the match threshold', () => {
    const results: IFileMatch[] = [
      makeMatchWithRanges('/ws/big.ts', 'big hit', 11),
      makeMatchWithRanges('/ws/small.ts', 'small hit', 3),
    ]
    const services = new ServiceCollection()
    services.set(
      IConfigurationService,
      stubConfigurationService({ 'search.collapseResults': 'auto' }),
    )
    render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <SearchResultsTree results={results} onActivateMatch={() => {}} />
      </ServicesContext.Provider>,
    )
    // 11 matches > AUTO_COLLAPSE_THRESHOLD → collapsed, no preview row rendered.
    expect(screen.queryAllByText('big hit')).toHaveLength(0)
    // 3 matches → expanded, all three preview rows rendered.
    expect(screen.queryAllByText('small hit')).toHaveLength(3)
  })

  it('re-applies the policy when search.collapseResults changes', () => {
    const results: IFileMatch[] = [makeMatchWithRanges('/ws/big.ts', 'big hit', 11)]
    const config = stubConfigurationService({ 'search.collapseResults': 'alwaysExpand' })
    const services = new ServiceCollection()
    services.set(IConfigurationService, config)
    render(
      <ServicesContext.Provider value={new InstantiationService(services)}>
        <SearchResultsTree results={results} onActivateMatch={() => {}} />
      </ServicesContext.Provider>,
    )
    expect(screen.queryAllByText('big hit')).toHaveLength(11)

    // Switching to `auto` must fold the already-rendered file, not just apply
    // to nodes seen for the first time afterwards.
    act(() => {
      config.set('search.collapseResults', 'auto')
    })
    expect(screen.queryAllByText('big hit')).toHaveLength(0)

    act(() => {
      config.set('search.collapseResults', 'alwaysExpand')
    })
    expect(screen.queryAllByText('big hit')).toHaveLength(11)
  })
})
