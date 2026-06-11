/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Maps an ACP agent's string icon id to a concrete logo component. Built-in
 *  agents resolve to the official Claude / OpenAI marks (inline single-color
 *  SVG paths from simple-icons, tinted via `currentColor`); unknown / iconless
 *  agents fall back to a generic lucide `Bot`. Mirrors the icon-map pattern used
 *  by `activitybar/icon-map.ts` so the platform layer stays icon-library free.
 *--------------------------------------------------------------------------------------------*/

import { Bot } from 'lucide-react'
import type { JSX } from 'react'
import { IAcpAgentRegistry, agentIconId } from '../../services/acp/acpAgentRegistry.js'
import { AGENT_LOGO_PATHS } from '../../services/acp/agentIconData.js'
import { useService } from '../useService.js'
import styles from './agentIcon.module.css'

export interface AgentIconProps {
  readonly size?: number | undefined
  readonly className?: string | undefined
}

type AgentIconComponent = (props: AgentIconProps) => JSX.Element

const cx = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' ')

function ClaudeLogo({ size = 16, className }: AgentIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cx(styles['claude'], className)}
      aria-hidden="true"
    >
      <path d={AGENT_LOGO_PATHS['claude']} />
    </svg>
  )
}

function OpenAILogo({ size = 16, className }: AgentIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cx(styles['openai'], className)}
      aria-hidden="true"
    >
      <path d={AGENT_LOGO_PATHS['openai']} />
    </svg>
  )
}

function BotLogo({ size = 16, className }: AgentIconProps) {
  return <Bot size={size} strokeWidth={1.75} className={cx(styles['bot'], className)} aria-hidden />
}

const ICON_MAP: Record<string, AgentIconComponent> = {
  claude: ClaudeLogo,
  openai: OpenAILogo,
  bot: BotLogo,
}

/** Resolve a string icon id (`'claude'` / `'openai'` / …) to a logo component. */
export function resolveAgentIcon(iconId: string): AgentIconComponent {
  return ICON_MAP[iconId] ?? BotLogo
}

export interface AgentIconByIdProps extends AgentIconProps {
  readonly agentId: string | undefined
}

/**
 * Renders the logo for an agent looked up by id. Resolves the descriptor's
 * `icon` through the registry (which throws on unknown ids — caught here so
 * stale/deleted-agent sessions degrade to the bot fallback).
 */
export function AgentIcon({ agentId, size, className }: AgentIconByIdProps) {
  const registry = useService(IAcpAgentRegistry)
  let descriptorIcon: string | undefined
  if (agentId !== undefined) {
    try {
      descriptorIcon = registry.get(agentId).icon
    } catch {
      descriptorIcon = undefined
    }
  }
  const Icon = resolveAgentIcon(agentIconId(agentId, descriptorIcon))
  return <Icon size={size} className={className} />
}
