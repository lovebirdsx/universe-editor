/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for the bug recording service. Renderer windows feed structured
 *  events into main's single recorder; main appends them as JSONL, captures
 *  screenshots at key steps, and on stop packs everything (events, timeline
 *  markdown, screenshots, log tails, ACP transcripts, environment info) into one
 *  zip evidence bundle meant to be handed to an AI for root-cause analysis.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type { Event } from '@universe-editor/platform'

/**
 * Wall-clock stamp taken by the producing window. Main converts it to an offset
 * from `startedAt` when persisting — renderer and main clocks are the same
 * machine, but only main knows when the recording began.
 */
export interface BugRecordEventBase {
  readonly ts: number
}

/** Why a screenshot was taken; surfaces in the timeline so an AI can correlate. */
export type BugScreenshotReason =
  | 'start'
  | 'commandError'
  | 'errorNotification'
  | 'agentPrompt'
  | 'marker'

/**
 * The event payload without the timestamp. Named separately because `Omit` does
 * not distribute over a union — producers need the discriminated form to stay
 * intact so `kind` still narrows the other fields.
 */
export type BugRecordEventPayload =
  | { readonly kind: 'commandError'; readonly commandId: string; readonly message: string }
  | {
      readonly kind: 'telemetry'
      readonly name: string
      readonly data?: Readonly<Record<string, string | number | boolean>>
    }
  | { readonly kind: 'edit'; readonly count: number; readonly resource?: string }
  | { readonly kind: 'editorSwitch'; readonly resource?: string }
  | {
      readonly kind: 'notification'
      readonly severity: 'error' | 'warning'
      readonly message: string
    }
  | {
      readonly kind: 'acpMessage'
      readonly sessionId: string
      readonly role: string
      readonly text: string
    }
  | {
      readonly kind: 'acpToolCall'
      readonly sessionId: string
      readonly title?: string
      readonly status?: string
      readonly inputPreview?: string
    }
  | { readonly kind: 'marker' }
  | { readonly kind: 'screenshot'; readonly file: string; readonly reason: BugScreenshotReason }

export type BugRecordEvent = BugRecordEventBase & BugRecordEventPayload

/** Event as persisted: the wire event plus main's offset from recording start. */
export type PersistedBugRecordEvent = BugRecordEvent & { readonly t: number }

export interface BugRecordingStatus {
  readonly state: 'idle' | 'recording'
  readonly startedAt?: number
}

export interface BugRecordingStartMeta {
  readonly workspaceFolders?: readonly string[]
}

/** An ACP transcript on disk, referenced rather than re-recorded. */
export interface BugRecordingTranscriptRef {
  readonly title: string
  readonly path?: string
}

export interface BugRecordingStopOptions {
  readonly redact: boolean
  readonly transcripts?: readonly BugRecordingTranscriptRef[]
}

export interface BugRecordingResult {
  readonly zipPath: string
  readonly eventCount: number
  readonly screenshotCount: number
  readonly zipSizeBytes: number
}

/** A recording left behind by a crash or force-kill, found on the next launch. */
export interface BugRecordingOrphanInfo {
  readonly startedAt: number
  readonly eventCount: number
  readonly screenshotCount: number
}

export interface IBugRecorderService {
  readonly _serviceBrand: undefined

  /** Broadcast to every window so each status bar stays in sync with main. */
  readonly onDidChangeStatus: Event<BugRecordingStatus>

  startRecording(meta: BugRecordingStartMeta): Promise<BugRecordingStatus>
  recordEvents(events: readonly BugRecordEvent[]): Promise<void>
  /** User-driven "mark this moment": records an event and forces a screenshot. */
  markStep(): Promise<void>
  stopRecording(options: BugRecordingStopOptions): Promise<BugRecordingResult>
  getRecordingStatus(): Promise<BugRecordingStatus>

  /** Consume-once, so only the first window that asks offers to export it. */
  consumeOrphanRecording(): Promise<BugRecordingOrphanInfo | null>
  exportOrphanRecording(options: BugRecordingStopOptions): Promise<BugRecordingResult>
}

export const IBugRecorderService = createDecorator<IBugRecorderService>('bugRecorderService')
