/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Swarm review restore + changed-file list/tree regressions.
 *--------------------------------------------------------------------------------------------*/

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ICommandService,
  IDialogService,
  IEditorService,
  IStorageService,
  InstantiationService,
  ServiceCollection,
  type ICommand,
} from '@universe-editor/platform'
import {
  SwarmCommands,
  type SwarmReviewDetailDto,
  type SwarmReviewFileDto,
} from '@universe-editor/extensions-common'
import { ServicesContext } from '../../useService.js'
import { SwarmReviewEditorInput } from '../../../services/editor/SwarmReviewEditorInput.js'
import { swarmReviewDetailCache } from '../../../services/swarm/swarmViewState.js'
import { SwarmReviewEditor } from '../SwarmReviewEditor.js'
import { SwarmReviewFiles } from '../SwarmReviewFiles.js'

const DETAIL: SwarmReviewDetailDto = {
  id: '1001',
  state: 'needsReview',
  stateLabel: 'Needs Review',
  author: 'alice',
  description: 'Restore this review',
  updated: 1,
  versions: [{ version: 1, change: '2001', pending: true, time: 1 }],
  participants: [],
  transitions: [],
  commentCount: 0,
  openTaskCount: 0,
  testStatus: 'none',
}

const FILES: SwarmReviewFileDto[] = [
  { status: 'M', path: 'src/editor/a.ts', depotFile: '//depot/src/editor/a.ts' },
  { status: 'A', path: 'src/runtime/b.ts', depotFile: '//depot/src/runtime/b.ts' },
]

class RegistryCommandService {
  declare readonly _serviceBrand: undefined
  readonly executeCommand = vi.fn(async <T,>(id: string, ...args: unknown[]) => {
    const command = CommandsRegistry.getCommand(id)
    if (!command) return undefined
    return command.handler({ get: () => undefined } as never, ...args) as T
  })
}

class FakeStorage {
  declare readonly _serviceBrand: undefined
  async get<T>(): Promise<T | undefined> {
    return undefined
  }
  async set(): Promise<void> {}
  async remove(): Promise<void> {}
}

function registerCommand(id: string, handler: ICommand['handler']) {
  return CommandsRegistry.registerCommand({ id, handler })
}

function renderReview() {
  const services = new ServiceCollection()
  const commands = new RegistryCommandService()
  services.set(ICommandService, commands as unknown as ICommandService)
  services.set(IDialogService, {
    _serviceBrand: undefined,
    confirm: vi.fn(async () => ({ confirmed: false })),
  } as unknown as IDialogService)
  services.set(IEditorService, {
    _serviceBrand: undefined,
    openEditor: vi.fn(),
  } as unknown as IEditorService)
  services.set(IStorageService, new FakeStorage() as unknown as IStorageService)
  const instantiation = new InstantiationService(services)
  const result = render(
    <ServicesContext.Provider value={instantiation}>
      <SwarmReviewEditor input={new SwarmReviewEditorInput('1001')} />
    </ServicesContext.Provider>,
  )
  return { ...result, commands }
}

beforeEach(() => {
  vi.useFakeTimers()
  swarmReviewDetailCache.clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  swarmReviewDetailCache.clear()
})

describe('SwarmReviewEditor restore', () => {
  it('waits for the runtime command instead of treating startup undefined as a missing review', async () => {
    const { commands } = renderReview()

    await act(async () => Promise.resolve())
    expect(commands.executeCommand).not.toHaveBeenCalledWith(SwarmCommands.getReview, '1001')
    expect(screen.queryByText('Review #1001 is unavailable.')).toBeNull()

    const registration = registerCommand(SwarmCommands.getReview, () => DETAIL)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })

    expect(screen.getByText('Review #1001')).toBeTruthy()
    expect(screen.getByText('Restore this review')).toBeTruthy()

    const describeRegistration = registerCommand(SwarmCommands.describeVersion, () => FILES)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(screen.getByText('a.ts')).toBeTruthy()

    describeRegistration.dispose()
    registration.dispose()
  })

  it('still reports a missing review after the command is registered', async () => {
    const registration = registerCommand(SwarmCommands.getReview, () => undefined)
    renderReview()

    await act(async () => Promise.resolve())

    expect(screen.getByText('Review #1001 is unavailable.')).toBeTruthy()
    registration.dispose()
  })
})

describe('SwarmReviewFiles list/tree mode', () => {
  it('shows directory context inline in list mode', () => {
    render(<SwarmReviewFiles files={FILES} viewMode="list" onOpenFile={() => {}} />)

    expect(screen.queryByTestId('swarm-review-file-folder')).toBeNull()
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('src/editor')).toBeTruthy()
  })

  it('reuses the compact changed-file tree and supports collapsing folders', () => {
    render(<SwarmReviewFiles files={FILES} viewMode="tree" onOpenFile={() => {}} />)

    expect(screen.getByText('src')).toBeTruthy()
    expect(screen.getByText('editor')).toBeTruthy()
    expect(screen.getByText('runtime')).toBeTruthy()
    fireEvent.click(screen.getByText('editor'))
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.getByText('b.ts')).toBeTruthy()
  })

  it('opens files by click and keyboard and exposes the two view-mode controls', () => {
    const onOpenFile = vi.fn()
    const onViewModeChange = vi.fn()
    render(
      <SwarmReviewFiles
        files={FILES}
        viewMode="list"
        onViewModeChange={onViewModeChange}
        onOpenFile={onOpenFile}
      />,
    )

    fireEvent.click(screen.getByText('a.ts'))
    expect(onOpenFile).toHaveBeenCalledWith(FILES[0])
    fireEvent.keyDown(screen.getByRole('tree'), { key: 'Enter' })
    expect(onOpenFile).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'View as Tree' }))
    expect(onViewModeChange).toHaveBeenCalledWith('tree')
  })
})
