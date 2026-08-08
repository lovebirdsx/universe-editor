/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/timeline/TimelineView.tsx
 *
 *  Covers the inline row actions: commit/revision rows get an "Open Commit"
 *  button (whole item DTO as the command argument, the extension handler needs
 *  item.command.arguments[0].uri) next to the pre-existing "Open in Graph"
 *  button; working-tree rows get neither.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  ICommandService,
  IConfigurationService,
  IContextKeyService,
  IEditorService,
  InstantiationService,
  observableValue,
  ServiceCollection,
  URI,
} from '@universe-editor/platform'
import type { ITimelineDto, ITimelineItemDto } from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import {
  ITimelineService,
  type ITimelineProviderModel,
  type ITimelineService as ITimelineServiceType,
} from '../../../services/timeline/TimelineService.js'
import { TimelineView } from '../TimelineView.js'

const FILE_URI = URI.file('/repo/file.txt')

function makeGitCommitItem(): ITimelineItemDto {
  return {
    handle: 'git-history|abc123',
    source: 'git-history',
    id: 'abc123',
    label: 'fix crash',
    timestamp: 2000,
    themeIcon: 'git-commit',
    contextValue: 'git:file:commit',
    command: {
      command: 'git.timeline.openDiff',
      title: 'Open Changes',
      arguments: [{ uri: FILE_URI.toString(), currentHash: 'abc123', previousHash: 'def456' }],
    },
  }
}

function makeGitWorkingItem(): ITimelineItemDto {
  return {
    handle: 'git-history|working',
    source: 'git-history',
    label: 'Uncommitted Changes',
    timestamp: 3000,
    contextValue: 'git:file:working',
  }
}

function makePerforceRevItem(): ITimelineItemDto {
  return {
    handle: 'perforce-history|12345',
    source: 'perforce-history',
    id: '12345',
    label: 'tweak config',
    timestamp: 1000,
    contextValue: 'perforce:file:rev',
    command: {
      command: 'perforce.timeline.openDiff',
      title: 'Open Changes',
      arguments: [{ uri: FILE_URI.toString(), rev: 12345 }],
    },
  }
}

function setup(items: ITimelineItemDto[]) {
  const provider: ITimelineProviderModel = {
    handle: 1,
    id: 'git-history',
    label: 'Git History',
    schemes: ['file'],
  }
  const timelineService = {
    _serviceBrand: undefined,
    providers: observableValue<readonly ITimelineProviderModel[]>('t.providers', [provider]),
    onDidChangeTimeline: new Emitter<never>().event,
    uri: observableValue<URI | undefined>('t.uri', FILE_URI),
    pinnedUri: observableValue<URI | undefined>('t.pinned', undefined),
    followUri: vi.fn(),
    getTimeline: vi.fn(
      async (): Promise<ITimelineDto> => ({ source: provider.id, items: [...items] }),
    ),
  }
  const executeCommand = vi.fn()
  const services = new ServiceCollection()
  services.set(ITimelineService, timelineService as unknown as ITimelineServiceType)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    activeEditor: observableValue('t.activeEditor', undefined),
  } as never)
  services.set(ICommandService, { _serviceBrand: undefined, executeCommand } as never)
  services.set(IConfigurationService, { _serviceBrand: undefined, get: () => undefined } as never)
  services.set(IContextKeyService, { _serviceBrand: undefined, createScoped: vi.fn() } as never)
  const instantiation = new InstantiationService(services)
  return { executeCommand, instantiation }
}

async function renderView(instantiation: InstantiationService): Promise<void> {
  render(
    <ServicesContext.Provider value={instantiation}>
      <TimelineView />
    </ServicesContext.Provider>,
  )
  // loadFirstPage awaits the provider pages before pushing rows into the tree.
  await act(async () => {})
}

afterEach(() => cleanup())

describe('TimelineView — inline row actions', () => {
  it('renders Open Commit and Open in Graph buttons on a git commit row', async () => {
    const { instantiation } = setup([makeGitCommitItem()])
    await renderView(instantiation)

    const openCommit = screen.getByRole('button', { name: 'Open Commit' })
    const openGraph = screen.getByRole('button', { name: 'Open in Git Graph' })
    // VSCode inline order: viewCommit before the graph action.
    expect(openCommit.compareDocumentPosition(openGraph)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('runs git.timeline.viewCommit with the whole item when Open Commit is clicked', async () => {
    const item = makeGitCommitItem()
    const { executeCommand, instantiation } = setup([item])
    await renderView(instantiation)

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open Commit' })))

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('git.timeline.viewCommit', item)
  })

  it('runs perforce.timeline.viewCommit with the whole item on a perforce rev row', async () => {
    const item = makePerforceRevItem()
    const { executeCommand, instantiation } = setup([item])
    await renderView(instantiation)

    expect(screen.getByRole('button', { name: 'Open in Perforce Graph' })).toBeTruthy()
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open Commit' })))

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('perforce.timeline.viewCommit', item)
  })

  it('renders no inline action on a working-tree row', async () => {
    const { instantiation } = setup([makeGitWorkingItem()])
    await renderView(instantiation)

    expect(screen.getByText('Uncommitted Changes')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open Commit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open in Git Graph' })).toBeNull()
  })

  it('keeps Open in Graph running the graph command with just the commit id', async () => {
    const item = makeGitCommitItem()
    const { executeCommand, instantiation } = setup([item])
    await renderView(instantiation)

    act(() => fireEvent.click(screen.getByRole('button', { name: 'Open in Git Graph' })))

    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(executeCommand).toHaveBeenCalledWith('_workbench.openGitGraph', item.id)
  })
})
