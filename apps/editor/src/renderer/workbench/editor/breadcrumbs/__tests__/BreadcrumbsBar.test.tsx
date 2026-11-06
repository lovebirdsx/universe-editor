/*---------------------------------------------------------------------------------------------
 *  Tests for workbench/editor/breadcrumbs/BreadcrumbsBar.tsx (config + focus model)
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  IFileService,
  InstantiationService,
  IUriIdentityService,
  IWorkspaceService,
  observableValue,
  ServiceCollection,
  URI,
  type EditorInput,
  type IConfigurationChangeEvent,
  type IDirectoryEntry,
} from '@universe-editor/platform'
import type { monaco } from '../../monaco/MonacoLoader.js'
import { ServicesContext } from '../../../useService.js'
import {
  IOutlineService,
  type IOutlineScope,
  type OutlineModel,
  type OutlineSourceKind,
} from '../../../../services/languageFeatures/OutlineService.js'
import { EditorGroupContext } from '../../EditorGroupContext.js'
import { Breadcrumbs } from '../../Breadcrumbs.js'
import { DEFAULT_BREADCRUMBS_CONFIG } from '../../../../services/breadcrumbs/breadcrumbsConfig.js'

const uriIdentity = {
  isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  relativePath: (from: URI, to: URI) => {
    const base = from.path.replace(/\/+$/, '')
    if (to.path === base) return ''
    if (!to.path.startsWith(`${base}/`)) return null
    return to.path.slice(base.length + 1)
  },
} as unknown as IUriIdentityService

const workspaceService = {
  _serviceBrand: undefined,
  current: { folder: URI.file('/ws') },
  onDidChangeWorkspace: () => ({ dispose: () => {} }),
} as unknown as IWorkspaceService

function makeConfig(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial))
  const emitter = new Emitter<IConfigurationChangeEvent>()
  const service = {
    _serviceBrand: undefined,
    get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
    onDidChangeConfiguration: emitter.event,
  } as unknown as IConfigurationService
  return {
    service,
    update(key: string, value: unknown) {
      values.set(key, value)
      emitter.fire({ keys: [key], affectsConfiguration: (k) => k === key })
    },
  }
}

function makeSymbol(name: string): monaco.languages.DocumentSymbol {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  return {
    name,
    detail: '',
    kind: 14 as monaco.languages.SymbolKind,
    tags: [],
    range,
    selectionRange: range,
    children: [],
  }
}

function makeScope(symbolName: string): IOutlineScope {
  const symbol = makeSymbol(symbolName)
  return {
    outline: observableValue<OutlineModel | undefined>('test.outline', {
      uri: 'file:///ws/src/a.ts',
      roots: [symbol],
      languageId: 'typescript',
      version: 1,
    }),
    activeSymbol: observableValue('test.activeSymbol', symbol),
    sourceKind: observableValue<OutlineSourceKind | undefined>('test.sourceKind', 'file'),
    revealSymbol: vi.fn(),
    captureViewState: () => undefined,
    previewSymbol: vi.fn(),
    restoreViewState: vi.fn(),
  }
}

const input = {
  getName: () => 'a.ts',
  resource: URI.file('/ws/src/a.ts'),
} as unknown as EditorInput

function makeFiles(map: Record<string, IDirectoryEntry[]>): IFileService {
  return {
    list: vi.fn(async (directory: URI) => {
      const entries = map[directory.path]
      if (!entries) throw new Error(`missing ${directory.path}`)
      return entries
    }),
  } as unknown as IFileService
}

function renderBar(
  initialConfig: Record<string, unknown> = {},
  symbolName = 'AlphaSymbol',
  files?: Record<string, IDirectoryEntry[]>,
) {
  const config = makeConfig(initialConfig)
  const scope = makeScope(symbolName)
  const services = new ServiceCollection()
  services.set(IOutlineService, {
    _serviceBrand: undefined,
    forGroup: () => scope,
  } as never)
  services.set(IUriIdentityService, uriIdentity as never)
  services.set(IWorkspaceService, workspaceService as never)
  services.set(IConfigurationService, config.service as never)
  if (files) services.set(IFileService, makeFiles(files) as never)
  const instantiation = new InstantiationService(services)

  render(
    <ServicesContext.Provider value={instantiation}>
      <EditorGroupContext.Provider value={{ id: 1 } as never}>
        <Breadcrumbs input={input} />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>,
  )
  return { config }
}

describe('BreadcrumbsBar', () => {
  it('renders the workspace-relative file path and the symbol path', () => {
    renderBar()
    const bar = screen.getByTestId('editor-breadcrumbs')
    expect(within(bar).getByText('src')).toBeTruthy()
    expect(within(bar).getByText('a.ts')).toBeTruthy()
    expect(within(bar).getByText('AlphaSymbol')).toBeTruthy()
  })

  it('honours filePath=last, symbolPath=off and icons=false', () => {
    renderBar({
      'breadcrumbs.filePath': 'last',
      'breadcrumbs.symbolPath': 'off',
      'breadcrumbs.icons': false,
    })
    const bar = screen.getByTestId('editor-breadcrumbs')
    expect(within(bar).queryByText('src')).toBeNull()
    expect(within(bar).getByText('a.ts')).toBeTruthy()
    expect(within(bar).queryByText('AlphaSymbol')).toBeNull()
    expect(bar.querySelector('[data-file-icon]')).toBeNull()
  })

  it('shows file and symbol icons by default', () => {
    renderBar()
    const bar = screen.getByTestId('editor-breadcrumbs')
    expect(bar.querySelector('[data-file-icon]')).not.toBeNull()
    expect(bar.querySelector('.codicon')).not.toBeNull()
  })

  it('renders nothing when breadcrumbs.enabled is false', () => {
    renderBar({ 'breadcrumbs.enabled': false })
    expect(screen.queryByTestId('editor-breadcrumbs')).toBeNull()
  })

  it('reacts to configuration changes', () => {
    const { config } = renderBar()
    const bar = screen.getByTestId('editor-breadcrumbs')
    expect(within(bar).getByText('src')).toBeTruthy()

    act(() => config.update('breadcrumbs.filePath', 'last'))
    expect(within(bar).queryByText('src')).toBeNull()

    act(() => config.update('breadcrumbs.enabled', false))
    expect(screen.queryByTestId('editor-breadcrumbs')).toBeNull()
  })

  it('marks the last segment active and uses a roving tab stop', () => {
    renderBar()
    const bar = screen.getByTestId('editor-breadcrumbs')
    const segments = within(bar).getAllByRole('button')
    expect(segments).toHaveLength(3)
    expect(segments[0]!.getAttribute('tabindex')).toBe('-1')
    expect(segments[2]!.getAttribute('tabindex')).toBe('0')
    expect(segments[2]!.getAttribute('data-breadcrumb-active')).toBe('true')

    fireEvent.focus(segments[2]!)
    expect(segments[2]!.getAttribute('data-breadcrumb-focused')).toBe('true')
    expect(segments[1]!.getAttribute('data-breadcrumb-focused')).toBeNull()
  })

  it('closes the picker when focus leaves the portal', async () => {
    renderBar()
    const bar = screen.getByTestId('editor-breadcrumbs')
    fireEvent.click(within(bar).getByText('AlphaSymbol'))

    const picker = screen.getByTestId('breadcrumbs-symbol-picker')
    act(() => within(picker).getByRole('tree').blur())

    await waitFor(() => expect(screen.queryByTestId('breadcrumbs-symbol-picker')).toBeNull())
  })

  it('keeps the file picker open when focus moves from the tree to a twistie', async () => {
    renderBar({}, 'AlphaSymbol', {
      '/ws': [{ name: 'src', isDirectory: true, isFile: false }],
    })
    const bar = screen.getByTestId('editor-breadcrumbs')
    fireEvent.click(within(bar).getByText('src'))

    const picker = await screen.findByTestId('breadcrumbs-file-picker')
    const tree = await within(picker).findByRole('tree')
    const twistie = within(picker).getByRole('button', { name: 'Expand folder' })
    await waitFor(() => expect(document.activeElement).toBe(tree))

    // Chromium sets the new focus target after dispatching focusout, with the
    // microtask checkpoint in between: `activeElement` reads as <body> there.
    act(() => tree.blur())
    await act(async () => {
      await Promise.resolve()
    })
    act(() => twistie.focus())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(screen.queryByTestId('breadcrumbs-file-picker')).not.toBeNull()
  })

  it('falls back to the default configuration values', () => {
    renderBar()
    expect(DEFAULT_BREADCRUMBS_CONFIG.filePath).toBe('on')
  })
})
