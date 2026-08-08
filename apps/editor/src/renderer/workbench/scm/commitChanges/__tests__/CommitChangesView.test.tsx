/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// happy-dom has no layout engine so @tanstack/react-virtual renders 0 visible
// items. Mock it so every row mounts and can be clicked / asserted.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: i,
        start: i * opts.estimateSize(i),
        size: opts.estimateSize(i),
        lane: 0,
        end: (i + 1) * opts.estimateSize(i),
      })),
    getTotalSize: () =>
      Array.from({ length: opts.count }, (_, i) => opts.estimateSize(i)).reduce(
        (total, height) => total + height,
        0,
      ),
    scrollToIndex: () => undefined,
    measureElement: () => undefined,
  }),
}))

import {
  ICommandService,
  IEditorResolverService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  StorageScope,
} from '@universe-editor/platform'
import type {
  CommitChangesFileEntry,
  ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../../useService.js'
import { CommitChangesView } from '../CommitChangesView.js'
import { commitChangesViewState } from '../viewState.js'

const executeCommand = vi.fn(async (..._args: unknown[]) => undefined)
const resolverOpenEditor = vi.fn(async (_uri: unknown, _opts?: unknown) => undefined)
const storageGet = vi.fn(async (_key: string, _scope: unknown) => undefined)
const storageSet = vi.fn(async (_key: string, _value: unknown, _scope: unknown) => undefined)

function createInstantiationService(): InstantiationService {
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand,
  } as never)
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    openEditor: resolverOpenEditor,
  } as never)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: storageGet,
    set: storageSet,
  } as never)
  return new InstantiationService(services)
}

function entry(path: string, overrides?: Partial<CommitChangesFileEntry>): CommitChangesFileEntry {
  return { path, oldPath: null, status: 'M', resourceUri: null, args: { path }, ...overrides }
}

function payload(overrides?: Partial<ShowCommitChangesPayload>): ShowCommitChangesPayload {
  return {
    providerId: 'git',
    title: 'a1b2c3d — fix crash',
    commitRef: 'a1b2c3d',
    openExternalCommand: 'git-graph.openFileDiff',
    files: [entry('src/a.ts'), entry('src/deep/b.ts')],
    ...overrides,
  }
}

function renderView() {
  return render(
    <ServicesContext.Provider value={createInstantiationService()}>
      <CommitChangesView />
    </ServicesContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  commitChangesViewState._resetForTests()
})

afterEach(() => {
  cleanup()
  commitChangesViewState._resetForTests()
})

