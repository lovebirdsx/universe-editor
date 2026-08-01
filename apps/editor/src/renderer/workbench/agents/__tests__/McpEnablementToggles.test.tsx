/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors.
 *  McpEnablementToggles tests — visibility rules, the user-level stance
 *  write, the workspace three-state cycle (inherit → on → off → inherit),
 *  the shadowed tooltip, and external-write synchronization.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  InstantiationService,
  ServiceCollection,
  StorageScope,
} from '@universe-editor/platform'
import type { IMcpServerEnablementService } from '../../../services/acp/mcpServerEnablementService.js'
import { IMcpServerEnablementService as IMcpServerEnablementServiceId } from '../../../services/acp/mcpServerEnablementService.js'
import { McpEnablementToggles } from '../McpEnablementToggles.js'
import { ServicesContext } from '../../useService.js'

afterEach(() => cleanup())

class StubEnablement implements IMcpServerEnablementService {
  declare readonly _serviceBrand: undefined
  readonly whenReady = Promise.resolve()
  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange = this._onDidChange.event
  readonly records: Record<StorageScope, Record<string, boolean>> = {
    [StorageScope.GLOBAL]: {},
    [StorageScope.WORKSPACE]: {},
  }
  isEnabled(name: string): boolean {
    return (
      this.records[StorageScope.WORKSPACE][name] ?? this.records[StorageScope.GLOBAL][name] ?? true
    )
  }
  getOverride(name: string, scope: StorageScope): boolean | undefined {
    return this.records[scope][name]
  }
  setEnabled(name: string, enabled: boolean, scope: StorageScope): Promise<void> {
    this.records[scope][name] = enabled
    this._onDidChange.fire()
    return Promise.resolve()
  }
  removeOverride(name: string, scope: StorageScope): Promise<void> {
    delete this.records[scope][name]
    this._onDidChange.fire()
    return Promise.resolve()
  }
}

function renderToggles({
  enablement,
  name = 'fs',
  showUserToggle = true,
}: {
  enablement: StubEnablement
  name?: string
  showUserToggle?: boolean
}) {
  const services = new ServiceCollection()
  services.set(IMcpServerEnablementServiceId, enablement)
  const inst = new InstantiationService(services)
  return render(<McpEnablementToggles name={name} showUserToggle={showUserToggle} />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
}

const userToggle = () => screen.getByTestId('mcp-ena-user-toggle') as HTMLInputElement
const wsToggle = () => screen.getByTestId('mcp-ena-ws-toggle') as HTMLInputElement

describe('McpEnablementToggles', () => {
  it('hides the user-level switch for workspace-only names', () => {
    renderToggles({ enablement: new StubEnablement(), showUserToggle: false })
    expect(screen.queryByTestId('mcp-ena-user-toggle')).toBeNull()
    expect(screen.getByTestId('mcp-ena-ws-toggle')).toBeTruthy()
  })

  it('user switch defaults to on (stance, not effective) and writes GLOBAL', () => {
    const enablement = new StubEnablement()
    renderToggles({ enablement })
    expect(userToggle().checked).toBe(true)
    fireEvent.click(userToggle())
    expect(enablement.getOverride('fs', StorageScope.GLOBAL)).toBe(false)
    expect(userToggle().checked).toBe(false)
    fireEvent.click(userToggle())
    expect(enablement.getOverride('fs', StorageScope.GLOBAL)).toBe(true)
  })

  it('workspace switch cycles inherit → enabled → disabled → inherit', () => {
    const enablement = new StubEnablement()
    renderToggles({ enablement })
    expect(wsToggle().indeterminate).toBe(true)
    expect(wsToggle().checked).toBe(false)

    fireEvent.click(wsToggle())
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBe(true)
    expect(wsToggle().indeterminate).toBe(false)
    expect(wsToggle().checked).toBe(true)

    fireEvent.click(wsToggle())
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBe(false)
    expect(wsToggle().checked).toBe(false)

    fireEvent.click(wsToggle())
    expect(enablement.getOverride('fs', StorageScope.WORKSPACE)).toBeUndefined()
    expect(wsToggle().indeterminate).toBe(true)
  })

  it('keeps the user switch on (with shadow hint) when the workspace overrides it off', async () => {
    const enablement = new StubEnablement()
    await enablement.setEnabled('fs', false, StorageScope.WORKSPACE)
    const { container } = renderToggles({ enablement })
    // Stance: default-on, even though the effective value is disabled.
    expect(userToggle().checked).toBe(true)
    expect(wsToggle().checked).toBe(false)
    const userWrap = container.querySelector('span[title]')!
    expect(userWrap.getAttribute('title')).toContain('overridden by the workspace')
  })

  it('no shadow hint once the workspace record is removed', async () => {
    const enablement = new StubEnablement()
    await enablement.setEnabled('fs', false, StorageScope.WORKSPACE)
    await enablement.setEnabled('fs', false, StorageScope.GLOBAL)
    const { container } = renderToggles({ enablement })
    const userWrap = container.querySelector('span[title]')!
    expect(userWrap.getAttribute('title')).not.toContain('overridden by the workspace')
  })

  it('reflects external writes via onDidChange', async () => {
    const enablement = new StubEnablement()
    renderToggles({ enablement })
    expect(wsToggle().indeterminate).toBe(true)
    await enablement.setEnabled('fs', false, StorageScope.GLOBAL)
    expect(userToggle().checked).toBe(false)
    await enablement.setEnabled('fs', true, StorageScope.WORKSPACE)
    expect(wsToggle().indeterminate).toBe(false)
    expect(wsToggle().checked).toBe(true)
    // Workspace wins over the global-off stance → user switch is shadowed.
    expect(userToggle().checked).toBe(false)
    expect(enablement.isEnabled('fs')).toBe(true)
  })

  it('scopes reads and writes per server name', async () => {
    const enablement = new StubEnablement()
    await enablement.setEnabled('other', false, StorageScope.GLOBAL)
    renderToggles({ enablement, name: 'fs' })
    expect(userToggle().checked).toBe(true)
    fireEvent.click(userToggle())
    expect(enablement.getOverride('fs', StorageScope.GLOBAL)).toBe(false)
    expect(enablement.getOverride('other', StorageScope.GLOBAL)).toBe(false)
  })
})
