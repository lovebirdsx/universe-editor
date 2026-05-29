/*---------------------------------------------------------------------------------------------
 *  Tests for WindowTitleContribution
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IRecentWorkspace,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { WindowTitleContribution } from '../WindowTitleContribution.js'

function makeWorkspaceStub(initial: IWorkspace | null = null): IWorkspaceServiceType & {
  fireWorkspaceChange(workspace: IWorkspace | null): void
} {
  const wsEmitter = new Emitter<IWorkspace | null>()
  const recentEmitter = new Emitter<readonly IRecentWorkspace[]>()
  let current = initial
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: wsEmitter.event,
    get recent() {
      return []
    },
    onDidChangeRecent: recentEmitter.event,
    whenReady: Promise.resolve(),
    async openFolder() {},
    async closeFolder() {
      current = null
    },
    async clearRecent() {},
    fireWorkspaceChange(workspace: IWorkspace | null) {
      current = workspace
      wsEmitter.fire(workspace)
    },
  }
}

function makeContribution(ws: IWorkspaceServiceType): WindowTitleContribution {
  const services = new ServiceCollection()
  services.set(IWorkspaceService, ws)
  const inst = new InstantiationService(services)
  return inst.createInstance(WindowTitleContribution)
}

describe('WindowTitleContribution', () => {
  afterEach(() => {
    document.title = ''
  })

  it('sets the title to "<folder name> - <parent dir>" for the initial workspace', () => {
    const folder = URI.file('/tmp/myProject')
    const ws = makeWorkspaceStub({ folder, name: 'myProject' })
    const contribution = makeContribution(ws)

    expect(document.title).toBe(`myProject - ${URI.file('/tmp').fsPath}`)

    contribution.dispose()
  })

  it('shows only appName when there is no workspace', () => {
    const ws = makeWorkspaceStub(null)
    const contribution = makeContribution(ws)

    expect(document.title).toBe('Universe Editor')

    contribution.dispose()
  })

  it('updates the title when the workspace changes', () => {
    const ws = makeWorkspaceStub(null)
    const contribution = makeContribution(ws)

    ws.fireWorkspaceChange({ folder: URI.file('/tmp/a'), name: 'a' })
    expect(document.title).toBe(`a - ${URI.file('/tmp').fsPath}`)

    ws.fireWorkspaceChange({ folder: URI.file('/work/b'), name: 'b' })
    expect(document.title).toBe(`b - ${URI.file('/work').fsPath}`)

    ws.fireWorkspaceChange(null)
    expect(document.title).toBe('Universe Editor')

    contribution.dispose()
  })
})
