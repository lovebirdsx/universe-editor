/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IConfirmOptions, IConfirmResult, IDialogService } from '@universe-editor/platform'
import { askRedaction, collectTranscripts, exportRecording } from '../bugRecordingActions.js'
import type { IAcpSessionHistoryService } from '../../services/acp/session/acpSessionHistory.js'
import type { AcpSessionHistoryEntry } from '../../services/acp/session/acpSessionHistory.js'
import type { BugRecordingResult } from '../../../shared/ipc/bugRecorderService.js'
import type { INotificationService } from '@universe-editor/platform'
import { Severity } from '@universe-editor/platform'

function makeDialogs(choice: IConfirmResult['choice']): IDialogService & {
  options: IConfirmOptions[]
} {
  const options: IConfirmOptions[] = []
  return {
    _serviceBrand: undefined,
    options,
    confirm: (opts) => {
      options.push(opts)
      return Promise.resolve({ confirmed: choice === 'primary', choice })
    },
    prompt: () => Promise.resolve(undefined),
  }
}

function makeNotifications(): INotificationService & {
  messages: Array<{ severity: Severity; message: string }>
} {
  const messages: Array<{ severity: Severity; message: string }> = []
  return {
    ...({} as INotificationService),
    messages,
    notify: (opts: { severity: Severity; message: string }) => {
      messages.push({ severity: opts.severity, message: opts.message })
      return { close: () => {} } as never
    },
  }
}

function makeHistory(
  entries: readonly Partial<AcpSessionHistoryEntry>[],
): IAcpSessionHistoryService {
  return {
    ...({} as IAcpSessionHistoryService),
    list: () => entries as readonly AcpSessionHistoryEntry[],
  }
}

describe('askRedaction', () => {
  it('maps the primary button to keeping everything', async () => {
    await expect(askRedaction(makeDialogs('primary'))).resolves.toBe('keep')
  })

  it('maps the secondary button to redacting', async () => {
    await expect(askRedaction(makeDialogs('secondary'))).resolves.toBe('redact')
  })

  it('maps cancel to aborting the export', async () => {
    await expect(askRedaction(makeDialogs('cancel'))).resolves.toBe('cancel')
  })

  // The dialog is the only place the user learns screenshots are unmaskable, so
  // this assertion guards the promise made in the product decision.
  it('spells out that screenshots cannot be redacted', async () => {
    const dialogs = makeDialogs('cancel')
    await askRedaction(dialogs)
    expect(dialogs.options[0]?.detail).toContain('Screenshots cannot be redacted')
    expect(dialogs.options[0]?.primaryButton).toBe('Save Evidence')
    expect(dialogs.options[0]?.secondaryButton).toBe('Redact and Save')
  })

  it('accepts a caller-supplied cancel label for the crash-fallback flow', async () => {
    const dialogs = makeDialogs('cancel')
    await askRedaction(dialogs, { cancelButton: 'Not Now' })
    expect(dialogs.options[0]?.cancelButton).toBe('Not Now')
  })
})

describe('collectTranscripts', () => {
  it('keeps only entries that actually have a transcript on disk', () => {
    const result = collectTranscripts(
      makeHistory([{ title: 'with path', transcriptPath: '/logs/a.jsonl' }, { title: 'no path' }]),
    )
    expect(result).toEqual([{ title: 'with path', path: '/logs/a.jsonl' }])
  })

  it('caps the bundle at five transcripts', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({
      title: `s${i}`,
      transcriptPath: `/logs/${i}.jsonl`,
    }))
    expect(collectTranscripts(makeHistory(entries))).toHaveLength(5)
  })

  it('returns an empty list when no session has a transcript', () => {
    expect(collectTranscripts(makeHistory([{ title: 'a' }, { title: 'b' }]))).toEqual([])
  })
})

describe('exportRecording', () => {
  const RESULT: BugRecordingResult = {
    zipPath: '/out/bundle.zip',
    eventCount: 12,
    screenshotCount: 3,
    zipSizeBytes: 999,
  }

  it('reports the bundle path and counts on success', async () => {
    const notifications = makeNotifications()
    await exportRecording(notifications, () => Promise.resolve(RESULT))
    expect(notifications.messages[0]?.severity).toBe(Severity.Info)
    expect(notifications.messages[0]?.message).toContain('/out/bundle.zip')
    expect(notifications.messages[0]?.message).toContain('12 events')
  })

  it('surfaces a failure as an error notification instead of throwing', async () => {
    const notifications = makeNotifications()
    await expect(
      exportRecording(notifications, () => Promise.reject(new Error('disk full'))),
    ).resolves.toBeUndefined()
    expect(notifications.messages[0]?.severity).toBe(Severity.Error)
    expect(notifications.messages[0]?.message).toContain('disk full')
  })
})
