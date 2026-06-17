/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for SessionChangesView — single-click preview vs double-click pin, and
 *  the list/tree view-mode toggle (grouping changed files by directory).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  Emitter,
  IEditorResolverService,
  IEditorService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
  type IObservable,
  type IOpenEditorServiceOptions,
  type IWorkspace,
} from '@universe-editor/platform'
import { SessionChangesView } from '../SessionChangesView.js'
import { IAcpSessionService } from '../../../services/acp/acpSessionService.js'
import {
  ISessionChangeTrackerService,
  type SessionFileChange,
} from '../../../services/acp/sessionChangeTracker.js'
import { sessionChangesViewState } from '../sessionChangesViewState.js'
import { ServicesContext } from '../../useService.js'

class FakeEditor {
  declare readonly _serviceBrand: undefined
  opened: Array<{ input: IEditorInput; options: IOpenEditorServiceOptions | undefined }> = []
  openEditors = observableValue<readonly IEditorInput[]>('fake.openEditors', [])
  activeEditorId = observableValue<string | undefined>('fake.activeId', undefined)
  activeEditor = observableValue<IEditorInput | undefined>('fake.active', undefined)
  openEditor(input: IEditorInput, options?: IOpenEditorServiceOptions) {
    this.opened.push({ input, options })
  }
  closeEditor() {}
  closeAllEditors() {}
}

class FakeStorage {
  declare readonly _serviceBrand: undefined
  async get<T>(): Promise<T | undefined> {
    return undefined
  }
  async set(): Promise<void> {}
  async remove(): Promise<void> {}
}

function change(path: string, status: SessionFileChange['status'] = 'modified'): SessionFileChange {
  return { uri: URI.file(path), path, baseline: 'a', current: 'b', status, batchCount: 1 }
}

class FakeWorkspace {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  current: IWorkspace | null
  constructor(folder: URI | null) {
    this.current = folder ? { folder, name: 'ws' } : null
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

function renderView(changes: readonly SessionFileChange[], root: URI | null = URI.file('/ws')) {
  const services = new ServiceCollection()
  const editor = new FakeEditor()
  const resolver = {
    _serviceBrand: undefined,
    opened: [] as URI[],
    openEditor(uri: URI) {
      this.opened.push(uri)
      return Promise.resolve()
    },
  }
  const changesObs: IObservable<readonly SessionFileChange[]> = observableValue(
    'test.changes',
    changes,
  )
  const sessions = {
    _serviceBrand: undefined,
    activeSession: observableValue<{ id: string } | undefined>('test.session', { id: 's1' }),
  }
  const tracker = {
    _serviceBrand: undefined,
    changesFor: () => changesObs,
  }
  services.set(IEditorService, editor as unknown as IEditorService)
  services.set(IStorageService, new FakeStorage() as unknown as IStorageService)
  services.set(IWorkspaceService, new FakeWorkspace(root) as unknown as IWorkspaceService)
  services.set(IEditorResolverService, resolver as unknown as IEditorResolverService)
  services.set(IAcpSessionService, sessions as unknown as IAcpSessionService)
  services.set(ISessionChangeTrackerService, tracker as unknown as ISessionChangeTrackerService)
  const inst = new InstantiationService(services)
  const result = render(
    <ServicesContext.Provider value={inst}>
      <SessionChangesView />
    </ServicesContext.Provider>,
  )
  return { ...result, editor, resolver }
}

beforeEach(() => sessionChangesViewState.setViewMode('list'))
afterEach(() => cleanup())

describe('SessionChangesView — preview vs pin', () => {
  it('single-click opens the diff as a preview (pinned:false)', async () => {
    const { editor } = renderView([change('/ws/src/a.ts')])
    fireEvent.click(await screen.findByText('a.ts'))
    await waitFor(() => expect(editor.opened).toHaveLength(1))
    expect(editor.opened[0]?.options?.pinned).toBe(false)
  })

  it('double-click pins the diff (pinned:true)', async () => {
    const { editor } = renderView([change('/ws/src/a.ts')])
    fireEvent.doubleClick(await screen.findByText('a.ts'))
    await waitFor(() => expect(editor.opened.length).toBeGreaterThanOrEqual(1))
    expect(editor.opened.some((o) => o.options?.pinned === true)).toBe(true)
  })
})

describe('SessionChangesView — open file action', () => {
  it('the floating button opens the real file (not the diff)', async () => {
    const { editor, resolver } = renderView([change('/ws/src/a.ts')])
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByTestId('acp-changes-open-file'))
    await waitFor(() => expect(resolver.opened).toHaveLength(1))
    expect(resolver.opened[0]?.fsPath).toContain('a.ts')
    // The row's own diff handler must not fire when the action button is clicked.
    expect(editor.opened).toHaveLength(0)
  })

  it('deleted files have no open-file button', async () => {
    renderView([change('/ws/src/gone.ts', 'deleted')])
    await screen.findByText('gone.ts')
    expect(screen.queryByTestId('acp-changes-open-file')).toBeNull()
  })
})

describe('SessionChangesView — status decoration (SCM-aligned)', () => {
  it('tags an added row with data-status="added"', async () => {
    renderView([change('/ws/src/new.ts', 'added')])
    await screen.findByText('new.ts')
    expect(screen.getByTestId('acp-changes-row').getAttribute('data-status')).toBe('added')
  })

  it('tags a deleted row with data-status="deleted" (drives the strike-through)', async () => {
    renderView([change('/ws/src/gone.ts', 'deleted')])
    await screen.findByText('gone.ts')
    expect(screen.getByTestId('acp-changes-row').getAttribute('data-status')).toBe('deleted')
  })
})

describe('SessionChangesView — list/tree mode', () => {
  it('list mode shows the file directory inline; no folder rows', async () => {
    renderView([change('/ws/src/a.ts')])
    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(screen.queryByTestId('acp-changes-folder')).toBeNull()
  })

  it('tree mode groups files under per-directory folder rows (relative to workspace root)', async () => {
    // Workspace root `/ws` is stripped; `src` and `lib` become top-level rows.
    renderView([change('/ws/src/a.ts'), change('/ws/lib/b.ts')])
    sessionChangesViewState.setViewMode('tree')
    await waitFor(() =>
      expect(screen.getAllByTestId('acp-changes-folder').length).toBeGreaterThanOrEqual(2),
    )
    expect(screen.getByText('src')).toBeTruthy()
    expect(screen.getByText('lib')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
  })

  it('shows a shared nested folder even when every file lives under it', async () => {
    // Regression: foo/bar/a.js + foo/bar/b.js must render a single compressed
    // `foo/bar` folder row, not bare files with no folder.
    renderView([change('/ws/foo/bar/a.js'), change('/ws/foo/bar/b.js')])
    sessionChangesViewState.setViewMode('tree')
    await waitFor(() => expect(screen.getByText('foo/bar')).toBeTruthy())
    expect(screen.getAllByTestId('acp-changes-folder')).toHaveLength(1)
    expect(screen.getByText('a.js')).toBeTruthy()
    expect(screen.getByText('b.js')).toBeTruthy()
  })

  it('collapsing a folder hides its files', async () => {
    renderView([change('/ws/src/a.ts'), change('/ws/lib/b.ts')])
    sessionChangesViewState.setViewMode('tree')
    await screen.findByText('src')
    expect(screen.getByText('a.ts')).toBeTruthy()
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.queryByText('a.ts')).toBeNull())
    expect(screen.getByText('b.ts')).toBeTruthy()
  })
})
