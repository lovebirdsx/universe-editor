import {
  parentWorkspaceRelativePath,
  type MobileDirectoryListing,
} from '@universe-editor/mobile-protocol'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DirectoryPickerSheet } from '../DirectoryPickerSheet.js'
import { strings } from '../../strings.js'

function makeListing(
  relativePath: string,
  entries: readonly string[],
  extra: { readonly truncated?: boolean } = {},
): MobileDirectoryListing {
  return {
    relativePath,
    ...(relativePath !== ''
      ? { parentRelativePath: parentWorkspaceRelativePath(relativePath) ?? '' }
      : {}),
    entries: entries.map((name) => ({
      name,
      relativePath: relativePath === '' ? name : `${relativePath}/${name}`,
    })),
    ...extra,
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function directoryEntry(relativePath: string): HTMLElement {
  const entry = screen
    .getAllByTestId('new-session-directory-entry')
    .find((element) => element.getAttribute('data-relative-path') === relativePath)
  if (entry === undefined) throw new Error(`missing directory entry: ${relativePath}`)
  return entry
}

function projectRootOption(relativePath: string): HTMLElement {
  const option = screen
    .getAllByTestId('new-session-directory-project-root')
    .find((element) => element.getAttribute('data-relative-path') === relativePath)
  if (option === undefined) throw new Error(`missing project root: ${relativePath}`)
  return option
}

function renderSheet(
  listDirectory: (relativePath: string) => Promise<MobileDirectoryListing>,
  initialRelativePath = '',
  projectRoots: readonly string[] = [],
): { readonly onSelect: ReturnType<typeof vi.fn>; readonly onClose: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn()
  const onClose = vi.fn()
  render(
    <DirectoryPickerSheet
      initialRelativePath={initialRelativePath}
      disabled={false}
      projectRoots={projectRoots}
      listDirectory={listDirectory}
      onSelect={onSelect}
      onClose={onClose}
    />,
  )
  return { onSelect, onClose }
}

describe('DirectoryPickerSheet', () => {
  it('loads the initial directory, enters a child, and selects the current path', async () => {
    const listDirectory = vi.fn(async (path: string) => {
      if (path === '') return makeListing('', ['packages', 'src'])
      if (path === 'packages') return makeListing('packages', ['demo'])
      return makeListing(path, [])
    })
    const { onSelect, onClose } = renderSheet(listDirectory)

    await waitFor(() => expect(directoryEntry('packages')).toBeTruthy())
    expect(listDirectory).toHaveBeenCalledWith('')
    expect(screen.getByTestId('new-session-directory-path').textContent).toContain(
      strings.newSessionDirectoryRoot,
    )

    fireEvent.click(directoryEntry('packages'))
    await waitFor(() => expect(directoryEntry('packages/demo')).toBeTruthy())
    expect(listDirectory).toHaveBeenLastCalledWith('packages')
    expect(screen.getByTestId('new-session-directory-path').textContent).toContain('packages')

    fireEvent.click(screen.getByTestId('new-session-directory-select'))
    expect(onSelect).toHaveBeenCalledWith('packages')
    expect(onClose).toHaveBeenCalled()
  })

  it('walks up to the workspace root', async () => {
    const listDirectory = vi.fn(async (path: string) => {
      if (path === '') return makeListing('', ['a'])
      if (path === 'a') return makeListing('a', ['b'])
      if (path === 'a/b') return makeListing('a/b', [])
      return makeListing(path, [])
    })
    renderSheet(listDirectory, 'a/b')

    await waitFor(() => expect(listDirectory).toHaveBeenCalledWith('a/b'))
    expect((screen.getByTestId('new-session-directory-up') as HTMLButtonElement).disabled).toBe(
      false,
    )

    fireEvent.click(screen.getByTestId('new-session-directory-up'))
    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith('a'))
    fireEvent.click(screen.getByTestId('new-session-directory-up'))
    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith(''))
    expect((screen.getByTestId('new-session-directory-up') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('shows empty and truncated states', async () => {
    renderSheet(async (path) => makeListing(path, [], { truncated: true }))

    await waitFor(() =>
      expect(screen.getByTestId('new-session-directory-empty').textContent).toContain(
        strings.directoryPickerEmpty,
      ),
    )
    expect(screen.getByTestId('new-session-directory-truncated').textContent).toContain(
      strings.directoryPickerTruncated,
    )
    expect((screen.getByTestId('new-session-directory-select') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('reports a bad request and retries', async () => {
    let fail = true
    const listDirectory = vi.fn(async (path: string) => {
      if (fail) throw Object.assign(new Error('missing'), { code: 'bad_request' })
      return makeListing(path, [])
    })
    renderSheet(listDirectory)

    await waitFor(() =>
      expect(screen.getByTestId('new-session-directory-error').textContent).toContain(
        strings.directoryPickerInvalid,
      ),
    )
    expect((screen.getByTestId('new-session-directory-select') as HTMLButtonElement).disabled).toBe(
      true,
    )

    fail = false
    fireEvent.click(screen.getByTestId('new-session-directory-retry'))
    await waitFor(() => expect(screen.getByTestId('new-session-directory-empty')).toBeTruthy())
    expect((screen.getByTestId('new-session-directory-select') as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('discards a stale response after navigating away', async () => {
    const slow = deferred<MobileDirectoryListing>()
    const listDirectory = vi.fn((path: string) =>
      path === 'stale' ? slow.promise : Promise.resolve(makeListing('', ['stale'])),
    )
    renderSheet(listDirectory)

    await waitFor(() => expect(directoryEntry('stale')).toBeTruthy())
    fireEvent.click(directoryEntry('stale'))
    fireEvent.click(screen.getByTestId('new-session-directory-up'))
    await waitFor(() => expect(directoryEntry('stale')).toBeTruthy())

    await act(async () => {
      slow.resolve(makeListing('stale', ['stale-child']))
    })

    expect(screen.queryByText('stale-child')).toBeNull()
    expect(screen.getByTestId('new-session-directory-path').textContent).toContain(
      strings.newSessionDirectoryRoot,
    )
  })
})

describe('DirectoryPickerSheet project roots', () => {
  it('jumps to a project root without selecting or closing the sheet', async () => {
    const listDirectory = vi.fn(async (path: string) => makeListing(path, []))
    const { onSelect, onClose } = renderSheet(listDirectory, '', ['packages/demo'])

    await waitFor(() =>
      expect(screen.getByTestId('new-session-directory-project-roots')).toBeTruthy(),
    )
    expect(screen.getByText(strings.directoryPickerProjectRoots)).toBeTruthy()

    fireEvent.click(projectRootOption('packages/demo'))

    await waitFor(() => expect(listDirectory).toHaveBeenLastCalledWith('packages/demo'))
    expect(screen.getByTestId('new-session-directory-path').textContent).toContain('packages/demo')
    expect(projectRootOption('packages/demo').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('new-session-directory-sheet')).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('reloads when the current root is tapped again', async () => {
    const listDirectory = vi.fn(async (path: string) => makeListing(path, []))
    renderSheet(listDirectory, 'packages/demo', ['packages/demo'])

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(1))
    fireEvent.click(projectRootOption('packages/demo'))

    await waitFor(() => expect(listDirectory).toHaveBeenCalledTimes(2))
    expect(listDirectory).toHaveBeenLastCalledWith('packages/demo')
  })

  it('keeps shortcuts visible when the directory fails to load', async () => {
    const listDirectory = vi.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 'bad_request' })
    })
    renderSheet(listDirectory, 'packages/demo', ['packages/demo'])

    await waitFor(() => expect(screen.getByTestId('new-session-directory-error')).toBeTruthy())
    expect(screen.getByTestId('new-session-directory-project-roots')).toBeTruthy()
  })

  it('omits the section when no roots are configured', async () => {
    renderSheet(async (path) => makeListing(path, []), '', [])

    await waitFor(() => expect(screen.getByTestId('new-session-directory-empty')).toBeTruthy())
    expect(screen.queryByTestId('new-session-directory-project-roots')).toBeNull()
  })
})