describe('CommitChangesView', () => {
  it('renders the empty state when no payload has been shown', () => {
    renderView()

    expect(screen.getByTestId('commitChanges-view')).toBeTruthy()
    expect(screen.getByText(/Select a commit from Blame/)).toBeTruthy()
    expect(screen.queryByRole('tree')).toBeNull()
  })

  it('renders only the title and meta lines even when metadata carries parents / message', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(
        payload({
          metadata: {
            author: 'Jane Doe',
            authorDate: 1700000000,
            message: 'fix crash\n\nlong body here',
            parents: ['1234567890abcdef', 'fedcba0987654321'],
          },
        }),
      )
    })

    expect(screen.getByTestId('commitChanges-title').textContent).toBe('a1b2c3d — fix crash')
    const meta = screen.getByTestId('commitChanges-meta').textContent ?? ''
    expect(meta).toContain('Jane Doe')
    expect(meta).toContain(' · ')
    expect(screen.queryByTestId('commitChanges-parents')).toBeNull()
    expect(screen.queryByTestId('commitChanges-message')).toBeNull()
  })

  it('renders only the title when metadata is absent', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    expect(screen.getByTestId('commitChanges-title').textContent).toBe('a1b2c3d — fix crash')
    expect(screen.queryByTestId('commitChanges-meta')).toBeNull()
  })

  it('clicking a file row executes openExternalCommand with the entry args', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    const row = document.querySelector('[data-row-key="file:src/a.ts"]')
    expect(row).toBeTruthy()
    fireEvent.click(row!)

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('git-graph.openFileDiff', { path: 'src/a.ts' })
  })

  it('clicking a folder row collapses and re-expands its children', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    expect(document.querySelector('[data-row-key="file:src/a.ts"]')).toBeTruthy()

    const folder = document.querySelector('[data-row-key="folder:src"]')!
    fireEvent.click(folder)
    expect(document.querySelector('[data-row-key="file:src/a.ts"]')).toBeNull()

    fireEvent.click(folder)
    expect(document.querySelector('[data-row-key="file:src/a.ts"]')).toBeTruthy()
  })

  it('shows the Open File inline action only for entries with a resourceUri', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(
        payload({
          files: [
            entry('src/a.ts', { resourceUri: 'file:///ws/src/a.ts' }),
            entry('src/deleted.ts', { status: 'D' }),
          ],
        }),
      )
    })

    const withFile = document.querySelector('[data-row-key="file:src/a.ts"]')!
    expect(withFile.querySelector('[aria-label="Open File"]')).toBeTruthy()
    const deleted = document.querySelector('[data-row-key="file:src/deleted.ts"]')!
    expect(deleted.querySelector('[aria-label="Open File"]')).toBeNull()

    fireEvent.click(withFile.querySelector('[aria-label="Open File"]')!)
    expect(resolverOpenEditor).toHaveBeenCalledTimes(1)
    expect(String(resolverOpenEditor.mock.calls[0]![0])).toBe('file:///ws/src/a.ts')
    // The inline action must not bubble into the row's diff-open click.
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it('reveals the revealPath file row and focuses the tree on it', async () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload({ revealPath: 'src/deep/b.ts' }))
    })

    // treeModel.reveal() resolves on a microtask; wait for the selection flush.
    await vi.waitFor(() => {
      const row = document.querySelector('[data-row-key="file:src/deep/b.ts"]')
      expect(row?.getAttribute('aria-selected')).toBe('true')
    })
    // Opened from blame/timeline: the tree takes DOM focus on the revealed row.
    const tree = document.querySelector('[role="tree"]')
    expect(tree?.contains(document.activeElement)).toBe(true)
  })

  it('focusing the tree lands on the first file row (folders skipped)', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    const tree = document.querySelector('[role="tree"]') as HTMLElement
    fireEvent.focusIn(tree)

    // Folders sort before files, so the first file row is the one nested
    // inside the deepest-leading folder, not the alphabetically-first path.
    const row = document.querySelector('[data-row-key="file:src/deep/b.ts"]')
    expect(row?.getAttribute('aria-selected')).toBe('true')
    expect(
      document.querySelector('[data-row-key="folder:src"]')?.getAttribute('aria-selected'),
    ).toBe('false')
  })

  it('focusing the tree in list mode lands on the first row', () => {
    renderView()
    act(() => {
      commitChangesViewState.setViewMode('list')
      commitChangesViewState.show(payload())
    })

    const tree = document.querySelector('[role="tree"]') as HTMLElement
    fireEvent.focusIn(tree)

    const row = document.querySelector('[data-row-key="file:src/a.ts"]')
    expect(row?.getAttribute('aria-selected')).toBe('true')
  })

  it('restores the remembered file when the view remounts and regains focus', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    fireEvent.click(document.querySelector('[data-row-key="file:src/deep/b.ts"]')!)

    // Re-showing the same commit remounts the content (fresh TreeModel).
    act(() => {
      commitChangesViewState.show(payload())
    })
    const tree = document.querySelector('[role="tree"]') as HTMLElement
    fireEvent.focusIn(tree)

    const row = document.querySelector('[data-row-key="file:src/deep/b.ts"]')
    expect(row?.getAttribute('aria-selected')).toBe('true')
  })

  it('Space on a file row previews the diff preserving tree focus', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    const tree = document.querySelector('[role="tree"]') as HTMLElement
    fireEvent.click(document.querySelector('[data-row-key="file:src/a.ts"]')!)
    executeCommand.mockClear()
    fireEvent.keyDown(tree, { key: ' ' })

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith(
      'git-graph.openFileDiff',
      { path: 'src/a.ts' },
      { preserveFocus: true },
    )
  })

  it('Enter on a file row opens the diff and hands focus to the editor', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    const tree = document.querySelector('[role="tree"]') as HTMLElement
    fireEvent.click(document.querySelector('[data-row-key="file:src/a.ts"]')!)
    executeCommand.mockClear()
    fireEvent.keyDown(tree, { key: 'Enter' })

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('git-graph.openFileDiff', { path: 'src/a.ts' })
  })

  it('Enter on a folder row toggles it instead of opening a diff', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    const tree = document.querySelector('[role="tree"]') as HTMLElement
    fireEvent.click(document.querySelector('[data-row-key="folder:src"]')!)
    // Folder click collapsed it; Enter re-expands without running the command.
    fireEvent.keyDown(tree, { key: 'Enter' })

    expect(executeCommand).not.toHaveBeenCalled()
    expect(document.querySelector('[data-row-key="file:src/a.ts"]')).toBeTruthy()
  })

  it('tree mode shows no directory suffix on file rows', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    const row = document.querySelector('[data-row-key="file:src/a.ts"]')
    expect(row).toBeTruthy()
    expect(row?.textContent).not.toContain('src')
  })

  it('list mode flattens the tree and shows the grey directory suffix', () => {
    renderView()
    act(() => {
      commitChangesViewState.setViewMode('list')
      commitChangesViewState.show(payload())
    })

    expect(document.querySelector('[data-row-key="folder:src"]')).toBeNull()
    const row = document.querySelector('[data-row-key="file:src/a.ts"]')
    expect(row).toBeTruthy()
    expect(row?.textContent).toContain('a.ts')
    expect(row?.textContent).toContain('src')

    fireEvent.click(row!)
    expect(executeCommand).toHaveBeenCalledWith('git-graph.openFileDiff', { path: 'src/a.ts' })
  })

  it('reveals the revealPath file row in list mode too', async () => {
    renderView()
    act(() => {
      commitChangesViewState.setViewMode('list')
      commitChangesViewState.show(payload({ revealPath: 'src/deep/b.ts' }))
    })

    await vi.waitFor(() => {
      const row = document.querySelector('[data-row-key="file:src/deep/b.ts"]')
      expect(row?.getAttribute('aria-selected')).toBe('true')
    })
  })

  it('collapse-all / expand-all signals from the toolbar fold and restore the tree', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })
    expect(document.querySelector('[data-row-key="file:src/a.ts"]')).toBeTruthy()

    act(() => {
      commitChangesViewState.requestCollapseAll()
    })
    expect(document.querySelector('[data-row-key="file:src/a.ts"]')).toBeNull()
    expect(document.querySelector('[data-row-key="folder:src"]')).toBeTruthy()

    act(() => {
      commitChangesViewState.requestExpandAll()
    })
    expect(document.querySelector('[data-row-key="file:src/a.ts"]')).toBeTruthy()
  })

  it('persists the view mode to GLOBAL storage once the stored value is restored', async () => {
    renderView()
    // Flush the restore read so restoredRef flips before the next mode change.
    await act(async () => {
      await storageGet.mock.results[0]?.value
    })

    act(() => {
      commitChangesViewState.setViewMode('list')
    })

    await vi.waitFor(() => {
      expect(storageSet).toHaveBeenCalledWith(
        'scm.commitChanges.viewMode',
        'list',
        StorageScope.GLOBAL,
      )
    })
  })
})
