/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Guards the bug-recording translations. A missing key is invisible at runtime —
 *  localize silently falls back to the English default and no check script looks
 *  for it — so the only way this stays correct is by asserting it here.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { configureNls, localize, localize2 } from '@universe-editor/platform'
import { getLocaleMessages } from '../availableLocales.js'

/** Mirrors what bootstrap.ts hands to configureNls for a zh-CN window. */
function useZhCn(): void {
  configureNls({
    locale: 'zh-CN',
    fallbackLocale: 'en-US',
    messages: getLocaleMessages('zh-CN'),
    fallbackMessages: getLocaleMessages('en-US'),
  })
}

const STOP_TITLE = '停止 Bug 录制并导出证据包'

describe('bug recording zh-CN messages', () => {
  afterEach(() => {
    configureNls({ locale: 'en-US' })
  })

  it('translates the three command titles', () => {
    useZhCn()

    expect(localize2('action.startBugRecording.title', 'Start Bug Recording').value).toBe(
      '开始 Bug 录制',
    )
    expect(
      localize2('action.stopBugRecording.title', 'Stop Bug Recording and Export Evidence').value,
    ).toBe(STOP_TITLE)
    expect(localize2('action.markBugRecordingStep.title', 'Mark Bug Recording Step').value).toBe(
      '标记 Bug 录制步骤',
    )
  })

  it('keeps the English original searchable so English keywords still match', () => {
    useZhCn()

    // CommandsQuickAccessProvider folds `original` into the palette keywords.
    expect(localize2('action.startBugRecording.title', 'Start Bug Recording').original).toBe(
      'Start Bug Recording',
    )
  })

  it('names the stop command in the start notification exactly as the palette does', () => {
    useZhCn()

    const started = localize(
      'bugRecording.started',
      'Bug recording started. Reproduce the problem, then run "Stop Bug Recording".',
    )
    // The message tells the user which command to run next; a translation that
    // drifts from the command title would point at a name the UI never shows.
    expect(started).toContain(STOP_TITLE)
  })

  it('substitutes every placeholder in the export notifications', () => {
    useZhCn()

    const exported = localize(
      'bugRecording.exported',
      'Bug evidence bundle exported: {path} ({events} events, {shots} screenshots)',
      { path: 'X:/workspace/bundle.zip', events: 214, shots: 25 },
    )
    expect(exported).toContain('X:/workspace/bundle.zip')
    expect(exported).toContain('214')
    expect(exported).toContain('25')
    expect(exported).not.toMatch(/\{[a-z]+\}/i)

    const orphan = localize(
      'bugRecording.orphanFound',
      'A bug recording from {time} was interrupted (crash or forced exit). Its {events} recorded events are still on disk.',
      { time: '2026-08-28 10:15', events: '7' },
    )
    expect(orphan).toContain('2026-08-28 10:15')
    expect(orphan).toContain('7')
    expect(orphan).not.toMatch(/\{[a-z]+\}/i)
  })

  it('translates the redaction dialog including the un-redactable screenshot warning', () => {
    useZhCn()

    expect(localize('bugRecording.save', 'Save Evidence')).toBe('保存证据包')
    expect(localize('bugRecording.redactAndSave', 'Redact and Save')).toBe('脱敏并保存')
    expect(localize('bugRecording.keepRecording', 'Keep Recording')).toBe('继续录制')

    const detail = localize('bugRecording.stopDetail', 'unused')
    // The three buttons are referenced by name in the body, and the screenshot
    // caveat is a product requirement rather than incidental wording.
    expect(detail).toContain('保存证据包')
    expect(detail).toContain('脱敏并保存')
    expect(detail).toContain('截图无法脱敏')
    expect(detail.split('\n\n')).toHaveLength(3)
  })

  it('leaves no bug-recording message untranslated', () => {
    const zh = getLocaleMessages('zh-CN')
    const keys = [
      'action.startBugRecording.title',
      'action.stopBugRecording.title',
      'action.markBugRecordingStep.title',
      'bugRecording.statusTooltip',
      'bugRecording.alreadyRecording',
      'bugRecording.started',
      'bugRecording.notRecording',
      'bugRecording.stopConfirm',
      'bugRecording.stopDetail',
      'bugRecording.save',
      'bugRecording.redactAndSave',
      'bugRecording.keepRecording',
      'bugRecording.exported',
      'bugRecording.exportFailed',
      'bugRecording.orphanFound',
      'bugRecording.orphanExport',
      'bugRecording.orphanDiscard',
    ]

    for (const key of keys) {
      expect(zh[key], `missing zh-CN translation for ${key}`).toBeTruthy()
    }
  })
})
