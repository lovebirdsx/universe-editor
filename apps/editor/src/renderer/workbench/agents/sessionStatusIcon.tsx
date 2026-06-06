/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Maps a session display-status id to a lucide status icon, mirroring the
 *  resolver pattern of `agentIcon.tsx`. Kept distinct from the agent-logo
 *  resolver so quick pick rows can carry both an agent and a status glyph.
 *--------------------------------------------------------------------------------------------*/

import {
  Circle,
  CircleDashed,
  CircleX,
  Loader2,
  MessageCircleQuestion,
  type LucideIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import styles from './sessionStatusIcon.module.css'

export interface SessionStatusIconProps {
  readonly size?: number | undefined
  readonly className?: string | undefined
}

type SessionStatusIconComponent = (props: SessionStatusIconProps) => JSX.Element

function spinning(Icon: LucideIcon): SessionStatusIconComponent {
  return ({ size = 14, className }) => (
    <Icon size={size} className={`${className ?? ''} ${styles['spin']}`} aria-hidden />
  )
}

function plain(Icon: LucideIcon): SessionStatusIconComponent {
  return ({ size = 14, className }) => <Icon size={size} className={className} aria-hidden />
}

const ICON_MAP: Record<string, SessionStatusIconComponent> = {
  running: spinning(Loader2),
  connecting: spinning(Loader2),
  idle: plain(Circle),
  errored: plain(CircleX),
  ask: plain(MessageCircleQuestion),
  closed: plain(CircleDashed),
}

/** Resolve a display-status id (`'running'` / `'ask'` / …) to a status icon. */
export function resolveSessionStatusIcon(statusId: string): SessionStatusIconComponent {
  return ICON_MAP[statusId] ?? plain(Circle)
}
