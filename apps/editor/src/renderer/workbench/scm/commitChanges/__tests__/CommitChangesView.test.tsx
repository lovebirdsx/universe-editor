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
  InstantiationService,
  ServiceCollection,
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

  it('renders the header metadata (author / date / parents / message)', () => {
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
    expect(screen.getByTestId('commitChanges-parents').textContent).toBe(
      'Parents: 1234567, fedcba0',
    )
    expect(screen.getByTestId('commitChanges-message').textContent).toBe(
      'fix crash\n\nlong body here',
    )
  })

  it('renders only the title when metadata is absent', () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload())
    })

    expect(screen.getByTestId('commitChanges-title').textContent).toBe('a1b2c3d — fix crash')
    expect(screen.queryByTestId('commitChanges-meta')).toBeNull()
    expect(screen.queryByTestId('commitChanges-parents')).toBeNull()
    expect(screen.queryByTestId('commitChanges-message')).toBeNull()
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

  it('reveals the revealPath file row (selected) without focusing the tree', async () => {
    renderView()
    act(() => {
      commitChangesViewState.show(payload({ revealPath: 'src/deep/b.ts' }))
    })

    // treeModel.reveal() resolves on a microtask; wait for the selection flush.
    await vi.waitFor(() => {
      const row = document.querySelector('[data-row-key="file:src/deep/b.ts"]')
      expect(row?.getAttribute('aria-selected')).toBe('true')
    })
    const tree = document.querySelector('[role="tree"]')
    expect(tree?.contains(document.activeElement)).toBe(false)
  })
})
