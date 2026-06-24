/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  agentSettingsRegistry — module-level registry mapping an ACP agentId to the
 *  React component that renders its settings UI. Each agent owns a self-contained
 *  settings component and registers it here as a side-effect on import; the Agent
 *  Settings editor shell merely lists the known agents (from IAcpAgentRegistry)
 *  and renders the contributed component for the selected one.
 *
 *  Adding settings for a new agent (e.g. Codex) is a single registerAgentSettings
 *  call from that agent's settings module — the shell needs no changes.
 *--------------------------------------------------------------------------------------------*/

import type { ComponentType } from 'react'

/** Props every contributed agent-settings component receives. */
export interface AgentSettingsComponentProps {
  readonly agentId: string
}

export type AgentSettingsComponent = ComponentType<AgentSettingsComponentProps>

const registry = new Map<string, AgentSettingsComponent>()

/** Register the settings component for an agent. A later call overrides an earlier one. */
export function registerAgentSettings(agentId: string, component: AgentSettingsComponent): void {
  registry.set(agentId, component)
}

/** The settings component contributed for an agent, or `undefined` if none. */
export function getAgentSettingsComponent(agentId: string): AgentSettingsComponent | undefined {
  return registry.get(agentId)
}
