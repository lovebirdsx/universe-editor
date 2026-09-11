/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Search-mode lane collapse: filtering the Perforce Graph drops parents outside
 *  the result set, so the layout would draw dangling lines to nothing. While a
 *  query is active the swim-lane paths are hidden and every node is pinned to
 *  the left column; clearing the query restores the full lane rendering.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  Event,
  ICommandService,
  IStorageService,
  IViewDescriptorService,
  IViewsService,
  InstantiationService,
  ServiceCollection,
  observableValue,
} from '@universe-editor/platform'
import {
  PerforceGraphCommands,
  type P4GraphLoadResult,
  type P4GraphRepoDto,
} from '@universe-editor/extensions-common'
import { IScmService } from '../../../services/extensions/ScmService.js'
import { _resetForTests } from '../../../services/perforceGraph/perforceGraphViewState.js'
import { scmViewState } from '../../scm/scmViewState.js'
import { _clearGraphPayloadCacheForTests } from '../../scm/commitChanges/graphPayloadCache.js'
import { ServicesContext } from '../../useService.js'
import { PerforceGraphEditor } from '../PerforceGraphEditor.js'

const REPO: P4GraphRepoDto = { root: 'C:/ws/main', name: 'alice-ws' }

function makeResult(pendingCount = 0): P4GraphLoadResult {
  return {
    changes: [
      {
        id: '4521',
        parents: ['4519'],
        author: 'alice',
        client: 'alice-ws',
        date: 1,
        message: 'Fix widget',
        body: 'Fix widget',
      },
      {
        id: '4519',
        parents: [],
        author: 'bob',
        client: 'bob-ws',
        date: 1,
        message: 'Initial',
        body: 'Initial',
      },
    ],
    head: '4521',
    headClient: 'alice-ws',
    moreAvailable: false,
    pendingCount,
    haveChange: null,
  }
}

function renderEditor(result: P4GraphLoadResult = makeResult()) {
  const services = new ServiceCollection()
  services.set(ICommandService, {
    _serviceBrand: undefined,
    executeCommand: vi.fn(async (id: string) => {
      switch (id) {
        case PerforceGraphCommands.getChanges:
          return result
        case PerforceGraphCommands.getRepos:
          return [REPO]
        default:
          return undefined
      }
    }),
    onWillExecuteCommand: Event.None,
    onDidExecuteCommand: Event.None,
  } as unknown as ICommandService)
  services.set(IScmService, {
    _serviceBrand: undefined,
    sourceControls: observableValue('test.sourceControls', []),
    changeInputBoxValue: vi.fn(),
    setExtHost: vi.fn(),
    resetSourceControls: vi.fn(),
  } as unknown as IScmService)
  services.set(IStorageService, {
    _serviceBrand: undefined,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    onDidChangeWorkspaceScope: () => ({ dispose: () => {} }),
  } as unknown as IStorageService)
  services.set(IViewsService, {
    _serviceBrand: undefined,
    openViewContainer: vi.fn(),
  } as unknown as IViewsService)
  services.set(IViewDescriptorService, {
    _serviceBrand: undefined,
    setViewCollapsed: vi.fn(),
  } as unknown as IViewDescriptorService)
  return render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <PerforceGraphEditor input={{} as never} />
    </ServicesContext.Provider>,
  )
}

async function flush(): Promise<void> {
  for (let round = 0; round < 10; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }
}

function graphSvg(container: HTMLElement): SVGSVGElement {
  const svg = container
    .querySelector('[data-testid="perforceGraph-scrollBody"]')
    ?.querySelector('svg')
  expect(svg).toBeTruthy()
  return svg as unknown as SVGSVGElement
}

function typeQuery(container: HTMLElement, query: string): void {
  fireEvent.change(container.querySelector('input[type="search"]')!, {
    target: { value: query },
  })
}

beforeEach(() => {
  _resetForTests()
})

afterEach(() => {
  _resetForTests()
  scmViewState.setSelectedRepo(undefined)
  _clearGraphPayloadCacheForTests()
  vi.clearAllMocks()
})

describe('PerforceGraphEditor search mode', () => {
  it('hides the lane paths and pins nodes to the left column while filtering', async () => {
    const { container } = renderEditor()
    await flush()

    const normalWidth = graphSvg(container).getAttribute('width')
    expect(graphSvg(container).querySelectorAll('path').length).toBeGreaterThan(0)

    typeQuery(container, 'widget')
    await flush()

    const svg = graphSvg(container)
    expect(svg.querySelectorAll('path')).toHaveLength(0)
    const circles = [...svg.querySelectorAll('circle')]
    expect(circles).toHaveLength(1)
    expect(circles[0]!.getAttribute('cx')).toBe('12')
    expect(svg.getAttribute('width')).toBe('24')
    expect(screen.getByText('Fix widget')).toBeTruthy()
    expect(screen.queryByText('Initial')).toBeNull()

    typeQuery(container, '')
    await flush()

    expect(graphSvg(container).querySelectorAll('path').length).toBeGreaterThan(0)
    expect(graphSvg(container).getAttribute('width')).toBe(normalWidth)
    expect(screen.getByText('Initial')).toBeTruthy()
  })

  it('keeps the pending-changes node rendered (and pinned) while filtering', async () => {
    const { container } = renderEditor(makeResult(2))
    await flush()

    typeQuery(container, 'widget')
    await flush()

    expect(screen.getByText('Pending Changes (2)')).toBeTruthy()
    const svg = graphSvg(container)
    expect(svg.querySelectorAll('path')).toHaveLength(0)
    const circles = [...svg.querySelectorAll('circle')]
    expect(circles).toHaveLength(2)
    for (const circle of circles) {
      expect(circle.getAttribute('cx')).toBe('12')
    }
  })
})
