/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Re-run one finished trigger run from its saved input. The agent re-reads the
 *  skill files, so replaying the original payload under the current trigger
 *  definition is how a skill edit is verified. Docs: docs/development/triggers.md
 *--------------------------------------------------------------------------------------------*/

import {
  fsPathToWorkspaceUri,
  localize,
  REMOTE_SCHEME,
  Severity,
  URI,
  type IFileService,
  type ILogger,
  type INotificationService,
} from '@universe-editor/platform'
import type { ITriggerMainService } from '../../../shared/ipc/triggerService.js'
import { parseWorkspaceUri } from '../../../shared/triggers/configParse.js'
import type { TriggerPayloadValue, TriggerRunHistoryEntry } from '../../../shared/triggers/types.js'

export interface RerunTriggerServices {
  readonly triggers: ITriggerMainService
  readonly files: IFileService
  readonly notifications: INotificationService
  readonly logger: ILogger
}

/** `<runDir>/event.json`; written by the renderer when the run starts. */
export const TRIGGER_RUN_EVENT_FILE = 'event.json'

/** Refuse oversized saved input before `readFileText` allocates it. */
export const MAX_TRIGGER_RUN_EVENT_BYTES = 1024 * 1024

/**
 * Re-run `runId` with its saved payload under the current trigger definition.
 * Uses `manual` event semantics: no dedupe key is consumed and the trigger's
 * pause / backoff does not gate it (a global pause still rejects it).
 */
export async function rerunTriggerRun(
  services: RerunTriggerServices,
  runId: string,
): Promise<void> {
  let entry: TriggerRunHistoryEntry | undefined
  try {
    entry = await services.triggers.getRun(runId)
  } catch (err) {
    services.logger.warn(`rerun ${runId}: cannot read the run history: ${describeError(err)}`)
    notifyFailure(services, describeError(err))
    return
  }
  if (entry === undefined) {
    notify(
      services,
      Severity.Info,
      localize(
        'triggers.rerun.unknownRun',
        'The run is no longer in the history, so it cannot be re-run.',
      ),
    )
    return
  }
  if (entry.runDir === undefined || entry.runDir.length === 0) {
    notify(
      services,
      Severity.Info,
      localize(
        'triggers.rerun.noInput',
        'This run did not save its input (it was recorded before re-run support), so it cannot be re-run.',
      ),
    )
    return
  }

  let payload: Readonly<Record<string, TriggerPayloadValue>>
  try {
    // The workspace URI is the single source of truth for the host; callers do
    // not need to derive (and risk diverging on) the authority.
    const workspace = parseWorkspaceUri(entry.workspace)
    const authority =
      workspace !== undefined && workspace.scheme === REMOTE_SCHEME
        ? workspace.authority
        : undefined
    const eventUri = URI.joinPath(
      fsPathToWorkspaceUri(entry.runDir, authority),
      TRIGGER_RUN_EVENT_FILE,
    )
    const stat = await services.files.stat(eventUri)
    if (!stat.isFile || stat.size > MAX_TRIGGER_RUN_EVENT_BYTES) {
      throw new Error(`event.json is not a file or exceeds ${MAX_TRIGGER_RUN_EVENT_BYTES} bytes`)
    }
    const saved = readSavedPayload(await services.files.readFileText(eventUri))
    if (saved === undefined) throw new Error('event.json is malformed or has an unknown version')
    payload = saved
  } catch (err) {
    services.logger.warn(`rerun ${runId}: cannot read the saved event: ${describeError(err)}`)
    notify(
      services,
      Severity.Warning,
      localize(
        'triggers.rerun.inputUnavailable',
        'The saved input for this run is unavailable, so it cannot be re-run.',
      ),
    )
    return
  }

  try {
    // No `sourceKey`: the original poll item stays consumed, and a re-run must
    // not change the scheduler's dedupe state.
    await services.triggers.runNow(entry.triggerKey, { payload })
  } catch (err) {
    services.logger.warn(`rerun ${runId}: runNow failed: ${describeError(err)}`)
    notifyFailure(services, describeError(err))
    return
  }
  notify(
    services,
    Severity.Info,
    localize(
      'triggers.rerun.queued',
      'Trigger "{name}" was queued to run again with the saved input.',
      { name: entry.triggerName },
    ),
  )
}

/**
 * Parse `<runDir>/event.json`, returning `undefined` for an unknown version or a
 * non-object payload (a present-but-empty object is valid: no external event).
 */
function readSavedPayload(text: string): Readonly<Record<string, TriggerPayloadValue>> | undefined {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  if (record['version'] !== 1) return undefined
  const value = record['payload']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const entries: [string, TriggerPayloadValue][] = []
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' || typeof item === 'boolean') {
      entries.push([key, item])
    } else if (typeof item === 'number' && Number.isFinite(item)) {
      entries.push([key, item])
    }
  }
  // fromEntries defines properties (no `__proto__` setter), so a crafted field
  // name in the saved JSON cannot mutate the prototype.
  return Object.fromEntries(entries)
}

function notify(services: RerunTriggerServices, severity: Severity, message: string): void {
  services.notifications.notify({ severity, message })
}

function notifyFailure(services: RerunTriggerServices, error: string): void {
  notify(
    services,
    Severity.Error,
    localize('triggers.rerun.failed', 'Could not re-run the trigger: {error}', { error }),
  )
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
