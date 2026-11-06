/*---------------------------------------------------------------------------------------------
 *  Tests for workbench/editor/breadcrumbs/FileBreadcrumbPicker.tsx
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  ContextKeyService,
  InstantiationService,
  IContextKeyService,
  IEditorResolverService,
  IFileService,
  IUriIdentityService,
  ServiceCollection,
  URI,
  type IEditorGroup,
  type IDirectoryEntry,
} from '@universe-editor/platform'
import { ServicesContext } from '../../../useService.js'
import { EditorGroupContext } from '../../EditorGroupContext.js'
import { FileBreadcrumbPicker } from '../FileBreadcrumbPicker.js'

const uriIdentity = {
  isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  relativePath: (from: URI, to: URI) => {
    const base = from.path.replace(/\/+$/, '')
    if (to.path === base) return ''
    if (!to.path.startsWith(`${base}/`)) return null
    return to.path.slice(base.length + 1)
  },
} as unknown as IUriIdentityService

function makeEntries(map: Record<string, IDirectoryEntry[]>): IFileService {
  return {
    list: vi.fn(async (directory: URI) => {
      const entries = map[directory.path]
      if (!entries) throw new Error(`missing ${directory.path}`)
      return entries
    }),
  } as unknown as IFileService
}

const anchor = { left: 10, top: 20, width: 80, height: 22 }

function renderPicker(options: {
  root: URI
  focus: URI | undefined
  entries: Record<string, IDirectoryEntry[]>
}) {
  const onClose = vi.fn()
  const openEditor = vi.fn()
  const group = { id: 1, openEditor } as unknown as IEditorGroup
  const resolver = {
    createEditorInput: (uri: URI) => ({ resource: uri, getName: () => uri.path }),
  } as unknown as IEditorResolverService
  const services = new ServiceCollection()
  services.set(IFileService, makeEntries(options.entries) as never)
  services.set(IUriIdentityService, uriIdentity as never)
  services.set(IEditorResolverService, resolver as never)
  services.set(IContextKeyService, new ContextKeyService() as never)
  const instantiation = new InstantiationService(services)

  render(
    <ServicesContext.Provider value={instantiation}>
      <EditorGroupContext.Provider value={group}>
        <FileBreadcrumbPicker
          anchor={anchor}
          root={options.root}
          focusResource={options.focus}
          onClose={onClose}
        />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>,
  )
  return { onClose, openEditor }
}

describe('FileBreadcrumbPicker', () => {
  it('lists the directory and selects the focused file', async () => {
    renderPicker({
      root: URI.file('/ws'),
      focus: URI.file('/ws/b.ts'),
      entries: {
        '/ws': [
          { name: 'a.ts', isDirectory: false, isFile: true },
          { name: 'b.ts', isDirectory: false, isFile: true },
        ],
      },
    })

    const rows = await screen.findAllByRole('treeitem')
    expect(rows.map((row) => row.textContent)).toEqual(['a.ts', 'b.ts'])
    expect(rows[1]!.getAttribute('data-selected')).toBe('true')
    expect(rows[0]!.getAttribute('data-selected')).toBe('false')
  })

  it('opens a file on single click and closes the picker', async () => {
    const { onClose, openEditor } = renderPicker({
      root: URI.file('/ws'),
      focus: undefined,
      entries: { '/ws': [{ name: 'a.ts', isDirectory: false, isFile: true }] },
    })

    fireEvent.click(await screen.findByText('a.ts'))

    expect(openEditor).toHaveBeenCalledWith(
      expect.objectContaining({ resource: URI.file('/ws/a.ts') }),
      { activate: true, pinned: true },
    )
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('opens the focused file with Enter', async () => {
    const { openEditor } = renderPicker({
      root: URI.file('/ws'),
      focus: URI.file('/ws/a.ts'),
      entries: {
        '/ws': [
          { name: 'a.ts', isDirectory: false, isFile: true },
          { name: 'b.ts', isDirectory: false, isFile: true },
        ],
      },
    })

    await screen.findByText('a.ts')
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter', code: 'Enter' })

    expect(openEditor).toHaveBeenCalledWith(
      expect.objectContaining({ resource: URI.file('/ws/a.ts') }),
      { activate: true, pinned: true },
    )
  })

  it('expands a folder on double click', async () => {
    renderPicker({
      root: URI.file('/ws'),
      focus: undefined,
      entries: {
        '/ws': [{ name: 'src', isDirectory: true, isFile: false }],
        '/ws/src': [{ name: 'a.ts', isDirectory: false, isFile: true }],
      },
    })

    const folder = await screen.findByText('src')
    fireEvent.click(folder)
    expect(screen.queryByText('a.ts')).toBeNull()

    fireEvent.doubleClick(screen.getByText('src'))
    expect(await screen.findByText('a.ts')).toBeTruthy()
  })

  it('expands a folder from the twistie without closing', async () => {
    const { onClose } = renderPicker({
      root: URI.file('/ws'),
      focus: undefined,
      entries: {
        '/ws': [{ name: 'src', isDirectory: true, isFile: false }],
        '/ws/src': [{ name: 'inner.ts', isDirectory: false, isFile: true }],
      },
    })

    const folder = await screen.findByText('src')
    const row = folder.closest('[role="treeitem"]') as HTMLElement
    const twistie = within(row).getByRole('button', { name: 'Expand folder' })
    // Keep DOM focus on the tree: a focusable twistie loses it to focusout.
    expect(fireEvent.mouseDown(twistie)).toBe(false)
    fireEvent.click(twistie)

    expect(await screen.findByText('inner.ts')).toBeTruthy()
    expect(
      screen.getByText('src').closest('[role="treeitem"]')?.getAttribute('aria-expanded'),
    ).toBe('true')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows an empty state', async () => {
    renderPicker({ root: URI.file('/ws'), focus: undefined, entries: { '/ws': [] } })
    expect(await screen.findByText('No files found.')).toBeTruthy()
  })

  it('shows an error state when the directory cannot be read', async () => {
    renderPicker({ root: URI.file('/ws'), focus: undefined, entries: {} })
    await waitFor(() => {
      expect(screen.getByText(/Unable to load this folder/)).toBeTruthy()
    })
  })
})
