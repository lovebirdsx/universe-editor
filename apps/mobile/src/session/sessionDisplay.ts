import type {
  MobileTimelineItem,
  MobileTimelineMessageItem,
  MobileTimelineToolCallItem,
} from '@universe-editor/mobile-protocol'
import { readStoredString, writeStoredString } from '../preferences.js'

export type SessionDisplayPreference = 'onlyMessage' | 'full'

export const SESSION_DISPLAY_STORAGE_KEY = 'universe.mobile.sessionDisplay'
export const DEFAULT_SESSION_DISPLAY: SessionDisplayPreference = 'onlyMessage'

export function isSessionDisplayPreference(value: unknown): value is SessionDisplayPreference {
  return value === 'onlyMessage' || value === 'full'
}

export function readSessionDisplayPreference(): SessionDisplayPreference {
  const stored = readStoredString(SESSION_DISPLAY_STORAGE_KEY)
  return isSessionDisplayPreference(stored) ? stored : DEFAULT_SESSION_DISPLAY
}

export function setSessionDisplayPreference(preference: SessionDisplayPreference): void {
  writeStoredString(SESSION_DISPLAY_STORAGE_KEY, preference)
}

/**
 * Mirrors the desktop `onlyMessage` keep-set (timelineDisplay.ts) against the
 * phone wire shapes: user/agent text, errors, status notices and the three
 * always-kept tool cards survive; thoughts and ordinary tools are dropped.
 */
export function selectTimelineForDisplay(
  timeline: readonly MobileTimelineItem[],
  preference: SessionDisplayPreference,
): readonly MobileTimelineItem[] {
  if (preference === 'full') return timeline
  return timeline.filter(isOnlyMessageVisible)
}

function isOnlyMessageVisible(item: MobileTimelineItem): boolean {
  switch (item.kind) {
    case 'notice':
      return true
    case 'message':
      return isMessageVisible(item)
    case 'toolCall':
      return isAlwaysKeptToolCall(item)
  }
}

function isMessageVisible(item: MobileTimelineMessageItem): boolean {
  if (item.role === 'user') return true
  if (item.role === 'thought') return false
  return isErrorMessage(item) || hasVisibleContent(item)
}

function isErrorMessage(item: MobileTimelineMessageItem): boolean {
  return item.role === 'agent' && item.text.trimStart().startsWith('[error]')
}

function hasVisibleContent(item: MobileTimelineMessageItem): boolean {
  return item.text.trim().length > 0 || item.hasNonText === true || item.streaming
}

function isAlwaysKeptToolCall(item: MobileTimelineToolCallItem): boolean {
  return (
    item.subagent === true || item.requiresUserDecision === true || item.toolKind === 'switch_mode'
  )
}
