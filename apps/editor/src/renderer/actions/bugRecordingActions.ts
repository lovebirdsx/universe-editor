/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bug recording commands: start, stop (with the redaction choice) and mark a
 *  step. Stopping asks whether to redact — keeping everything is the primary
 *  choice, since a masked path or username is often the very clue that explains
 *  the bug.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IDialogService,
  INotificationService,
  IWorkspaceService,
  localize,
  localize2,
  Severity,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpSessionHistoryService } from '../services/acp/session/acpSessionHistory.js'
import { IBugRecorderClient } from '../services/bugRecording/bugRecorderClient.js'
import type {
  BugRecordingResult,
  BugRecordingTranscriptRef,
} from '../../shared/ipc/bugRecorderService.js'

const CATEGORY = localize2('command.category.developer', 'Developer')
const MAX_TRANSCRIPTS = 5

export class StartBugRecordingAction extends Action2 {
  static readonly ID = 'workbench.action.startBugRecording'

  constructor() {
    super({
      id: StartBugRecordingAction.ID,
      title: localize2('action.startBugRecording.title', 'Start Bug Recording'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const recorder = accessor.get(IBugRecorderClient)
    const notifications = accessor.get(INotificationService)
    const workspace = accessor.get(IWorkspaceService).current

    if (recorder.isRecording) {
      notifications.notify({
        severity: Severity.Info,
        message: localize('bugRecording.alreadyRecording', 'A bug recording is already running.'),
      })
      return
    }

    const folder = workspace?.folder.toString()
    await recorder.startRecording(folder !== undefined ? { workspaceFolders: [folder] } : {})
    notifications.notify({
      severity: Severity.Info,
      message: localize(
        'bugRecording.started',
        'Bug recording started. Reproduce the problem, then run "Stop Bug Recording".',
      ),
    })
  }
}

export class StopBugRecordingAction extends Action2 {
  static readonly ID = 'workbench.action.stopBugRecording'

  constructor() {
    super({
      id: StopBugRecordingAction.ID,
      title: localize2('action.stopBugRecording.title', 'Stop Bug Recording and Export Evidence'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // The accessor is invalid past the first await — take every service up front.
    const recorder = accessor.get(IBugRecorderClient)
    const dialogs = accessor.get(IDialogService)
    const notifications = accessor.get(INotificationService)
    const history = accessor.get(IAcpSessionHistoryService)

    if (!recorder.isRecording) {
      notifications.notify({
        severity: Severity.Info,
        message: localize('bugRecording.notRecording', 'No bug recording is running.'),
      })
      return
    }

    const choice = await askRedaction(dialogs)
    if (choice === 'cancel') return

    const transcripts = collectTranscripts(history)
    await exportRecording(notifications, () =>
      recorder.stopRecording({
        redact: choice === 'redact',
        ...(transcripts.length > 0 ? { transcripts } : {}),
      }),
    )
  }
}

export class MarkBugRecordingStepAction extends Action2 {
  static readonly ID = 'workbench.action.markBugRecordingStep'

  constructor() {
    super({
      id: MarkBugRecordingStepAction.ID,
      title: localize2('action.markBugRecordingStep.title', 'Mark Bug Recording Step'),
      category: CATEGORY,
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    const recorder = accessor.get(IBugRecorderClient)
    const notifications = accessor.get(INotificationService)

    if (!recorder.isRecording) {
      notifications.notify({
        severity: Severity.Info,
        message: localize('bugRecording.notRecording', 'No bug recording is running.'),
      })
      return
    }
    await recorder.markStep()
  }
}

export type RedactionChoice = 'keep' | 'redact' | 'cancel'

/**
 * Three-button choice. "Keep everything" is primary on purpose: redaction is a
 * lossy transform on exactly the strings (paths, usernames) that reproductions
 * often hinge on, so the user has to opt into losing them.
 */
export async function askRedaction(
  dialogs: IDialogService,
  options?: { readonly cancelButton?: string },
): Promise<RedactionChoice> {
  const result = await dialogs.confirm({
    type: 'info',
    message: localize('bugRecording.stopConfirm', 'Stop recording and export the evidence bundle?'),
    detail: localize(
      'bugRecording.stopDetail',
      '"Save Evidence" keeps everything, which gives the best chance of pinpointing the problem.\n\n"Redact and Save" masks usernames, account directories, project paths and credential tokens — but it may also erase the very clue that explains the bug (for example a reproduction that only happens under a specific path or username).\n\nScreenshots cannot be redacted: they are pictures of your screen. Review them yourself if they may show something sensitive.',
    ),
    primaryButton: localize('bugRecording.save', 'Save Evidence'),
    secondaryButton: localize('bugRecording.redactAndSave', 'Redact and Save'),
    cancelButton: options?.cancelButton ?? localize('bugRecording.keepRecording', 'Keep Recording'),
  })
  if (result.choice === 'primary') return 'keep'
  if (result.choice === 'secondary') return 'redact'
  return 'cancel'
}

/** Shared by the normal stop flow and the crash-fallback export. */
export async function exportRecording(
  notifications: INotificationService,
  run: () => Promise<BugRecordingResult>,
): Promise<void> {
  try {
    const result = await run()
    notifications.notify({
      severity: Severity.Info,
      message: localize(
        'bugRecording.exported',
        'Bug evidence bundle exported: {path} ({events} events, {shots} screenshots)',
        { path: result.zipPath, events: result.eventCount, shots: result.screenshotCount },
      ),
    })
  } catch (err) {
    notifications.notify({
      severity: Severity.Error,
      message: localize(
        'bugRecording.exportFailed',
        'Failed to export the bug evidence bundle: {message}',
        { message: err instanceof Error ? err.message : String(err) },
      ),
    })
  }
}

/** ACP transcripts already on disk — referenced by path rather than re-recorded. */
export function collectTranscripts(
  history: IAcpSessionHistoryService,
): readonly BugRecordingTranscriptRef[] {
  return history
    .list()
    .filter((entry) => entry.transcriptPath !== undefined)
    .slice(0, MAX_TRANSCRIPTS)
    .map((entry) => ({
      title: entry.title,
      ...(entry.transcriptPath !== undefined ? { path: entry.transcriptPath } : {}),
    }))
}
