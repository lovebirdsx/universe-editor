/*---------------------------------------------------------------------------------------------
 *  Guards the Sessions container/view chrome. The ids are asserted all over the
 *  codebase, but a revert of the user-visible name or icon would otherwise pass
 *  every existing test — `iconCoverage` only checks that an icon id resolves,
 *  not which container carries it.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
} from '@universe-editor/platform'
import { SessionsViewContainerContribution } from '../AgentsContributions.js'

describe('SessionsViewContainerContribution', () => {
  let contribution: SessionsViewContainerContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('registers the Sessions container in the secondary side bar', () => {
    contribution = new SessionsViewContainerContribution()

    const container = ViewContainerRegistry.getViewContainer('workbench.view.sessions')
    expect(container).toBeDefined()
    expect(container?.label).toBe('Sessions')
    expect(container?.icon).toBe('comment-discussion')
    expect(container?.location).toBe(ViewContainerLocation.SecondarySideBar)
  })

  it('gives the main view the same name and icon as its container', () => {
    contribution = new SessionsViewContainerContribution()

    const view = ViewRegistry.getView('workbench.view.sessions.main')
    expect(view).toBeDefined()
    expect(view?.name).toBe('Sessions')
    expect(view?.icon).toBe('comment-discussion')
    expect(view?.containerId).toBe('workbench.view.sessions')
  })

  it('keeps the MCP servers view in the same container', () => {
    contribution = new SessionsViewContainerContribution()

    const view = ViewRegistry.getView('workbench.view.sessions.mcp')
    expect(view).toBeDefined()
    expect(view?.name).toBe('MCP Servers')
    expect(view?.containerId).toBe('workbench.view.sessions')
  })

  it('dispose unregisters the container and both views', () => {
    contribution = new SessionsViewContainerContribution()
    contribution.dispose()
    contribution = undefined

    expect(ViewContainerRegistry.getViewContainer('workbench.view.sessions')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.sessions.main')).toBeUndefined()
    expect(ViewRegistry.getView('workbench.view.sessions.mcp')).toBeUndefined()
  })
})
