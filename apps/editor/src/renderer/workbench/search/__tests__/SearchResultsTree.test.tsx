/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/SearchResultsTree.tsx
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileMatch,
  type ITextSearchMatch,
} from '@universe-editor/platform'
import { SearchResultsTree, type SearchResultsTreeHandle } from '../SearchResultsTree.js'
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

/** One file with several matches — the shape the search engine actually emits. */
function makeFile(path: string, previews: readonly string[]): IFileMatch {
  return {
    resource: URI.file(path),
    matches: previews.map((preview, i) => ({
      lineNumber: i + 1,
      preview,
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
    const [resource, match, idx, options] = onActivate.mock.calls[0]!
    expect(resource).toBeInstanceOf(URI)
    expect(match.lineNumber).toBe(4)
    expect(idx).toBe(0)
    // A mouse click opens the match and focuses the editor (Space is the only
    // gesture that keeps focus in the tree).
    expect(options).toEqual({ preview: true, target: 'default', preserveFocus: false })
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

  it('opens the row menu with the ContextMenu key, already highlighted and drivable', async () => {
    const results: IFileMatch[] = [makeMatch('/ws/a.ts', 1, 'foo')]
    render(<SearchResultsTree results={results} onActivateMatch={() => {}} />)

    const tree = screen.getByRole('tree', { name: 'Search results' })
    // Clicking seeds the tree cursor — the ContextMenu key anchors on it.
    fireEvent.click(screen.getByText('a.ts'))
    fireEvent.keyDown(tree, { key: 'ContextMenu' })

    const menu = await screen.findByRole('menu')
    // A keyboard user has no pointer to aim, so the first entry opens highlighted.
    const active = () => menu.ownerDocument.querySelectorAll('[role="menuitem"][data-active]')
    expect(active()).toHaveLength(1)
    expect(active()[0]?.textContent).toBe('Copy Path')
    expect(menu.getAttribute('aria-activedescendant')).toBeTruthy()

    // The arrow keys drive the menu and must not tear it down.
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowDown' })
    })
    expect(screen.getByRole('menu')).toBeTruthy()
    expect(active()[0]?.textContent).toBe('Copy All')
  })

  it('leaves a mouse-opened menu unhighlighted', async () => {
    const results: IFileMatch[] = [makeMatch('/ws/a.ts', 1, 'foo')]
    render(<SearchResultsTree results={results} onActivateMatch={() => {}} />)

    fireEvent.contextMenu(screen.getByText('a.ts'), { clientX: 10, clientY: 20 })

    await screen.findByRole('menu')
    expect(document.querySelector('[role="menuitem"][data-active]')).toBeNull()
  })
})

/** Owns the result list and applies dismissals like SearchView/useSearchActions. */
function StatefulSearchTree({ initial }: { initial: readonly IFileMatch[] }) {
  const [results, setResults] = useState<readonly IFileMatch[]>(initial)
  return (
    <SearchResultsTree
      results={results}
      onActivateMatch={() => {}}
      onDismissMatch={(resource, match, rangeIndex) => {
        setResults((prev) =>
          prev
            .map((fm) => {
              if (fm.resource.toString() !== resource.toString()) return fm
              const matches = fm.matches
                .map((m) => {
                  if (m !== match) return m
                  const ranges = m.ranges.filter((_, i) => i !== rangeIndex)
                  return ranges.length === 0 ? null : { ...m, ranges }
                })
                .filter((m): m is ITextSearchMatch => m !== null)
              return matches.length === 0 ? null : { ...fm, matches }
            })
            .filter((fm): fm is IFileMatch => fm !== null),
        )
      }}
      onDismissFile={(resource) =>
        setResults((prev) => prev.filter((fm) => fm.resource.toString() !== resource.toString()))
      }
    />
  )
}

const selectedRowKey = (): string | null | undefined =>
  document.querySelector('[role="treeitem"][aria-selected="true"]')?.getAttribute('data-row-key')

describe('SearchResultsTree — modifier activation', () => {
  const tree = () => screen.getByRole('tree', { name: 'Search results' })

  it('passes the side target for a match row', () => {
    const onActivate = vi.fn()
    render(
      <SearchResultsTree results={[makeFile('/ws/a.ts', ['one'])]} onActivateMatch={onActivate} />,
    )
    fireEvent.click(screen.getByText('one'))
    onActivate.mockClear()

    fireEvent.keyDown(tree(), { key: 'Enter', ctrlKey: true })

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0]?.[3]?.target).toBe('side')
  })

  it('opens a file row at its first match with the new-window target', () => {
    const onActivate = vi.fn()
    render(
      <SearchResultsTree
        results={[makeFile('/ws/a.ts', ['one', 'two'])]}
        onActivateMatch={onActivate}
      />,
    )
    fireEvent.click(screen.getByText('a.ts'))
    onActivate.mockClear()

    fireEvent.keyDown(tree(), { key: 'Enter', altKey: true })

    expect(onActivate).toHaveBeenCalledTimes(1)
    const [, match, rangeIndex, options] = onActivate.mock.calls[0]!
    expect(match.lineNumber).toBe(1)
    expect(rangeIndex).toBe(0)
    expect(options?.preview).toBe(false)
    expect(options?.target).toBe('newWindow')
    expect(options?.preserveFocus).toBe(false)
  })

  it('keeps plain Enter on a file row as expand/collapse', () => {
    const onActivate = vi.fn()
    render(
      <SearchResultsTree results={[makeFile('/ws/a.ts', ['one'])]} onActivateMatch={onActivate} />,
    )
    fireEvent.click(screen.getByText('a.ts'))
    onActivate.mockClear()
    expect(screen.queryByText('one')).toBeNull()

    fireEvent.keyDown(tree(), { key: 'Enter' })

    expect(screen.queryByText('one')).not.toBeNull()
    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('SearchResultsTree — keyboard preview', () => {
  const tree = () => screen.getByRole('tree', { name: 'Search results' })

  it('Space previews the focused match and keeps focus in the tree', () => {
    const onActivate = vi.fn()
    render(
      <SearchResultsTree results={[makeFile('/ws/a.ts', ['one'])]} onActivateMatch={onActivate} />,
    )
    fireEvent.click(screen.getByText('one'))
    onActivate.mockClear()

    fireEvent.keyDown(tree(), { key: ' ' })

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0]?.[3]).toEqual({
      preview: true,
      target: 'default',
      preserveFocus: true,
    })
  })

  it('Enter pins the match and hands focus to the editor', () => {
    const onActivate = vi.fn()
    render(
      <SearchResultsTree results={[makeFile('/ws/a.ts', ['one'])]} onActivateMatch={onActivate} />,
    )
    fireEvent.click(screen.getByText('one'))
    onActivate.mockClear()

    fireEvent.keyDown(tree(), { key: 'Enter' })

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate.mock.calls[0]?.[3]).toEqual({
      preview: false,
      target: 'default',
      preserveFocus: false,
    })
  })

  it('Space on a file row toggles the group instead of previewing', () => {
    const onActivate = vi.fn()
    render(
      <SearchResultsTree results={[makeFile('/ws/a.ts', ['one'])]} onActivateMatch={onActivate} />,
    )
    fireEvent.click(screen.getByText('a.ts'))
    expect(screen.queryByText('one')).toBeNull()
    onActivate.mockClear()

    fireEvent.keyDown(tree(), { key: ' ' })

    expect(screen.queryByText('one')).not.toBeNull()
    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('SearchResultsTree — focus recovery after Remove', () => {
  it('deletes a middle match and lands on the next match', () => {
    render(
      <StatefulSearchTree
        initial={[makeFile('/ws/a.ts', ['one', 'two', 'three']), makeFile('/ws/b.ts', ['four'])]}
      />,
    )
    fireEvent.click(screen.getByText('two'))
    fireEvent.keyDown(screen.getByRole('tree', { name: 'Search results' }), { key: 'Delete' })

    expect(screen.queryByText('two')).toBeNull()
    expect(selectedRowKey()).toBe('match:file:///ws/a.ts:1')
  })

  it('deletes the last match of a file and lands on the next row', () => {
    render(
      <StatefulSearchTree
        initial={[makeFile('/ws/a.ts', ['one', 'two']), makeFile('/ws/b.ts', ['four'])]}
      />,
    )
    fireEvent.click(screen.getByText('two'))
    fireEvent.keyDown(screen.getByRole('tree', { name: 'Search results' }), { key: 'Delete' })

    expect(screen.queryByText('two')).toBeNull()
    // The file row still exists, so the next row is b.ts (its earlier slot).
    expect(selectedRowKey()).toBe('file:file:///ws/b.ts')
  })

  it('deletes the last match of the last file and lands on the previous match', () => {
    render(
      <StatefulSearchTree
        initial={[makeFile('/ws/a.ts', ['one']), makeFile('/ws/b.ts', ['two'])]}
      />,
    )
    fireEvent.click(screen.getByText('two'))
    fireEvent.keyDown(screen.getByRole('tree', { name: 'Search results' }), { key: 'Delete' })

    expect(screen.queryByText('two')).toBeNull()
    // b.ts vanishes with its last match, so the seat moves up one more row.
    expect(selectedRowKey()).toBe('match:file:///ws/a.ts:0')
  })

  it('deletes a focused file row and lands on the next file', () => {
    render(
      <StatefulSearchTree
        initial={[makeFile('/ws/a.ts', ['one', 'two']), makeFile('/ws/b.ts', ['four'])]}
      />,
    )
    fireEvent.click(screen.getByText('a.ts'))
    fireEvent.keyDown(screen.getByRole('tree', { name: 'Search results' }), { key: 'Delete' })

    expect(screen.queryByText('a.ts')).toBeNull()
    expect(selectedRowKey()).toBe('file:file:///ws/b.ts')
  })

  it('deletes a non-focused match above the cursor and keeps the same match focused', async () => {
    render(<StatefulSearchTree initial={[makeFile('/ws/a.ts', ['one', 'two', 'three'])]} />)
    fireEvent.click(screen.getByText('three'))
    expect(selectedRowKey()).toBe('match:file:///ws/a.ts:2')

    // The row menu acts on the clicked row, not on the cursor. Removing match
    // 0 renumbers every id after it, so the cursor's old id would go stale.
    fireEvent.contextMenu(screen.getByText('one'), { clientX: 10, clientY: 20 })
    await screen.findByRole('menu')
    fireEvent.click(screen.getByText('Remove'))

    expect(screen.queryByText('one')).toBeNull()
    expect(selectedRowKey()).toBe('match:file:///ws/a.ts:1')
  })

  it('new results that were not dismissed do not auto-select a row', () => {
    const onActivateMatch = () => {}
    const { rerender } = render(
      <SearchResultsTree
        results={[makeFile('/ws/a.ts', ['one', 'two'])]}
        onActivateMatch={onActivateMatch}
      />,
    )
    fireEvent.click(screen.getByText('two'))
    expect(selectedRowKey()).toBe('match:file:///ws/a.ts:1')

    rerender(
      <SearchResultsTree
        results={[makeFile('/ws/a.ts', ['one'])]}
        onActivateMatch={onActivateMatch}
      />,
    )

    expect(screen.queryByText('two')).toBeNull()
    expect(selectedRowKey()).toBeUndefined()
  })
})

describe('SearchResultsTree — focusResource', () => {
  it('focuses the preferred match and returns the tree container', () => {
    const resource = URI.file('/ws/a.ts')
    const matchId = `match:${resource.toString()}:1`
    const ref = createRef<SearchResultsTreeHandle>()
    render(
      <SearchResultsTree
        ref={ref}
        results={[makeFile('/ws/a.ts', ['one', 'two'])]}
        onActivateMatch={() => {}}
      />,
    )
    const tree = screen.getByRole('tree', { name: 'Search results' })

    let focused: HTMLElement | null = null
    act(() => {
      focused = ref.current!.focusResource(resource, matchId)
    })

    // Returning the container is the contract FocusableRegistry relies on: a
    // null here makes it fall back to the ViewBody wrapper and steal focus.
    expect(focused).toBe(tree)
    expect(document.activeElement).toBe(tree)
    expect(selectedRowKey()).toBe(matchId)
  })

  it('falls back to the file row when the preferred match is in another file', () => {
    const resource = URI.file('/ws/a.ts')
    const other = URI.file('/ws/b.ts')
    const ref = createRef<SearchResultsTreeHandle>()
    render(
      <SearchResultsTree
        ref={ref}
        results={[makeFile('/ws/a.ts', ['one']), makeFile('/ws/b.ts', ['two'])]}
        onActivateMatch={() => {}}
      />,
    )

    let focused: HTMLElement | null = null
    act(() => {
      focused = ref.current!.focusResource(resource, `match:${other.toString()}:0`)
    })

    expect(focused).toBe(screen.getByRole('tree', { name: 'Search results' }))
    expect(selectedRowKey()).toBe(`file:${resource.toString()}`)
  })

  it('returns null and leaves focus alone when the file is not in the results', () => {
    const ref = createRef<SearchResultsTreeHandle>()
    render(
      <SearchResultsTree
        ref={ref}
        results={[makeFile('/ws/a.ts', ['one'])]}
        onActivateMatch={() => {}}
      />,
    )

    let focused: HTMLElement | null = null
    act(() => {
      focused = ref.current!.focusResource(URI.file('/ws/missing.ts'), null)
    })

    expect(focused).toBeNull()
    expect(screen.queryByRole('treeitem', { selected: true })).toBeNull()
  })
})
