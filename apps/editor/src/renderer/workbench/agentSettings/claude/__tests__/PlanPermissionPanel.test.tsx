/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  PlanPermissionPanel tests — the personal plan-permission switch writes the
 *  User layer only (a Project value can neither weaken nor strengthen it) and
 *  follows external changes to the same key.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  ConfigurationService,
  ConfigurationTarget,
  IConfigurationService,
  InstantiationService,
  ServiceCollection,
} from '@universe-editor/platform'
import { ServicesContext } from '../../../useService.js'
import { PLAN_PERMISSION_POLICY_KEY } from '../../../../services/acp/session/planPermissionPolicy.js'
import { PlanPermissionPanel } from '../PlanPermissionPanel.js'
import type { UseClaudeConfig } from '../useClaudeConfig.js'

afterEach(() => cleanup())

function renderPanel(config: ConfigurationService) {
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  const inst = new InstantiationService(services)
  render(<PlanPermissionPanel config={{} as UseClaudeConfig} />, {
    wrapper: ({ children }) => (
      <ServicesContext.Provider value={inst}>{children}</ServicesContext.Provider>
    ),
  })
}

const radio = (value: string): HTMLInputElement =>
  screen.getByDisplayValue(value) as HTMLInputElement

describe('PlanPermissionPanel', () => {
  it('defaults to skip and offers all three policies with their descriptions', () => {
    renderPanel(new ConfigurationService())

    expect(radio('skip').checked).toBe(true)
    expect(radio('auto').checked).toBe(false)
    expect(radio('manual').checked).toBe(false)
    expect(screen.getByText(/Plan mode permissions/)).toBeTruthy()
    expect(screen.getByText(/takes effect on sessions created or resumed afterwards/)).toBeTruthy()
    expect(screen.getByText(/read from user settings only/)).toBeTruthy()
    expect(screen.getByText(/managed policy, if it forbids auto mode, still wins/)).toBeTruthy()
  })

  it('selecting a policy writes the User layer only', () => {
    const config = new ConfigurationService()
    renderPanel(config)

    fireEvent.click(radio('manual'))

    expect(config.getValueForTarget(PLAN_PERMISSION_POLICY_KEY, ConfigurationTarget.User)).toBe(
      'manual',
    )
    expect(config.getValueOrigin(PLAN_PERMISSION_POLICY_KEY)).toBe(ConfigurationTarget.User)
    expect(config.getLayerSnapshot(ConfigurationTarget.Memory)[PLAN_PERMISSION_POLICY_KEY]).toBe(
      undefined,
    )
    expect(config.getLayerSnapshot(ConfigurationTarget.Project)[PLAN_PERMISSION_POLICY_KEY]).toBe(
      undefined,
    )
    expect(radio('manual').checked).toBe(true)
  })

  it('ignores a workspace/project value', () => {
    const config = new ConfigurationService()
    config.update(PLAN_PERMISSION_POLICY_KEY, 'manual', ConfigurationTarget.Project)

    renderPanel(config)

    expect(radio('skip').checked).toBe(true)
    expect(radio('manual').checked).toBe(false)
  })

  it('follows an external change to the same key', async () => {
    const config = new ConfigurationService()
    renderPanel(config)

    await act(async () => {
      config.update(PLAN_PERMISSION_POLICY_KEY, 'auto', ConfigurationTarget.User)
    })

    expect(radio('auto').checked).toBe(true)
    expect(radio('skip').checked).toBe(false)
  })
})
